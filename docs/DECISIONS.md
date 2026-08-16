# Decision log

Why things are the way they are. Append, never rewrite — a superseded
decision gets a new entry that supersedes it, so the reasoning trail stays
intact.

Format: `## D-00N — Title` · **Date** · **Status** · Context / Decision /
Consequences.

---

## D-001 — Mainnet from day one, no testnet phase

**2026-08-16 · Accepted**

**Context.** The obvious engineering advice is to build on Sepolia and
migrate. The pool exists on Sepolia and it would be safer.

**Decision.** Build and ship on mainnet with real funds. Use tiny smoke
amounts during migration.

**Consequences.** No mandatory testnet phase, and no cutting a working
integration because it uses real funds. Every flow is exercised against the
real pool, real fees and real screening from the start — which removes an
entire class of "worked on testnet" surprises. It also means every mistake is
a real mistake, so the smoke-amount discipline is load-bearing.

---

## D-002 — Wallet API route; the game runs no privacy infrastructure

**2026-08-16 · Accepted**

**Context.** Two integration routes exist. The low-level Privacy SDK route
means holding viewing keys, running note discovery, building proof-carrying
transactions and operating a prover. The Wallet API route means asking the
player's wallet to perform a private action.

`shieldup` took the first route and paid for it: a Hetzner box running
Pathfinder, a transaction-prover and a discovery service, a custom
CPU-specific prover rebuild, and a full outage when Starknet upgraded to
0.14.3.

**Decision.** Wallet API. The game calls `wallet_strk20Balances`,
`wallet_strk20PrepareInvoke` and `wallet_strk20InvokeTransaction`. The wallet
holds keys, discovers notes, proves and submits.

**Consequences.** Zero infrastructure, zero key custody, no compliance
relationship — screening rides in from the wallet. In exchange, the
addressable audience is limited to wallets implementing the API, and the game
inherits whatever prompt and latency behaviour those wallets have.

`shieldup`'s prover, viewing-key derivation and proof-aware signer are
**reference implementations for a path we are not taking.** Do not port them.

---

## D-003 — v1 is extension-only; email/social login is deferred, not abandoned

**2026-08-16 · Accepted**

**Context.** Extension-free onboarding is wanted. `shieldup` proved
email-login onboarding works via Privy — but Privy is a *signer*, not a
wallet implementing `wallet_strk20*`, so that path requires the low-level SDK
and therefore a prover, which D-002 rules out.

No web wallet implements the STRK20 methods today. Verified: the current
StarknetKit web wallet connector exposes 16 `wallet_*` methods, none of them
STRK20, and ends in a `not implemented` default.

**Decision.** v1 supports extension connectors only. Write the privacy layer
against `WalletWithStarknetFeatures` so any wallet registering on the wallet
standard works, including a web wallet, with no code change.

**Consequences.** Onboarding requires an extension in v1 — a real funnel cost,
and the largest unknown in the project. But the architecture costs nothing to
be ready, and the ask to a wallet vendor is small and specific: expose the
three methods they already implement in the extension through their web
wallet too.

Do not let this decision remove other buildings from v1. Passkeys and
email login are an independent seam.

---

## D-004 — Submission is decoupled from avatar action

**2026-08-16 · Accepted**

**Context.** Entering a building is a timestamped event visible to every
player in the lobby and to our own server. The resulting pool interaction is
public on-chain. Timing correlation is the dominant deanonymisation heuristic
in the literature, and a shared world collapses the resolution to
milliseconds.

**Decision.** A submission queue sits between game action and broadcast,
applying randomised delay and batching. It is a first-class subsystem in
`apps/web` with its own tests.

**Consequences.** Actions do not feel instant, which the economy design
already accommodates because shielded actions are session events rather than
turn events. Without this, the game is a high-quality deanonymisation oracle
wrapped around a strong privacy pool — the cryptography would be perfect and
the product would still leak.

---

## D-005 — Never set cross-origin isolation headers

**2026-08-16 · Accepted**

