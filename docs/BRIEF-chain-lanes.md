# Brief — Chain, Backend and Bridge lanes

Hand this to the agent taking the blockchain half. It is written to be
self-contained.

---

You own the money half of **STRKWORLD**, a 2D top-down browser city where
buildings are Starknet privacy protocols. Real funds, Starknet **mainnet**.

Repo: `https://github.com/Calcutatator/STRKWORLD` — clone it, it is public.

## Before anything else

```bash
cd STRKWORLD && ./scripts/sync.sh
```

Several agents work in this repo simultaneously. That script shows what moved,
what is unpushed, which PRs are open, the newest decisions and findings, and
whether the invariants pass. **If it warns, resolve the warnings before writing
code.**

Then read, in this order:

1. `AGENTS.md` — the working agreement, the invariants, and the findings log.
   The findings log is traps already paid for; reading it will save you days.
2. `docs/DECISIONS.md` — every choice and why. **Newest wins**; an older entry
   that was never updated is not authoritative.
3. `docs/ARCHITECTURE.md` — boundaries and what must not cross them.
4. `docs/WORKPLAN.md` — your lane briefs.
5. `.agents/skills/strk20-wallet-api/` — vendored official STRK20 docs. Read
   these before the network; `strk20.starknet.io` is a client-rendered SPA that
   returns an empty shell to fetchers.

## Your lanes

| Lane | Package |
|---|---|
| **Chain** | `packages/privacy` — the STRK20 seam, the only package importing `starknet` |
| **Backend** | `apps/backend` — paymaster custody, RPC proxy, submission queue |
| **Bridge** | `packages/bridge` — NEAR Intents 1Click, deposit-only |

**Not yours:** `packages/world`, `packages/lobby`, `apps/web`,
`packages/world/assets`. Another agent owns the game and the shell. Do not edit
them; if you need something from them, raise it rather than reaching across.

## The architecture in one paragraph

The game runs **no privacy infrastructure**. No prover, no discovery service,
no viewing keys, no compliance relationship. It calls three RPC methods on the
player's wallet — `wallet_strk20Balances`, `wallet_strk20PrepareInvoke`,
`wallet_strk20InvokeTransaction` — and the wallet holds keys, discovers notes,
generates the proof, handles screening and submits. That is D-002 and it is
settled. `shieldup`'s prover and viewing-key derivation are reference
implementations for a path **we are not taking**; do not port them.

## First task — the Phase 0 spike

**Do this before writing production code.** A scratch page driving the three
methods against a real extension on mainnet with tiny amounts. Four questions
no document can answer, and the answers change design in lanes other than
yours, so publish them the day you have them:

1. **Does the shipped wallet honour the spec's "arbitrary contract" `invoke`,
   or does it allowlist targets?** This gates the Vault entirely.
2. **Does `strk20Balances` prompt the user?** It lists `USER_REFUSED_OP` among
   its errors. If it prompts per call, a live balance HUD is impossible and the
   shell's design changes completely.
3. **Does a 3-action array render one confirmation or three?** Batching is the
   only lever against per-action fees; if the wallet renders N prompts, it buys
   much less than we think.
4. **Real end-to-end latency**, and `get_fee_amount()` read live.

Two more the spec missed, from the official skill: does the wallet
auto-register on first use (which would make our whole `NOT_REGISTERED`
onboarding room unnecessary), and how does Ready's current batched
approve-plus-deposit transaction action actually render.

Write the answers into the findings log in `AGENTS.md`, with how you verified
them, and push.

## Then

**Implement `WalletApiPrivacyOperations`** against the interface in
`packages/privacy/src/operations.ts`. It is intent-based and two-phase:
`prepare(Intent[])` returns cost, warnings and prompt count; `confirm({feeCeiling})`
refuses to sign if the fee moved. `FakePrivacyOperations` already implements
the same interface with fault injection — the shell is being built against it,
so your implementation must behave the same way.

**The interface is SOURCE-DERIVED AND FROZEN** (D-036). A change breaks the
Shell lane, so it needs a decision entry and a heads-up before implementation,
never a quiet edit. Funded behavior remains a pre-launch validation under
D-028.

