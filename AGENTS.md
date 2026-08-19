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

### Workers stop at decisions

Workers execute a bounded lane brief; they do not make product direction or
cross-lane choices. If a worker reaches a key decision, finds the brief
ambiguous, or is undecided about what to execute, it must **stop before writing
the affected change** and ping the project-lead orchestration task at
`codex://threads/01a014f6-ede0-7681-818d-5428e71cfb6f` for direction.

The project lead does not decide that product or cross-lane choice alone. It
must present the decision, options, consequences and recommendation to the user
in that orchestration task and wait for the user's direction. Silence is not
approval. The user's answer is then recorded in `docs/DECISIONS.md` (and the
brief/seam is updated where needed) before the worker resumes. Fully specified
implementation details inside an approved brief do not need another
checkpoint.

### The user tests the game in a browser

For rendered game acceptance, stop and give the user a short test script for
the live current checkout at `http://localhost:5173/`. Do not spend agent time
automating Chrome or the in-app browser unless the user explicitly asks for
browser automation. Headless/unit/integration checks remain agent-owned; this
rule applies to visual and interactive browser acceptance of the game.

### Questions for the user are explicit gates

When the project lead needs an answer from the user, it must ping the user in
the orchestration task, ask the precise question plainly, and pause that
decision path. Do not bury a question in a progress update and then continue by
guessing what the answer might be. Independent work that does not depend on the
answer may continue.

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
  The hardcoded two-prompt claim appears in the snapshot at
  `strk20-wallet-api/SKILL.md:73-74` **and**
  `strk20-privacy-integration/references/wallet-api-route.md:60` — treat both
  as superseded by this correction.
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

### 2026-08-19 — WorldHost leases must single-flight lazy Phaser acquisition

React cleanup can beat a lazy Phaser import. The former stateless effect leases
then let overlapping StrictMode effects pass the runtime's pre-import host
check concurrently, creating and leaking two Games. `apps/web` now
single-flights overlapping leases, keeps a zero-lease pending acquisition
reusable, and releases the shared world only after the last live lease; failed
acquisition resets the manager without exposing a rejection.

*Verified:* deterministic acquire-count, peak-live, last-release and rejection
tests, plus the Web typecheck. No browser or Phaser context was used.

### 2026-08-19 — Fly production origins and lobby vocabulary are fixed at startup

Fly startup now cross-validates `FLY_PUBLIC_ORIGIN` against the trimmed
`LOBBY_ALLOWED_ORIGINS` list. The production-origin parser rejects localhost,
IPv4 `127/8`, IPv4-mapped IPv6 loopback in dotted and hexadecimal forms, and
placeholder/`.invalid` hosts with generic errors. The edge pins the opaque
`avatar-1` through `avatar-8` contract and keeps `/metrics` at 404; final art
maps cosmetically behind those keys.

*Verified:* origin membership and loopback/placeholder tests, generic-error
assertions, edge tests for the fixed sprite set and `/metrics`, Fly typecheck,
and invariant checks. No host, secret or deployment was used.

### 2026-08-19 — Kenney pavement and door mappings require lossless art review

The earlier pavement mapping used frame 86, an object/edge tile with a purple
lower-right block that repeated across the map. Lossless atlas inspection
identified seamless frame 109 for the broad pavement fill. The earlier door
mapping used frame 289, a tree-like object; the actual double-door is frame 284.
Broad map kinds do not encode edge orientation, so seamless interior fills are
required until authored edge semantics exist. Door presentation is a 32×32
overlay centered over the unchanged 64×32 trigger; it does not alter map,
collision or activation geometry.

*Verified:* lossless atlas pixel/rectangle audit, exact mapping and presentation
tests, the World suite, World typecheck and `./scripts/check-invariants.sh`.

### 2026-08-19 — Fly runtime must replace npm workspace symlinks

The Fly image's production lobby is compiled JavaScript, but `npm ci` installs
`@strkworld/shared` as a workspace symlink to the source tree. Copying only
`node_modules` into the final image leaves that link pointing at a path that is
not present, so package resolution is not proven by a successful build stage.
The Fly build now emits `packages/shared` and replaces that runtime link with a
small package manifest pointing at the compiled `src/index.js`. Docker was not
available for an image boot test; the Dockerfile layout is covered by a static
regression test, and the TypeScript emit was run locally.

*Verified:* read the npm workspace install layout and emitted Fly tree, then
ran `npx tsc -p deploy/fly/tsconfig.build.json --noEmit` plus the static Fly
tests. No image, secret or deployment was created.

### 2026-08-19 — RPC assurance needs credentials; the fixed backend seam is already fail-closed

The D-046 Alchemy choice cannot be meaningfully probed without an account,
keys and a real endpoint. Adding a credential-free Alchemy smoke test would
provide false assurance about method/version support, browser origin
allowlisting, server IP restriction, quotas or provider retention. The current
backend RPC seam is already narrow: it sends only fixed pool calls, block
number and transaction-receipt reads; environment parsing rejects placeholders
without echoing values; provider failures are generic and non-retrying; and
backend admission returns aggregate 429s without a client retry loop. Browser
RPC configuration is separate and public by design.

`scripts/check-drift.sh` defaults to the open Lava endpoint when
`STARKNET_RPC_URL` is absent. It is a read-only protocol drift canary, not
evidence that Alchemy is configured or suitable for production. Production CI
and deployment checks must inject the selected Alchemy server endpoint and
then run the exact method/version, origin/IP, quota/429, redaction and
retention checks from D-046.

*Verified:* read `apps/backend/src/environment.ts`,
`apps/backend/src/starknet-rpc.ts`, `apps/backend/src/api.ts`,
`packages/privacy/src/wallet-api/backend-client.ts`, their focused tests,
`scripts/check-drift.sh`, `docs/OPS.md` and the official Alchemy/QuickNode
RPC documentation. No account, key, endpoint, network RPC call or source
configuration was used.

### 2026-08-19 — Browser acceptance closes the local multiplayer seam; Bridge recovery is now resumable

The current checkout has passed the first rendered multiplayer acceptance:
multiple browser tabs connected to the local lobby and each tab displayed the
other player's avatar. The browser matchmaking request is credentialed, so the
lobby's allowlist must return `Access-Control-Allow-Credentials: true` for an
approved origin; disallowed origins must receive neither an allow-origin nor a
credentials grant. The reconnect path remains explicit and the lobby remains
presence-only.

The Bridge demo now persists its complete signed record in browser-local
storage. Reopening the Bridge exposes one concise resume action that refreshes
provider status before showing the next safe step; settled continuation still
uses only validated actual `strkReceived`. This does not change the D-043 gate:
real new quotes and deposit instructions still require a reviewed production
planner, while saved evidence remains inspectable, refreshable and exportable.

*Verified:* the user tested two live tabs at `http://localhost:5173/` and
confirmed mutual avatars; lobby CORS tests assert credentialed allowlisted and
blocked origins; Bridge persistence/resume and 43-test package suite pass;
typechecks, invariants and diff checks pass. No wallet, proof, signature or
transaction was used.

---

### 2026-08-18 — Bridge recovery outlives the room; deposit instructions do not outlive their evidence

D-043 is composed offline through a Shell-owned manual Bridge state machine
and the shared fixed-room core. Entering the room or touching
`bridge:deposit` performs no quote, poll, wallet, balance, proof or submission
work. A new quote is bound to the normalized active account and its actionable
deposit address/memo remains hidden until the signed minimum has passed an
injected public-shield planning preflight. Expiry, a non-awaiting status, an
account change, a changed signed record or a failed plan revokes those
instructions. Saved/imported signed evidence remains inspectable, refreshable
and exportable without an account or planner.

1Click quote creation is not abortable in the pinned service, so component
lifecycle state alone is insufficient. The Shell keeps a service-object-scoped
single-flight coordinator across room close/remount. Close or discard cancels
the UI claim; a late returned quote is deleted only when it is the exact signed
evidence that flight created. An explicit recovery import remains immediately
usable during a hung flight and is restored if the stale response later tries
to overwrite it; a later discard suppresses that restoration. This prevents a
provider response from resurrecting an orphaned deposit address or destroying
the player's chosen recovery record.

