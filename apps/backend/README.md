# @strkworld/backend

**The server-side privacy boundary. Core request handling is implemented.**

The browser cannot hold a paymaster key (required for relayed routes since
D-070, though the player still pays: each private transaction repays avnu from
their shielded balance) or send privacy-sensitive RPC reads
directly to a third party. This app owns the smallest server surface needed to
submit eligible prepared Wallet API calls and proxy those reads. Since D-082
the wallet submits unshield, transfer and stake itself, so the browser relays
only a swap; the relay routes for the others remain here but are not called.

## What this owns

- Paymaster-key custody and fee-action ceiling checks
- Recipient-registration and receipt RPC proxies
- Bounded submission concurrency for eligible prepared calls only, with no
  artificial delay by default (D-066)
- A hard request deadline propagated to AVNU and Starknet RPC
- Aggregate rate, budget and health counters
- Global and per-route kill switches

AVNU's quote-bound first-party flow is never delayed and never waits in the
submission queue.

## Request boundary

Accept strict, versioned request shapes only. A request identifies an approved
route and carries only the data that route requires. Validate the visible
submission target, chain, pool/executor address, fee action, proof freshness and
route state. `packages/privacy` remains responsible for constructing the typed
action and its contract, selector, token, quote and slippage allowlists.

Never expose a generic transaction relay or accept an arbitrary destination or
calldata blob. If route validation cannot be completed, fail closed; the
client keeps the building locked (D-018).

## What this must never do

- Log or persist per-request IPs, calls, proofs, timings, recipients or
  transaction hashes
- Correlate lobby sessions with financial requests
- Inspect or hold a viewing key, note set or user secret
- Delay an AVNU quote or a prepared proof beyond its validity window
- Turn a missing private route into a public transaction

See D-014 for the backend threat model, D-015 for queue placement and D-018
for the building privacy-admission rule.

## Implemented core

`BackendApi` is a framework-neutral, versioned handler for the exact seven
operations the browser needs: pool-native fee build, quote-bound swap prepare,
prepared submission, pool config, recipient public key, receipt lookup and
the Privacy Plaza's pool stats (D-076, below), plus the optional read-only
degen token list (D-067, below) and the opt-in debug-log sink (D-069, below).
Schemas reject unknown fields. The
submission validator accepts only the configured pool's `apply_actions`,
bounded calldata and a non-empty bounded proof. It verifies that the proof
output contains the exact serialized-server-action prefix of the call, then
strictly parses the remaining screening option (`[]` compatibility, `[1]`
None, or `[0, issued_at, r, s]` Some). It decodes the current twelve-variant
`Span<ServerAction>` ABI and applies route policy: transfer/unshield cannot hide
an external `Invoke`, the exact authorized paymaster withdrawal must be
present, and public deposit/transfer-from/viewing-key or computed-invoke actions
cannot be smuggled through a private route. A `Some` screening attestation is
also rejected on these non-deposit routes; the current pool expects `None`.
One recipient per send (D-065): a first transfer opens a channel with
`Append(recipient, …)`, which publishes the recipient's address, so every
route refuses a submission whose `Append` actions name more than one distinct
address (400). Later sends to a known recipient carry no address, so the
Shell's one-transfer batch rule bounds those.

The Privacy Plaza's pool stats (D-076, `POST /v1/rpc/pool-stats` with
`{ "v": 1 }`) come from `PoolStatsCache` (`pool-stats.ts`), never from the
chain inside a request: accounts registered (the pool's `ViewingKeySet`
events since block 8,978,970), deposits in the last 51,429 blocks, and
`balance_of(pool)` for the six Exchange catalog tokens pinned here. The
scans are incremental: the first reads the pool's history in windows of
250,000 blocks, following the node's continuation tokens and committing
each window, and later refreshes read only new blocks. The range that
reaches the head names it by hash (`starknet_blockHashAndNumber`), since a
node answers a numeric `to_block` past its tip short and without an error,
and a window that ends by number ends at least 250,000 blocks below the
head. The RPC port returns block numbers only. A refresh runs about every
60 s while the route is asked and stops after ten quiet minutes; each part
keeps its last good value through a failed refresh and is null until first
counted. The route has its own rate window (`POOL_STATS_RATE_LIMIT`, 600 a
minute), apart from the one the private routes share, answers the kill
switch like every other, and logs nothing.

