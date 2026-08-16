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

**Phaser ships its own docs.** `node_modules/phaser/skills/` holds 28
engine-versioned `SKILL.md` files — `tilemaps`, `scenes`,
`input-keyboard-mouse-touch`, `events-system`, `scale-and-responsive` and more.
They cannot drift from the installed version, so prefer them over anything
found online for Phaser questions.

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
- The approval/deposit sequence is real, but Ready 5.33.8 currently puts its
  approval call(s) and privacy call in one transaction action. Exact visible
  prompt count remains a live-wallet result. Do not hardcode two.
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

### 2026-08-16 — Ready 5.33.8 prompts for private reads and batches deposit approval

The current shipped Ready extension creates an explicit approval action for
`wallet_strk20Balances`; its English UI says “Share private balances”. It also
creates one “Prove transaction” action for an entire
`wallet_strk20PrepareInvoke` array. These are deliberate wallet interactions,
so a balance HUD must be user-requested rather than polled and proof preparation
cannot be presented as a silent preview.

All three STRK20 dapp handlers provision local privacy material and then check
pool registration. They return `NOT_REGISTERED` when the account is not
registered; they do not call the wallet's separate registration operation.
Current Ready therefore does not auto-register through a first dapp balance,
prepare or invoke request.

For `wallet_strk20InvokeTransaction`, Ready groups deposits by token, prepends
the required ERC-20 approval calls, appends the pool privacy call, and creates
**one** wallet `TRANSACTION` action for the resulting call array. This
supersedes the old assumption that a shield necessarily means exactly two
wallet prompts. A real mainnet UI run still has to confirm the visible prompt
sequence and latency before `PrivacyOperations.promptCount` is frozen.

The request schema accepts any valid felt as `invoke.contract`, but the shipped
paymaster error set includes `TX_PAYMASTER_INVOKE_NOT_ALLOWED`. Client syntax
therefore does not prove end-to-end arbitrary-target support; that Vault gate
remains open until a harmless reviewed helper is exercised on mainnet.

*Verified:* downloaded Chrome Web Store extension
`dlcobpjiigpikoobohmabehhmhfoodbb` through Google's public CRX endpoint,
confirmed manifest version `5.33.8` and CRX SHA-256
`2f6014522d1a6d6881bcbb0cdd427d11aa497c6684c35dc3e21947b91bd23fb6`, then
inspected the shipped background handlers, action screens, validators and
English locale. No wallet was installed or opened and no transaction was
submitted. Full evidence and remaining manual steps:
[`docs/research/ready-wallet-5.33.8-source-audit.md`](docs/research/ready-wallet-5.33.8-source-audit.md).

---

### 2026-08-16 — Wallet API balances cannot expose note maturity

`wallet_strk20Balances` returns only `[{ token, balance }]`. The stable 0.10.3
surface has no field or companion method for spendable-versus-maturing notes.
STRKWORLD must not translate that aggregate into a spendable MAX value. The real
adapter marks the split unknown; only the deterministic fake can report it.

*Verified:* inspected `STRK20_BALANCE_ENTRY` in the installed
`@starknet-io/starknet-types-0103` declarations reached by
`starknet@10.4.0`, then typechecked the production adapter against that exact
shape on 2026-08-16. No balance was requested from a wallet.

---

### 2026-08-16 — A prepared Wallet API proof can be queued and relayed without the account signer

`wallet_strk20PrepareInvoke` returns the pool `apply_actions` call plus its
proof. AVNU's private paymaster accepts exactly that artifact through
`paymaster_executeTransaction` with transaction type `apply_action`; its
shipped SDK states that no user signature is required at submission. This
makes D-015's backend queue implementable for non-public, non-quote-bound
actions: the wallet proves, the backend validates and delays within the live
proof-validity window, and the paymaster relays.

Fee mode is operationally significant. On mainnet,
`sponsored_private` currently rejects a build without a valid
`x-paymaster-api-key`, while `default` succeeds without a key and returns a
shielded-token `withdraw` fee action. Do not treat those modes as aliases.
Validate the returned token, recipient and amount against route policy before
asking the wallet to prove, then revalidate the exact artifact at enqueue and
submission. Quote-bound AVNU swaps still must not be delayed.