After `SUCCESS`, only validated actual `strkReceived` enters a fresh plan. The
ordinary Bank owns the separate shield review and receipt. Immediately before
wallet confirmation it rechecks the active account, machine generation, exact
settled record/amount and unchanged plan; no Bridge step prepares, signs or
submits automatically, and no Bridge-to-shield correlation is stored. The
offline demo supplies deterministic quote/status/planner fixtures and refuses
production. No production Ready planner exists, so real new quotes and deposit
instructions remain locked pending the fee-aware D-028 funded/source gate.

*Verified:* Shell commit `befda52` passed 329 web tests, web typecheck,
production build, invariant scan and diff hygiene. Independent adversarial
review replayed expiry, account-switch, close/import/discard, remount,
single-flight, stale-response cleanup, different-record preservation and Bank
commit-point cases with no remaining P1-P3 finding. No browser automation,
wallet prompt, proof, signature, provider quote or transaction was used;
rendered acceptance remains user-owned at `http://localhost:5173/`.

---

### 2026-08-18 — Ready public shielding is unsupported until fee handling is proven

D-043 retains a separate sanitized `PublicShieldPlanner` port and a
deterministic `FakePublicShieldPlanner`, but exports no production Ready
adapter or wallet-fee capability. Ready 5.33.8's shipped `URe` source emits an
ERC-20 approval for each deposit amount only. The canonical STRK20 pool source
at commit `66e3caae8c0201227a6719696d004e30d90aea65` proves
`apply_actions()` separately calls `collect_fee()`, which performs
`checked_transfer_from(STRK, caller, fee_collector, fee_amount)`. Shieldup's
pinned production shield path therefore approves `deposit.amount + fee` for
STRK. The visible Ready high-level route does not prove where that fee
allowance/transfer is supplied, so Chain must not infer an extra approval,
wallet execute fallback or AVNU/paymaster behavior. A real Bridge-to-Bank
handoff stays locked until a funded/source-verified fee-aware route is accepted.

The public port still defines `amountToShield` as the deposit action amount and
`plannedReserve = poolFee + estimated public gas`; a valid implementation must
prove `amountToShield + plannedReserve <= available`. Every monetary field is
denominated in the same Bridge public-STRK input token, and a planner must
reject a fee/gas denomination mismatch. The fake requires that token
explicitly, accepts a zero governance pool fee, rejects zero gas (so the
reserve remains positive), and enforces field-prime address/token bounds,
uint256 bounds, abort handling, non-positive remainder rejection and
deterministic changing estimates. No production planner claim crosses the
seam.

*Verified:* read the installed `starknet@10.4.0` declarations, the committed
Ready 5.33.8 bundle/source audit, canonical STRK20 `privacy.cairo`, and
Shieldup at `290f8306571ce45e630c5a08b243d7b5f8c232b4`. Vitest coverage asserts
the fake reserve arithmetic, normalization, abort/overflow/malformed inputs,
changing deterministic estimates and the absence of a Ready planner export.
No wallet prompt, proof, signature, submission, RPC secret or funded call was
used.

---

### 2026-08-18 — Direct 1Click needs no key, but its fee fields need clarification

The pinned `@defuse-protocol/one-click-sdk-typescript@0.1.25` accepts an
optional JWT and sends `Authorization: Bearer …` only when one is configured.
An unauthenticated browser call is therefore a supported route, not a missing
environment variable. Official 1Click documentation currently assigns that
route a 0.2% platform fee; authenticated distribution is described as
fee-free apart from protocol, spread and execution costs. D-043 chooses the
direct unauthenticated route for v1, with disclosure, rather than adding a
credential-bearing backend.

One live unauthenticated `dry: true` quote returned HTTP 201 and the advertised
unauthenticated rate limit, without issuing a deposit address or transaction.
It also echoed one 10-bps `quoteRequest.appFees` entry even though the request
omitted `appFees`. The relationship between that field and the documented
0.2% platform fee is not established. Until Defuse confirms it, show the
signed expected/minimum output and the canonical 0.2% disclosure, but do not
claim an exact total fee breakdown or call the echoed entry a STRKWORLD fee.

*Verified:* inspected the exact installed SDK constructor/request code, the
official API-key and fees pages, a read-only live dry quote, and Shieldup's
production 1Click client at commit
`290f8306571ce45e630c5a08b243d7b5f8c232b4`. Shieldup also calls 1Click
directly without a JWT. No credential, deposit address, wallet signature or
transaction was created.

---

### 2026-08-18 — Treat 1Click execution status as hostile runtime data

The generated 1Click SDK types do not validate the response received over the
network. In particular, a `SUCCESS` response can still carry an absent,
non-decimal, non-positive or over-uint256 `amountOut`; passing that value
directly to `BigInt` either throws a provider-shaped error or records a false
settlement. Transaction-hash arrays and their first entries need the same
runtime boundary. A destination hash is optional in the pinned SDK, so an empty
list is valid and must not prevent a genuine positive settlement from being
recorded.

`BridgeService.refresh()` now accepts settlement only after validating a
positive decimal uint256 amount, and validates any origin or destination hash
it surfaces as a bounded non-whitespace string. Malformed provider data leaves
the prior bridge record intact and produces one generic local error; it never
copies the provider payload into the player-facing failure. This validation is
independent of signed-quote verification: the quote binds the intended route,
whereas the later status response reports what actually settled.

*Verified:* adversarial service tests cover absent, null, zero, negative,
fractional, exponential, oversized and over-uint256 amounts; malformed hash
arrays and entries; an omitted optional destination hash; and every supported
terminal status. The 42-test Bridge suite, package typecheck, invariant scan
and independent read-only review all pass. No quote, deposit, wallet signature
or transaction was created.

---

### 2026-08-18 — Exchange confirmation has three independent freshness gates

D-042 exposed three places where a truthful prepared swap can go stale without
changing its public shape. `swapReview.expiresAt` is Unix epoch
**milliseconds**: the backend normalizes AVNU's seconds before the browser sees
it, so Shell must construct `Date` directly from that value and recheck it both
when the review is accepted and immediately before wallet handoff. Multiplying
it by 1,000 produces a plausible but false far-future date rather than a useful
failure.

The session uncertainty gate has the same time-of-check problem. Checking it
before the live pool-fee read is insufficient because another action can become
uncertain during that await. Exchange now checks after the read and again at
the last instruction before `PreparedBatch.confirm()`. The fee ceiling remains
the hard wallet-side guard; when a stale Shell fee read is followed by a
generic ceiling rejection, a second pool read classifies the failure as a moved
fee instead of inventing an error-string contract.

Finally, uncertainty blocks new financial work, not evidence of work already
settled. A restored Exchange receipt renders ahead of the blocked compose or
review branches, and successful confirmation records the receipt before any
panel-liveness check. Closing a room after wallet handoff therefore cannot hide
the hash, while a late hashless rejection still promotes the one-bit session
uncertainty notice and never creates a retry path.

*Verified:* adversarial tests hold fee reads and confirmations with explicit
deferreds, close only after the wallet handoff is observed, advance an injected
clock across quote expiry, flip uncertainty during the awaited fee read, and
exercise the stale-read/second-read fee classification. Static rendering pins
the canonical amounts, slippage, millisecond UTC expiry, exact fees and D-024
copy inside `ConfirmGate`, hides confirmation while blocked, and keeps a
settled receipt visible. The web suite passes 285 tests; typecheck, production
build, invariant scan and diff validation pass. No browser, wallet, proof,
signature or transaction was used.

---

### 2026-08-18 — Prepared swaps canonicalize AVNU’s protected minimum

D-042 changes only the prepared swap’s internal intent value, not the frozen
public shape. After validating the AVNU plan, Chain computes the protected
minimum with exact bigint arithmetic:
`expectedAmountOut - (expectedAmountOut * slippageBps / 10_000)`. It rejects a
nonpositive result or a requested quote floor above that result, then returns a
canonical single-swap intent whose `minAmountOut` and sanitized
`swapReview.minimumAmountOut` are identical. Confirm-time validation uses that
canonical intent, so a later fee/quote recheck cannot fall back to the
provisional floor.

The deterministic fake applies the same calculation only when explicit
expected-output/slippage configuration is supplied; it derives no market rate,
reads no clock, and omits `swapReview` when unconfigured. Quote-bound immediate
submission and D-034 uncertainty handling are unchanged.

*Verified:* the rounding, canonical-intent/review equality, above-protected
floor rejection and fake determinism tests were observed red before the shared
helper and mappings were added, then green. The full privacy suite passes 70
tests; package typecheck, invariant checks and diff validation pass. No wallet,
proof, signature or transaction was used.

