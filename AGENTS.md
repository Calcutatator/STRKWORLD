# AGENTS.md

**Contract and shared memory for everyone working on STRKWORLD — human or agent.**

Read this before touching anything. It is short on purpose. The findings log
at the bottom is the part that grows.

---

## 1. What this project is

A 2D top-down browser game where buildings are Starknet privacy protocols.
Real funds, Starknet **mainnet**, from day one. Players hold funds in the
STRK20 privacy pool.

The full specification is [`docs/SPEC.md`](docs/SPEC.md). Do not re-derive it
from scratch — it is backed by primary-source verification in
[`docs/research/`](docs/research/), and re-deriving has already wasted
significant time on this project.

---

## 2. Invariants — never break these

These are not preferences. Breaking one is a defect regardless of whether
anything appears to work afterwards.

**The game runs no privacy infrastructure.** No prover, no discovery service,
no viewing keys, no note management. The wallet does all of it. If you find
yourself reaching for `@starkware-libs/starknet-privacy` or a
`PROVING_SERVICE_URL`, you are on the wrong path — stop and read
`docs/DECISIONS.md` entry D-002.

**The lobby never sees money.** No address, balance, transaction hash,
building name, or financial action may enter lobby traffic or lobby server
state. Ephemeral per-session game IDs only. The lobby knows a player is at
`(x, y)`; it must not be able to learn who they are or what they did.

**Transaction submission is decoupled from avatar action.** Entering a
building and broadcasting a transaction must never be causally linked in
time. This is a privacy control, not a nicety — see D-004.

**Never branch on wallet identity in the privacy path.** No `wallet.id ===`,
no name matching, no allowlist. Capability is determined at runtime. This is
what keeps web wallets and email login possible later without a rewrite.

**Never set `COOP: same-origin` or `COEP: require-corp`.** They break the
`postMessage` popups and cross-origin iframes that web wallets rely on, and
the standards fix ships in no browser. We do no in-browser proving, so we
never need them. See D-005.

**Never commit a secret.** RPC keys, paymaster keys, API keys. `.env.local`
is gitignored; `.env.example` is the template and holds no real values.

---

## 3. Package boundaries

Work inside one package. If a change needs to cross a boundary, add a
decision entry explaining why before writing the code.

| Package | Owns | Must never |
|---|---|---|
| `packages/privacy` | All Starknet interaction. The `PrivacyOperations` interface and its implementations | Import from `world` or `lobby`. Contain UI |
| `packages/world` | Phaser scenes, movement, collision, tilemaps, sprites | Import `starknet` or any wallet package. Know what money is |
| `packages/lobby` | Colyseus presence, positions, ephemeral IDs | Touch an address, balance, tx hash, or building name |
| `packages/shared` | Types and constants crossing boundaries | Contain logic or dependencies |
| `apps/web` | Composition, routing, layout, the event bus | Contain business logic that belongs in a package |

The bridge is one-directional: React owns wallet and financial state and
pushes into Phaser via an event emitter. Phaser never reaches back into
React state or calls Starknet.

---

## 4. How to verify a claim

This project has been bitten repeatedly by confident documentation that was
wrong, and by agents reporting findings they had not checked.

**Install the package and read the types.** Not the docs site. Not a blog.

```bash
npm view <pkg> version dist-tags
npm install <pkg>@<version>
node -e "console.log(typeof require('<pkg>').theThing)"
grep -r "theThing" node_modules/<pkg>/dist/*.d.ts
```

**Read contract state over RPC.** Not launch announcements — fees and config
are governance-settable and have already moved once.

```bash
curl -s -X POST $RPC -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"starknet_call","params":[{...},"latest"]}'
```

**A config variable is not a service.** `PROVING_SERVICE_URL` existing in an
`.env.example` proves nothing about a service existing. A method name in a
doc page proves nothing about a wallet implementing it.

**Read the vendored skills first — they are the primary reference.**
`.agents/skills/` carries five STRK20 skills with official doc pages bundled
as Markdown, so you do not need the network and cannot be defeated by the SPA
problem below:

| Skill | Use it for |
|---|---|
| `strk20-wallet-api` | **Our route.** Actions, capability detection, private DeFi, AVNU private swaps |
| `strk20-privacy` | Concepts — notes, nullifiers, channels, viewing keys, what is and is not hidden |
| `strk20-anonymizer-contracts` | Cairo helpers. Needed for the Vault, post-v1 |
| `strk20-privacy-sdk` | The low-level route. **Not ours** — read only to understand what we are not doing |
| `strk20-privacy-integration` | The official ask/plan/execute planner |

**Canonical STRK20 docs online:** `https://strk20-by-example.org/llms-full.txt`
— the whole site as one Markdown file. Note that
`strk20.starknet.io/docs/<path>` is a client-rendered SPA that returns an
empty shell to fetchers, so a 200 there means nothing.

---

## 5. Findings log

Append what you learn. Newest first. Include how you verified it — a finding
without a verification method is a rumour.

Format: `### YYYY-MM-DD — short title` then what, why it matters, how verified.

---

### 2026-08-16 — Pin the connection stack as a set, never mix floating and pinned

The four connection packages must be pinned **exactly and together**:

```
starknet                                 10.4.0
@starknet-io/types-js                    0.10.3
@starknet-io/get-starknet-discovery      6.0.3
@starknet-io/get-starknet-wallet-standard 6.0.3
```