**Context.** `COOP: same-origin` + `COEP: require-corp` are required for
`SharedArrayBuffer` and multithreaded WASM. They also break `postMessage`
popups and cross-origin iframes — precisely how web wallets and iframe
keychains communicate. The standards fix, `COOP: restrict-properties`, was
put on hold in 2025 and ships in no browser.

**Decision.** Never set them. Enforce with a header test in CI.

**Consequences.** We forgo in-browser multithreaded WASM, which we do not
need because we do no proving. If anyone later adds a WASM dependency wanting
threads, it becomes threads *or* web wallets — permanently, and silently.
This entry exists so that trade-off is visible when someone hits it in a
year.

---

## D-006 — Cap sponsorship, not user funds

**2026-08-16 · Accepted · supersedes an earlier recommendation**

**Context.** An earlier draft recommended a contract-enforced cap on user
balances to bound the blast radius of an unaudited system. That conflated two
different things.

**Decision.** No product-level cap on user funds — it is the user's money.
Apply controls to *gas sponsorship*, which is our money spent on behalf of
unauthenticated users: per-account and global rate limits, a per-transaction
fee ceiling, a budget with alerting, and a kill switch that disables
sponsorship without taking the game down.

**Consequences.** Users are not artificially constrained. Sponsorship cannot
become an open drain. Sybil resistance matters because account creation is
free and sponsorship is not.

---

## D-007 — Vesu excluded from v1

**2026-08-16 · Accepted**

**Context.** The Vault is the only building requiring new Cairo (a
`privacy_invoke` adapter), the only one without a working `shieldup`
precedent, and the only one putting an external audit on the critical path.

**Decision.** Ship v1 as Bank, Exchange and Post Office. Vesu comes after,
supply/redeem first; borrowing and collateral are a separate, larger piece.

**Consequences.** v1 needs no Cairo at all, so no audit gates launch, and the
6–8 week window is protected. The Vault ships as a visible but disabled
facade so the world reads as complete.

---

## D-008 — Embed Tiled tilesets

**2026-08-16 · Accepted · supersedes an earlier recommendation**

**Context.** An earlier draft advised external (un-embedded) tilesets from day
one, on the reasoning that they scale better across map versions.

Phaser's parser rejects them:

```js
if (set.source) {
    console.warn('External tilesets unsupported. Use Embed Tileset and re-export');
```

**Decision.** Embed tileset definitions in exported JSON, or flatten them at
build time.

**Consequences.** Following the earlier advice would have produced maps Phaser
silently refuses to load. Map authoring guidance lives in
`packages/world/README.md` so it is next to the work.

---

## D-009 — The Bridge is a fifth building, in its own package, and it is public

**2026-08-16 · Accepted**

**Context.** Players need a way to get value into STRKWORLD from another chain
and back out. `shieldup` already implements this over NEAR Intents 1Click
(`@defuse-protocol/one-click-sdk-typescript`), bidirectional, with a resumable
multi-leg pipeline — roughly 1,200 lines of proven orchestration.

**Decision.** Add a Bridge building in v1, in a **separate package**
(`packages/bridge`) rather than inside `packages/privacy`.

**Consequences.** The separation is the point: `privacy` is the STRK20 seam,
and the Bridge does not touch the pool. Folding it in would put public
cross-chain rails behind an interface named for privacy, which is how a
privacy claim gets made by accident. A CI check enforces that the bridge never
imports the privacy package.

The Bridge does need Starknet for the OUT-direction ERC-20 transfer, so the
"starknet only in `packages/privacy`" invariant widens to "privacy and bridge".
`world`, `lobby` and `shared` remain chain-free, which is what that invariant
was actually protecting.

**The honesty rule.** Bridging is a funding feature, not a privacy feature. A
bridge-in lands a public ERC-20 with a visible amount and recipient; shielding
happens afterwards at the Bank as a separate transaction. Bundling them would
publish the link the pool exists to break. The building's copy must say so.

StarkWare's own `privacy-bridge` (USDC over CCTP, with inbound and outbound
anonymizers binding the cross-chain message to the private note in one
transaction) is strictly better privacy and worth tracking for v2 — but it is
`0.1.x` and USDC-only today.

---

