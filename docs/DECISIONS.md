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

**2026-08-16 · Accepted · production boundary unchanged; D-057 defines an
external sibling tester without creating an exception inside STRKWORLD**

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

**2026-08-16 · Accepted · randomised relay delay SUPERSEDED by D-066**

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

The static half of that test scans shell and YAML source raw, including
comments. It deliberately does not attempt to model their expansion and
scalar grammars; comment exemptions are limited to syntaxes the gate can own.

**Consequences.** We forgo in-browser multithreaded WASM, which we do not
need because we do no proving. If anyone later adds a WASM dependency wanting
threads, it becomes threads *or* web wallets — permanently, and silently.
This entry exists so that trade-off is visible when someone hits it in a
year.

---

## D-006 — Cap sponsorship, not user funds

**2026-08-16 · Accepted · supersedes an earlier recommendation · per-account control superseded by D-026**

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

**2026-08-16 · Accepted · narrows D-009 · D-043 adds the fail-closed exact-planning gate**

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

**2026-08-16 · Accepted · paymaster key made optional (gasless relay) by D-068 · per-request logging exception for opted-in test deployments by D-069 · key required again for relayed routes by D-070**

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

**2026-08-16 · Accepted · amends D-004 and D-011 · development gate amended by D-028 · provisional seam status superseded by [D-036](#d-036--privacyoperations-is-frozen-on-source-derived-evidence)**

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

**2026-08-16 · SUPERSEDED — presence requirement by [D-019](#d-019--entering-a-building-removes-the-avatar-from-lobby-presence), overlay mechanism by [D-030](#d-030--a-building-has-two-modes-game-mode-primary-and-menu-mode)**

> Superseded twice, and neither remainder is safe to act on. D-019 accepts the
> avatar disappearing on entry, so the "stay on the street" requirement is gone.
> D-030 replaces the overlay mechanism entirely: interiors are now instanced
> walkable rooms (Game Mode), not React overlays. Read D-030 and D-019, not this.

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

**2026-08-16 · SUPERSEDED — v1 scope by [D-031](#d-031--game-mode-is-the-v1-target)**

> The "stop at working doors, no game design in v1" scope is superseded: the
> project leads have made Game Mode (D-030) the v1 target (D-031). D-017's core
> success criterion still holds — a player uses a real privacy protocol and
> understands what was private — but v1 is now a walkable instanced room, not a
> bare hub. This entry's reasoning on *why game design was deferred* remains the
> honest record; its scope conclusion does not. Read D-031.

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

**2026-08-16 · Accepted · strengthens D-018 · approval gate completed by D-024**

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

---

## D-021 — Public value gets funnelled back into the pool

**2026-08-16 · Accepted · partially superseded by D-023 for `exchange.swap`**

**Context.** Pool STRK is the game's money and its gas (D-013). Several routes
nevertheless leave value sitting in public: the Bridge delivers public STRK, and
a swap can land an output the player then holds outside the pool.

A player left holding public value has an unfinished journey and, worse, holds
something the game largely cannot use — they cannot pay a fee with it, and every
private action needs a pool balance.

**Decision.** Any route that leaves value in public must **offer the next step
back into the pool** rather than letting the player walk away. Encoded as
`returnToPool` on each register entry, so it is a property of the route rather
than a thing a panel might remember to do.

Currently true for `bridge.deposit` and `exchange.swap`.

**Consequences.** The Bridge is the clearest case: the solver delivers public
STRK, and the building should carry the player straight into shielding it —
minus a gas reserve, per D-013, since shielding everything strands them one
transaction short.

This is a prompt, not an automation. Shielding is always to self and must be
signed by the player, so it cannot be done for them; and quietly moving
someone's funds would be its own kind of wrong.

The nudge must persist. A player who bridges and closes the tab still has public
STRK, and should find the prompt waiting rather than discovering months later
that their funds never made it in.

---

## D-022 — One prepared batch produces one submission; wallet maturity is unknown

**2026-08-16 · Accepted · amends D-015 · funded-evidence caveat qualified by D-028**

**Context.** The production Wallet API adapter exposed two mismatches in the
provisional financial seam. First, `PreparedBatch.confirm()` returns one
transaction hash, while the interface prose claimed a shield-plus-spend batch
would be split into two submissions. That would either discard a receipt or lie
about atomicity. Second, `wallet_strk20Balances` returns only `{ token,
balance }`; it does not expose which notes are mature. Pretending the aggregate
is spendable creates an unsafe MAX button.

**Decision.** A prepared batch maps to exactly one submission route. Mixing a
public shield with a private spend is rejected; the shell prepares the shield
and later prepares the spend as separate, explicit operations. Homogeneous
pool-native actions may still batch atomically.

`PrivateBalance` retains the aggregate as `total` and gains
`maturityKnown`. The Wallet API implementation sets it false and reports
conservative zeroes for `spendable` and `maturing`; the deterministic fake sets
it true because it owns the simulated note ages. The shell must not derive MAX
when maturity is unknown.

Ready 5.33.8 source creates one wallet transaction action for a complete STRK20
action array, including deposit approvals, so the offline adapter models one
prompt per accepted batch. That is a source-derived expectation, not a claim
that the funded rendered UI has been observed.

**Consequences.** Shell lane heads-up: treat mixed shield/spend input as a
sequencing error, handle `maturityKnown: false`, and keep exact prompt copy
provisional until the funded UI run. No caller receives a fabricated maturity
split or loses one of two transaction receipts.

---

## D-023 — AVNU swaps are server-planned, wallet-proven and quote-bound

**2026-08-16 · Accepted · amends D-014, D-015 and D-018; partially supersedes D-021 · funded-evidence caveat qualified by D-028**

**Context.** The Exchange needs AVNU's dynamic private executor and paymaster,
but the browser cannot hold the paymaster key and must never be allowed to turn
a route into an arbitrary relay. The installed AVNU 4.2.0 SDK also establishes
an important output invariant: `buildStrk20Actions()` withdraws the sell asset
to the executor, pays the private fee, creates an `OPEN` output note for the
wallet, and invokes the executor atomically. The bought asset is already back
in the pool; D-021's Exchange return-to-pool prompt was therefore wrong.

**Decision.** The backend selects an exact-input AVNU quote, enforces minimum
output, chain, token allowlist, slippage and expiry, and calls
`quoteToCalls({ private: true })`. It returns the executor plan plus a stateless
HMAC authorization binding the route, sell/buy tokens, sell amount, executor,
serialized call prefix, fee and quote expiry.

The browser passes that plan to AVNU's `buildStrk20Actions()` and asks the
connected Wallet API account to prove it. On submission, the backend checks
that the proof output binds the pool call, decodes the resulting
`Span<ServerAction>`, and requires the exact authorized sell withdrawal, fee
withdrawal and executor invocation. The wallet-resolved open-note id is the
only unbound final felt. Swap preparation has its own endpoint; the generic fee
endpoint cannot authorize swaps. Quote-bound submissions are never delayed.

**Consequences.** The Exchange remains an approved first-party STRK20 route,
not a generic contract-call surface. A stale quote, wrong chain, unexpected
token, changed executor/call, excessive fee or disabled route fails closed
before relay. `exchange.swap.returnToPool` is false because the output is
already a private note; `bridge.deposit` remains true because bridge delivery
is public. Funded mainnet evidence is still required before launch to prove
Wallet API artifact compatibility with AVNU's live paymaster.

---

## D-024 — The approved privacy disclosures are canonical product copy

**2026-08-16 · Accepted · implements D-020**

**Context.** D-020 locked every below-private route until the project lead had
approved both the deviation and plain-language player copy. The project lead
approved the four proposed strings on 2026-08-16.

**Decision.** The disclosure strings in
`packages/shared/src/privacy-grades.ts` for Bank shield/unshield, Exchange swap
and Bridge deposit are the canonical approved copy. Panels import those values;
they do not paraphrase them locally.

**Consequences.** The four approved deviations pass the privacy gate. A future
copy change is another frozen-seam change and needs a decision entry so wording
cannot silently drift from the reviewed privacy grade.

---

## D-025 — Node 22.12 is the repository runtime floor

**2026-08-16 · Accepted**

**Context.** AVNU SDK 4.2.0 is the approved first-party private-swap route and
declares Node 22 or newer. Vite supports Node 22 from 22.12. Advertising Node
20 made a clean install appear supported while the Exchange dependency said it
was not.

**Decision.** Set the repository engine floor to Node 22.12. Do not suppress
engine checks or claim a Node 20 build target.

**Consequences.** Local development, CI and backend deployment use Node 22.12+
(the current workspace is newer). Any future downgrade must first replace or
obtain an explicit compatibility commitment for the AVNU SDK.

---

## D-026 — Sponsorship controls stay aggregate and unlinkable

**2026-08-16 · Accepted · partially supersedes D-006**

**Context.** D-006 asked for per-account sponsorship rate limits. D-014 later
made the backend an explicit correlation adversary and forbade durable request
identity. Keying private submissions by account, wallet or IP would give the
operator exactly the cross-request linkage the backend is designed not to
retain.

**Decision.** Do not add account/IP-keyed sponsorship state. Enforce a global
request-rate window, an aggregate token-denominated sponsorship budget, route
and transaction fee ceilings, HMAC-bound short-lived authorizations, and
global/per-route kill switches. A budget rejection increments only an
aggregate metric; production monitoring alerts on that counter without
recording the triggering request.

**Consequences.** A Sybil can consume shared capacity but cannot turn the
budget control into an account-correlation database. Multi-instance deployment
must back the global budget/rate counters with an aggregate atomic store or run
a single admission-control instance; process-local counters alone are not a
production-wide cap. Exhausting sponsorship locks financial doors without
taking down the city or exposing a public fallback.

---

## D-027 — The event bus contract, added retroactively to the frozen seam

**2026-08-16 · Accepted · retroactive; documents a change already merged**

**Process note, first.** Commit `7bd1bc1` added 24 lines to
`packages/shared/src/index.ts` — a frozen seam — **without a decision entry
first**, which D-011 requires. That was my error. This entry closes it rather
than pretending it did not happen, and the sequencing rule stands: for a frozen
seam, the decision comes before the code.

**Context.** `WorldEvents` and `ShellEvents` were frozen as data shapes, but
nothing described the *channel* carrying them. The world and shell each needed
to know what they were handed at init.

**Decision.** Add a type-only `EventBus<Events>` interface and a `WorldBus`
alias to `packages/shared`. Type-only because that package holds no logic; the
implementation lives in `apps/web` and is passed to the world at init, so the
dependency points one way — the world *receives* a bus, it never constructs one.

`WorldEvents` and `ShellEvents` are declared as **`type` aliases, not
interfaces**. This is load-bearing, not style: TypeScript gives type aliases an
implicit index signature and interfaces none, so an interface cannot satisfy
`Record<string, unknown>`. Leaving them as interfaces produced nine typecheck
errors on `main` — green tests, red build, which is the worst combination
because it teaches everyone to ignore red. Do not convert them back.

**Who this affects.** The World lane consumes the bus type; the Shell lane
implements and owns it. No payload shape changed, so nothing that was already
built against `WorldEvents`/`ShellEvents` breaks.

**Consequences.** The one-directional rule is now expressible in types rather
than only in review: the world can be handed a narrowed emit-only view out and
an on-only view in.

## D-028 — Development proceeds without the funded live-wallet run

**2026-08-16 · Accepted · amends D-015; qualifies D-022 and D-023**

**Context.** The remaining Phase 0 item is a funded live-wallet UI run on
mainnet — visible prompt sequence, real latency, and Wallet API artifact
compatibility with AVNU's live paymaster. It needs the project lead's funded
wallet, and it had become the single gate several strands of work were
waiting on. The Ready 5.33.8 source audit has already answered the structural
questions from shipped code.

**Decision.** The project lead has decided: **build as far as possible on
source-derived expectations, without waiting for live wallet runs.**
Divergences a later run reveals are handled as ordinary bugs and decision
amendments, not as blockers today.

- `PrivacyOperations` may be frozen on current source-derived evidence once
  the Chain lane judges it ready (decision entry plus heads-up, as always).
- Prompt-count and latency remain **provisional in code and copy**: drive UI
  from the hooks' pending states, never from an assumed count — SPEC §5
  rule 5 already requires exactly this.
- D-022 and D-023's funded-evidence caveats move from "gate during
  development" to **required validation on the pre-launch checklist**. The
  launch does not happen without the run; the building of it does.

**Consequences.** No lane waits on wallet access. The accepted risk is rework
where the funded run contradicts a source-derived expectation; the mitigation
is that every such expectation is already marked provisional. The funded run
stays on the launch checklist with its two named questions: the rendered
prompt sequence, and AVNU paymaster acceptance of a real wallet-produced
artifact.

## D-029 — Coordinated offline financial hardening may span the three owned lanes

**2026-08-16 · Accepted · retroactive process exception for commits `ca0f442`
and its immediate review-fix follow-up**

**Process note, first.** The hardening commit touched `packages/privacy`,
`apps/backend`, and `packages/bridge` before this decision was recorded. That
violated the one-lane-per-change rule even though the project lead had asked
for one continuous, no-mainnet hardening pass across those three financial
lanes. This entry records the exception instead of hiding it; future
cross-lane changes still require a decision first.

**Context.** Offline verification exposed related boundary failures at each
stage of the same financial path: wallet intent construction, private artifact
admission/relay, and public bridge quote/resume handling. Fixing only one lane
would have left the end-to-end claims false. The changes create no cross-package
imports, do not alter `packages/shared`, and preserve each package's ownership.

**Decision.** Treat this named audit and its immediate independent-review fixes
as one coordinated exception spanning only the three already assigned lanes.
Each implementation remains independently testable behind its existing seam.
This is not blanket authorization for future multi-lane commits.

**Consequences.** The audit can close with one coherent set of invariants and
evidence, while the usual lane boundary remains in force after the follow-up
commit. The breach and its reason are visible to every syncing agent.

---

## D-030 — A building has two modes: Game Mode (primary) and Menu Mode

**2026-08-17 · Accepted · supersedes D-016's overlay mechanism**

**Context.** Until now a building interior was a React panel overlaid on the
street (D-016). The project leads have chosen a richer interior model, and want
the panel stack kept as a secondary, faster path.

**Decision.** Every building is entered in one of two modes.

**Game Mode — the primary experience, the one we optimise for.** Entering a
building transports the player into a **fixed, instanced, walkable room** — it
should feel like a separate place, not a menu over the street. Inside:

- Each of the building's functions is a **station**: a square the player walks
  up to. Related functions may be **combined into one station** (e.g. shield +
  unshield share a station), and a station may cover a set of functions where
  that makes sense. How functions group is a design/UX detail we will adjust
  freely later — it is not load-bearing.
- Walking **next to** a station **highlights** it. The player **collides** with
  a station and cannot walk over it.
- Walking up to a station **opens an interaction window** for that function.
- **Execution is per-window** (see D-032): pressing the function in the window
  executes it there and then. Not accumulated and settled on room exit.
- Stations are **pixel-art illustrations** of their function eventually (a post
  box for transfer, a shield monument for shield/unshield). **Placeholder for
  now: the square simply carries the text label** ("shield", "transfer") for
  ease of testing while we build.

**Menu Mode — the secondary, direct path.** A **button hovers in the top-right**
of the screen while in a building. Clicking it opens the **existing panel UI**
— the full set of the building's functions at once. This is the stack already
built and tested (`PanelLayer`, the building panels, the disclosure system). It
is for advanced players, quick execution, and testing. We optimise Game Mode
first; Menu Mode is the escape hatch, not the default.

**All modes.** The avatar **leaves the overworld** for the duration of the
visit and rejoins on exit — this is D-019, and Game Mode makes it structural: a
separate room cannot leak the interior to the lobby.

**Guardrails — a mode changes the entry point, never the execution path.**

- A station or a Menu Mode panel is only a **themed entry to the same typed
  intent**. Both **must reuse the same `ConfirmGate` and the approved
  disclosure** (D-020, D-024). A station that executed a `public-edge` shield
  without the approved copy on screen would reopen the exact hole closed in
  PR #2/#6. The privacy machinery is shared; only the doorway to it differs.
- **A locked or unapproved route renders a locked station**, exactly as the
  Vault is a locked door today (D-018). The privacy-grade gate runs before a
  station goes live.
- **Combine functions within a grade, not across it.** Shield + unshield are
  both `public-edge`, so one station is clean. A station mixing a `private`
  transfer with a `public` shield would blur two different disclosures — each
  function still shows its own grade's copy at commit, so grouping should
  respect grade boundaries.

**Consequences.** D-016's overlay-vs-instanced-scene choice is superseded:
interiors are now instanced rooms, not overlays. **This introduces no privacy
regression** — D-016's privacy rationale (keep the avatar on the street so entry
is indistinguishable) was already conceded by D-019, which accepted the avatar
disappearing on entry. The one guardrail that survives from D-016: the room and
its transition are **client-local rendering only** — the lobby still sees only
the avatar vanish, never a room, a building id, or a function.

Lane split when we build: World lane (Phaser) owns the instanced room, station
placement, proximity highlight, collision, and the enter/exit transition. Shell
lane (React) owns the interaction window (reusing the built panels), the
Menu Mode button and panel, and mode state. The world↔shell seam
(`packages/shared`) is frozen (D-011); the new events Game Mode needs (a
station-activated event, a mode toggle) are a controlled seam extension and get
their own decision entry when we start.

---

## D-031 — Game Mode is the v1 target

**2026-08-17 · Accepted · supersedes D-017's v1 scope**

**Context.** D-017 set v1 as a bare hub — working doors and panels, and no game
design — and explicitly reserved the game-design pass for **the project lead**.
To be clear on who that is: the **project leads are this decision-making layer**
(the humans and the orchestrator setting direction); the sub-agents and other
instances are the workers who implement it. The project leads have now initiated
that pass.

**Decision.** **Game Mode (D-030) is the v1 target**, not a post-v1 phase. v1 is
no longer "doors that open panels"; v1 is a player walking into an instanced
building room and using its functions at stations, with Menu Mode as the
secondary path.

**Consequences.** This is not a reversal of D-017 so much as its intended
sequel: D-017 deferred game design to the project lead, and this is the project
lead exercising that ownership. The current hub demo (walkable street, doors
that open panels) stands as the **working baseline** we build Game Mode on top
of — we do not throw it away, we grow it. Scope for v1 is larger than D-017's
"stop at working doors"; the World and Shell lanes gain the Game Mode work
described in D-030. Success for v1 still includes D-017's core: a player uses a
real privacy protocol with real funds and understands what was and was not
private — now inside a room rather than over a menu.

---

## D-032 — Game Mode executes each function on use, not as a batch on room exit

**2026-08-17 · Accepted · amends D-015**

**Context.** The batch accumulator (D-015) collects intents during a building
visit and settles one atomic batch, chosen partly to amortise the per-action
pool fee across a session (SPEC §6). Game Mode offers a different interaction:
walk to a station, press the function, it happens.

**Decision.** In **Game Mode, each function executes when the player uses its
station** — per-window, immediately. It is **not** accumulated and settled on
room exit. The batch accumulator remains available in **Menu Mode** for players
who want to compose several actions and settle once; it is no longer the primary
settlement model.

**Consequences.**

- **Fee economics change in Game Mode.** Each station action is its own
  transaction with its own pool fee (6 STRK live, D-013) plus relay fee — there
  is no per-session amortisation. This is a conscious trade of fee-efficiency
  for immediacy and legibility. If per-action fees prove too costly in testing,
  revisit — Menu Mode's batching is the fallback lever, and this decision is the
  thing to amend rather than a hidden assumption to unwind.
- **Privacy is preserved.** Per-window execution does not re-link avatar action
  to broadcast timing (the D-004 concern): the avatar has already left presence
  on entering the room (D-019), so the lobby cannot observe in-room timing, and
  each action still routes through an approved private route (D-018) with
  backend submission decoupling where the route permits (D-015).
- **D-022 still binds.** A shield must not be bundled with the spend it funds.
  Per-window execution makes this easy — separate stations, separate
  transactions — but a combined station must not fold a deposit into the action
  it funds.

We are deliberately **not** fixing the finer per-window-vs-grouped execution
questions now; design will settle what a single station covers. The rule is:
execute on use, in Game Mode.

---

## D-033 — Game Mode extends the frozen event bus with opaque stations and control ownership

**2026-08-18 · Accepted · extends D-011 and D-027; implements the seam change anticipated by D-030**

**Context.** Game Mode needs the World to render and activate stations while
the Shell remains the sole owner of wallet state, route admission, disclosures,
mode state and financial execution. Encoding concrete actions or privacy grades
in Phaser would break the package boundary; encoding only a literal mode toggle
would leave input ownership and locked-station rendering implicit.

**Decision.** Extend the shared event vocabulary once, with this semantic
shape:

```ts
type StationId = `${BuildingId}:${string}`;

type GameModeWorldEvents = {
  'station:activated': { building: BuildingId; station: StationId };
};

type GameModeShellEvents = {
  'world:control-owner': {
    building: BuildingId;
    owner: 'world' | 'shell';
  };
  'world:stations': {
    building: BuildingId;
    stations: readonly {
      station: StationId;
      label: string;
      status: 'available' | 'locked';
    }[];
  };
  'world:exit-building': { building: BuildingId };
};
```

`world:exit-building` already exists with an empty payload; this decision adds
the active building so a stale React callback cannot eject the player from a
newer room. Commands for a building other than the active local room are
ignored.

Station IDs are **opaque presentation identifiers**, not action or route IDs.
The Shell owns the registry that maps a station to one or more existing panel
functions. That lets design regroup functions without changing the bus. Labels
and lock state are preformatted presentation data, like the existing HUD
events. A missing or unknown station defaults locked, and the Shell re-runs the
real route/privacy gate before it renders a functional window; the World's
snapshot is never authorization.

The Shell owns `game` versus `menu` mode. The World needs only to know who owns
controls. It suspends input **before** emitting `station:activated`; closing the
station window or Menu Mode returns control to the World. React owns Escape.
Walking next to an available station auto-opens it once per approach, matching
D-030; leaving the approach zone re-arms it. No focus event crosses the bus.

The first tracer is a procedural Bank room with a physical exit tile and one
`bank:shielding` station labelled `SHIELD / UNSHIELD`. The station may expose
only the first completed function while the slice is under construction; its
grouping is not a new execution path. Closing a station or Menu Mode returns to
the room. It does not exit the building. The physical exit ends the first
slice's visit; `world:exit-building` remains available for a later explicit
accessible exit control.

**Lobby consequence.** `apps/web` composes the `LobbyClient` lifecycle because
the Shell sees visit start/end and owns the explicit suspend/resume decision.
World continues to emit only movement and local visit semantics. Building,
room, station, mode and function identity never enter lobby state or traffic.

**Consequences.** World can build room geometry, collision, proximity and
transitions without money or wallet imports. Shell can build Game/Menu state
and reuse the existing panels and `ConfirmGate`. The initial asset contract is
procedural 32 px geometry and text; Art waits until room and station footprints
are frozen. Tests must cover fail-closed station state, control handoff before
activation, stale-building commands, listener cleanup, input reset, and the
unchanged lobby vocabulary.

---

## D-034 — A lost private-submission response is non-retryable uncertainty

**2026-08-18 · Accepted · extends the D-015 submission contract · recovery acknowledgement extended by D-035 · unblocks the D-028 seam freeze after implementation**

**Context.** Commit `59bfc8b` preserves a private transfer or swap receipt once
the submission gateway has delivered a transaction hash. A connection can
still disappear after the backend accepts the transaction but before the
browser learns the hash. The current `unreachable` copy says “Nothing was
sent,” and a blind retry can duplicate an action that settled.

A backend idempotency-key-to-transaction-hash store could recover this state,
but it would introduce the per-request linkage D-014 deliberately excludes.
The project does not add that correlation surface to solve a rare transport
ambiguity in v1.

**Decision.** Add `submission-uncertain` to the public `PrivacyErrorKind`. Once
a private submit request has been dispatched, a transport failure before a
validated hash reaches the browser maps to this kind, not to retryable
`unreachable`. Pre-submit configuration, fee, proof and wallet failures keep
their existing precise outcomes.

`submission-uncertain` is **single-attempt and non-retryable**. The Shell must
retain it above the interaction window for the rest of the browser session and
show copy that does not claim success or failure:

> We could not confirm whether this private action was submitted. Do not retry
> it yet. Reconnect, wait a few minutes, and refresh your private balance before
> taking another action.

Closing a station, switching mode or leaving the room must not erase that
notice. Automatic retry, a “Try again” control, and “Nothing was sent” are all
defects for this outcome. Durable cross-reload persistence of private financial
history remains a separate privacy decision; this decision requires session
retention, not local storage.

**Consequences.** Chain and Shell may make one coordinated seam change under
this decision: the error kind and backend-client classification in
`packages/privacy`, then exhaustive copy/state/receipt handling in `apps/web`.
No backend schema or storage change is authorized. Once that change is tested,
the Chain lane may record the explicit source-derived `PrivacyOperations`
freeze allowed by D-028. Funded Ready/Xverse behavior and real paymaster
acceptance remain pre-launch validation, not development gates.

---

## D-035 — Balance-check acknowledgement releases the uncertainty gate

**2026-08-18 · Accepted · extends D-034 after the Shieldup production-reference audit · D-072 adds one player-initiated balance read at entry, answered as a boolean**

**Context.** D-034 says a hashless post-dispatch response loss is non-retryable
and keeps a notice for the browser session. A review found that closing and
reopening the Bank still creates a fresh form, so copy alone does not prevent a
duplicate economic intent. The player can deliberately read their private
balance, but that read is eventual state reconciliation rather than a
submission receipt: a changed balance is useful evidence, while an unchanged
balance can still mean pending confirmation, note discovery lag, maturity or a
temporarily unavailable wallet service.

The audited Shieldup reference behaves the same way. It polls note discovery
and offers manual refresh, but has no hash-to-note correlation, idempotency key
or authoritative submission lookup. Easy balance access therefore makes the
ambiguity recoverable; it does not make immediate retry safe.

**Decision.** D-034's session notice becomes an enforceable acknowledgement
gate, not a full-session lock. While an uncertainty is active and
unacknowledged, every Bank entry path may show balance refresh and recovery
information but must not start, prepare or confirm a financial action. The
player releases the gate only through an explicit control labelled:

> I refreshed and checked my private balance

That control is an acknowledgement of the player's check, not an automated
claim that STRKWORLD correlated a balance delta to the lost request. After it,
new actions are available again and the session still shows:

> A previous private action is still unconfirmed. You checked your refreshed
> balance before continuing.

If another uncertain submission occurs, the gate closes again and needs a new
acknowledgement. There is never an automatic retry. The session state may hold
only `active` and `acknowledged` booleans: no intent, token, amount, recipient,
timestamp, hash, balance snapshot or request handle, and no local storage.

**Consequences.** Shell owns the gate and enforces it at both the rendered Bank
surface and the Bank machine's public action seam. Balance reads remain
player-initiated Wallet API calls; they are not feature detection and the
acknowledgement does not force an additional balance-consent prompt. Chain and
Backend contracts do not change. Once the Shell tests prove retention across
station/Menu/room transitions, re-locking on a second uncertainty, and blocked
prepare/confirm paths, D-034/D-035 are complete and the Chain lane may take the
D-028 freeze.

---

## D-036 — `PrivacyOperations` is frozen on source-derived evidence

**2026-08-18 · Accepted · implements D-028 and supersedes D-015's provisional seam status · narrowly extended by D-041/D-042 for truthful swap review, and by D-063 for private staking · failure taxonomy extended by D-070 (`relay-not-configured`) · methods extended by D-072 (`hasPrivateFunds`, `depositStatus`)**

**Context.** D-015 correctly unfroze the original one-shot interface. The
replacement intent-based, prepare-then-confirm seam is implemented by both the
wallet-backed adapter and deterministic fake. D-034 now distinguishes a lost
post-dispatch response from retryable pre-submit failure, and D-035's reviewed
Shell gate retains that uncertainty for the browser session and blocks further
actions until explicit balance-check acknowledgement. The conditions D-028 set
for a source-derived development freeze are therefore complete.

The required freshness check was rerun before this decision. The published
`next` tags moved to discovery 6.0.4 and wallet-standard 6.0.5, and upstream
replaced `packages/sub_account_anonymizer` with
`packages/shadow_account_anonymizer`. Stable Wallet API 0.10.3 and AVNU 4.2.0
did not move. Those facts do not change this seam: STRKWORLD remains on its
exact tested direct pins, and no shadow-account route is admitted by v1.

**Decision.** Freeze the current exported financial contract in
`packages/privacy/src/operations.ts` and `types.ts`: the five
`PrivacyOperations` methods, typed `Intent` variants, `PreparedBatch`
prepare/confirm/discard contract, its warnings and costs, pool/capability and
balance shapes, recipient status, transaction result/progress shapes, and the
public `PrivacyErrorKind` taxonomy.

Any change to that contract now requires a decision entry and a heads-up to
dependent lanes before implementation. Wallet implementation details, live
pool values, route configuration and dependency upgrades are not silently
authorized by this freeze; each remains governed by its existing boundary and
verification rules.

**Evidence boundary.** This is a **source-derived development freeze**, not a
claim that funded mainnet behavior has been validated. The `promptCount` field
shape is frozen, but its rendered value, prompt sequence and latency remain
provisional. Ready/Xverse behavior and AVNU acceptance of a real
wallet-produced artifact remain mandatory pre-launch checks under D-028. A
contradiction from that run is handled through a new decision and coordinated
seam change, never by quietly editing the frozen interface.

**Consequences.** Dependent lanes may now treat `PrivacyOperations` as stable.
D-015's queue placement and two-phase rationale remain in force; only its
provisional status is superseded. D-034/D-035 remain the required handling for
hashless private-submission uncertainty, with no automatic retry or recovery
storage.

---

## D-037 — Lobby failure degrades to explicit solo play

**2026-08-18 · Accepted · SUPERSEDED in part by D-055 for the production
entry path; connected-app behavior remains · completes D-019's unavailable-
path behavior**

**Context.** D-019 removes an avatar from lobby presence while the player is
inside a building, and D-030 assigns the `LobbyClient` lifecycle to the Shell.
The lobby client and server already implement privacy-minimal movement,
payload-free suspend and position-only resume, but neither decision says what
the product does when `VITE_LOBBY_URL` is absent, the initial join fails or an
existing lobby connection drops.

Blocking the World would be simpler at the first render, but it would turn a
non-financial presence outage into an outage for navigation, private balance
access and financial actions. Silently continuing would be worse: the player
would reasonably believe multiplayer presence was active when it was not.

**Decision.** Once the production wallet entry gate admits the player, lobby
availability is independent of financial availability. If the lobby is missing
or unreachable, STRKWORLD remains fully playable in **solo mode** and shows a
clear multiplayer-unavailable status. It never invents peers or claims a
connection exists. A configured endpoint gets an explicit manual reconnect
control; there is no automatic retry loop. D-055 supersedes only the earlier
claim that this solo-capable World could mount before wallet admission.

The presence lifecycle has only the states needed to make that truthful:
connecting, connected, suspended and unavailable. The Shell connects only
after it has the first real street placement, forwards only the frozen
`player:moved` payload, suspends on local building entry and resumes from the
World's restored street placement on physical exit. A reconnect must never
make the avatar reappear while the player is inside a building; it waits for or
is completed from the next street placement.

Lobby errors, endpoint values and connection timing do not enter lobby state,
financial state or transaction copy. The unavailable surface carries no
wallet, building, station, action or balance detail. Room entry, financial
controls and D-034/D-035 recovery remain usable while presence is unavailable.

**Consequences.** This adds a small, isolated Shell status/reconnect surface
and lifecycle controller. It adds no blockchain, backend, lobby-server,
storage or shared-event contract. Tests must prove explicit connect ownership,
StrictMode-safe listener cleanup, street-only reconnect, suspend/resume order,
continued World/financial availability, and that no lobby call receives a
building or financial field.

---

## D-038 — Remote avatars use a replaying World-owned source

**2026-08-18 · Accepted · technical direction delegated to the project lead**

**Context.** D-019 and D-037 put `LobbyClient` connection ownership in the
Shell and freeze the privacy-minimal lobby payload, but the client's peer
snapshots have no approved path into Phaser. Sending a one-shot peer event over
`ShellEvents` looks small but is not sufficient: a snapshot can arrive while
Phaser is still loading or remounting, and the current event bus deliberately
does not retain or replay state. Adding it there would also widen the frozen
`packages/shared` seam from D-011 with lobby-shaped data.

An imperative World handle has the opposite problem. It gives the Shell a
renderer method whose availability depends on asynchronous Phaser boot,
StrictMode cleanup and HMR, forcing the caller to buffer state and understand
World lifecycle details.

**Decision.** Remote-avatar state crosses a dedicated, World-owned
`RemotePeerSource` seam. Its external interface has one operation:
`subscribe(listener)`, which synchronously replays the current immutable full
snapshot, publishes later full snapshots in arrival order, and returns an
idempotent unsubscribe. An empty snapshot is authoritative and removes every
remote avatar; omission of one opaque peer ID removes that avatar.

The source shape contains only an opaque ephemeral ID, world position, facing
and an approved cosmetic sprite key. The Shell adapts
`LobbyClient.onPeers()` into that shape and owns all connection, replacement,
error and reconnect behavior. World owns validation, full-snapshot
reconciliation, safe sprite fallback, interior visibility and Phaser teardown.
The World receives no lobby status, endpoint, close code, reconnect state,
building, wallet or financial field, and performs no network action.

The latest snapshot is retained across World boot/remount so delivery cannot
race scene subscription. A lobby drop, client replacement or controller
destruction clears it. While the local player is inside a building, the World
hides the remote-avatar layer; the retained peer snapshot may continue to
update and is reconciled when the street returns. Remote avatars are
presentation-only and never participate in local collision.

This is a narrow state source beside the D-010 event bus, not a replacement
for it. `WorldEvents` and `ShellEvents`, the lobby `PresenceState`, and the
frozen `PrivacyOperations` contract remain unchanged.

**Consequences.** The new interface and its Phaser-free tests live in
`packages/world`; the concrete Lobby-to-World adapter lives in `apps/web`.
`WorldConfig` receives the source before scene creation. Tests at the approved
seams must prove synchronous replay, full replacement/removal, drop and
teardown clearing, stale-client listener cleanup, invalid-data fail-closed
behavior, street/interior visibility, and StrictMode-safe unsubscribe. Smooth
interpolation may be added behind the World interface later; timestamps,
revisions, map IDs and animation metadata are not added to the cross-lane shape
for v1.

---

## D-039 — Fixed Game Mode rooms share one data-driven core; Post Office is the second tracer

**2026-08-18 · Accepted · technical direction delegated to the project lead · extends D-030–D-033 · rendered Bank/Post Office room-and-station status updated by [the 2026-08-28 finding](../AGENTS.md#2026-08-28--room-navigation-and-three-admitted-stations-pass-bridge-deposit-stays-locked)**

**Context.** The accepted Game Mode target gives every v1 building a fixed,
walkable, client-local room with opaque stations. The Bank tracer proves the
event ordering, input handoff and per-window financial path, but its geometry,
controller and Phaser adapter are named and structured around one Bank station.
Copying that implementation for each remaining building would duplicate the
privacy-sensitive control handoff, fail-closed station admission, exit/presence
ordering and collision rules. Creating a separate Phaser scene per building
would instead add asynchronous scene lifecycle and bus propagation to a model
that needs only different fixed data.

**Decision.** World gets one Phaser-free fixed-room core configured by a room
definition: building ID, dimensions, spawn, physical exit, and one or more
opaque station footprints with fallback labels. It owns geometry validation,
solid tiles, approach detection, fail-closed Shell snapshot normalization,
single-activation arming, matching-building commands, input ownership, physical
exit and teardown. The existing street scene remains the sole Phaser scene and
adapts whichever configured room is active. Room entry still occurs before the
synchronous `building:entered` event reaches Shell; street placement is restored
and reported before `building:exited`; remote avatars remain hidden throughout
the local interior.

The current Bank definition and public compatibility exports remain
behavior-identical: 18×12 tiles at 32 px, spawn `(9,9)`, two-tile bottom exit,
and `bank:shielding` at `x=8..9,y=3`. The Post Office is the second definition
using the same stable 18×12 envelope, spawn and exit, with one solid
`post-office:transfer` station at `x=3..4,y=3` labelled `TRANSFER`. Shared room
dimensions keep camera/transition behavior predictable while station placement
remains data that later art can replace.

Shell adds that opaque station and maps it only to the already approved
`post-office.transfer` route. The existing financial panel/machine is deepened
with an explicit non-empty allowed-mode list and initial mode; Bank Game Mode
keeps Shield/Unshield, while the Post Office station exposes Transfer only and
allows one intent. Recipient preflight, typed intent construction, balance and
uncertainty gates, receipt lifetime, route admission and `ConfirmGate` remain
the same implementation. The private route needs no disclosure, but it still
passes through the gate. Post Office Menu Mode remains the truthful existing
`UnbuiltRoom` in this slice; a station does not imply a fabricated full panel.

No `WorldEvents`, `ShellEvents`, `PresenceState`, `PrivacyOperations`, privacy
route or player-facing privacy claim changes. A need for a visit token,
different route, new copy or shared event is a new decision rather than an
implementation convenience.

**Consequences.** Tests must preserve every Bank behavior while proving the
generic core against both definitions: locked-until-current-snapshot,
malformed/duplicate rejection, station collision and re-arming, suspend-before-
activate, stale-building command rejection, building-specific safe return,
remote-avatar visibility and idempotent teardown. Shell tests must prove that
Post Office publishes only its transfer station, rechecks route admission at
activation, renders no Shield/Unshield or batch controls, executes one typed
transfer through the existing commit path, and leaves Menu Mode explicitly
unbuilt. Browser acceptance remains user-owned.

---

## D-040 — Post Office Menu Mode is the transfer-only batch surface

**2026-08-18 · Accepted · technical direction delegated to the project lead · completes the bounded deferral in D-039 · Exchange deferral completed by D-042 · transfer batching narrowed to one recipient per send by D-065**

**Context.** D-030 and D-032 already define Menu Mode as a building-wide
transaction surface that batches compatible typed intents for one later
confirmation. D-039 deliberately stopped after the Post Office Game Mode
station so adding a station could not silently fabricate a full panel. The
remaining Post Office surface now has no unresolved financial behavior: its
only approved route is the pool-native private transfer, and the existing Bank
machine already owns transfer intent construction, recipient preflight,
batching, preparation, confirmation, receipts and uncertainty handling.

Building a second transfer state machine would split those invariants. Turning
the whole panel registry into a configurable financial-form framework would
instead broaden a seam for one building-specific set of defaults.

**Decision.** Post Office Menu Mode uses a small semantic panel adapter over
the existing financial machine. It supplies the Post Office title, permits only
`transfer`, opens on `transfer`, and uses `experience="menu"`. Menu Mode may
therefore batch several compatible private transfers under D-032; the
`post-office:transfer` station remains the D-039 one-intent Game Mode path.

The Post Office panel is added to the existing building-panel registry. The
ordinary privacy gate still runs before registry resolution, and the panel
still rechecks the route at action time. It shows no Shield or Unshield control,
accepts no raw target or calldata, adds no public fallback, and introduces no
new product or privacy copy. Because `post-office.transfer` is the project's
fully private route, the existing `ConfirmGate` must remain present but has no
deviation disclosure to render.

No World, shared-event, lobby, backend, Bridge or `PrivacyOperations` change is
part of this slice. Exchange remains unbuilt until its quote and minimum-output
confirmation surface is specified; Bridge composition remains independent.

**Consequences.** Shell tests must prove registry admission, transfer-only
controls, Menu Mode batch vocabulary and more than one compatible transfer,
recipient preflight, commit-gate/receipt/uncertainty reuse, route-disabled
fail-closed behavior, and unchanged one-intent Post Office station behavior.
Exchange, Bridge and Vault continue to resolve honestly according to their
current registry and route state. Browser acceptance remains user-owned.

---

## D-041 — Prepared swaps expose sanitized quote review, not relay authority

**2026-08-18 · Accepted · technical direction delegated to the project lead · narrow extension of the D-036 freeze · minimum-source rule superseded by D-042**

**Context.** The Exchange is the next substantive v1 Game Mode building. The
source-derived Wallet API adapter already receives AVNU's expected buy amount
and quote expiry, while its configured swap policy supplies slippage. It
validates those values before proving and again before submission. The frozen
`PreparedBatch` contract, however, exposes only the original swap intent,
aggregate fee figures, warnings and prompt metadata.

That is enough to show what the player sells and a minimum output they typed,
but not the quote they are actually reviewing. Asking a player to invent a
minimum without an expected output is a poor real-funds surface; displaying an
expected amount, expiry or slippage inferred elsewhere would be worse. Raw
quote IDs, executor calls and fee authorizations must also stay behind the
privacy boundary because they are relay authority, not product review data.

**Decision.** Add one optional source-derived review field to `PreparedBatch`:

```ts
interface SwapReview {
  expectedAmountOut: bigint;
  minimumAmountOut: bigint;
  slippageBps: number;
  expiresAt: number;
}

interface PreparedBatch {
  readonly swapReview?: SwapReview;
  // existing frozen fields and methods remain unchanged
}
```

It is present only for a successfully prepared single swap. The Wallet API
adapter maps `expectedAmountOut` and `expiresAt` from the already validated
`PreparedPrivateSwap`, copies `minimumAmountOut` from the typed intent, and
copies `slippageBps` from the exact policy used to request and validate the
plan. Production construction must reject malformed, expired or inconsistent
values before returning the batch. The deterministic fake may expose review
data only from explicit deterministic inputs; it must not read the clock,
invent a market rate or label the minimum as an estimate.

The field contains no quote ID, executor, calls, calldata, HMAC authorization,
paymaster detail or submit handle. It does not authorize anything and is not a
recovery handle. Confirmation still revalidates the quote and submits it
immediately: quote-bound routes retain zero intentional delay and cannot enter
the ordinary queue. D-034/D-035 still govern hashless response loss as
non-retryable session uncertainty.

**Consequences.** This is the smallest justified change to the D-036 public
shape; all five `PrivacyOperations` methods, intent variants, confirmation
semantics, error taxonomy and other public fields remain frozen. Chain updates
the Wallet API adapter, deterministic fake, exports, tests and package docs.
Shell receives a dependent-lane heads-up now and must require `swapReview` at
the Exchange commit surface rather than fabricating missing quote data. The
backend response already carries expected output and expiry, so no backend or
shared-event schema changes. Any wish to expose raw quote or relay fields is a
new decision.

---

## D-042 — The Exchange reviews AVNU's protected minimum over a six-asset display catalog

**2026-08-18 · Accepted · technical direction delegated to the project lead · implements D-030–D-032, completes D-040's Exchange deferral and amends D-041's minimum mapping · rendered Exchange room/station status updated by [the 2026-08-28 finding](../AGENTS.md#2026-08-28--room-navigation-and-three-admitted-stations-pass-bridge-deposit-stays-locked) · the ground floor keeps these six assets, but the degen floor's runtime catalog (a backend-fetched avnu list) is added by D-067**

**Context.** D-041 exposed the expected output, the typed intent's minimum,
the configured slippage and quote expiry. Tracing the installed AVNU 4.2.0
implementation found a sharper distinction: `quoteToCalls` derives the amount
actually protected by the executor as
`expected - floor(expected × slippageBps / 10,000)`. The operation order is
intentional: integer rounding can make the algebraically rearranged expression
one base unit lower. The current backend only checks that the quote's expected
output exceeds the intent minimum. A player could therefore type a floor above
AVNU's protected amount, see that floor in the review, and still receive less.
That is not truthful enough for real funds.

The repository also had no product token catalog. The production Shieldup
reference at `290f8306571ce45e630c5a08b243d7b5f8c232b4` uses a checked-in,
mainnet-tested six-token catalog for shielded swaps: STRK (18 decimals), ETH
(18), USDC (6), USDT (6), WBTC (8) and strkBTC (8). It offers only positive
shielded balances as sell assets, permits any different catalog asset as the
buy side, and lets AVNU route availability fail closed. It does not establish
STRK/USDC as a privileged pair.

**Decision.** The v1 Exchange uses that six-token catalog, with the exact
mainnet addresses and display metadata checked into `apps/web`. It is
presentation data, never route authority: the wallet policy and backend
`BACKEND_ROUTE_SWAP_ALLOWED_TOKENS` remain the enforcement boundary, and a
missing/disabled route stays locked or fails closed. STRKWORLD does not fetch
AVNU's broad token list at runtime and does not admit user-added tokens in v1.
The player explicitly asks the wallet to read those six balances; no automatic
balance read occurs. Only positive balances become sell choices, the buy choice
must differ, and the catalog order supplies the deterministic default.

Both Exchange modes execute one swap at a time. Game Mode adds one opaque
`exchange:swap` station to the existing fixed-room core. Menu Mode presents the
same single-swap flow without batch controls: swaps cannot share a prepared
batch, so a Menu label must not imply fee amortisation that cannot happen.

The Shell requests a plan with the smallest positive quote floor and never
shows that provisional intent. Chain canonicalizes the prepared swap to AVNU's
policy-protected minimum using exact bigint basis-point arithmetic; both
`PreparedBatch.intents[0].minAmountOut` and
`PreparedBatch.swapReview.minimumAmountOut` carry that value. The deterministic
fake derives it only from explicit expected-output/slippage inputs. Backend
independently rejects any requested quote floor above the amount protected by
the same AVNU calculation before issuing relay authority. This supersedes only
D-041's rule that copied the incoming floor; the public shape stays unchanged.

The commit surface shows the exact sell and expected-buy amounts, the protected
minimum, configured slippage, absolute quote expiry, pool/network/total fees,
and D-024's canonical Exchange disclosure. It never exposes quote ID, executor,
calls, calldata, HMAC authorization, paymaster details or a recovery handle.
Confirmation remains immediate and single-attempt; D-034/D-035 uncertainty,
session receipts owned by `exchange`, close-mid-submit behavior and manual
balance refresh remain unchanged.

**Consequences.** No new browser/backend API, shared event or public
`PrivacyOperations` field is required. World changes only authored room data;
Shell owns the display catalog and interaction; Chain owns prepared-review
canonicalization; Backend owns the independent floor guard. Tests must prove
catalog identity/uniqueness, explicit balance gating, distinct pairs, missing
review fail-closed behavior, exact protected-minimum rounding, backend rejection
of an unenforceable requested floor, canonical disclosure, exact fees/expiry,
one confirmation, Exchange receipt ownership, uncertainty retention and
unchanged Bank/Post Office behavior. Rendered acceptance remains user-owned.

---

## D-043 — Bridge v1 is manual, direct and wallet-bound; exact shielding fails closed

**2026-08-18 · production planner lock SUPERSEDED by D-061 · Accepted and implemented through production recovery; new
financial continuation remains locked · SUPERSEDED in part by D-055 for
production no-wallet entry; production fee-aware planning remains a D-028
funded gate · rendered Bridge navigation/exit status updated, with physical
station admission still open/locked, by [the 2026-08-28 finding](../AGENTS.md#2026-08-28--room-navigation-and-three-admitted-stations-pass-bridge-deposit-stays-locked)
· completes D-009/D-012's v1 composition choice and adds no method to the
D-036-frozen `PrivacyOperations` seam**

**Context.** The independent Bridge package already owns a signed, resumable
1Click deposit record, but the game has no Bridge room or Shell controller.
Three facts decide the composition. First, the pinned 1Click SDK works directly
from the browser without a credential; official provider documentation prices
that route at a 0.2% platform fee, while a JWT must remain secret. Second, a
bridge quote must deliver to the currently connected Starknet account, not a
free-form address. The Wallet API account already has a source-derived
`address`, so widening `PrivacyOperations` just to expose identity would weaken
the seam. Third, the existing shield preparation reports zero gas estimate and
there is no generic Wallet Standard fee estimator. Subtracting a constant from
real funds would only disguise that missing capability.

**Decision.** Bridge v1 uses the pinned 1Click SDK directly and
unauthenticated. There is no backend credential proxy and no browser JWT. The
surface discloses the provider's 0.2% unauthenticated platform fee and shows
the signed quote's exact input, expected output and minimum output. It does not
invent a total fee breakdown or label the provider's currently unexplained
`appFees` echo as a STRKWORLD fee; that response field is a provider-clarification
launch check.

Only manual deposit mode is exposed in v1. The existing signed-origin package
path remains dormant rather than creating chain-wallet adapters in the Shell.
World adds a real fixed Bridge room with one opaque `bridge:deposit` station;
Shell owns its meaning. Entering or touching the station never starts a quote,
poll, wallet prompt or transaction. Every consequential step remains an
explicit player action under D-004.

The real composition root retains the concrete connected Wallet API account
alongside `PrivacyOperations`. A new quote binds its Starknet recipient to that
account's validated address; the player cannot edit it. Address comparisons use
validated Starknet field-element equality, not display spelling. A recovered or
imported record remains structurally refreshable, exportable and inspectable
without a wallet in the BridgeStore and explicit offline/test composition, but
D-055 keeps the production UI behind the wallet entry gate. No production
screen is reachable to exercise that record without an admitted wallet. No new
quote or shield continuation is allowed unless the active account matches the
signed recipient. An account switch blocks new quotes and shielding
immediately, but preserves the old recipient-bound record for status refresh,
inspection and export when the production gate is later re-admitted. It never
retargets or silently discards that evidence.

`BridgeRecord` in the browser-local `BridgeStore` is the authoritative bridge
progress and dispute-evidence record. It is sensitive, survives reload, may be
explicitly exported/imported, and remains after settlement until the player
explicitly discards it. It is not copied into the privacy receipt ledger or a
server database. The later shield is a separate Bank-owned transaction and
receipt; STRKWORLD persists no Bridge-to-shield correlation.

Reserve sizing is a separate, optional Chain-owned public capability,
not a sixth `PrivacyOperations` method and not a Bridge dependency on Privacy.
The public port and sanitized plan shape are retained, with
`amountToShield` meaning the deposit action amount and
`plannedReserve = poolFee + estimated public gas`; a valid implementation must
prove `amountToShield + plannedReserve <= available`. All monetary fields use
the same Bridge public-STRK input-token denomination; a planner must reject a
fee or gas estimate in another denomination. A zero governance pool fee is
valid, but the gas estimate must remain positive so `plannedReserve` cannot be
zero. However, the current
Ready high-level route is explicitly unsupported: its shipped source visibly
approves only the deposit amount while canonical `apply_actions` separately
pulls `fee_amount` from the caller. Chain must not infer an extra approval,
wallet execute fallback or AVNU/paymaster fee behavior. The real Bridge-to-Bank
handoff remains locked until a funded/source-verified fee-aware route, or a
separately reviewed route, is accepted. The deterministic fake is for offline
demo/test estimates only and is not production capability.

There are two deliberate phases. Before a real new provider quote or its
deposit instructions, Shell requires a matching active account and an injected
production planner that preflights the signed minimum output; a missing, failed
or non-positive plan keeps that real handoff locked. Saved or imported signed
evidence remains structurally retained without that planner or an active
account, but production access to its UI still requires the D-055 wallet gate;
explicit offline/test compositions may inspect it without a wallet. After
1Click
reports `SUCCESS`, Shell uses the actual validated `strkReceived`, rechecks the
active account and requests a fresh maximum-shield plan. It revalidates that
plan at the Bank commit point, and the ordinary Bank fee ceiling and
confirmation checks remain authoritative. Missing or stale estimates, a
changed account, non-positive remainder, inconsistent recipient/reserve
arithmetic or a changed plan block the handoff. The player then explicitly
reviews and signs the ordinary Bank shield; it is never submitted automatically
and quote-time output is never used as the settled balance.

**Consequences.** Chain adds and tests only the separate public-shield planner
port and deterministic fake (which requires the explicit token denomination,
allows a zero pool fee, and rejects zero gas); no production Ready adapter or
wallet-fee claim
crosses the seam. World adds only room definition/presentation data. Shell
composes the Bridge machine and injected offline planner, but a real new Bridge
deposit
stays locked while the planner is absent. Bridge remains independent of
`packages/privacy`; Backend and lobby do not change. Tests cover fake address,
field/uint256 bounds, aborts, reserve subtraction, non-positive remainders,
changing deterministic estimates and the absence of a production Ready
planner. Ready/Xverse prompt packaging, account deployment, allowance/fee
handling, live fee ceilings and one tiny mainnet completion remain funded
pre-launch checks. Rendered game acceptance remains user-owned.

---

## D-044 — Kenney Urban CC0 is the placeholder art base

**2026-08-19 · SUPERSEDED by [D-059](#d-059--the-world-renders-in-3d-with-threejs) — the 3D World is drawn from
procedural geometry and no longer slices the Kenney 2D atlas · previously accepted
by the user, placeholder scope only**

**Context.** The World tracer currently uses procedural and placeholder
presentation. Art needs a commercially safe base for roads, grass, pavement
and generic city structure, while the protocol facades and station states
remain product-specific. The exact visual identity is not yet final.

**Decision.** The Art lane may use the Kenney Urban CC0 pack at clean 2× as a
placeholder base. It may not imply that Kenney authored STRKWORLD's protocol
identity: facades, labels, station states and privacy-specific treatments stay
separate and may be replaced. A parallel research lane scans for a closer CC0
16-bit/JRPG-like base before any final art lock. No asset is downloaded or
committed by this decision.

Every acquired file still needs a source URL, pack/version, license evidence,
retrieval date, modifications and `assets/CREDITS.md` entry. Kenney's CC0
status is the reason this is safe as a placeholder, not a waiver of provenance
or of later aesthetic review.

**Consequences.** Art can begin a license/source manifest and a reversible
placeholder integration brief immediately. Final palette, facades, room art,
atlas format and station-state treatment remain open until the comparison
and user review are complete. World/Shell contracts do not change.

---

## D-045 — Fly.io is the deployment topology

**2026-08-19 · Accepted by the user as delegated technical direction · provider configuration deferred**

**Context.** The web build, privacy backend and Colyseus lobby need one
browser origin for `/api`, a long-lived `wss` presence service, runtime-only
secrets and exactly one admission-control instance while the controls remain
process-local. A static site plus a separately exposed backend would violate
the same-origin constraint.

**Decision.** Target one public Fly.io app/Machine with a small edge/composition
process that serves `apps/web/dist`, routes same-origin `/api` to the backend,
and upgrades the lobby WebSocket. Keep exactly one active backend/admission
instance until D-026 aggregate adapters exist. Use Fly-managed TLS/custom
domain support and runtime secret injection; never put secrets in Vite output,
Docker build arguments or image layers. No Fly account, domain, secret or
service is created by this decision.

**Required launch checks.** Verify provider/platform access-log behavior against
D-014, confirm no COOP/COEP headers are added, test deploy overlap does not
create two active admission instances, verify runtime secret rotation, and
test `/api` plus `wss` from two browser sessions. A separate RPC-provider
decision remains pending the current hackathon-document scan and is not made
here.

**Alternatives considered.** Render Web Service and Railway Service remain
viable one-service alternatives with similar edge composition work; separate
static-site plus backend deployments are not accepted without a same-origin
proxy. Vercel Functions are not selected because the current long-lived
Colyseus/process-local design is not a serverless fit.

**Consequences.** The deployment lane may draft a minimal Fly topology and
staging checklist, but must stop before account creation, provider
configuration, domain purchase, secret upload or production deployment until
those operational permissions and values are explicitly supplied.

---

## D-046 — Use Alchemy for the initial Starknet RPC provider

**2026-08-19 · Accepted as a provisional technical choice · no account or key created**

**Context.** The browser needs a public mainnet RPC URL whose access can be
restricted to the eventual domain. The backend needs a separate private RPC
credential with server-side restriction. The hackathon/build-document scan did
not establish a suitable free mainnet production entitlement or a better
provider-specific control path. Alchemy's official documentation explicitly
establishes Starknet mainnet endpoints, keyed accounts, domain allowlists and
IPv4 allowlists.

**Decision.** Use Alchemy for now, with two operationally separate applications
or keys:

- a browser/public app restricted by the production origin/domain;
- a server/private app restricted by the backend deployment's source IPs.

The browser key is public by design and may be compiled into Vite only after a
domain exists. The server key remains runtime-only and never enters source,
Vite output, Docker build args, image layers or logs. No Alchemy account, app,
key or endpoint is created by this decision.

**Required checks before funded validation.** Confirm exact Starknet RPC method
and version support, domain/IP enforcement on the selected plans, quotas and
429 behavior, key rotation, provider retention/access-log terms and whether
the deployment edge presents stable source IPs. Keep D-028's funded Wallet
API/paymaster run separate: an RPC provider does not prove wallet prompts,
private proof acceptance or transaction execution.

**Alternatives.** QuickNode remains a viable fallback if its Starknet plan
exposes the documented endpoint security controls. Self-hosted Pathfinder/Juno
offers control at the cost of node operations and a public read proxy. Neither
is selected here.

**Consequences.** The Backend/RPC lane may prepare a no-secret staging probe
and provider-control checklist. It must stop before account creation, key
procurement, domain allowlisting or production configuration until the user
supplies the necessary account/permissions and values.

---

## D-047 — The hidden Avatar Studio owns eight paired cosmetic characters

**2026-08-19 · PARTIALLY SUPERSEDED — interior portal direction by
[D-048](#d-048--the-avatar-studio-uses-a-top-wall-return-portal), runtime art
geometry and final-art approval by
[D-049](#d-049--avatar-art-uses-one-fixed-64x64-logical-canvas);
remaining foundation implemented and rendered accepted on localhost**

**Context.** The sprite studio is developing the player art independently from
the World implementation. The current multiplayer contract has eight opaque
cosmetic keys, while the user's requested art set is eight characters with two
visual variants each. The user also wants character selection to be a small
world interaction rather than a long menu overlay, without adding a financial
or identity meaning to appearance.

**Decision.** v1 uses the existing single lobby `sprite` field for exactly
sixteen opaque cosmetic-state keys: `avatar-1` through `avatar-8` are the
cosy/default states and `avatar-9` through `avatar-16` are their fighting
partners (`1↔9`, `2↔10`, through `8↔16`). The pair meaning is local registry
data; no stance field or stance message is added to the lobby. The selection
room is a hidden, non-financial Avatar Studio: it is outside `BuildingId` and
`BUILDINGS`, has no visible facade or public map label, and uses dedicated
non-financial world events (`avatar-studio:entered`, `avatar-studio:exited`,
and `avatar:selected`) so the financial `VisitLayer` cannot render it. The
street path extends south from the spawn directly to the bottom/offscreen
edge; walking into that end enters the hidden room. The room displays eight
collision-selectable avatar figures. Touching a figure selects that character
in its cosy/default state. A keyboard control will toggle the selected
character between its paired states; the exact key remains open and no key is
bound until the user chooses it.

Appearance has no wallet, account, protocol, building or financial meaning.
The lobby continues to receive only an allowlisted opaque cosmetic state and
position/facing; it never receives a selection identity or room/building
meaning. The default and fallback are `avatar-1`. The World, lobby and edge
registries must expand to the sixteen keys atomically; until that rollout the
current eight-key deployment remains the safe live contract. The final art,
palette, names and key-to-art mapping remain subject to the user's approval in
the sprite-studio task.

Cosmetic selection is page/runtime state only: reload, tab close and a new
session reset to `avatar-1`; durable persistence is out of scope. The room
remains subject to the existing interior presence lifecycle: entering it
suspends lobby presence, and the selected key is used when street presence
resumes. No avatar selection may trigger a wallet read, quote, balance
operation or transaction.

**Consequences.** World owns the hidden entrance, path extension, room
geometry, collision and selection figures. Shell owns the local cosmetic state
handoff, if an existing composition seam requires one. The approved
nonfinancial WorldEvents extension is limited to
`avatar-studio:entered`, `avatar-studio:exited` and `avatar:selected`;
ShellEvents and the lobby schema remain unchanged. Lobby and deployment must
update their trusted allowlist together with World rendering once the atomic
implementation and sprite-art handoff are complete; partial rollouts fail
closed to the existing default rather than exposing arbitrary values. Art
supplies eight compatible characters with two states each and a manifest, but
does not change the runtime contract or choose financial/protocol semantics.

This decision extends D-030's fixed-room model to a non-financial cosmetic
room. It does not change D-019 presence rules, the lobby schema, ShellEvents,
or any privacy/financial route; its three named WorldEvents are the controlled
event-bus extension for this room.

---

## D-048 — The Avatar Studio uses a top-wall return portal

**2026-08-19 · Accepted by the user · supersedes D-047's interior
bottom-opening direction; implementation pending**

**Context.** D-047 correctly fixed the hidden street entrance at the south end
of the spawn path, but the first room foundation also put the Studio's exit in
its bottom wall. That reverses the visual direction of travel: the player walks
south off the street and then appears near a second south-facing exit. The
interior needs to make the transition read as one continuous passage rather
than two unrelated doorways.

**Decision.** The hidden exterior entrance stays where D-047 put it: the path
continues south from spawn to the map's bottom/offscreen trigger, with no
facade or public label. Inside the 18x12 Avatar Studio, the only portal is a
centered two-tile-wide, one-tile-deep opening in the **top** wall. Entry places
the player on a walkable interior tile immediately below that opening, so
continuing to move down travels farther into the room. Leaving requires walking
back up through the same top-wall opening.

The portal is navigation geometry only. It does not turn the Studio into a
`BuildingId`, station or financial visit, and it does not add an event or lobby
field. Exit must preserve the established D-047 ordering: restore and publish
the real street placement before `avatar-studio:exited` lets Shell resume
presence.

**Alternatives.** Keeping the bottom-wall exit was rejected because the room
transition reads backwards. Adding separate entrance and exit portals was
rejected because it invents an unnecessary route through a small selection
room. Moving or revealing the exterior entrance was rejected because the user
still wants the Avatar Studio hidden at the end of the south path.

**Consequences.** World must update the authored Studio exit, spawn,
walkability, presentation and transition tests together. The eight selector
figures, opaque cosmetic keys, presence suspension and non-financial event
seam remain unchanged. The previously accepted localhost test covers the
foundation and hidden exterior entrance, not this new interior portal
orientation; rendered acceptance is required again after implementation.

---

## D-049 — Avatar art uses one fixed 64x64 logical canvas

**2026-08-20 · PARTIALLY SUPERSEDED by [D-059](#d-059--the-world-renders-in-3d-with-threejs) for in-World
rendering (avatars are procedural 3D figures; these sheets remain the colour
reference and D-058's wallet-cue source) and by
[D-052](#d-052--avatar-animation-contract-and-avatar-studio-f-toggle) for
animation geometry and the Avatar Studio fighting-toggle status; 2026-08-19
accepted by the user; 2026-08-20 art-production amendment authorizes all eight
characters through final handoff and supersedes the
interim pause after characters 1/4/6/7 · supersedes D-047's provisional 32x32
runtime-art assumption; final `v1/` handoff committed at `86e8f5f`, independently
QA-verified and visually approved by James for runtime integration; World
integration and rendered in-game acceptance pending**

**Context.** The approved art direction deliberately includes two larger
characters and fighting poses whose weapons extend beyond a 32x32 cell. A
layered body/weapon renderer could preserve that old cell size, but it would
add animation synchronization, directional front/back layers, extra draw
objects and a more fragile art pipeline. Variable per-character canvases would
move size knowledge into every caller and make feet alignment inconsistent.

**Decision.** Every visual state behind `avatar-1` through `avatar-16` uses one
transparent **64x64 logical canvas** with a fixed feet point at **(32, 56)**.
The authoritative gameplay footprint remains the existing centered 24x24 body
for the local player and the same 24x24 contact footprint for Studio selectors;
visual size never changes collision, reachability, movement or selection.
Smaller characters retain their intended scale through transparent padding.
Characters 4 and 7 may occupy more of the same canvas, but do not receive a
different canvas or body.

The lobby still carries only the existing opaque `sprite` key. No visual size,
stance, feet, pivot, layer or weapon field is added to shared or lobby state.
World resolves all canvas and anchor meaning locally from the allowlisted key.
If a runtime atlas trims transparent pixels, its metadata must preserve the
64x64 logical `sourceSize` and the (32, 56) pivot exactly; callers must observe
the same logical canvas as an untrimmed export.

The final delivery is exactly sixteen transparent **192x256 PNG sheets**, one
for each opaque `avatar-1` through `avatar-16` key. Each sheet is a 3-column by
4-row grid of 64x64 cells: the existing `idle`, `walk-1`, `walk-2` columns and
`down`, `left`, `right`, `up` rows. The handoff also includes one tagged,
editable Aseprite source. A combined mega-atlas is not part of the delivery.

The art lane owns that final handoff at exactly
`packages/world/assets/player-sprites/v1/`. Its root contains
`avatar-1.png` through `avatar-16.png`, `manifest.json` and `README.md`; the
tagged editable source is `source/player-sprites.aseprite`, and mechanical QA
evidence lives under `qa/`. The existing `v1-review/` package remains review
provenance; its existing artifacts are neither moved nor overwritten by the
final delivery. Fixing this destination layout did not itself assert that any
`v1/` file existed, passed QA, was runtime-ready or had been integrated; the
separate final-art approval below is the evidence that later cleared the art
handoff for World integration.

No frame may contain baked shadow pixels. World may render one consistent
shadow separately behind every local, remote and Studio avatar; that shadow is
presentation only and does not change the fixed feet point or 24x24 gameplay
body.

**Initial 2026-08-19 gate — superseded by the 2026-08-20 authorization below.**
The user first approved the sixteen true-resolution idle calibrations, one for
each opaque key, and authorized movement prototypes only for characters 1, 4,
6 and 7 before a mandatory pause. That calibration review was not approval of
the movement pixels or runtime assets.

**2026-08-20 art-production authorization.** The user has now authorized the
art lane to carry all eight characters, both cosy and fighting states, through
the complete production process without the former 1/4/6/7 pause: remaining
movement work for characters 2, 3, 5 and 8, final transparent exports, the one
tagged editable source, mechanical QA and the final handoff are all unblocked.
The fixed canvas, feet/body, sheet topology, opaque-key mapping and no-baked-
shadow requirements above remain unchanged. At that stage this authorized art
production and handoff only; it did not make an intermediate or final file
runtime-ready, authorize World integration, or replace final in-game rendered
acceptance. The World-integration restriction is superseded by the final-art
approval immediately below; the rendered-acceptance restriction is not.

**2026-08-20 final-art approval.** Commit `86e8f5f` contains the complete
`packages/world/assets/player-sprites/v1/` handoff: all sixteen per-key PNG
sheets, the tagged editable Aseprite source, manifest and mechanical QA
evidence. A separate independent QA review verified the fixed sheet/cell
geometry, binary transparency, feet and body references, source round trip,
frame vocabulary, shadow-free pixels and required character distinctions.
James then visually approved those committed assets for runtime integration.
This clears the final-art gate only: it does not claim that World has loaded or
rendered the sheets, and it does not replace the required in-game rendered
acceptance after implementation.

Variable per-key canvases and separate body/weapon layers are rejected for the
initial runtime. They require a later decision if final accepted art proves the
single-canvas contract insufficient. This decision does not approve the
current review sheets for runtime: they still contain baked backgrounds and
are not the final transparent export.

**Consequences.** The Art lane's `player-sprites/v1/` handoff is complete and
approved; `v1-review/` remains immutable provenance. World is now authorized
to integrate the sixteen committed 192x256 sheets through one World-local
semantic avatar-visual resolver. That resolver takes only an allowlisted opaque
`avatar-1..avatar-16` key and owns the per-key sheet, 64x64 logical canvas,
fixed `(32, 56)` feet origin and `idle`/`walk-1`/`walk-2` frames for all four
facings. Local players, remote peers and Avatar Studio selectors must use that
same resolver so fallback, frame selection, origin and scale cannot diverge.

The existing centered 24x24 local physics body and 24x24 Studio contact body
remain authoritative and must not be resized to the visual silhouette. Source
frames have no baked shadow; World may add at most one consistent optional
runtime-owned shadow behind every avatar presentation. Integration changes are
World-local: no lobby/wire field, shared type, Fly allowlist or financial seam
changes. The fighting-state toggle key remains open and unbound unless a newer
decision explicitly approves it; art integration does not choose that key.

Tests must pin exact sheet/cell geometry, logical canvas, feet, frame
vocabulary, transparent padding, shadow-free source pixels, fixed 24x24
gameplay geometry, all sixteen opaque-key mappings and common
local/remote/Studio resolution. After implementation, separate rendered
acceptance must cover the small character, both large characters,
cosy/fighting pairs, all four facings, walk cadence, optional runtime shadow
and weapon extents before the placeholder renderer is retired.

---

## D-050 — The standalone Backend owns graceful signal shutdown

**2026-08-19 · Accepted technical decision · implemented at `375bad4` and
verified by hosted CI run `32282522737`**

**Context.** Commit `7adc821` added quarantined production-image boot smokes.
GitHub Actions run
[`32279807295`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32279807295)
proved that the Fly image builds, reaches readiness and stops cleanly. The
standalone Backend image also built and reached TCP readiness, but its smoke
started at `17:08:53.501` and failed after Docker stop at `17:08:57.255`:
3.754 seconds around the configured three-second grace. The smoke reported
that the exit status was not the expected `143`; it did not log the actual
status.

At `7adc821`, the image used an exec-form `CMD`, so Node was PID 1. Neither
`deploy/backend/launch.mjs` nor `apps/backend/src/server.ts` installed a signal
handler, and `server.ts` discarded the `RunningBackendServer` returned by
`listenBackendServer()`. Node 22.12's source registers reset-on-handle
defaults for `SIGTERM` and `SIGINT`; that handler resets terminal state and
re-raises the signal. Docker documents both that a PID-1 process ignores a
signal whose action is default and that `docker stop` sends `SIGKILL` after its
grace expires. The timing and failed status therefore make a forced `SIGKILL`
/ exit `137` the high-confidence explanation, but not an observed fact because
this CI log did not print the code. Sources: [Node 22.12 signal-handler
source](https://github.com/nodejs/node/blob/v22.12.0/src/node.cc#L178-L181),
[Node 22.12 handler registration](https://github.com/nodejs/node/blob/v22.12.0/src/node.cc#L655-L658),
[Docker PID-1 signal
behavior](https://docs.docker.com/reference/cli/docker/container/run/#pid-settings---pid)
and [`docker container
stop`](https://docs.docker.com/reference/cli/docker/container/stop/).

**Decision.** Do not accept a forced kill as successful Backend shutdown.
Backend owns an explicit `SIGTERM`/`SIGINT` lifecycle around the live
`RunningBackendServer`. Both signals enter one single-flight shutdown path:
close that server exactly once, allow successful close to finish with exit
`0`, and finish nonzero if close fails. Repeated or overlapping signals must
not double-close the server. Do not weaken the smoke to accept `137` or `143`.

The public test seams are an injectable lifecycle boundary that proves signal
coalescing, one close, success and failure outcomes, plus the final hosted
standalone image. Its smoke remains network-none, uses only inert/disabled
financial configuration, makes no API request, and must reach readiness then
stop with exit `0` inside a bounded five seconds.

**Alternatives.** Accepting the forced kill was rejected because it can drop
live connections without exercising application cleanup. Adding only an init
wrapper was rejected because forwarding a signal still leaves the Backend
without ownership of its live server. Moving the handler into the deployment
launcher was rejected because `apps/backend` creates and owns the
`RunningBackendServer`; keeping lifecycle beside that handle is the smaller
and testable boundary.

**Consequences.** Commit `375bad4` implements the injectable, single-flight
lifecycle, retains the live server through startup, closes it exactly once on
either signal, exits `0` after success and nonzero after failure, and changes
the standalone smoke to require bounded exit `0`. GitHub Actions run
[`32282522737`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737),
deployment job
[`96164346536`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737/job/96164346536),
then passed both deployment typechecks, both image builds and both image
smokes in 1m12s; the full typecheck/test job also passed. This supersedes the
failed lifecycle result from run `32279807295`, while retaining that run as
the evidence that exposed the defect.

This is operational lifecycle work only. It changes no `PrivacyOperations`
method, HTTP route or response, schema, lobby field, financial policy or
submission semantics. Hosted image lifecycle is now verified. Host access-log
policy, TLS, secrets, real Alchemy/RPC and AVNU calls, live staging, deployment
and funded routes remain unverified.

---

## D-051 — Share the production origin policy between Node-only lobby callers

**2026-08-19 · Accepted technical decision · implemented at `d6f2bad`**

**Context.** Production hostname classification is deployment policy for the
Node lobby, not browser or shared-domain logic. The lobby production entrypoint
and the Fly startup path had duplicated hostname checks. Duplicated regular
expressions drift: one caller can reject a loopback or placeholder form while
the other accepts it, leaving startup validation and request-origin validation
with different security boundaries.

**Decision.** Put one small, Node-only policy helper in
`packages/lobby/src/production-origin.ts` (or an equivalently named module).
`packages/lobby/src/production.ts` and `deploy/fly/src/main.ts` consume that
helper. Do not export it through the browser-facing/root lobby entry and do not
move the policy into `packages/shared`. Each caller retains its existing
canonical whole-origin formatting and parsing rules; the shared helper only
classifies the resulting production hostname.

The policy rejects loopback hosts, including all IPv4 `127/8` and
IPv4-mapped IPv6 loopback forms, localhost descendants, `.invalid` names and
explicit placeholder labels. It must not reject legitimate substring domains
such as `your-company.com`, `replaceable.example.com` or
`placeholdertech.com`. Fly and lobby tests pin the same adversarial matrix
atomically so a future policy change cannot update one caller in isolation.

**Alternatives.** Keeping the two regexes separate was rejected because their
security behavior can drift. Exporting the helper through the browser/root
lobby entry was rejected because production deployment policy is not a client
contract. Putting it in `packages/shared` was rejected because it would widen a
Node-only concern into a cross-runtime dependency.

**Consequences.** Commit `d6f2bad` implements the internal helper and routes
both `packages/lobby/src/production.ts` and `deploy/fly/src/main.ts` through
it. The lobby and Fly tests pin the same loopback, localhost, `.invalid`,
placeholder and legitimate-substring matrix, including dotted and hexadecimal
IPv4-mapped IPv6 loopback forms. Production startup and lobby admission share
one tested classification boundary without changing CORS, protocol schema,
presence messages, financial routes, logging or browser behavior. The helper
is a deployment guard, not proof of domain ownership, TLS, provider readiness
or funded-route readiness.

---

## D-052 — Avatar animation contract and Avatar Studio F toggle

**2026-08-20 · PARTIALLY SUPERSEDED — the sprite-sheet animation contract is
superseded for in-World rendering by [D-059](#d-059--the-world-renders-in-3d-with-threejs) (procedural 3D
walk cycle); the Studio-only F scope is superseded by
[D-053](#d-053--the-f-outfit-toggle-follows-the-local-avatar-throughout-world-play) ·
supersedes the animation-geometry and Avatar Studio toggle portions of
[D-049](#d-049--avatar-art-uses-one-fixed-64x64-logical-canvas) · Avatar 1
cosy rendered acceptance accepted 2026-08-28 by the status amendment below;
Avatar 1 fighting and avatars 2-16 remain open**

**Context.** The browser recording attempt failed to establish rendered
acceptance. It is therefore not evidence that the integrated final art or its
movement reads correctly in-game. Research confirms that each direction needs
four unique walk poses in addition to its idle: contact-left, passing-left,
contact-right and passing-right. The Aseprite MCP was evaluated but not
adopted because it is unofficial and immature, and no local Aseprite
executable is available. PixelOver and Pixelorama remain optional authoring
candidates, not project dependencies.

**Decision.** The replacement handoff uses the same sixteen opaque
`avatar-1..avatar-16` keys and one transparent 64x64 cell per logical frame,
but supersedes D-049's 3-column/192-frame animation geometry with five
columns per direction: `idle`, `contact-left`, `passing-left`,
`contact-right` and `passing-right`. Each sheet is therefore **320x256**
(five columns by four facing rows), and the tagged Aseprite source contains
**320 total frames** across the sixteen sheets (20 frames per sheet).

The fixed feet point remains **(32, 56)** and the authoritative local and
Studio contact bodies remain **24x24**. Vertical rows must move the legs along
the depth/y axis with hip continuity; side rows must move them along the x
axis. Every cycle keeps at least one foot planted on the baseline and may not
introduce new white or bright edge contamination. Every frame must also reject
accidental transparent holes or narrow channels through the expected body,
pelvis, limbs, clothing, hair or weapon joins; one connected opaque component
is not sufficient evidence of anatomical continuity. Intentional negative
space must remain stable, anatomically readable and explicitly reviewed.
Source frames still contain no baked shadow. The sixteen-key mapping,
World-local resolver, wire shape, privacy boundary and financial semantics
remain unchanged.
The file topology also remains one sheet per opaque key with no mega-atlas;
the existing `v1-review/` provenance is not overwritten.

Inside Avatar Studio only, **F** is authorized as a one-press, no-repeat
toggle for the current editable target's cosy/fighting pair. It emits the
existing `avatar:selected` event with the paired opaque key; it adds no stance
field, wire field or privacy meaning. F must not toggle the state outdoors,
inside financial rooms or through any lobby behavior.

**Acceptance and consequences.** The replacement art requires background
review and fresh user-run in-game review. The failed browser recording remains
an explicit failed rendered-acceptance result, not a pass. The existing
192x256/3-column `v1/` handoff remains historical D-049 provenance until a
replacement package satisfies this D-052 contract; it must not be described as
D-052-compliant. All D-049 requirements not explicitly superseded here remain:
transparent 64x64 logical cells, fixed feet, 24x24 bodies, sixteen opaque
keys, no baked shadows, World-local integration and no new shared/lobby or
financial fields.

**2026-08-20 implementation status.** The first five-column handoff at
`0ccf5b9` was rejected during independent review because all 256 movement
cells confined their changed pixels below the hip (`y=45..53`). The corrective
art at `8e92cfa` passes the D-052 anatomy, edge, background, source-round-trip
and whole-body gait gates: movement reaches `y=8..27`, with at least 243
changed pixels and 60.8% of each cell's changed pixels above its hip gate.
Subsequent rendered review exposed a separate source-art identity defect:
character 5/13 changed style and construction in the side rows despite matching
height bounds. Art commit `0051fce` rebuilds only those twenty left/right cells,
preserves the approved down/up identities and direction-specific fighting
staff, and passes independent cross-facing, anatomy, edge and Aseprite-cel
reconstruction review. Hosted CI run 32374850224 passed all jobs.
World commit `5c8c81a` loads all 20 frames per sheet and plays columns
`0,1,2,3,4` at the approved 8/12 FPS cadences. Art and headless runtime
integration are therefore complete and independently reviewed; only the
user-run rendered in-game acceptance remains open.

**2026-08-20 approval-flow amendment.** James delegated intermediate sprite
direction and rejection to orchestration. Art may iterate through turnaround,
edge, pose, movement and export gates without pausing for user approval at
each contact sheet. Intermediate scaffolds and mechanical QA boards are not
user-review deliverables. The next user checkpoint is the completed,
independently reviewed correction after final assets and the five-column
runtime are integrated, with a short user-run in-game acceptance script. This
amendment removes repeated approval pauses; it does not waive D-052's final
rendered-acceptance requirement or authorize a mechanically conforming but
visually incoherent asset.

**2026-08-28 Avatar 1 cosy six-column amendment.** James explicitly approved
only the exact Avatar 1 cosy PNG with SHA-256
`f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb`.
For that opaque key only, the sheet is 384x256 and each facing row uses six
64x64 columns: `idle`, `contact-left`, `passing-left`, `contact-right`,
`passing-right`, `settle`. Its normal runtime cycle is all six columns at 8
FPS. Avatar 1 fighting and avatars 2-16 retain the existing five-column sheets
and were not approved or altered by this amendment. World must own geometry
per sheet so the opaque key and lobby wire shape remain unchanged. The common
feet point, gameplay body, binary alpha, no-shadow rule and nearest-neighbour
rendering remain unchanged.

The exact approved pixels use up to 29 visible RGB colours per frame: 21 of
24 cells exceed the prior 24-colour cap and the maximum is 29. Exact-binary
approval plus James's instruction to continue authorizes a scoped Avatar 1
cosy exception of 29. The default cap remains 24 for Avatar 2-16, including
Avatar 1's paired fighting key `avatar-9`; no palette remap or broader palette
relaxation is authorized.

The approved down-eye correction remains in the exact PNG. A later attempted
left/right eye-lock pass was rejected and fully reverted; its artifact and
ledger are quarantined outside the repository and must not be used. The
approved PNG's left and right rows are pixel-identical to their pre-eye-pass
versions and its up row is unchanged. The prior Aseprite source does not encode
this new sixth column, so it remains historical source for the five-column set
and must not overwrite the source-authoritative hashed Avatar 1 PNG. Fresh
live-browser rendered acceptance of this replacement remains required.

**2026-08-28 Avatar 1 cosy rendered-acceptance status.** James accepted this
exact Avatar 1 cosy replacement in the live game. This supersedes only the
historical pending status in the six-column amendment above; it does not alter
that amendment's reasoning or accept Avatar 1 fighting or avatars 2-16.

---

## D-053 — The F outfit toggle follows the local avatar throughout World play

**2026-08-20 · Accepted by the user · supersedes only D-052's Studio-only F
scope; D-052's art, animation and body contracts remain; rendered
functional/interactive gate accepted 2026-08-28 by [the verified D-053
finding](../AGENTS.md#2026-08-28--the-rendered-functional-and-interactive-d-053-matrix-is-complete-subjective-art-remains-open), while subjective final-art acceptance remains open**

**Context.** The implemented `F` binding currently exists only while Avatar
Studio is active. James reported that the outfit toggle therefore appears to
work nowhere else and asked for the missing global behavior to be added to the
World todo list.

**Decision.** `F` is a World-local cosmetic toggle for the current local
avatar's cosy/fighting pair wherever the local avatar is playable: outdoors,
inside Avatar Studio and inside the existing fixed-room interiors. One
Scene-lifecycle-owned binding must follow the avatar across those transitions;
individual buildings must not own separate bindings. The key remains
one-press/no-repeat, ignores editable DOM targets, and is inactive after Scene
shutdown or while World gameplay input is not active.

The toggle resolves only through the existing `pairedAvatarSprite` mapping and
emits the existing `avatar:selected` event with the paired opaque
`avatar-1..avatar-16` key. It adds no stance/outfit field, lobby message,
building field or financial meaning. Existing lobby suspension/resume behavior
continues to publish only the selected opaque sprite key when presence resumes;
no financial-room identity or action is disclosed.

**Status and acceptance.** Headlessly implemented and verified on branch
`codex/global-outfit-toggle` (PR #19). `packages/world/src/avatar-outfit.ts`
splits the two jobs D-052 had conflated: `createAvatarOutfitSelection` owns the
selected key as one Scene-wide source of truth, injected into the Avatar Studio
controller as a required option, and `createAvatarOutfitToggleBinding` owns one
`keydown-F` listener for the Scene's lifetime, gated per press on
`InputGate.suspended`. `AvatarStudioController.toggleSelectedState()` is
removed; no building owns a binding.

TDD covers outdoor, Studio and every `FIXED_ROOM_DEFINITIONS` interior;
repeat/editable/suspended/destroy guards; single ownership across room
transitions and same-Scene restarts driven through the real `create()` order;
and an assertion that the only outbound addition is the existing
`avatar:selected` with a `sprite`-only payload. Verified by 22 World files /
218 tests, the full workspace, workspace typecheck, production build,
invariants, drift and tilemap checks.

**Rendered functional and interactive acceptance completed on 2026-08-28; the
previous open status is superseded by [the verified D-053
finding](../AGENTS.md#2026-08-28--the-rendered-functional-and-interactive-d-053-matrix-is-complete-subjective-art-remains-open).** The implementation checks
above remain headless. A later D-057 mock-only Chrome run on canonical main
`6b9d3e0` verified `F` outdoors, in Avatar Studio both ordinarily and while
visibly overlapping its central figure, inside each fixed room, and silent
while a station panel held the keyboard. No live wallet, proof, signature,
submission, transaction or funds were used. Subjective final-art acceptance is
a separate gate and remains open.

---

## D-054 — Production wallet lifecycle belongs to a privacy-owned session

**2026-08-23 · Accepted · autonomous tester prompting superseded by D-057**

**Context.** `WalletApiPrivacyOperations`, dynamic Wallet Standard discovery
and the Backend privacy client already exist, while the browser composition
still mounts `App` without real operations. Putting connection logic directly
in Web would make the Shell own wallet APIs and account generations; creating a
CLI wallet would instead move keys, registration, notes and proving into a
STRKWORLD-controlled trust boundary. Both contradict the established package
boundary and D-002.

**Decision.** `packages/privacy` owns one `WalletSession` facade around dynamic
Wallet Standard discovery, explicit wallet selection, `WalletAccountV6`,
account/network/disconnect generations and a stable `PrivacyOperations`
delegate. Web may subscribe to the session's sanitized snapshot and render its
wallet choices, but it never imports a wallet library, sees keys or notes, or
branches financial behavior on wallet identity. A selected wallet is always a
user choice; the first discovered wallet is never silently connected.

Every account or network generation owns the operations created for it. Work
prepared by an older generation is discarded before it can be handed back for
confirmation, and an old prepared batch cannot begin signing after an account
change or disconnect. Accepted receipts remain evidence and are not erased by
session replacement. The same concrete mainnet account authority is supplied
reactively to the Bridge composition and through its stable account reader, as
D-043 requires.

Phase 1 uses a deliberately deny-all route policy: zero intents, zero relay-fee
ceiling, no enabled routes and empty token allowlists. This permits real wallet
discovery, connection and Wallet API capability checks without authorizing any
financial preparation. Bridge planning remains null. A later transfer-only
policy requires a live fee read and a separately approved global relay-fee
ceiling; swap remains disabled until its executor authority is resolved.

**Consequences.** The first live acceptance uses the user's Ready wallet in the
browser on `SN_MAIN`; STRKWORLD does not create, fund or custody a CLI wallet.
Headless tests own discovery, selection, stale-event, account/network and
prepared-work behavior. The user owns rendered wallet-prompt acceptance. Any
funded mainnet action remains a separate explicit gate naming the exact account,
recipient, token, amount and live fee ceiling immediately before handoff.

**Status.** Headless Phase 1 implementation is complete on
`codex/wallet-integration`. The real-wallet path is production-default and an
explicit local-development opt-in; every transaction route remains denied by
default. The accepted funded-tester shield exception is defined by
[D-056](#d-056--the-funded-tester-may-enable-the-pool-native-strk-shield-route),
which supersedes this status only for its explicit three-variable
canonical-STRK tuple. Rendered Ready discovery, connection, rejection,
network/account change and capability behavior remain the next manual gate; no
live wallet or funded claim is accepted by this status.

---

## D-055 — A supported connected wallet is the app entry gate

**2026-08-23 · Accepted by the user · SUPERSEDED in part by D-072 (a supported wallet now reaches the funds gate, not the city) · supersedes D-037's wallet-independent
lobby availability and qualifies D-043's production no-wallet recovery claim
for the production app entry path**

**Context.** D-054 gave the Shell a privacy-owned production wallet session,
but `ProductionRoot` still mounted the complete `App` before that session had
an account. The World therefore booted Phaser, and its first street movement
could create a lobby client, while the wallet picker appeared only inside a
building or panel. That made wallet connection an in-game capability prompt
instead of the access gate the product requires.

**Decision.** In the production composition, a connected wallet on the
expected Starknet mainnet must also pass the existing STRK20 capability
check before it is admitted as a supported wallet and before STRKWORLD opens.
Before the session reports `phase: 'connected'` with a valid account and the
capability flow reports support, the root renders only wallet discovery,
explicit wallet selection and connection/recovery UI.
The World/Phaser tree, lobby/presence controller and building panels are not
mounted and no lobby connection can start. A player must explicitly choose a
discovered wallet; discovery order never authorizes a connection.

When the session loses its account, disconnects, disappears, or reports the
wrong network, the connected app is unmounted and its current World and lobby
owners are torn down. A later valid connection creates a fresh presence owner
and mounts a fresh app. The existing demo and injected test compositions may
still mount without a wallet because they are explicit non-production seams;
this decision changes only the production root. D-043's BridgeStore retention
and offline/test inspection semantics remain valid, but its no-wallet UI-
recovery language is not a production promise while this gate is in force.

**Consequences.** The initial browser surface is a wallet gate rather than a
walkable solo city. The lobby remains independently privacy-minimal once the
player has entered the connected app, but it is no longer available before
wallet admission. Account/network generations continue to be owned by
`packages/privacy`; Web consumes only its sanitized snapshot. No wallet key,
note, proof, signature, balance, RPC result or transaction is introduced into
the gate. Rendered wallet-prompt acceptance and funded mainnet actions remain
separate explicit gates under D-028 and D-054.

**Status.** Implemented in `apps/web/src/production/ProductionRoot.tsx` with
public root/snapshot and client lifecycle regressions. Unsupported capability,
unreachable and rejected capability results remain at the entry gate; only a
supported result admits the connected tree. No browser wallet, RPC, proof,
signature, funds or transaction was used by this implementation.

---

## D-056 — The funded tester may enable the pool-native STRK shield route

**2026-08-24 · Accepted · autonomous tester handoff superseded by D-057 · unshield exclusion superseded by D-062 · STRK-only shield token SUPERSEDED by D-072 (one to sixteen tokens)**

**Context.** The disposable Ready mainnet account is now deployed, registered
with the STRK20 pool and able to share its private balance with STRKWORLD. Its
public balance is funded while its private balance is zero. The accepted Bank
implementation already submits a shield directly through
`wallet_strk20InvokeTransaction`; it does not generate a proof in STRKWORLD,
use the private-submission backend, or move viewing keys or note ownership out
of Ready. Production composition nevertheless has no explicit shield-policy
input, so the game cannot ask Ready to open that already-built route.

**Decision.** Production wallet policy may expose an explicit, fail-closed
pool-native shield configuration. It is disabled by default and admits only
the configured STRK token, a positive bounded intent count and the existing
live pool-fee ceiling check. Enabling shield does not enable transfer,
unshield or swap, does not create a relay-fee authority, and does not alter the
Backend. Malformed, partial or empty shield configuration resolves to deny-all
rather than a partially open route.

The current local tester checkout may enable this route for one small funded
mainnet shield so the prompt originates in STRKWORLD. Ready remains the only
owner of account execution and the final wallet confirmation remains a human
handoff. This acceptance does not make the route generally deployed or prove
rendered/funded behavior before the live receipt and refreshed private balance
are observed.

**Consequences.** The public seam is production environment parsing plus the
existing Bank route projection. Tests must pin disabled/malformed deny-all,
STRK-only enablement, immutable policy ownership and the absence of every
other route. After merge, the canonical local checkout is restarted and the
funded tester performs the final Ready confirmation; the resulting receipt and
deliberate balance refresh are the live acceptance evidence.

---

## D-057 — Autonomous testing uses a separate capped tester wallet

**2026-08-28 · Accepted by the user · supersedes D-054 and D-056 only for
agent-owned local testing; production player custody remains unchanged**

**Context.** Ready correctly asks the player to approve private-balance access,
proof generation and transaction submission. STRK20 pool calls cannot use the
ordinary account session-key path, so repeated end-to-end testing through Ready
turns the user into a manual test runner. James explicitly requires the project
lead to run repeated tests without asking him to approve every wallet action.

Moving a tester private key, viewing key, notes or prover into STRKWORLD would
break D-002. Faking the wallet only exercises UI state and cannot establish a
funded mainnet result. The testing route therefore needs its own deliberately
custodial boundary while the production app continues to use Wallet Standard.

**Decision.** Build a separate sibling workspace named
`strkworld-tester-wallet`. It owns exactly one disposable tester account and
may use the low-level STRK20 Privacy SDK for that account only. It must never be
imported by STRKWORLD, bundled by `apps/web`, deployed as a player service or
receive a player's key. Signing and viewing secrets live in macOS Keychain,
never source, environment files, chat, logs or journals.

The sibling exposes a localhost-only Wallet Standard test provider so the
current local game can exercise its real wallet seam. Admission is fail-closed:
mainnet and canonical pool/STRK addresses only; a hard kill switch; shield-only
initially; one invocation per run; exact amount and fee ceilings; dry-run by
default; no arbitrary calldata, recipient or route; and no automatic retry
after an uncertain submission. An append-only journal stores request IDs,
policy decisions and redacted receipt digests, not raw secrets, notes, proofs,
viewing keys or private transaction material.

Mock mode may run unlimited UI/state-machine regression loops without funds.
Live mode is a separate command requiring the kill switch, the explicit
mainnet acknowledgement flag and a configured disposable account. Registration
and shielding are live chain operations; discovery and proving are external
services; shielding also requires protocol screening. Every unavailable or
unverified dependency fails closed. Funding the disposable address does not
expand the allowlist or caps.

**Consequences.** The project lead can repeat mock wallet-seam and rendered UI
loops without Ready prompts. Capped, shield-only funded smoke becomes possible
only after the disposable account, RPC, discovery, proving and screening paths
are explicitly configured and verified. The harness assumes custody and exposes
its own requests to those services; it is not a privacy guarantee for players
and never bypasses protocol screening. Production STRKWORLD remains zero-custody
and runs no privacy infrastructure. The sibling workspace has an independent
threat model, tests, journal and kill procedure; its existence is not production
readiness or permission to raise a cap.

**2026-08-28 Phase 1 status.** The sibling now serves a mock-only loopback
gateway at `127.0.0.1:5173` in front of the canonical Vite server on
`127.0.0.1:5175`. It injects a deterministic Wallet Standard provider before
Vite's module entry without entering STRKWORLD source or bundles. The gateway
constructs its mock adapter and policy internally, refuses live environment
configuration, uses exact loopback/Host/Origin/fetch-metadata gates and a
per-process HttpOnly SameSite cookie, and has no key, RPC, prover, proof,
signature, submission or funds path.

Rendered Chrome acceptance passed through the production public seams: the
tester was discovered, Wallet API 0.10.3 on SN_MAIN admitted the world,
multiplayer connected, the Bank opened through a deterministic mock pool read,
one deliberate balance read returned zero, and a one-wei canonical STRK shield
returned the fixed mock receipt without a popup, dialog or new tab. Leaving the
Bank restored multiplayer. This is autonomous mock acceptance only; Ready or
Xverse and every funded/onchain claim remain separate production gates.

---

## D-058 — Manual wallet handoffs use one visible in-game attention cue

**2026-08-29 · Accepted by the user**

**Context.** Mock mode can exercise the complete production wallet seam without
interrupting the user, but a real wallet still owns connection, private-balance
sharing and transaction approval. Those handoffs can appear outside the game
window or take long enough that the existing inline pending sentence is easy to
miss. The user asked for the approved mini character to ping them only when they
actually need to do something.

**Decision.** Web renders one fixed wallet-attention cue only while an explicit
manual handoff owns the current UI state: the production session is connecting,
a requested private-balance read is loading, or a submitted operation reports
the wallet-owned `awaiting-approval` stage. Capability detection, preparation,
proof generation, submission and network confirmation do not show the cue.

The cue uses World's approved Avatar 1 idle frame through a narrow public visual
projection. This is a deliberate World-to-Web presentation seam: it carries
only the cosmetic asset URL and frame geometry, never movement authority,
wallet state, financial data or lobby data. Web owns the cue state, copy and
accessibility. While active it is a prominent visual alert, marks the browser
tab and emits one best-effort local chime/vibration without asking for browser
notification permission. Re-renders of the same handoff do not repeat the
signal, and the original tab title is restored when the handoff ends.

**Consequences.** This makes human handoffs conspicuous without inventing a
prompt count or claiming unattended real-wallet signing. The cue contains no
account, balance, amount, route, transaction hash or wallet identity. Mock mode
continues to complete without the cue lingering because it never waits on a
human-owned prompt. Browser rendering and audibility remain local acceptance
checks after the headless state and lifecycle regressions pass.

---

## D-059 — The World renders in 3D with Three.js

**2026-09-27 · Accepted by the user · supersedes D-044's placeholder art base ·
partially supersedes D-049 and D-052 for in-World avatars · amends the Phaser
mechanism named in D-008, D-030 and D-039**

**Context.** The user asked for STRKWORLD to become a 3D-rendered, simple game
world you can walk around in, entirely in the browser, built on the same
technology as a reference browser game made with Claude in one day. The
reference site could not be inspected from the development machine, so the
stack is the conventional one for that kind of build: vanilla Three.js on Vite
and TypeScript. Offered a flag-gated rollout or a direct replacement, the user
chose the quickest path to ship ("remove whatever you need or replace whatever
you want"), low-poly 3D figures for avatars, and procedural geometry for the
first art pass.

**Decision.**

- `packages/world` renders with Three.js 0.186 instead of Phaser 4. The engine
  loads behind the same lazy `./runtime` seam — `acquireWorld` /
  `releaseWorld`, the ref-counted host, retarget on a new Shell binding — and
  keeps one WebGL context per mount. `acquireWorld` now resolves to `void`;
  nothing in the Shell used the Phaser `Game` it returned.
- Gameplay stays tile-authored in 2D pixel space and is now engine-agnostic.
  `world-session.ts` carries StreetScene's orchestration, create/teardown
  order and rollback rules over unchanged and drives a narrow
  `WorldSessionView`. The street uses the same substep tile collision the
  interiors already used (`moveWithCollisionSubsteps` with `isSolidAt` and the
  same 24 px body), replacing Arcade physics. One tile is one world unit; +X is
  east and +Z is south.
- No seam changes shape. `packages/shared`, the lobby protocol and the Shell
  are untouched. `Facing` stays four cardinal values on the wire; the avatar's
  continuous yaw is presentation only.
- Camera: third-person follow, north-up by default so the district reads as it
  did in 2D; drag to orbit, wheel to zoom. Movement keys are camera-relative,
  and the reported facing is the cardinal nearest the intended World-space
  direction, with exact diagonals resolving vertically as before. The camera
  never turns on its own, so a key held through a room or Studio handoff cannot
  walk the player straight back out.
- Art: procedural low-poly geometry and no new third-party assets. Avatars are
  procedural blocky figures, one look per existing opaque avatar key, coloured
  from the approved D-049 sheets, so the lobby's cosmetic allowlist is
  unchanged. Buildings that stand between the camera and the player fade.
- Input: a DOM keyboard replaces Phaser's KeyboardPlugin behind the same
  `KeyboardLike` input-gate contract, and also clears held keys on window blur
  and when the tab is hidden.
- Other players are interpolated between lobby snapshots and face their
  direction of travel. They remain presentation-only (D-038).

**Consequences.**

- The Phaser dependency, StreetScene, the Kenney atlas slicer and the
  sprite-sheet renderers are removed. The approved 2D sheets stay: they are
  the colour reference for the 3D looks and the source of D-058's
  wallet-attention cue.
- Still WebGL on one canvas under `.world-host`; no COOP/COEP, no
  SharedArrayBuffer and no WASM, so D-005 is unaffected.
- Frame stages are isolated. A failing session update, animation or camera
  step is reported (rate-limited) and the frame still renders; the session's
  rollback rules retry the handoff on the next frame.
- A perspective camera sees further than the lobby's 640 px interest radius, so
  a distant peer can appear at the edge of the fog.
- Visual acceptance stays with the user at localhost:5173, as for every
  rendered change. Headless tests cover the session (the StreetScene lifecycle
  suite, ported), the keyboard, the camera math and scene construction.
- A later Art decision may swap procedural geometry for a CC0 model pack; it
  must record provenance the way D-044 did.

---

## D-060 — A shared block sandbox where the road ends

**2026-09-27 · Accepted by the user · extends D-011 (shared seam: sandbox
constants and types, `PresenceState.carrying`) and D-038 (remote peers carry a
block colour) · adds anonymous lobby state under invariant 2 · amended by D-071
(a pillar taller than 15 bursts the sandbox, announced by a second sandbox
broadcast)**

**Context.** The user asked for a simple sandbox area at the end of the road:
blocks drop from the sky at random; `E` picks one up and `E` puts it down;
blocks stack, with no practical ceiling but a solid floor; walking into a block
steps you up onto it — one block at a time, never a climb of several; and the
area is a large square you can reshape and draw in by placing blocks. They
then asked for it to be multiplayer too.

**Decision.**

- The street map widens east: the road runs on into a 28×28 sandbox square
  (`SANDBOX_AREA`, street tiles x 54–81, y 0–27). Its floor is a new walkable
  tile kind; block stacks are shared state layered on top of it.
- *Amended 2026-09-27, at the user's request for a better road-to-square
  transition:* the square is walled on its street side — a two-block toy-block
  wall one tile west of it, a new solid tile kind (`fence`) — and entered
  through one gate where the road and both pavements run in. The gate's lintel
  clears the tallest avatar holding a block. Sky drops and returned blocks
  never land on the three tiles just inside the gate (`SANDBOX_ENTRANCE`,
  x 54–56, y 11–18), so the rain cannot wall off the way in. Players may still
  lay blocks there, but a stack in the entrance never grows past one step
  (`SANDBOX_STEP_HEIGHT`), so nobody can wall it off either: a three-high wall
  would otherwise be out of reach from the gate and lock everyone outside.
- The lobby is the authority. The room stores the stacks (colour indices from
  the ground up, per tile) and each player's carried colour. It spawns sky
  drops on a server timer while players are present, never within a tile of a
  player or in the entrance, and validates every pick and place: the target must be inside the
  area, next to the requester, not under another player, within reach (block
  tops from one below to two above the level the player stands on) and within
  the height and block caps. A rejected request changes nothing. Blocks are
  conserved: when a carrier disconnects or suspends presence, the block they
  held returns to the board as a sky drop on a random open tile — never at the
  carrier's position, which would reveal where they went.
- Solo play runs the same pure rules locally in the Shell, so the sandbox works
  without a lobby.
- The lobby schema gains exactly one presence field, `carrying` (an opaque
  colour index, or −1), plus anonymous block state. Neither is financial:
  invariant 2 holds — no address, balance, transaction, token or building name
  enters lobby traffic, and block state carries no identity field. It is not
  unlinkable, though: an observer inside the presence interest radius can
  correlate a peer's `carrying` change with a neighbouring column change in the
  same patch, and anyone learns that someone was within reach of a changed
  tile.
- The World stays lobby-free. It receives a World-owned `SandboxChannel`
  through `WorldConfig`, like D-038's peer source, reads stack heights for
  movement and emits pick/place intents. Walking keeps the tile collision and
  adds one rule: a stack more than one block above the level you stand on is a
  wall; one block is a step up with a small hop; stepping down is free. `E`
  targets the tile you face. Other players stand on the same shared stacks and
  show the block they carry.
- The shared seam grows additively — constants `SANDBOX_*`, types
  `SandboxTile`, `SandboxColumn`, `SandboxSnapshot`, and
  `PresenceState.carrying` — recorded here as D-011 requires.

**Consequences.**

- Blocks are visible to everyone in the room regardless of the 640 px presence
  interest radius; the state is small (at most 900 blocks).
- Every client draws a player standing on blocks at stack height from shared
  state, so heights never go on the wire.
- No persistence: block state lives as long as the lobby room.
- Sandbox messages have their own rate limit; the existing hard message
  ceiling still disconnects floods.
- Reach and step checks bind honest clients; a hostile client can claim any
  in-bounds position (presence already trusts positions within its clamps), so
  on the server they are advisory. Block conservation bounds the damage: a
  hostile player can rearrange blocks but not destroy them.
- The board is player-written content visible to the whole room. Colluding
  clients could encode data in it, as they already could in positions; nothing
  here makes that financial.
- Late joiners receive the whole board in one state encode, so the lobby
  raises Colyseus's encode buffer above the worst-case board (see the lobby
  findings).

---

## D-061 — The production Bridge plans its shield with a conservative STRK reserve

**2026-09-27 · Accepted by the user · supersedes D-043 in part (its production planner lock) · open only while D-056's shield route is enabled**

**Context.** D-043 locked new production Bridge quotes, deposit instructions
and the Bridge-to-Bank handoff until a fee-aware shield route was proven:
Ready's visible shield route approves only the deposit amount, while the
pool's `apply_actions` separately pulls `get_fee_amount()` from the caller
(the 2026-08-18 finding). In the 2026-09-27 feature review the user decided
the Bridge should open with a conservative reserve rather than wait: size it
from the live fee and overcompensate, to 10 STRK. The live fee read that day
was 6 STRK (`get_fee_amount()` = 6e18 at mainnet block 15,523,237).

**Decision.**

- Production composition injects a reserve-based `PublicShieldPlanner`
  whenever, and only when, the production shield route is enabled (D-056).
  With shield disabled the Bridge stays recovery-only, exactly as before.
- `plannedReserve = max(10 STRK, liveFee + gasAllowance)`. `liveFee` is the
  pool's `get_fee_amount()`, read live through the existing pool-configuration
  path at planning time; `gasAllowance` is a fixed, positive, conservative
  public-gas allowance of 4 STRK — above the one measured STRK20 private
  transaction's 3.6133 STRK of gas, and exactly 10 STRK minus today's fee, so
  today's reserve is the approved 10 STRK and a fee rise never squeezes gas. The planner fails closed — no plan, handoff
  locked — when the read fails, the denomination is not the Bridge's STRK or
  `amountToShield` would not be positive.
- `amountToShield = available − plannedReserve`. D-043's arithmetic,
  denomination and positivity rules are unchanged, as are its two phases:
  preflight against the signed minimum output before deposit instructions,
  then a fresh maximum-shield plan from the actual `strkReceived` after
  `SUCCESS`, revalidated at the Bank commit point, where the Bank's own fee
  ceiling and confirmation remain authoritative.
- The unspent reserve stays as public STRK in the player's wallet, and the
  copy says so.

**Consequences.**

- "Bring funds in, then shield" becomes playable in production wherever the
  shield route is.
- The fee-allowance question is not resolved by this: if Ready does not
  supply the allowance for the pool fee, the separate shield reverts and the
  bridged STRK stays public in the player's wallet — the state a manual Bridge
  deposit already ends in, never a loss. D-056's funded shield is the evidence
  either way.
- A governance fee rise is absorbed automatically: the live fee always wins
  over the 10 STRK floor.

---

## D-062 — The funded tester may enable the pool-native STRK unshield route

**2026-09-27 · Accepted by the user · supersedes D-056 in part (its unshield exclusion)**

**Context.** Unshield is built, register-approved (`public-edge`, with its
D-024 disclosure) and the pool's only in-game exit, but D-056 admitted shield
alone and production policy hard-coded unshield to deny, so the Bank offered a
route that could only fail at prepare. The user asked for it to be switched
on. Like transfer, unshield is submitted through the private-submission
backend, whose own route allowlist and relay-fee ceiling
(`BACKEND_ROUTE_UNSHIELD_*`) already exist.

**Decision.** Production wallet policy may expose an explicit, fail-closed
unshield configuration mirroring the transfer route's shape: disabled by
default; admits only the configured STRK token, a positive bounded intent
count and a positive relay-fee ceiling, alongside the live pool-fee ceiling
check; malformed, partial or empty configuration resolves to deny-all. Where
several relayed routes are enabled, the policy keeps the strictest relay-fee
ceiling and intent bound. Enabling unshield enables nothing else. Ready remains
the only owner of execution, and the final confirmation remains a human
handoff.

**Consequences.** Tests pin disabled and malformed deny-all, STRK-only
enablement, strictest-bound merging and the absence of every other route. The
acceptance evidence is one small funded mainnet unshield by the tester, with
its receipt and a deliberate balance refresh; until then the route is enabled
only in the tester's checkout.

---

## D-063 — Endur private staking is a Bank counter, built switched off

**2026-09-27 · Accepted by the user · extends D-036's frozen seam with a `stake` intent · a D-018 anonymizer path · respects D-030's one-grade-per-station rule**

**Context.** The feature review of strk20.starknet.io found Endur liquid
staking live on mainnet through an STRK20 anonymizer, the strongest new
integration. `EndurDepositAnonymizer` at
`0x030dee638065962eb3642ca54aa48e9e2cd98536bc90b64b99bb306c1db30698` has one
entry point, `privacy_invoke(in_token, out_token, assets: u256, note_id) ->
Span<OpenNoteDeposit>` (read from the deployed class ABI); Endur's xSTRK at
`0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a` is an
ERC-4626 vault. There is no private unstake: Endur's withdrawal queue takes
1–14 days and no withdraw anonymizer exists. Ready 5.33.8's client accepts any
invoke target, but its paymaster may reject one that is not pre-approved. The
user chose a counter in the Bank, in Endur's look, built now and switched off.

**Decision.**

- `PrivacyOperations` gains a `stake` intent — STRK in, xSTRK out, one
  amount — prepared like `swap`, in AVNU's mainnet-proven order: withdraw the
  staked STRK to the anonymizer, withdraw the relay fee, open the xSTRK note,
  then invoke the anonymizer (calldata `[in, out, amount low, amount high,
  note_id]`). There is no minimum-out field: `privacy_invoke` enforces none,
  and D-041/D-042 forbid showing a floor nothing enforces. No other seam
  method changes.
- Like swap, it is relayed by the private-submission backend through AVNU's
  sponsored-private paymaster. A fail-closed `BACKEND_ROUTE_STAKE_*` group,
  disabled when absent, admits exactly one call to the pinned anonymizer plus
  exactly two withdrawals: the authorized fee and the staked STRK.
- The privacy register grades it `anonymous`, like swap: who staked is hidden;
  the amount staked and the xSTRK received are public. (Its player-facing
  disclosure is waived by D-064.)
- The Bank gets a separate staking station and menu section, so no station
  mixes grades (D-030). It wears Endur's palette, as the Bank's other counters
  wear STRK20's.
- It is switched off: production policy and the backend both deny `stake`
  unless their own fail-closed configuration enables it.

**Consequences.**

- Before switching it on: AVNU's sponsored-private paymaster, which relays it
  behind the backend, must accept the anonymizer as an invoke target (ask the
  STRK20 team or AVNU; Ready's client already accepts any target), and one
  small funded stake must succeed.
- The counter is stake-only. A later decision covers exit: an Endur withdraw
  anonymizer, or adding xSTRK to the Exchange (whose six-asset catalog is fixed
  by D-042).
- The position view reads the shielded xSTRK balance only on the player's
  explicit request, like every balance, plus a public xSTRK-to-STRK rate.

---

## D-064 — The lead waives the in-game disclosure for Endur staking

**2026-09-27 · Accepted by the user · a narrow exception to D-020/D-024's disclosure rule, for `bank.stake` only**

**Context.** D-063's staking counter is graded `anonymous`: who staked is
hidden, while the STRK staked and the xSTRK received are public, as with the
private swap. The register requires every deviation to show the player a
disclosure before commit. Offered a one-line disclosure, the user declined any
disclosure for staking.

**Decision.**

- The register gains an explicit waiver, `disclosureWaivedBy`, naming the
  decision that waives a route's player-facing disclosure. It replaces only the
  `disclosure` string: approval, date and rationale are still required, and
  the grade and `observable` still record exactly what an observer sees.
- `bank.stake` carries `disclosureWaivedBy: 'D-064'`, approved by the lead.
  The commit gate does not demand a disclosure for it; every other deviation
  keeps its disclosure.
- A waiver counts at runtime only when the frozen `DISCLOSURE_WAIVERS` table
  lists that exact route with that exact decision, so no route can borrow a
  decision that merely mentions it. Check 8 strips comments, requires every
  register entry to parse, and accepts a waiver only when the cited decision
  is Accepted, unsuperseded, and itself records the route's
  `disclosureWaivedBy` value.
- In exchange, the counter's own copy claims no amount privacy. It may say
  staking is from the pool balance and that the xSTRK lands in the pool; it
  must not say amounts are hidden. The note that unstaking takes 1–14 days
  through Endur and is not available in the game stays: it is how the product
  works, not a privacy disclosure.

**Consequences.** The Exchange keeps its swap disclosure, so the two
`anonymous` routes now differ in what they show. Any further waiver needs its
own decision; there is no blanket switch.

---

## D-065 — A first transfer reveals its recipient; no note, one recipient per send

**2026-09-27 · Accepted by the user · regrades `post-office.transfer` from `private` to `anonymous` · a D-064-style disclosure waiver**

**Context.** The 2026-09-27 privacy audit verified on mainnet that a first
transfer to a new recipient opens a channel keyed by the recipient's address:
`Append(recipient)` sits in plaintext calldata and `get_num_of_channels`
for that address goes from 0 to 1 in the same block (tx `0x33d01b…495`, block
15,524,071; re-checked independently). The sender and the amount stay hidden,
the relay fee leaves the pool publicly to AVNU's forwarder, and the proof's
reference block dates the confirm. The register graded the route `private`
with "all hidden", which overclaimed. Batching several transfers publishes
every new recipient in one transaction, as paid by one sender. Offered a
one-line note, the user declined it, and chose one recipient per send.

**Decision.**

- `post-office.transfer` is regraded `anonymous`, the conservative grade that
  does not overclaim, and `observable` records exactly what is visible.
- Its in-game disclosure is waived: `post-office.transfer` carries `disclosureWaivedBy: 'D-065'`,
  listed in `DISCLOSURE_WAIVERS` and approved by the lead. Copy may keep "send
  privately" but must not claim the recipient is hidden.
- One recipient per send: a batch holds at most one transfer. The Shell's
  batch accumulator refuses a second, and the relay rejects any submission
  that pays more than one recipient.

**Consequences.** Menu Mode's transfer tab at the Bank follows the same rule.
A shield and a transfer may still share a visit. The recipient reveal cannot
be avoided through the Wallet API, which has no separate way to open a
channel in advance.

---

## D-066 — The relay submits without an artificial delay

**2026-09-27 · Accepted by the user · supersedes D-004 in part (its randomised relay delay)**

**Context.** D-004 put a randomised delay between game action and broadcast
to break timing correlation. The 2026-09-27 privacy audit found it cannot:
the wallet builds the proof before the relay sees anything, and every pool
transaction publishes its proof's reference block in plaintext
(`proof_facts[4]`), which dates the confirm whenever it is broadcast. The
delay instead pushed the game's transactions past the pool's normal 14–33
block proof-to-inclusion gap (p90 22), so they stood out, and a delay longer
than the request deadline failed submissions after the player had approved.

**Decision.** Relayed routes (transfer, unshield, stake) submit as soon as
they are validated. The backend accepts a zero queue delay for them, and the
example configuration sets zero. A nonzero delay remains possible but must
leave the request deadline 5 s of headroom. The submission queue's
concurrency and backpressure limits stay.

**Consequences.** Sends feel faster. Timing privacy is unchanged in
substance: the proof's block always dated the confirm. D-019's accepted
presence leak, the avatar vanishing into a building, remains the main
in-game timing signal.

---

## D-067 — The degen floor swaps a curated core plus avnu's live community list

**2026-09-28 · Accepted by the user · extends D-042 (the ground floor's six-asset catalog is unchanged) · keeps D-018's server-side allowlisting**

**Context.** The Exchange's new degen floor was asked to list "the degen mode
listed tokens on Starknet that avnu has", and the user chose a combination of
a curated list and avnu's live list. avnu's degen mode is a client toggle; its
public token API tags tokens `Unknown`, `Verified`, `Community`, `Unruggable`
and `AVNU`. Routed liquidity is thin (about $50–60 a day for LORDS and
DREAMS, under $10 for most others), and ticker-squatting impostors exist
(three fake LORDS). The pool itself accepts any ERC-20, so our allowlist is
the only gate.

**Decision.**

- The degen counter (`exchange:degen`) swaps privately through the same
  `exchange.swap` route, grade and disclosure as the ground floor, over a
  separate degen catalog.
- The degen catalog is a curated core (LORDS, DREAMS, SLAY, BROTHER, tBTC,
  CASH, DOG), each pinned to a reviewed address and always listed, plus
  avnu's live list. The backend fetches the live list itself, so avnu never
  sees a player's IP. It keeps only `Verified`, `Community`, `Unruggable` or
  `AVNU` tags above a minimum routed daily volume, and never a token whose
  ticker impersonates a curated one. Addresses come only from avnu's API or
  the curated core, never from player input or a URL.
- The backend admits a degen swap only for tokens in the curated core or in
  its own current filtered list. The counter is labelled "Degen mode" and
  shows each token's avnu tag. D-041/D-042's protected-minimum review applies
  unchanged: thin liquidity means worse quotes, never an unprotected fill.

**Consequences.** Demo mode shows the counter working against the fake.
Production keeps swap denied until swap itself is switched on; that decision
must also switch the degen catalog on or off. The volume floor and tag set are
operator configuration.

---

## D-068 — The private relay runs gasless, with no paymaster key by default

**2026-09-28 · Accepted by the user · narrows D-014's "holds the paymaster key" to "holds it if one is used" · keyless default SUPERSEDED by D-070**

**Context.** The backend refused to start without `AVNU_PAYMASTER_API_KEY`.
AVNU's docs distinguish gasfree (the dapp sponsors gas, with an API key) from
gasless (the user pays gas in a supported token, with no key). The user wants
gasless. The private relay already uses AVNU's `sponsored_private` fee mode
with `poolFeeToken`: the paymaster fronts the gas and is repaid by a pool fee
withdrawn from the player's shielded balance inside the private transaction,
so the player, not STRKWORLD, pays. The SDK marks the key optional.

**Decision.** `AVNU_PAYMASTER_API_KEY` is optional. Unset or empty, the backend
starts and relays without a key; a placeholder is still refused. When a key is
set it is passed to the paymaster and, per D-014, never leaves the server. The
fee ceilings, sponsorship budget, queue and no-logging rules are unchanged.

**Consequences.** A test deployment needs only `FEE_AUTHORIZATION_SECRET` as a
secret. If AVNU's relay turns out to require a key for this fee mode, relayed
routes fail at the fee build and the fix is to set one: nothing else changes.

---

## D-069 — Opt-in debug logs for test deployments

**2026-09-28 · Accepted by the user · narrows D-014's "logs nothing per-request" for opted-in test deployments only**

**Context.** The lead tests the live Railway deployment on a separate laptop
with a funded wallet, and what fails there has to reach the developer without
copying and pasting. D-014 makes the backend log nothing per request, and the
one-container composition (D-045) discarded every child's stdout, so a failure
in that browser left no trace the developer could read.

**Decision.**

- Two flags, both off by default and never set for a launch:
  `BACKEND_DEBUG_LOGS_ENABLED=true` opens `POST /api/v1/debug/logs`, and
  `VITE_DEBUG_LOGS=true` compiles the browser logger into the bundle. Unset,
  the route answers exactly like an unknown path and the bundle carries no
  logger; any value other than `true` or `false` stops the relay starting.
- A debug build sends nothing until the page is opened with `?debug=1`, which
  lasts for that tab's session; `?debug=0` or the badge's button ends it, and a
  badge shows while it is on.
- The browser sends window errors and unhandled rejections, `console.error`
  and `console.warn`, privacy and wallet failures (kind, wallet error code,
  message), connect-flow states, wallet-session phases including the connected
  account, building, station and panel events, and failed `/api` calls (path,
  status and body code only). It never sends signatures, calldata or proof
  data, and long hex and base64 runs are redacted. The session id is random
  per browser session, never the lobby id and never derived from the wallet.
- The relay validates each batch strictly (at most 50 entries and 32 KB, a
  fixed schema), writes one `[debug]` line per entry with control characters
  stripped, rate-limits to 600 entries a minute, and never reads the request's
  IP, headers or timing. With the flag on, the composition pipes the backend's
  stdout and forwards only lines that start with `[debug] `; the lobby's
  output is never read.

**Consequences.** With both flags on, one tester's own session reaches the
platform log stream, including their account address and any amounts or
addresses that wallet errors mention, beside Railway's own HTTP log. That is
acceptable only because the deployment is private and the tester is the
owner. While the route is open, anyone who can reach it can write lines within
the rate limit. D-005 and D-020/D-024 are unchanged. A launch leaves both
flags unset.

---

## D-070 — The private relay needs an avnu Portal key

**2026-09-28 · Accepted by the user (D-068's contingency) · supersedes D-068 in part (its keyless default) · extends D-036's frozen seam with a `relay-not-configured` failure kind**

**Context.** On the live test site an unshield failed at its first step:
`POST /api/v1/private/fees` answered 502 `UPSTREAM_FAILURE`. avnu's paymaster
refuses `paymaster_buildTransaction` (type `apply_action`, fee mode
`sponsored_private`) without an API key. Replaying the SDK's exact request with
no `x-paymaster-api-key` header returns JSON-RPC error
`{"code":163,"message":"An error occurred (UNKNOWN_ERROR)","data":"x-paymaster-api-key is invalid"}`.
avnu's docs (`https://docs.avnu.fi/llms-full.txt`, "Build Private
Transaction") say the Portal key is "Required for the sponsored fee modes
(`sponsored`, `sponsored_private`)", and for execution: "The relayer submits
the proven call on-chain and pays the gas; the pool fee (from the build step)
reimburses it." (avnu's "pool fee" there is what STRKWORLD calls the relay
fee.) The key is an access credential, not a budget: the player still pays,
through the relay fee withdrawn inside their own private transaction, and the
relay stays gasless for STRKWORLD. D-068 named this contingency: if the
relay needs a key for this fee mode, the fix is to set one. Shield is not
affected, because the wallet submits it (`wallet_strk20InvokeTransaction`) and
it never reaches the relay. In the same session a shield could not then be
added, most likely because the failed unshield stayed queued in the Bank visit
and a shield cannot join a spend; the D-069 debug log could not show which,
because the Bank's own steps were not logged.

**Decision.**

- `AVNU_PAYMASTER_API_KEY` is required for every relayed route: unshield,
  transfer, stake and swap. It is created at `https://portal.avnu.fi` by
  connecting a deployed wallet. In `sponsored_private` each transaction repays
  avnu itself, so Portal credits, which fund gasfree (`sponsored`)
  sponsorship, are not what these relays spend. The backend still starts
  without a key, and D-014's custody rules apply to it unchanged.
- Without a key the backend never calls avnu for a relayed route. A fee build,
  a swap preparation (its quote included) or a submission on an enabled route
  answers HTTP 503
  `{ "code": "RELAY_NOT_CONFIGURED", "message": "The private relay is not configured on this deployment." }`.
  A disabled route still answers as disabled, and the kill switch still
  answers `SERVICE_DISABLED`. With a key set, avnu's own rejection of it (code
  163 whose data or message names the API key) answers the same 503. Every
  other upstream failure, other 163s included, keeps its old answer.
- The relay writes one startup line when enabled routes will be refused,
  naming them, and nothing per request (D-014). The composition discards the
  relay's output (D-045, D-069), so the relay hands the line to the edge with
  its readiness message and the edge prints only that exact line.
- `PrivacyErrorKind` gains `relay-not-configured`, which the browser client
  maps from that 503. The Bank, the Post Office, the staking counter and the
  Exchange show "Unshield, send, stake and swap need the private relay, which
  isn't set up on this site yet. Nothing was sent."
- A shield refused behind a queued spend tells the player to remove the queued
  item first. Under D-069, a debug build also logs the Bank's mode switches,
  refused adds (reason code only), prepares (intent kinds and count only) and
  confirm stages, never an amount, a balance, a recipient or a token address.

**Consequences.** Setting the key is the whole fix; no code changes with it. A
deployment without one keeps shield working and says plainly that the relayed
actions are not set up, instead of reporting a network failure. The first
keyed relay, D-062's funded unshield, is also the evidence for the docs'
account that the in-transaction fee, not Portal credits, pays for this mode.

---

## D-071 — A pillar taller than 15 bursts the sandbox

**2026-09-28 · Accepted by the user · amends D-060 (the sandbox now resets itself by bursting, and the lobby sends a second sandbox broadcast) · extends D-011's shared seam with `SANDBOX_BURST_HEIGHT`**

**Context.** In multiplayer the sandbox is always busy and never resets. D-060
keeps nothing beyond the room's life, a busy room never empties, and sky drops
keep adding blocks up to the 900-block cap. The lead asked that "if one pillar
of blocks gets above 15 blocks they all explode and fly away, resetting the
area."

**Decision.**

- `SANDBOX_BURST_HEIGHT` (15) joins the shared seam: the most blocks a column
  may hold. The block that would make any column taller (a player's place, a
  sky drop or a carried block put back) bursts the sandbox instead: every
  placed block is removed at once, that block with them. The placer's carried
  block is consumed; blocks other players carry stay in their hands.
  `SANDBOX_MAX_HEIGHT` (256) is unchanged, and can no longer be reached.
- The authority runs every existing check first (range, occupancy, reach, the
  entrance's one-step cap, the height and block caps), so whatever it refused
  before it still refuses, and reports the tile of the column that tipped it.
  The rules stay pure and deterministic: a sky drop that bursts draws the same
  two numbers as one that lands.
- The lobby announces a burst with a second sandbox broadcast,
  `sandbox:burst` `{ x, y }`: the tile alone, whoever caused it, validated and
  relayed by the client like `sandbox:drop`. It is sent at once, not after the
  next patch, so it reaches every client before the patch that removes the
  blocks. Solo play announces it in the same order.
- Every client throws the blocks it still draws away from the burst tile:
  outward and upward, tumbling, under gravity, shrinking out after about
  1.4 s. Each block's throw is seeded only by its tile, its level and the
  burst tile, so every client sees the same explosion. For a player who asked
  for less motion (`prefers-reduced-motion`) the blocks pop out where they
  stand instead. Players on the stacks fall to the ground through the
  existing fall. When the aimed place would burst the sandbox, the target
  shows its own warning colour.
- A debug build (D-069) logs `sandbox.burst` with the tile and nothing else.

**Consequences.**

- The square resets whenever a 16th block lands on a pillar, placed or from
  the sky. Placing it needs a stand at least 14 blocks high beside the pillar,
  so it takes building; the rain and returned blocks trip it only by chance.
- Blocks are conserved between bursts, not through one. D-060's argument that
  a griefer can only rearrange the board still holds block by block, but
  anyone can now empty it by building a pillar, which is the point.
- The server vocabulary grows to three messages, none with an identity field.
  A burst reveals no more than the column change it causes.
- A late joiner never receives the broadcast; it just sees the emptied board.
- The ordering rests on Colyseus: a `broadcast` without `afterNextPatch` goes
  out at once, and the room's clock, which runs the spawner, ticks inside
  `broadcastPatch` (the room sets no simulation interval) before that tick's
  patch is encoded. If a client ever
  received the emptied state first (the lobby's order rules it out), the
  burst would still throw the blocks then popping out, and any block that
  state had just added would fly too and reappear at the next change.

---

## D-072 — Entry requires funds in the privacy pool

**2026-09-29 · Accepted by the user · supersedes D-055 in part (a supported wallet now reaches the funds gate, not the city) · supersedes D-056 in part (its STRK-only shield token) · extends D-036's frozen seam with `hasPrivateFunds` and `depositStatus` · adds one player-initiated read under D-035's balance-read rule · registers `entry.shield` (approved by the lead, 2026-09-29)**

**Context.** The lead asked for one check before the app opens: a player must
have funds in the STRK20 pool; one who does is checked and loads straight in,
one who does not is prompted to deposit anything into the pool. It had to use
the current shielding function, stay clean, and change neither the theme nor
the login method (wallet connect). Asked, the lead chose any token and any
amount ("it doesn't even need to be STRK"), checked once per session. Until
now a supported wallet (D-055) admitted the city directly, an account the
capability flow marked `not-registered` included, whose room then waited in
every building. Ready raises an explicit "Share private balances" approval for
every `wallet_strk20Balances` read (the 2026-08-16 finding), so the check can
only be a read the player starts. Given an empty token list the Wallet API
returns every shielded token's balance, and an account that never registered
answers 118. Shield never reaches the relay: the wallet proves and submits it,
and Ready takes the pool fee out of the deposit, in the deposited token (a 20
STRK shield left 14 STRK private). The pool emits `Deposit` with keys
`[sn_keccak('Deposit'), user_addr, token]` and data `[amount]` for every
deposit, read from its deployed class ABI, and it already takes deposits of
other tokens. D-056 admitted canonical STRK alone as a cautious first
rollout, not as a privacy rule: the shield's grade and disclosure name no
token.

**Decision.**

- **The gate sits after the wallet's capability check and before everything
  else.** In production, `ProductionRoot` renders it once `capabilityAdmits`
  passes, keyed by account generation; the presence owner, `App`, the World,
  the HUD and the lobby connection mount only after it passes. The demo
  composition, whose seam `App` loads itself, runs the same gate around the
  city. It reuses the connect rooms' card and the Bank's review pieces.
- **One check, started by the player, answered yes or no.** The card "One
  check before you enter" has one button, "Enter STRKWORLD", which makes one
  `hasPrivateFunds()` read: a single `wallet_strk20Balances` call with an
  empty list, true when any token's total, maturing included, is above zero.
  The amounts stay in `packages/privacy`; the shell learns a boolean. Nothing
  reads on mount or on a timer.
- **Pass, deposit or retry.** Funds pass straight into the city. No funds,
  every balance zero or a 118, shows the deposit card. A declined or failed
  read returns to the check card with the matching `COPY.errors` message and
  a retry.
- **Once per session.** A pass is remembered in this tab's `sessionStorage`
  under a SHA-256 of the normalised account, with a constant value: no
  address, balance or amount is stored. A reload of the same account skips
  the check; another account, tab or session checks again, and a storage or
  hashing failure only means checking again.
- **The deposit is the Bank's shield.** The same `prepare([shield])` and
  `confirm({ feeCeiling })`, with the Bank shield's approved disclosure at a
  `ConfirmGate` commit point (D-020, D-024). It is registered as its own
  route, `entry.shield`, under the Bank: graded `public-edge` with that
  disclosure word for word, approved by the lead on 2026-09-29, and gated by
  the build's shield policy exactly as `bank.shield` is.
- **Any token this build admits, any amount above zero.** The shield route's
  allowlist (`VITE_STRK20_SHIELD_ALLOWED_TOKENS`) is no longer STRK alone: it
  is a non-empty list of at most 16 canonical token addresses (`0x` and 1 to
  64 hex digits, a contract address above zero and below 2^251), no two with
  the same field value. A malformed, repeated, oversized or partial value
  keeps the whole route denied. The Railway deployment lists STRK, ETH, USDC
  (Circle's native USDC), USDT and WBTC. The card offers each allowed token
  the Exchange catalog describes, in allowlist order, with its symbol and
  decimals and a picker when there is more than one, and skips one it cannot
  describe. There is no minimum and no public balance (the Bank reads none).
  A plain note says part of a first deposit pays the pool's fee, with no
  figure.
- **The Bank and the Bridge still shield STRK.** The Bank works in the pool's
  money and fee token (D-013), so its shield door also needs STRK on the
  list; the Bridge plans only a STRK shield (D-061), and its planner is on
  only while STRK is listed. The register's shield disclosures name no token,
  so they hold for any deposit.
- **Figures in the token's own units.** At the gate's and the Bank's commit
  points the web writes a shield's public-leg warning from the shield it
  belongs to, with the token's decimals and symbol ("Depositing 0.5 STRK is
  public: the amount and your address are visible on-chain."), where the
  seam's detail prints base units. Both adapters emit one such warning per
  shield, in intent order; the seam and every approved string are unchanged.
  The fake's maturing warning now counts only fee-token notes, since it names
  no token.
- **Landing is a public read.** After the wallet returns the hash,
  `depositStatus()` reads the receipt through the backend's receipt route
  (D-014): the gate passes when the transaction succeeded, was accepted, and
  holds the pool's `Deposit` naming this account. There is no second wallet
  prompt. A revert says so; a receipt not seen within about three minutes
  offers "Check again". A 118 from the shield shows the existing
  not-registered guidance, with a retry back to the deposit.
- **The not-registered room is folded into the gate.** A capability
  `not-registered` state is admitted to the gate like `connected`, and the
  gate meets a 118 itself. After entry, a later operation's 118 still moves
  the connect flow to `not-registered`, and a building shows the gate's same
  card with the connect flow's recheck. The connect machine's states and
  escalation rules are unchanged.
- `PrivacyOperations` gains `hasPrivateFunds(signal?)` and
  `depositStatus(transactionHash, signal?)`; the backend-proxied
  `PoolReadClient` gains `receipt()`. The pool address and the `Deposit`
  selector are pinned in `packages/privacy/src/pool.ts`.
- Under D-069, a debug build logs the gate's transitions, by state name only.
- The demo seam starts a fresh player with nothing in the pool, and its notes
  mature at once so a practice deposit can be spent;
  `createDemoOperations({ funded: true })` and the fake's `balances` start
  funded.

**Consequences.** Every player approves one balance share per session before
the city opens, and a player with nothing in the pool makes a public deposit
first, which names their address, token and amount on-chain. A build with
shield switched off shows new players a locked deposit card: they cannot enter
until it is on. A list without STRK keeps the gate open but shuts the Bank's
shield and the Bridge planner. The fee comes out of the deposit in the
deposited token, of a size the gate cannot state, and its fee ceiling is
still the prepared pool fee. Each depositing player adds one public receipt
read every few seconds to the backend's shared rate window while the gate
waits.