*Verified:* inspected the published `@avnu/avnu-sdk@4.2.0` tarball types and
implementation (`createStrk20WalletProver`, `submitPrivateSwap`, and the
`apply_action` JSON-RPC payload), then called the live mainnet AVNU paymaster's
`paymaster_buildTransaction` on 2026-08-16 with both fee modes. No transaction
was submitted.

---

### 2026-08-16 — Prepared proofs expose a route-enforceable server-action list

The Wallet API artifact is not an opaque blob. The submitted pool call's
calldata is Cairo serialization of `Span<ServerAction>`, and the proof output is
`[class_hash, ...serialized_actions]`. The backend can therefore verify that
`proof.output.slice(1)` equals the submitted calldata and decode enough of the
stable ABI to enforce route policy before relaying.

STRKWORLD now rejects an external `Invoke` under transfer/unshield routes,
requires the exact HMAC-authorized relay-fee `TransferTo`, and rejects an extra
public withdrawal under the transfer route. This prevents a fee authorization
from becoming a generic sponsored anonymizer call even though every artifact
targets the same pool entry point.

*Verified:* inspected the pinned ShieldUp privacy SDK's
`private-transfers.js`, `proof-invocation-factory.js` and full privacy-pool ABI,
then exercised the decoder with valid, truncated, route-mismatched and
invoke-smuggling fixtures in `apps/backend` on 2026-08-16. No proof was
generated or submitted.

---

### 2026-08-16 — AVNU SDK 4.2.0 raises the toolchain floor to Node 22

The approved private-swap SDK is installed exactly at
`@avnu/avnu-sdk@4.2.0`. Its published manifest declares `node >=22`; D-025
therefore raised the repository floor to Node 22.12, which also satisfies
Vite's supported Node range. Node 20 is not a build target.

Do not paper over engine mismatches with `engine-strict=false`. Future runtime
changes must keep both the Exchange SDK and build toolchain supported.

*Verified:* installed the exact npm release and inspected
`node_modules/@avnu/avnu-sdk/package.json` (`engines.node: >=22`) against the
root `package.json` engine range on 2026-08-16.

---

### 2026-08-16 — Proof-validity is a live pool read, not a 450-block constant

The privacy pool exposes `get_proof_validity_blocks() -> u64`. The 450-block
value is governance-settable and was only a mainnet observation. Backend fee
authorizations and client confirmation must use the live getter alongside
`get_fee_amount()`; a configured default can outlive the proof the pool accepts.

*Verified:* inspected the pinned ShieldUp privacy-pool ABI and derived the
selector with the pinned Starknet library; the fixed RPC adapter test returns
the live value through the new read.

---

### 2026-08-16 — 1Click source metadata is live data, not a static catalogue

The live 1Click registry currently exposes 186 assets across 35 blockchain
labels and includes STRK on Starknet as
`nep141:starknet.omft.near`. An unauthenticated dry quote for 10 Arbitrum USDC
to Starknet STRK succeeded and correctly returned pricing with no deposit
address. At least one static ShieldUp label has already drifted: asset id
`nep245:v2_1.omni.hot.tg:1117_`, recorded there as TON, is currently returned
by the registry as `GRAM`.

Port the curated asset IDs and address-safety rules as fallbacks, but merge and
display live registry metadata. Never infer current route availability or
symbol/name from the old list alone. Dry quotes are previews only; production
quotes still require explicit deposit-address lifecycle and resume tests. The
current `QuoteResponse` also says its signature and whole signed quote must be
saved for dispute resolution; ShieldUp's trimmed `BridgeQuote` drops that
evidence, so port the resume behaviour but not that lossy response shape.

*Verified:* installed `@defuse-protocol/one-click-sdk-typescript@0.1.25` in
the repository dependency tree, called `OneClickService.getTokens()` and
`OneClickService.getQuote({ dry: true, ... })` against the live service on
2026-08-16, and compared the response with ShieldUp commit `290f830`'s
`source-tokens.ts`. No deposit address was issued and no funds moved.

