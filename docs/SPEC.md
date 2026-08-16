# Privacy City — Technical Spec & Feasibility

**A 2D top-down browser world where buildings are Starknet privacy protocols.**

| | |
|---|---|
| Date | 16 Aug 2026 |
| Route | STRK20 Wallet API |
| Network | Mainnet |
| v1 auth | Extension connectors only |
| Status | Pre-build |

---

## Verdict

**Feasible.** The game runs no privacy infrastructure — no prover, no discovery service, no viewing keys, no compliance relationship. The entire privacy surface is three RPC methods on the connected wallet.

Every interface in this document was read from packages installed from npm, not from documentation. `starknet@10.7.0` carries all four `strk20*` methods on `WalletAccountV6` and as standalone functions over `WalletWithStarknetFeatures`; `@starknet-io/types-js@0.10.3` defines the four action variants and the error codes; `@starknetfoundation/starknet-start-react@2.0.1` ships the three hooks plus a paymaster set.

The binding constraints are economic and procedural, not architectural: one wallet prompt per shielded transaction with no session-key mechanism, a per-transaction pool fee, a note-maturity wait before funds are spendable, and a registration step the game cannot perform on the player's behalf. Each has a design answer below.

---

> ### ⚠ Action required — rotate a credential
>
> A **Cairo Coder API key** was pasted in plaintext into the originating chat. Treat it as exposed and rotate it. It is deliberately omitted from this document and from all research artifacts, and must not be retrieved or reused.

---

## 1. Architecture

| Decision | Choice | Consequence |
|---|---|---|
| Privacy integration | STRK20 Wallet API | Wallet handles keys, note discovery, proving, submission, screening |
| v1 authentication | Extension connectors only | Extra prompts accepted. Email/social deferred — no web wallet implements the methods yet |
| Code target | `WalletWithStarknetFeatures` | Not a specific wallet. Web wallets register on the same feature surface, so email/social lights up with no code change when one ships |
| Network | Mainnet from day one | Real funds. No testnet phase |
| Game engine | Phaser 4 + Tiled + React overlay | **Embed tilesets on export.** Phaser rejects external `.tsx` — see §2 |
| Multiplayer | Colyseus, presence only | Street lobby. Never sees an account address |
| Gas | `strk20PrepareInvoke` + sponsor submit | Requires a small backend to hold the paymaster key |

### Why target the interface, not the wallet

In `get-starknet-wallet-standard`, `"starknet:walletApi"` carries a generic `request` over the whole RPC map — `wallet_strk20*` is not a separate feature, it rides the same channel. Cartridge already proves a non-extension wallet can register this way, wrapping a cross-origin iframe keychain via `registerWallet(this.asWalletStandard())`.

Write against `WalletWithStarknetFeatures` and extension, iframe and web wallet are the same call site.

---

## 2. Dependency manifest

| Package | Pin | Note |
|---|---|---|
| `starknet` | **`10.4.0` exact** | **Trap:** npm `latest` is **10.0.2** with zero STRK20 — a bare install fails silently, every symbol undefined. Pin exact; see the connection-stack note below |
| `@starknet-io/types-js` | **`0.10.3` exact** | Action types and error codes live here |
| `@starknet-io/get-starknet-discovery` | **`6.0.3` exact** | Dynamic wallet discovery. Never the static `get-starknet-wallets` list |
| `@starknet-io/get-starknet-wallet-standard` | **`6.0.3` exact** | `WalletWithStarknetFeatures` |
| `@starknetfoundation/starknet-start-react` | `^2.0.1` | The hooks package the STRK20 docs point at. **Not** `@starknet-react/core` |
| `@avnu/avnu-sdk` | `^4.2.0` | Private swaps need ≥ 4.2.0. Surface labelled Preview |
| `phaser` | `4.2.1` | **Trap:** the Tiled parser does not support external tilesets. `ParseTilesets.js` does `if (set.source) console.warn('External tilesets unsupported. Use Embed Tileset and re-export')` and skips them. **Embed tileset definitions in exported JSON, or flatten them at build time.** Authoring maps with external `.tsx` produces maps Phaser silently refuses to load |
| `@colyseus/core` | `0.17.50` | Presence only. Use the narrow set, not the legacy `colyseus.js` (0.16.x, a major behind) or the full auth/playground meta-package |
| `@colyseus/ws-transport` | `0.17.13` | |
| `@colyseus/sdk` | `0.17.43` | Client side |

