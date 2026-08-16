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