This is the combination the official integration skill tested end to end.
Newer versions exist (`starknet` 10.7.0, get-starknet 6.0.4 on `next`), and
they may well be fine — but mixing a floating `starknet` with stale connection
pins produces a stack nobody has run, which is the worst of both.

We had exactly that defect: `starknet: "10.7.0"` alongside
`get-starknet-*: "*"`. Fixed.

Either use these four as a set, or bump them together and re-run the wallet
tests. Never one without the others.

*Verified:* all four resolve on npm; `starknet@10.4.0` installed clean and
exposes `WalletAccountV6` with 10 `strk20` references in its type definitions.
*Credit:* the `welttowelt/strk20-skills` wallet-api skill, which flags this
hazard explicitly.

---

### 2026-08-16 — A shield is TWO wallet prompts, and the second reads as a bug

The ERC-20 `approve` must land on-chain before the private deposit, so the
wallet prompts twice for what the player thinks is one action.

**Label both steps in the UI.** Unlabelled, the second prompt reads as a
duplicate-transaction bug and players cancel it.

For our Bridge deposit flow this compounds: bridge deposit, then `approve`,
then shield. Three prompts for one intent. The room has to narrate that.

*Source:* `.agents/skills/strk20-wallet-api/SKILL.md`.

---

### 2026-08-16 — `starknet` npm `latest` has no STRK20 and fails silently

`npm install starknet` resolves to **10.0.2**, which contains none of the
STRK20 surface. Every symbol is `undefined` at runtime with no useful error.

Pin `starknet@10.7.0` exactly and commit the lockfile.

*Verified:* `npm view starknet dist-tags` → `latest: 10.0.2, next: 10.7.0`;
grep for `strk20` in the 10.0.2 tarball returns zero hits.

---

### 2026-08-16 — Standalone `strk20*` functions are not exported

An earlier revision of the spec recommended
`import { strk20Balances } from 'starknet'`. **This does not exist.**
`require('starknet').strk20Balances` is `undefined` — they are internal
`connectV6_*` aliases.

Use the `WalletAccountV6` instance methods:
`walletV6.strk20Balances(...)`, `.strk20PrepareInvoke(...)`,
`.strk20InvokeTransaction(...)`.

Type import: `WalletWithStarknetFeatures` from
`@starknet-io/get-starknet-wallet-standard/features`.

*Verified:* `node -e "console.log(typeof require('starknet').strk20Balances)"`
→ `undefined`.

---

### 2026-08-16 — Phaser does not support external Tiled tilesets

Phaser's Tiled parser **rejects** external `.tsx` tilesets:

```js
// phaser/src/tilemaps/parsers/tiled/ParseTilesets.js:38
if (set.source) {
    console.warn('External tilesets unsupported. Use Embed Tileset and re-export');
```

**Embed tileset definitions in the exported JSON**, or flatten them at build
time. Authoring maps with external tilesets produces maps Phaser silently
refuses to load. An earlier spec revision advised the opposite — that was
wrong and would have cost a map re-authoring pass.

*Verified:* read from `node_modules/phaser@4.2.1` source.

---

### 2026-08-16 — Recipient registration IS preflightable

The Wallet API has no method to check whether an address is registered in the
pool, but the **pool contract does**: `get_public_key(address)`, readable
over ordinary RPC. Unregistered returns `0x0`.

Preflight before offering "send to this player", and still map error 118 at
transaction time — the two must agree.

*Verified:* `starknet_call` against the mainnet pool with an unregistered
address returned `0x0`.

---

### 2026-08-16 — `get-starknet-wallets` is a hardcoded list, do not use it

`@starknet-io/get-starknet-wallets` exports a static registry of five wallets.
Sourcing connectors from it means no new wallet can ever appear, however well
it implements the standard — which would permanently close the door on web
wallets and email login.

Use `@starknet-io/get-starknet-discovery` (`createStore` / `getWallets` over
`wallet-standard:` events), which picks up runtime registrations.

*Verified:* read the package exports; `isStarknetWallet()` requires only four
features and makes no window-injection assumption.

---

### 2026-08-16 — Pool fee is 6 STRK, not 4, and is governance-settable

`get_fee_amount()` returns `6e18`. The 4 STRK figure in launch material is
stale. Read it live at runtime — it has already moved once. A 450-block
proof-validity window also applies, so a prepared proof expires.

*Verified:* two independent `starknet_call` reads against the mainnet pool.

---

### 2026-08-16 — Reuse shieldup's behaviour, not its lockfile

[`shieldup`](https://github.com/Calcutatator/shieldup) already implements the
Bank, the AVNU Exchange and private transfer on mainnet. At commit `290f830`:
`npm ci` passes, strict TypeScript passes, production build passes,
**213/213 logic tests pass**, and its recorded AVNU mainnet transaction
confirms `ACCEPTED_ON_L1`.

But `npm audit --omit=dev` reports **36 transitive advisories** in its
historical dependency tree. Port modules and behaviour; do not port the
lockfile or the vendored privacy dependency graph.

Its self-hosted prover/indexer, custom viewing-key derivation and proof-aware
signer are reference implementations for a path we are **not** taking.

*Verified:* full audit in [`docs/research/shieldup-reuse-audit.md`](docs/research/shieldup-reuse-audit.md).

---