**The connection stack is pinned exactly, all four together.** This is the
combination the official STRK20 integration skill tested end to end. Newer
versions exist — `starknet` 10.7.0 and get-starknet 6.0.4 are on `next` — but
mixing a floating `starknet` with stale connection pins is the specific hazard
that produces a stack nobody has run. Either use these four as a set, or bump
them together and re-run the wallet tests.

| ~~`starkzap`~~ | — | **Excluded.** 3.0.0 contains zero `strk20`; pins `starknet ^9.2.1` and `@avnu/avnu-sdk ^4.1.0-rc.0`, both below the STRK20 floors. Its signer abstraction is worth reading; the package is not usable here |
| ~~`starknetkit`~~ | — | **Excluded.** 3.4.3 exposes 16 `wallet_*` methods, none STRK20, and pins `types-js 0.8.4` |

---

## 3. The API surface

Read from `@starknet-io/types-js@0.10.3`. This is the complete privacy surface the game touches.

```ts
type STRK20_DEPOSIT_ACTION  = { type:'deposit';  token:ADDRESS; amount:FELT }
type STRK20_WITHDRAW_ACTION = { type:'withdraw'; token:ADDRESS; amount:FELT; recipient:ADDRESS }
type STRK20_TRANSFER_ACTION = { type:'transfer'; token:ADDRESS; amount:FELT|'OPEN'; recipient:ADDRESS }
type STRK20_INVOKE_ACTION   = { type:'invoke';   contract:ADDRESS; calldata:STRK20_CALLDATA_ITEM[] }

type STRK20_ACTION = DEPOSIT | WITHDRAW | TRANSFER | INVOKE
type STRK20_CALL_AND_PROOF = { call: Call; proof: STRK20_PROOF }
type STRK20_BALANCE_ENTRY  = { token: ADDRESS; balance: FELT }
```

Wallet-resolved calldata placeholders, pattern `^\$\{(?:openNoteIds\[[0-9]+\]|poolAddress)\}$`:

- `${openNoteIds[N]}` — ID of the Nth open note (the Nth `transfer` action with `amount: 'OPEN'`)
- `${poolAddress}` — the privacy pool contract address

### Methods

```ts
// Use the WalletAccountV6 instance methods.
walletV6.strk20Balances(tokens: Address[]): Promise<STRK20_BALANCE_ENTRY[]>
walletV6.strk20PrepareInvoke(actions, simulate?): Promise<STRK20_CALL_AND_PROOF>
walletV6.strk20InvokeTransaction(actions): Promise<{ transaction_hash }>

// The type, for the forward-compatibility rule in §5:
import type { WalletWithStarknetFeatures }
  from '@starknet-io/get-starknet-wallet-standard/features'
```

> **Correction.** An earlier revision of this document recommended standalone
> `strk20Balances(walletWSF, …)` imports from `starknet`. Those do not exist on
> the package root — `require('starknet').strk20Balances` is `undefined`. They
> are internal `connectV6_*` aliases. Use the instance methods above.

`strk20InvokeTransaction` — the wallet proves, **adds its own fee action**, and submits. Player pays from their pool balance.

`strk20PrepareInvoke` — returns `{call, proof}` and the wallet adds **no** fee action. The dapp submits and pays. This is the sponsorship hook. `simulate: true` skips proof generation and returns an unsubmittable preview for fee estimation.

### React hooks

```ts
const { getBalances, getBalancesAsync, data, isPending } = useStrk20Balances()
const { prepare, prepareAsync } = useStrk20PrepareInvoke({ actions, simulate })
const { invoke,  invokeAsync }  = useStrk20InvokeTransaction({ actions })
```

The same package also ships `usePaymasterSendTransaction`, `usePaymasterEstimateFees` and `usePaymasterGasTokens` — the sponsorship path needs no separate library.

### Error taxonomy

| Code | Name | Handling |
|---|---|---|
| 118 | `NOT_REGISTERED` | Designed screen. Player must register inside their wallet — the game cannot do it. Returned by **all three** methods, including balances |
| 119 | `INSUFFICIENT_PRIVATE_BALANCE` | Show spendable-vs-maturing split. The pool fee comes out of the same balance |
| 120 | `PRIVACY_LEAK` | Wallet refused the bundle on anonymity grounds. **Trigger conditions undocumented.** Must be a legible user-facing state — the game generates action arrays programmatically |
| 162 | `API_VERSION_NOT_SUPPORTED` | Capability gate. Route to the unsupported-wallet screen |
| 163 | `UNKNOWN_ERROR` | Generic. Do not surface raw |