---

### 2026-08-18 — A shared financial machine needs an explicit receipt owner

D-039/D-040 reused the Bank's financial state machine for Post Office transfer
surfaces. Parameterizing the title, allowed modes and batch limit was not
enough: receipt restoration still queried `pending('bank')`, and successful
submissions still recorded `building: 'bank'`. A Post Office transfer could
therefore reappear in the Bank and fail to reappear where it was made.

Receipt ownership is now an explicit building input to the shared machine,
defaulting to Bank for compatibility and passed as Post Office by both its Menu
Mode adapter and Game Mode station. The same review found a React lifecycle
trap: an inline `['transfer']` array changed identity on every wrapper render,
which could recreate the memoized financial machine and discard queued state.
Station configuration arrays that participate in machine ownership are stable
module values.

*Verified:* red/green tests pin Post Office pending-receipt restoration,
Post Office receipt recording, Bank's unchanged default ownership, two-transfer
Menu batching and the station's one-intent limit. The full workspace passes 598
tests across 57 files, every workspace typecheck, the production build, the
invariant scan and `git diff --check`.

---

### 2026-08-18 — Prepared swap review is sanitized and deterministic

D-041 adds the optional `PreparedBatch.swapReview` field for a successfully
prepared single AVNU swap. It contains only the validated expected output and
expiry, the typed intent's minimum output, and the exact slippage policy used
to request the quote. Quote IDs, executor data, calldata, authorizations,
paymaster details and recovery handles remain private. The Wallet API adapter
rejects malformed or stale expected-output/expiry data before returning a
review. Pool-native batches have no review field.

`FakePrivacyOperations` exposes review data only when its explicit deterministic
configuration supplies expected output, expiry and slippage; it derives the
minimum from the swap intent and never reads a clock or invents a market rate.
The existing quote-bound immediate submission and D-034 accepted-hash versus
hashless uncertainty semantics are unchanged.

*Verified:* targeted Wallet API and fake tests were observed red before the
mapping, then green after the adapter, public type, fake configuration and
sanitization assertions were added; privacy typecheck and invariant checks also
pass. No wallet, proof, signature or transaction was used.

---

### 2026-08-18 — A reusable room is authored data, so validate it before Phaser owns it

Extracting the accepted Bank interior into D-039's shared fixed-room core made
two Bank-specific assumptions visible. First, TypeScript types do not protect
the runtime from malformed authored geometry. A room definition is now rejected
before controller listeners or Phaser objects exist unless its dimensions are
positive integers, its spawn is a walkable interior tile, its exit is a
positive in-bounds border rectangle, and it has at least one valid interior
station. Station IDs must match the room's building, and duplicate IDs,
overlapping footprints and overlapping approach halos are rejected. Ambiguous
approach ownership must never depend on definition order.

Second, one Phaser text object cannot present a data model that permits several
stations: each loop iteration overwrites the previous label. The adapter now
owns one label per opaque station ID and hides and destroys the full collection
with the room lifecycle. A Phaser-free presentation projection pins that
one-to-one relationship independently of rendering.

The same runtime-boundary rule applies in Shell. The reused financial machine
now rejects non-array, empty, unsupported and duplicate mode lists, plus an
initial mode outside that list, even from untyped callers. The Post Office Game
Mode tracer exposes one Transfer action and reuses the existing recipient
preflight, route admission, commit gate, receipts and uncertainty handling; it
does not leak Menu Mode's batch controls. D-039 left Post Office Menu Mode as
the honest unbuilt surface; D-040 now completes it as a separately bounded,
transfer-only batch surface with explicit Post Office receipt ownership.

*Verified:* validation and multi-station presentation were driven by 15 observed
red tests plus a separately observed empty-station regression; the Shell's
untyped configuration cases and station-only surface were also observed red
before green. Focused integration passes 140 tests across six World/Shell
files, and both affected package typechecks pass. No shared event, lobby or
privacy seam changed. The full repository passes 588 tests across 56 files,
all workspace typechecks, the production build and the invariant checker.

---

### 2026-08-18 — Vite workspace scripts do not find the repository-root env by default

The root setup guide and committed `.env.example` tell developers to create
`STRKWORLD/.env.local`, but `npm run dev` delegates to the `apps/web` workspace.
Without an explicit `envDir`, Vite searches from that workspace root and
silently misses the repository-root file. The practical symptom for D-037 is a
truthful but surprising solo game even though `VITE_LOBBY_URL` appears to be
configured; the same trap applies to every browser-side `VITE_*` setting.

`apps/web/vite.config.ts` now sets `envDir: '../..'`, making the committed root
template and setup command the actual configuration contract. Vite still
exposes only `VITE_`-prefixed values to browser code; backend secrets remain
runtime process variables and must never be prefixed or sent through Vite.

*Verified:* the config regression test was observed failing before `envDir`
was added. A temporary root `.env.envprobe` containing only a harmless lobby
marker was then loaded by a separate Vite mode on port 5199, and the served
`import.meta.env` contained that exact marker. The probe file and server were
removed afterwards; no secret was read or written.

---

### 2026-08-18 — Remote peer state must replay, and self-filtering must wait for welcome

D-038 carries remote avatars through a dedicated World-owned retained source,
not the one-shot shared event bus. `subscribe()` synchronously replays the
latest immutable full snapshot, so a lobby update that arrives before Phaser
boots or while it remounts is not lost. The Shell owns the LobbyClient adapter
and clears the source on drop, replacement and teardown; World owns validation,
full replacement, safe cosmetic fallback, interior hiding and non-physics
presentation.

The first integrated review exposed a second ordering consequence of the
existing pre-welcome window: `LobbyClient` had a room and emitted peers before
it knew its own server-minted `gameId`, so `peers()` could not self-filter and
briefly published the local avatar as a remote one. `peers()` now returns an
empty snapshot until welcome supplies the ID; the welcome handler then emits
the correctly filtered full snapshot. Do not infer that a room or `connected`
status is enough to distinguish self from peers.

A second test now crosses the complete real composition seam with two
`LobbyClient`-backed Shell controllers against one local Colyseus server. It
proves that the retained World snapshots contain the other server-minted
identity only, replace on movement, clear when the other player enters the
Bank, resume at the restored street placement on exit, and clear on controller
or server teardown. Keep one server per test file because the matchmaker is a
process-global.

*Verified:* a new real-server websocket test was observed failing on the old
client because one pre-welcome snapshot contained the eventual local ID, then
passing after the identity gate. D-038's source/renderer/adapter suites cover
synchronous replay, immutable replacement and clear, stale callbacks, invalid
data, safe textures, interior visibility and idempotent teardown. The final
integrated gate passed 548 tests across 53 files, all workspace typechecks, the
production build and repository invariants. No browser, wallet, financial data
or transaction was used. After the real composition and environment-contract
regressions were added, the repository gate passed 550 tests across 55 files
with the same typecheck, build and invariant gates green.

---

### 2026-08-18 — Lobby `connected` precedes welcome completion

`LobbyClient.connect()` does not resolve at the same moment the client becomes
visible. After Colyseus returns a room, the client stores the room and emits
`connected`, then waits up to five seconds for the server-minted welcome ID.
The Shell must therefore react to the status edge itself. Waiting for the
`connect()` promise before suspending lets an avatar remain visible after its
player has entered a building; treating the controller as suspended without
calling the client can then make physical exit call `resume()` on a connected
or closed client.

The D-037 controller now suspends immediately when `connected` arrives while
the World is inside, never promotes a dropped pre-welcome join back to
`suspended`, and preserves only an explicitly requested reconnect through that
race. Teardown unsubscribes status listeners and closes a room acquired after
the first disconnect attempt, so an HMR or page exit cannot leave a late lobby
presence behind.

*Verified:* read the pinned `packages/lobby/src/client.ts` join order and drove
adversarial red/green controller tests where entry precedes `connected`, a
server drop precedes welcome completion, exit follows the drop, and destroy
precedes late room acquisition. No browser, lobby server, wallet or network was
used.

*Manual acceptance:* the user hard-refreshed the live checkout at
`http://localhost:5173/`, confirmed the explicit solo state left the street
playable, and re-entered the Bank to verify that the shield/unshield station
still highlighted and opened its action window.

---