## D-010 — The React ↔ Phaser channel is the "event bus", not the "bridge"

**2026-08-16 · Accepted**

**Context.** Earlier documents called the React ↔ Phaser channel "the bridge".
D-009 introduced a Bridge *building*. Two unrelated things with one name, in a
repo several agents work in simultaneously.

**Decision.** The internal channel is the **event bus**. "Bridge" refers only
to the building and `packages/bridge`.

**Consequences.** A rename now costs a few minutes; ambiguity later costs an
agent building the wrong thing. `WorldEvents` and `ShellEvents` in
`packages/shared` are the event bus contract.

---

## D-011 — `packages/shared` is a frozen seam

**2026-08-16 · Accepted**

**Context.** Four lanes work in parallel. `packages/shared` carries the event
bus contract, the lobby schema and the building registry — a change there
breaks three lanes at once and surfaces at integration, when it is most
expensive.

**Decision.** `packages/shared` is frozen. Changes require a decision entry.

The lobby schema is deliberately the enforcement point for "the lobby never
sees money": `PresenceState` is the complete set of fields the lobby may hold,
so a field that is not there cannot leak. Note that *entering* a building is
excluded on purpose — position is public within the world, entry is not,
because entry plus public on-chain timing is a correlation attack.

**Consequences.** Slower to change one file; much faster to build four things
against it at once.

---

## D-012 — The Bridge is deposit-only, always to STRK, always ending shielded

**2026-08-16 · Accepted · narrows D-009**

**Context.** D-009 carried shieldup's bridge shape across: bidirectional, with
an arbitrary destination token reached via an AVNU swap leg. That is a lot of
UX surface — a direction toggle, a token picker, two quotes, two slippage
settings — for a building whose job is "put money in".

**Decision.** One path only:

```
any asset, any chain → STRK on Starknet → STRK20 pool
```