There is no per-action capability flag. Detect with `wallet_supportedWalletApi` version sniffing plus a `simulate: true` prepare as the live probe, and try/catch on 162.

---

## 4. Buildings — operation sequences

### The Bank — STRK20 pool · no Cairo

The whole building is the action set.

```ts
// shield
invoke([{ type:'deposit', token, amount }])

// pay another player
invoke([{ type:'transfer', token, amount, recipient }])

// exit
invoke([{ type:'withdraw', token, amount, recipient }])

// HUD
getBalances([])   // empty array = all shielded tokens
```

### The Exchange — AVNU · no Cairo

Ride AVNU's deployed executor via `@avnu/avnu-sdk@^4.2.0`. Its `createStrk20WalletProver` calls `strk20PrepareInvoke` and submits through AVNU's paymaster — a working reference for the sponsor-pays pattern.

### The Vault — Vesu lending · ~150–200 lines Cairo

The open-note pattern: create the output slot, then invoke the adapter with a placeholder the wallet resolves.

```ts
invoke([
  { type:'transfer', token: tokenOut, amount:'OPEN', recipient: player },
  { type:'invoke', contract: vaultAdapter,
    calldata: [tokenIn, tokenOut, amountIn, '${openNoteIds[0]}'] },
])
```

The adapter must expose `privacy_invoke(...) -> Span<OpenNoteDeposit>`. Only the return type is fixed; arguments are adapter-specific. StarkWare's Vesu adapter is Apache-2.0 reference — adaptation, not invention — but it sits outside the audited perimeter and needs its own review.

### The Post Office — player to player · no Cairo

The `transfer` action.

**Registration is preflightable.** The Wallet API has no method for it, but the pool contract exposes `get_public_key(address)`, readable over ordinary RPC. Verified on mainnet: an unregistered address returns `0x0`.

```
starknet_call → pool.get_public_key(recipient)
  0x0        → unregistered, block the send with an explanatory state
  non-zero   → registered, proceed
```

Preflight before offering "send to this player", and still map error 118 at transaction time — the two must agree. Without this, a transfer to an unregistered player fails late with no explanation.

### One invoke per transaction

A building needing two unrelated external calls must split across two player-facing transactions or consolidate into one adapter that calls both internally.

`shadow_account_invoke` would remove per-building Cairo entirely, but it appeared in `types-js@0.10.4-beta.2` and was pulled again in `0.11.0-beta.1`. Keep adapter interfaces thin enough to swap; do not build a v1 dependency on it.

---

## 5. Forward compatibility

v1 ships extension-only, but every later version must be able to accept web wallets, embedded wallets and email/social login the moment a vendor exposes the methods — **with no rewrite**. That property is not automatic.

The foundation is verified. `isStarknetWallet()` requires exactly four features and makes **no assumption about window injection**:

```ts
const RequiredStarknetFeatures = [
  "starknet:walletApi",
  "standard:connect",
  "standard:disconnect",
  "standard:events",
]
```

Anything registering those four qualifies — extension, cross-origin iframe keychain, or a hosted web wallet.

### Five rules that keep the door open

**1. Discover wallets dynamically — never from the static list.**
`@starknet-io/get-starknet-wallets` exports a hardcoded registry: `readyWallet`, `braavos`, `metaMask`, `okxWallet`, `keplr`. It is the obvious thing to reach for and it is the door-closing mistake — a wallet not on that list can never appear, however well it implements the standard. Source connectors from `@starknet-io/get-starknet-discovery` instead: `createStore` / `getWallets` over `wallet-standard:` registration events.

**2. Never branch on wallet identity in the STRK20 path.**
No `if (wallet.id === …)`, no name matching, no allowlist. Capability is determined at runtime. A wallet either answers the methods or it does not — that is the only question the game asks.

**3. Never set cross-origin isolation headers.**
This is the trap that would close the door silently and permanently. `COOP: same-origin` + `COEP: require-corp` — needed only for `SharedArrayBuffer` and multithreaded WASM — **break `postMessage`-based popups and cross-origin iframes**, which is exactly how web wallets and iframe keychains communicate. The standards fix (`COOP: restrict-properties`) was put on hold in 2025 and ships in no browser. We have no reason to set them: we do no in-browser proving. But if anyone later adds a WASM dependency that wants threads, it becomes threads *or* web wallets, not both. Write it into the deployment config as a comment and a header test.