**Build the backend** (`apps/backend`, D-014). It holds the paymaster key,
proxies RPC reads, and owns the submission queue. Treat it as a privacy
component with the same seriousness as the lobby: it sees call, proof, IP and
timing before broadcast, which makes it a stronger correlation oracle than
anything else in the system. Written no-logging policy required.

**Bridge port and offline composition are complete.** The deposit-only 1Click
service, signed recovery record, manual Shell flow and fixed World room are in
place without the OUT direction or AVNU leg removed by D-012. D-043 exposes no
production Ready public-shield planner: only the deterministic demo can create
a new quote today, while saved/imported evidence remains inspectable,
refreshable and exportable without a wallet or planner. Settlement uses actual
validated `strkReceived`; shielding is a separate explicit Bank action with no
automatic submission or persisted Bridge correlation. The remaining route is
a funded/source-verification gate, not permission to infer Ready fee handling.

## Hard rules

These are defects if broken, even if everything appears to work.

- **Never branch on wallet identity.** No `wallet.id ===`, no allowlist.
  Capability is a runtime version query. This is what keeps web wallets and
  email login possible later without a rewrite.
- **Never source connectors from `@starknet-io/get-starknet-wallets`.** It is a
  hardcoded five-wallet registry; use `get-starknet-discovery`.
- **Never read balances to feature-detect.** It prompts the player for consent
  to data the app has no reason to see.
- **Never set `COOP: same-origin` / `COEP: require-corp`.** They break the
  popups web wallets use, and we do no in-browser proving.
- **Never expose a raw target/selector/calldata escape hatch to the shell.**
  The shell emits typed intents; you own the translation and the allowlist.
- **`packages/bridge` must never import `packages/privacy`.** Public rails
  behind a privacy-named seam is how a false claim gets made by accident.
- **Pin the connection stack as a set**, exactly: `starknet@10.4.0`,
  `@starknet-io/types-js@0.10.3`, `get-starknet-discovery@6.0.3`,
  `get-starknet-wallet-standard@6.0.3`. Never float one and pin the others —
  `npm install starknet` gives 10.0.2 with zero STRK20 and fails silently, and
  `get-starknet` at `*` resolves to a 5.x beta.

`./scripts/check-invariants.sh` enforces most of these. Run it before you
commit.

## The privacy approval gate

**Absolute privacy is the default.** Any route delivering less is a deviation
needing the project lead's recorded approval *and* plain-language disclosure to
the player, in `packages/shared/src/privacy-grades.ts`. An unapproved deviation
renders a **locked door**, never a silent downgrade. CI enforces it.

If you add an integration, you must state its grade. Run
`./scripts/privacy-report.sh` and take anything new to the project lead —
do not decide it yourself.

Grades, each mapped to a verified protocol property: `private` (parties and
amounts hidden), `anonymous` (parties hidden, **amounts visible** — open notes
carry plaintext), `public-edge` (actor and amount on-chain), `public`.

## Facts worth knowing before you start

- Pool fee reads **6 STRK** live, is governance-settable, and has already moved
  once. Read it at runtime; never hardcode.
- Pool deposits are **always to self** — no recipient field. The game cannot
  fund a player's shielded balance for them.
- Recipient registration **is** preflightable via the pool's
  `get_public_key(address)` over ordinary RPC, even though the Wallet API has no
  method for it. Unregistered returns `0x0`.
- Ready 5.33.8's shipped code puts the ERC-20 approval call(s) and pool privacy
  call in one wallet transaction action. Do not hardcode a two-prompt shield;
  record the visible sequence in the funded Phase 0 UI run.
- Notes mature ~10 blocks before they are spendable. Hardware-independent.
- Session keys are **architecturally blocked** — the pool requires
  `caller_address.is_zero()`, which `execute_from_outside` can never satisfy.

## When you finish anything

Commit and push, even mid-task. Record what you learned in the findings log
with how you verified it — a finding without a verification method is a rumour.
If you supersede a decision, edit both ends: the new entry says what it
changes, and the old entry's status line points forward. CI check 7 fails
otherwise.
