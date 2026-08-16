# @strkworld/backend

**The server-side privacy boundary. Core request handling is implemented.**

The browser cannot hold the paymaster key or send privacy-sensitive RPC reads
directly to a third party. This app owns the smallest server surface needed to
submit eligible prepared Wallet API calls and proxy those reads.

## What this owns

- Paymaster-key custody and fee-action ceiling checks
- Recipient-registration and receipt RPC proxies
- Bounded submission jitter and concurrency for eligible prepared calls only
- A hard request deadline propagated to AVNU and Starknet RPC
- Aggregate rate, budget and health counters
- Global and per-route kill switches

AVNU's quote-bound first-party flow does not pass through the delay queue.

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

`BackendApi` is a framework-neutral, versioned handler for the exact six
operations the browser needs: pool-native fee build, quote-bound swap prepare,
prepared submission, pool config, recipient public key and receipt lookup.
Schemas reject unknown fields. The
submission validator accepts only the configured pool's `apply_actions`,
bounded calldata and a non-empty bounded proof. It verifies that the proof
output contains the same serialized server actions as the call, decodes that
`Span<ServerAction>`, and applies route policy: transfer/unshield cannot hide an
external `Invoke`, the exact authorized paymaster withdrawal must be present,
and a transfer cannot smuggle a public withdrawal.

For AVNU swaps the server selects an exact-input quote and requests
`quoteToCalls({ private: true })`. Its HMAC authorization additionally binds
the sell/buy tokens, sell amount, dynamic executor, serialized executor calls
and quote expiry. At submission the decoded proof must contain exactly that
sell withdrawal, fee withdrawal and executor invocation; only the final
wallet-resolved open-note id is variable. Generic fee requests cannot authorize
the swap route.

Fee build returns an HMAC authorization binding route, fee token, operation
token, recipient, amount and block-validity window. The server keeps no quote
row to correlate with the later proof. Pool-native submissions receive bounded
jitter, then enter a bounded process-local admission queue. They are checked
again after both waits; an expired request is removed from the queue and can
never relay later. Quote-bound swaps skip both delay and queuing: if the
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

The code deliberately does not choose an HTTP framework or deployment host.
`createBackendFetchHandler()` is the deployable Fetch API edge: it performs
bounded streaming body reads, accepts same-origin JSON without reflecting
CORS, rejects query strings, returns `no-store`, and passes only
`{method, path, body, signal}` into the core. The signal carries cancellation,
not identity or financial data. The deployment must still disable
provider and platform request logging for these routes; a platform whose
default access log captures IP, path or latency would violate D-014 even though
the handler and core themselves log nothing.