**4. Keep the PWA shell popup-tolerant.**
Web wallets hand off via popup or iframe. In an *installed* PWA, `window.open()` opens inside the PWA rather than a browser window, which is known to break popup-based auth handoffs. Verify popup behaviour in the installed context before locking the shell down. Note also that a web wallet's iframe mode may be origin-allowlisted by its operator — that is a request to make early, not on launch day.

**5. Do not encode extension behaviour into the UI.**
Prompt counts, latency and connection persistence differ by wallet. Drive the UI from the hooks' own pending state rather than assumptions. Copy that says "confirm in your extension" ages badly; "confirm in your wallet" does not.

### The forward-compatibility test

One test, run in CI, that fails if any rule is violated: assert the STRK20 module's imports contain no reference to `get-starknet-wallets`, no wallet-id string literals, and that a **mock wallet** implementing only the four required features plus the three `strk20*` methods can drive every game operation end to end. `@starknetfoundation/starknet-start-react` ships `MockWallet` for exactly this.

If a mock that is neither extension nor web wallet can play the game, a real web wallet will work on the day it ships.

---

## 6. Constraints that bind the design

### One prompt per transaction, no session keys — batching is the only lever

Session keys are absent from the dapp surface and blocked at the contract level: the pool's `assert_valid_os_call` requires `caller_address.is_zero()`, which `execute_from_outside` can never satisfy. Every call shows its own approval UI, and the spec warns the dapp "must tolerate long-running calls."

**Design answer:** the `actions` array is atomic. Accumulate player intent off-chain inside a building and settle one batch on exit — one prompt, one proof, one fee. This converts cost from per-move to per-session. Architect it from day one; retrofitting is expensive.

### Registration happens in the wallet, not the game

No `wallet_strk20Register` method exists. Every method returns 118 until the player has registered a viewing key inside their wallet. The game cannot register them and cannot probe registration without making a call.

**Design answer:** The Bank's ground floor is the onboarding room — connect, catch 118, explain, deep-link out, detect return. Instrument the drop-off; it is the largest unknown in the project.

### Shielded actions are session events, not turn events

Note maturity is 10 blocks before a note is spendable, plus wallet-side proof generation, plus confirmation. No published wallet latency figure exists — measure it in Phase 0. Nothing here belongs on a game loop's critical path.

**Design answer:** shielded actions are deliberate and infrequent. Players bank once, then play against cheap public state. Lift shieldup's `note-maturity.ts` pattern — split the balance into spendable-now versus "+X arriving", and gate spend-max on the mature portion only.

### Pool fee is 6 STRK, and governance-settable

Two independent on-chain reads returned `get_fee_amount() = 6e18`. The 4 STRK figure in launch material is stale. **Read it live at runtime, do not hardcode** — it is a governance parameter and has already moved once.

Also read live: the pool reported a **450-block proof-validity window** at verification time. A prepared proof anchors to a block and expires; the prepare/submit split must submit promptly or re-prepare.

Whether a paymaster can cover the pool fee as well as gas is an open question — see §9.

### Cap sponsorship, not user funds

These are different things and were conflated in an earlier revision. **Do not impose a product-level cap on user balances** — that is the user's money and their decision.

The application's *gas sponsorship* is a different matter: it is our money, spent on behalf of unauthenticated users, and it needs controls or it is an open drain.

- Per-account and global rate limits on sponsored transactions
- A per-transaction fee ceiling, rejecting anything above it
- A budget with alerting well before exhaustion
- A kill switch that disables sponsorship without taking the game down — players fall back to paying their own gas

Sybil resistance matters here because account creation is free and sponsorship is not.

### Anonymity, not confidentiality — and deposits are always to self

`STRK20_DEPOSIT_ACTION` has no recipient field. The game **cannot** fund a player's shielded balance: no airdrops into the pool, no starting balance, no gifting a newcomer their first token.

Deposit and withdrawal legs are public with visible addresses and amounts; open-note amounts are plaintext by design. *"Nobody can link this move to you"* is defensible. *"Your balance is hidden"* is not.

### The lobby is a timing oracle