### 2026-08-18 — `PrivacyOperations` is source-derived and frozen

D-036 freezes the current financial seam after the D-034
`submission-uncertain` classification and D-035 Shell acknowledgement gate
landed and passed integrated review. The freeze covers the five
`PrivacyOperations` methods and their transitive public contract: typed
intents, prepared-batch confirm/discard behavior, costs and warnings,
capability/pool/balance/recipient/result/progress shapes, and the public error
taxonomy. Any change now requires a decision and dependent-lane heads-up before
implementation.

This supersedes the older “not ready for D-028 freeze” finding below because
its exact blocker has been resolved. It does **not** turn source evidence into
a funded-mainnet claim: prompt count, rendered prompt sequence, latency,
Ready/Xverse behavior and AVNU acceptance of a real wallet-produced artifact
remain pre-launch validation under D-028.

The required freshness probe still reports discovery `next` 6.0.4,
wallet-standard `next` 6.0.5, and upstream replacement of
`packages/sub_account_anonymizer` by
`packages/shadow_account_anonymizer`. Stable Wallet API 0.10.3 and AVNU 4.2.0
remain unchanged. STRKWORLD keeps its exact tested direct pins and current v1
routes; the freeze neither upgrades dependencies nor admits a shadow-account
route.

*Verified:* reran the vendored integration freshness script against npm,
GitHub and the Wallet API release list; inspected the installed package types
and exact package pins; and ran the privacy package tests/typecheck plus the
repository documentation, invariant and diff checks. No wallet was opened, no
proof or signature was produced, and no transaction was submitted.

---

### 2026-08-18 — Phaser starts auto-start scenes before `postBoot`

The Bank room exposed a lifecycle ordering error in the World composition
root. `runtime.ts` put the World/Shell buses into `game.registry` from the
Phaser config's `postBoot` callback, while `street-scene.ts` captured that
registry value when it created the Bank controller. The controller therefore
captured `undefined` and could never receive the Shell's `world:stations`
snapshot. The street door still worked because its emitter resolved the bus
lazily, making the failure look like a station collision problem: the player
could enter the Bank and reach the station, but the station remained locked and
could neither highlight nor activate.

The exact Phaser 4.2.1 order is: `Game.texturesReady()` emits `READY`;
`SceneManager.bootQueue`, already registered on that event, synchronously
starts the auto-start scene and runs its lifecycle; only after the `READY`
listeners return does `texturesReady()` call `Game.start()`, which invokes
`config.postBoot`. Comparing only `Game.start()` with the first loop step misses
the synchronous Scene Manager path. A dependency needed by scene creation must
be installed in `preBoot`, which `Game.boot()` invokes before the `READY` event,
or supplied without relying on registry timing.

*Verified:* the user's fresh-checkout screenshot showed the avatar stopped at
the station but no highlight or window. Pixel sampling the station fill gave
`#655f67` after screenshot colour conversion, matching the source's locked
`0x665f67` branch rather than available brown `0xb07b41` or highlighted gold
`0xe2b45d`. The current Shell station-resolution tests pass. The installed
`phaser@4.2.1` source was traced through `core/Game.js:texturesReady/start` and
`scene/SceneManager.js:bootQueue`, confirming the ordering above. No wallet,
network or transaction was used. The regression was then observed failing on
the old `postBoot` wiring with an undefined scene bus and passing after the bus
moved to `preBoot`; the full repository suite passed 496 tests. Finally, the
user hard-refreshed the current localhost checkout, approached the same station
and confirmed that it highlighted and opened the Bank action window.

---

### 2026-08-18 — Shieldup balances reconcile state, not a hashless submission

Shieldup is a useful production-behaviour reference, but it does not close
D-034. Its private paymaster wrapper returns a transaction hash only after a
successful JSON-RPC response; fetch failure has no phase, accepted signal,
idempotency key or recovery lookup. The transfer, unshield and private-swap
callers then wait for confirmation inside the same error boundary, so even a
known hash can be discarded by a later provider-read failure. Its current
"nothing went on-chain" unavailable copy is therefore not safe to copy for a
post-dispatch response loss.

Its balance model is the reusable part: discover every unspent private note,
tally by token, poll every 30 seconds and offer manual refresh, while preserving
an optimistic value when discovery is temporarily unavailable. That gives the
player eventual state reconciliation, but there is no transaction-hash-to-note
correlation and no authoritative submission lookup. A changed balance can
support resolving an uncertain action; an unchanged balance cannot yet prove
that it failed, and a retry before settlement can still duplicate intent.

Use Shieldup as a behaviour and test-seam reference only. It directly hosts an
indexer discovery provider, proving service and viewing-key identity through
`@starkware-libs/starknet-privacy-sdk`; copying that infrastructure would break
STRKWORLD's D-002 trust boundary. STRKWORLD's Wallet API implementation and
vendored Wallet API types remain authoritative.

*Verified:* authenticated read-only audit of private repository
`Calcutatator/shieldup` at clean `main`
`290f8306571ce45e630c5a08b243d7b5f8c232b4`, including
`private-paymaster.ts:247-280,408-435`,
`shielded-ops.ts:279-359,462-584`, `shielded-balances.ts:54-109`,
`Home.tsx:516-600,1038-1210,1253-1258,1384-1541`, `history.ts:20-121`
and `sdk.ts:200-238`. The commit and the two central source excerpts were
independently fetched through the GitHub API. In the reference checkout,
`npm run typecheck`, `npm run build` and all 213 logic checks passed; there is
no adversarial execute-response-loss or balance-reconciliation test.

---

### 2026-08-18 — Known hashes survive gateway failure; hashless response loss remains uncertain

`PrivateSubmissionGateway.submit` now has an internal `onAccepted` signal.
Pool-native private and quote-bound swap confirmations retain the first
accepted `TxResult`; if the gateway later throws, `PreparedBatch.confirm()`
returns that hash, emits success, and remains single-attempt. The production
`BackendPrivacyClient` reports acceptance immediately after validating the
response hash.

This closes the “once a hash exists, surface it” part of the 2026-08-17
settle-then-throw finding. It cannot close a connection drop **before** the
hash reaches the browser: the current backend exposes neither an idempotent
submission lookup nor an earlier recovery handle, so Chain code cannot know
whether the relay accepted the transaction. Today that transport path maps to
`PrivacyError('unreachable')`, while the Shell's exhaustive copy says “Nothing
was sent.” A blind retry could therefore duplicate intent even though the
prepared proof itself is single-attempt.

`PrivacyOperations` is **not ready for the D-028 source-derived freeze** until
one controlled cross-lane decision chooses either (a) a public
`submission-uncertain` outcome with non-retry Shell handling, or (b) a
privacy-safe idempotent backend recovery mechanism. Do not broaden the current
Chain change into either lane without that decision.

*Verified:* red/green Wallet API seam tests make both transfer and swap
gateways report an accepted hash and then throw; each confirmation returns the
receipt, a second confirmation is rejected, and the gateway is called once.
`BackendPrivacyClient` has a separate red/green contract test for the
acceptance signal. The hashless case was verified by tracing `post()`'s fetch
failure path and the Shell's exhaustive `unreachable` copy. No network, wallet,
proof, signature or transaction submission was used.

---

### 2026-08-17 — The composition root, and the one door the world never closes

Wired the shell's composition root (`apps/web/src/main.tsx` + `App.tsx`) over
the World lane's door triggers, all against the fake. Three things the next
agent in `apps/web` or the World lane should know.

