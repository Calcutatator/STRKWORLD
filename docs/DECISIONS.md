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

**2026-08-18 · Accepted · extends D-034 after the Shieldup production-reference audit**

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

**2026-08-18 · Accepted · implements D-028 and supersedes D-015's provisional seam status**

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

**2026-08-18 · Accepted · completes D-019's unavailable-path behavior**

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

**Decision.** Lobby availability is independent of wallet and financial
availability. If the lobby is missing or unreachable, STRKWORLD remains fully
playable in **solo mode** and shows a clear multiplayer-unavailable status. It
never invents peers or claims a connection exists. A configured endpoint gets
an explicit manual reconnect control; there is no automatic retry loop.

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

**2026-08-18 · Accepted · technical direction delegated to the project lead · extends D-030–D-033**

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

**2026-08-18 · Accepted · technical direction delegated to the project lead · completes the bounded deferral in D-039**

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