---

### 2026-08-16 — Exact connection pins still contain mixed transitive API types

The four required direct pins are not a uniform dependency tree by themselves.
`get-starknet-discovery@6.0.3` declares `types-js@0.10.4-beta.1` and caret
ranges for its v6 wallet-standard and virtual-wallet dependencies; the current
lock resolves part of that subtree to virtual-wallet/wallet-standard `6.0.4`
and `types-js@0.10.4-beta.2`, alongside the direct `types-js@0.10.3` and
starknet.js's v5 compatibility types.

The committed lockfile is therefore load-bearing. Keep application imports on
the direct tested surface, use structural wallet-standard types at the
boundary, and treat any lockfile regeneration as a connection-stack upgrade
requiring the Phase 0 wallet tests—not as a harmless install refresh.

*Verified:* inspected the installed package manifests and complete `npm ls`
tree after a clean repository sync on 2026-08-16. The direct versions remain
the approved pins; this finding records their actual transitive closure.

---

### 2026-08-16 — Phaser's official React template is broken under React 19 StrictMode

Do not copy `phaserjs/template-react-ts`'s `PhaserGame.tsx`. Verified in a real
browser on Phaser 4.2.1 + React 19.2: it produces **two `Phaser.Game`
instances, two WebGL contexts, two canvases, and runs `Scene.create()` twice**.

`Game.destroy()` only sets `pendingDestroy` and defers teardown to the next
`step()`, which needs requestAnimationFrame. StrictMode re-runs the effect
synchronously in the same tick, so the second `new Game()` happens first.

It self-heals on frame 1 in a **foreground** tab and **never heals in a hidden
tab** — rAF does not fire, so the orphaned game and its canvas sit there
indefinitely. For a PWA that backgrounds on mobile, that is a stuck WebGL
context.

**The fix:** a ref-counted singleton with `setTimeout(..., 0)` deferred
teardown, living in `packages/world/src/runtime.ts` rather than in a React
component, so React never owns the game. StrictMode re-runs effects but does
not recreate the DOM node, so the remount cancels the pending teardown.
Acceptance test: under `<StrictMode>`, `document.querySelectorAll('canvas').length === 1`
and `create()` logs exactly once.

Never pass `destroy(true, true)` — that destroys the global plugin cache and no
further Game can be created on the page.

*Verified:* browser run, plus Phaser v4.2.1 source.

---

### 2026-08-16 — Phaser steals keystrokes from focused React inputs

**Typing an amount into a building panel is impossible without an explicit fix.**

Phaser's KeyboardManager binds `keydown`/`keyup` to `window` with **no
`document.activeElement` check**, and `addKeys`/`createCursorKeys` default to
`enableCapture = true`. A real keydown dispatched from a focused `<input>`
produced both failure modes at once: `defaultPrevented === true` (the character
never reaches the input) **and** `Key.isDown === true` (the player walks).

Three traps in the obvious fixes:

- **`game.input.enabled = false` does NOT stop the keyboard.**
  `KeyboardPlugin.isActive()` ignores `manager.enabled`, while
  `InputPlugin.isActive()` honours it. It disables the mouse only.
- **`scene.pause()` is queued by the SceneManager**, not immediate. Read back in
  the same tick and the scene is still RUNNING with the key still down.
- **`Key.isDown` is sticky.** Disable the plugin while W is held and the key
  stays down forever — the player walks off screen when you re-enable.

**The fix:** `suspendInput()` / `resumeInput()` in `packages/world` doing
`disableGlobalCapture()` → `enabled = false` → `resetKeys()`, and the reverse.
Wire to `building:entered` / `building:exited`. Escape belongs to React — once
the plugin is correctly disabled, a scene-level ESC never fires and the panel
becomes unclosable by keyboard.

*Verified:* synthetic keydown from a focused input, plus Phaser v4.2.1 source.

---

### 2026-08-16 — Phaser 4 does not tree-shake; lazy-load it