No OUT direction (exiting is the Bank's `unshield`). No destination token
choice. The player clicks Deposit and there is exactly one outcome.

**Consequences.** Roughly half the ported orchestration disappears, and the
**AVNU leg goes entirely** — 1Click delivers STRK on Starknet natively, so
fixing the destination removes a whole quote, a whole slippage setting and a
whole class of half-completed failures.

**The honest part.** "Directly into the pool" is one intent and *two*
transactions. `STRK20_DEPOSIT_ACTION` has no recipient field — pool deposits
are always to self and must be signed by the account making them — so the
bridge cannot shield on the player's behalf. The solver delivers STRK publicly,
then the player signs a shield, which also has a public leg.

An observer therefore sees "this address received STRK from a bridge, then put
it in the pool". That is unavoidable, and a delay does not hide it, because the
deposit leg is public either way. What is private is everything the player does
*after* arrival. The building's copy must land that distinction rather than
implying the player has become invisible by depositing.

**Sequencing ownership.** The shell orchestrates bridge → shield, because
`packages/bridge` must not import `packages/privacy` (D-009) and the shell
already owns cross-package sequencing.

---

## D-013 — Shielded STRK is the money and the gas

**2026-08-16 · Accepted**

**Context.** The game needs one asset to reason about. Multiple tokens, each
with its own balance, fee behaviour and maturity state, is a lot of surface for
a player standing in a pixel bank.

**Decision.** **Pool STRK is the medium of exchange and the fee token for
everything.** Prices are in it, gas is paid in it, and it is what a player's
balance means.

**This is supported, and verified rather than assumed.** AVNU's private
paymaster returns its fee as a `withdraw` action drawn from the pool:

```ts
type PrivatePaymasterFeeAction = { type: "withdraw"; recipient; token; amount }
```

The fee is a leg of the same private transaction, paid out of shielded notes.
`shieldup` ran this on mainnet for unshield, shielded send and shielded swap;
the SDK exposes it as the `sponsored_private` fee mode.

**The one exception: shielding itself needs public STRK.** A deposit is a
direct `approve → deposit` and its gas cannot come from a pool balance that
does not exist yet. You cannot pay for the transaction that creates your
shielded balance out of your shielded balance.

**Consequences.**

*Every private-side action is self-funding.* Once a player has a pool balance,
they never need public STRK again. No "top up for gas" step, no second asset to
explain.

*The Bridge resolves the exception by construction.* The solver delivers public
STRK; the player spends a little on gas for the shield and pools the rest. The
one flow needing a public reserve is the flow that just created one.

*Therefore: never shield the full public balance.* Leave a gas reserve, sized
from a live fee estimate rather than a constant. `shieldup` shipped this as a
known open UX defect — a player who shields everything is stranded one
transaction short of being able to do anything, and it reads as the app having
taken their money.

*Balances are two numbers, not one.* Public STRK (a gas reserve, transient) and
pool STRK (the actual balance). The HUD shows the second; the first appears only
when it is low enough to block an action.

*Fee ceilings are mandatory.* The paymaster names its own fee. Validate the
returned `fee_action` — token, recipient and amount — against a ceiling before
signing. `shieldup`'s `private-paymaster.ts` does exactly this and it is
directly portable.

*Server-side split is required, not optional.* The AVNU SDK warns that
`sponsored_private` needs an API key and "calling it from a browser leaks the
key". Fee build and submission go behind our own endpoints; proving stays
client-side in the player's wallet. This is the backend from D-009 and the
Shell lane owns it.

---

## D-014 — The backend is a first-class component with its own privacy rules

**2026-08-16 · Accepted**

**Context.** An independent review found that D-013 quietly put a server on the
critical path of *every* private action — fee build and submission must be
proxied because the AVNU paymaster key cannot ship to a browser — and that this
server had no package, no lane owner, no deployment story and no threat model.

Worse: **it is a stronger correlation oracle than the lobby the docs obsess
over.** It sees the call, the proof, the IP, and the session timing of every
private action, *before broadcast*. The lobby only ever sees position.

A second leak came with it. `.env.example` used a `VITE_` prefixed RPC URL,
which Vite compiles into the public bundle — so the game's own reads
(`get_public_key(<intended recipient>)` for the Post Office preflight, receipt
polling for tx hashes) hand a third-party RPC provider tuples of player IP,
intended recipient, and timing. That is a deanonymisation channel the
wallet-side privacy story never covers, because it is ours, not the wallet's.

**Decision.** The backend is a package with the same "must never" treatment as
the lobby:

- **Logs nothing per-request.** No IP, no call, no proof, no timing, no
  correlation between them. Aggregate counters only.
- **Proxies the RPC reads** so the recipient preflight and receipt polling do
  not leave the player's browser to a third party.
- **Holds the paymaster key**, and validates the returned `fee_action` against
  a ceiling before it ever reaches the player.
- **Owns the D-004 submission queue** (see D-015).

The client-side `VITE_STARKNET_RPC_URL` remains only for reads that are already
public and unlinkable, and must use a domain-allowlisted key.

**Consequences.** "The lobby is structurally incapable of seeing an address" is
true and was never sufficient. The operator can deanonymise through components
the threat model never mentioned. This entry makes the operator a modelled
adversary rather than an assumed-honest one.

---

## D-015 — Unfreeze `PrivacyOperations`; the submission queue moves server-side

**2026-08-16 · Accepted · amends D-004 and D-011**

**Context.** Two findings from the same review, with one root cause: decisions
were locked before the evidence that should shape them existed.

**`PrivacyOperations` was frozen wrong.** It offers only single-shot
`shield/unshield/transfer/privateSwap`, each its own transaction — but the
batch accumulator is the load-bearing economic mechanism in SPEC §6 and
ARCHITECTURE, and the interface has no batched-intent entry point. `PoolConfig`
and `WalletCapability` are defined and unreachable. D-013 requires validating
the paymaster fee *before signing*, which needs an estimate-then-confirm split
the one-shot methods cannot express. There is no `AbortSignal` on operations
that D-004 delays and proving makes slow.

**D-004's queue was misplaced.** Via `strk20InvokeTransaction` the *wallet*
submits on approval, so a client-side delay only delays when the prompt
appears — the player then approves and broadcast follows within seconds. It
delayed the prompt, not the broadcast, while adding a real defect: a prompt
firing after the player has walked away, or a lost intent if they closed the
tab. The project's own commissioned research said so plainly and the decision
was taken the same day without engaging with it.

**Decision.**

1. `PrivacyOperations` is **provisional, not frozen.** Revise it after the
   Phase 0 spike, then freeze. `WorldEvents` and `PresenceState` stay frozen —
   they do not depend on the spike.
2. The submission queue moves to the **backend, on the `strk20PrepareInvoke`
   path**, where broadcast timing is genuinely ours to control. Bounded by the
   450-block proof-validity window, and it must never delay a quote-bound AVNU
   action.
3. Copy states plainly that timing privacy is weak while the pool is small.
   Jitter does not defeat session-granularity correlation, and pretending
   otherwise is the kind of claim this project has committed not to make.

**Consequences.** One seam unfreezes and the lanes depending on it — Shell
especially — start against a provisional interface. That is the correct
trade: building four things against an interface known to be wrong is more
expensive than waiting a week for the spike.

---

## D-016 — Interiors are overlays; the avatar never leaves the street

**2026-08-16 · PARTLY SUPERSEDED BY [D-019](#d-019--entering-a-building-removes-the-avatar-from-lobby-presence)**

> The overlay choice stands. The requirement that the avatar remain on the
> street and make entry indistinguishable **does not** — D-019 accepts
> building-presence leakage for v1. Read D-019 before acting on this entry.

**Context.** An independent review found a leak the privacy design missed.
`PresenceState` deliberately excludes building entry — position is broadcast,
entry is not, because entry plus public on-chain timing is a correlation
attack.

But **position alone broadcasts entry anyway.** If the avatar disappears or
freezes at the Bank door while the interior scene loads, every other client
sees it happen, timestamped. The exclusion achieved nothing.

**Decision.** Building interiors render as **overlays over the street scene**.
The player never leaves it, so the avatar keeps existing, keeps its position,
and keeps behaving like everyone else's.

The alternative — a ghost or idle continuation while the player is elsewhere —
was rejected: it means maintaining a fiction that can desync, and a fiction
that desyncs is worse than no fiction, because now the tell is subtler and
nobody is looking for it.

**Consequences.** The world stays a single scene; buildings are UI, not
teleports. That is also a simpler engine architecture and it suits a hub.

Entering a building must remain indistinguishable from standing near it. That
means no entry animation the lobby can observe, no door state broadcast, and no
position freeze — a player in the Bank should still drift like an idle player
outside it.

---

## D-017 — v1 is a hub with working buildings; game design comes later

**2026-08-16 · Accepted**

**Context.** The review flagged that the financial layer is specified
rigorously and the game barely — a street, four doors, four panels, with
nothing yet making walking around worth doing.

**Decision.** That is correct and deliberate. v1 is a **hub**: the buildings
working is the whole target. Game design — what makes the world worth
inhabiting — is a later pass, owned by the project lead rather than derived
from a spec.

**Consequences.** The World lane builds a walkable, coherent street and four
functioning doors, and stops there. No quest system, no economy loop, no
progression. Resist inventing them; a half-designed game layer would be harder
to replace than an honestly empty one.

Success for v1 is: a player walks in, uses a real privacy protocol with real
funds, and understands what was private and what was not.

---

## D-018 — Every financial building needs an approved private execution path

**2026-08-16 · Accepted**

**Context.** A building is a themed interface to a wallet or protocol, not a
separate financial system. That simplicity creates a dangerous ambiguity:
"integrated" could mean a private pool action, a protocol's private executor,
or merely unshielding and calling its normal public entrypoint. Only the first
two preserve the product's purpose.

**Decision.** Shielded STRK is the game's core balance. The shell emits a
narrow, typed intent, and `packages/privacy` may execute it only through one of
three approved routes:

1. a pool-native Wallet API action, used by the Bank and Post Office;
2. a protocol's first-party STRK20 path, used by the Exchange through AVNU;
3. an app-specific `privacy_invoke` anonymizer, required for a protocol action
   with no first-party private path, such as the Vault.

An active route allowlists its contracts, selectors, tokens and action limits.
It validates minimum output or slippage, quote expiry, fee ceilings and the
route's kill switch. The browser never supplies an arbitrary target, selector
or calldata blob.

There is **no public fallback**. If an approved private route is absent,
unverified, disabled or stale, the building stays locked. The game must never
unshield and call from the player's wallet, or redirect to a normal protocol
frontend, while presenting the result as private.

The Bridge and the Bank's shield/unshield controls are deliberate public
boundaries, not fallbacks. They must label their public legs honestly and keep
shielding separate from the later private action.

For an anonymizer flow, the pool supplies the input to the helper, the helper
calls the protocol, and the output returns to a pool note atomically. This
hides the player's wallet address from the protocol action; it does not hide
the chosen application, action, timing, or necessarily the amount. Open-note
amounts are public. Production helpers are owned, reviewed, tested, audited,
deployed and maintained by this project; reference contracts are not
production approvals.

**Consequences.** Every current and future financial building has a privacy
admission gate before its door can be enabled. The Bank, Post Office and AVNU
Exchange can ship without project-owned Cairo. The Vault remains locked until
its helper and exact deployment pass review and audit. The world is an
orchestration UI over these capability-bounded routes; it is not a generic
transaction composer.

---

## D-019 — Entering a building removes the avatar from lobby presence

**2026-08-16 · Accepted · supersedes D-016's presence requirement**

**Context.** D-016 required a player inside a building to remain visibly idle
on the street so building choice could not be inferred. The project lead has
explicitly accepted building-presence leakage for v1: when a player enters a
building, other players may see that their avatar disappeared.

**Decision.** The interior may remain a local overlay, but entering it leaves
or suspends lobby presence. The avatar disappears for other players and
rejoins through the ordinary ephemeral presence lifecycle on exit. Lobby
traffic still never carries a building identifier, wallet address, action or
financial state.

**Consequences.** A nearby observer may infer the chosen building and visit
timing from the player's last coordinate and disappearance. That is an
accepted v1 trade-off, not a privacy claim. It does not relax D-018: the
financial action must still use an approved private execution path, and
backend submission remains decoupled where the route permits it. D-016's
overlay choice may remain, but its requirement that the avatar stay on the
street and make entry indistinguishable is superseded.

---

## D-020 — Absolute privacy is the default; every deviation needs approval

**2026-08-16 · Accepted · strengthens D-018**

**Context.** D-018 established that every financial building needs an approved
private execution path. It did not say *how private*, and the routes differ
sharply: a private transfer hides everything, an anonymizer-mediated swap hides
who but not how much, a shield names the depositor and the amount, and the
bridge is public end to end.

Left implicit, those differences get discovered by a player rather than decided
by us.

**Decision.** Privacy is graded, and **absolute privacy is the default**. Any
route below it is a deviation requiring two things before it can ship:

1. **Recorded approval from the project lead**, in
   `packages/shared/src/privacy-grades.ts`, with a rationale.
2. **Plain-language disclosure to the player**, stored in the same entry so the
   copy cannot drift from the grade it describes.

Four grades, each mapped to a verified protocol property rather than a
marketing label:

| Grade | Means |
|---|---|
| `private` | Parties and amounts hidden, no public leg. Ships without approval |
| `anonymous` | Parties hidden, **amounts visible**. Open notes carry plaintext amounts |
| `public-edge` | The action names the actor and the amount on-chain |
| `public` | No privacy claim |

**An unapproved deviation renders a locked door, not a downgrade.** Silently
shipping less privacy than the default is the single failure this exists to
prevent, and CI check 8 fails the build rather than trusting anyone to remember.

**Consequences.** Four v1 routes are deviations and currently await approval:
`bank.shield` and `bank.unshield` (`public-edge`), `exchange.swap`
(`anonymous`), and `bridge.deposit` (`public`). Only `post-office.transfer` is
`private` and ships unconditionally.

Run `./scripts/privacy-report.sh` for the current state. A new integration
cannot reach players before its grade is stated and, if it is a deviation,
approved — which is the point: the decision surfaces at integration time, to a
person, rather than being inherited by accident.
