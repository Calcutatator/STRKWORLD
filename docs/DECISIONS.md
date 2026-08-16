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
