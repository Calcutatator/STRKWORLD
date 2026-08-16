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

**No financial building without an approved private route.** A building may
use a pool-native Wallet API action, a protocol's first-party STRK20 path, or
a reviewed and audited app-specific anonymizer. There is no unshield-and-call,
arbitrary-calldata or normal-frontend fallback: if its route is unavailable,
the building is locked. The Bridge is an explicitly public funding edge. See
D-018.

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

## 3. Working agreement

Several agents work in this repository at once. These two rules are what keep
that from turning into divergence.

### The repository is the source of truth

Not chat. Not a message. Not your own memory of a decision. If a learning, a
fact or a direction is not in the repo in a structured place, it does not exist
— the next agent will not have it, and neither will you next session.

| What you have | Where it goes |
|---|---|
| A verified fact, a trap, a gotcha | Findings log, §6 below — with how you verified it |
| A choice with alternatives and reasoning | `docs/DECISIONS.md` |
| How something is built | `docs/ARCHITECTURE.md` or the package README |
| Who does what, in what order | `docs/WORKPLAN.md` |
| A boundary that must not be crossed | The invariants in §2, and `scripts/check-invariants.sh` |

Uncommitted work is not in the repo. Commit and push before you stop, even
mid-task — an unpushed branch is invisible to every other agent.

### Newest wins, and supersession is explicit

Direction comes from the **most recent** verified learning. An older document
that was never updated is not authoritative just because it is longer or more
confident.

When you supersede something, edit both ends: the new entry says what it
changes, and the old entry's status line points forward. An agent who reads the
old entry first must not be able to act on it unknowingly. This is the only case
where editing a past decision is required — edit the status line, never the
reasoning.

If you find two documents that disagree, that is a defect. Resolve it and record
which won, rather than picking one silently.

### Sync before you work

```bash
./scripts/sync.sh
```

Shows what moved, what is unpushed or uncommitted, which PRs are open, the
newest decisions and findings, and whether the invariants still pass. Run it at
the start of every session. If it warns, resolve the warnings before writing
code.

---

## 4. Package boundaries

Work inside one package. If a change needs to cross a boundary, add a
decision entry explaining why before writing the code.

| Package | Owns | Must never |
|---|---|---|
| `packages/privacy` | All Starknet interaction. The `PrivacyOperations` interface and its implementations | Import from `world` or `lobby`. Contain UI |
| `packages/world` | Phaser scenes, movement, collision, tilemaps, sprites | Import `starknet` or any wallet package. Know what money is |
| `packages/lobby` | Colyseus presence, positions, ephemeral IDs | Touch an address, balance, tx hash, or building name |
| `packages/shared` | Types and constants crossing boundaries | Contain logic or dependencies |
| `apps/web` | Composition, routing, layout, the event bus | Contain business logic that belongs in a package |
| `apps/backend` | Paymaster proxy, privacy-safe RPC reads, bounded submission queue | Log or persist per-request IPs, calls, proofs, timings, recipients or transaction hashes |

The bridge is one-directional: React owns wallet and financial state and
pushes into Phaser via an event emitter. Phaser never reaches back into
React state or calls Starknet.

---

## 5. How to verify a claim

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

**Load the vendored skills for every STRK20 task.** `.agents/skills/` carries
five complementary STRK20 skills with their source pages bundled as Markdown.
The four knowledge skills from `welttowelt/strk20-skills` are vendored from
commit `bded2dfc08467b9103ad3dd0c6575a2065fdf425`; `skills-lock.json` records
their content hashes.

| Skill | Use it for |
|---|---|
| `strk20-wallet-api` | **Our route.** Actions, capability detection, private DeFi, AVNU private swaps |
| `strk20-privacy` | Concepts — notes, nullifiers, channels, viewing keys, what is and is not hidden |
| `strk20-anonymizer-contracts` | Cairo helpers. Needed for the Vault, post-v1 |
| `strk20-privacy-sdk` | The low-level route. **Not ours** — read only to understand what we are not doing |
| `strk20-privacy-integration` | The official ask/plan/execute planner |

Route work deliberately: use `strk20-privacy` for the trust boundary and
hidden/visible claims, `strk20-wallet-api` for `packages/privacy` and browser
flows, and `strk20-anonymizer-contracts` only when a helper contract is in
scope. The integration planner controls planning and approval gates. Direct
use of `@starkware-libs/starknet-privacy-sdk` in this product is a defect: it
would move viewing keys, discovery and proving into a trust boundary we have
explicitly rejected.

**The skills are required working references, not authority over shipped
code.** Installed package types, live contract state, current wallet behavior,
and the verified project findings below win when they disagree. In the current
vendored snapshot:

- `strk20PrepareInvoke(actions, true)` skips proof generation; it does not
  "build and prove". Its result is for simulation and is not submittable.
- The approval/deposit sequence is real, but exact wallet prompt count is a
  live-wallet test result, not a protocol guarantee. Do not hardcode two.
- Bundled upstream SDK references contain commands that write an auth token
  directly to `.npmrc`. Never execute those. If the SDK is ever used in a
  different, approved key-holding project, follow the safer environment
  placeholder flow in `strk20-privacy-sdk/SKILL.md`.

**Canonical STRK20 docs online:** `https://strk20-by-example.org/llms-full.txt`
— the whole site as one Markdown file. Note that
`strk20.starknet.io/docs/<path>` is a client-rendered SPA that returns an
empty shell to fetchers, so a 200 there means nothing.

---

## 6. Findings log

Append what you learn. Newest first. Include how you verified it — a finding
without a verification method is a rumour.

Format: `### YYYY-MM-DD — short title` then what, why it matters, how verified.

---

### 2026-08-16 — A private building is an approved execution route, not a facade

The world is a capability-bounded UI over three valid financial paths:
pool-native Wallet API actions, a protocol's first-party STRK20 executor, or a
project-owned anonymizer. Bank/Post Office use the first; AVNU Exchange uses
the second; Vesu Vault needs the third. If none is available, the door stays
locked — unshield-and-call is not a fallback.

For anonymizer routes, the pool-to-helper-to-protocol-to-note operation is
atomic and hides the player's wallet address from the protocol action. The
application, action, timing and open-note amount can remain public, so copy
must not claim full confidentiality or universal unlinkability.

*Verified:* the required vendored STRK20 privacy, Wallet API and anonymizer
skills; `check_freshness.py` confirmed Wallet API types `0.10.3`, AVNU SDK
`4.2.0`, and the public Vesu anonymizer reference path on 2026-08-16. Product
admission and fallback policy are recorded in D-018.

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

### 2026-08-16 — Approval and deposit are separate; prompt count is wallet-dependent

The ERC-20 approval must be established before a private deposit. That is a
real sequencing constraint, but neither the Wallet API types nor the action
shape guarantee exactly two prompts: an existing allowance and wallet UX can
change what the player sees.

Design the Bank and Bridge as explicit multi-stage progress flows, but obtain
the actual prompt count from the Phase 0 Ready/Xverse mainnet spike before
writing fixed copy.

*Verified:* `starknet@10.7.0` type definitions and
[`docs/research/primary-source-verification.md`](docs/research/primary-source-verification.md),
which correctly retains prompt count as a live-wallet unknown.

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