**`world:exit-building` exists in the frozen bus, but the world does not consume
it yet.** `packages/shared` declares it in `ShellEvents`, so the shell emits it
on panel close as designed — but `street-scene.ts` only reads the `in` bus's
type, never subscribes to it (grep: the sole reference to `in` in
`packages/world/src` is the runtime's config type). And the world does not
install its own `input-gate` in the scene either. Net effect today: closing a
panel with the Close button emits `world:exit-building` into the void, and
because input is never suspended, the player was free to walk the whole time.
Walking off an *entered* door emits `building:exited`, which closes the panel —
so the Bank closes on walk-away. This is a World-lane wiring gap, not a shell
one; flagged, not touched.

**The locked Vault emits no exit, by the world's own design.**
`door-trigger.ts:60-61` emits `building:exited` only for a door that was
actually *entered*; a locked door emits `building:locked` on arrival and
nothing on departure (asserted in `door-trigger.test.ts:58`, "never
entered/exited"). So the shell's locked surface cannot auto-close on
walk-away — it is dismissed with its Close control instead. Auto-close would
need the world to emit an exit/left signal for locked doors (or gate input on
`building:locked` the way it does on `building:entered`). That is a
World/shared change; the shell handles what the contract actually sends.

**The preview dev server can bind to the wrong checkout.** A dev smoke against
`preview_start` served a stale `main.tsx` (`export {}`) because the reused
preview process was rooted in a *different* clone in the scratchpad
(`scratchpad/STRKWORLD`), not the working tree. Confirmed by the served module's
sourcemap carrying the old content and `ps` showing the vite process's cwd.
Running `vite` directly from the actual clone rendered correctly: React mounts,
`main.strkworld` + `.world-host` + a Phaser canvas present, the street draws
(facades, pavement, grass, avatar, camera-follow), zero console errors. If a
preview looks stale, check the vite process's working directory before
believing the code is wrong.

*Verified:* `npm run build` succeeds with Phaser (1.38 MB) and the seam-bearing
`demo-operations` (543 kB, pulls starknet) in their own lazy chunks, entry chunk
229 kB; `scripts/check-headers.mjs` green (no isolation headers); full suite 414
across 35 files; the browser mount checked in a real Chromium against the
correct clone. No wallet, no network, no transaction.

---

### 2026-08-17 — Colyseus: the first client's join options can become the room's config

This is the highest-severity finding in the project so far, and it broke the
core lobby invariant in shipped code. A room's `onCreate` is called by the
matchmaker with `merge({}, clientOptions, handlerOptions)`
(`@colyseus/core@0.17.50` `MatchMaker.mjs`, `handleCreateRoom`), where `merge`
(`utils/Utils.mjs`) is a shallow last-wins copy. When the room is defined with
empty handler options (`server.define(name, Room, {})`), the merged object is
just `clientOptions` — the join payload of whichever unauthenticated client
created the room. A room that reads its configuration from that argument lets a
client set it.

The lobby did exactly that: `spriteKeys`, `defaultSprite`, `interestRadius`,
`maxVisiblePeers`, `minUpdateIntervalMs`, `capacity` and `worldLimit` were read
from `onCreate`'s options. One `POST /matchmake/joinOrCreate/street` with
`{"spriteKeys":["0xdead… 12.5 STRK to the Bank"],"defaultSprite":"…same…"}` —
no socket, no second step — made an honest observer's `peers()` return a peer
whose sprite was that string. A hex id, a token amount and a building name on
the wire: a direct break of "the lobby never sees money", and the
allowlist-based normalisers were validating against an allowlist the attacker
wrote. `capacity: 99999` → `maxClients` 99999 was reproduced the same way.

**Fix, defence in depth.** (a) The room reads config only from a
`protected roomConfig` field set at construction, and ignores its `onCreate`
options argument entirely (the parameter is named `_untrustedOptions`).
`definePresenceRoom(config)` returns a subclass that bakes the trusted config
into that field, so it is captured in the class, never routed through
matchmaking. (b) `startPresenceServer` also passes the resolved config as
define-time handler options, so even Colyseus's own merge favours it. (c)
`resolveRoomConfig` clamps every numeric field (capacity ≤ 128, etc.) so a bad
value cannot produce an unbounded room even if the boundary failed.

**Server-mint the identity too.** The same class of trust error applied to
`gameId`: it was client-supplied. It is now minted on the server at `admit()`
and a client-supplied one is ignored (the join `PlacementRequest` type has no
`gameId` field). The client learns its assigned id from a one-off `welcome`
message. "Ephemeral per-session" is now enforced, not trusted.

*Verified:* reproduced the exploit end-to-end (a raw `joinOrCreate` with hostile
options; an honest observer then saw the injected string as a peer sprite) —
the assertion failed on the shipped code. After the fix the same scenario shows
trusted sprites and the injected string reaches no one; a unit test drives a
room's `onCreate` with hostile options and asserts `maxClients` stays the
trusted default; 82 lobby tests pass. Read `MatchMaker.mjs`/`Utils.mjs` in the
pinned build to confirm the merge order.

---

### 2026-08-17 — Colyseus matchmaker is a process-global; one Server per test file

`matchMaker` in `@colyseus/core` is a module-level singleton shared by every
`Server` in the process. Starting a second `Server` and later calling
`gracefullyShutdown()` on it tears down shared matchmaker state, and a room
created on a *different* still-running server then answers matchmaking with a
truncated body — the client-side symptom is `SyntaxError: Unexpected end of
JSON input` from the SDK's `fetch`+`JSON.parse`, not an obvious server error.

So tests that need to shut a server down mid-run, or need a differently
configured server, must not share a process with another server. Vitest
isolates each test file in its own worker, so the rule is **one `Server` per
test file**: the reconcile suite and the server-drop suite each got their own
file. Also relevant to production: run exactly one presence `Server` per
process.

Two smaller server-side facts confirmed while fixing the above, both overridable
process-globals reached through the exported `matchMaker`:

- **CORS default is permissive-with-credentials.** `matchMaker.controller`'s
  `DEFAULT_CORS_HEADERS` sets `Access-Control-Allow-Credentials: true` and
  `getCorsHeaders` reflects the request `Origin` (or `*`). `startPresenceServer`
  overrides both to an origin allowlist with no credentials header.
- **Per-connection debug channels are exported `debug` instances.** Setting
  `.enabled = false` on `debugConnection`/`debugMessage`/`debugPatch` (and
  `presence`/`driver`/`matchmaking`) from `@colyseus/core` hard-disables them
  regardless of the `DEBUG` env var, which is narrower than `debug.disable()`
  and leaves unrelated `debug` usage alone.

*Verified:* the JSON-input failure appeared only when a shutdown-in-file test
sat beside another server in `client.test.ts`, and vanished once each was moved
to its own file (78→ stable across repeated runs). A subprocess launched with
`DEBUG=colyseus:*` that joins and sends a move prints zero coordinates and zero
`colyseus:message`/`patch`/`connection` lines. An `OPTIONS` preflight from a
disallowed origin comes back with no `Access-Control-Allow-Origin` and no
credentials header; an allowed origin is reflected.
---

### 2026-08-17 — World lane: the object-layer property trap, plus two adjacent ones, building the door triggers

Building commit 2 (door triggers) against the earlier finding that object-layer
custom properties arrive un-flattened. Confirmed it end to end and found two
adjacent traps the next World/Shell agent would otherwise hit.

**The property trap, with the exact mechanism.** Object-layer objects keep
Tiled's raw `properties: [{ name, type, value }]` array; tileset tile-properties
are flattened to a keyed object. The divergence is two functions:
`tilemaps/parsers/tiled/ParseObject.js` builds the object with
`Pick(tiledObject, [...,'properties',...])`, and `utils/object/Pick.js` copies
each listed key **verbatim** — so the array passes straight through. Meanwhile
`ParseTilesets.js` (the `set.tiles` loop, ~line 62-70) does
`tile.properties.forEach(p => newProps[p.name] = p.value)`. So
`object.properties.building` is always `undefined`; you must flatten first.
Isolated as `packages/world/src/tiled-object-props.ts:flattenProperties` with
its own test that pins the array-has-no-keyed-access shape so the reason it
exists cannot be optimised away.

**NEW — object-layer coordinates are PIXELS, tile logic is TILES.** A Tiled
rectangle object carries `x/y/width/height` in pixels with a top-left origin;
the world's `DoorZone`/`doorAt`/`worldToTile` work in tiles. The adapter
(`objectLayerToDoors`) divides by `TILE_SIZE` on the way in. Skip that and every
door lands `TILE_SIZE` (32 px) off its facade — and it still *looks* like a door
on screen, so it is the kind of bug a look does not catch. The adapter also
fails closed: an object whose `building` property is absent or names a building
outside the shared `BUILDINGS` registry produces no door, rather than a door to
nowhere.

**Status: superseded by “Phaser starts auto-start scenes before `postBoot`”
(2026-08-18). The bus-timing claim below is wrong; do not act on it.**

**NEW — the `game.registry` bus is present by `create()`, but read it lazily
anyway.** The scene emits on the bus the shell stashes with
`game.registry.set('bus', ...)` in the Phaser config's `postBoot`. `Game.start`
(core/Game.js ~line 410) calls `this.config.postBoot(this)` **before**
`this.loop.start(...)`, and scene `create()` runs on the first loop step — so
the bus is already set when `create()` runs. The scene still resolves it
per-emit rather than caching it in `create()`: it costs nothing, it stays
correct if that ordering ever shifts, and it degrades to a no-op under a
headless/bus-less boot (which is what keeps the door-trigger state machine
unit-testable with a fake bus instead of a game).

*Verified:* read the named phaser@4.2.1 source (`ParseObject.js`, `Pick.js`,
`ParseTilesets.js`, `core/Game.js`) directly from the installed package, not
docs. The property flattening, the pixel→tile conversion and the door-to-door
enter/exit transitions are covered by 16 new headless tests
(`tiled-object-props.test.ts`, `door-trigger.test.ts`, and object-layer cases in
`map/street.test.ts`) that assert against a fake bus — no Phaser, no canvas, no
network. `building:locked` already existed in the frozen `WorldEvents`
(`{ building; reason: 'coming-soon' }`), so the Vault routes through it; nothing
in `packages/shared` was touched.

---

### 2026-08-17 — Chain lane: the private/swap submit paths can settle a tx then throw, losing the hash

`packages/privacy/src/wallet-api/operations.ts`: `prepareShield` deliberately
guards the settle-then-throw case — once the wallet returns a transaction hash
the public deposit may already be on-chain, so it does not turn a post-submit
failure into a retryable cancellation. **`preparePrivate` and `prepareSwap`
have no equivalent guard.** If `owner.submission.submit(...)` rejects *after*
the relay has already accepted the tx on-chain (e.g. a dropped response),
`confirm()` throws and the caller records no receipt — a settled transaction
reported to the player as nothing. This breaks the same "a settled tx must
leave a receipt" invariant the shell's receipt ledger was built to uphold, but
the shell cannot close it: the seam hands back no hash on the throwing path.

**Chain lane fix:** give the private and swap submit paths the same
post-submit success-preservation `prepareShield` already has — once a hash
exists, surface it even if a later step fails, rather than throwing it away.

*Verified:* adversarial trace of `wallet-api/operations.ts` submit paths
against the `prepareShield` guard, 2026-08-17, during PR #6 verification. Not
reproducible against the deterministic fake (which never settles-then-throws),
which is exactly why it survived the shell's tests — the hole is in the real
seam only.

---

### 2026-08-16 — The unmount is not the player's decision, and neither is the receipt

Second review round on the Shell lane. The blockers held, and three reachable
breaks remained. All three are the same shape: an async step finishing into a
world that has moved on.

**A panel is unmounted by the world, not by the player.** `building:exited`
unmounts the building panel, so a transaction that settles during that window had
its hash written into a store that no longer exists — settled money, no receipt,
nothing said. Receipts therefore live in a ledger above the panels, written the
instant the seam returns and *before* any liveness check, and a reopened room
finds what is outstanding. Disabling the close button is not the fix: it traps
the player behind a wallet that may never answer, and the world can unmount the
panel anyway.

**Do not discard a batch the wallet is already signing.** Writing the fix above
exposed a second defect immediately: the panel's close path called
`PreparedBatch.discard()` unconditionally, and the seam is entitled to treat a
discarded batch as unsubmittable — the deterministic fake does exactly that. So
closing the room *cancelled a settling transaction*, turning "the player walked
out" into "it never happened". A batch handed to the wallet is no longer the
shell's to release.

**One invalidation counter is not enough.** Guarding balance reads with the same
counter that guards submissions means a balance read cancels a submission. Three
clocks, three reasons: a newer attempt, a closed panel, a newer read. Without the
third, a read in flight when a submission lands restores the pre-submission
figure underneath a notice saying the balance has changed.

**And, again: verify the test, not just the code.** Two more tests in this lane
passed while asserting nothing. One checked that a disclosure appeared "before
the confirm button" — satisfied by the panel header, so it would have passed with
the commit gate rendering no disclosure at all. The other exercised the window
*before* signing rather than after, which is the safe one. A test written against
a bug you have already fixed proves nothing unless you have watched it fail.

*Verified:* every fix by a test observed failing first. The receipt tests hold the
seam inside `PreparedBatch.confirm()` with a deferred rather than a timer, so the
close lands mid-signature deterministically — and it was that test, not review,
that caught the discard defect. The header-disclosure fix was verified by
reverting it and watching the new test fail. The import-boundary test was
verified against three separate escape hatches (a bare side-effect import, a
package subpath, a bare deep import), each observed failing, then removed.

**And the stale quote was real, found by CI within the hour.** The Chain lane's
varying-gas fake (PR #5) landed while this branch was open, and the MAX test
that passed locally failed on CI immediately: the relay fee is charged per
action, so a figure measured on a one-intent batch is not the cost of a
two-intent batch. Reusing it made MAX a floor rather than a maximum — the same
bug in a smaller coat.

A quote is now evidence about **one batch shape** and nothing else, keyed by the
sorted intent kinds, and MAX is offered only for a shape that has actually been
costed. No interpolation between two observations: a fitted curve is still a
guess about somebody's money, and the seam has no non-proving estimate call to
ask instead. The cost is that MAX is unavailable the first time a visit reaches
a new shape, which is the same answer D-022 already forces for unknown note
maturity — not a guess, and not the total.

*A seam gap worth naming:* `PrivacyOperations` has no cheap cost estimate.
`prepare()` is the only oracle and it is a wallet proving interaction, so the
shell cannot cost a batch it has not yet asked the player to approve. A
non-proving `estimate(intents)` would let MAX be exact on first use for any
shape. That is a Chain-lane call, not a shell workaround.

---

### 2026-08-16 — A correct state machine can still be a wrong screen

Review of the Shell PR found four blockers. The machine layer passed 84 tests
and every one of those blockers was real, because all four lived in the gap
between what the machine decided and what a player could see or do.

**The disclosure was keyed to a control, not to the batch.** The Bank showed
the approved D-024 copy for the mode tab currently selected. Queue a shield,
click the transfer tab, and the disclosure unmounted while the shield stayed
queued and confirmable — a public deposit committed with the approved copy
nowhere on screen. The fix is structural rather than careful: disclosures are
derived from the intents actually queued, carried on the prepared summary, and
rendered by the one component that owns the confirm button. A panel cannot ship
a confirm button without passing the disclosures for what it commits.

**A guard that runs before an `await` is not a guard.** `confirm()` checked the
flow, then awaited a fee read before moving out of `review`. Two clicks in one
tick both passed the check. Worse, a late rejection from an abandoned attempt
could overwrite a settled `submitted` with `failed` — telling a player nothing
was signed about a transaction that had settled. Both are fixed by moving the
state transition above every await and giving each attempt an id that later
patches check.

**A reserve must match the accounting that spends it.** MAX subtracted only the
pool fee, but prepare charges pool fee *plus* the relay/gas estimate from the
same shielded balance, so MAX-then-review failed every time. The seam only
reports the network cost at prepare time, so there is no maximum to offer before
the first quote — the panel now says so instead of guessing, which is the same
rule D-022 already forces for note maturity.

**A lint-style test must be verified by breaking the code.** The first version
of the shell's import-boundary test passed while asserting nothing: its regex
matched the word "imports" in a doc comment rather than the import statement
below it. It also missed `export … from` entirely, so a re-export of the
forbidden path would have sailed through.

*Verified:* every fix by an added failing-first test — 40 new ones, including
component tests that render each surface. The boundary test was verified
adversarially: two temporary files (a deep `@strkworld/shared/src/…` import and
a runtime `@strkworld/privacy` import) were added, each observed to fail the
relevant assertion, then deleted and the suite re-run green. Component tests use
`react-dom/server`'s `renderToStaticMarkup` with a pre-driven machine injected —
no jsdom, no testing-library, no new dependency — which works because
`useSyncExternalStore` is given a server snapshot. No wallet, no network and no
transaction was involved.

---

### 2026-08-16 — Four traps found building the shell against the fake seam

Shell lane, building the panel framework, the Bank and the batch accumulator
against `FakePrivacyOperations`. Four things the next agent in `apps/web`
would otherwise rediscover the expensive way.

**The canonical disclosures have no package entry point.** `packages/shared`
declares no `exports` map and `src/index.ts` does not re-export
`privacy-grades.ts`, so D-024's approved copy is only reachable as
`@strkworld/shared/src/privacy-grades.js`. That resolves today under both
`moduleResolution: bundler` and Vite's `.js`→`.ts` fallback, but it is
load-bearing and fragile: **adding an `exports` field to that package.json
breaks every disclosure import in the shell at once.** If anyone adds one, add
a `./privacy-grades` subpath in the same change.

**The register has no `bank.transfer` route.** The private transfer is graded
once, as `post-office.transfer`. The Bank's transfer control drives that same
pool-native route and therefore reads that entry — inventing a `bank.transfer`
id would have failed closed to a locked door, which is the gate working
correctly. If the Bank's transfer is ever meant to be a distinct route, it
needs its own register entry, and that is a frozen-seam change plus a decision.

**A fee that moved past the ceiling is not a distinct error kind.**
`PreparedBatch.confirm()` rejects with `PrivacyError('unknown')`, so a shell
that maps kinds to copy tells the player "that did not go through" for the one
failure with an obvious next step. The Bank now re-reads `poolConfig()`
immediately before confirming purely to produce a legible sentence, and still
passes `feeCeiling` — the seam remains the guard, the read is only for words.

**Two silent tooling traps in `apps/web`. Both fixed by the tooling PR (#4) —
recorded here for the reasoning, not as current behaviour.** Invariant check 4d
greped raw file text with no comment stripping (unlike check 5), so a *comment*
mentioning a forbidden protocol field failed the build; it is comment-aware now.
And `vitest.config.ts` included only `apps/**/*.test.ts` — a `.test.tsx` was
never collected, so a React component test would have passed CI by not existing;
`.tsx` is collected now. Panel logic still lives in plain `.ts` state machines,
but that is a testability choice rather than a workaround.

*Verified:* the two resolution claims by running `tsc --noEmit -p tsconfig.json`
and the full `vitest run` against the subpath import; the register claims by
reading `packages/shared/src/privacy-grades.ts` and asserting in
`apps/web/src/panels/routes.test.ts` that an id absent from the register locks
the door. The two tooling traps were confirmed by execution, not inspection: a
temporary file whose only mention of the forbidden field was inside a comment
made `./scripts/check-invariants.sh` fail, and a temporary `.test.tsx`
containing `expect(1).toBe(2)` left the suite at 211 passing because it was
never collected. Both temporary files were deleted. No wallet, no network and
no transaction was involved at any point.
---

### 2026-08-16 — Colyseus 0.17: five traps between the pinned set and a working room

The narrow pin set (`@colyseus/core@0.17.50` + `@colyseus/ws-transport@0.17.13`
+ `@colyseus/sdk@0.17.43`) is correct, but it is not sufficient on its own and
the gaps fail in unobvious ways.

**`ws-transport` cannot load without `express`, which it calls optional.** Its
`package.json` lists `express` under `peerDependenciesMeta` as
`optional: true`, but `build/WebSocketTransport.mjs` imports it at the top
level and only *uses* it inside `getExpressApp()`. Importing the transport
without express installed throws `Cannot find package 'express'` before any of
your code runs. `@colyseus/core` and `@colyseus/sdk` both load fine without it
— the trap is transport-only. `express@5.2.1` is therefore a direct dependency
of `packages/lobby` and nothing in that package uses it.

**`@colyseus/schema` is a required peer and is not re-exported.** Core declares
`@colyseus/schema: ^4.0.7` as a non-optional peer, and neither core nor the SDK
re-exports `Schema` or `schema()`. Any package that defines room state must
depend on it directly; pinned at `4.0.30`, which is what the lockfile already
resolved transitively.

**Schema 4 has a decorator-free definition API, and it is the one to use.**
`schema({ x: 'number' }, 'Name')` needs neither `experimentalDecorators` nor
standard decorators, neither of which this repository's tsconfig enables.
`Metadata.getFields(Klass)` reads the declared field set back at runtime, which
is what lets "the room schema is exactly `PresenceState`" be a test rather than
an aspiration.

**A room that validates in `onJoin` still returns a successful matchmake.** The
HTTP seat reservation (`POST /matchmake/joinOrCreate/<room>`) completes before
`onJoin` runs; refusal happens when the websocket consumes the reservation.
More importantly, when `onJoin` throws, `Room._onJoin`'s catch calls
`_onLeave(client)` and then deletes the reserved seat — so **your `onLeave`
runs for a client that was never admitted**, and it has to be safe for a
session your own registry has never heard of. There is no seat leak.

**Keying room state by Colyseus's `sessionId` puts a second identifier on the
wire.** The idiomatic `MapSchema` key is the server-generated 9-character
`sessionId`. Alongside a `gameId` field that is already the player's ephemeral
identity, that is one identifier more than the lobby needs. STRKWORLD keys the
map by `gameId` instead, and the room keeps `sessionId -> gameId` privately.

**`@colyseus/core@0.17.50` independently declares `node: ">= 22.x"`.** That is
a second package requiring Node 22, after the AVNU SDK, so D-025's floor is now
held up by two lanes rather than one. It also means CI's
`.github/workflows/ci.yml` `node-version: 20` is building against a package
that says it is unsupported. npm does not enforce `engines` without
`engine-strict`, so this passes today rather than failing — which is exactly
the failure mode D-025 warns about.

Interest management via `{ map: Entry, view: true }` plus per-client
`StateView.add/remove` works end to end: a removed reference disappears from
that client's decoded state, and deleting a map entry propagates to every view
without an explicit remove. Guard with `view.has(ref)` before add/remove rather
than calling them unconditionally each tick.

*Verified:* installed the pinned set, read the shipped `package.json` peer
metadata and the `WebSocketTransport.mjs` and `Room.mjs` build output, then ran
a real server and two real SDK clients over a websocket — asserting that a
distant peer is absent from the observer's state, reappears when it moves into
range, and disappears on suspend. 67 lobby tests, including 15 end-to-end ones.
No network beyond localhost.

---

### 2026-08-16 — The lobby invariant scan forbids its own test vocabulary

Check 5 of `scripts/check-invariants.sh` greps every `.ts` file under
`packages/lobby/src` — tests included — for `address`, `balance`, `building`,
`token`, `amount` and friends, after stripping `//` comments and `*`-prefixed
comment lines. A privacy test that scans room state for those words therefore
cannot spell them in TypeScript: it would fail the very gate it reinforces.

The list lives in `packages/lobby/src/testing/forbidden-vocabulary.json`
instead. JSON is not scanned, the scanner still sees no financial vocabulary in
lobby code, and the test still has real strings to search for. Do not "fix"
this by weakening check 5 or by concatenating the words from fragments in
TypeScript — the second reads exactly like evading the scan.

Two constraints on that list, both learned by hitting them. Nothing in it may
be a word spellable in hexadecimal alone: an ephemeral `gameId` is 16 hex
characters, so `fee` would match by chance roughly once in three hundred
sessions. And a "wei-scale integer" pattern must require at least 17 digits, or
a 16-character identifier that happens to be all digits matches it.

One usability defect in check 5 found while confirming this: it pipes every
lobby `.ts` file through one `sed`/`grep`, so the failure prints the offending
line *content* prefixed by a line number that is an offset into the
concatenated stream, with no filename. `910:` in a package with a few hundred
lines is not a location. The check is correct; locating the hit means grepping
for the printed text.

*Verified:* wrote a throwaway `.ts` file in `packages/lobby/src` containing two
of the words and ran `./scripts/check-invariants.sh` — check 5 fails and prints
`910:export const WORDS = [...]` with no filename; removed it and all thirteen
checks pass. Then ran the privacy suite, which searches both the room's JSON
serialisation and the actual encoder output bytes across a 4000-step
randomised sequence of hostile input.

---

### 2026-08-16 — Current pool calldata is proof-bound actions plus screening

The current `apply_actions` ABI is
`(Span<ServerAction>, Option<ScreeningAttestation>)`. Proof output is
`[class_hash, ...serialized_actions]`; Ready submits those actions followed by
the independently serialized screening option. Therefore the correct binding
check is exact equality with the calldata **prefix**, followed by strict parsing
of only these suffixes: compatibility-empty, `None = [1]`, or
`Some = [0, issued_at_u64, signature_r, signature_s]`.

The current `ServerAction` enum has twelve variants. In particular,
`EmitEncNoteCreated = 8`, `EmitNoteUsed = 9`, `Invoke = 10`, and
`InvokeWithComputation = 11`. The relay decoder must fail closed on unknown
variants and currently rejects public deposit/transfer-from/viewing-key actions
and computed invokes on the admitted private routes.

This **corrects** the older finding “Prepared proofs expose a route-enforceable
server-action list”: the proof still exposes a route-enforceable list, but it
does not bind the screening suffix and `Invoke` is not tag 9.

*Verified:* inspected the unpacked, SHA-pinned Ready 5.33.8 bundle, the
canonical `starknet-privacy` Cairo `ServerAction` and `apply_actions` sources,
and the current pool class ABI; then ran backend fixtures for tags 10/11,
screening `None`/`Some`, prefix mismatch, and public/computed-action rejection.
No proof was generated and no transaction was built or submitted.

---

### 2026-08-16 — Secret scanning has one exact public-contract false positive

Gitleaks 8.30.1's default `generic-api-key` rule flags
`DEFAULT_POOL.feeToken` in `packages/privacy/src/testing/fake.ts`. That value is
the canonical public Starknet STRK token contract, not a credential. Both the
current-tree and 32-commit scans pass after allowing only that exact public
value. Do not exclude the file or disable the generic rule: either would hide a
real credential added beside it.

*Verified:* ran redacted `gitleaks dir` and `gitleaks git` scans, inspected only
the flagged rule and location, matched the value to the repository's canonical
STRK address, then reran both scans with a process-local exact-value allowlist.
No other finding remained. No secret value was printed or committed.

---

### 2026-08-16 — 1Click authentication is a server-side fee decision

*Status: resolved by D-043; v1 uses the direct unauthenticated route and
discloses the documented 0.2% platform fee. The browser-JWT prohibition below
remains in force.*

The 1Click API can be called without authentication, but official current docs
say unauthenticated requests incur a 0.2% fee. JWT-authenticated requests are
fee-free, and the same docs require that credential to be stored securely.
The bridge SDK currently runs in the browser without a token; silently adding
a JWT there would expose it to every player.

Before launch choose one explicit route: retain the unauthenticated SDK flow
and disclose the signed quote's fee, or add a narrow server-side credential
proxy that preserves the backend privacy threat model. Never place a 1Click
JWT in `packages/bridge`, frontend configuration, a PWA asset or a committed
environment file.

*Verified:* read the official 1Click authentication and TypeScript SDK pages,
then inspected the installed
`@defuse-protocol/one-click-sdk-typescript@0.1.25` exports and STRKWORLD's
`OneClickSdkClient` on 2026-08-16. No credential was created or used.

---

### 2026-08-16 — The Bridge loader now covers every current non-Starknet registry family

The current 1Click token response contains 35 blockchain labels. STRKWORLD's
loader now maps all 34 non-Starknet families and deliberately excludes the
same-chain Starknet destination from the inbound Bridge picker. The map covers
EVM, Solana-compatible, Move, UTXO and account-chain families; their local
validators are shape checks only, and the signed 1Click quote remains
authoritative.

Treat this as live provider metadata, not a permanent compatibility claim. An
unknown future label is skipped rather than guessed, and freshness checks must
run when the pinned SDK or registry changes.

*Verified:* called `OneClickService.getTokens()` read-only on 2026-08-16 (186
tokens, 35 labels), compared every returned label with `CHAIN_MAP`, and ran the
17-test bridge suite including representative family validation. No quote was
issued, no deposit address was created and no funds moved.

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

**Corrected by “Current pool calldata is proof-bound actions plus screening”
above:** the proof-bound action list is an exact calldata prefix, not the whole
call; the remaining suffix is the separately encoded screening option, and the
current `Invoke` enum tag is 10.

The Wallet API artifact is not an opaque blob. The submitted pool call's
calldata is Cairo serialization of `Span<ServerAction>`, and the proof output is
`[class_hash, ...serialized_actions]`. The backend can therefore verify that
`proof.output.slice(1)` equals the submitted calldata prefix and decode enough
of the stable ABI to enforce route policy before relaying.

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

**The fix, now implemented and guarded.** A ref-counted host with deferred
teardown in `packages/world/src/host.ts`, with the Phaser wiring in
`runtime.ts` and a ~15-line React component that only acquires and releases.
React never owns the game lifecycle.

The ref-counting logic is deliberately Phaser-free so the part that actually
breaks is unit-tested in CI without a browser: `host.test.ts` has 9 tests
covering the StrictMode acquire→release→acquire sequence, interleaved teardown
and acquire, unbalanced releases, and rapid same-tick churn. One test
demonstrates the naive implementation producing two instances, so the reason
this module exists survives someone deciding it looks over-engineered.

*Verified:* 9 passing tests asserting exactly one instance across a StrictMode
double-mount, plus zero teardowns when a remount cancels a queued one. The
browser-level assertion (one canvas, one `create()`) still wants a manual check
once a scene exists.

Never pass `destroy(true, true)` — `noReturn` tears down the global plugin
cache and no further Game can be created on the page.

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

### 2026-08-16 — Phaser 4 API differences that break a v3-shaped scene

Three found while writing the first scene. All compile-time, none obvious from
v3 experience:

- **`RenderTexture.drawFrame()` is gone.** In v4 `RenderTexture extends Image`
  with a different `draw(entries, x, y, alpha, tint)` signature. Drawing a tile
  grid tile-by-tile into a render texture is a v3 pattern that no longer
  type-checks. Use a real tilemap layer instead — which is better anyway, since
  the Tiled import then swaps only the data source.
- **`Scene` declares `update()` but not `preload()`/`create()`.** With
  `noImplicitOverride` on, marking `update` as `override` is required and
  marking the other two is an error. They are optional hooks the SceneManager
  calls if present, not base members.
- **`createLayer()` returns `TilemapLayer | TilemapGPULayer`.** The GPU layer
  is new in v4. A field typed as plain `TilemapLayer` will not accept it.

*Verified:* compiled against `phaser@4.2.1` types; each error reproduced and
fixed. Read `node_modules/phaser/types/phaser.d.ts` rather than v3-era guides.

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

### 2026-08-16 — Consistency audit: docs had drifted from the decision log; fixed

An orchestration-level audit (five parallel readers, each defect then
adversarially re-verified against file:line before being accepted) found the
top-level docs lagging the decision log. All fixes are doc/tooling-level — no
decision changed:

- `ARCHITECTURE.md` omitted `packages/bridge` entirely (topology and
  Boundaries), and `SPEC.md`'s v1 summary, build plan and §7 dropped the
  Bridge its own §4 table marks Active (D-009/D-012). Both now carry it.
- Neither `SPEC.md` nor `ARCHITECTURE.md` mentioned the D-020
  grade/approval/disclosure gate or D-021 `returnToPool`. Both now do.
- `SPEC.md` §7 still said "external tilesets" (contradicting D-008), one §8
  bullet still called the event bus "the bridge" (D-010), and the Verdict/§6
  hardcoded a one-prompt-per-batch outcome that §8 lists as a Phase 0 unknown.
- `docs/BRIEF-chain-lanes.md` stated "a shield is two wallet prompts" as fact,
  reintroducing the claim the finding below (same date) retired. Reworded;
  the two vendored-skill occurrences are now named in §5 above.
- `packages/privacy/README.md` documented the pre-D-015 single-shot interface,
  a `WalletApiPrivacyOperations` that does not exist yet, and the superseded
  `starknet@10.7.0` pin. Rewritten against `src/operations.ts`.
  `docs/research/primary-source-verification.md`'s pin section now carries a
  supersession banner pointing at the set-pin finding.
- `skills-lock.json` content hashes matched neither the vendored files nor
  upstream at the pinned commit — wrong from the first commit, and nothing
  verified them. Recomputed (sha256 of each vendored `SKILL.md`), and
  check 4e now verifies them instead of only checking file existence.
- Check 8's register parser only recognised entries whose closing brace sat at
  exactly two-space indent — ordinary reformatting silently hid entries from a
  safety gate (fail-open). Replaced with a brace-depth parser that fails
  closed when it cannot parse the register.

*Verified:* every defect confirmed by an independent adversarial verifier
against exact file:line before fixing; `./scripts/check-invariants.sh` re-run
after the changes — the only remaining failure is the four approved deviations
awaiting the project lead's disclosure copy, which is the known, deliberate
state.

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
