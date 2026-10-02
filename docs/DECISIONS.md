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
external sibling tester without creating an exception inside STRKWORLD ·
`wallet_strk20ShadowAccountCommitment` joins the calls, for the Vault, by D-077**

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

**2026-08-16 · Accepted · SUPERSEDED in part by D-077 (the Vault opens on STRK20 shadow accounts through the canonical anonymizer, with no project-owned Cairo, behind a fail-closed switch; with the switch off it is still this facade)**

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

**2026-08-16 · Accepted · seam extended with the Privacy Plaza's `plaza` building id, `plaza:nearby` and `plaza:stats` by D-076 · with the football pitch's constants and types, and `SANDBOX_AREA` laid out from `STREET_ORIGIN_X`, by D-078 · `plaza:stats`'s `held` replaced with `valueUsd` and `topHoldings` by D-080 · `deposits24h` removed from `plaza:stats` by D-098**

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

**2026-08-16 · Accepted · paymaster key made optional (gasless relay) by D-068 · per-request logging exception for opted-in test deployments by D-069 · key required again for relayed routes by D-070 · a background public-aggregate scan (the Privacy Plaza's pool stats) added by D-076 · two pinned public Vault reads (the shadow account and its position) added by D-077 · Vesu's supply APY, fetched from Vesu's public API by the backend alone, added by D-079**

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

**2026-08-16 · Accepted · amended by D-077 (a fourth approved route: the canonical STRK20 shadow-account anonymizer, which the Vault uses with no project-owned helper) · the swap uses that route too since D-084**

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

**2026-08-16 · Accepted · supersedes D-016's presence requirement · superseded in part by [D-087](#d-087--only-the-overworld-the-exchange-roof-and-the-avatar-studio-are-multiplayer-each-a-presence-area-of-its-own) (the Exchange roof and the Avatar Studio are shared presence areas: reaching them switches presence instead of suspending it; every other interior still suspends)**

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

**2026-08-16 · Accepted · amends D-015 · funded-evidence caveat qualified by D-028 · "the shell must not derive MAX when maturity is unknown" amended by D-089 (a Max may use the wallet's per-token total; the wallet refuses a spend counting a note still maturing, and the shell says the funds are settling) and by D-090 (the Exchange's Max does the same) · amended for the Bank by D-091 (the same rule, plus the costed-shape requirement it keeps)**

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

**2026-08-16 · Accepted · amends D-014, D-015 and D-018; partially supersedes D-021 · funded-evidence caveat qualified by D-028 · superseded by D-084 (the swap is wallet-submitted through a shadow account, quoted by avnu's keyless public API through the backend; no server plan, relay or quote binding)**

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

**2026-08-17 · Accepted · supersedes D-016's overlay mechanism · amended by D-103 (Menu Mode no longer batches: every counter does one action)**

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

**2026-08-18 · Accepted · extends D-011 and D-027; implements the seam change anticipated by D-030 · stations on the street, used with E, added by D-076**

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

**2026-08-18 · Accepted · implements D-028 and supersedes D-015's provisional seam status · narrowly extended by D-041/D-042 for truthful swap review, and by D-063 for private staking · failure taxonomy extended by D-070 (`relay-not-configured`) and D-074 (`recipient-not-registered`) · methods extended by D-072 (`hasPrivateFunds`, `depositStatus`) · the Vault's `vaultPosition`, `prepareVaultSupply`, `prepareVaultRedeem`, `supportsShadowAccounts` and `shadow-accounts-unsupported` added by D-077 · `vaultPositions` (replacing `vaultPosition`), a token for `prepareVaultRedeem`, and `vaultRates` by D-079 · `endurRate` (xSTRK's exchange rate, a public read) by D-091**

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

**2026-08-18 · Accepted · technical direction delegated to the project lead · completes the bounded deferral in D-039 · Exchange deferral completed by D-042 · transfer batching narrowed to one recipient per send by D-065 · amended by D-103 (no visit queue: one send, reviewed straight from the form)**

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

**2026-08-18 · Accepted · technical direction delegated to the project lead · narrow extension of the D-036 freeze · minimum-source rule superseded by D-042 · extended by D-084 (the review gains an oracle `priceCheck`; its quote expiry is STRKWORLD's own 30 s and is re-quoted at confirmation)**

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

**2026-08-18 · Accepted · technical direction delegated to the project lead · implements D-030–D-032, completes D-040's Exchange deferral and amends D-041's minimum mapping · rendered Exchange room/station status updated by [the 2026-08-28 finding](../AGENTS.md#2026-08-28--room-navigation-and-three-admitted-stations-pass-bridge-deposit-stays-locked) · the ground floor keeps these six assets, but the degen floor's runtime catalog (a backend-fetched avnu list) is added by D-067 · the protected-minimum formula is kept by D-084, which sets the on-chain floor itself**

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
[D-049](#d-049--avatar-art-uses-one-fixed-64x64-logical-canvas), and its
"entering it suspends lobby presence" by
[D-087](#d-087--only-the-overworld-the-exchange-roof-and-the-avatar-studio-are-multiplayer-each-a-presence-area-of-its-own)
(the Studio is a shared presence area: its players see each other, with their
current look); remaining foundation implemented and rendered accepted on
localhost**

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
QA-verified and visually approved by calc for runtime integration; World
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
calc then visually approved those committed assets for runtime integration.
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

**2026-08-20 approval-flow amendment.** calc delegated intermediate sprite
direction and rejection to orchestration. Art may iterate through turnaround,
edge, pose, movement and export gates without pausing for user approval at
each contact sheet. Intermediate scaffolds and mechanical QA boards are not
user-review deliverables. The next user checkpoint is the completed,
independently reviewed correction after final assets and the five-column
runtime are integrated, with a short user-run in-game acceptance script. This
amendment removes repeated approval pauses; it does not waive D-052's final
rendered-acceptance requirement or authorize a mechanically conforming but
visually incoherent asset.

**2026-08-28 Avatar 1 cosy six-column amendment.** calc explicitly approved
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
approval plus calc's instruction to continue authorizes a scoped Avatar 1
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

**2026-08-28 Avatar 1 cosy rendered-acceptance status.** calc accepted this
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
Studio is active. calc reported that the outfit toggle therefore appears to
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

**2026-08-23 · Accepted · autonomous tester prompting superseded by D-057 · discovery extended by D-073 (bounded looks for late injected wallets; the picker keeps its order)**

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

**2026-08-23 · Accepted by the user · SUPERSEDED in part by D-072 (a supported wallet now reaches the funds gate, not the city) · extended by D-073 (display-only install links and gate-era unsupported copy on its entry card) · supersedes D-037's wallet-independent
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
turns the user into a manual test runner. calc explicitly requires the project
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

**2026-08-29 · Accepted by the user · the cue's figure is the default 3D figure walking, pre-rendered, instead of Avatar 1's 2D idle frame, since [the 2026-09-30 finding](../AGENTS.md#2026-09-30--the-wallet-cues-figure-is-a-walk-pre-rendered-from-the-3d-model-the-2d-sheets-no-longer-ship)**

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
mechanism named in D-008, D-030 and D-039 · the street and its backdrop move
east, unchanged relative to each other, for the football pitch by D-078 · the
2D sheets no longer feed D-058's cue, by [the 2026-09-30 finding](../AGENTS.md#2026-09-30--the-wallet-cues-figure-is-a-walk-pre-rendered-from-the-3d-model-the-2d-sheets-no-longer-ship) ·
other players' interpolation is a critically damped follow by D-086**

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
broadcast) · amended by D-078 (a football pitch square of the same size takes
the road's west end, and the street and the sandbox move east with
`STREET_ORIGIN_X`: `SANDBOX_AREA` is x 83-110)**

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

**2026-09-27 · Accepted by the user · extends D-036's frozen seam with a `stake` intent · a D-018 anonymizer path · respects D-030's one-grade-per-station rule · superseded in part by D-085 (staking is switched on for the test deployment, and the counter is no longer stake-only: unstaking runs through a shadow account, not a withdraw anonymizer) · amended by D-103 (STAKE does one thing; UNSTAKE is its own counter beside it)**

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

**2026-09-27 · Accepted by the user · a narrow exception to D-020/D-024's disclosure rule, for `bank.stake` only · amended by D-085 (the unstaking note now points at the unstaking counter; the waiver itself is unchanged)**

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

**2026-09-28 · Accepted by the user · extends D-042 (the ground floor's six-asset catalog is unchanged) · keeps D-018's server-side allowlisting · amended by D-084 (the degen admission guards the keyless quote proxy, not a relay; the browser admits the list behind its own switch) · amended by D-088 (Menu Mode offers the degen floor's window beside the ground floor's)**

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

**2026-09-28 · Accepted by the user · narrows D-014's "holds the paymaster key" to "holds it if one is used" · keyless default SUPERSEDED by D-070 · superseded in part by D-082 (no player flow but swap reaches the relay)**

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

**2026-09-28 · Accepted by the user · narrows D-014's "logs nothing per-request" for opted-in test deployments only · `vault.*` probe events added by D-077 · `football.*` events added by D-078**

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

**2026-09-28 · Accepted by the user (D-068's contingency) · supersedes D-068 in part (its keyless default) · extends D-036's frozen seam with a `relay-not-configured` failure kind · superseded in part by D-082 (unshield, transfer and stake are wallet-submitted and need no key; only swap is still relayed) · superseded for the swap by D-084 (no player flow needs the key)**

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

**2026-09-28 · Accepted by the user · amends D-060 (the sandbox now resets itself by bursting, and the lobby sends a second sandbox broadcast) · extends D-011's shared seam with `SANDBOX_BURST_HEIGHT` · burst threshold superseded by D-075**

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

**2026-09-29 · Accepted by the user · supersedes D-055 in part (a supported wallet now reaches the funds gate, not the city) · supersedes D-056 in part (its STRK-only shield token) · extends D-036's frozen seam with `hasPrivateFunds` and `depositStatus` · adds one player-initiated read under D-035's balance-read rule · registers `entry.shield` (approved by the lead, 2026-09-29) · a transfer's 118 scoped to its recipient by D-074 · superseded in part by D-094 (the Bank's Shield control reads the wallet's public balance, and a STRK deposit pays the pool fee on top instead of out of the deposit)**

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
  reads on mount or on a timer. Every card after it (the deposit form, the
  locked deposit card, the not-registered card, and a deposit the network
  has not confirmed or cannot be checked) offers the same read as "Check my
  private balance", so none is a dead end; it stays a press, and the wallet
  asks first.
- **Pass, deposit or retry.** Funds pass straight into the city. No funds,
  every balance zero or a 118, shows the deposit card, with its form as the
  player left it when the check came from a later card. If a deposit the
  player sent has not shown up yet, the card says it "may still be on its
  way", so "nothing yet" does not read as an invitation to send a second. A
  declined or failed read returns to the check card with the matching
  `COPY.errors` message and a retry.
- **Once per session.** A pass is remembered in this tab's `sessionStorage`
  under a SHA-256 of a fixed label and the normalised account, with a
  constant value, so no raw address, balance or amount is stored. The key is
  no secret: anyone with the public address, which the pool's `Deposit`
  events print for every depositor, can recompute it. A reload of the same
  account skips the check; another account, tab or session checks again, and
  a storage or hashing failure only means checking again.
- **An answer belongs to its account.** Before the gate acts on a check, a
  deposit or a receipt, or honours a remembered pass, it re-reads the
  session's account (`WalletSession.readAccount`, which asks the wallet
  nothing) and drops the answer if the account moved in place. Its owner,
  keyed by account generation, then builds a fresh gate that checks again.
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
  figure. At review, a STRK deposit no larger than the prepared pool fee
  (D-013) gets a plain warning in the note's place, that nothing would reach
  the pool because the fee comes out of the deposit, and Confirm stays
  available. Another token's share of the fee cannot be stated, so it keeps
  the note. A 119 from the shield says the wallet's public balance of the
  chosen token is too small ("There is not enough USDC in your wallet's
  public balance for this deposit."), not the shielded balance the shared
  `COPY.errors` line names.
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
  (D-014), at once and then after 3, 6 and 12 seconds and every 20 seconds
  after that: twelve reads in about three minutes. The gate passes when the
  transaction succeeded, was accepted, and holds the pool's `Deposit` naming
  this account. There is no second wallet prompt. A revert says so; a
  receipt not seen in that time offers "Check again" and the balance check.
- **A failed read is not "not yet".** The receipt route answers a hash its
  node has not seen (JSON-RPC error 29) with 200 `null`, which reads as
  `pending`. Any other failure (a 429, 502, 503 or 504, or no answer at all)
  makes `depositStatus()` reject `unreachable`, and three such reads in a row
  end the watch early with "STRKWORLD can't reach the network check right
  now, so it can't tell whether this deposit has arrived yet.", "Check again"
  and the balance check. An answer in between resets the count.
- **A 118 from the shield leads back to the check.** It shows the existing
  not-registered guidance with "Check my private balance" rather than a
  retry of the deposit: registering inside Ready often makes a first deposit
  too, and a retry would invite a second.
- **The not-registered room is folded into the gate.** A capability
  `not-registered` state is admitted to the gate like `connected`, and the
  gate meets a 118 itself. After entry, a later operation's 118 still moves
  the connect flow to `not-registered`, and a building shows the gate's same
  card with the connect flow's recheck. The connect machine's states and
  escalation rules are unchanged.
- `PrivacyOperations` gains `hasPrivateFunds(signal?)` and
  `depositStatus(transactionHash, signal?)`; the backend-proxied
  `PoolReadClient` gains `receipt()`, and the backend's
  `PoolRpcPort.getReceipt` resolves `null` for error 29 and rejects on every
  other RPC error. The pool address and the `Deposit` selector are pinned in
  `packages/privacy/src/pool.ts`.
- Under D-069, a debug build logs the gate's transitions, by state name only.
- The demo seam starts a fresh player with nothing in the pool, and its notes
  mature at once so a practice deposit can be spent;
  `createDemoOperations({ funded: true })` and the fake's `balances` start
  funded.

**Consequences.** Every player approves a balance share before the city
opens, once per session unless they check again from a later card, and a
player with nothing in the pool makes a public deposit first, which names
their address, token and amount on-chain. A build with shield switched off
shows new players a locked deposit card: they cannot deposit there, and only
one who deposited elsewhere can check their balance and enter. A list without STRK keeps the gate open but shuts the Bank's
shield and the Bridge planner. The fee comes out of the deposit in the
deposited token, of a size the gate cannot state, and its fee ceiling is
still the prepared pool fee. Each depositing player adds at most twelve
public receipt reads, further apart each time, to the backend's shared rate
window while the gate waits.

---

## D-073 — Late injected wallets appear without a click; install links are display only

**2026-09-29 · Accepted by the user · extends D-054's discovery (the session looks again for late injected wallets, and the picker keeps its order) · adds display-only install links and gate-era unsupported-wallet copy to D-055's entry card · amended by D-093 (a wallet that answers the capability query as a method it lacks, or with nothing, lands in the unsupported room, not the unreachable one; a too-old version says so)**

**Context.** The lead asked: "We also need to add Xverse as a wallet
connector too." Xverse offers Starknet to dapps through the legacy injected
global `window.starknet_xverse` (StarknetKit's injected connector `xverse`).
No evidence was found that it registers through the Wallet Standard, and it
is not in get-starknet's default registry. Discovery already lists any
`window.starknet_*` wallet (the 2026-09-27 getter finding), so SPEC §5 rules
1 and 2 leave nothing Xverse-specific to build, and forbid it. Two gaps
remained. The store scans those globals once, when it is built, so a wallet
that injects later stayed missing until the player pressed "Look again".
And the store puts its newest wallet first, which would move the buttons a
player is about to press. `COPY.unsupported` also predated the entry gate:
it said "the doors that need the pool stay shut", but since D-055 and D-072
nothing in the city opens for such a wallet.

**Decision.**

- **Look again, briefly.** The session looks again 250 ms, 1 s, 2.5 s and 5 s
  after it starts, then stops; `destroy()` clears the timers. Each
  choose-a-wallet card (the production entry card and the connect room's
  picker) also looks once as it mounts, and each time the page becomes
  visible while it shows. A look is best effort: it only adds wallets to the
  list, never selects or connects one (D-054), and a throwing scan is
  swallowed.
- **Nothing moves.** Every listed wallet keeps its place and a new one joins
  the end, told apart by object alone, never by name. The store already
  refuses a second wallet of the same name, so looks add no duplicates.
- **Install links are display only.** While discovery lists no wallet, the
  card shows "Get a wallet: Ready · Xverse", linking https://www.ready.co and
  https://www.xverse.app in a new tab with `rel="noopener noreferrer"`. The
  links are static `COPY.connect` content in the web shell, read only by the
  one component that prints them (`GetAWallet`). They never feed discovery,
  the list, a filter or the STRK20 path, and a wallet named there is treated
  exactly like any other.
- **Gate-era unsupported copy, naming the wallet.** "{wallet} can't open the
  privacy pool yet" and "{wallet} is connected but doesn't yet offer the
  STRK20 privacy methods STRKWORLD needs, so the city stays closed. Your
  funds are fine. Connect a wallet that supports STRK20 private balances, or
  check again once {wallet} adds them." The name is the picker's display-only
  name for the selected choice, never compared; without one the room says
  "Your wallet". Its one action, "Connect a different wallet", still
  rechecks.

**Consequences.** A late-injecting wallet, Xverse included, appears at the
next look (in the first five seconds, on return to the tab, when a card next
mounts, or on "Look again") and still needs the player's click. A wallet the
store replaces with its own Wallet Standard registration is a new object, so
it moves to the end once. A connected Xverse is expected to land in
`unsupported-wallet` until it ships the dapp-facing STRK20 methods, and then
to pass the capability check with no code change. That holds while it
answers `wallet_supportedWalletApi` below 0.10.3 or with error 162: any other
failure of that query shows the unreachable room. Neither has been seen with
a live Xverse; that stays on the manual wallet checklist (D-028). Every look
re-wraps each injected global, and each wrapper adds two listeners to the
wallet's object that nothing removes (upstream), so looks stay bounded,
never periodic.

---

## D-074 — A transfer's 118 names its recipient, not the player

**2026-09-29 · Accepted by the user (the lead reported the fault and asked that a 118 met while sending be scoped to the recipient) · extends D-036's frozen seam with a `recipient-not-registered` failure kind · amends D-072 in part (a transfer's 118 no longer moves the connect flow to `not-registered`)**

**Context.** The lead reported that a registered, funded player sending from
the Post Office (`post-office.transfer`) to an address that has never
registered with the pool was shown the not-registered card ("Register with
the pool first"), and attributed it to a JSON-RPC 118 `NOT_REGISTERED` from
the wallet. Two paths turned a fact about the recipient into one about the
player. The Wallet API adapter's prepare-time preflight (`warningsFor`), and
the fake's, threw `PrivacyError('not-registered')` when the pool's
`get_public_key(recipient)` read zero. And `mapWalletError` maps every 118 to
`not-registered`, including one from `wallet_strk20PrepareInvoke` while it
proves a transfer. The connect flow escalates any `not-registered` into its
`not-registered` state (D-072), and `PanelLayer` then replaces the building's
room with that card. The D-072 finding had already logged the first path as a
trap.

In this app the wallet is asked to prove a transfer only after that preflight
has read the recipient as registered. A never-registered recipient is
therefore refused before any proof: at Add, with the Bank's own notice, or,
when the Add's read could not tell, at `prepare()`. That last refusal is the
path the tests reproduce. A 118 from the proving call can only follow a
preflight that read the recipient as registered, a disagreement between the
pool and the wallet that nobody has observed. The Wallet API defines 118 for
the caller alone (`@starknet-io/types-js` 0.10.3: "NOT_REGISTERED if the user
is not registered") and has no code for a recipient, and
`docs/research/primary-source-verification.md` left the transfer-to-unregistered
mapping to a live wallet test. Since D-072 no player reaches a building
without a wallet answer about their own account that a 118 would have
refused. That answer is the balance check, or a shield the wallet accepted
and the pool recorded (the Wallet API answers 118 to both for an
unregistered account), or a pass this tab remembered from one of those. An
account switch builds a fresh gate.

**Decision.**

- `PrivacyErrorKind` gains `recipient-not-registered`: the transfer's
  recipient is not registered in the pool, so it cannot receive a private
  transfer, and nothing was sent. It is a fact about the recipient, and only
  they can register, inside their own wallet.
- A transfer to an address whose `get_public_key` reads zero rejects at
  `prepare()` with it, in the Wallet API adapter and the fake alike.
- On the transfer route, and only there, a 118 from the wallet's proving call
  maps to it as well (`mapTransferWalletError`, internal to the adapter). This
  follows the lead's rule that a 118 met while sending never moves the
  player's own state, and D-072's entry has already settled the sender's
  registration. The wallet's own answer stays on the error's `cause`, so a
  D-069 debug line still reads `code=118 NOT_REGISTERED`. Every other 118
  stays `not-registered`: the entry check, balances, shield, unshield (whose
  recipient is a public address), swap and stake. `mapWalletError` itself is
  unchanged.
- The connect machine is unchanged: only `not-registered` and
  `unsupported-wallet` move it, so the new kind stays in the panel that met
  it. The Bank and the Post Office show "That recipient hasn't set up private
  balances yet, so they can't receive a private transfer. Nothing was sent."
  with the failed prepare's usual Back, which keeps the send queued.
- No approved copy changes. The Add-time preflight's line, the register's
  disclosures (D-024) and the transfer route's waiver (D-065) stay as they
  are, and the new line obeys D-065's transfer copy rules.

**Consequences.** A registered player whose recipient has not registered
keeps the Post Office open and reads whose step is missing. The connect flow,
the HUD's wallet status and every other room are untouched. Once the
recipient registers, Back and Review send it. A 118 from the proving call
shows the same line even though the pool read the recipient as registered,
so Review may keep failing until the wallet agrees. If one is ever seen,
compare the recipient's `get_public_key` with the wallet's own view. If a
wallet answered 118 on a transfer about the sender's own account, which
D-072's entry rules out, the player would read the recipient line instead of
the registration card; nothing is sent either way. Every exhaustive record
of the kinds must list the new one. The shell's classifier, the debug format
and `COPY.errors` are typed so that the compiler refuses one that misses it.
No agent opened a wallet for this decision.

---

## D-075 — The 15th block bursts, and sky drops fall a little faster

**2026-09-29 · Accepted by the user · supersedes D-071's threshold only (a column now holds at most 14, and the 15th block bursts the sandbox)**

**Context.** The lead tried D-071's burst live at a temporary
`SANDBOX_BURST_HEIGHT` of 3: three stacked blocks stood, and the fourth
burst the sandbox, matching the rule exactly as shipped. Satisfied it worked,
the lead asked that production "make sure it does that when placing the 15th
block" — one lower than D-071 shipped — and separately, of the sky-drop fall
animation, to "make the blocks drop slightly faster, only a little bit."

**Decision.**

- `SANDBOX_BURST_HEIGHT` drops from 15 to 14: the most blocks a column may
  hold. The 15th block — placed, dropped from the sky or put back — bursts
  the sandbox instead of stacking, one block sooner than D-071 shipped.
  Nothing about the mechanism changes: which checks run first, what a burst
  reports, how every client throws its blocks, and the debug log are all
  D-071's, untouched, because they are expressed only through this one
  constant.
- `GRAVITY` in `three/sandbox-view.ts` rises from 42 to 58 units/s²: a sky
  drop from `DROP_HEIGHT` (40) now takes about 1.17 s to land instead of
  about 1.38 s, so the rain reads a little brisker. `DROP_HEIGHT`,
  `BOUNCE_SPEED`, `SETTLE_MS`, the burst's own `BURST_GRAVITY` (16, floatier
  than a sky drop's so the throw still reads as an explosion) and the
  server's spawn interval are unchanged; only the ordinary sky-drop landing
  speeds up.

**Consequences.** A stand that reached a pillar's top at one below the old
cap now needs one block less to do it: 13, not 14. Every other reach, range,
occupancy and conservation rule D-071 established is unaffected, since none
of them name a height directly — only `SANDBOX_BURST_HEIGHT` moved. The cap
is enforced only at the moment a block would join a column, so nothing
retroactively bursts; a column already standing at the old cap simply bursts
on the next block it is offered, exactly as D-071 always specified for a full
column. Sky drops read very slightly snappier; their landing tile, colour and
avoidance rules are unchanged.

---

## D-076 — The Privacy Plaza at the west end

**2026-09-29 · Accepted by the user · extends D-011's shared seam with a non-financial `plaza` building id, `plaza:nearby` and `plaza:stats` · extends D-033's stations to the street, used with E, outside any building · adds a background public-aggregate scan to D-014's backend, which still logs nothing per request · registers no route (D-020) · moves east with the street, unchanged relative to it, beside D-078's football pitch · the pool's value and top holdings replace the six-token `held` reads, from an external aggregate, by D-080 · the 24-hour deposit count leaves the monument and its window, and the total gets its own face, by D-098**

**Context.** The lead: "The left end of the road, opposite the sandbox, has
nothing to do." Offered options, the lead picked "Privacy Plaza — a no-money
social spot: a live pool-stats monument plus a shell-game mini-game showing
how the pool hides notes." The south side of the road's west end (y 19-27)
was empty grass, and stations existed only inside building rooms, where they
open on approach (D-033). Read on mainnet on 2026-09-29: `ViewingKeySet` is
a `nested` variant of the pool's event enum with keys
`[sn_keccak('ViewingKeySet'), user_addr, public_key]`; the pool has emitted
2,932 of them since its first block, 8,978,970, each for a different
address; 23 deposits landed in the last 51,429 blocks (a day at about 1.68 s
a block; that span was 87,270 s); and `balance_of(pool)` answers a u256 for
all six Exchange catalog tokens. Cartridge's public RPC pages
`starknet_getEvents` by about 81,920 blocks with a continuation token, so
reading the pool's whole life takes about 82 pages and 25 s. Asked for a
numeric `to_block` a million blocks past its head, it answers without an
error; asked for a block hash it has not seen, it refuses with
`BLOCK_NOT_FOUND` (24).

**Decision.**

- **Where.** A paved square at street tiles x 0-10, y 19-27, level with and
  entered from the south pavement through a gateway: two posts and a lintel
  carrying a "PRIVACY PLAZA" sign on the Bank facade's STRK20 plate, with
  planters either side and the east side open to the grass. Benches, park
  lamps and trees in tubs, in the street's golden-hour palette. Two new tile
  kinds carry it: `plaza` (walkable) and `plinth` (solid, under every
  fixture), so collision stays tile-based and no volume stands where a player
  walks. It keeps clear of the Avatar Studio path (x 23-24) and the spawn.
  The geometry is its own module, `three/plaza-builder.ts`, merged into the
  street's groups and draw-call budget: twelve more calls and about 2,400
  more triangles.
- **The monument.** A STRK20-dark obelisk on a stepped plinth at x 4-6,
  y 22-24, its square shaft turned 45 degrees so the fixed north camera sees
  two faces: accounts registered and deposits in the last 24 hours. The
  plinth's front shows what the pool holds, one token at a time. The World
  receives the figures pre-formatted (`plaza:stats`, like `hud:balance`) and
  draws "…" for any it lacks; it never learns what they mean. The monument
  and the gateway fade like buildings when they hide the player.
- **Two stations, used with E.** `plaza:monument` and `plaza:shells` open from
  any tile beside the monument or the table. Walking past opens nothing: the
  street is shared and the player may only be passing. The handoff is the
  fixed rooms', with the plaza as the building: the World suspends input,
  emits `station:activated`, the Shell claims `world:control-owner` while it
  is delivered and hands it back when the window closes, and an unclaimed
  activation gives the World its input straight back. No building is
  entered: no `building:entered`, presence and the lobby are untouched
  (D-019 is unchanged), and there is no Menu Mode and no wallet check.
- **Public aggregates only.** The backend answers `POST /v1/rpc/pool-stats`
  with `{ "v": 1 }` and nothing else as
  `{ accounts, deposits24h, held: [{ token, amount }] }`, each part null
  until counted. A cache computes them in the background: the registration
  count scans from block 8,978,970 in windows of 250,000 blocks, following
  the node's continuation tokens and committing after each window, then only
  the blocks since. The range that reaches the head names it by the hash
  `starknet_blockHashAndNumber` gave, so a node behind a load balancer that
  trails the one that gave the head refuses the read instead of answering
  short, and a window that ends by number ends at least 250,000 blocks below
  the head. The deposit window keeps the block number of each
  deposit in the last 51,429 blocks and nothing else; the balances are read
  for the six Exchange catalog tokens, pinned in the backend so no request
  can name a contract. The RPC port hands back block numbers only, never an
  address, key, amount or transaction hash. A refresh runs about every 60 s
  while the route is asked, one at a time, stops after ten quiet minutes and
  starts at boot; the route answers from memory at once and serves each
  part's last good value while it refreshes. It has its own rate window,
  600 requests a minute, apart from the one the private routes share: the
  figures cost the chain nothing, so a crowd at the plaza never takes a slot
  a fee quote or a submission needs. It is refused with the kill switch off,
  and logs nothing.
- **The web reads while someone can see it.** The Shell reads the route when
  the World reports the plaza in view (`plaza:nearby`, a new World event) or
  while the monument's window is open, about every 60 s, never on a hidden
  page. The held figures cover this build's shield allowlist as far as the
  Exchange catalog describes it (STRK, ETH, USDC, USDT and WBTC on Railway).
  A failed read keeps figures younger than three minutes and otherwise shows
  "…". A failed read (a 429 included), or an answer with a part still
  uncounted, is asked again after 15 s (10 s) and then backs off, doubling to
  the minute with up to a quarter more at random; walking in and out of view
  never reads inside a backoff, and a read not answered in 15 s is given up
  as a failure. The demo shows sample figures labelled as such, and a
  production build refuses them. The window adds three sentences on the
  anonymity set and one on the public edges.
- **The shell game is client-only.** No money, wallet, backend or lobby, and
  nothing kept beyond the page. The note starts under a cup chosen by
  `crypto.getRandomValues` (rejection-sampled, so every cup is equally
  likely), six visible swaps carry it in its cup, and a pick wins exactly
  when it finds it. Each win in a row makes the swaps about a tenth quicker
  (520 ms down to a 240 ms floor); a miss resets the streak. A player who
  asked for less motion gets a quick fade in place of the swaps. Its line:
  "In the pool, notes look alike from outside. Without your viewing key, no
  one can tell which ones are yours."
- **Registry.** `BuildingId` gains `plaza`, which `BUILDINGS` leaves out
  (there is no door, so `ownBuildingPayload` refuses it); `StationId` then
  covers `plaza:*`. The Shell's station registry maps both stations with no
  routes, and nothing enters the privacy register.
- A debug build (D-069) logs `plaza.open` and `plaza.close` with the station
  id and `plaza.shells` with `result=win` or `result=lose`, and nothing else.

**Consequences.** Each player standing near the plaza adds about one stats
read a minute to the route's own window, so about 600 players at once fill
it; past that some reads get a 429 and back off, and the monument keeps its
last figures for up to three minutes. The private routes' shared window
never sees them. The backend reads the chain on its own for the first time:
about nine RPC calls a minute while the stats are wanted, plus one
whole-history scan per process, and nothing after ten minutes without a
request. The scans were read against Cartridge's public RPC; the deployment
reads through its own `STARKNET_RPC_URL`, and a provider that refuses long
`starknet_getEvents` ranges leaves the accounts figure at "…" rather than
wrong. The accounts figure counts `ViewingKeySet` events, one per registered
account because a viewing key is set once; if the pool ever let an account
set one twice, it would count twice. Every exhaustive record keyed by
building must now handle `plaza` (`COPY.buildings`; the street's
`BUILDING_THEMES` is now partial). The figures are the pool's own public
facts: the stats show the crowd, and nothing about who is in it.

---

## D-077 — The Vault opens on shadow accounts

**2026-09-29 · Accepted by the user · supersedes D-007 in part (the Vault no longer needs project-owned Cairo, and is no longer only a facade) · amends D-018 (a fourth approved route: the canonical shadow-account anonymizer) · extends D-036's frozen seam with `vaultPosition`, `prepareVaultSupply`, `prepareVaultRedeem`, `supportsShadowAccounts` and a `shadow-accounts-unsupported` failure kind · bumps the pinned connection stack to Wallet API 0.10.4 · adds two pinned public reads to D-014's backend, which still logs nothing per request · adds `vault.*` probe events to D-069 · registers `vault.supply` and `vault.redeem` (approved by the lead, 2026-09-29) · amended by D-079 (five tokens, a position per token with the stand-in address shown, Vesu's supply APY, and the fee's token explained) · amended by D-081 (every Vesu market, some through curated pools; a collateral-only market is not supplied) · amended by D-085 (its commitment, address cross-check and wallet submission, shared with the Borrow counter since D-083, now serve Endur unstaking too, under unstaking's own dapp name) · amended by D-103 (SUPPLY and REDEEM are separate counters; `vault:lending` is an alias of `vault:supply`)**

**Context.** D-007 kept Vesu out of v1 because the Vault was the only
building needing new Cairo: a project-owned `privacy_invoke` adapter, the
third route of D-018, which "production helpers are owned, reviewed, tested,
audited, deployed and maintained by this project". SPEC §4 costed it at
150-200 lines of Cairo and §8 put it after v1, and §4 ruled out
`shadow_account_invoke` because it had appeared in `types-js` 0.10.4-beta.2
and been pulled again. It has since shipped. Stable Wallet API 0.10.4
(`@starknet-io/types-js` 0.10.4, carried by `starknet` 10.8.0) defines
`wallet_strk20ShadowAccountCommitment` and the `shadow_account_invoke` action:
a keyless, deterministic address per (player, `dapp_name`, nonce) that only
the canonical `ShadowAccountAnonymizer` can execute through, deployed on
mainnet at `0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7`
on 23 July 2026 with its source verified on Voyager. Read over mainnet RPC on
2026-09-29 (block 15,641,579): its class is
`0xb61dee4f9f6b243f5310fbfab4224128db5c4815077b6329c232f8fc9af409`,
`get_privacy_contract()` is the STRK20 pool, and `get_shadow_accounts` agreed
for three commitments with the address derived from the deployed `Primer`
class `0x00123e6bc1c14ae9934e933d3f64916a6116dd6b036a922b2b1f0815e0d1d300`,
not from `get_shadow_account_class_hash()`
(`0x70e76435b6ddb74b11665d3bc3264aaf354f59329976f3ffcb03b2ab992b78f`), which
is what the starknet.js 10.8.0 guide derives with. Vesu's Prime vSTRK vault
at `0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d`
("Vesu Starknet", vSTRK, 18 decimals, `asset()` STRK) exposes ERC-4626
`deposit`, `withdraw` and `redeem` with `balance_of`, `preview_redeem`,
`max_withdraw` and `max_redeem`; a share previewed at 1.0204 STRK, and the
pool fee read 6 STRK. The Vesu shadow-vault example
(`github.com/starkience/starknet-shadow-vault-example`) runs that vault end
to end on mainnet through the anonymizer with no new Cairo. The lead's Ready
reports Wallet API 0.10.4, but nobody has yet confirmed a full supply and
redeem through a shadow account in Ready. The lead asked for the Vault on
shadow accounts, behind a fail-closed switch, as the first version and as
the probe of that support.

**Decision.**

- **The route.** The Vault lends STRK to Vesu's Prime vSTRK vault from the
  player's shadow account for `dapp_name` `strkworld-vault`, nonce 0, through
  the canonical anonymizer. D-018 gains it as a fourth approved route: shared
  StarkWare infrastructure bound to the pool, not a project-owned helper, so
  the Vault adds no Cairo. The name and nonce are fixed for good: they are
  part of every player's stand-in address, and changing either would move
  every position to an address nothing here reads.
- **Supply and redeem, STRK only.** A supply withdraws the amount from the
  pool to the shadow account, the public leg, then through it approves vSTRK
  and deposits with the shadow account as receiver, collecting nothing
  (`exact 0`): the shares are the position. A redeem opens one STRK note for
  the player, then has the shadow account `withdraw(assets)` for an amount,
  or `redeem` every share for "everything", as receiver and owner, collecting
  only what the call gained (`diff`). A redeem above what the vault lets the
  position take now (`max_withdraw`, `max_redeem`) is refused before the
  wallet is asked. These are the example's action shapes. Borrowing and
  collateral stay out.
- **The wallet proves and submits** both, through
  `wallet_strk20InvokeTransaction`, as it does a shield: no STRKWORLD relay,
  no avnu key and no relay fee. The wallet adds its own network fee, which
  the review leaves to the wallet to state, and the pool fee comes out of the
  shielded balance on both legs.
- **Capability is runtime.** A wallet can run the Vault when
  `wallet_supportedWalletApi` reports 0.10.4 or later and its account exposes
  `strk20ShadowAccountCommitment`, read without running an accessor; nothing
  branches on wallet identity. A wallet that answers the commitment or the
  Vault's submission with 162 or JSON-RPC -32601 is
  `shadow-accounts-unsupported`, a new failure kind that stays in the Vault:
  it never moves the connect flow and never closes the city. A 118 is still
  `not-registered`.
- **The address comes from the anonymizer.** The wallet derives the partial
  commitment (no nonce) once per connection. The backend reads
  `get_shadow_accounts(partial, 0, 1, false)` on the pinned anonymizer
  (D-014), and the browser sends nothing to the address unless it equals the
  one the anonymizer derives from that commitment with the Primer class.
  The view is the authority; the derivation is only that cross-check, so a
  relay or node that lied could not redirect a supply, and a changed Primer
  would fail closed.
- **The position is a public read**, through the backend, of `balance_of`,
  `preview_redeem`, `max_withdraw` and `max_redeem` on the pinned vault, made
  only when the player asks. Neither read can name another contract or
  selector.
- **The seam (D-036).** `PrivacyOperations` gains `vaultPosition()`,
  `prepareVaultSupply(token, amount)` and `prepareVaultRedeem(amount |
  'all')`. A `PreparedVaultBatch` is single-attempt with a fee ceiling, and
  its `confirm` resolves `{ transactionHash, outcome }` once the wallet
  returns a hash, after a bounded receipt wait of about 70 s: `pending` is
  never a failure. `WalletCapability` gains `supportsShadowAccounts`, and
  every Vault call reports code-only stages for the probe logs. The demo fake
  runs a Vault at a fixed DEMO rate of 51 STRK per 50 shares.
- **The register (D-020).** `vault.supply` and `vault.redeem` are graded
  `anonymous`, like D-063's staking: who acted is hidden, what the chain
  shows is not. Approved by calc, 2026-09-29, with one disclosure shown at
  every commit point and no waiver: "Your Vault position sits on a stand-in
  address, not your wallet. That address, its balance and every supply and
  redeem you make through it, with their amounts, are public on-chain. Only
  its link to your wallet is hidden, and matching amounts or timing can still
  give that link away."
- **The switch.** The browser build admits the Vault only with
  `VITE_STRK20_VAULT_ENABLED=true` and `VITE_STRK20_VAULT_ALLOWED_TOKENS`
  naming canonical STRK and nothing else. Anything missing, malformed or
  disabled keeps it exactly as it was: the World's door stays locked and
  emits `building:locked`, the sign says "VAULT / COMING SOON", the steel
  door stays chained, and no room is built. The Shell tells the World once,
  as `WorldConfig.vaultOpen`. Open, the door stands open onto a Vault room in
  Vesu's palette with one counter, `vault:lending` ("SUPPLY / REDEEM"), and
  the window wears Vesu's look, with Supply and Redeem modes. There is no
  backend switch: the two reads are public, pinned, and behind the global
  kill switch. Enabling the Vault enables nothing else, and no other switch
  enables it. Demo mode opens it against the fake.
- **The connection stack moves together** to `starknet` 10.8.0,
  `@starknet-io/types-js` 0.10.4 and get-starknet discovery and
  wallet-standard 6.0.6. starknet.js 10.8 hands a dapp a starknet.js `Call`
  from `strk20PrepareInvoke`, so `BackendPrivacyClient` converts the proved
  call back to the Wallet API shape the relay and avnu take, and refuses
  anything else.
- **Probe logs (D-069).** A debug build logs `vault.capability` (supported,
  and the Wallet API reported), `vault.commitment` (ok, or the wallet's
  code), `vault.address` (resolved and deployed, never the address),
  `vault.position`, `vault.prepare`, `vault.submit` (ok, or the code),
  `vault.receipt` and the `vault.confirm` stages. Never an amount, an
  address, a balance, the commitment or a hash: each field is admitted from
  a fixed list, and a Vault failure reaches the connect flow and the
  `privacy.operation` line by its kind alone.
- **The first live use is the probe.** On the Railway test deployment, with
  the switch and debug logs on, the lead makes one small supply and one
  redeem of everything, reading the position between; the `vault.*` lines
  answer whether Ready runs shadow accounts end to end.

**Consequences.** A player's Vault position is a persistent public
pseudonym: every supply and redeem they make sits on one address, linked to
each other, and only the link to their wallet is hidden; a supply that
matches a recent public deposit in amount or timing can give it away, which
the disclosure says. A player who supplies their whole shielded balance
cannot redeem until the pool fee is back in the pool, and the counter says
to keep it there. The Vault depends on two third-party contracts outside
this project's review, StarkWare's anonymizer and Vesu's vault, both pinned
by address; D-007's audit gate does not apply because no Cairo is written
here. If the anonymizer ever deployed a new Primer, the cross-check would
refuse every Vault call until the pin moved. Contracts stays dormant
(`docs/WORKPLAN.md`). Every exhaustive record of the failure kinds had to
list the new one, and the compiler refuses any that misses it. The switch is
off in every environment file; turning it on for the probe needs a rebuild,
since `VITE_` values compile into the bundle, and nothing on the backend.
Until the probe succeeds this route is source-derived under D-028, and a
wallet that fails it keeps the Vault's counter open with the
unsupported-wallet line rather than locking the door.

---

## D-078 — A football pitch at the west end of the road

**2026-09-29 · Accepted by the user · amends D-060 (the district widens west by a second square of the sandbox's size, and the sandbox moves east with the street) · extends D-011's shared seam with `PITCH_AREA`, `STREET_ORIGIN_X`, the field, goal and ball constants and the football types · moves D-076's Privacy Plaza and D-059's street and backdrop east with the street, unchanged relative to it · adds anonymous football state, one payload-free verb and one broadcast to the lobby under invariant 2 · adds `football.*` events to D-069**

**Context.** The lead: "My ask was to add an activity on the left end of the
road in the same position as the sandbox but parallel. The sandbox is on the
end of the road on the right and the activity I want is on the end of the
road on the left … I want it to take up as much space as the sandbox."
Offered options, the lead picked "Football pitch: kick one shared ball into
two goals for quick drop-in matches." The road's west end was open, closed by
a barrier at x -0.6 with the backdrop's houses along the road beyond it, and
the Privacy Plaza (D-076) filled the street's first eleven columns south of
the road. The street grid was a zero-based array read by collision, the door
triggers, every builder and the lobby's sandbox rules; D-060's sandbox tiles
travel as `uint8`, and presence positions are clamped to ±8192 px.

**Decision.**

- **The map widens west.** A 28×28 square (`PITCH_AREA`, tiles x 0-27,
  y 0-27) takes the road's west end, mirroring the sandbox at its east end,
  with a fence one tile east of it (x 28) open at a gate in line with the road
  and both pavements (rows 11-18), as the sandbox's wall and gate are. The
  street moved east rather than the map growing a negative-x region: every
  street column is laid out from one constant, `STREET_ORIGIN_X` (29, the
  column past the fence), so the buildings, doors, signs, spawn, Studio path,
  Privacy Plaza, Exchange roof and sandbox (`SANDBOX_AREA` now x 83-110,
  `SANDBOX_ENTRANCE` x 83-85) keep their places relative to one another and
  the grid stays a zero-based array. A negative origin would have touched
  every reader of the grid and D-060's `uint8` tiles; the shift touches
  literal coordinates only, and the district is 111 tiles wide. The
  backdrop is laid out from the street too, so everything the street sees is
  where it was; the road runs on west past the square, closed by its barrier
  where the square interrupts it, lined by the houses, lamps and trees that
  lined it. Coordinate tests count from `STREET_ORIGIN_X` (the lobby's keep
  D-060's numbers as `S(n)`) rather than being loosened.
- **The pitch.** Four new tile kinds keep collision tile-based: walkable
  `turf` (the field, x 3-24, y 7-22, its long axis east-west so the
  north-facing camera sees it as a broadcast does) and `walkway` (the paving
  round it), solid `footing` under every fixture, and the solid `railing`
  fence. The field has touchlines, goal lines, a halfway line, a centre circle
  and spot, penalty and goal areas, penalty spots and arcs and corner arcs,
  mown in stripes, inside knee-low boards the ball comes back off. A white
  goal with a net stands at each end, 4 tiles between the posts and 1 deep,
  its net and posts on solid footing and its mouth open from the field; the
  gate opens onto the walkway, clear of both. A concrete stand fills the north
  side to the square's edge, seated in West's blue and East's red under a
  roof, with the scoreboard on its roof: a brand plate in the facade signs'
  machinery reading "WEST 0 – 0 EAST". Low bleachers stand either side of an
  aisle on the south side, nearest the camera; a floodlight stands in each
  corner, a green steel fence round the square, and the gate's posts carry a
  "FOOTBALL" board and fade like the sandbox gate's superstructure when they
  hide the player. It is `three/pitch-builder.ts`, in the street's merged
  bins: draw calls 75 to 81 (four meshes and two signs), and the street's
  ground from 87,837 to 103,393 triangles.
- **One ball, server-authoritative.** `@strkworld/lobby/football` holds the
  pure rules, shared by the room, the Shell's solo play and the ball the
  Shell draws. A fixed 40 ms step (25 a second) in four substeps, so the
  fastest ball moves less than a post and its own radius per substep: drag
  of 0.8 of its speed a second plus 24 px/s² of rolling resistance, so a full
  kick runs about thirteen tiles in three and a half seconds; the boards give
  back 0.7 of the speed into them, the posts 0.6 and the net 0.15. A goal is
  a ball wholly over a goal line between the posts: into the east goal it is
  West's, into the west goal East's. The room steps the ball only while
  someone on the street is on the pitch or within 15 tiles of its gate, on
  its clock just before each patch, and brings it to rest when nobody is.
- **Kicking.** `football:kick` carries nothing: the room kicks from the
  position and facing it already holds. A kick needs the kicker's centre
  within 1.3 tiles of the ball's and live play, and sends the ball at 13
  tiles a second straight away from the kicker's centre through the ball's,
  so a player aims by where they stand, all the way round, which four wire
  facings could not give; the facing is used only from on top of the ball.
  The room holds each session to one kick per 250 ms, refused kicks
  included, and the client holds itself to 300 ms and drops an early kick
  rather than holding it. Walking into the ball pushes it off the player's
  body as off a moving wall (restitution 0.4), the player's speed read from
  the times of their own moves, so a player walking into a still ball sends
  it on ahead: a dribble.
- **State and the one broadcast.** The room state gains one shared
  `football` entry: the tick the sample is from, the ball's position and
  velocity in whole 64ths of a pixel, the score and the phase (live, goal,
  full time), all whole numbers, written only when the ball, score or phase
  changed, so a still ball costs no patches. `football:goal` names the side
  that scored, at once, ahead of the patch that raises the score. A goal is
  celebrated for 2.5 s with the ball dead in the net, then play kicks off
  from the centre spot; the first side to 5 gets a 4.5 s full-time moment,
  and the score starts again from 0–0.
- **Nothing names a player.** No kick, goal or score is counted per player,
  and there are no names, statistics or leaderboard anywhere. The kick has no
  payload, the goal names a side and the state holds the ball and the
  scoreboard; `privacy.test.ts` pins the entry's fields to the frozen
  `FootballSnapshot` and scans a seeded match for leaks.
- **The client.** The World receives a `FootballChannel` through
  `WorldConfig`, as it does the sandbox's, draws the ball it hands out each
  frame, shows "E · KICK" exactly while a kick would reach it and sends the
  kick on E; it never moves the ball. The Shell's presenter places each
  snapshot in the authority's time by its tick, takes the smallest arrival
  gap it has seen as the clock offset (jitter only ever adds to it), and
  draws the latest ball carried on to the present through the same rules, at
  most 400 ms past its snapshot, easing a correction in over 90 ms; a kick
  or a touch of the local player's plays out at once for 260 or 180 ms and
  hands back smoothly. A goal shows "GOAL!" over the goal it went into with a
  small burst of confetti in both sides' colours; full time shows "FULL TIME"
  and "WEST WIN 5 – 3" over the centre spot. A player who asked for less
  motion gets the words held still and no confetti, read at each moment as
  the sandbox burst reads it.
- **Solo play** runs the same rules in the Shell on the same tick while the
  player is on or near the pitch; the tests step the lobby's registry and the
  solo controller through the same moves and kick and get the same ball, tick
  for tick.
- **The seam (D-011)** gains `TileRect`, `PITCH_AREA`, `STREET_ORIGIN_X`,
  `PITCH_FIELD`, `PITCH_GOAL`, `FOOTBALL_BALL_RADIUS`, `FOOTBALL_POST_RADIUS`,
  `FOOTBALL_KICK_RANGE`, `FOOTBALL_WIN_SCORE`, `FOOTBALL_TICK_MS`, and the
  types `FootballSide`, `FootballPhase`, `FootballSnapshot` and
  `FootballGoal`; `SANDBOX_AREA` and `SANDBOX_ENTRANCE` now derive from
  `STREET_ORIGIN_X`.
- A debug build (D-069) logs `football.kick`, `football.goal side=west` and
  `football.full-time winner=east`, each field from a fixed list, and never
  an identifier or a position.

**Consequences.** Every street coordinate moved 29 tiles east. Nothing was
persisted in the old ones, but a client and a lobby from either side of the
change disagree about where the street is, so the web and the lobby deploy
together. The ball puts a small patch on the wire about 20 times a second
while it moves and anyone is near the pitch, to every client in the room,
like the sandbox (it is not interest-filtered), and nothing while it is
still; the room steps it only then. As with the sandbox, positions are
trusted within their clamps, so a hostile client can stand wherever it says
and push or kick the ball from there: it can spoil a match, not reach money.
An observer next to the ball when it moves can guess who touched it, as they
can with a sandbox block; the lobby records nothing about it. The street
build takes about a fifth longer, the pitch and the wider backdrop together.

---

## D-079 — The Vault lends five tokens and shows each position

**2026-09-30 · Accepted by the user (the lead asked for more Vault tokens and a clearer position) · amends D-077 (the Vault lends ETH, USDC, USDT and WBTC beside STRK, its switch takes a list, and its position read covers every pinned vault and hands the shell the stand-in address) · extends D-036's frozen seam (`vaultPositions` replaces `vaultPosition`, `prepareVaultRedeem` takes a token, and `vaultRates` is added) · adds one public read to D-014's backend, Vesu's supply APY, which the backend alone fetches from Vesu · keeps D-077's register grades, disclosure and approval, whose words name no token · amended by D-081 (every Vesu market: twenty-three tokens across Prime and five curated pools, strkBTC through Re7 xBTC, collateral-only markets kept out of Supply, a map generated and re-verified by `scripts/vesu-markets.mjs`, a grouped picker, and batched reads)**

**Context.** D-077 opened the Vault for STRK alone, and its first live round
trip worked in Ready on 2026-09-29: a 2 STRK supply into Vesu's Prime vSTRK
vault and a redeem of everything, both through the canonical
`ShadowAccountAnonymizer`, and both receipts succeeded. The lead asked for more
tokens, the shield list's STRK, ETH, USDC, USDT and WBTC plus strkBTC, and
a clearer position: each token in its own units, Vesu's rate if it is
public, the earnings if they can be computed without storing amounts, a
clear way to read again, and a line saying the stand-in address is public
with an optional Voyager link. Vesu's public API (`api.vesu.xyz`, no key)
lists each Prime asset's vToken and supply APY. Read over mainnet RPC at
block 15,669,141 (2026-09-30), the ETH, USDC, USDT and WBTC vaults it names
all run vSTRK's class (`0x41b16e0c…4f78`), so every entry point the Vault
calls has vSTRK's shape; each one's `asset()` is its token and
`pool_contract()` the Prime pool (`0x0451fe48…c3b5`), and each token's
`approve` takes `(ContractAddress, u256)`. strkBTC has no Prime vault. It
has vaults of the same class only in curated pools with other collateral
and risk settings (Clearstar USDC Reactor, Re7 xBTC and Re7 USDC Prime),
with supply APYs between 0 and 0.15%. The pool's own fee, 6 STRK, is paid
in STRK to its fee collector by whoever submits. On a wallet-submitted
action the relayer (avnu's paymaster forwarder, `0x0127021a…584f`) pays it,
and the wallet adds one withdrawal from the player's shielded balance to
repay it, in a token the wallet picks (`pool_fee_token` in StarkWare's
reference wallet). Ready repaid 6 STRK on each leg of the probe. Of 216 such
fee withdrawals in the 200,000 blocks to 15,668,951, 98 were STRK, 89 USDC,
21 strkBTC and 4 ETH, mostly but not always in the token the transaction
moved. One vSTRK redeem through the anonymizer repaid in USDC. No token
other than STRK has yet gone through the anonymizer.

**Decision.**

- **The token → vault map is pinned in one place,** `VAULT_MARKETS` in
  `packages/privacy/src/vault.ts`: STRK (vSTRK), ETH (vETH `0x006ac248…043e`),
  Circle's native USDC (vUSDC `0x00387e8d…4e65`, not the bridged USDC.e's
  separate vault), USDT (vUSDT `0x06be9f89…2f9d`) and WBTC (vWBTC
  `0x04ecb066…f56c`), all in Vesu's Prime pool. The action builders take a
  market and refuse any market the map does not pin; every token builds
  D-077's shapes with its own token and vault. The backend pins its own copy
  of the vaults (`VESU_VAULTS`), and the web its own copy of the tokens
  (`VAULT_TOKENS`), each checked by a test against the map, token for token.
  **strkBTC is not pinned.** Lending it would mean choosing a curator's pool
  and its risk settings for players, which is the lead's call, not a
  configuration detail.
- **The switch takes a list,** the way D-072 widened shield's:
  `VITE_STRK20_VAULT_ALLOWED_TOKENS` is one to five canonical addresses (`0x`
  and 1 to 64 hex digits), no two with the same field value, each in
  `VAULT_TOKENS`, kept in the order given. A missing, zero, malformed,
  repeated, oversized, unpinned or partial value keeps the whole Vault
  locked, as D-007's facade, and touches no other route. The door needs no
  STRK on the list. The adapter applies the same rule to any policy it is
  handed. `deploy/RAILWAY.md` gives the test deployment all five.
- **The seam (D-036).** `vaultPositions(options?)` replaces
  `vaultPosition(options?)`. It answers one position per admitted token, in
  the list's order, and the stand-in address (`standIn`). `prepareVaultRedeem`
  takes the token first. `vaultRates(signal?)` answers Vesu's supply APY for
  each admitted token as an integer and its decimals, asking no wallet.
  `VaultPosition` keeps its shape, and its `assets` is the token's own units
  by the vault's `preview_redeem`: a vToken has 18 decimals whatever the
  token, so shares are never shown. `PreparedVaultBatch.poolFee` is the
  pool's fee in STRK whatever the action moves.
- **The position read.** The backend's route still takes only the stand-in
  address, never a vault. It answers one row per pinned vault
  (`balance_of`, and for a held position `preview_redeem`, `max_withdraw` and
  `max_redeem`, on that vault only), or `ok: false` for a vault whose read
  failed, so one vault's trouble never blocks another. The adapter takes the
  rows of the vaults it admits by address. One of those missing, repeated or
  malformed fails the read, and one the backend could not read fails it as
  unreachable. A redeem needs only its own vault's row. One commitment, one
  address read and one position read answer every token.
- **Vesu's rate.** `POST /v1/vault-rates` with `{ v: 1 }` answers each pinned
  vault's `stats.supplyApy` from Vesu's public Prime pool endpoint. The
  backend alone fetches it, so Vesu never sees a player's IP (D-014, as
  D-067 does for avnu's list). One read serves everyone for five minutes,
  single-flight, on its own five-second timeout. A failed read answers no
  rates for a minute. A rate counts only when exactly one asset names both
  the token and its pinned vault, the pool is Prime and not deprecated, and
  the value is a plain integer below 10,000%. The route logs nothing per
  request and follows the kill switch and the shared rate window. The
  counter reads it when it opens and whenever the player reads positions,
  shows it as "Supply APY 2.73%, Vesu's figure", and shows none when it
  cannot read one. There is no backend switch, as for D-077's reads.
- **The counter.** It offers the build's tokens that the Exchange catalog
  describes, in order, with a picker when there is more than one. Amounts
  are read and every figure shown in the chosen token's decimals and symbol.
  The positions are read only when the player asks ("Show my positions"),
  one row per token, and say they are one read that does not update on its
  own ("Read my positions again" reads positions and rates again). A
  submission marks them changed, as before.
- **The stand-in address is shown, and stays in memory.** Once a read has
  resolved it, a line says "Your stand-in address, 0x…, is public: anyone
  can look up what it holds." It carries an optional "View it on Voyager"
  link, which opens a new tab with no referrer and says Voyager sees the
  player's IP address. The address is never stored, logged, put in a probe
  line (D-069, unchanged) or handed to the connect flow. This relaxes
  D-077's "neither the commitment nor the address leaves this package" for
  the address alone, which is public on-chain; the commitment still never
  leaves it.
- **Fees in another token.** The pool fee is set in STRK. The wallet repays
  its relayer from the shielded balance in a token it chooses, which can be
  STRK even when the action moves USDC. So a non-STRK Vault action may need
  STRK in the private balance, and whether Ready takes it in STRK or in the
  moved token is not yet verified. While another token is chosen, the
  counter says the fee is set in STRK and to keep some STRK in the pool too,
  and the review says the wallet chooses which token pays it. The fee
  ceiling still guards the pool fee. The demo fake takes the fee in STRK,
  the conservative case.
- **No earnings figure.** An amount earned since supplying needs a cost
  basis. That means storing amounts, which the lead ruled out, or reading the
  vault's `Deposit` and `Withdraw` events for the stand-in address, which
  took 41 RPC pages and about 11 seconds for one vault from the anonymizer's
  first use. That is too heavy for each read through the shared window. A
  session-only figure would count only what accrued since the first read in
  that session, which is near zero and would read as "since you supplied".
  So there is none.
- **The register (D-020).** `vault.supply` and `vault.redeem` keep their
  grade (`anonymous`), their one disclosure and calc's approval of
  2026-09-29: neither the grade nor the disclosure names a token, as D-072
  found for shield. Their `observable` now describes any of the five tokens,
  the fee withdrawal's token, and the one address that links a player's
  positions in every token.

**Consequences.** A player who lends two tokens shows both on one public
stand-in address, so a watcher links the positions to each other, which the
disclosure already says of every supply and redeem. The Vault now depends on
five third-party vaults, and for its rate on Vesu's API, which it only
displays: a wrong or missing rate cannot move funds. The backend reads up to
twenty `starknet_call`s per position request instead of four. At most once a
minute it makes one outbound request to `api.vesu.xyz`, and only when a
request asks for the rates. A non-STRK action may fail with too little STRK in
the pool, depending on the wallet's fee token, and the first live non-STRK
supply is the check of which token Ready uses. strkBTC waits on the lead's
choice of a pool. A rebuild with the new list is needed to open the extra
tokens on the test deployment (`deploy/RAILWAY.md`).

---

## D-080 — The plaza's pool value comes from strkprice.com, not a six-token guess

**2026-09-30 · Accepted by the lead · extends D-076 (the Privacy Plaza's pool figures) · amends D-011's shared seam: `plaza:stats`'s `held` replaced with `valueUsd` and `topHoldings` · the held face's "total, then each holding" cycle and the 24-hour deposit count are superseded by D-098 · adds a backend-only external fetch to D-014's backend, which still logs nothing per request · registers no route (D-020)**

**Context.** The lead: the plaza's "held in the pool" figure was wrong. It
read `balance_of(pool)` for six pinned tokens only (`POOL_STATS_TOKENS`, the
web's Exchange catalog), in raw token amounts, with no USD total — against a
pool that actually holds about forty tokens, so the six-token figure covered
a fraction of what the pool holds. The lead's own site, strkprice.com
(`github.com/Calcutatator/strkprice`), already computes the pool's real
value: its public proxy sums Voyager's USD balance for every token the pool
holds, with a GeckoTerminal price fallback, and caches for 20 s. It needs no
key, and its CORS admits only strkprice origins, so it must be read from the
backend, never the browser. Read directly at
`https://strkprice-pool-api-production.up.railway.app/api/pool` on
2026-09-30 at 09:48 UTC: `{ t, usd, starknet_tvl, pct, tokenCount, unpriced,
tokens }`, `usd` 1,177,403.36, `tokenCount` 40 (exactly `tokens.length`;
`unpriced` is a separate list of symbols the pool holds with no resolvable
price, 12 entries that day, some repeated). Each `tokens` entry is `{
symbol, address, usd }`; addresses were well-formed felts and every `usd`
finite and non-negative, but the answer is public and unauthenticated, nested
addresses and symbols are not otherwise validated by the proxy, and a
homoglyph or overlong symbol is easy to slip in cheaply. The top ten by
value that day: xSTRK $453K, USDC $198K, SLAY $165K, STRK $107K, xstrkBTC
$59K, ETH $51K, WBTC $30K, EKUBO $28K, BROTHER $23K, strkBTC $21K —
compact-formatted, these numbers land exactly on the lead's own examples.

**Decision.**

- **The backend fetches the aggregate itself**, on the existing pool-stats
  cache's ~60 s background refresh, on its own 15 s timeout — bounded
  separately from the chain reads' timeout, so a slow aggregate cannot stall
  the accounts and deposits scans, or vice versa. `PLAZA_POOL_VALUE_URL`
  overrides the default (strkprice's proxy above); unset, empty or a
  placeholder all fall back to it; set, it must be https, following the same
  fail-closed style as every other URL here (`environment.ts`).
- **Validated strictly, in `pool-stats.ts`.** The top-level `usd` must be a
  finite number at least zero, and `tokens` must be an array, or the whole
  read fails — which, like any failed part, keeps the cache's last good
  value rather than publishing a wrong or partial total. Within `tokens`,
  one malformed entry is dropped rather than failing every other one — a
  non-finite or negative `usd`, a missing or invalid `address` (a felt,
  nonzero), or a `symbol` that cleans to nothing printable or to more than
  16 characters — since a single bad or unpriced token among forty should
  not hide the rest. Symbols are cleaned to printable ASCII (`\x20`-`\x7E`)
  only and trimmed: the read is public and unauthenticated, so a homoglyph
  or control-character symbol is treated as noise, not a display string. The
  kept holdings are sorted by value and capped to the ten highest
  (`MAX_TOP_HOLDINGS`); `tokenCount` is taken as a plain count, and
  `unpriced` is read no further than confirming it is an array — its symbol
  strings are exactly the kind this project does not expose raw.
- **The response gains `valueUsd`, `topHoldings` (`{ symbol, usd }`, highest
  first), `valueAsOf` (an ISO timestamp of the backend's own last successful
  refresh, not the proxy's) and `tokenCount`, each null until the fetch has
  succeeded once.** `held` (raw `balance_of` per pinned token) is dropped:
  once the total and top holdings covered what the pool holds, nothing on
  the web still needed the six-token figure, so it goes with its on-chain
  scan — `POOL_STATS_TOKENS`, `refreshHeld`, `getPoolBalance` and the
  `PoolStatsRpcPort` entry that carried it are gone. `BALANCE_OF_SELECTOR`
  stays: the Vault's shares read (D-077) still calls it, now pinned in
  `vault.test.ts` instead of here. This also removes nine `starknet_call`s a
  minute against the configured RPC while the plaza is watched; the accounts
  and deposits24h scans are unchanged.
- **The shared seam (D-011).** `plaza:stats` drops `held` (one line per
  pinned token) for `valueUsd` (compact, e.g. "$1.18M") and `topHoldings`
  (compact "SYMBOL · $usd" lines, e.g. "xSTRK · $453K"), pre-formatted like
  every other Shell-to-World figure; `PlazaStatsPresentation` in
  `packages/world` mirrors the rename.
- **The monument's held face** keeps its "HELD IN THE POOL" caption and its
  existing cycling mechanism unchanged; only what it cycles through changes:
  the USD total leads, then each top holding takes a turn, then back to the
  total. The other two faces (accounts, deposits in the last 24 hours) are
  untouched.
- **The window** shows the total compact, with the exact figure on hover
  (e.g. "$1,177,415"), lists the top holdings compact (e.g. "xSTRK $453K"),
  and adds one line on where the figures come from: "Values from Voyager via
  strkprice.com, updated every minute." Unavailable still shows the existing
  "…" and failure copy. Demo mode shows sample figures in the same shape,
  labelled as demo like everything else here, and a production build still
  refuses them.
- **No key, no user data, backend-only, no new route.** The proxy is public
  and unauthenticated; only the backend calls it, never the browser; nothing
  about a player reaches it or comes back from it. This extends the existing
  public-aggregate route rather than adding a privacy-graded one, so it
  registers nothing in D-020's register.

**Consequences.** The plaza's figure now matches strkprice.com instead of a
six-token reading that covered a fraction of the pool. The value figure now
depends on a third party outside this project's review; a wrong, slow or
unreachable answer shows the plaza's last good figure and then "…", never a
stale number frozen forever, bounded by the same serve-last-good behaviour
as every other part here. If strkprice's proxy ever moves, or the lead
points this at a different aggregate, `PLAZA_POOL_VALUE_URL` is the one
value to change. A legitimate symbol longer than 16 characters (they exist —
wrapped and vault-share tokens run long) is dropped from the top holdings,
same as a hostile one; it is never shown badly, only left out.

---

## D-081 — The Vault lends in every Vesu market the pool can hold

**2026-09-30 · Accepted by the user (the lead asked for every Vesu market whose token can reach it privately, strkBTC included; collateral-only markets stay out of Supply until borrowing ships) · amends D-079 (twenty-three tokens across Vesu's Prime pool and five curated pools, a generated and re-verified map, a switch of up to twenty-three, a batched position read and a rate read per pinned pool) · amends D-077 (a market may lend through a curated pool, and `prepareVaultSupply` refuses a collateral-only one) · `VaultMarket` gains its pool, the pool's name, whether it is Prime or curated, and whether the pool lends the token out; no seam signature changes (D-036) · keeps D-077's register grades, disclosure and approval, whose words name no token or pool · amended by D-089 (the supply field shows the pool balance once the player asks for it, so a read figure now stays in the window; a supply review's "none there" read is unchanged)**

**Context.** D-079 opened five Prime markets and left strkBTC out, because
lending it meant choosing a curated pool for players. The lead answered on
2026-09-30: "Doesn't Vesu allow lending/borrowing of many assets? We should
cover any that can use privacy to get there", and, of strkBTC, "If the shadow
accounts allow us to submit assets publicly whilst maintaining our privacy,
then we should include it." Vesu's glossary calls each asset of a pool a
lending market. Its API (`GET /pools`) listed 36 pools: 16 deprecated V1
pools, 10 V2 pools Vesu does not verify, and 10 live V2 pools it does,
holding 23 distinct assets. Read over mainnet RPC on 2026-09-30 (blocks
15,678,829 to 15,681,808), every one of the 57 vTokens in those 10 pools runs
vSTRK's class, which is also the official PoolFactory's
`v_token_class_hash()`; the PoolFactory (`0x03760f90…88c0`, from Vesu's
contract-addresses page) maps each pool and asset to its vToken and back;
each pool's `pool_name()` matches Vesu's name, and none is paused. The STRK20
pool has no token list (its ABI has no such entry point) and holds amounts as
`u128`, so any ordinary ERC-20 can sit in a private balance. Every one of the
23 is one by its ABI, with `approve(ContractAddress, u256) -> bool`; sixteen
have been credited to a pool note already, and seven (sUSN, mRe7YIELD,
uniBTC, YBTC.B, mRe7BTC, xLBTC, xsBTC) not yet. Prime lists nine of the 23.
strkBTC is lent in two curated pools: Re7 xBTC (against xtBTC, xstrkBTC and
xWBTC at 91.5% LTV, supply APY 0.0006%, 1.99 strkBTC supplied) and Clearstar
USDC Reactor (against xstrkBTC alone at 94% LTV, 0.15%, 4.09 strkBTC), and
held as collateral only in Re7 USDC Prime. Twelve of the 23 are collateral
only in the pool the policy picks: no pair there lends them out, so a supply
earns nothing.

**Decision.**

- **Every Vesu market.** The Vault pins one vault for each asset of a live,
  verified Vesu V2 pool whose token is an ordinary ERC-20 that passes the
  on-chain checks: all twenty-three. Nine lend through Prime (STRK, ETH,
  USDC, USDT, USDC.e, WBTC, xSTRK, wstETH, xWBTC); nine through Re7 xBTC
  (strkBTC, tBTC, SolvBTC, mRe7BTC, xstrkBTC, xtBTC, LBTC, xLBTC, xsBTC); sUSN
  and mRe7YIELD through Re7 USDC Stable Core; uniBTC through Re7 USDC Core;
  YBTC.B through Re7 USDC Frontier; and EKUBO through Re7 Labs Starknet
  Ecosystem. D-079's five keep their vaults. No market waits on someone having
  shielded its token first.
- **One vault per token, by policy.** Prime's vault whenever Prime lists the
  token. Otherwise Re7 xBTC's when it lists the token: the lead named it for
  strkBTC, and it is Vesu's BTC pool, where every pair lends a BTC token
  against BTC collateral, so every BTC token it lists that Prime lacks goes
  there and shares one curator's risk settings. Otherwise the only pool that
  lists the token; otherwise a choice recorded with its reason (sUSN goes to
  Re7 USDC Stable Core, not Clearstar USDC Reactor: both hold it as collateral
  only, and Stable Core lends only stablecoins against stable collateral).
  Every pool a market may name is approved by address in the policy. strkBTC
  stays with Re7 xBTC: Clearstar pays more today and holds twice as much, but
  both lend strkBTC only against BTC staking tokens, so neither is clearly
  better-suited, and the lead's pool stands.
- **Collateral only, and how it is known.** A market is `lendable` when three
  sources agree that its pool lends the token out: Vesu's `stats.canBeBorrowed`
  for the asset, the pool's `pairs` naming it as the debt asset of at least one
  pair, and the pool contract's `pair_config(collateral, token)` answering a
  `max_ltv` above zero for such a pair. It is collateral only when all three
  say no, the contract for every other asset the pool lists. A disagreement
  skips the market. Eleven are lendable (STRK, ETH, USDC, USDT, USDC.e, WBTC,
  strkBTC, tBTC, SolvBTC, wstETH, LBTC) and twelve collateral only (sUSN,
  mRe7YIELD, uniBTC, YBTC.B, mRe7BTC, xSTRK, xWBTC, xstrkBTC, xtBTC, xLBTC,
  xsBTC, EKUBO). A collateral-only market stays pinned, since borrowing will
  need it, but Supply does not offer it until borrowing ships, and
  `prepareVaultSupply` refuses it before the wallet is asked. A position
  already in one is listed, once a read finds it, and redeems as any other.
  wstETH and LBTC pay 0% today yet count as lendable: pairs lend them out
  (LBTC's cap borrowing at 100 base units each), and nobody is borrowing now.
- **Pinned, generated and re-verified.** `scripts/vesu-markets.mjs` derives
  the list from Vesu's API and checks every entry on mainnet: the vault's
  class (vSTRK's, or an ABI with every entry point the builders call, in
  their shapes), its `asset()` and `pool_contract()`, the PoolFactory's
  mapping both ways, the pool's `pool_name()` and `is_paused()`, the token's
  ERC-20 entry points, `decimals()` and `symbol()`, and `lendable`. It writes
  `scripts/vesu-markets.json` and the three copies from it (the privacy
  package's `VESU_MARKET_ROWS` behind `VAULT_MARKETS`, the backend's
  `VESU_VAULT_ROWS` behind `VESU_VAULTS`, and the web's
  `VAULT_MARKET_METADATA` behind `VAULT_TOKENS`); `vesu-markets.test.mjs`
  pins the list entry by entry and fails if any copy differs from what the
  script renders. Run without `--write` (about 20 s), it fails on any drift,
  a pool starting or stopping lending a token included. The API only
  proposes: a new asset stays unplaced, a pool the policy does not approve by
  address is never chosen, and a failed check skips the token by name, so a
  compromised API can fail a run or propose a diff but never move a pinned
  vault. USDC.e shows as Vesu names it, since its contract's `symbol()` is
  USDC. Nothing reads Vesu at run time except the display-only rates.
- **The market model.** A market is one token in one Vesu pool: `VaultMarket`
  carries the pool, its name, whether it is Prime or curated, and whether the
  pool lends the token out, so a borrow can name the same pool and token, and
  borrowing can reuse the map, collateral-only markets included.
- **The switch.** `VITE_STRK20_VAULT_ALLOWED_TOKENS` takes one to twenty-three
  pinned tokens, as D-079's rules, fail-closed; a collateral-only token on it
  is admitted and simply never offered for supply. No list may ever pass 48
  (`MAX_VAULT_MARKETS`), and the adapter reads no more rows than that.
  `deploy/RAILWAY.md` gives the test deployment all twenty-three.
- **The counter.** A picker grouped Majors, Stables, Bitcoin, Staking tokens
  and Ecosystem, and the market list grouped the same way, each row naming
  its pool ("Prime", or "Re7 xBTC, curated") beside Vesu's supply APY and the
  position once read, with one line: "Curated pools are run by their own
  curators, with their own risk settings." Supply offers the lendable markets
  alone; Redeem adds any collateral-only market the visit's last read found a
  position in, and the list shows the same, a collateral-only row saying
  "Collateral only: Vesu lends none of it out here, so it earns nothing, and
  it is not offered for supply. You can still redeem it." A group with nothing
  to show is left out. The chosen market's pool shows under the picker. A rate
  above zero and below 0.01% reads "<0.01%". The per-token positions, the
  stand-in address line and the fee-in-STRK note stay as D-079 made them.
  Token symbols and decimals come from the generated metadata, read on-chain
  at generation, not the Exchange catalog.
- **A supply needs the token in the pool balance.** Reviewing a supply first
  reads that one token's pool balance; the wallet may ask, since the player
  started it. With none there, the counter says "You have no strkBTC in your
  pool balance, so there is nothing to supply. Shield some first, or choose
  another token." and asks the wallet nothing more. A read that cannot be
  made blocks nothing, since the wallet still checks the funds, and a declined
  one stops quietly. Reading positions and rates never depends on it.
- **Bounded reads.** The position read is one JSON-RPC batch of `balance_of`
  for every pinned vault, then the preview and both limits for the vaults that
  hold shares, at most 50 calls a batch: two requests to the node while up to
  sixteen vaults hold shares, three with all twenty-three, four at most for
  48. Each call is answered by id, so a failed or malformed one makes its
  vault `ok: false` and nothing else. A node that refuses batches is read one
  call at a time, four at once; one that is down or rate-limiting reads every
  vault as unread, and is not retried call by call. Reading only the tokens
  the player picks or holds was not taken: the first needs the request to name
  vaults, which D-077 ruled out, and the second needs this same sweep first.
  The rate read asks Vesu's endpoint for each pinned pool (six today) at once,
  on one five-second timeout. A pool whose read fails answers no rates for its
  own vaults only, and a refresh with a failure is kept only for the
  one-minute retry window.
- **The register (D-020).** `vault.supply` and `vault.redeem` keep their
  grade, their one disclosure and calc's approval of 2026-09-29. Their
  `observable` no longer lists tokens: it says the pinned Vesu vault for the
  token, in the Prime pool or a curated pool, and that every Vault action in
  any token and any pool uses the one stand-in address.

**Consequences.** The Vault depends on twenty-three third-party vaults in six
pools, and on the risk settings of the one curator that runs all five curated
pools (the same `curator()` on each), besides Vesu's own. A share can lose
value: Vesu's 4 September 2026 oracle fault liquidated positions in seven
pools and wrote their lenders' shares down, 95% of it since recovered (Vesu's
post of 13 September). The seven tokens never yet in the pool are all
collateral only, so none is offered for supply; once one is, its first player
must shield it first, and whether deposit screening passes an unfamiliar
token is untested. Supply offers eleven markets; the other twelve wait for
borrowing, which will supply collateral to the pool directly rather than
through their vTokens. A supply
review adds one balance read, which a wallet may confirm with the player
first. A position read costs at most three requests to the node where D-079
sent up to twenty, and a rate refresh six to `api.vesu.xyz`. A refund a
curator sends to a stand-in address would sit there publicly: the Vault
collects only what its own calls gain, and has no sweep. The first supply
through a curated pool, strkBTC in Re7 xBTC, is the next live probe
(`deploy/RAILWAY.md`). Rerun `node scripts/vesu-markets.mjs` after Vesu lists
an asset or a pool changes what it lends; until the list is regenerated with
`--write`, the run fails.

---

## D-082 — The wallet submits unshield, send and stake; only swap is relayed

**2026-10-01 · Accepted by the user · supersedes D-070 in part (the key is no longer needed for unshield, transfer or stake) · supersedes D-068 in part (those routes no longer reach the relay) · narrows D-066 and D-063 (their relayed routes, bar swap, are wallet-submitted) · changes no D-024 disclosure and no D-036 seam type · superseded in part by D-084 (the swap is wallet-submitted too, through its own shadow account)**

**Context.** The lead wants every player flow gasless with no avnu API key.
Until now unshield, send and stake were proved by the wallet
(`wallet_strk20PrepareInvoke`) and submitted by STRKWORLD's backend relay
through avnu's paymaster in `sponsored_private` mode, which avnu refuses
without a Portal key (D-070, code 163). Shield (D-056) and the Vault
(D-077, D-079) were already proved **and submitted by the wallet**
(`wallet_strk20InvokeTransaction`), with no key, no relay and no relay fee,
and the Vault's supply carries a pool `withdraw` leg, so a wallet-submitted
transaction can spend from the pool. The Wallet API corpus
(`strk20-by-example.org/llms-full.txt`) lists shield, private transfer,
withdraw, shadow accounts and swap as wallet actions, `STRK20_ACTION` has
five variants (`deposit`, `withdraw`, `transfer`, `invoke`,
`shadow_account_invoke`), and its anonymizer example submits a
transfer-OPEN plus `invoke` through `strk20InvokeTransaction`. So every
action shape these routes use is admitted there.

**The sender question.** With the relay the on-chain sender was avnu's
relayer, never the player. Wallet submission leaves the sender to the
wallet. Read over mainnet RPC (`api.cartridge.gg/x/starknet/mainnet`) on
2026-09-30, the two pool transactions in which the canonical anonymizer
emitted `ExternalContractInvoked` at the time of the lead's Vault probe,
2026-09-29 21:37 to 21:38 UTC, were both sent by avnu relayer accounts, not
the player:

- `0x332aa46565a112430be5ef7e5ad977ebc85c50dea083d822225dae842571e8a`
  (block 15,646,840, the vSTRK supply), `sender_address`
  `0x056a084ebadde03908e0649dbe2eeed03d4a367bfa5f68a55f305849c87203c7`;
- `0x057733184bdd5cedb674b9299eb67ece963178de52f02c8aa5cfdc946d74f18`
  (block 15,646,877, the redeem), `sender_address`
  `0x071bff06fcea361f72b21a9abc081581bb78d7282e549b2db92bfa098f2adc0d`.

Both senders run one account class (`0x1a736d6e…2003`) and have sent about
304,000 transactions each, so they are shared relayers, not a player's
account. Each transaction's outer calls are the relayer's STRK `transfer`
to avnu's paymaster forwarder (`0x0127021a…584f`) and the forwarder's
execute of the pool call; the pool then withdraws 6 STRK from the player's
notes back to that forwarder, which pays 6 STRK on to `0x056be89c…d589`,
and the relayer pays the network fee (4.31 and 4.65 STRK) to the sequencer
address. `0x056be89c…d589` takes the same 6 STRK from the forwarder in
unrelated accounts' pool transactions of the same day, so it is avnu's, not
the player's. No other address in either transaction's calldata or STRK
transfers is an account: the rest are the pool, its fee collector, the
anonymizer, the forwarder, vSTRK, Vesu's Prime pool, STRK and the shadow
account. Ready's own submission is therefore an avnu gasless relay, and
hides the player as sender exactly as STRKWORLD's relay did. Not every
wallet does this: in the same window some pool transactions were sent by
low-nonce accounts of another class (`0x014aa582…f0aa`, nonce 8), which
reads as a wallet submitting from the user's own account.

**Decision.**

- **Unshield, transfer and stake are proved and submitted by the wallet**
  through `wallet_strk20InvokeTransaction`, like shield and the Vault. Their
  actions carry no relay-fee `withdraw` leg: an unshield is one `withdraw`,
  a send one `transfer`, a stake the D-063 withdraw to Endur's anonymizer,
  an OPEN xSTRK note and the `invoke`. The wallet adds and prices its own
  network fee, so a prepared batch's `gasEstimate` is `0` and its
  `totalCost` the pool fee, as for the Vault. The pool fee is still re-read
  at confirmation and held to the caller's ceiling before the wallet is
  asked. A transfer's 118 is still the recipient's (D-074).
- **One submission path.** `packages/privacy/src/wallet-api/wallet-submission.ts`
  holds the frozen-actions copy, the wallet call and its hash check, and the
  bounded receipt wait that the Vault already used. The Vault and the pool
  spends share it; nothing is copied.
- **Progress and copy.** The stages stay `awaiting-approval`, `proving`,
  `submitting`, `done`, and the Shell's copy for them is unchanged.
  `submitting` is reported once the wallet has answered with a hash, so a
  discard or an abort at that point cannot turn a sent transaction into a
  failure. The connect card no longer says proofs pass through the relay,
  and `relay-not-configured` now reads "Swaps need the private relay, which
  isn't set up on this site yet. Nothing was sent." The register's transfer
  `observable` names the wallet's fee leg instead of a relay fee. No D-024
  disclosure changes.
- **Swap stays relayed.** Its executor plan and its fee come together from
  avnu's paymaster (`buildPrivateSwapFee`, which needs the key), the pinned
  SDK's `buildStrk20Actions` always emits that fee leg, and the backend binds
  the quote's executor, calls and expiry to the fee authorization and checks
  the expiry again at submission. Moving it would mean a new keyless
  quote endpoint and our own action builder, for a route the browser never
  enables. Without a key the backend answers its preparation 503
  `RELAY_NOT_CONFIGURED`, which the client maps to `relay-not-configured`,
  never a 502.
- **The backend relay stays** in place and tested. The browser no longer
  calls `/v1/private/fees` or `/v1/private/submissions` for unshield,
  transfer or stake. `AVNU_PAYMASTER_API_KEY` is optional and needed by no
  player flow this build enables. The relay's startup line still names its
  own refused endpoints. The `VITE_STRK20_*_MAX_RELAY_FEE` values are still
  required, so existing environments keep parsing, but they gate no quote
  except a swap's.

**Consequences.** A deployment with no avnu key runs every enabled flow.
Who appears as sender is now the wallet's choice, not STRKWORLD's: Ready
relays through avnu's gasless paymaster, as above, but a wallet that
submitted from the player's own account would name the player on every
spend. Shield and the Vault already accepted that; Xverse is unverified.
The pool fee and the wallet's network fee come from the player's shielded
balance in a token the wallet picks (D-079's finding), and the review no
longer states a network figure for a spend: the wallet's prompt does. Batch
rules the relay used to enforce, one recipient per send (D-065) and one
withdrawal per unshield, are kept in the accumulator. The first live
unshield, send and stake through the wallet are the evidence for these
routes on Ready.

---

## D-083 — Borrowing on Vesu from a second shadow account, at its own counter in the Vault

**2026-10-01 · Accepted by the user (the product owner's decisions: its own shadow account, a second counter in the Vault's room, Prime only in five tokens, four flows each one wallet-submitted private transaction, a health display, a build switch off by default) · extends D-077 (the canonical shadow-account anonymizer, to Vesu's pool contract itself) · extends D-036's frozen seam by three methods and their shapes · adds one register route (`vault.borrow`) with its own disclosure, and changes no D-024 string · builds on D-081 (the pinned Prime markets) and D-082 (wallet submission) · amended by D-088 (Menu Mode now offers the BORROW window too, behind the same gate) · amended by D-089 (Max replaces the "repay everything" and "withdraw all" checkboxes; Max borrows to a health of 1.25, above this entry's 1.05 floor, which stands) · amended by D-102 (the loans and pool balances are read when the counter opens) · amended by D-103 (BORROW borrows and adds collateral; REPAY repays and withdraws it)**

**Context.** The Vault lends through Vesu's vTokens from the player's shadow
account (D-077, D-079, D-081); borrowing was the open half. The research
pass (2026-09-30, not committed) read Vesu V2's sources (`vesuxyz/vesu-v2`
`src/pool.cairo`, `src/common.cairo`, `src/data_model.cairo`) against the
deployed Prime pool class: one entry point, `modify_position(ModifyPositionParams)`,
moves collateral and debt together; `assert_ownership` passes when the
caller is the position's `user`, so a shadow account calling for itself
needs no delegation; risk-raising changes must stay collateralised
(`collateral_value × max_ltv ≥ debt_value × SCALE`) and under the asset's
`max_utilization`; every change needs both oracle prices valid, a nonzero
debt above the debt asset's floor and, with debt, collateral above its
floor; new debt must fit the pair's `debt_cap`; and anyone may liquidate an
undercollateralised position. On 2026-10-01 (block 15,725,569) all twenty
ordered pairs among STRK, ETH, USDC, USDT and WBTC in Prime read a max LTV
of 0.68 to 0.93, a 0.90 or 0.95 liquidation factor and a nonzero debt cap;
every one of the five reads a $10 floor, a 0.95 utilization ceiling and a
valid price.

**Decision.**

- **Its own shadow account.** `dapp_name` `strkworld-borrow`, nonce 0, fixed
  for good (`BORROW_DAPP_NAME`). The address resolves exactly as the Vault's
  does, through a resolver both now share
  (`packages/privacy/src/wallet-api/shadow-account.ts`): the wallet's
  partial commitment for that name, the anonymizer's `get_shadow_accounts`
  through the backend's existing `/v1/rpc/shadow-account` route (nonce 0),
  cross-checked against the address derived here; a mismatch fails closed.
  Supply and loans are therefore on different public addresses.
- **Scope v1.** Vesu Prime only, STRK, ETH, USDC, USDT and WBTC as collateral
  or debt (`BORROW_TOKENS`, each the Vault's own pinned Prime market). The
  pair settings are read live, never pinned. A pair whose max LTV or debt
  cap reads zero is not offered: Vesu reads a zero cap as uncapped, so this
  is the conservative reading of the product owner's rule and can only hide
  a pair. A loan already in such a pair still shows, measured by its own max
  LTV, and can be repaid or topped up.
- **Four flows, each one private transaction the wallet proves and submits**
  (`wallet_strk20InvokeTransaction`, D-082), no relay, no avnu key, one pool
  fee (`packages/privacy/src/borrow.ts`):
  - *open or borrow more*: withdraw the collateral (if any) to the account,
    an OPEN note of the debt token, then `approve` the pool and one
    `modify_position` adding both, collecting `diff`;
  - *add collateral*: withdraw, `approve`, `modify_position` with the debt
    untouched (`Native` 0), collecting `exact 0`;
  - *repay part*: withdraw exactly the amount, `approve`, a negative
    `Assets` debt, collecting `exact 0`; *repay all*: withdraw the debt read
    at prepare plus 0.1 % and two base units, `approve` that, repay the
    whole nominal debt in `Native` so Vesu fixes the figure when it runs,
    and one OPEN note of the debt token collecting `all`: the unused buffer.
    `diff` cannot say it, because the buffer reaches the account before the
    invoke and the invoke only loses that token; the borrow account holds no
    balance of it that is not the player's own;
  - *withdraw collateral*: an OPEN note of the collateral token and a
    negative `Assets` collateral, or every collateral share in `Native` once
    no debt remains, collecting `diff`.
- **Refused before the wallet is asked.** `prepareBorrow` reads the market
  and the position fresh and runs `assessBorrow`, Vesu's own rules in
  bigints, conservatively (a base unit more debt on a borrow, one less
  collateral on a withdrawal): a stale price, a pair not offered for new
  debt, a result above the max LTV, a debt or collateral at or under the
  floor, the debt cap, the utilization ceiling, a partial repay of the whole
  debt, more collateral than held, all of it while debt remains. A refusal
  is a `BorrowRefusedError` (kind `unknown`, with an own `refusal` code), and
  the counter says which rule in its own words without reporting a failure.
  Actions that add risk (borrowing more, withdrawing collateral while owing)
  must also leave a health of at least 1.05 (`BORROW_MIN_HEALTH_AFTER`):
  prices move while the wallet proves and sends, so a loan sent at about 1
  could land liquidatable. Repaying and adding collateral are never held to
  it. A loan in a pair Vesu stopped offering is assessed by that pair's own
  max LTV, read live.
- **A review lives two minutes** (`BORROW_REVIEW_TTL_MS`). Past it, confirm
  refuses with `review-expired` before the fee check or the wallet, and the
  counter offers a fresh review: interest may have outgrown a repay-all's
  buffer, or prices moved under a borrow.
- **Health in the browser, from public reads.** Each loan carries Vesu's
  LTV, max LTV, a health factor (`collateral_value × max_ltv / debt_value`),
  the collateral price at which it turns liquidatable if the debt token
  holds its price, and a band: safe, warning below 1.15, liquidatable below
  1, none with no debt, and no figure at all with a stale price. Each
  prepared batch carries the health after the action. The backend reads
  Vesu's `price`, `asset_config`, `pair_config`, `pairs` and `position`
  through two new pinned routes, `/v1/rpc/borrow-market` (a version only)
  and `/v1/rpc/borrow-position` (the stand-in address only), and logs
  nothing per request. The shadow-to-wallet link never reaches the backend
  or the lobby (D-024's sense: the lobby never sees money).
- **The seam (D-036).** `PrivacyOperations` gains `borrowMarket`,
  `borrowPositions` and `prepareBorrow`, with `BorrowAsset`, `BorrowPair`,
  `BorrowMarket`, `BorrowPosition`, `BorrowPositions`, `BorrowRequest`,
  `BorrowAction`, `BorrowHealth` and `PreparedBorrowBatch` (the Vault's
  confirm contract). The session wrapper owns a borrow batch as it owns a
  Vault batch, and checks its action and health.
- **The counter.** `vault:borrow`, labelled BORROW, at tile (14, 3) in the
  Vault's room beside SUPPLY / REDEEM, which is unchanged; its own station
  because its route has its own disclosure (D-030). Dressed in the Vault's
  Vesu look (`VESU_BORROW_STATION_THEME`): a loan card with two token fields,
  a segmented health bar in Vesu's blues and the primary button, no figure.
  The room draws 31 calls by its test's count (23 before), under its 40.
  Its window (`apps/web/src/panels/borrow/`) previews the disclosure while
  composing, explains liquidation in three plain lines, and needs the
  player's request before reading loans, as the Vault does. Menu Mode keeps
  the Vault's one window; borrowing is Game Mode only for now.
- **The register.** `vault.borrow`, `anonymous`, approved by calc on
  2026-10-01 under this decision: "Your loans sit on a second stand-in
  address, not your wallet and not your Vault one. That address, its
  collateral, its debt and every change you make, with their amounts, are
  public on-chain, and like any Vesu loan anyone can liquidate it if its
  collateral loses too much value. Only its link to your wallet is hidden,
  and matching amounts or timing can still give that link away." The
  wording follows the product owner's direction; the lead should read it
  before the switch goes on anywhere players are.
- **The switch.** `VITE_STRK20_BORROW_ENABLED=true` adds the `borrow` policy
  route over the five pinned tokens; anything else keeps the counter locked,
  and it enables nothing else. The counter is reached only through the
  Vault's door, which still follows the Vault's two routes. Off in
  `.env.production.example`; the Railway probe is in `deploy/RAILWAY.md`.

**Consequences.** A player can borrow against private funds with the loan
on a public, liquidatable address whose link to the wallet is hidden; amounts
and timing around it can still correlate. A flash loan cannot run through a
shadow account (it has no callback), so no leverage helper follows from
this. A stale Vesu feed freezes every change to a loan, repaying included,
and the counter says so. **No borrow through a shadow account has been made
on mainnet**: D-077's probe exercised vTokens only, never the pool
contract, so the first live borrow on the Railway probe is the evidence for
this route, and a revert there (for example the pool refusing the account as
caller) stops it until a new decision.

---

## D-084 — The swap runs on its own shadow account, quoted by avnu's keyless API

**2026-10-01 · Accepted by the user (the lead asked for private swaps at the Exchange and the degen floor with no avnu API key and no STRKWORLD relay) · supersedes D-023 (server-planned, relayed, quote-bound swaps) · supersedes D-082 in part (the swap is wallet-submitted too) · supersedes D-070 in part (no player flow needs the key) · amends D-067 (its admission guards the quote proxy) · keeps D-042's protected-minimum formula and D-024's swap disclosure · extends D-036's seam: `SwapReview.priceCheck`, the optional `acknowledgeUncheckedPrice` on `PreparedBatch.confirm`, and an optional `degen` on `WalletRoutePolicy.swap` · adds one public route to D-014's backend, which still logs nothing per request · D-083 is the borrowing route, which shares the shadow-account resolver · its build-fixed slippage amended by D-090 (the player chooses, up to the build's figure)**

**Context.** D-082 left the swap the only relayed route: avnu's private-swap
plan and its fee came together from avnu's paymaster, which refuses
`sponsored_private` without a Portal key, so without one a swap answered
`RELAY_NOT_CONFIGURED`. The lead wants every flow keyless. Read on
2026-10-01:

- avnu's public swap API needs no key. `GET
  https://starknet.api.avnu.fi/swap/v3/quotes` (v1 and v2 answer too; the
  pinned SDK 4.2.0 calls v3) answered 200 for STRK→USDC with
  `takerAddress` set, `expiry: null`; `POST /swap/v3/build` with that
  quote id, the taker, a slippage and `includeApprove: false` answered 200
  with exactly one call, `multi_route_swap` on
  `0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f`,
  the taker as beneficiary. An unknown quote id is a 400. No key header was
  sent on any request.
- That exchange, read over `https://api.cartridge.gg/x/starknet/mainnet` at
  block 15,726,513, runs class
  `0x2ce861096e127f07859a9377472eb4855853b544422d1860e449dcb2ea7d236`, whose
  ABI declares `multi_route_swap(sell_token_address, sell_token_amount:
  u256, buy_token_address, buy_token_amount: u256, buy_token_min_amount:
  u256, beneficiary, integrator_fee_amount_bps: u128,
  integrator_fee_recipient, routes: Array<Route>)` and no account entry
  point. Its source (avnu-labs/avnu-contracts-v2, `exchange.cairo`) checks
  only that the beneficiary is the caller, pulls exactly the sell amount
  with `transferFrom`, reverts below the floor, and asserts no residual
  token is left in the exchange; its one callback, `locked`, is for its own
  adapters and checks they are the caller. Nothing asks the caller for a
  signature. avnu's own `PrivacySwapHelper` (class `0x3ff37c9d…cee`, ABI
  `privacy_invoke` only, no account entry points) swapped through it as
  taker and beneficiary in `0x5d3af396…dd67` (block 15,724,143,
  SUCCEEDED). The shadow account class (`0x70e76435…78f`) exposes
  `execute`, `initialize`, `owner` and `upgrade`. So a keyless shadow
  account can call it. The exchange is upgradeable by its owner
  (`upgrade_class`).
- The anonymizer's source (starkware-libs/starknet-privacy,
  `shadow_account_anonymizer.cairo`) snapshots each `Diff` note's balance
  after the pool's withdraw and before the calls, applies one collect policy
  to every open note, and asserts every note collects more than zero
  (`ZERO_BALANCE`) and no `Diff` note goes negative (`NEGATIVE_DIFF`).

**Decision.**

- **The route.** A swap runs through the player's shadow account for
  `dapp_name` `strkworld-swap`, nonce 0, through the canonical anonymizer
  (D-018's fourth route, D-077). Its own name, never the Vault's or the Borrow
  counter's, so swaps, Vault positions and loans are not linked on-chain; fixed for good, as it is part
  of every player's swap stand-in address. The address is resolved exactly as
  the Vault's and the Borrow counter's, through the one shared resolver
  (`wallet-api/shadow-account.ts`, D-083), with its own dapp name.
- **The actions** (`packages/privacy/src/swap.ts`): withdraw the sell amount
  to the stand-in; one `OPEN` note of the bought token for the player; one
  `shadow_account_invoke` that approves the exchange for exactly the sell
  amount and calls `multi_route_swap` with the stand-in as beneficiary, no
  integrator fee and STRKWORLD's floor, collecting `diff`. The head of the
  calldata is built here from owned values; only avnu's route encoding comes
  from the quote. No second note is opened for the sell token: the anonymizer
  would refuse it when the swap spends everything (`ZERO_BALANCE`) and a
  `diff` on it would go negative. None is needed: the exchange pulls exactly
  the approved amount or reverts, and a reverted swap reverts the withdraw.
- **The quote.** avnu's public `/swap/v3/quotes` and `/swap/v3/build` (no
  key, no integrator fee, no approve), for the stand-in as taker, fetched by
  the backend's thin proxy, `POST /v1/swap/quote`, so avnu never sees the
  player's IP next to the stand-in and the amounts. The proxy admits the swap
  route's tokens (its allowlist or, while on, the degen list, D-067) and a
  slippage up to the route ceiling, checks the shape and the pinned exchange,
  keeps its own aggregate window of 60 quotes a minute, spent only once a
  request is admitted, besides a slot in the shared one, and a bucket per
  client before that (10 at once, one more every 6 s), so no one client can
  spend the window for everyone. The client key is an HMAC of the client's
  address under a salt drawn at process start and never written: the public
  edge computes it from the address Railway's proxy appends to
  `X-Forwarded-For` and sends it on loopback as `x-strkworld-client` (the
  backend trusts that header from a loopback peer only, and otherwise keys
  the peer itself). Buckets are in memory, at most 10,000, least recently
  used dropped, idle ones swept. It logs and keeps nothing else, and reads
  avnu's answers as a stream, cancelled past 256 KB. The browser owns every field again
  (`ownSwapQuote`): mainnet, its tokens and amount, one call, the pinned
  exchange and entry point, its stand-in as beneficiary, no integrator fee,
  a nonempty route starting at the sell token, an output a pool note holds.
- **The independent price check.** A floor computed from avnu's own
  expected output cannot catch a lying quote: a compromised avnu answer,
  proxy or `AVNU_BASE_URL` could route through a pool at a fraction of fair
  value and pass it. So before the review the expected output is held against
  Pragma's on-chain spot price (oracle
  `0x02a85bd6…875b`, `get_data_median(SpotEntry(pair))`), read by the browser
  over the wallet's own RPC (`VITE_STARKNET_RPC_URL`), never through
  STRKWORLD's backend or avnu. The read is one fixed batch of every pinned
  pair (STRK, ETH, USDC, USDT, WBTC, wstETH, LORDS, EKUBO; read on
  2026-10-01 with 3 to 11 sources each), so the node learns no pair, amount
  or address; it is cached 30 s. With both tokens priced, an expected output
  worth more than **3%** (`SWAP_PRICE_BOUND_BPS`, which covers avnu's 0.1%
  fee, the slippage and ordinary impact) below the input is refused before
  the player sees it. So is a floor (`minAmountOut`, what the chain lets a
  route deliver) below the oracle value × (1 − 3% − slippage), checked
  itself rather than inferred from the quote; with slippage capped at 3%
  (300 bps, browser and backend), no checked swap can settle more than 6%
  under the oracle. So is a pinned price that is missing, older than
  30 minutes, from fewer than 3 sources, or unreadable: a token that should
  be checked is never quietly left unchecked. A re-quote passes the same
  check. A token with no feed (strkBTC, which answered zero, and most of the
  degen floor) makes the swap `unchecked`: the review says "No independent
  price check: …" and confirming needs an explicit tick, carried to the
  adapter as `acknowledgeUncheckedPrice: true` (the adapter refuses without
  it). That keeps the degen floor usable, which refusing would not; the
  degen list is already the backend's curated, volume-floored set (D-067).
  The review shows the implied rate and, where the oracle prices a side, its
  USD value. `SwapReview` gains `priceCheck`, and `PreparedBatch.confirm`
  the optional acknowledgement (D-036 extensions).
- **Slippage and the floor.** The floor is D-042's protected minimum for the
  build's fixed slippage, by exact bigint arithmetic, and is what the review
  shows and the chain enforces. avnu's own build rounds the slippage up (a
  live 430,588 at 1% carried 426,282; the protected minimum is 426,283), so
  its floor is checked for shape only and not used.
- **Expiry and re-quote.** avnu's quote has no expiry, so a quote stands for
  30 s (`SWAP_QUOTE_TTL_MS`). Confirming an older one asks again before the
  wallet is: the Exchange re-prepares, goes ahead when the fresh floor is at
  or above the reviewed one, and otherwise shows the fresh figures with "The
  quote expired and the price moved. Check the new protected minimum, then
  confirm again." The fee the player reviewed stays the ceiling through a
  re-quote, and the pair is the reviewed batch's. The adapter repeats the
  check at confirmation for a quote
  that ran out in between, and stops with nothing sent if the floor would
  fall. The counter spaces quote requests 1.5 s apart: a press inside the
  window waits, and a newer press replaces it.
- **Submission.** The wallet proves and submits (`wallet_strk20InvokeTransaction`,
  `wallet-submission.ts`), as for the Vault and every pool spend. `gasEstimate`
  is `0` and the total the pool fee. A wallet without shadow accounts is
  `shadow-accounts-unsupported` (now worded for the Vault and the Exchange),
  never `unsupported-wallet`.
- **The relayed swap is deleted**: the backend's `/v1/private/swaps/prepare`,
  `AvnuSwapPlanner`, the authorization's swap binding and the server-action
  swap check; the browser's `prepareSwap`, the SDK action builder and its
  guards; the adapter's `submission` option. The relay's fee and submission
  endpoints refuse `route: 'swap'`, its startup line no longer names swap,
  and `BACKEND_ROUTE_SWAP_MAX_RELAY_FEE` / `_MAX_QUEUE_DELAY_MS` are no
  longer read. The privacy package no longer depends on `@avnu/avnu-sdk`.
  `AVNU_PAYMASTER_API_KEY` is used by no player flow.
- **The switch.** The browser admits the swap only with
  `VITE_STRK20_SWAP_ENABLED=true`, `VITE_STRK20_SWAP_ALLOWED_TOKENS` (1 to 16
  tokens naming STRK) and `VITE_STRK20_SWAP_SLIPPAGE_BPS` (1 to 300, matching the backend's ceiling);
  `VITE_STRK20_SWAP_DEGEN_ENABLED=true` also admits the degen floor's tokens,
  which the backend vets. Anything else keeps the Exchange and the degen
  floor locked; off in every environment file. The demo fake prices no relay
  for a swap and refuses one from a wallet without shadow accounts.
- **The register (D-020, D-024).** The grade stays `anonymous` and the
  disclosure is unchanged. The `observable` now names the stand-in and that
  every swap a player makes uses the same one.

**Consequences.** A swap needs no avnu key and no STRKWORLD relay. Every
swap a player makes sits on one public stand-in address, linked to each other
though not to the wallet; D-024's frozen disclosure says the executor is
visible but not that it persists, which the lead may want to amend. The
sender is the wallet's choice, as D-082 found. avnu sees the stand-in, the
tokens and amounts, and the backend's IP. A Pragma price that is wrong in the player's favour is not caught, and a
pair Pragma does not price is only as good as avnu's quote, which the
review says. The oracle read tells the wallet's RPC that someone opened the
Exchange, at that time. The swap depends on avnu's exchange,
which its owner can upgrade, and on avnu's public API staying keyless and
within its rate limits; the proxy's window bounds what STRKWORLD asks of it.
A stand-in that already held some of the bought token keeps it (`diff`).
Unverified live: no shadow-account swap has been submitted yet; the first,
on the Railway test deployment (`deploy/RAILWAY.md`, "The swap probe"), is
the evidence, as the Vault's first supply was for D-077.

---

## D-085 — Endur staking is switched on, and xSTRK unstakes privately through a shadow account

**2026-10-01 · Accepted by the user (the lead asked for staking on and for private unstaking through a STRK20 shadow account) · supersedes D-063 in part (staking is switched on for the test deployment; the counter is no longer stake-only, and its exit is a shadow account rather than a withdraw anonymizer) · amends D-064 (the unstaking note points at the new counter; the waiver for `bank.stake` is unchanged) · amends D-077 and builds on D-083 (the shadow-account module D-083 extracted now serves the Vault, the Borrow counter and unstaking) · extends D-036's frozen seam with `endurUnstakePosition`, `prepareEndurUnstake` and `prepareEndurClaim` · adds one pinned public read to D-014's backend · registers `bank.unstake` and `bank.unstake-claim` (approved by the lead, 2026-10-01) · adds the `unstake` policy route and `VITE_STRK20_UNSTAKE_ENABLED` · amended by D-091 (the unstaking counter is the staking counter's Unstake tab, and the staking note says so) · amended by D-103 (UNSTAKE is its own counter, no longer a tab)**

**Context.** D-063 built Endur staking switched off. The reason in
`.env.production.example` was relay acceptance: "not to be enabled until
AVNU's sponsored-private paymaster is confirmed to accept the Endur deposit
anonymizer and one small funded stake has succeeded". D-082 removed the
relay: the wallet proves and submits a stake itself, with no paymaster, avnu
key or `BACKEND_ROUTE_STAKE_*` block, so the first condition no longer
exists and the second is the live probe D-082 already names. Nothing else
held it off: the production policy, the register (approved, D-064 waiver)
and the adapter were all ready. Unstaking did not exist: "no withdraw
anonymizer exists" (D-063). The Vault proved a keyless STRK20 shadow account
end to end in Ready (D-077, D-079), and a shadow account is a persistent
address, so it can hold an Endur withdrawal request across the queue's wait.

Read over mainnet RPC (`api.cartridge.gg/x/starknet/mainnet`) on
2026-10-01, block 15,726,652:

- Endur's xSTRK (`0x028d709c…0b0a`) exposes ERC-4626 `redeem(shares,
  receiver, owner)` and `withdraw`; its withdrawal queue is
  `0x0518a66e579f9eb1603f5ffaeff95d3f013788e9c37ee94995555026b9648b6`
  (class `0x6b2e1893…3f34`), an ERC-721 with `request_withdrawal(assets,
  shares, receiver) -> u128`, `claim_withdrawal(request_id)`,
  `claim_withdrawal_to`, `get_request_info(request_id) -> WithdrawRequest`
  (assets, shares, isClaimed, timestamp, claimTime, a cumulative snapshot)
  and `get_queue_state`. A real request (`0x5653395f…448`) was xSTRK
  `redeem` → queue `request_withdrawal` with xSTRK as caller.
- **The request NFT is a plain mint.** A simulated xSTRK `redeem` from a
  real holder with a live shadow account (`0x6ad69dce…aba4`, class
  `0x70e76435…b78f`, which has no SRC5, `supports_interface` or
  `on_erc721_received`) as receiver succeeded and minted request #10590 to
  it; `request_withdrawal` made no call to the receiver. A keyless shadow
  account can therefore hold a request.
- **Anyone can claim, and Endur does.** `claim_withdrawal` burns the NFT and
  pays its owner; Endur's relayer (`0x2d6cf618…173`) claims other people's
  ready requests once the queue is funded (`0x5846a8a2…eba`; its source,
  `Endur-fi/relayer`, does the same). A claim reverts "Too early to claim"
  before `claimTime`, "Insufficient funds" while the queue is unfunded, and
  "ERC721: invalid token ID" once paid.
- **The wait is seven days**: `claimTime - timestamp` was 604,800 s on all
  200 requests before #10589. D-063's "1 to 14 days" was not what the chain
  shows; funding can add to it.

**Decision.**

- **Staking is switched on** for the Railway test deployment
  (`VITE_STRK20_STAKE_*`, `deploy/RAILWAY.md`), wallet-submitted as D-082
  made it. The example environment keeps every route denied by default, as
  before. Its first live stake is the probe.
- **Unstaking runs through the player's own unstaking shadow account**:
  `dapp_name` `strkworld-endur`, nonce 0, fixed for good, and never the
  Vault's, so a player's Endur requests and Vault positions sit on different
  addresses and are not linked to each other.
- **Request (flow A).** Withdraw the xSTRK from the pool to the shadow
  account (the public leg), then through it xSTRK's `redeem(shares, shadow,
  shadow)`, which burns exactly those shares and queues the STRK. Nothing
  returns yet. xSTRK already on the address returns in the same batch to an
  OPEN xSTRK note (`collect_policy: all`); with none there, nothing is
  collected (`exact 0`, no note).
- **Claim (flow B).** Open one STRK note and collect every STRK on the
  address (`all`). When the address already holds STRK (Endur paid it
  there), the batch only collects: its one call is STRK's
  `balance_of(shadow)`, since an invoke needs a call, and no claim rides
  along, because Endur's relayer could claim that request while the wallet
  proves and the duplicate would revert the batch ("ERC721: invalid token
  ID"). Otherwise the shadow account calls `claim_withdrawal` for each
  request a read-only dry run found payable now (at most eight, oldest
  first); a request past its wait that Endur has not funded is never
  claimed, since one would revert the batch ("Insufficient funds"). The
  address is unstaking's alone, so all its STRK came from its requests. A
  claim with nothing held and nothing payable is refused before the wallet
  is asked.
- **The machinery is shared.** `packages/privacy/src/wallet-api/shadow-account.ts`,
  extracted for the Vault and the Borrow counter by D-083, holds
  `ShadowAccountResolver` (the commitment request, cached per resolver; the
  anonymizer-view address and its Primer-derived cross-check at the
  resolver's nonce) and `preparedShadowBatch` (the single-attempt
  wallet-submitted batch with its receipt wait). `EndurUnstake` holds its own
  resolver for `strkworld-endur`, as `ShadowVault` and `ShadowBorrow` hold
  theirs; nothing is copied, and no two dapp names share a commitment.
- **The read.** `POST /v1/rpc/endur-unstake` with `{ v: 1, account }`
  answers the latest block's timestamp, the address's STRK and xSTRK, its
  count of queue NFTs, and each request the queue's `WithdrawQueue` events
  name it as receiver for, by `get_request_info`, and for each unpaid
  request past its wait (at most eight) whether a read-only `starknet_call`
  of `claim_withdrawal(id)` succeeds (`claimableNow`). The scan runs from
  1,000,000 blocks back (about twenty days), never before block 15,726,000,
  at most 12 pages, keeping the newest 16; pages left over mark the answer
  `complete: false`, and anything malformed fails it whole. It logs nothing
  per request and follows the kill switch, like D-077's reads. The browser
  classifies each unpaid request by that chain timestamp, never its own
  clock, as `waiting`, then `awaiting-funds` ("Waiting for Endur to fund
  it") or `ready` by the dry run, and counts NFTs it could not list as
  `unlisted`. The dry run was checked against history: #10451, #10468 and
  #10469 answered `[]` one block before their owners' successful claims,
  and #10583 reverts "Insufficient funds" at the head. Endur's relayer funds
  the queue and claims in one transaction (#10582 still reverted one block
  before its claim), so most requests go from `awaiting-funds` straight to
  paid, and the claim step is usually a collection.
- **The seam (D-036)** gains `endurUnstakePosition(options?)`,
  `prepareEndurUnstake(shares, options?)` and `prepareEndurClaim(options?)`,
  with `EndurUnstakePosition`, `EndurWithdrawalRequest`, `EndurAction` and
  `PreparedEndurBatch` (the Vault batch's contract). The demo fake runs it at
  the stake fixture's DEMO RATE inverted and a fixed demo clock.
- **The switch.** Policy route `unstake`, admitted by
  `VITE_STRK20_UNSTAKE_ENABLED=true` and nothing else: no token list, no
  relay-fee ceiling, no intent bound. Off, the counter says unstaking is not
  switched on. It is independent of staking either way.
- **The counter** sits under the stake form in the Bank's staking tab, in
  Endur's look, with its own door, and steps aside while a stake is at its
  commit point. It reads requests only when the player asks, shows each with
  its time left or "Ready to claim", the STRK already paid to the stand-in,
  any leftover xSTRK, the stand-in address with an optional Voyager link, and
  a Claim button once something is claimable. A request first reads the
  xSTRK balance and says so plainly when there is none.
- **The register (D-020).** `bank.unstake` and `bank.unstake-claim`, graded
  `anonymous` like the Vault, approved by the lead on 2026-10-01 (the brief
  asked for this explanation), with one disclosure at every commit point and
  no waiver: "Your unstake request sits on a stand-in address, not your
  wallet. That address, the xSTRK it unstakes, its requests and the STRK it
  claims, with their amounts, are public on-chain. Only its link to your
  wallet is hidden, and matching amounts or timing can still give that link
  away. Claimed STRK returns to your pool balance." No D-024 string changes.
  The staking note now reads "To unstake, use the unstaking counter below.
  Endur's withdrawal queue holds the STRK for about seven days, sometimes
  longer, before it can come back to your pool balance." (D-064's other
  rules stand.)

**Consequences.** A player who unstakes has a persistent public stand-in at
Endur: every request and claim on it is linked to the others, and a request
that matches a recent stake in amount or timing can give away the link,
which the disclosure says. Endur's own service usually pays the STRK to that
address before the player claims, so the claim is a collection; a ready but
unfunded request makes the wallet refuse the claim, and nothing is sent. Two
transactions per unstake, each paying the pool fee. The read's window means
a request left unpaid for more than about twenty days stops being listed,
though the counter still says it exists and a claim still collects it once
Endur pays it. Unstaking depends on Endur's queue and xSTRK, pinned by
address, and StarkWare's anonymizer; no Cairo is written here. First live
use on Railway is the probe: one small stake, one request, one claim a week
later.

---

## D-086 — The lobby syncs interest once per patch, takes moves from a bucket, and remote avatars follow on a spring

**2026-10-01 · Accepted under the lead's multiplayer-stability brief · technical, no product, privacy or seam change · amends the lobby's 50 ms move floor (packages/lobby/README.md, "Rate and reach") from a strict gap to a three-deep token bucket at the same rate · keeps the sandbox (D-060) and kick (D-078) floors strict · amends D-059's remote-avatar interpolation (presentation only, behind D-038's seam)**

**Context.** The lead reported that multiplayer feels unoptimised, with lag
at times "when locked into multiplayer". A reproducible load test
(`packages/lobby/tools/load-test.ts`, which forks its own instrumented local
lobby and drives real `LobbyClient` bots that walk at the game's speed,
report every 16 ms frame and work the sandbox) found three server-side causes
and one client-side one. With 20 ms of uplink jitter, one room, before this
decision:

- **A third of all moves were dropped.** The client sends at exactly the
  server's 50 ms floor, so any jitter delivers some moves 40 ms apart, and
  the strict floor dropped each one: 35% at 10 to 50 bots. Every observer
  saw those peers stall for a patch: 53–55% of peer updates came 100 ms
  apart instead of 50.
- **Clients lost track of peers.** The room recomputed every view on every
  accepted move, so an entry could leave and re-enter one observer's view
  inside one patch. `@colyseus/schema@4.0.30` encodes that so the client
  cannot apply it: the SDK logs `"refId" not found`, skips the entry's
  updates, and that peer freezes on screen. 12 such failures in 20 s at 10
  bots, 493 at 50, 3,575 at 100.
- **The interest work was O(sessions³) a second.** Each recompute is
  O(sessions²), once per move. One room of 100 used 98.5% of a core, its
  patch rate fell from 20 to 11 a second, 56% of moves were dropped and
  joins took 369 ms at p95. At 50 bots it was already 23% of a core.
- **A full sandbox cost every client 0.58 ms a patch.** `LobbyClient` re-read
  and re-froze all ~850 blocks on every 20-a-second patch, whether or not
  the sandbox changed.

And remote avatars were drawn with a first-order ease towards the latest
snapshot, whose speed pulsed by 15% within every 50 ms patch even on a
perfect network (coefficient of variation 0.153 in
`packages/world/tools/remote-crowd-bench.ts --interpolation`), 0.298 when a
move was lost.

**Decision.**

- **Interest sets are recomputed once per patch**, in the room's
  `onBeforePatch`, when anything moved, joined, left, suspended or resumed
  since the last one. The joiner's own view is filled at once in `onJoin`, so
  its first full state already holds its neighbours, and is then left alone
  until the client acknowledges the join: Colyseus encodes no patch for a
  joining client, so changes queued meanwhile would all reach it in one
  encode. The ball's timer is re-armed there too after moves. The rule itself
  (`selectVisible`: 640 px box, nearest first, capped at 24) is unchanged.
- **The move floor is a token bucket**: `UpdateThrottle(50, MOVE_BURST)`, a
  GCRA with `MOVE_BURST = 3`. The long-run rate is still one move per 50 ms
  per session; up to three may arrive close together after a gap, so 100 ms
  of jitter costs nothing. A burst costs no bandwidth, because a patch
  carries only the latest position. `resume` drains the bucket, so the next
  move still waits a full interval and suspend/resume is still no
  position-write channel. The hard ceiling (40 messages a second,
  disconnecting) and the sandbox and kick floors are unchanged and strict.
- **Remote avatars follow on a critically damped spring**, in its exact
  closed form, with `REMOTE_INTERPOLATION_TIME_CONSTANT_MS` 45: the same
  90 ms lag behind the wire as before, but at an even speed. From rest it
  never overshoots a target that holds still; teleports still land at once.
- **`LobbyClient` reads the sandbox only when a patch touched it.** It takes
  the decoder's raw change hook (`getRawChangesCallback` in
  `@colyseus/schema`) only if nothing else holds it, checks every read that
  it still does (same decoder, same hook), and otherwise reads every patch
  as before. Every hundredth read (5 s) is full regardless, so a patch whose
  decode failed before reaching the hook cannot leave the sandbox stale for
  longer. A read reuses every frozen column the patch did not change.
  Validation is unchanged.
- **The edge's lobby tunnel disables Nagle's algorithm** on the leg it opens
  to the lobby (the browser leg already had it off). Unmeasured: macOS
  loopback showed no difference, and Railway runs Linux, where Nagle with
  delayed ACKs can hold a small frame for 40 ms.
- **Capacity stays 48 per room.** When a room is full, Colyseus's
  `joinOrCreate` puts the next joiner in a new `street` room: nobody is
  refused (100 bots at capacity 48 made three rooms, none refused), but the
  rooms do not see each other and each has its own sandbox and ball.

**Consequences.** The same load test after this decision, 20 ms of jitter,
one room: 0 moves dropped and 0 decode failures at every size; observer
stalls 6–8% (from 53–55%); a room of 100 uses 11–13% of a core at a full 20
patches a second, joins in 11 ms at p95. Each client receives more bytes
(3.8 KB/s at 100, from 2.4), because it now gets every move instead of half.
The tick itself is longer, since the interest work moved into it (p95 6 ms
at 100, inside the 50 ms budget). A full sandbox costs a client 0.09 ms a
patch, and the drawn walk's coefficient of variation is 0.046 on time, 0.188
with every third move lost. One room could now hold 100 players on the
server's side; whether to raise the cap is the lead's call, and the client
still draws at most 24 peers at 14 draw submissions each (7 meshes, all
casting shadows). Not measured: real browsers (GPU time, draw-call overhead,
frame pacing), real network latency and loss, and Linux TCP behaviour on
Railway.

---

## D-087 — Only the overworld, the Exchange roof and the Avatar Studio are multiplayer, each a presence area of its own

**2026-10-01 · Accepted by the product owner (the multiplayer-scope rule: interiors stay private solo instances; only the overworld is multiplayer, plus two approved shared areas, the roof of the avnu building and the avatar changing room) · supersedes D-019 in part (the Exchange roof and the Avatar Studio no longer suspend presence) · supersedes D-047 in part (its "entering it suspends lobby presence") · extends D-011's shared seam with `PresenceArea`, `PRESENCE_AREAS`, `ROOF_PRESENCE_GRID` and `STUDIO_PRESENCE_GRID`, and D-047's WorldEvents with `rooftop:entered`, `rooftop:exited` and `area:moved` · adds one lobby verb, `area` · changes no `PresenceState` field and no D-024 disclosure · builds on D-086's per-patch interest sync and keeps its overflow · amended the same day by the lead (the roof also sees the street below, one way; see the amendment at the end)**

**Context.** The product owner set the multiplayer scope. Building interiors
are private solo instances, as they are today: the Bank, the Vault, the Post
Office, the Bridge, and the Exchange's ground floor and degen floor. Only the
overworld is multiplayer — the street, the sandbox, the football pitch and the
plaza — plus two explicitly approved shared areas: the roof of the avnu
building (the Exchange tower's roof, reached by lift) and the avatar changing
room (the Avatar Studio). Before this, the lobby had one interest rule over
one coordinate space, and the only way off the street was D-019's suspend. The
Studio suspended presence (D-047). The roof was reached inside the Exchange's
suspended visit with no event of its own; its view drew the street's remote
peers below.

**Decision.**

- **A live session is in exactly one presence area: `street`, `roof` or
  `studio`; a suspended one is in none.** The room's interest sets pair
  sessions in the same area only, with D-086's radius and cap inside it. The
  area is the lobby's own server-side bookkeeping (`Session.area` in
  `presence.ts`), not a schema field, so no client is told another player's
  area — only shown the players in its own.
- **Strictly one area per view, the roof included.** *(Superseded the same
  day by the one-way roof view amendment below.)* The roof's view keeps
  drawing the street's buildings below, but not its passers-by: street
  players never see roof players and roof players never see street players.
  The alternative (roof observers also receive street peers, one way) is
  possible, since the deck lies over the tower's solid footprint where no
  street player can stand, but it would make the client tell peers apart by
  position and break "one rule for every view". Not built; the product
  owner may ask for it.
- **One room type, areas inside it.** Not a Colyseus room per area: a switch
  would be a leave and a join, a new `gameId`, a join's full state and a
  matchmaking round trip per lift ride, and overflow would have to place
  three rooms together. Instead D-086's once-per-patch view sync filters by
  area, and a switch keeps one entry and one `gameId`, which views drop and
  pick up at the next patch, once each. D-086's overflow (capacity 48, then
  a new `street` room) applies per lobby room; each room has its own street,
  roof and Studio.
- **One new verb, `area`** (`{ area, x, y, facing, sprite }`): go live in an
  area from a suspend or from another area, or refresh the placement and
  sprite in the current one. Like `resume` it always succeeds when well
  formed and stamps the move floor, so it is no faster a write channel than
  `move`. Leaving the street puts a carried block back and leaves the ball,
  as a suspend does. A malformed switch, or one off the area's tiles,
  suspends the session: a client that disagrees with the room about where it
  stands is seen by no one rather than in the wrong place.
- **Server-authoritative movement per area.** The rooms use their own
  coordinate spaces: the roof's grid lies over the tower's street footprint,
  the Studio's at the interiors' origin over the hidden street by the pitch.
  The lobby holds a shared room's players to its walkable tiles, from
  `ROOF_PRESENCE_GRID` and `STUDIO_PRESENCE_GRID` in `@strkworld/shared`
  (a World test fails if they drift from `EXCHANGE_ROOF_LEVEL` and
  `AVATAR_STUDIO_DEFINITION`): a placement must land on one, and a move must
  land on one without its straight line crossing a solid tile. A step within
  one tile (`AREA_STEP_SLACK_PX`) may clip a corner, because two real samples
  a patch apart can lie either side of the Studio's portal jamb, and no wall
  in either room is thinner than a tile. The street keeps its rule, a clamp
  to the world. The sandbox, the ball and the sky drops count street players
  only, since the rooms' coordinates overlap the street's.
- **World events.** The session emits `rooftop:entered` when the lift reaches
  the roof and `rooftop:exited` when it leaves (by lift, or by a Shell
  release, before the street placement and `building:exited`), and
  `area:moved` for every position in the roof or the Studio — the arrival
  before the entered event, then every frame the player moves. Never
  `player:moved`: street consumers (the sandbox and football controllers)
  never read a room's coordinates.
- **The Shell switches area for those two rooms and suspends for every other
  interior.** The presence controller maps `avatar-studio:entered` and
  `rooftop:entered` to `LobbyClient.enterArea` with the latest `area:moved`
  placement, `avatar-studio:exited` to `enterArea('street', …)` and
  `rooftop:exited` to a suspend (the floors below are private). A client
  without `enterArea` keeps the old suspend, the safe fallback.
- **The Studio.** Its players are drawn there with their current look, and a
  look chosen in the Studio is shown at once: `avatar:selected` re-enters the
  same area with the new sprite (the existing sprite field, nothing new).
  D-047's input and camera ownership are unchanged; the session only keeps
  remotes visible there. On the roof remotes stand on the deck's height.
- **`LobbyClient` never shows the area left in the area entered.** After a
  switch, `peers()` is empty until the room's copy of the client's own avatar
  shows the new placement: the patch that moves it is the one that swaps the
  views. A suspended client is shown nobody.
- **Privacy (the second invariant; D-024's disclosures unchanged).** The
  lobby still never sees money or wallet data: no
  `PresenceState` field changed, the area travels only in the client's own
  `area` message, and neither room carries anything financial — the roof has
  no station and the Studio only the cosmetic sprite field. What the areas do
  let an observer learn: a player arriving on the roof came through the
  Exchange (D-019 already accepts that inference at its door), and the roof
  arrival brackets their time on the floors below.

**Consequences.** Lobby tests cover area isolation (street, roof and Studio
players at the same pixels never see each other), movement validation per
area, area switching and its fail-closed refusals, and suspend for every other
interior; a real-server test drives the same through `LobbyClient`, and
another through three real presence controllers. The load test's `--mixed`
scenario (every bot spends 4–10 s on the street, in the Studio or on the roof,
with a 1–2 s private ride between the street and the roof) at 100 bots in one
room, 20 ms of jitter: tick p95 8.8 ms, 12.4% of a core, 2.76 KB/s per
client, 20 area switches a second, 0 decode failures, 0 moves refused by a
room's tiles, and 0 of 708,534 peer sightings in the wrong area. About 1% of
moves are dropped by the floor because each switch drains the bucket, as a
resume does; the client resends them, and observer stalls are 9.1%. Street
only, the same load test is where D-086 left it (100 bots: tick p95 8.2 ms,
13.2% of a core, 3.83 KB/s per client, 0 moves dropped, 7.5% stalls), so the
area filter costs the street nothing measurable. The load test's uplink
jitter is now one FIFO per room (it could reorder two frames due in the same
millisecond). Not verified: real browsers (drawing,
the roof's remote heights, the Studio's crowd), real networks, and the
product owner's view of a roof without the street's passers-by.

**2026-10-01 one-way roof view amendment.** The lead asked for the roof to
show the street's passers-by below again, as it did before this decision.
This replaces the "strictly one area per view" bullet above; everything else
in it stands.

- **One view is one-way.** A roof observer is sent the roof's players and the
  street's, from the same once-per-patch view sync (D-086), inside the same
  interest radius and the same cap of 24 drawn peers: roof players fill the
  cap first, nearest first, and street players the rest, so a crowd below
  never pushes a roof player out of view. No street observer is ever sent a
  roof player, and the Studio stays strict both ways. The rule lives in
  `LobbyPresence.visibleTo` alone.
- **A roof peer is told from a street peer by where it stands, not by a
  field.** The roof's grid is the tower's street footprint, and every
  footprint tile is solid on the street except the Exchange's door, which
  takes a player inside (a World test checks the footprint). So the lobby never sends
  a roof observer a street player standing over the footprint, which only a
  hostile client can do, and the presenter stands any peer over the footprint
  on the deck and every other on the street (`isOverAreaGrid`, and the grid's
  new `width` and `height`). `PresenceState` is unchanged; no area is sent.
- **Privacy.** The roof is shown what a player at the tower's foot is shown:
  street positions and sprites, nothing financial. The street still learns
  nothing of the roof, and is not told it is being watched from it.
- **A placement waits a patch after an erasure.** The real-server test that
  timed out on CI was meeting a real fault, not only a slow runner: a suspend
  then an area switch, or a suspend then a resume, in back-to-back messages
  erased an entry and placed its successor under the same `gameId` key inside
  one patch. `@colyseus/schema@4.0.30` encodes that as one `DELETE_AND_ADD`
  and filters it per view by the new entry alone, so a view that held the old
  entry and was not to see the new one was sent nothing and kept a frozen
  ghost of it. The room now holds such a placement until the patch carrying
  the erasure has gone out (`PresenceRoom`'s `#placeAgain`, at most two
  patches). The lift ride is longer than a patch, so play rarely met it; the
  fault predates D-087 for a fast suspend and resume.

**Consequences of the amendment.** Lobby tests cover the one-way view, the
cap's order and a hostile street player over the footprint
(`presence-areas.test.ts`, `areas.test.ts`); the real-server test
(`area-room.test.ts`) waits on conditions, the room's counters and a
street player's step seen by each observer instead of fixed sleeps, runs
each case under a 20 s budget like the other lobby wire tests, and adds a
regression test for the ghost, which fails against the old room. The
presenter and grid tests cover the deck/street split, and the web
integration test the one-way view through three real controllers. The
load test's `--mixed` scenario at 100 bots, 20 ms of jitter: 2.92 KB/s per
client while on the roof (2.34 KB/s with the strict rule, same seed), 3.78
on the street, 2.46 in the Studio; 2.87 KB/s per client overall; tick p95
7.7 ms, 11.0% of a core; 0 of 722,399 peer sightings in a wrong area and
20,838 street sightings from the roof; 0 decode failures. Not verified: a
real browser drawing the street's crowd from the roof.

---

## D-088 — Menu Mode offers every counter its Game Mode room holds

**2026-10-01 · Accepted · technical direction delegated to the project lead (the lead asked for Menu Mode parity with Game Mode) · amends D-083 (its "Menu Mode keeps the Vault's one window; borrowing is Game Mode only for now") · amends D-067 (the degen floor is reachable from Menu Mode) · keeps D-030's guardrails, D-042's one-swap Exchange and D-024's disclosures · no seam, register, World, lobby or backend change · amended by D-103 (the Bank's and the Vault's tabs are their four counters each)**

**Context.** D-030 makes Menu Mode the secondary path to "the full set of
the building's functions at once". Since then two rooms gained a second
window that only Game Mode reached: the Vault's BORROW counter (D-083) and
the Exchange's DEGEN SWAP counter (D-067). An audit of every player feature
found no other gap: the Bank's Menu Mode has shield, unshield, transfer and
stake, with the unstaking counter under the stake form (D-085); the Post
Office's is its transfer (D-040); the Bridge's and the Vault's SUPPLY /
REDEEM are the counters' own windows, the Vault over all twenty-three
markets (D-081); the ground swap's review carries the price check and the
unpriced-token acknowledgement (D-084). The Privacy Plaza (D-076), the
sandbox (D-060), the pitch (D-078) and the Avatar Studio (D-047) have no
Menu Mode by design: no building, no money.

**Decision.**

- **A row of counter tabs.** Where a room holds more than one window, Menu
  Mode shows them one at a time behind tabs named as the counters are
  (`SUPPLY / REDEEM` · `BORROW`, `SWAP` · `DEGEN SWAP`). The first tab is
  the building's own Menu Mode window and is always offered; its window
  still shows its own locked door. Every other tab is offered only while
  `resolveStation` would open that counter, against the same register,
  policy and build switches, so a counter the build leaves off
  (`VITE_STRK20_BORROW_ENABLED` unset, or an unapproved route) is hidden,
  not shown locked. With one tab, no row is drawn and the window is what it
  was.
- **The counters' own windows.** The tabs choose between the existing
  `VaultPanel` and `BorrowPanel`, and `ExchangePanel` on its ground and
  degen floors: the same machines, `ConfirmGate`, disclosures and receipts.
  `apps/web/src/panels/MenuCounters.tsx` holds the admission and the tabs;
  `VaultMenuPanel` and `ExchangeMenuPanel` are the registry's adapters, as
  `PostOfficePanel` is (D-040). `PanelFrame` gains a presentation-only
  `counters` slot between the header and the disclosure, so the disclosure
  shown is always the chosen counter's own.
- **One window mounted.** Only the chosen window is mounted, so only one
  confirm is ever on screen. A tab switch closes one window and opens the
  other, as walking between counters does: a submission already sent is not
  cancelled, and its receipt stays in the shared ledger (the degen window
  opens on the swap just sent downstairs, as the degen counter would).

**Consequences.** A player can borrow and swap on the degen floor without
walking. No disclosure string changes, and no route opens that its counter
would not. Tests: `apps/web/src/visits/menu-mode-parity.flow.test.tsx`
drives both rooms' Menu Mode through the real visit layer (a borrow and an
unpriced swap to submission, a degen swap, and the hidden tabs with
borrowing or swapping off). Not verified: a real browser at phone width.

---

## D-089 — The lending counters follow Vesu's and Aave's form conventions

**2026-10-01 · Accepted · direction from the product owner (simple, familiar lending touches in the Vault's Vesu style; lending conventions only, so no 50%, flip arrow or slippage), details delegated to the lane · amends D-081 (a pool balance the player reads stays in the window for the supply field) · amends D-022 (a Max may use the wallet's per-token total) · amends D-083 (Max is how a repay or a collateral withdrawal takes everything; Max borrows to a health of 1.25) · keeps D-024's disclosures and every seam check · no seam, register, World, lobby or backend change**

**Context.** The Vault's SUPPLY / REDEEM and BORROW forms were a token
picker, a bare number and a review button, with checkboxes for "everything".
Lending apps agree on a few touches (a research pass over Aave's modal
sources and locale strings, and Vesu's user guides): the balance the amount is
measured against, one Max, the market's APY, "you will supply / receive",
the health factor before → after with the liquidation level, and a button
that says what is missing. The shared panel kit (`apps/web/src/panels/kit/`)
already draws them in each building's own tokens.

**Decision.**

- **Supply.** The field's balance line is the pool balance of the chosen
  token, read only when the player presses "Show my pool balance" (one
  `wallet_strk20Balances` call for every lendable token, which the wallet
  may confirm, and the pool fee beside it). The figure stays in the window,
  is never logged, and goes back to unread after a submission. Max leaves
  the 6 STRK pool fee behind in STRK. `wallet_strk20Balances` answers one
  `{ token, balance }` total per token and no maturity split, so with a real
  wallet **Max uses that per-token total** (amending D-022's "no MAX when
  maturity is unknown"), the rule the counters now share: a note stays
  maturing for 10 blocks (about 20 s) after it lands, and the wallet refuses
  a spend that counts one (119, an insufficient balance), so no funds are at
  risk. When that refusal comes back for a supply the read balance covers,
  the counter says "Funds you just added are still settling; try again in a
  few seconds." rather than calling the balance short. Where the wallet does
  report a spendable figure (the fake and demo), Max uses it. Over the
  balance the button reads "Insufficient {token}".
- **Redeem.** The balance line is what is supplied, from the position read.
  Max is what the vault can pay out now; when that is the whole position,
  the redeem is of every share by the vault's own `redeem`, as the old
  "Redeem everything" checkbox did, which Max replaces. The review still
  says "You redeem everything".
- **Both.** The market's supply APY (Vesu's figure, as listed) and "You will
  supply / receive" sit under the field.
- **Borrow.** Once the loans are read (an existing loan changes every
  figure, so nothing is shown before): "Available to borrow", a Max, the
  LTV, health factor and liquidation price, each now → after.
  **Max aims for a health of 1.25** (LTV at 80% of the pair's max), not
  Aave's whole limit and not D-083's 1.05 floor: the collateral can lose a
  fifth of its price before the loan is liquidatable, and a Max-filled loan
  starts clear of the 1.15 warning band. "Available to borrow" is that same
  figure. Typing more is allowed down to the 1.05 floor; under it the button
  reads "Health factor too low" and offers no review, and the seam refuses
  as before.
- **Repay and withdraw.** Repay's balance line is the debt; Max fills it, and
  that amount is a repay-all with the seam's buffer, replacing the
  checkbox. A withdrawal's Max keeps health at 1.25, or is the whole
  collateral (a withdraw-all) when nothing is owed.
- **Tidy Max figures.** Every Max, and "Available to borrow", is floored
  to two decimals for a stablecoin and six significant figures otherwise
  (kit `tidyFloor`), never rounded up; the maths beneath stays exact. A
  tidied whole position, debt or debt-free collateral still means
  everything.
- **One set of loan figures in the form.** The borrow form no longer repeats
  the loan's block from the list above; it shows LTV, health factor and
  liquidation price once each, now → after while an amount is typed. The
  list keeps the loan's own figures and warnings.
- **Maths in the shell for display only.** `apps/web` may not import the
  seam's runtime, so `panels/borrow/borrow-preview.ts` restates Vesu's
  formulas in the seam's rounding; `borrow-preview.test.ts` holds its health
  factor and liquidation price equal to `borrowHealth` and every Max it
  fills accepted by `assessBorrow`. The seam re-reads and decides at
  prepare, as D-083 says.

**Consequences.** Each form gains a few rows and loses a checkbox. No
disclosure, refusal rule, review or confirm changes; one refusal's words
change because the checkbox they named is gone ("Use Max to repay
everything instead"). The kit gains two optional words (an `exceedsMessage`
for `AmountField`, an `exceeds` for `primaryAction`) so a redeem says "More
than you have supplied" and a repay "More than you owe". Tests: the panel
flow tests, both machines' tests, the kit's, and `borrow-preview.test.ts`.
Not verified: a real wallet's balance prompt, or a browser at phone width.

---

## D-090 — The Exchange swaps as swap apps do: live quote, Max from the per-token balance, and a slippage cog

**2026-10-01 · Accepted by the lead (the owner asked for the Exchange and the degen floor to follow avnu's and Uniswap's swap conventions, with Max and the slippage cog, simply and in the building's own style) · amends D-022 as D-089 does, for the Exchange (Max may fill from the per-token total) · amends D-084 (the slippage is the player's, up to the build's figure, which becomes a ceiling) · extends D-036's frozen seam with the swap intent's optional `slippageBps` · keeps D-084's review, oracle check, unchecked-price tick, re-quote and fee ceiling unchanged · amended by D-103 (the review shows what you sell, what you should get, the fees and a total of the amount plus the fees)**

**Context.** The Exchange's compose view was two selects, an amount and a
Review button: no Buy figure until the review, no flip, no rate, and Max off
for every live player. The spec (`defi-ui-patterns.md`, swap section) and the
owner's principles ask for Sell and Buy, 50% and Max, the flip arrow, a live
read-only Buy figure with USD values, a rate with an invert, slippage behind a
cog (0.1/0.5/1% and custom, capped at 3%, a warning above 1%), and four rows:
Receive at least, Price impact, Pool fee, Route via avnu.

Read on 2026-10-01: `wallet_strk20Balances(tokens)` answers
`[{ token, balance }, ...]`, one entry per requested token (the STRK20 corpus,
"Show the shielded balance"; the adapter's parser,
`wallet-api/operations.ts`, which refuses any other shape). So per-token
balances are available. What it does not give is which notes are mature: a
note is spendable 10 blocks after it is created (corpus, "matures 10 blocks
after creation"). That is what D-022 meant by "aggregate": spendable plus
maturing, per token, not a total across tokens. The adapter reports
`maturityKnown: false` and zero `spendable`, so the kit's Max was always off.

D-084's slippage was the build's own (`VITE_STRK20_SWAP_SLIPPAGE_BPS`), and the
adapter refused a floor tighter than it, so a cog had nothing to set.

**Decision.**

- **Max fills from the per-token total** when the wallet gives no spendable
  split (`maxBasis` in the kit), less the 6 STRK pool fee when selling STRK,
  the fee's own token (`maxAfterReserve`, `feeReserve`); off when that leaves
  nothing. A non-STRK sell keeps its whole balance, since the wallet chooses
  which pool token pays the fee (D-079), and the Pool fee row says so. The
  total is what the balance line shows and a player may type in by hand, so
  Max fills in nothing a typed amount could not. A note received in the last
  10 blocks may not be spendable yet; the wallet, which proves, refuses a
  spend it cannot make, as it would for the same figure typed in. This
  applies to the Exchange what D-089 made of D-022's "the shell must not
  derive MAX when maturity is unknown" for the Vault.
- **The live quote is a prepared batch**, asked for 800 ms after the last edit
  (`LIVE_QUOTE_DELAY_MS`), never inside the 1.5 s spacing a Review press
  keeps, and from a budget of 7, one more every 6 s (`LIVE_QUOTE_BUDGET`),
  below the backend's per-client bucket (10, one more every 6 s, D-084), so
  typing never spends what Review and the confirm-time re-quote need. Only a
  swap worth quoting is asked (both sides listed and swappable, an amount
  within the pool balance, a valid slippage). A Review press takes a fresh
  live quote for exactly that swap as is, with no second request, and waits
  for one already in flight rather than asking twice; any edit discards it. A
  quote that runs out (30 s) dims, with "Review swap asks for a fresh one";
  nothing re-asks on its own, so an idle open counter costs avnu nothing. A
  failed live quote (a refusal in the wallet included) pauses live quoting
  until the next Review press, so it is not asked again on every keystroke.
  The first quote of a connection may ask the wallet for the swap's
  shadow-account commitment, as a Review press did before.
- **Slippage is the player's.** The swap intent gains an optional
  `slippageBps` (D-036 extension): a whole number from 1 to the build's
  `WalletRoutePolicy.swap.slippageBps`, which is now that build's ceiling and
  the default for an intent without one. The adapter quotes and floors at it
  and refuses anything else before the wallet or avnu is asked; the fake does
  the same. The cog offers 0.1%, 0.5% (default) and 1%, those at or below
  the ceiling only, and a custom value; above 1% it warns, above the ceiling
  (never more than 3%, so D-084's 6% worst case under the oracle stands) it
  says "Enter a value up to 3%." and the button reads "Check the slippage".
  The counter refuses a review whose floor is not for the chosen slippage. On
  Railway both slippage figures are 50, so the cog shows 0.1% and 0.5% until
  both are raised to 300 (`deploy/RAILWAY.md`).
- **Price impact** is how far the expected output sits below the input's
  value at Pragma's price (`priceCheck.shortfallBps`, which counts avnu's fee
  and the route's impact together), floored at 0; "Not known" when Pragma
  prices one side or neither. Above 3% it is a warning. D-084 already refuses
  a checked quote more than 3% under the oracle, so the warning shows only if
  that bound is ever widened; the degen floor's unpriced tokens read "Not
  known".
- **Buttons**: "Enter an amount", "Insufficient {token}", "Check the slippage",
  "Review swap", "Preparing with your wallet…", then the review's own confirm.
  The review, the oracle check and the unchecked-price tick are unchanged;
  the review's slippage line now says the slippage was chosen with the cog.
- **Look.** The view is the panel kit (`AmountField` gains `readOnly`, `busy`
  and `stale`; `SettingsPopover` a `hint` and a custom value that survives
  passing through a preset) in the Exchange's own `--ui-*` tokens, so the
  ground floor wears avnu's look and the degen floor its own. The degen
  floor runs the same view over its list. Each figure shows once: the pool
  balance on the balance line beside 50% and Max (the token selectors show
  the ticker alone), "via avnu" on the Route row (the card's footer badge is
  gone), and no "one swap at a time" subtitle (D-042's single-swap rule
  stands; the view has no batch controls to explain).

**Consequences.** A player sees what a swap returns before reviewing it, and
Max works for live players. The live quote spends a little more of avnu's
public window and the backend's than Review presses alone did, bounded per
counter by the budget above; the backend's own limits are unchanged. Max can
include a note that matured too recently to spend, which the wallet refuses
with nothing sent. The adapter's swap slippage is no longer one build-wide
figure, so the swap stand-in's quotes carry several slippages; nothing about
the player beyond what D-084 lists reaches avnu or the backend. Not verified
live: the cog's wider range on Railway, and a Max that counts a maturing note
on a real wallet.

---

## D-091 — The Bank, the Post Office and the Bridge follow their category's conventions, on the shared kit

**2026-10-01 · Accepted (the lead's brief, with the owner's three principles: simple and direct, each building's own look, only what the category's leading apps do) · extends D-036's frozen seam with `endurRate` · adds one public backend read · amends D-022 for the Bank (Max takes the per-token total, per the lead's balance rule for every panel) · amends D-085 (the unstaking counter is a tab, and the staking note's wording) · keeps D-063 and D-041 (no figure at a stake's or an unstake's review), D-074's recipient check, D-061's reserve copy and every D-024 disclosure · lending is D-089 and the swap D-090 · amended by D-103 (no Stake and Unstake tabs, and no queue: one action per counter)**

**Context.** The panel kit (`apps/web/src/panels/kit`, PR #163) gave every
counter the same amount field and rows. The spec of each category's
conventions (`defi-ui-patterns.md` in the lead's working notes: Lido and
Endur for staking, Uniswap's wallet send for a send, Uniswap and StarkGate
for a bridge) asks for a few familiar rows per panel and no swap elements
outside the swap. The Bank's forms were a bare input with a Max beside it;
the staking counter showed no rate and stacked the unstaking counter under
the stake form; the Bridge showed no time; a send's recipient field had no
Paste and said nothing until Add.

**Decision.**

- **Bank and Post Office (one machine, D-040).** Every control uses the
  kit's `AmountField` and a `DetailRows` with the pool fee read live. In a
  mode that spends the private balance (unshield, send, stake) the read
  total sits on the field ("Pool balance: 100 STRK", with a small Refresh
  beside it and the card's notes as the field's hint), and the balance card
  is drawn only before the read; the field flags an amount over it.
  Shielding spends public STRK the Bank cannot see, so its field shows no
  balance and has no Max. The primary button follows the kit's
  `primaryAction` ("Enter an amount", "Insufficient STRK"), and a send's
  says "Enter a recipient" or "Check the address" first. One primary at a
  time: the review button appears only once something is queued; the batch
  flow and its wording are unchanged. No 50%, no
  slippage, no flip.
- **The recipient field** is the kit's new `RecipientField`: "To", the
  placeholder "Enter address", a Paste button where the browser offers
  `navigator.clipboard.readText`, and an inline "That does not look like a
  Starknet address." checked on blur and on paste, never per keystroke.
  Whether the address can receive is still the Bank's own check at Add
  (D-074), with its own line.
- **Max (amends D-022 for the Bank).** Following the lead's balance rule for
  every panel: `wallet_strk20Balances` answers one total per token (read
  from `@starknet-io/types-js` 0.10.4: `STRK20_BALANCE_ENTRY` is
  `{ token, balance }`, no maturity split), and Max now takes that total
  less the pool fee, what is queued and the costed network figure. The
  wallet refuses a spend that counts a note still maturing (about ten
  blocks), so a Max can fail but not misspend; when the wallet refuses a
  spend as more than the balance and the read total covers it and the pool
  fee, the Bank says "Funds you just added are still settling; try again in
  a few seconds." The machine's cost-evidence rule is unchanged: Max appears
  once a visit of that shape has been costed.
- **Staking (Endur style).** The staking counter has Endur's two tabs,
  Stake and Unstake; only the chosen form is mounted (D-088's rule), and
  the tabs step aside at a stake's commit point. The stake form shows "You
  will receive ≈ x xSTRK", "Exchange rate 1 xSTRK = x STRK" and the pool
  fee; the unstake form shows "You will receive ≈ x STRK", the rate,
  "Waiting time About 7 days" (D-085's measured 604,800 s, with Endur's own
  caveat as its note) and the pool fee with its note, and the pending
  requests sit under the form with the claim behaviour unchanged (funded,
  awaiting funds, collect-only). The estimates say they are estimates; a
  stake's and an unstake request's review still show no figure from the
  rate, because Endur's vault fixes it when the transaction runs.
- **The rate (extends D-036).** `PrivacyOperations.endurRate(signal)`
  answers `{ strkPerXstrk, origin }`: xSTRK's `convert_to_assets(10^18)` at
  the latest block through `POST /v1/rpc/endur-rate` (`{ v: 1 }`, answer
  `{ strkPerXstrk }`), a pinned call on the pinned xSTRK that names nobody
  and asks no wallet, open while the stake or the unstake route is. The
  demo fake answers its fixed DEMO RATE (1.25) as `origin: 'demo'`, which
  the counter labels "Demo rate, not Endur's." The staking view reads it
  once when it opens and never on a timer. Read on 2026-10-01 at block
  15,734,660: `0x106c70bf65979943`, 1 xSTRK = 1.18344 STRK.
- **The Bridge.** The amount uses the kit field (no balance and no Max: the
  source chain's balance is not read). The quote shows "You will receive ≈
  x STRK", the signed minimum and "Est. time", from the signed quote's
  `timeEstimate` (1Click: seconds once the deposit confirms, said in the
  row's note). A saved deposit's status is a persistent `role="status"`
  line at the top of its record. The 0.2% provider-fee note and every
  recovery control stay.
- **The staking note** (D-085's wording) now reads "To unstake, use the
  Unstake tab. Endur's withdrawal queue holds the STRK for about seven
  days, sometimes longer, before it can come back to your pool balance."

**Consequences.** Each panel reads as its category does, in its building's
own tokens. The seam has eighteen methods. A Max with a fresh shield may
fail in the wallet for a few blocks and says why. Tests: the kit's
`RecipientField`, `endur-rate.test.ts`, the Bank's render and machine
tests, the staking and unstaking flows through the tabs, the Post Office's
send conventions, the Bridge's rows and status, the adapter, client, fake
and backend rate reads. Not verified: no live wallet has shown these
panels, and the rate route has not run on Railway.

---

## D-093 — A wallet that lacks the capability method is unsupported, not unreachable

**2026-10-01 · Accepted (the lead's brief, from the Xverse end-to-end research) · amends D-073's consequence that any capability failure other than 162 shows the unreachable room · keeps D-055's gate (only a supported result admits), D-069's code-only logging rule for the message, D-077's shadow-account gating and SPEC §5 rule 2 (nothing branches on wallet identity)**

**Context.** `wallet_supportedWalletApi` is STRKWORLD's only capability
probe. Until now a probe that failed with anything but 162 (or with no code
at all) mapped to `unknown` or `unreachable`, and both showed "Cannot reach
your wallet" with "Try again". A connected wallet that does not implement the
method (JSON-RPC -32601, "Not implemented", "Unknown method", or no answer)
is reachable: it answered. Retrying cannot help, and the room told the player
the connection had dropped. Xverse is the likely first wallet to meet this
(the research found no public evidence that it answers the dapp-facing
Wallet API).

**Decision.**

- **Unsupported.** `capability()` maps a probe failure to `unsupported-wallet`
  when the wallet says the method is not there: code -32601 (JSON-RPC method
  not found), -32004 (EIP-1474 method not supported) or 4200 (EIP-1193
  unsupported method), anywhere down `error` and `cause`; a message, or a
  thrown string, matching "method not found", "unknown method/request",
  "unsupported method/request", "not implemented" or "method ... does not
  exist / is not available / not supported"; 162, as before; or an answer of
  `null` or `undefined`. The connect flow sends it to D-073's room, named by
  the picker's display name, with "Connect a different wallet".
- **Unreachable.** Only a failure with no wallet answer in it stays in
  "Cannot reach your wallet" with its retry: a dropped transport, a timeout,
  a popup closed without a 113, or an empty error. A code with a meaning of
  its own keeps it (113 is a declined connection, back to the connect room;
  118, 119, 120 as before), whatever its message says, and a cancelled query
  stays a cancellation. 163 and other unexplained codes keep their present
  `unknown` mapping and room.
- **Too old.** A probe that names versions, all below 0.10.3, is still
  unsupported, and the room now says so plainly: "{Wallet} is connected, but
  it reports Wallet API {version} and STRKWORLD needs {required} or later,
  so the city stays closed. ..." The required figure is
  `REQUIRED_WALLET_API_VERSION`, exported by `@strkworld/privacy`, which the
  shell copies as `REQUIRED_WALLET_API_LABEL` (a value import of the seam
  would pull starknet.js into the entry chunk; a test holds them equal). The
  separate "Wallet API x.y.z" line remains only for a 162 met after the city
  admitted the version.
- **Hostile errors.** The message is read only as an own data property
  (getters never run, proxy traps cannot escape), bounded to its first 512
  characters, and never kept or logged beyond what D-069 already records.
- **Shadow accounts.** Unchanged and now tested on every counter: a wallet
  at 0.10.3, or one whose commitment call answers 162 or -32601, passes the
  city's gate, and the Vault, Borrow, Exchange and Endur unstake counters
  say "doesn't support shadow accounts yet" with nothing asked or sent,
  while the pool routes (staking included) work.

**Consequences.** A wallet without the STRK20 Wallet API sees a room that
says so, whatever error shape it uses, as long as the shape says the method
is missing; a wallet whose answer says nothing about the method still sees
the unreachable room. Message matching is a heuristic over English text: a
wallet that words it otherwise, or localises it, falls back to unreachable,
which is the old behaviour. Not verified: no live Xverse has been probed.

---

## D-094 — Shield shows the wallet's public balance, and the pool fee goes on top of the amount

**2026-10-01 · Accepted (the owner's live test with Ready, and his rule: "if im shielding 9 strk it should shield 9 strk and then the fee should be taken separately") · supersedes D-072 in part (the Bank now reads a public balance; a STRK deposit's fee is added on top, so the "fee takes all" warning is gone) · amends D-013 (Max on Shield leaves only the pool fee behind) · extends D-036's frozen seam with `publicBalance` · changes no D-024 disclosure**

**Context.** On the Bank's Shield tab the balance card showed the PRIVATE
pool balance ("0 STRK", with D-091's settling note) while the wallet held
29 STRK public: a shield spends public funds, so the figure was the wrong
one. Then the owner shielded 9 STRK and thought the funds had gone. On
mainnet (tx `0x6d1a6aeff1411bc1613fe74b5507ba683ae0090f0228e931662c0d194786bcb`)
the account deposited 9 STRK, the pool withdrew its 6 STRK fee to avnu's
relayer (which also paid the network fee) and opened a note of about
3 STRK. Nothing on screen said so.

**Decision.**

- **The public balance (extends D-036).** `PrivacyOperations.publicBalance(token,
  signal)` answers the connected account's ERC-20 `balance_of` in base units,
  read over the wallet's own RPC (`VITE_STARKNET_RPC_URL`, the node the wallet
  account and D-084's Pragma check already use) by `RpcPublicBalanceReader`:
  never STRKWORLD's backend or the lobby, nothing cached, nothing logged. It
  asks no wallet, so the Shield control reads it when it opens, when it is
  reopened or its token changes, after a shield, and on Refresh. The demo
  fake answers `publicBalances` or a DEMO 1,000-unit figure. The seam has
  nineteen methods.
- **The Shield tab** shows "Wallet balance: 29 STRK" on its field, never the
  pool balance or the settling note, which stay on Unshield, Send and Stake.
  While D-035's gate holds, the card is still the private balance check.
- **The fee goes on top.** A shield's amount is what reaches the pool. A
  shield in the pool's fee token deposits `amount + poolFee`
  (`shieldDeposits`, used by the adapter at confirmation with the fee read at
  prepare; the existing fee ceiling still refuses a fee that rose). The fee is
  paid once per transaction, so only the first STRK shield in a batch carries
  it. Another token's shield deposits its amount unchanged: the fee is STRK
  and where a wallet takes it from then is not established. The form and the
  review show "You shield 9 STRK · Pool fee 6 STRK · Total from your wallet
  15 STRK"; the public-leg warning names the 15 STRK deposit; an amount whose
  total exceeds the wallet reads "Insufficient STRK"; a shield no more than
  twice the fee gets a nudge that the fee is fixed. The entry gate's STRK
  deposit follows the same rule.
- **Max on Shield** is the wallet balance less the pool fee and any shield
  already queued. No network reserve is held back: on the measured shield the
  relayer paid the network fee out of the pool fee, so only the deposit left
  the wallet. A wallet that pays its own network fee would refuse the shield
  before sending anything, and since every private action pays its fees from
  the pool, D-013's stranding trap no longer applies.
- **After a shield** the receipt adds "Your wallet's shielded view shows the
  new funds after about 20 seconds, once they mature." (the owner's
  observation; notes mature about ten blocks after they arrive).

**Consequences.** The Bridge's planned shield (D-061) now reaches the pool
whole; its reserve still covers the fee. Every other flow already took the
fee from the pool balance on top of the typed amount (unshield, send, stake,
unstake and claim, Vault supply and redeem, borrow and repay, swap), so none
changed. Not verified: a shield from an account that already holds STRK in
the pool (a wallet could then take the fee from those notes, and more than
the amount would arrive), and any wallet other than Ready.

---

## D-095 — The avatars pass a clipping check in every pose, and avatar 2/10 is a cat girl

**2026-10-01 · Accepted under the lead's avatar brief (fix the green character's outfit clipping when he switches mode; turn the engineer into a cat girl) · amends D-059's procedural figures (presentation only) · changes no opaque key, lobby field, seam or financial meaning · the 2D sheets (D-049, D-052) stay the colour reference, but avatar 2/10's 3D look now adds ears, tail and face marks they do not have**

**Context.** "Mode" is the F outfit toggle (D-053): cosy `avatar-N` and fighting `avatar-N+8`. The green character is character 7, the large moss-haired woodsman (`avatar-7`, fighting `avatar-15`). In his fighting outfit his mop hair, built up to the crown as for a bare head, came out through the horned helmet's tapered dome and its bevelled corners: a green band round the helmet from every side. Looking for the same kind of fault in every look, in every pose, found more: thighs swinging out through the front of the hip band (the band rides on the torso, which bobs, leans and twists, while the legs turned about a point above its hem), arm tops rising into the head and out through pauldrons and mantle shoulders, the beard into the fur collar, long hair into the arms, weapons through heads, helmets and pauldrons, and hands, heels and boots into cloaks, coat tails and the robe at a sprint. The lead also asked for the engineer to become a cat girl. The owner identified her from an in-game screenshot: orange-red hair swept up in a side ponytail, brass goggles on the forehead, an olive work jacket and dark green trousers. That is character 2, the "Workshop Courier" mechanic (`avatar-2`, fighting `avatar-10` with the hand wrench), matched by rendering her beside the screenshot. Character 6, briefly made the cat girl on this branch, is back to her original look.

**Decision.**

- **A clipping check is part of the suite.** `packages/world/tools/avatar-clipping.ts` poses each of the sixteen looks through its own `update()`: four moments of a breath at rest and sixteen frames each of a settled walk and sprint stride. Every box of every part is sampled. Where two parts that move against each other cross, the seam between them is a clip if it is uncovered and some camera direction can see it (the street's 28° and the roof's 74° pitch, at eight yaws). The exceptions are the joints built as sockets: the hip band, a robe's bell, collars, pauldrons, mantle and cloak yokes hold the limb or head that passes through their open top or bottom face, and nothing may come out through another face. Hair may not stand outside a hood or helmet where headwear lies directly below it, and no hair under headwear may be seen at all from any view (sixteen yaws at every 15° of pitch from level to overhead, the head on its own), except the hair built to frame the face inside a hood's opening (`hair-face`). The tolerance is one pixel at the street camera (0.011 units: 12 units span a 1080-pixel view). `avatar-clipping.test.ts` requires no findings for every look and shows that the check finds an arm swung through the body, a thigh swung out of the hips and a head sunk into the chest. `PartBuilder` records each box's tag and socket on the part geometry (`avatarPartBoxes`); nothing at runtime reads it.
- **The fixes are geometry, not hiding.** Hair under a helmet stops inside its rim and keeps clear of its bevels, and its nape hair ends inside the neck guard; the helmet's cheek guards now run back to the neck guard and rest on the head, closing the side gap where a square of green hair showed in back and three-quarter views; a fringe under a hood starts lower. The legs swing from 0.1 below the hip line, under the band's hem, and the band is as deep as the shirt, so a thigh never sweeps out of it. Arms hang outside the torso's outermost layer (`torsoFlare`: a coat, a closed robe's belt, a full chest plate, a cloak's yoke) and end in a shoulder that narrows front to back, below the head. The head takes back a quarter of the body's lean, not 0.6, so its chin never dips into the shirt. Collars, scarves, yokes, pauldrons and mantle shoulders were resized and moved so their sockets hold what they hold; a bearded look's fur collar sits below the chin and behind the beard, which now hangs in front of the chest. The cloak hangs further back and steeper, the knee coat's back tail steeper, long hair narrows below the head, and a long robe shortens the stride to 0.58 of everyone else's. Weapons lean out from the body (staff, halberd, mace, wrench), the sword's grip stays in the fist, and the crossbow is carried upright and short.
- **Avatar 2/10 is a cat girl.** Cat ears in her hair's orange, with paler peach inner ears, stand up through her hair beside the side ponytail and lean out a little; a short tail curls up from the small of her back to a pale tip; her cheeks are blushed and she has a small `w` cat mouth. She keeps her identity: the side ponytail, brass goggles on her hairline, olive work jacket, dark green trousers, belt and work gloves; fighting, the hand wrench. The look is cute and non-sexualised: same body, same clothes, no paw gloves or costume pieces. Ears, blush and mouth are boxes in the head geometry, the tail in the torso's, so they turn and nod with the head and lean with the body; the tail does not sway on its own, which would need its own mesh.
- **Keys and budgets stay.** `avatar-2` and `avatar-10` are the same keys, so saved and synced looks still resolve. Every figure is still seven meshes on one material, about 14 draw submissions with shadows (D-086); the cat girl is 952 and 1,016 triangles (from 688 and 752), the most is `avatar-12` at 1,036, and the test allows at most 1,100. There is no avatar name label anywhere; the look registry's comment names her.

**Consequences.** Every look moves a little: arms sit up to 0.032 further out where a coat or plate is worn, legs swing a shorter arc from lower down, the walk's stride reads slightly shorter, and the default figure's walker strip (D-058's cue) is regenerated. A new piece of gear or a new pose has to pass the check, or be built as a socket for what it holds. The check covers the figure against itself only: not other players, props or the world, and not the Studio's camera at closer zoom. Visual acceptance in the browser stays with the lead.

## D-096 — Every fighting look is a change of clothes: SAO-inspired adventurer gear, one archetype each

**2026-10-01 · Accepted under the owner's brief ("only a few of the characters in the fighting stances change clothes … make them all do it … take inspiration from Sword Art Online for alternate clothes") · amends D-059's procedural figures and D-095's looks (presentation only) · changes no opaque key, lobby field, seam or financial meaning · the everyday looks `avatar-1..8` are unchanged, geometry for geometry · drops, for the 3D fighting looks, the 2D handoff's rule that "cosy and fighting states preserve each character's hair and clothing palette" (`assets/player-sprites/v1/README.md`); hair, skin and face are still shared by construction**

**Context.** The F toggle (D-053) swaps `avatar-N` for `avatar-N+8`. Of the eight fighting looks, four were the everyday outfit plus a weapon and nothing else: `avatar-10` (the cat girl, hand wrench), `avatar-11` (crossbow), `avatar-13` (orb staff) and `avatar-14` (giant wrench). Two more kept the everyday clothes and added one piece: `avatar-9` leather pauldrons and a sword, `avatar-16` a gold chest plate and a sword. Only `avatar-12` (steel plate, kite shield, mace) and `avatar-15` (horned helm, bronze plate, halberd) changed clothes.

**Decision.**

- **Each fighting look is its own outfit**, fantasy-MMO adventurer gear in the spirit of Sword Art Online's, not a copy of any named character's costume, in the figures' blocky low-poly style and non-sexualised: `avatar-9` the swordsman (a long charcoal battle coat with teal trim and a high collar, fingerless gloves, steel greaves, a sheathed sword on the hip and one in hand); `avatar-10` the rogue (the cat girl in a sleeveless slate jerkin with an olive cowl, orange straps, bare arms to long fingerless gauntlets, a dagger; goggles, ears and tail kept); `avatar-11` the archer (a moss-green hood and hooded cape over a leather jerkin, a quiver, a longbow); `avatar-12` the guardian and `avatar-15` the berserker, unchanged; `avatar-13` the mage (a midnight-indigo robe trimmed in her gold, a cream high collar and long gloves, a crystal-orb staff); `avatar-14` the smith-warrior (a steel cuirass trimmed in her orange, copper pauldrons over teal, steel boots, goggles kept, a war hammer); `avatar-16` the guild knight (a white uniform coat with gold trim over navy, a steel chest plate, pauldrons, greaves, a longsword).
- **Identity stays with the character.** Face, hair, skin, build, the cat girl's ears and tail are the shared `character` object as before; each outfit carries the character's signature colours as accents (the swordsman's teal, the cat girl's olive and orange, the ranger's cream, the scholar's gold, the mechanic's orange and teal, the duellist's navy). `avatar-looks.test.ts` requires at least three of the five garment colours and the gear to differ in every pair, and no two fighting looks to share their set of gear and weapon kinds.
- **New pieces, all boxes in the existing seven meshes:** gear `collar` (a standing collar, a neck socket), `fingerless` (the fist's last 0.05 is skin), `greaves` (a shin plate and knee cop), `quiver` (on the back, below the head's overhang), `sheath` (on the left hip, angled 0.95 back), a `long` coat whose tails reach the calf and hang further back and out; weapons `dagger`, `bow` (upright at the side, short enough to clear the ground, carried as steadily as a staff) and `hammer`.
- **Budgets hold.** Every look is still seven meshes on one material; the fighting looks are 1,000, 1,088, 880, 1,036, 856, 984, 896 and 976 triangles (`avatar-9..16`), within the test's 1,100. The cat girl is the tightest: her ears, face marks, tail and goggles cost 316, so her outfit is mostly colour, straps and a collar.
- **The clipping check (D-095) passes for all sixteen looks** in all 36 poses and every view. Two limits it found are now rules: greaves only fit the standard build (a small build's shin is too short; a large build's thigh at a sprint lifts their front into the hip band), and a weapon held in a pauldroned arm has to lean well out (the hammer leans 0.9) or its haft passes out through the pauldron.

**Consequences.** Pressing F now always visibly changes clothes. The everyday looks, and with them the loading walker (`avatar-1`, D-058), are byte for byte the same, so the walker strip is not regenerated. The 2D sheets stay the colour reference for the everyday looks only. Visual acceptance in the browser stays with the lead.

---

## D-097 — Space makes the avatar jump: cosmetic, and synced to the peers who see it as a byte counter on the presence entry

**2026-10-02 · Accepted under the lead's brief ("add a jump to STRKWORLD characters on the Space bar") · extends D-011's frozen `PresenceState` with one field, `jumps`, and D-047's `WorldEvents` with `player:jumped` · adds one lobby verb, `jump` · builds on D-086 (no extra message to observers, no view resync) and D-087 (area isolation by the existing views) · presentation only in the World (D-059) · no D-024 disclosure changes: nothing financial is added**

**Context.** The lead asked for a short, snappy jump on Space that works standing, walking and sprinting, that peers in the same presence area see, and that never touches tile movement, collision or input ownership. Space was already a World-captured key (`dom-keyboard.ts` swallowed it while the World owned input, so the page never scrolled) but bound to nothing: the football kicks, the sandbox and the plaza are all E (D-060, D-076, D-078), the outfit is F (D-053), the Avatar Studio selects by walking onto a figure, a room's counters open by walking up to them, and every panel input is behind the input gate. So there was no binding to move.

**Decision.**

- **Feel** (`packages/world/src/jump.ts`). 500 ms in the air on a parabola peaking 0.6 units above the feet; a 0.12 vertical stretch on take-off easing out over the first 35%; a tuck at the top (legs swing up 0.42 rad, arms lift out 0.55 rad); a 0.14 squash for 110 ms after landing. Then a 150 ms cooldown: one jump at a time, no double jump, and a press in the air or in the cooldown is dropped, not buffered. A held key's repeats do nothing. The figure is lifted by the presenter on top of whatever it stands on (pavement, a sandbox stack, the roof); the camera follows the feet's surface, not the hop. A soft contact disc stays on the ground under a jumping avatar and shrinks (to 0.55) and fades as it rises; it exists only while in the air, outside the figure's seven meshes (D-095).
- **Cosmetic only.** The session never changes position, velocity or collision for a jump: a walk or sprint during a jump covers exactly the same ground (tested).
- **Input ownership.** Space jumps only while the World owns input: never while the input gate is suspended (a panel, Menu Mode, a Shell claim), never while a room's controller has handed control to the Shell (`control-owner` 'shell'), never in the Avatar Studio, and never from a keystroke aimed at a text field (the keyboard already ignores those; a suspended keyboard also stops capturing Space, so a focused button or input gets it natively). Inside a private interior the jump plays for the player alone.
- **Reduced motion.** With `prefers-reduced-motion`, read at take-off: a 0.3-unit hop, and no stretch or squash (the tuck stays). Peers' jumps follow the viewer's own preference.
- **Sync: a byte counter, not an event.** `PresenceEntry.jumps` (`uint8`, wraps at 256). The client sends `jump` with no payload; the room bumps the sender's own counter. Because the field rides the entry, Colyseus's per-observer views (D-086's interest management, D-087's area filter) decide who hears it: exactly the observers who already see the jumper, in the same area and radius, and nobody else, with no new broadcast path. It costs an observer 4 bytes in the next patch (2 if the jumper also moved in it); an observer who does not see the jumper gets nothing. A peer met mid-session takes its counter as a baseline and does not jump on sight. A counter survives a missed patch, where a one-shot message would need its own fan-out and could not be view-filtered by the encoder.
- **Rate.** The room accepts at most one jump per 400 ms per session (`JUMP_MIN_INTERVAL_MS`, strict); the client holds itself to 450 ms; the World itself allows one per 650 ms. Moves, sandbox actions, kicks and jumps together stay under the 40-message ceiling (20 + 5 + 3.3 + 2.2 a second).
- **Where it is accepted.** Live on the street or the roof. Refused (silently) while suspended, from the Studio, and for an unknown session. The Shell forwards `player:jumped` to `LobbyClient.jump()` while connected; the client itself sends nothing while suspended or in the Studio.
- **Privacy (D-011, D-024).** One byte that counts presses of a cosmetic key: no time, no target, no money, no wallet data, nothing about a building. Only the room writes it. An observer learns that a player it can already see pressed Space, and nothing else.
- *Amended 2026-10-02, at the owner's request ("make the height of every character's jump about the height of a block … all characters just need a bigger, longer held-height jump"):* the arc peaks at `JUMP_HEIGHT` = `SANDBOX_STEP_HEIGHT` × `SANDBOX_BLOCK_HEIGHT` + `JUMP_CLEARANCE` (0.15): 1.15 units with one-unit blocks. It is derived from the block height, never written down. `SANDBOX_BLOCK_HEIGHT` is a new shared constant, and the 3D sandbox draws its blocks at that size. The feet stand at the figure's root for every build: the body scales about them and the tuck only lifts them. So the small, standard and large builds' feet all clear a one-block stack at the apex (measured on the real geometry: 1.17 units for each). Air time is the new shared `JUMP_AIR_MS`, 800 ms, on an eased arc (`jumpArc`): a quadratic ease-out rise over 43% of the air, a 14% hold at the peak, then a mirrored ease-in fall. About 30% more of the air is spent within 10% of the peak than a plain parabola spends there. The tuck follows the arc, so it is held through the hang; the stretch (first 35%), the landing squash, the cooldown (150 ms) and the shadow's shrink (to 0.55 at the peak) are unchanged, and all scale with the new arc. Reduced motion keeps its 0.3-unit hop over the same 800 ms. Peers play the same arc. **Rate:** the room's floor is now the whole air time (`JUMP_MIN_INTERVAL_MS` = `JUMP_AIR_MS`, 800 ms), so two accepted jumps never overlap; the client holds itself to 850 ms; the World allows one per 950 ms (air plus cooldown). The message budget becomes 20 + 5 + 3.3 + 1.2 a second, against 40. Tests: the apex derived from the block height, the air time, the eased arc and its hang (`jump.test.ts`); every look of every build clears a block at the apex, standing and sprinting (`avatar-figure.test.ts`); the floors (`lobby jump.test.ts`, `jump-room.test.ts`).

**Consequences.** Tests: the arc, the pose and the state machine (`jump.test.ts`), the session's gating and that movement is unchanged (`world-session-jump.test.ts`), Space on the keyboard (`dom-keyboard.test.ts`), the local and a peer's jump in the presenter (`presenter.test.ts`), the counter's validation (`remote-peer.test.ts`); in the lobby, validation, the floor, the Studio refusal, area isolation and the 4-byte patch (`jump.test.ts`), the field set (`privacy.test.ts`) and the real wire, where a street jump reaches the street and a roof jump the roof and neither reaches the other or the Studio (`jump-room.test.ts`). The "Getting started" card lists "Space: Jump". Not verified: a real browser's feel and frame pacing, which stay with the lead.

---

## D-098 — The plaza shows the pool's total once, in place of the 24-hour deposit count

**2026-10-02 · Accepted under the owner's brief ("on the Privacy Plaza, instead of 'Deposits in the last 24 hours', just show the total dollar amount in the pool") · extends D-076 and D-080 · amends D-011's shared seam: `plaza:stats` loses `deposits24h` · registers no route (D-020)**

**Context.** The monument had three figures: accounts, deposits in the last 24 hours, and a "held in the pool" die face that cycled the USD total (D-080) and then each top holding. The window listed the same figures. So the total was already on screen, only as one frame of a cycling face and as the panel's "Held in the pool" row, and the owner wanted it as the plaza's headline in place of the deposit count.

**Decision.**

- **One place per figure.** The shaft's second face (the old deposit count) now reads the compact total, e.g. "$1.18M", captioned "TOTAL IN POOL". The die's face stops carrying the total and cycles the top holdings alone, captioned "TOP HOLDINGS", so the total is not shown twice on the monument.
- **The window** drops the deposit row. Its former "Held in the pool" row is now "Total in the pool" (compact, exact on hover), so the total appears once there too, above the top holdings.
- **The client no longer reads `deposits24h`:** `PlazaStatsPresentation`, `plaza:stats`, the web's `PoolStatsSnapshot` and parser, the demo figures and the poller's "incomplete" test all lose it.
- **The backend still computes and returns `deposits24h`.** Removing its `Deposit`-event scan touches the cache, the API and their tests, and nothing else uses it; the web parser ignores the field. It can be removed later without a client change.

**Consequences.** The plaza's headline is the pool's size in dollars, which is what a visitor can read without knowing what a deposit is. The die's face shows "…" until the top holdings arrive, even when the total is known; the total has its own face. No privacy claim changes: every figure is still a public pool-wide aggregate.

---

## D-102 — The Borrow counter reads its figures on opening, shows the collateral held, and every Max is a real one

**2026-10-02 · Accepted under the owner's live-test report ("the borrow tab doesn't show the amount you have supplied, and the max doesn't show the max you can borrow when pressing it; you need to guess how much you can borrow") · amends D-083 (the counter no longer waits for the player's request to read loans) · extends D-089 (a collateral Max from the pool balance, and "Available to borrow" always says a figure or why not) · keeps D-083's separate `strkworld-borrow` account and every seam check · no seam, register, World, lobby or backend change · D-099 to D-101 left free for branches in flight**

**Context.** On mainnet the owner had just supplied in the Vault, opened BORROW and found no collateral, an "Available to borrow" of 0 and a Max that did nothing. Three things stacked: the Vault's supply sits on the Vault's own stand-in (`strkworld-vault`) and is never collateral for a loan, by design (D-083: supply and loans on different public addresses); the form had no collateral line, so nothing said what was held or where collateral comes from; and every borrow figure waited for the "Show my loans" press, after which an empty collateral field gave a 0 with no reason.

**Decision.**

- **Read on opening.** Once the door is open and the wallet speaks shadow accounts, the counter reads Vesu's pool (backend, public), then the loans (the wallet derives the borrow account's commitment and may ask), then the pool balances of the offered tokens with the pool fee (`wallet_strk20Balances`, which it may also ask for). One wallet request at a time, never two prompts together. A declined read is the player's answer: back to the button, nothing reported. After a submission both go back to unread, and pressing Back reads them again. With the door locked or the capability missing, nothing is read.
- **Collateral, plainly.** The borrow form shows "Your collateral: X" for the chosen pair (0 when there is none) and one line: "Your Vault supply is not collateral here. Add collateral below, from your pool balance." The collateral field shows the pool balance, and its Max is that balance (spendable where the wallet splits it, else the per-token total, D-089's rule) less the 6 STRK pool fee when the collateral is STRK, tidied. The Add collateral tab's field gets the same balance and Max. An amount over the pool balance reads "Insufficient {token}".
- **A real borrow Max.** Max borrows to a health of 1.25 (D-089) on the collateral held plus the collateral typed, so an empty field means the collateral already held. With none, the borrow Max is off and the field says "Add collateral first." with a **Max collateral** chip that fills the pool balance less the fee.
- **"Available to borrow" is always a figure or a reason:** reading your loans, read your loans first, add collateral first, price feed stale, not offered right now, none at a health factor of 1.25, Vesu has none to lend right now, or under Vesu's $10 minimum (with a hint to add collateral). `borrow-preview.ts`'s `borrowCapacity` names the reason; `maxBorrow` is its figure alone and unchanged.

**Consequences.** A player opening BORROW with a real wallet may see up to two wallet requests before the form fills; declining either leaves the button that asked before. The pool-balance figures stay in the window, are never logged, and are dropped after a submission. Tests: `borrow-machine.test.ts` (read order, a declined read, a locked door, the re-read after Back), `borrow-preview.test.ts` (every reason, and the figure equal to `maxBorrow`), `BorrowPanel.flow.test.tsx` (collateral line, pool balance, Max collateral, Max on held collateral, the floor reason) and Menu Mode's parity test. Not verified: a real wallet's prompts on opening, or a phone-width browser.


---

## D-103 — Each Bank and Vault tab is its own counter, doing one action; the visit queue is gone

**2026-10-02 · Accepted by the product owner (the approved counters plan) · amends D-030 and D-040 (Menu Mode no longer batches a visit: every counter, in either mode, does one action and confirms it) · amends D-063, D-085 and D-091 (STAKE and UNSTAKE are two counters, not one counter's two tabs) · amends D-077 (its one SUPPLY / REDEEM counter is now SUPPLY and REDEEM) · amends D-083 (its one counter of four actions is now BORROW and REPAY) · amends D-088 (the Bank's and the Vault's Menu Mode tabs are their four counters) · extends D-094's amount rule (typed amount moves, fee on top) to every counter, by the owner's standard · amends D-090 (the swap review's total is the amount sold plus the fees) · keeps D-024's disclosures, D-030's one grade per station and every seam check · supersedes SPEC §6's "batching is the only lever" for the shipped counters · no seam, register, lobby or backend change; the World gains stations, the Shell loses the Bank's transfer · its rooms' layout (four free-standing counters in a row along the north wall) is amended by D-104: the counters are built into the Bank's teller wall and Endur's booth, and the Vault's front desk and vault wall**

**Context.** The Bank had two counters (SHIELD / UNSHIELD with tabs, and STAKE with Stake and Unstake tabs) and its Menu Mode four tabs (Shield, Unshield, Private transfer, Stake) over a visit queue: "Add to this visit", "Nothing queued yet", and "settles as one action, so you pay the pool fee once". The Vault had SUPPLY / REDEEM with two tabs and BORROW with four. The owner asked for one action per counter.

**Decision.**

- **The Bank's four counters,** a teller line along the north wall, west to east: **SHIELD** (`bank:shielding`, public wallet to pool, with the wallet balance and "You shield X · Pool fee 6 · Total Y" of D-094), **UNSHIELD** (`bank:unshielding`, pool to the connected wallet by default with "Send to another address", #173), **STAKE** (`bank:staking`, Endur) and **UNSTAKE** (`bank:unstaking`, the request, the pending list and the claim of D-085, behind both unstaking routes). SHIELD and UNSHIELD keep the Bank's look; STAKE and UNSTAKE wear Endur's.
- **No private transfer in the Bank.** The Post Office is the one place to send privately; its counter and Menu Mode window are unchanged.
- **The Vault's four counters,** laid out the same way: **SUPPLY** (`vault:supply`), **REDEEM** (`vault:redeem`), **BORROW** (`vault:borrow`: borrow, and add collateral, with D-102's collateral line and Max) and **REPAY** (`vault:repay`: repay, and withdraw collateral). BORROW and REPAY drive the one `vault.borrow` route and its disclosure.
- **Ids.** Kept where the meaning held: `bank:shielding`, `bank:staking`, `vault:borrow`. `vault:lending` held supply and redeem, so it is renamed `vault:supply` and kept as an alias (`FIXED_ROOM_STATION_ALIASES` in the World, `STATION_ALIASES` in the Shell, one table checked equal by a test): an old id resolves, and locks, as SUPPLY, and is never published.
- **One action per counter, no queue.** "Review this action" checks the form, queues its one intent through the accumulator (which still validates the intent's shape, D-018, and now holds one) and prepares it. Back from the review, or from a failed prepare, drops the queued intent and leaves the form as typed; a submission empties it. Each action pays its own pool fee. The machine loses Remove and Clear; the accumulator's mixing rules stay as the shape gate behind it. A submission-uncertain failure empties the form with the queue, so acknowledging cannot replay it.
- **Menu Mode (D-088).** The Bank's tabs are SHIELD · UNSHIELD · STAKE · UNSTAKE and the Vault's SUPPLY · REDEEM · BORROW · REPAY, each the counter's own window (`CounterWindow`, the same component Game Mode opens). The first is always offered; the others only while their counter would open, so a counter a build leaves off is hidden, as D-088 hides it.
- **Gating.** Each counter resolves on its own route and switch: SHIELD on shield, UNSHIELD on unshield, STAKE on stake, UNSTAKE on unstake, SUPPLY and REDEEM on the Vault's, BORROW and REPAY on borrow. A counter whose feature is off stands locked in the room.
- **The owner's amount standard, at every counter.** The typed amount is never reduced by a fee; it is the amount that moves (audited from each machine to the actions `packages/privacy` builds). Every form and review reads, in this order, what you enter ("You shield / unshield / stake / unstake / send / supply / redeem / borrow / repay X"), what you get out directly ("You receive", the ≈ xSTRK or STRK estimate, "Supplied to Vesu", "Debt paid off"), the fees added separately (the pool fee, and a network fee where the seam or the wallet states one), and the total ("Total from your wallet" for a shield, "Total from your pool" otherwise, in each token it is paid in, e.g. "20 USDC + 6 STRK"; a redeem's and a withdrawal's total is the fee alone, since the amount comes out of Vesu). One kit component draws it: `AmountSummary` (`apps/web/src/panels/kit/AmountSummary.tsx`). A spend's amount field is checked against its balance less the pool fee when they share a token ("More than your pool balance once the pool fee is added"), and every Max leaves the fee aside; REPAY's Max is capped at what the pool balance less the fee can cover. The Exchange's review gains the same summary (its total is now the amount sold plus the fees); the Post Office's window is the Bank machine's and follows it. Exceptions, by design: repaying the whole debt withdraws a small buffer and returns the rest; redeeming the whole position redeems every share.
- **Draw calls.** Every counter's static desk and props share one lit and one self-lit mesh per room, and every approach halo one vertex-coloured mesh, each station painting its own slice; a station's own group keeps what its state changes (the status panel, the beacon, its label and any brand plate). Four counters cost the Bank 29 draw calls and the Vault 34, under the 40 budget (the Vault was 31 with two).

**Consequences.** A player does each action at its own counter and confirms it there, and two actions are two pool fees. The counter re-arm is the World's as before: stepping off every halo re-arms the counters, so walking back reopens one. Tests: the teller line, the alias and the per-counter activation and re-arm (`fixed-room.test.ts`), the shared-geometry budget (`room-builder.test.ts`), the registry's gating per counter (`station-registry.test.ts`), the single-action machine (`bank-machine.test.ts`), each counter's window without queue vocabulary (`BankPanel.test.tsx`, `VisitLayer.test.tsx`), the Menu Mode tabs for both rooms (`menu-mode-parity.flow.test.tsx`), the amount standard per counter (`amount-standard.flow.test.tsx`: typed amount equals the amount submitted, total equals amount plus fee) and the kit's `AmountSummary`, and the counters' flows (stake, unstake, unshield, supply, redeem, borrow, repay). Not verified: a real browser at phone width, and a real wallet at the new counters.

## D-104 — The Bank's and the Vault's counters are built into their rooms: a banking hall and a lending lounge

**2026-10-02 · Requested by the product owner ("make the interiors of the buildings and counters feel a bit more like they fit into the scene of each building ... more built into the scene, over just mapped onto two blocks on the floor") · amends D-103's room layout (a row of free-standing counters along the north wall) for the Bank and the Vault · amends D-059's room rule that every volume stands on a wall or station tile (fixtures join them) · keeps every station id, D-030's one grade per station, D-103's one action per counter and the approach, open and re-arm logic · World only: no Shell, seam, lobby or backend change**

**Context.** D-103 put four two-tile desks in a row in each room, each with a spinning beacon and a floating label pill. They read as kiosks set on the floor, the same in every building.

**Decision.**

- **Fixtures.** A room definition may name `fixtures`: rectangles of built-in furniture, solid like walls (`FixedRoomTile` `'fixture'`, `isFixedRoomSolidAt`), which the room's builder dresses. Validation keeps them strictly inside, off stations, pads, the spawn and lift arrivals, and walks the floor from the spawn: every station must keep an approach tile the spawn reaches (`unreachable-station`), and so must the door.
- **A counter's fit.** A station theme may name a `fit` (`teller`, `endur-booth`, `vesu-desk`, `vesu-booth`) and a `sign` style. A built-in counter draws its desk into the room's shared meshes as D-103's do, has no beacon (its status light, a lamp shade or a light strip in the state's colour, is its one status mesh), and carries the Shell's label on a sign in the architecture instead of a floating pill. Its approach halo covers only the tiles a player can stand on to open it.
- **The Bank, a banking hall.** A walnut teller wall runs the width of row 3 with the tellers' back office behind it. SHIELD (x 5-6) and UNSHIELD (x 11-12) are teller windows in it: marble top, brass-framed glass with a grille and speaking ring, the STRK20 terminal behind the glass, a brass ledger lamp whose shade shows the state, and a gilded sign in the header. Between them, on the hall's axis where the runner from the door ends, a central bay opens neither: STRK20's vault emblem, STRK20 on the header and a clock in a pediment edged in the facade's orange light. STAKE (16, 5) and UNSTAKE (16, 8) are the two windows of Endur's partner booth on the east wall, in Endur's light look, each under a green blade sign that faces the camera, with Endur's name once on the booth's south end. A bench stands on the west wall. The room stays near-black with STRK20's orange.
- **The Vault, a lending lounge.** SUPPLY (x 3-4) and REDEEM (x 7-8) are the two places at a long white front desk, each with Vesu's supply card on a screen and the V beside it, under a lit header beam carrying their blue signs and `vesu`; Vesu's avatar hangs behind the desk between two posts. BORROW (x 11-12) and REPAY (x 15-16) are loan booths in a tall vault wall either side of a round vault door (blue-lit rim, wheel, the V on its hub, safe-deposit lockers over it): a niche, a counter, glass, the loan card on the officer's screen, a lit sign in the lintel.
- **Budgets.** One more mesh per room for the windows' glass; built-in counters drop their beacons and brand plates. The Bank goes from 29 draw calls to 26 and the Vault from 34 to 28 (budget 40); triangles from 3,636 to 9,274 and from 9,759 to 13,673.

**Consequences.** The counters open as before (walk onto the strip in front, walk away to re-arm), from the hall only. Tests: fixtures and their validation (`fixed-room.test.ts`), the built-in counters, signs, halos and the hall and lounge (`room-builder.test.ts`), the room themes (`vesu-mark.test.ts`), and the walkable-floor and budget checks over every room. Rendered offline only (`renders/int-bankvault-*.png` in the working scratchpad); not yet seen in a browser.

---

## D-105 — The Exchange, Degen floor, Post Office and Bridge counters are built into their rooms; furniture is solid `fixture` tiles

**2026-10-02 · Accepted under the owner's interiors brief (counters that fit each building's scene) · art and level design, no product, privacy or seam change · amends D-059's interiors (the floor carries solid furniture, not only flat inlays) · keeps D-039's station ids, rects, approach and arming, D-042's and D-067's counters, D-040's Post Office counter and D-030's one grade per station · keeps D-103's shared counter and halo meshes · builds on D-104's fixtures (the Bank and Vault's half of the same brief): one solid-tile mechanism, D-104's field, validation and error codes**

**Context.** The owner found the counters "aesthetically nice" but the same two-tile box mapped onto every floor, with a floating pill over it. He asked for setups built into each building's scene.

**Decision.**

- **Solid furniture is D-104's `fixtures`.** These floors author their furniture as D-104's fixtures (`fixture` tiles, solid in `isFixedRoomSolidAt`, so the session's collision honours them), under D-104's validation and codes (`invalid-fixture`, `unreachable-station`). D-105 adds one optional field: a fixture may name a `prop` (`trading-pod`, `high-table`, `pillar-box`, `writing-desk`, `bench`), free-standing furniture drawn on the floor's own meshes at no draw call; an unknown prop is an `invalid-fixture`. A fixture without one belongs to a counter.
- **The counters,** each closed at its back and sides by its furniture, so only its front row is its approach:
  - **Exchange SWAP (avnu):** a trading desk across the north-east corner on a raised pit, the counter its middle bay, in front of a wall of boards (candlestick charts, avnu's swap card, quote rows; bars and lines only), with the room's ticker running on above it. Two traders' pods stand on the floor.
  - **Degen floor DEGEN SWAP:** a back-room booth set into the poster wall between the posters, pink and violet neon up its partitions, the DEGEN MODE sign over a back bar of neon chip stacks, and a black bar across its mouth. Two neon high tables stand on the floor.
  - **Post Office TRANSFER:** a long wooden counter across the north-west corner with an airmail border, brass grilles and one open service window with the scale and a parcel, SEND on the fascia above it between airmail stripes, a red stamp machine at its east end, and the sorting room behind (pigeonholes, a sorting table, a mail sack). A pillar box and a writing desk stand on the floor.
  - **Bridge DEPOSIT (NEAR):** a gateway after the facade's pylons, a green light cable up each, a departure board on its lintel (rows of flap cells lit in shapes, never letters or figures) and a portal of nested teal and green frames behind the terminal. The route map on the north wall runs through it, chains on a card west of it, Starknet on a card east. Two rows of lounge seats face it.
- **The label is the architecture's.** These counters paint the Shell's label on a sign of their own (the desk's gantry, the booth's lintel, the window's enamel ticket, the departure board's header), with no floating pill; the label still follows the Shell's text and state. As D-104's built-in counters, they have no beacon: the state colour lights the architecture (the gantry's posts, the lintel's underline, the window's service lamps, the portal's nearest frame). The halo lies only on the approach tiles a player can stand on.
- **Budget.** Draw calls, counted as the room budget test counts them, against main before this change: Exchange 20 → 19, Degen floor 30 → 29, Post Office 14 → 15 (the SEND sign and the stamp machine's lit window, less the beacon), Bridge 20 → 19, all under 40.

**Consequences.** A player can no longer walk behind or through these counters or their furniture; D-104's validator keeps every counter reachable, and a test walks each of these floors to every counter, lift and the exit. The Bank and Vault rooms are D-104's. Tests: `fixed-room.test.ts` (props, the authored rooms' reachability), `room-builder.test.ts` (signs over the windows, halos on standing tiles only, furniture on its fixtures, props, colours, budget, no volume on walkable floor), `world-session.test.ts` (no step into a counter's furniture). Renders from the offline rasterizer in the working scratchpad (`renders/int-others-*.png`, not committed). Not verified: a real browser.

---

## D-106 — Jump to climb: walking never steps up, a jump near its peak climbs one block, and the lobby holds it to the jump it heard

**2026-10-02 · Accepted by the product owner ("auto-climbing the blocks should not be standard: a user must jump up the block … a character near the peak of their jump should always be able to jump on top of a block … a general rule for jumping on stuff going forward") · amends D-060 (stepping up one block no longer happens by walking) and D-097 (the jump stays cosmetic for the ground position but now gates a step up) · extends D-011's shared seam with `CLIMB_FROM_PHASE`, `CLIMB_WINDOW_MS` and `PLAYER_BODY_SIZE` (constants only) and the World's `SandboxChannel` with an optional `subscribeResync` · adds one server-to-client message, `resync`, and the move outcome `refused` · builds on D-086's move bucket · no D-024 disclosure change: nothing financial is added**

**Context.** Since D-060 a body touching a stack one block higher was lifted onto it, so walking climbed staircases on its own. D-097 added a jump on Space but left it presentation only. The owner wants the jump to be the way up, generously enough that a smaller hop still makes it, as a general rule for raised surfaces. An audit of the World found one kind of raised walkable surface: sandbox stacks. Everything else that stands above the ground is a solid fixture (the plaza monument and its steps, tables, benches and planters, the pitch's stand, bleachers, goals and floodlights, every room counter and prop), the pitch's boards are a knee-low kerb at elevation 0, and the Exchange roof is reached by its lift, a teleport. There are no stairs or ramps.

**Decision.**

- **Walking never steps up.** On any heightmap (today, the sandbox), a stack higher than the level the body stands on is a wall, exactly as tile collision is. Level ground and stepping down any height are unchanged. The step is simply blocked: no bump animation, no message.
- **A jump climbs one block, once.** From `CLIMB_FROM_PHASE` (0.35) of the jump's air time until it lands, the body may step up `SANDBOX_STEP_HEIGHT` (one block), once per jump (`JumpState.canClimb`, `stepOnHeightmap`'s `climb`). The window is judged on the jump's normalised phase, never its height: reduced motion's 0.3-unit hop and any future smaller or shorter jump clear the same block, rounded up onto it. At 0.35 the arc is at 91% of its height. A jump that started before reaching the stack climbs as it arrives, while still in the air. Two blocks at once stay a wall; from a one-block stack the next jump climbs the second.
- **The climb looks like a climb.** When the feet step up mid-jump, the hop onto the block starts from the top of the arc and the rest of the arc adds no lift, so the figure goes up onto the block and lands there without dipping, for the local player (presenter) and for peers (remote layer).
- **The lobby holds it to the jump it heard.** On the street, a move whose body (`PLAYER_BODY_SIZE`, overlap measured exactly as the World measures it, so the step is seen on the move the World made it) stands higher than at the held position is a step up. It is accepted only if it is one block, within `CLIMB_WINDOW_MS` (650 ms: 500 ms of air, plus the 50 ms move floor and 100 ms of jitter) of the session's last accepted `jump`, and that jump has not climbed yet. The climb is spent only when the move is written, so a move the bucket throttles is resent and still lands. A throttled jump opens no window; suspend, a change of area and leave drop it. Anything else is `refused`: the position stays and the move counts as rejected.
- **Resync.** After a refusal the room sends that client alone `resync` `{ x, y }`, its own held street position, at most once per `RESYNC_MIN_INTERVAL_MS` (250 ms). `LobbyClient.onResync` validates it (finite whole numbers in the world, own data properties), stops re-sending the refused position and delivers it while live on the street; the Shell's sandbox controller forwards it through `SandboxChannel.subscribeResync` while that client is the authority, and the World stands the player there again (eased when within two tiles, snapped otherwise) and allows no second climb in that jump. Solo play predicts the same rule and is never refused.
- **Help.** The "Getting started" card's Space line and its sandbox paragraph say a block is climbed with a jump.
- *Amended 2026-10-02, with D-097's block-high jump:* the window stays phase-based, from `CLIMB_FROM_PHASE` (0.35) of the air time to landing: 280–800 ms of the new 800 ms. The lobby's window is now derived: `CLIMB_WINDOW_MS` = `JUMP_AIR_MS` + `CLIMB_LATENCY_MS` (150 ms: the 50 ms move floor plus 100 ms of jitter) = 950 ms. The full jump's feet are already above the block top when the window opens (1.11 of 1.15 units at 35%). So a climb no longer hops: the ground rises under the jump, and the same arc carries on over the block, holding at the top and landing on it, never below the block top. This holds for the player (presenter) and for peers (remote layer). The hop from the top of the arc stays for a jump whose feet are below the block top when it climbs, such as reduced motion's 0.3-unit hop, which still climbs because the rule never reads the height. Tests: the climb allowed at 40% and refused before 35% (`jump.test.ts`, `world-session-sandbox.test.ts`); the window as air time plus latency, swept against the 800 ms air (`climb.test.ts`); the climb carried along the arc and the reduced-motion hop (`presenter.test.ts`, `remote-avatars.test.ts`).

**Consequences.** Climbing in multiplayer feels instant: the World predicts the climb and the room accepts the same move, since the jump message always precedes the climbing move on the socket. A step up made with no jump the room heard, made from a stack update the client had not yet received, or forged, is undone by a resync. Affected surfaces: the sandbox's stacks, including the entrance, where a one-block stack (the cap since D-060) now needs a jump to cross but can never wall the gate off; a player in a pit of one-block stacks jumps out. The street has no other surface to climb, so nothing else changed. The street still has no path check (D-087 kept its clamp), so a move may still cross stacks of its own height or lower in one step. Tests: the window and normalisation across every avatar, reduced motion and synthetic profiles (`jump.test.ts`); walls, one climb per allowance, clamping, two-block refusal, stepping down (`sandbox.test.ts`); the session's no-auto-climb, climb in the window, landed jumps, one climb per jump, step down and resync (`world-session-sandbox.test.ts`); the climb's visual for the player and peers (`presenter.test.ts`, `remote-avatars.test.ts`); in the lobby, refusal, body measurement, level ground, the whole client window with send delay and jitter, the latency edge, one climb per jump, two blocks, a throttled climb, a throttled jump, suspend and the resync throttle (`climb.test.ts`), the client's resync handling (`client-resync.test.ts`), the controller's relay (`sandbox-controller.test.ts`) and the real wire (`climb-room.test.ts`). Not verified: the feel in a real browser, with real latency.

---

## D-107 — A hidden room under the alley across from the plaza: a Tokyo net cafe left years ago, its lift out of order

**2026-10-02 · Requested by the product owner ("on the parallel side to the plaza, build a small opening to an underground bunker ... like a gaming cafe with stalls for PCs ... an elevator near the entrance stairs that is 'out of order' ... NOT to be labeled 'gaming bunker' in-game, and I don't want a sign outside") · extends D-011's shared seam with one `BuildingId`, `bunker`, kept out of `BUILDINGS` like D-076's `plaza` · extends D-059's street tiles (`stairhead`, `service`), D-104's fixtures (six D-105 props and `storage`) and stations (`reserved`) · keeps D-019 and D-087 (the room is a solo private interior), D-024 (no money) and every existing building's behaviour · World and seam only, plus one Shell copy key: no lobby, backend or privacy change**

**Context.** The owner wanted a small, unmarked way down to an underground room across the road from the Privacy Plaza (D-076): inside, a Tokyo gaming cafe with PC stalls, tight in parts, abandoned years ago but still modern, and an out-of-order lift by the stairs that will later lead to floors for games. The north side opposite the plaza (street x 0-10, counted from `STREET_ORIGIN_X`) is the Bank's front, with grass strips either side. Read in the Shell: the presence controller suspends on any `building:entered`, whatever its payload (`presence-controller.ts`). The visit controller, the window layer and the debug log drop any id not in `BUILDINGS` (`world-event-payload.ts`). The World's door trigger, fixed-room controller and presenter take any `BuildingId`.

**Decision.**

- **Where, and the easter egg.** A narrow concrete service stair in the alley between the Bank and the Exchange (street x 10-11, rows 5-10), across the road from the plaza's east edge. It takes three tiles: the top step `(10, 10)` is walkable (`stairhead`) and carries the door; the flight `(10, 9)` and a vending machine `(11, 10)` are solid (`service`). Down the flight a steel door stands ajar, with magenta and cyan neon leaking out of it, up the steps and a little onto the pavement, breathing slowly. The lit vending machine has no brand, no coin slot and no prices, and a calico cat sleeps on top of it. The only hints are shapes: a faded pink arrow stencilled on the top step and a small arrow sticker on the machine. There is no facade, sign, exterior label, door portal or name, so nothing on the street, in the HUD or in a window names the place. The pavements, the road, the plaza, the pitch, the sandbox, the Studio path and the spawn are untouched. The alley's mouth is now closed to the street, though its back is still reached from behind the buildings. Three draw calls in the street (83 to 86, budget 150), 1,136 triangles.
- **The id.** `bunker` is a `BuildingId` so its door is a `DoorZone` and its room a fixed room, but it stays out of `BUILDINGS`, `ACTIVE_BUILDINGS` and `SHIELDED_BUILDINGS`. Its door is added to the map after the Tiled door layer, whose loader admits only `BUILDINGS`. Entering emits `building:entered { building: 'bunker' }`. The Shell's presence controller then suspends presence (solo, D-019, D-087), and the sandbox and football controllers treat the player as away. The visit controller opens nothing: no window, no stations, no control claim, no Menu Mode. `COPY.buildings.bunker` is "…", so any title ever drawn for it is that ellipsis, never a name. The codename appears in code only.
- **The room** (`BUNKER_ROOM_DEFINITION`, 16 by 10). The stair comes down in the south-west corner onto a landing (the exit is the stair back up). The lift is right beside it, its approach one step north of the spawn, its shaft behind it, with junk stored behind that. A one-tile spine runs north past the shaft. Two one-tile corridors run east from the spine between rows of PC booths, into the one larger booth area in the east, which has booths along its north and east walls and two chairs knocked over. A one-tile lobby along the south passes the reception (a check-in desk, snack shelves behind it, the drinks fridge at its end) and waist-high manga shelves. There are 25 booths, each with partitions, a desk, a monitor (about half on, the rest dark or cracked), a keyboard and an office chair. The only words are generic Japanese: ネットカフェ, ゲーム and 受付 24H, plus the lift's paper. The abandonment sits over the modern fit-out:
  - dust, stains and paper on the carpet;
  - a ceiling tile fallen on the floor, and one hanging by a wire;
  - cables sagging from the trays above head height;
  - peeling posters and a breaker box hanging open;
  - one tube that stutters. Under reduced motion it holds steady.
  Every booth, the lift and the stair are reached from the spawn (the D-104 validator and tests).
- **The lift.** Station `bunker:elevator` is a D-104 built-in counter (fit `elevator`). It is a clean shaft in fresh paint with brushed-steel doors, and a floor indicator (1, B1-B4, B1 lit, a down arrow). The dim call button is its state light, with a service tag hanging from it. The protective film is still on one door, and cones, a striped bar and a red toolbox stand in front. Its label is the hand-written paper taped across the seam: 故障中 / OUT OF ORDER. It is `reserved`: always locked, whatever a `world:stations` snapshot says. Walking up to it highlights it and floats "Out of order" over it, and nothing else happens. Its id is held for the floors to come.
- **Budget.** 19 draw calls (14 meshes and 5 labels, room budget 40), 18,152 triangles. The booths, shelves and fridge are D-105 props on the floor's own meshes. The tube is the only light with materials of its own.

**Consequences.** A player who finds the stair walks down into a private room, and their avatar disappears from the street for others as in any interior. Later floors can give the lift a route by dropping `reserved` and adding levels (D-030's one-building rule applies). Tests: `bunker.test.ts` covers placement, the three tiles, no overlap, reachability, not a building or shared area, the room's reachability and tight corridors, and the reserved lift. `world-session-bunker.test.ts` covers entering and leaving, and the lift showing out of order only. `bunker-room.test.ts` covers the words, the paper and the prompt, the budget, the screens, the tube under reduced motion, and the booths. `bunker-builder.test.ts` covers the stair's tiles, no portal or label, three calls, the level step and the slow breathing glow. `visit-controller.test.ts` checks that nothing opens, and `presence-areas.test.ts` checks that it suspends. Renders come from the offline rasterizer (`renders/bunker-*.png` in the working scratchpad, not committed). Not verified: a real browser.