The Vault's public reads (D-077, D-079, `vault.ts`) are pinned, and a
request names only the value to look up.
`POST /v1/rpc/shadow-account` with `{ "v": 1, "partialCommitment" }` reads
`get_shadow_accounts(partial, 0, 1, false)` on the canonical
`ShadowAccountAnonymizer` and answers `{ address, deployed }`, refusing
anything but one well-formed row for nonce 0; the browser checks that
address against the anonymizer's own derivation before sending anything
there. `POST /v1/rpc/vault-position` with `{ "v": 1, "account" }` reads
`balance_of`, and with shares `preview_redeem`, `max_withdraw` and
`max_redeem`, on every Vesu vault in `VESU_VAULTS` (twenty-three, in Vesu's
Prime pool and five curated pools, generated by `scripts/vesu-markets.mjs`,
D-081),
answering `{ positions: [...] }`, one row per vault in decimal base units, or
`ok: false` for a vault whose read failed, so one vault never blocks another.
It sends two JSON-RPC batch requests to the node, the balances and then the
held vaults' follow-ups, and reads a node without batches a few calls at a
time. `POST /v1/vault-rates` with `{ "v": 1 }` answers each pinned vault's
supply APY as Vesu states it (`{ value, decimals }`), from Vesu's keyless
public endpoint for each pinned pool (`VESU_POOLS`), which this service alone
fetches, at most once every five minutes (`vesu-rates.ts`); a pool whose
fetch fails answers no rates for its own vaults for a minute. They come through here for D-014's reason: the player's IP next to a
partial commitment or a stand-in address is the link a shadow account exists
to hide, and Vesu need not see players at all. All three share the private
routes' rate window, answer the kill switch, answer 503 on a service
composed without them, and log nothing. The Vault's transactions never
reach this service: the wallet submits them.

The Borrow counter's public reads (D-083, `borrow.ts`) are pinned the same
way, to Vesu's Prime pool, five tokens (`BORROW_TOKENS`: STRK, ETH, USDC,
USDT, WBTC) and their twenty ordered pairs (`BORROW_PAIRS`). Its stand-in
address comes from the unchanged `/v1/rpc/shadow-account` route.
`POST /v1/rpc/borrow-market` with `{ "v": 1 }` reads `price` and
`asset_config` for every token and `pair_config` and `pairs` for every pair,
fifty calls in one JSON-RPC batch, answering `{ assets: [...], pairs: [...] }`
as decimal strings. `POST /v1/rpc/borrow-position` with `{ "v": 1, "account" }`
reads `position(collateral, debt, account)` for every pair, one batch of
twenty, answering `{ positions: [...] }`. A row whose call fails or answers
malformed is `ok: false` and fails no other row. Both share the private
routes' rate window, answer the kill switch, answer 503 on a service composed
without them, and log nothing. The account is never logged or kept.

The degen floor's catalog (D-067) is optional and off by default: with no
`BACKEND_DEGEN_ENABLED` it is absent, and any other `BACKEND_DEGEN_*`
variable fails startup. Once enabled (`_TAGS`, `_MIN_DAILY_VOLUME_USD` and
`_CACHE_TTL_MS` required), the backend fetches avnu's public token list itself
through the SDK's `fetchTokens`, so avnu never sees a player's IP, and keeps a
token only if it carries a configured tag (`Unknown` never qualifies), meets
the whole-dollar `lastDailyVolumeUsd` floor, has printable-ASCII text, and no
curated or ground-floor ticker at another address and no other live token
share its ticker. The pinned curated core (LORDS, DREAMS, SLAY, BROTHER, tBTC,
CASH, DOG, `degen-catalog.ts`) is always listed. The list is cached for the
TTL, refreshed single-flight on its own 5 s timeout, and fails safe to the
curated core alone, retried after a minute, whenever avnu cannot be reached.
`GET /v1/degen/tokens` serves it; the request carries nothing (no body, and
the edge refuses query strings), and the endpoint is shut whenever swap or
degen mode is. A swap's tokens must be in `BACKEND_ROUTE_SWAP_ALLOWED_TOKENS`,
the curated core or the current list, checked at prepare and again at
submission; a swap the static allowlist covers never consults the list.