`dist/phaser.esm.js` is a single pre-bundled webpack artifact with no
`sideEffects` field. Importing one class ships the whole engine: measured
**353 kB gzip** (1.38 MB raw). A custom arcade-only build saves ~9.5% for real
toolchain cost — not worth it.

A single *value* import of anything from `'phaser'` in the eager graph collapses
the lazy split and puts all of it in the entry chunk. With
`verbatimModuleSyntax: true` this is easy to do by accident — use
`import type * as Phaser` in type positions.

Also: `roundPixels` now defaults to **false** in Phaser 4 (it was true in v3).
On a tilemap with a following camera this reads as shimmering seams and gets
misdiagnosed as tileset spacing. `pixelArt: true` fixes it.

*Verified:* measured the published dist.

---

### 2026-08-16 — Tiled: the embed constraint is a warning, not an error

Phaser's rejection of external tilesets is a `console.warn`, so **a map with an
unembedded tileset loads "successfully" with blank tiles.** Author discipline is
not enough — add a build-time assertion that greps exported JSON for any
tileset entry carrying a `source` key.

Two related constraints found the same way:

- The check is `if (set.source)` — generic to any external pointer, not
  `.tsx`-specific. Exporting the tileset as `.tsj` JSON does **not** sidestep it.
- **"Collection of Images" tilesets are unsupported.** Every tile in a tileset
  must come from one image. Check this before adopting an asset pack, alongside
  the licence audit.

Tiled's own CLI can do the embedding as a build step —
`tiled --export-map json --embed-tilesets` — so districts can be authored
against one shared external tileset and flattened at build time. That keeps
authoring mergeable without risking the silent-failure mode.

Also: object-layer custom properties arrive as a raw
`[{name,type,value}]` array, **not** flattened into `object.properties.building`
the way tileset tile-properties are. The two code paths differ.

*Verified:* phaser@4.2.1 source, `ParseTilesets.js` and `ParseObject.js`.

---

### 2026-08-16 — No game-development MCPs exist; the tooling here is conventional

Searched the MCP registry for Phaser, Tiled, tilemap, sprite, pixel art, asset
generation and Godot. **Zero results.**

There is no MCP shortcut for the world build. The pipeline is ordinary desktop
and library tooling — Tiled for maps, Aseprite for sprites, a texture packer,
Phaser's own loaders. Do not spend time looking for one.

*Verified:* `mcp__mcp-registry__search_mcp_registry` with eight game-dev
keywords, 2026-08-16, empty result set.

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

**Superseded by “Ready 5.33.8 prompts for private reads and batches deposit
approval” above.** The sequencing concern remains, but current Ready's shipped
implementation combines the approval call(s) and pool privacy call into one
wallet transaction action.

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

### 2026-08-16 — AVNU private swap output is already a pool note

`@avnu/avnu-sdk@4.2.0` `buildStrk20Actions()` creates four actions: withdraw
the sell asset to AVNU's returned executor, withdraw the paymaster fee, create
an `OPEN` output note for the wallet, and invoke the executor with the
wallet-resolved note id. Do not offer a post-swap shield step: it would add a
public boundary after an output that is already private.

The server must bind the dynamic executor and serialized calls returned by
`quoteToCalls({ private: true })`; the browser must not provide an arbitrary
target. The proof output exposes the resulting `ServerAction` span, so the
relay can enforce that binding before submission without learning the wallet's
notes or viewing key.

*Verified:* inspected the installed SDK 4.2.0 declarations and runtime output;
backend and Wallet API adapter tests exercise the exact action and decoded
server-action shapes.

---

### 2026-08-16 — Never expire signed bridge evidence on a local timer

A 1Click signed quote is both resume state and dispute evidence. Deleting it
after 24 hours can erase the only complete record while a slow settlement,
refund or support case is still active. Retain it in browser-local storage
until the player explicitly discards it. Stop active polling after a bounded
window without marking the deposit failed, and use explicit sensitive-record
export/import for cross-device resume rather than a correlating backend table.

*Verified:* bridge persistence, signature revalidation, timeout, expiry and
export/import tests in `packages/bridge/src/bridge.test.ts`.

---