Entering a building is a timestamped event observed by every other player and by your server; the resulting pool interaction is public on-chain. Timing correlation is the dominant deanonymisation heuristic in the literature, and a shared street collapses it to milliseconds.

**Design answer:** a submission queue with randomised delay and batching, deliberately breaking the causal link between avatar action and broadcast. First-class subsystem with its own tests. The lobby server must be structurally incapable of seeing an account address — ephemeral session pseudonyms from day one.

---

## 7. What the game builds

- **The game itself** — Phaser 4 canvas, Tiled maps with external tilesets, React overlay, PWA shell. STRK20 provides zero game primitives.
- **Colyseus lobby** — presence and position only. Never sees an address.
- **Starknet RPC** for public reads — receipts, adapter contract reads. Not `publicProvider()` in production.
- **Thin backend** — paymaster key custody. Small, but this is not a pure static PWA.
- **Submission queue** — the timing-correlation mitigation.
- **Batch accumulator** — collects intent per building visit, settles one atomic array.

**Not built:** prover, discovery service, viewing-key storage, compliance relationship.

### Reusable from shieldup

**This is not greenfield financial work.** Shieldup already implements the Bank, the AVNU Exchange and private transfer on mainnet. Privacy City is a Wallet API migration plus game-world presentation, not a new build.

Verified at commit `290f830`: fresh `npm ci` passes on its committed lockfile, strict TypeScript passes, production Vite build passes (8,161 modules), **213/213 logic tests pass**, and the recorded AVNU mainnet transaction independently confirms `SUCCEEDED` / `ACCEPTED_ON_L1`.

**Reuse behaviour and selected source modules — not the lockfile.** `npm audit --omit=dev` reports 36 transitive advisories in its historical dependency tree.

High-value behaviour to carry across:

- BigInt-only token arithmetic; felt-padding-tolerant address comparison
- Runtime pool-fee reads; spendable-vs-maturing balance presentation (`note-maturity.ts`)
- Recipient registration preflight
- Shielded transaction progress state machine (`shield-flow.ts` — already the right shape for a game HUD) and the human error taxonomy (`shield-errors.ts`)
- AVNU quote TTL, slippage floor, minimum-received handling, dynamic executor usage
- Private paymaster fee token/amount/recipient validation and fee ceilings
- Receipt/history, reconnect/recovery, stale-client handling
- CSP enforcement, no third-party analytics in financial rooms, privacy-safe logging

**Replace rather than port:** the vendored low-level privacy SDK, custom viewing-key derivation and identity context, the proof-aware account signer, self-hosted Pathfinder/prover/indexer and their retry ownership, and the old Starknet/Privy/WalletConnect lockfile. These are reference implementations for a path we are not taking.

---

## 8. Build plan

### Phase 0 — Measure the wallet · 3–5 days

A scratch page driving the three methods against a real extension. Four questions no document answers:

- Deploy a trivial `privacy_invoke` adapter — does the shipped wallet honour "arbitrary contract" or allowlist it? **This gates The Vault.**
- Does `strk20Balances` prompt? Gates the live HUD.
- Does a 3-action array render one confirmation or three? Gates whether batching buys anything.
- End-to-end latency, and `get_fee_amount()` live.

### Phase 1 — The world, no chain · 2–3 weeks

Parallel with Phase 0.

- Phaser 4 + Tiled + React shell, PWA scaffolding
- One street: roads, grass, four facades, interiors, door triggers
- Colyseus lobby, ephemeral pseudonyms
- React↔Phaser bridge: hooks own wallet state, push into Phaser via event emitter

### Phase 2 — The Bank · 2–3 weeks

- Connector + capability detection + the 118 and unsupported-wallet rooms
- deposit / withdraw / transfer / balances
- Batch accumulator and submission queue
- Maturity-aware balance display
- In-product disclosure copy

### Phase 3 — The Exchange · 1–2 weeks

AVNU SDK, plus the backend paymaster proxy.

### Phase 4 — Hardening and launch · weeks 5–8

Multiplayer resilience, mainnet regression suite, dependency and security hardening, art pass, launch operations.

### After v1 — The Vault · Vesu

**Excluded from v1.** It is the only building needing new Cairo and the only one without a working Shieldup precedent, so it is the natural thing to cut to protect the 6–8 week window. Supply/redeem first; borrowing and collateral are a separate, larger piece of work.