Opt-in debug logs (D-069) are a test-deployment exception to D-014, off by
default. Only `BACKEND_DEBUG_LOGS_ENABLED=true` opens `POST /v1/debug/logs`;
unset, empty or `false`, the path answers exactly as an unknown one, and any
other value fails startup. The body is `{ v: 1, session, entries }`: a session
of 8–64 `[A-Za-z0-9-]`, 1–50 entries of `{ t, level, event, detail }` (epoch
ms; `info`, `warn` or `error`; up to 64 `[a-z0-9.:-]`; up to 2,000 characters),
at most 32 KB as compact JSON, and anything else refuses the whole batch. Each
entry becomes one stdout line, `[debug] <session> <ISO time> <level> <event>
<detail>`, with every control, format and lone-surrogate character stripped.
A global limit of 600 entries a minute drops and counts the rest and ends the
window with one `[debug] server … debug.dropped` line. The sink reads only the
body: no IP, header or timing. It takes no slot in the players' rate window
and ignores the private kill switch. The composition forwards only these
lines from the backend's stdout (`deploy/fly/src/debug-lines.ts`). A launch
never sets the flag.

For AVNU swaps the server selects an exact-input quote and requests
`quoteToCalls({ private: true })`. Its HMAC authorization additionally binds
the sell/buy tokens, sell amount, dynamic executor, serialized executor calls
and quote expiry. At submission the decoded proof must contain exactly that
sell withdrawal, fee withdrawal and executor invocation; only the final
wallet-resolved open-note id is variable. Generic fee requests cannot authorize
the swap route.

Endur private staking (D-063) is the optional `stake` route, disabled by
default: with no `BACKEND_ROUTE_STAKE_ENABLED` it is absent, and any other
`BACKEND_ROUTE_STAKE_*` variable fails startup. Once enabled, `_MAX_RELAY_FEE`,
`_MAX_QUEUE_DELAY_MS` (0, no artificial delay, under D-066) and
`_ALLOWED_TOKENS` are required, and the allowlist must be exactly STRK. It uses
the generic fee build and the ordinary submission queue, since no quote binds
it. At submission the decoded proof must
contain exactly one `Invoke` of the pinned `EndurDepositAnonymizer` with
`privacy_invoke(in_token, out_token, assets: u256, note_id)` calldata — the
authorized STRK in, pinned xSTRK out, a nonzero u256 — and exactly two
withdrawals: the authorized relay fee and `assets` of STRK to the anonymizer.
Only the wallet-resolved note id is variable.

Fee build returns an HMAC authorization binding route, fee token, operation
token, recipient, amount and block-validity window. The server keeps no quote
row to correlate with the later proof. Relayed pool routes (transfer, unshield,
stake) enter a bounded process-local admission queue as soon as they are
validated: D-066 removed the artificial delay, because every pool transaction
publishes the block its proof was built against, so a delay cannot hide timing
and only made the game's transactions stand out. The example configuration
sets `MAX_QUEUE_DELAY_MS=0`; a nonzero value is still honoured as bounded jitter
before the queue, and startup fails unless it leaves the request deadline 5 s of
headroom. Submissions are checked again after any wait against the current
block, current pool proof-validity window, and current route/token allowlists;
a stale or newly forbidden request is removed from the queue and can never
relay later. Quote-bound swaps skip both delay and queuing: if the
in-flight slot is unavailable they fail fast and must be re-quoted. Every
request also has a configured deadline. The edge abort signal and deadline are
propagated to AVNU and raw Starknet RPC, and timeout responses contain no
request material. Kill switches, fee caps, a global aggregate rate limit and
an aggregate fee-token sponsorship budget fail closed. `AggregateMetrics`
contains counts only; production alerts on `budgetExhausted` without attaching
a request identity. A multi-instance deployment needs one atomic aggregate
admission store because in-process counters and queue capacity are
instance-local (D-026).
`BackendApiOptions.rateLimiter` and `.sponsorshipBudget` accept atomic
deployment adapters; the in-memory defaults are for tests or a single
admission-control instance only.

Both the strict environment loader and direct `BackendApi` construction bound
the request deadline to Node's maximum timer delay (`2_147_483_647` ms). The
next integer would otherwise be reduced by Node to a one-millisecond timer.
The validated deadline is captured at construction; the remaining configuration
stays live so route-policy and kill-switch changes can still fail requests closed.

The code deliberately does not choose an HTTP framework or deployment host.
`createBackendFetchHandler()` is the deployable Fetch API edge: it performs
bounded streaming body reads, accepts same-origin JSON without reflecting
CORS, rejects query strings, returns `no-store`, and passes only
`{method, path, body, signal}` into the core. The signal carries cancellation,
not identity or financial data. The deployment must still disable
provider and platform request logging for these routes; a platform whose
default access log captures IP, path or latency would violate D-014 even though
the handler and core themselves log nothing.