Toolchain when it starts: Scarb `2.17.0`, Starknet Foundry `0.59.0` — verified against the current privacy repo, with the seven Vesu anonymizer unit tests passing. That is not a deployment audit.

Only proceed if Phase 0 confirmed the shipped wallet honours arbitrary-contract `invoke`.

**v1 — Bank, Exchange and Post Office on mainnet in roughly 6–8 weeks**, Phase 1 parallelised, no Cairo and therefore no audit on the critical path.

---

## 9. Asks and open items

**To Ready — expose the three `wallet_strk20*` methods through the web wallet, and bump the StarknetKit connector's `types-js` pin to 0.10.3.**
The privacy stack already exists for the extension — this is RPC plumbing, not a cryptography build. It is the single change that unlocks extension-free onboarding with zero infrastructure on our side. Also ask about the iframe origin allowlist, since popup fallback misbehaves inside an installed PWA.

**What exactly triggers `PRIVACY_LEAK` (120)?**
Undocumented everywhere. We generate action arrays programmatically; the refusal rules are the difference between a designed constraint and a runtime surprise.

**Is `get_fee_amount()` per transaction or per action, and can a sponsoring account cover the pool fee or only gas?**
Determines whether batching amortises the fee, which the whole economy design rests on.

**Status and timeline for `shadow_account_invoke` — is the `0.11.0-beta.1` removal a retreat or a reshuffle?**
It would remove per-building Cairo and unlink DeFi positions per player.

**Any scoped, non-retroactive disclosure primitive for consensual player-to-player reveal?**
Viewing keys remain all-or-nothing and irrevocable, so the trade feature has no foundation. The cheap alternative — notes sent to a payee are already visible to them — may satisfy the actual need.

**Real pool participation numbers.**
Still the most important missing figure. We cannot honestly tell players what privacy they are getting without it.

---

## 10. Unresolved

- **Mobile.** No Starknet WalletConnect equivalent, and nobody has confirmed whether a mobile wallet's in-app browser exposes the Wallet API to third-party dapps. Verify on device before promising it.
- **The exit.** Withdrawal reveals token, amount and recipient — the exit deanonymises. Needs a designed flow, not just copy.
- **Wallet proving throughput** under sustained load from many concurrent players. No published SLA or acceptable-use terms.
- **Scams and moderation.** Public lobby plus real funds plus peer-to-peer transfer, with no reporting or abuse design.
- **Analytics.** Needed to operate a game; every form of it is a deanonymisation vector.
- **Legal.** A public front-end to a shielded pool has real regulatory surface. Counsel before public launch.

---

## Provenance

Interfaces, type definitions, version pins and method coverage in this document were read from packages installed from npm — `starknet@10.7.0`, `@starknet-io/types-js@0.10.3`, `@starknetfoundation/starknet-start-react@2.0.1`, `@avnu/avnu-sdk@4.2.0`, `phaser@4.2.1`, `starkzap@3.0.0`, `starknetkit@3.4.3` — rather than from documentation.

### Corrections in this revision

A parallel research pass raised four errors in the previous revision. All four were independently re-verified here before being accepted, and all four were real:

| Was | Is | How verified |
|---|---|---|
| Use standalone `strk20Balances(walletWSF, …)` imports | They don't exist on the package root — use `WalletAccountV6` instance methods | `require('starknet').strk20Balances` → `undefined` |
| External Tiled tilesets from day one | **Embed them.** Phaser warns and skips external `.tsx` | Verbatim in `phaser/src/tilemaps/parsers/tiled/ParseTilesets.js:38-40` |
| No pre-flight for recipient registration | `pool.get_public_key(address)` is readable over RPC | mainnet `starknet_call` → `0x0` for unregistered |
| Cap user balances | Cap *sponsorship*, not user funds — different things | Reasoning, adopted |

Also corrected: the pool fee is settled at **6 STRK** (two independent reads; the 4 STRK launch figure is stale), a 450-block proof-validity window was added, Colyseus moved to the narrow `0.17.x` set, and Vesu moved out of v1.

Contract addresses, fees and pool activity were verified by direct JSON-RPC against Starknet mainnet. Items marked contested or unresolved are open questions, not conclusions.

The canonical STRK20 docs are machine-readable at `https://strk20-by-example.org/llms-full.txt`. Note that `strk20.starknet.io/docs/<path>` is a client-rendered SPA returning an empty shell to fetchers — a 200 there proves nothing.
