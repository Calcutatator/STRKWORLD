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

### Merged work is live on the current local build

The project lead owns the shared local runtime. After merging a runtime change,
fast-forward the canonical checkout to `origin/main`, restart the affected dev
server(s) from that checkout (do not rely on HMR surviving the fast-forward),
keep the web app and any required local services (including the lobby) running,
and verify the served module/current behavior before making the build available
at `http://localhost:5173/`. When the user has explicitly authorized browser
automation, reload that browser against the current build; otherwise give the
user the immediate reload/test handoff. A merged PR is not complete while the
shared checkout or dev server still points at an older branch or build. Do not
make the user discover or repair that drift.

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

### 2026-08-30 — Wallet discovery display snapshots must bypass hostile reads

`WalletSession` validated discovered wallet `name` and `icon` descriptors but
then read those fields through ordinary property access while building its
public selection snapshot. A descriptor-valid proxy could therefore throw from
its `get` trap during session construction, leaking an arbitrary exception
before the wallet-selection surface existed.

Selection snapshots now reuse the validated own data descriptors inside a
guarded projection. Malformed or newly hostile display objects are omitted
without escaping through session construction or discovery publication; valid
wallet identity objects remain unchanged for explicit connection. No wallet
identity matching or financial operation behavior changes.

*Verified:* a red-first public `createWalletSession()` regression supplied a
descriptor-valid wallet proxy whose display `get` trap throws. The old path
leaked that exception while constructing the initial snapshot; the corrected
path publishes the expected frozen wallet choice without invoking the trap.
Removing the descriptor projection restores the failure. Privacy tests pass 10
files / 530 tests and package typecheck passes. No browser, wallet, provider,
RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Web World-event consumers own and validate payloads

The Web visit, panel and presence consumers previously narrowed World event
payloads with an object check and then read typed fields normally. Runtime
payloads can still be null, accessor-backed, proxy-hostile or contain unknown
building/reason/facing values and non-finite coordinates. Those shapes could
throw inside bus delivery, open a panel for a nonexistent building, or start
lobby presence with an invalid placement.

The Web boundary now reads only own data descriptors, contains descriptor
traps, validates known building/lock/facing values, requires matching station
prefixes and finite coordinates, and publishes an owned frozen snapshot to
the existing consumers. Invalid events are ignored without changing the
current visit, panel or presence authority. Valid event ordering and station
registry fail-closed behavior are unchanged.

*Verified:* public regressions were red before the decoder: malformed movement
started a lobby join and accessor-backed visit/panel payloads were not owned at
their consumption boundary. The corrected focused run passes 4 files / 116
tests and Web typecheck. The full workspace gates are recorded in the owning
commit. Deterministic in-memory buses only: no browser, lobby service, wallet,
provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Avatar Studio highlight publication must remain retryable

`createAvatarStudioController.update()` assigned `highlightedFigure` before
publishing the synchronous `onChange` snapshot. If that external publication
threw, the controller retained a highlight the renderer had not accepted; the
same tile then skipped publication on retry because the sentinel already
matched.

Highlight updates now use their own committed revision. A failed publication
rolls back its candidate when no newer successful nested update owns it, while
reentrant newer state remains authoritative. Successful highlighting and
selection behavior are unchanged.

*Verified:* a red-first public World regression makes highlight delivery throw
on a figure tile; the old controller retained the unrendered figure and could
not retry its highlight, while the corrected controller restores `null` and
successfully republishes and selects the same tile. Focused Avatar Studio tests
pass 47 tests and the World suite passes 25 files / 404 tests. No browser,
lobby server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Fixed-room control ownership must follow the input handoff

The `world:control-owner` Shell callback committed `controlOwner = 'shell'`
before calling `input.suspend()`. If that external handoff threw before the
input gate had disabled delivery, the controller reported Shell ownership even
though World input remained active; a retry or later cleanup could then act on
divergent ownership. The inverse `world` handoff had the same stale-state
shape when input restoration failed.

The callback now restores the prior owner when the requested input state was
not established, while retaining the new owner when the concrete input gate
reports a partial suspended state that owns retryable cleanup. Reentrant newer
owner callbacks remain authoritative, and successful commands publish exactly
as before.

*Verified:* a public fixed-room regression first made `input.suspend()` throw
without changing input state; the old callback left `controlOwner` as `shell`,
while the corrected callback preserves `world` and rethrows the original error.
The World package suite, typecheck, invariants, and diff hygiene pass. No
browser, wallet, provider, RPC, proof, signature, funds, or transaction was
used.

### 2026-08-30 — Fixed-room station render projection must validate matching fields

`fixedRoomStationPresentations()` accepted a matching runtime station snapshot
by station id and copied its `label` and `status` directly into the public
render model. A malformed snapshot such as `{station: known, label: 42,
status: 'forged'}` therefore crossed the World boundary and could reach Phaser
despite the presentation contract requiring a nonblank string label and one of
`available`/`locked`.

The projection now reads station, label, and status through the existing
own-data-field boundary helper, accepts only a nonblank string label and the
two allowed statuses, and falls back to the authored label plus locked status
otherwise. Unknown, duplicate, null, accessor-backed, and malformed station
records remain fail-closed; valid custom labels/statuses are unchanged.

*Verified:* a public fixed-room regression first exposed the invalid matching
fields on the pre-fix head, then passed with the validation. Reverting the
projection validation reproduces the failure. Focused fixed-room tests, the
World package suite/typecheck, invariants, and diff hygiene pass. No browser,
wallet, provider, RPC, proof, signature, funds, or transaction was used.

### 2026-08-30 — Backend cancellation accepts genuine cross-realm signals

The browser backend client previously validated optional operation signals
with `instanceof AbortSignal`. A genuine signal created by another browser
realm therefore failed before transport, even though Fetch and cancellation
use only the standard AbortSignal surface.

The boundary now retains the native same-realm fast path and otherwise accepts
only a descriptor-owned structural signal with boolean `aborted`, a present
`reason`, and callable `addEventListener` / `removeEventListener`. Accessors,
missing members and wrong scalar types fail closed without invocation. Relay
estimate, private submission and swap preparation share the validator.

*Verified:* three public backend-client regressions were red before the fix
and prove cross-realm-like signals reach transport for all three operations.
Malformed and accessor-backed lookalikes are rejected before transport, with
the accessor never invoked. The focused client suite passes 102 tests and the
privacy package typecheck and diff hygiene pass. No browser, wallet, provider,
RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Bank compatibility maps must retain runtime immutability

`createBankRoom()` spread the already-frozen `FixedRoomMap` into a new
compatibility object, then returned that outer object mutable. A consumer could
therefore overwrite the public `name`, `building`, dimensions or station
references despite the readonly map contract, leaving the Bank facade's
metadata inconsistent with its fixed collision and station data.

The compatibility facade now freezes its returned outer map as well as the
deeply-owned data supplied by `createFixedRoom()`. Existing Bank geometry,
station helpers and controller behavior are unchanged.

*Verified:* a red-first public Bank regression observed that the returned map
was mutable and allowed `name` replacement; the corrected map is frozen and
rejects that mutation while retaining `bank`. Focused Bank tests and World
typecheck pass. No browser, lobby server, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Remote avatar idle timers must commit with the new pose

`createRemoteAvatarLayer.updateAvatar()` cancelled an existing movement-idle
timer before presenting the replacement pose and scheduling its timer. If the
replacement presentation failed, reconciliation correctly retained the last
rendered peer snapshot, but the prior timer had already been removed. With no
later lobby update, the avatar could remain in its old walking animation
indefinitely instead of returning to idle.

The update now keeps the prior timer until the replacement presentation and
new timer have succeeded, then retires the old timer and publishes the new
one together. A failed replacement leaves the prior timer owned; a failed new
timer is cleaned up without publishing it. Existing position rollback,
last-successful-snapshot retention, ordinary movement and teardown behavior
are unchanged.

*Verified:* a red-first public World regression starts a remote movement,
fails the next pose presentation, and fires the prior idle timer. The old path
had removed that timer and made no idle presentation; the corrected path keeps
the timer and returns the sprite to idle. Focused remote-avatar tests pass 25
tests. No browser, lobby server, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Fixed-room Shell command fields must be accessor-safe

The fixed-room controller used ordinary property access for the `building`
and `owner` fields of Shell commands. A malformed cross-package payload with
an accessor-backed field could therefore throw from the synchronous World
listener before the building check ran, interrupting the scene's event bus.
The existing null guard did not cover this case because optional chaining still
invokes an accessor.

Shell command handlers now read their discriminator and owner fields through
the own-data-field boundary, which ignores accessors and contains descriptor
failures. Station payload reads use the same safe path; valid command ordering,
known-owner validation and null-payload behavior are unchanged.

*Verified:* a red-first public fixed-room regression supplied a matching
`world:control-owner` payload whose `building` getter threw; the old handler
leaked that exact error, while the corrected handler ignored the command
without invoking the getter or changing World ownership. Focused fixed-room
tests pass 73 tests and World typecheck passes. No browser, lobby server,
wallet, provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Avatar Studio exit presentation must roll back partial handoffs

`createAvatarStudioPresentation.exit()` advanced the Phaser-facing port through
the street handoff without compensation. If a setter threw after an earlier
setter had already enabled the body or revealed street objects, the controller
could restore logical Studio ownership while the visible World remained
partially transitioned. Retrying then started from a mixed presentation.

The exit path now restores the known Studio contract after a failure while the
same transition still owns the presentation: disabled body, hidden street
objects, visible Studio, Studio bounds/camera bounds and Studio spawn. Each
restore operation is attempted, while reentrant newer transitions retain
authority and the original exit error remains primary. Successful exit and
existing entry rollback semantics are unchanged.

*Verified:* a red-first public World regression makes the exit body/ground/door
setters mutate state before a door setter throws; the old path left the street
partially visible, while the corrected path restores the exact Studio state and
the next exit retry completes. Focused Avatar Studio tests pass 46 tests. No
browser, lobby server, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Avatar Studio figure visibility sync must be transactional

`createAvatarStudioFigureLayer.sync()` applied visibility to eight figure
sprites and then the selection highlight one Phaser call at a time. If a
setter failed midway, earlier objects kept the new visibility while later
objects and the highlight kept the old state. A failed render therefore left
the Studio with a mixed presentation and no retained operation to retry it.

The sync now snapshots every owned visibility and the highlight position,
then compensates all changes when any setter fails. The original error remains
authoritative; rollback failures are combined in an `AggregateError` so no
cleanup failure is hidden. Successful visibility/highlight updates and
destroy ownership are unchanged.

*Verified:* a red-first public World regression makes the fourth figure's
visibility setter throw after the first three have changed; the old layer
left the first three visible and the remaining figures hidden, while the
corrected layer restores the prior all-visible state and preserves the exact
error. Focused Avatar Studio figure tests pass 10 tests. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Remote peer snapshot containers must fail closed

`reconcileRemotePeers()` iterated its public snapshot argument directly. The
TypeScript seam requires an array, but a malformed runtime producer can still
publish `null`, `undefined`, or another non-array value through the retained
World source; the old path then threw `TypeError: snapshot is not iterable`
before the renderer could recover. The same issue affected an invalid initial
snapshot supplied to `createRemotePeerSource()`.

The reconciliation boundary now treats any non-array container as an
authoritative empty snapshot, while preserving the existing per-entry
validation and duplicate-id policy. Initial and published malformed
containers therefore replay a safe empty array and cannot take down the World
render path.

*Verified:* red-first public World regressions published `null` and constructed
the retained source with `null`; the old implementation threw before replay,
while the corrected implementation delivered `[]`. Reconciliation regressions
cover `null`, `undefined`, object and string containers. Focused remote-peer
tests pass 24 tests. No browser, lobby server, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — World releases must retire a still-loading acquire

`acquireWorld()` waits for Phaser's lazy module import before handing the
request to the ref-counted host. A React owner can unmount in that window and
call `releaseWorld()`, but the old release saw no host and became a no-op. The
late acquire then created a live Game with an unclaimed reference, leaving the
World running after its only owner had gone away.

The runtime now tracks pending acquire requests and marks the matching pending
request cancelled when released. Once lazy loading completes, the request
still resolves its Game but immediately releases that lease, allowing the
normal deferred host teardown to retire it. Failed lazy imports remove their
pending request, while concurrent acquires and ordinary retained/remounted
ownership are unchanged.

*Verified:* a red-first runtime regression starts an acquire, releases before
the lazy Phaser import settles, and observes the late lease. The old runtime
left `refCount: 1` after release; the corrected runtime reaches
`refCount: 0` and destroys the Game on the deferred teardown. The mutation
that removes pending-release tracking reproduces the leak. Focused runtime
concurrency tests pass 2 tests. No browser, lobby server, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Remote avatar position must roll back after failed presentation

`createRemoteAvatarLayer.updateAvatar()` moved an existing Phaser sprite before
visual presentation and movement-idle timer setup completed. If either later
operation threw, reconciliation correctly retained the last rendered peer
snapshot, but the sprite had already moved to the uncommitted coordinates.
That left the public retained map and visible remote avatar disagreeing until
another source publication happened, and could make the next movement update
start from the wrong spatial state.

The update now captures the last rendered coordinates and compensates a
partially applied position when presentation or timer setup fails. A failed
position setter that did not mutate still preserves the original error, while
a rollback failure is reported together with it. Successful updates, idle
timers, retryable visual failures and teardown ownership are unchanged.

*Verified:* a red-first public World regression makes an existing sprite move
to a new position, then throws from its visual setter; the old layer retained
the old peer snapshot while leaving the sprite at the new coordinates, while
the corrected layer restores the old coordinates and preserves the exact
presentation error. Focused remote-avatar tests pass 24 tests. No browser,
lobby server, wallet, provider, RPC, proof, signature, funds or transaction
was used.

### 2026-08-30 — Failed local avatar poses must not advance facing state

`createLocalAvatarVisual.update()` advanced its private movement-facing
accumulator before asking the visual controller to present the pose. If a
Phaser setter threw during that presentation, the controller correctly kept
the last successful logical pose, but the local adapter retained the failed
facing. A later no-input retry therefore rendered the failed turn even though
the original update never committed.

The adapter now commits its facing accumulator only after the visual
presentation succeeds. Failed pose delivery leaves both the visual controller
and movement-facing state on the last successful pose; successful movement,
idle facing retention and sprite selection are unchanged.

*Verified:* a red-first public World regression makes the first right-facing
pose setter throw, then retries with no input. The old adapter rendered
`right` on the retry; the corrected adapter remains `down`. Focused avatar
visual tests pass 14 tests. No browser, lobby server, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Concurrent first World acquires must share lazy Phaser loading

`runtime.ensureHost()` awaited the dynamic Phaser import before assigning the
singleton `host`. Concurrent first `acquireWorld()` calls could therefore both
observe an empty host and each construct a separate ref-count host and Phaser
Game, while the module-level `host` retained only the later one. The first
game then had no reachable release owner and StrictMode/concurrent composition
could create duplicate canvases and World lifecycles.

The runtime now retains one in-flight host-construction promise and all
concurrent callers await it before acquiring the shared host. The promise is
cleared after success or import failure so a failed lazy load remains
retryable. Existing same-owner remount, retarget and deferred teardown
semantics are unchanged.

*Verified:* a red-first public runtime regression starts two `acquireWorld()`
calls before lazy Phaser resolves; the old path initiates two independent
dynamic imports and fails before the one-game assertion, while the corrected
path coalesces both calls to one Game and returns the same instance. The
focused runtime suites pass 6 tests; the World suite and full workspace gates
are recorded on this candidate. No browser, lobby server, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Failed nested avatar selection can leave the outer candidate committed

`createAvatarOutfitSelection.select()` used the selection revision to avoid
rolling back an outer failed event when a nested selection had taken over.
That check treated every newer revision as a successful owner, however. A
nested selection whose event delivery throws restores the outer candidate but
still increments the revision; if the outer event then fails, the logical
selection remains on an avatar whose delivery never completed.

Selection now tracks the newest revision whose event delivery completed. A
failed selection rolls back whenever its candidate is still selected and no
newer successful selection owns it, including when a failed nested attempt
restored that candidate. A genuinely successful nested selection remains
authoritative, and the existing forged-key and ordinary delivery contracts
are unchanged.

*Verified:* a red-first public regression makes an outer `avatar-2` delivery
synchronously attempt `avatar-3`, then fail the nested delivery. The old
selection remained `avatar-2` after the thrown error; the corrected selection
returns to `avatar-1`. Companion regressions preserve a successful nested
selection, including one that returns to the outer candidate. Focused outfit
tests pass 14 tests. No browser, lobby server, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Failed host remount cancellation must undo speculative retargeting

`createHost.acquire()` retargeted a retained World instance before cancelling
its deferred teardown. If cancellation then threw, the acquire failed but the
instance and `activeParent` had already been rebound to the new owner; the
queued teardown still belonged to the old owner and could later destroy an
instance that never acquired the host in its new location.

The host now compensates a speculative retarget when deferred cancellation
fails, restoring the previous parent before preserving the cancellation error.
If compensation itself fails, both errors are surfaced as an `AggregateError`;
the pending teardown remains authoritative and can still retire the instance.
Successful remounts, retarget failures and ordinary deferred teardown are
unchanged.

*Verified:* a red-first public host regression makes retarget mutate the
instance, then makes cancellation throw. The old path left the instance bound
to `new-owner`; the corrected path calls the inverse retarget, restores
`old-owner`, leaves the lease unclaimed, and later performs the queued stop.
Focused Host tests pass 24 tests. No browser, lobby, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Input suspension can lose ownership after a partial handoff

`createInputGate.suspend()` disabled Phaser keyboard delivery and global
capture before clearing held keys, but if `resetKeys()` (or a later keyboard
assignment) threw, the gate left `suspended` false. A caller could therefore
continue with a logically active gate while delivery was disabled; its later
`resume()` returned immediately and could never restore the keyboard.

The suspend transition now retains suspended ownership once either disabling
step has completed, even when a later step fails. Cleanup can then retry the
normal `resume()` handoff; failures before any disabling step preserve the
existing retry behavior. Successful ordering and idempotence are unchanged.

*Verified:* a red-first public World regression makes `resetKeys()` throw after
capture and delivery are disabled. The old path reports `suspended === false`
and leaves recovery as a no-op; the corrected path retains suspended ownership,
then resumes successfully. Focused input-gate tests pass 16 tests; the World
suite passes 24 files / 381 tests; the full workspace passes 111 files / 2,410
tests. Typechecks, production build, invariants and diff hygiene pass. No
browser, lobby server, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Nested street movement can run a stale post-move callback

`createStreetMovementAdapter.streetUpdate()` published the movement and then
always invoked its `afterMovement` callback. A synchronous `player:moved`
consumer could start a newer street update first; when that nested update
returned, the older callback still ran and could report a stale door tile or
other movement handoff after the newer transition had won.

Street and exit callbacks now capture an adapter transition revision and run
only while their own publication remains current. The reporter's facing
rollback remains independent, and successful movement publication plus the
existing callback ordering are unchanged.

*Verified:* a red-first public World regression starts a left-moving update
from the first right-moving publication. The old path invoked both `new` and
`stale` callbacks; the corrected path invokes only `new` and retains left
facing. Focused street-movement tests pass 21 tests. No browser, lobby server,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Input resumption fails closed when recapture throws

`createInputGate.resume()` enabled Phaser keyboard delivery before asking the
keyboard adapter to re-enable global capture. If that second operation threw,
the gate remained logically suspended while `keyboard.enabled` stayed `true`,
so a panel whose exit handoff failed could still receive gameplay movement
input.

Resume now compensates a failed recapture by disabling keyboard delivery and
reasserting disabled global capture before preserving the original error. The
gate remains suspended and retryable; successful resume ordering and ordinary
cleanup are unchanged.

*Verified:* a red-first public input-gate regression makes
`enableGlobalCapture()` throw after delivery is re-enabled. The old path left
`keyboard.enabled` true; the corrected path leaves it false, retries safely,
and preserves the exact capture error. Focused input-gate tests pass 15 tests.
No browser, lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Failed street movement publication can commit stale facing

`createStreetMovementReporter.update()` changed its authoritative facing before
publishing `player:moved`. If a synchronous shell listener threw, the failed
movement still left the new facing committed even though the publication did
not complete. A retry therefore started from state that belonged to an
uncommitted turn; a nested newer update could also be incorrectly overwritten
by a stale rollback.

Movement publication now owns a facing revision and restores the previous
facing only when the failed turn still owns it. A nested successful update
remains authoritative, while the existing frozen payload and facing priority
are unchanged.

*Verified:* a red-first public World regression makes the movement listener
throw on a right-facing update; the old path retained `right`, while the
corrected path restores `down` and accepts the retry after recovery. Focused
street-movement tests pass 20 tests. No browser, lobby server, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room entry failure can leave a partial presentation live

`createFixedRoomController.enter()` released logical room ownership when its
`onEnter()` callback threw, but did not compensate the callback. The Scene's
entry callback performs the presentation handoff before rendering the room;
if that later render step throws, the controller could report the street while
the Phaser presentation still showed the room.

Entry failure now attempts the matching `onExit()` compensation while the
controller still owns the room, preserving the original entry error if
compensation also fails. A controller already destroyed or synchronously
replaced by the failing callback remains authoritative and is not compensated
again.

*Verified:* a red-first public fixed-room regression completed the room
presentation, then threw from `onEnter`; the old path left room visibility on,
while the corrected path calls the paired exit and restores street visibility.
The focused fixed-room suite passes 72 tests. No browser, lobby server,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room exit compensation must restore partial presentation

`createFixedRoomController.leave()` restored logical room ownership when its
`onExit()` presentation callback threw, but did not invoke `onEnter()` to
restore a presentation that had already applied only part of the outside
handoff. The controller could therefore report `inRoom` while the renderer
remained outside and partially transitioned.

After restoring logical ownership, the exit failure path now attempts
`onEnter()` compensation. The original exit error remains authoritative if
compensation also fails, and a destroyed or synchronously re-entered controller
is not compensated a second time.

*Verified:* a public World regression makes the real fixed-room presentation
throw after applying partial exit state. On the old path the final presentation
operation remained `position:false` while the controller was inside; the
corrected path restores `position:true` and preserves the original error.
Focused fixed-room tests pass 71 tests. No browser, lobby server, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room entry rollback can overwrite a reentrant retry

`createFixedRoomPresentation` used a transition revision for its forward
handoff, but its failed-entry rollback restored street presentation without
checking that the entry still owned the transition. If a rollback port
callback synchronously started a newer room entry, the old rollback continued
and overwrote the retry's room position and presentation.

The rollback now rechecks the owning transition before each restoration action,
so a newer room transition retires stale cleanup. The original entry failure
remains authoritative and ordinary rollback still attempts every action while
its transition owns the presentation.

*Verified:* a public World regression starts a retry from the first rollback
port callback. On the old path the stale rollback ended at `position:false`
after the retry's `position:true`; the corrected path preserves the retry.
Focused fixed-room tests pass 69 tests. No browser, lobby server, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room exit announcement failure remains retryable

`createFixedRoomController.leave()` completed the outside presentation and
then emitted `building:exited` without treating the semantic announcement as
an external lifecycle boundary. If a synchronous consumer threw, the error
escaped after the controller had become outside, so a later exit call was a
no-op and the same handoff could not be retried coherently.

Exit announcement failure now restores the prior room ownership and
highlight/approach state, then compensates the presentation with `onEnter`
before preserving and rethrowing the original error. A destroyed or otherwise
replaced lifecycle remains authoritative, and a compensation failure never
masks the announcement error. Normal exit ordering and successful announcement
behavior are unchanged.

*Verified:* a red-first public fixed-room regression makes the first
`building:exited` consumer throw, observes the controller outside on the old
path, then retries after recovery. The corrected path calls `onEnter` to
restore the room, and the second exit completes successfully. Focused
fixed-room and World tests, typechecks, build, invariants and diff hygiene
pass. No browser, lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Avatar Studio destroy retry must retain retirement ownership

`createAvatarStudioPresentation.destroy()` left `destroyed` false when
`destroyStudio()` threw so a later teardown could retry. That also allowed a
new `enter()` or `exit()` handoff to run against partially destroyed
presentation objects before the retry, violating teardown ownership.

Destroy now retires the presentation before invoking cleanup and tracks a
pending cleanup failure separately. Enter/exit remain blocked while cleanup
is pending; a subsequent destroy retries exactly once for that attempt and
successful cleanup remains idempotent.

*Verified:* a public World regression makes the first `destroyStudio()` throw,
then attempts `enter()` before retrying destroy. On the old path the transition
started; the corrected path performs no transition, preserves the original
cleanup error, and permits the explicit retry. Focused Avatar Studio tests pass
45 tests. No browser, lobby server, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Fixed-room presentation transitions own one generation

Fixed-room entry and exit previously performed their Phaser presentation
handoffs directly in `StreetScene`. A synchronous nested opposite transition
could complete and then be overwritten by the stale outer continuation, while
a later setter failure could leave the player body, street visibility, bounds
or position only partly switched.

The handoff now runs through one World-owned presentation transaction. Each
enter or exit owns a generation and stops after a newer transition wins. A
failed current entry attempts every street-restoration action before preserving
the original error, so the controller can retry the same room transition.
Existing setter order, door reset, presence resume and controller authority are
unchanged.

*Verified:* public Phaser-free regressions were red before the transaction:
one nested exit allowed the stale enter to set the room position afterwards,
and one bounds failure left the partial entry unrestored. Both pass after the
fix. Focused fixed-room and StreetScene lifecycle verification passes 2 files /
96 tests; all World tests pass 24 files / 371 tests. Workspace typechecks,
production build, 13 invariants and diff hygiene pass. The full workspace run
was attempted but this isolated worktree's symlinked dependency root caused six
Vite asset-ID denials; its one executed unrelated presence assertion also fails
on exact base `2f78d8d`. No browser, wallet, network, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Avatar Studio entry rollback can overwrite a reentrant retry

`createAvatarStudioPresentation.enter()` used a transition revision for its
forward handoff, but its failure rollback only stopped when the presentation
was destroyed. If a rollback port callback synchronously started a newer
`enter()` retry, the old rollback continued applying street visibility,
bounds, and position after that retry had become authoritative.

Entry rollback now uses the owning transition predicate after every rollback
port call, so a newer transition or destruction stops the stale cleanup. The
original entry error remains authoritative and ordinary failed-entry rollback
still attempts every action while its transition owns the presentation.

*Verified:* a public World regression starts a retry from the first rollback
port callback. On the old path the stale rollback overwrote the retry's Studio
bounds and position; the corrected path preserves the retry's Studio state.
Focused Avatar Studio tests pass 44 tests. No browser, lobby server, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room station activation rechecks after input suspension

`createFixedRoomController.update()` treated `input.suspend()` as a
non-reentrant call and emitted `station:activated` immediately afterward. A
synchronous input adapter can destroy or leave the controller, let Shell take
control, or trigger a newer update during suspension. The stale continuation
then activated a station after World had lost the room or its authority.

The station handoff now rechecks controller liveness, room membership, World
control and the update revision after suspension. A still-live room rearms the
approach when that check retires the turn; destruction and leave transitions
retain ownership of their own reset. Normal suspension, activation and
delivery-failure retry behavior remain unchanged.

*Verified:* a red-first public fixed-room regression made `input.suspend()`
destroy the controller. Before the guard, the stale update emitted
`station:activated`; after it, no activation is delivered and the controller
remains outside. Removing the post-suspension guard reproduces the failure.
Focused fixed-room and World tests, typechecks, build, invariants and diff
hygiene pass. No browser, lobby, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Avatar Studio presentation transitions can overwrite reentrant ownership

`createAvatarStudioPresentation.enter()` and `exit()` only checked whether the
presentation was destroyed between port calls. A synchronous port callback
could therefore start the opposite transition while a handoff was in flight;
the older transition then resumed and overwrote the newer street/Studio
bounds, visibility, or player position.

Presentation enter/exit now own a transition revision and recheck it after
each synchronous port call. A newer transition or destruction retires the old
continuation; failed entry restoration is attempted only while that entry
still owns the transition. Normal handoff ordering and retry behavior remain
unchanged.

*Verified:* a public World regression starts `exit()` from the Studio-visible
port callback during `enter()`. On the old path the stale enter reapplied
Studio bounds and position after the exit; the corrected path leaves the
street bounds and return position authoritative. Focused Avatar Studio tests
pass 43 tests. No browser, lobby server, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Failed station delivery must remain retryable

`createFixedRoomController.update()` removed a station from
`approachArmed` before suspending input and delivering `station:activated`.
When a synchronous station consumer threw, input was restored and the error
was reported, but the approach remained disarmed. The player could stay on
the same approach tile and receive no second activation until leaving and
re-entering it, turning a transient presentation/consumer failure into a
stuck station interaction.

Failed station delivery now rearms that station after the input-restoration
attempt, including the aggregate delivery-plus-restoration failure path. The
reset is skipped only when the controller has already been destroyed or left;
those lifecycle transitions own their own reset. Successful activation,
input-suspension failure, Shell control claims and normal leave behavior are
unchanged.

*Verified:* a red-first public fixed-room regression made the first
`station:activated` consumer throw, then retried the same approach tile. On
the old path only one delivery occurred; the corrected path delivers the
second attempt and restores input after both attempts. Removing either
rearm path reproduces the relevant failure. Focused fixed-room and World
checks, typechecks, build, invariants and diff hygiene pass. No browser,
lobby, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Avatar Studio exit can announce stale ownership after reentrant state publication

`createAvatarStudioController.leave()` published the outside snapshot and then
unconditionally emitted `avatar-studio:exited`. An `onChange` consumer can
synchronously re-enter the Studio while that snapshot is delivered. The
outer leave then announces an exit after newer Studio ownership has already
won.

The exit path now rechecks `destroyed` and `inRoom` after synchronous outside
state publication, suppressing the stale semantic event. Normal exit
publication and announcement ordering are unchanged when the controller
remains outside.

*Verified:* a public World regression re-enters the Studio from the outside
snapshot callback. On the old path `avatar-studio:exited` was emitted after
re-entry; the corrected path emits no stale exit and remains inside. Focused
Avatar Studio tests pass 42 tests. No browser, lobby server, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio entry can announce stale ownership after reentrant state publication

`createAvatarStudioController.enter()` published the inside snapshot and then
unconditionally emitted `avatar-studio:entered`. An `onChange` consumer can
synchronously destroy the controller while that snapshot is delivered. The
controller is already retired, but the outer enter still announces a live
Studio to the shell.

The entry path now rechecks `destroyed` and `inRoom` after synchronous state
publication and suppresses the stale announcement when the newer lifecycle
state has won. Normal entry publication and announcement ordering are
unchanged when the controller remains inside.

*Verified:* a public World regression destroys the controller from the entry
`onChange` callback. On the old path `avatar-studio:entered` was emitted after
destruction; the corrected path emits no event and remains outside. Focused
Avatar Studio tests pass 41 tests. No browser, lobby server, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room exit can announce stale ownership after reentrant state publication

`createFixedRoomController.leave()` published the outside snapshot and then
unconditionally emitted `building:exited`. An `onChange` consumer can
synchronously call `enter()` while that outside snapshot is delivered. The
controller is then back inside, but the outer exit still announces that it
left, so the shell can hide the wrong room or retire the wrong presence state.

The exit path now rechecks `destroyed` and `inRoom` after synchronous outside
state publication and suppresses the stale announcement when newer room
ownership has already won. Normal exit publication and event ordering are
unchanged when no reentrant transition occurs.

*Verified:* a public World regression re-enters from the outside
`onChange` snapshot. On the old path `building:exited` was emitted despite the
controller being inside; the corrected path emits no stale event and retains
room ownership. Focused fixed-room tests pass 63 tests. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar vertices must round after the camera zoom

The World enabled Phaser's `pixelArt` mode and rounded the following camera,
but Phaser 4's default `safeAuto` Game Object vertex mode does not round a
textured sprite when the camera transform includes a zoom. Local and remote
avatar positions are intentionally fractional during movement, so their
transformed quads could still land between screen pixels and appear soft,
especially during horizontal travel. The existing camera `lerpX = 1` fix
removes camera easing but does not change this object-level rounding decision.

The shared avatar presentation seam now sets every avatar sprite to Phaser's
`fullAuto` vertex mode. This retains nearest-neighbour texture filtering and
the existing camera/physics contracts while rounding the final transformed
quad at the integer 2x camera zoom. All local, remote and Avatar Studio
figures use this seam.

*Verified:* a red-first public avatar presentation regression first observed
that a resolved pose never selected `fullAuto`; after the change every pose
selects it while texture, origin, animation and body setup remain unchanged.
The focused avatar-visual suite passes 13 tests. No browser, lobby, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Room tile handoffs remain retryable after failure

`StreetScene.reportRoomTile()` committed its `lastTile` sentinel before
delegating to the active fixed-room controller. If station activation or its
shell-owned synchronous handoff threw, the same tile was treated as already
delivered on every later frame, so the player could not retry after the
consumer recovered. Street and Avatar Studio tile reporting already preserve
retryability at their external handoff boundaries; the room path must do the
same.

Room tile reporting now restores only its own prior sentinel when controller
delivery fails, while a nested transition or Scene teardown remains
authoritative. Normal de-duplication and station activation ordering are
unchanged.

*Verified:* a red-first public StreetScene regression makes the first room
tile handoff throw, then retries the same `{x: 3, y: 8}` tile after recovery;
the old path retained the tile and suppressed the retry, while the corrected
path calls the controller twice and commits it only after successful delivery.
The focused lifecycle suite passes 28 tests. No browser, lobby, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room update can activate a stale station after reentrant publication

`createFixedRoomController.update()` published a changed station highlight and
then continued using the outer approach. An `onChange` consumer could
synchronously call `update()` for a different station: the nested update
activated station B, then the outer turn resumed and activated stale station A.
That produced two financial-building activation events for one latest movement
state and could hand the Shell an obsolete station action.

Each update now owns a monotonically increasing revision. After synchronous
highlight publication, the controller verifies that its revision remains
current, alongside the existing destroy, room and control-owner guards, before
activating a station. Normal station approach ordering and input restoration
are unchanged.

*Verified:* a public World regression uses two non-overlapping Post Office
stations and re-enters from station A's `onChange` callback into station B. On
the old path both B and stale A activated; the corrected path emits only B and
retains B as the highlighted station. Focused fixed-room tests pass 62 tests.
No browser, lobby server, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Avatar Studio ignores a stale outer figure update after reentrant publication

`createAvatarStudioController.update()` published the newly highlighted figure
before selecting it. An `onChange` consumer can synchronously call `update()`
again, which lets the nested update select and publish figure B; the outer call
then resumed with figure A and selected A over the newer state. The controller
therefore exposed a highlighted figure B while the shared outfit selection had
been rolled back to A.

Each update now owns a monotonically increasing revision. After synchronous
highlight publication and after selection delivery, the update verifies that
its revision is still current before applying or publishing its stale figure.
Destroy/leave guards remain authoritative, and ordinary non-reentrant figure
contact keeps the same selection and event ordering.

*Verified:* a public World regression re-enters from the first figure's
`onChange` callback into a second figure contact. On the old path the final
selection was `avatar-1` despite highlighted figure 2; the corrected path
retains `avatar-2` and figure 2. The focused Avatar Studio suite passes 40
tests. No browser, lobby server, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Backend response metadata and body reader share one owner

The Backend privacy client captured coherent `ok` and `status` metadata, but
resolved the `json` body reader in a later prototype walk. A stateful response
proxy could therefore admit one response shape and substitute a different body
reader before success or error parsing, causing the body consumed by the client
to come from a prototype that never owned the admitted metadata.

Response ownership now captures `ok`, `status` and `json` together from the
same object or same captured prototype. The exact body reader is bound once and
used for both success and error responses. Native Fetch responses retain their
platform metadata getters and descriptor-owned body method; accessors and
prototype traps still fail through the controlled invalid-response path.

*Verified:* a public BackendPrivacyClient regression supplies an admitted
prototype with `400` metadata and message `admitted rejection`, then exposes a
later prototype whose reader returns `substituted rejection`. The base consumed
the substituted body; the corrected client preserves the admitted message.
Focused Backend client verification passes 96 tests and privacy typecheck
passes. Full workspace gates are recorded in the owning commit. Deterministic
fakes only: no browser, external provider, RPC, wallet, proof, signature, funds
or transaction was used.*

### 2026-08-30 — Zero-duration interior movement is a no-op

`moveWithCollisionSubsteps()` converted a valid `delta` of `0` into one
millisecond with `Math.max(delta, 1)`. A zero-time Phaser update could
therefore move the local avatar by a nonzero fractional distance despite no
elapsed time, producing drift and unnecessary pixel-phase changes in fixed
rooms or Avatar Studio.

The movement guard now returns the current position for exactly zero duration;
positive durations retain the existing bounded substep and collision behavior,
while negative, nonfinite and malformed inputs remain fail-closed.

*Verified:* a red-first World regression with a 160 px/s horizontal velocity
and `delta: 0` first moved from `x=100` to `x=100.16`; the corrected path
returns exactly `{ x: 100, y: 100 }`. The focused street-movement suite passes
19 tests. No browser, lobby, wallet, provider, RPC, proof, signature, funds
or transaction was used.*

### 2026-08-30 — Failed presence resume must expose reconnectability

When an interior exit called the live presence client's `resume()` and that
command threw without a lifecycle callback, the controller remained
`suspended`. The avatar was absent from lobby state, but the UI's reconnect
control is only available from `unavailable`, leaving the client with no
explicit recovery path after a failed resume.

The exit command is now fail-closed for its authoritative client and status
generation: peer delivery is cleared, the client is retired and disconnected,
and `unavailable` is published so the shell can offer an explicit fresh join.
A command that already triggered a newer close/replacement transition remains
owned by that newer transition.

*Verified:* a public regression makes `resume()` throw during exit; the old
path stayed suspended without disconnecting, while the corrected path reports
unavailable, disconnects once, and permits explicit reconnect. The focused
presence controller suite passes 62 tests; the full workspace passes 111 test
files and 2,385 tests, all workspace typechecks pass, the Web production build
passes, all 13 invariants hold, and diff hygiene passes. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Backend response status metadata is one coherent snapshot

The Backend privacy client resolved `ok` and `status` in separate prototype
walks. A stateful response proxy could therefore report `ok: false` from one
prototype, then substitute a different status prototype before error
classification. A normal backend rejection could be reclassified as a service
outage—or vice versa—without those two values ever coexisting on one response
shape.

Response metadata now resolves `ok` and `status` together from one object or
one captured prototype. Native Fetch responses still use their platform
getters, while malformed descriptor/prototype traps retain the controlled
invalid-response path. Body-reader ownership and backend error messages remain
unchanged.

*Verified:* a public BackendPrivacyClient regression supplies a stateful
prototype proxy whose admitted response metadata is `ok: false/status: 400`
and whose later prototype is `status: 503`. The base classified the response
as unreachable; the corrected client preserves the coherent 400 rejection as
`unknown`, even though the prototype later changes. Focused Backend client
verification passes 95 tests and privacy typecheck passes. Full workspace
gates are recorded in the owning commit. Deterministic fakes only: no browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Submission artifacts are owned before serialization

The private submission request owned its top-level artifact reference, but
passed that caller object directly to `JSON.stringify`. Serialization performs
ordinary recursive property reads, so a proxy, getter or concurrent mutation
could replace the call or proof after top-level admission and change the
artifact dispatched at the irreversible submission boundary.

Submission now recursively copies the JSON data graph from own data-property
descriptors before validation and transport. Arrays require exact dense indexed
data, objects reject symbols and accessors, numeric values must be finite, and
proxy traps fail before dispatch. JSON serialization sees only the owned plain
graph; the wire shape and proof contents remain otherwise unchanged.

*Verified:* a public BackendPrivacyClient regression supplies an artifact proxy
whose own `call` descriptor targets `0x123/apply_actions` while ordinary reads
substitute `0x999/forged`. The base dispatched the forged call; the corrected
client dispatches the descriptor-owned call and invokes no proxy `get` trap.
Focused Backend client verification passes 94 tests and privacy typecheck
passes. Full workspace gates are recorded in the owning commit. Deterministic
fakes only: no browser, external provider, RPC, wallet, proof, signature, funds
or transaction was used.*

### 2026-08-30 — Failed presence suspension must retire street visibility

When an interior entry called the live presence client's `suspend()` and that
command threw without a lifecycle callback, the controller still considered
the transport connected while the player was inside. Movement was then
suppressed locally, but the lobby retained and continued exposing the last
street position.

The entry command is now fail-closed: if the same client and status generation
remain authoritative, the controller clears peer delivery, retires the client
and reports `unavailable` after attempting disconnect. A command that already
triggered a newer close/replacement transition remains owned by that newer
transition. Explicit reconnect remains the only way to establish a fresh
presence session.

*Verified:* a public regression makes `suspend()` throw during entry; the old
path stayed connected and never disconnected, while the corrected path reports
unavailable, disconnects once, and ignores later movement. The focused presence
controller suite passes 61 tests. No browser, lobby server, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Injected Backend transports receive no client authority

The Backend privacy client stored an injected fetch-compatible function as an
instance property and later called it as `this.fetcher(...)`. JavaScript method
call semantics therefore supplied the entire BackendPrivacyClient instance as
the transport's receiver, even though an injected transport is a plain
function dependency and has no reason to receive the client's private URL and
other instance authority through `this`.

Injected transports are now wrapped at construction and invoked explicitly
with an undefined receiver. The browser-default Fetch path retains its required
`globalThis` binding, so the earlier Web IDL receiver fix remains intact.
Arguments, promises, transport error classification and request serialization
are unchanged.

*Verified:* a public BackendPrivacyClient regression supplies a
receiver-sensitive injected transport and records its `this` value. The base
received the BackendPrivacyClient instance; the corrected invocation receives
undefined while the public-key read succeeds unchanged. Focused Backend client
verification passes 93 tests and privacy typecheck passes. Full workspace
gates are recorded in the owning commit. Deterministic fakes only: no browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Private swap-prepare requests are owned before dispatch

The Backend privacy client validated swap-prepare fields through ordinary
property reads and then reread the caller object to build the quote request. A
stateful proxy could therefore pass validation with one sell token, amount or
slippage value and substitute another value at dispatch, divorcing the backend
quote from the request that passed local admission.

Swap preparation now reads both tokens, both amounts, slippage and the optional
abort signal from own data-property descriptors exactly once. Validation,
decimal serialization, dispatch and post-response cancellation use only those
owned values. Inherited fields, accessors and descriptor traps fail before
transport; the backend response ownership path is unchanged.

*Verified:* a public BackendPrivacyClient regression supplies an input proxy
whose sell-token descriptor is `0xabc` while ordinary reads later substitute
`0xdef`. The base dispatched `0xdef`; the corrected client dispatches `0xabc`
and invokes no proxy `get` trap. Focused Backend client verification passes 92
tests and privacy typecheck passes. Full workspace gates are recorded in the
owning commit. Deterministic fakes only: no browser, external provider, RPC,
wallet, proof, signature, funds or transaction was used.*
### 2026-08-30 — Presence destroy must outlive status cleanup failures

Presence controller destruction called the status-listener cleanup directly.
If a host subscription threw while being removed, `destroy()` rejected before
clearing peer delivery or disconnecting the lobby client, leaving a live
transport and stale callbacks behind. Cleanup failures must not prevent the
remaining owned resources from being retired.

Destroy now records synchronous status/peer cleanup failures, attempts peer
clear and client/replacement disconnect, and reports the recorded failures
after all cleanup has settled. Normal single-failure and multi-failure
reporting remain deterministic and repeated destroy calls reuse the same
settled result.

*Verified:* a public regression makes status-listener removal throw during
destroy; the old path skipped disconnect and peer unsubscription, while the
corrected path attempts both and preserves the cleanup error. The focused
presence controller suite passes 60 tests; the full workspace passes 110 test
files and 2,377 tests, all workspace typechecks pass, the Web production build
passes, all 13 invariants hold, and diff hygiene passes. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Private submission requests are owned before dispatch

The Backend privacy client validated submission request fields through
ordinary property reads and then reread the same caller object while building
the dispatched body. A stateful proxy could pass admission as an approved
route and substitute another route, authorization or validity window at the
irreversible submission boundary. The signal and acceptance observer were also
looked up later rather than belonging to the admitted request snapshot.

Submission now reads route, artifact, authorization, proof-validity window,
optional signal and optional acceptance observer from own data-property
descriptors exactly once. Validation, dispatch, uncertainty handling and
accepted-receipt notification use only those owned locals. Inherited fields,
accessors and descriptor traps fail before transport; the artifact retains its
existing JSON serialization contract.

*Verified:* a public BackendPrivacyClient regression supplies an input proxy
whose route descriptor is `transfer` while successive ordinary reads return
`transfer` then `swap`. The base dispatched `swap`; the corrected client
dispatches `transfer` and invokes no proxy `get` trap. Focused Backend client
verification passes 91 tests and privacy typecheck passes. Full workspace
gates are recorded in the owning commit. Deterministic fakes only: no browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — BridgePanel retires a nested shield form with its plan

`BridgePanel` memoized the nested Bank used for a ready-to-shield Bridge plan,
but omitted the Bridge `plan` and flow from that memo's ownership key. If the
Bridge record was discarded while the nested Bank was open, the stale Bank
remained mounted with the old shield amount even though the Bridge no longer
held the plan that authorized it.

The nested shield machine is now recomputed when the plan or Bridge flow name
changes, so losing readiness immediately unmounts and closes the stale Bank.
Its existing wallet handoff and fresh plan revalidation guards remain intact.

*Verified:* a public red-first React regression mounted a ready shield plan,
opened the nested Bank, discarded the Bridge record, and observed the stale
station remain on the base. The corrected panel removes the station
immediately. Focused Bridge panel tests pass 7/7. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Presence state consumers cannot poison a live handoff

Presence state snapshots were assigned before subscriber delivery, but a
subscriber exception still escaped `setState()`. During asynchronous connect
settlement that exception was caught by the join failure handler, which then
published `unavailable` and detached the client even though the transport was
live. One faulty state consumer could therefore turn a successful join into a
false disconnect and suppress later consumers in the same transition.

State delivery now isolates each subscriber exception, logs the existing
diagnostic, and continues through the remaining subscription generation. The
assigned immutable state and transport ownership are preserved; listener
replacement/unsubscribe ordering and normal connection cleanup are unchanged.

*Verified:* a public regression makes a state subscriber throw while a
successful join publishes `connected`; the old path ends `unavailable`, while
the corrected path remains connected and forwards its placement. The focused
presence suite passes 59 tests; full workspace tests and typechecks, the Web
build, invariants, and diff hygiene are green. No browser, lobby server,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — PanelLayer retires callbacks from replaced World buses

`PanelLayer` unsubscribed its three World listeners when the `world` prop
changed, but had no ownership token on the callbacks themselves. A callback
already captured by the old World could therefore run after a replacement bus
was installed and reopen or close a room owned by the new bus. This is the
same stale-completion shape as an async result: unsubscribe cannot retract a
callback that has already escaped the bus.

The effect now assigns each listener set a generation and invalidates that
generation before cleanup. Every World callback checks ownership before
publishing room state; ordinary events, room close behavior and StrictMode
cleanup are unchanged.

*Verified:* a public red-first PanelLayer regression enters Bank on World A,
rebinds to World B and enters Exchange, then invokes an already-captured Bank
callback from World A. The base reopens Bank; the corrected implementation
keeps Exchange authoritative. Focused PanelLayer tests pass 16/16. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Relay estimate requests are owned before dispatch

The Backend privacy client validated estimate request fields through ordinary
property reads and then read the same caller object again while constructing
the HTTP body. A stateful proxy could therefore pass validation as one approved
route and substitute another route or token at dispatch, breaking the rule that
the validated request is the request sent to the private service.

Estimate now reads required route/token fields and the optional abort signal
from own data-property descriptors into local scalar owners before validation.
The body, cancellation checks and response processing use only those owned
values. Inherited fields, accessors and descriptor traps fail before transport;
ordinary object callers and optional omitted signals remain supported.

*Verified:* a public BackendPrivacyClient regression supplies an input proxy
whose route descriptor is `transfer` while successive ordinary reads return
`transfer` then `unshield`. The base dispatched `unshield`; the corrected
client dispatches `transfer` and invokes no proxy `get` trap. Focused Backend
client verification passes 90 tests and privacy typecheck passes. Full
workspace gates are recorded in the owning commit. Deterministic fakes only:
no browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Presence client factory failures stay fail-closed

`PresenceController` contained transport `connect()` failures but invoked the
client factory outside that boundary. A synchronous factory failure during an
explicit reconnect therefore escaped the public reconnect action instead of
leaving the controller safely unavailable for a later retry.

Client construction now retires the in-progress setup owner and returns no
client when the factory throws. No status or peer listeners have been
installed at that point, so the existing unavailable state remains the safe
projection and a subsequent explicit reconnect may retry construction. Errors
from status/peer listener registration remain on their existing setup rollback
path; transport disconnect reporting is unchanged.

*Verified:* a public regression makes the factory throw for the initial join
and first explicit reconnect, then recover; the old path throws from the
reconnect action, while the corrected path stays unavailable and successfully
constructs/connects on the next request. The focused presence suite passes 58
tests; full workspace tests and typechecks, the Web build, invariants, and
diff hygiene are green. No browser, lobby server, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Backend response body readers are descriptor-owned

The Backend privacy client owned a response's `ok` and `status` values through
descriptors, but invoked `response.json()` through ordinary property access
after status admission. A stateful response proxy could therefore expose one
body reader in its own descriptor and substitute another reader for successful
or error parsing, changing the provider body that crossed the validated HTTP
response boundary.

Response parsing now resolves `json` from a data-property descriptor on the
response or its prototype chain, binds that exact function to the response,
and invokes only the owned reader. Accessors and proxy prototype/descriptor
traps fail through the existing controlled invalid-response path. Native Fetch
`Response` receiver behavior and submission-uncertainty classification remain
unchanged.

*Verified:* a public BackendPrivacyClient regression supplies a response proxy
whose own `json` descriptor returns public key `0x123` while an ordinary read
substitutes a reader returning `0x999`. The base published `0x999`; the
corrected client publishes `0x123` and invokes no proxy `get` trap. Focused
Backend client verification passes 89 tests and privacy typecheck passes. Full
workspace gates are recorded in the owning commit. Deterministic fakes only:
no browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Backend response arrays are owned before swap decoding

The Backend privacy client checked swap response arrays for holes using own
property descriptors, but returned the original provider array to callers that
immediately traversed it with `map`. A stateful proxy could therefore expose a
valid executor call or calldata value in its descriptor and substitute a
different value during traversal, changing the immutable plan published to the
Wallet API layer after the sparse-array check.

The shared response-array decoder now owns its length and each indexed element
from data-property descriptors, rejects holes and extra keys, contains proxy
traps, and returns a separate array. Swap call and calldata parsing therefore
operate only on the owned values; existing field validation and final freezing
remain unchanged.

*Verified:* a public BackendPrivacyClient regression supplies an executor-call
array whose own descriptor targets `0x111/swap` while an ordinary index read
substitutes `0x222/forged`. The base published the forged call; the corrected
decoder publishes the descriptor-owned call and performs no provider array
reads. Focused Backend client verification passes 88 tests and privacy
typecheck passes. Full workspace gates are recorded in the owning commit.
Deterministic fakes only: no browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Presence replacement continues after stale disconnect failure

When a pending join settled successfully after an explicit reconnect request,
the replacement handoff awaited the old client's `disconnect()` directly. A
rejected or synchronously throwing disconnect therefore diverted the
continuation into generic failure handling, after the old owner had already
been cleared, and no replacement client was created.

The explicit replacement now treats stale disconnect failure as cleanup noise
and still starts the fresh client after the attempt settles. Destroyed or
interior-deferred ownership checks remain in force; normal `destroy()` retains
its existing disconnect-error reporting semantics.

*Verified:* a public regression defers the first join, requests reconnect,
then makes the stale disconnect reject. The old path disconnects the first
client but never connects the second; the corrected path performs both. The
focused presence suite passes 56 tests; full workspace tests and typechecks,
the Web build, invariants, and diff hygiene are green. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Presence replacement survives stale cleanup failure

When a pending join settled successfully after an explicit reconnect request,
the replacement branch invoked the stale status cleanup directly. If that
cleanup threw, the continuation fell into generic connect-failure handling
after clearing the reconnect request, so the old client was never disconnected
and no replacement client was started. A queued success could therefore leave
the controller unavailable without honoring the user's retry.

The successful replacement handoff now detaches status ownership before
invoking cleanup and contains both status and peer cleanup errors before
retiring the stale client. The replacement still disconnects the old client
before creating the new one; ordinary disconnect rejection and explicit retry
semantics remain unchanged.

*Verified:* a public regression defers the first join, requests reconnect,
then resolves the join while its status cleanup throws. The old path performs
no replacement; the corrected path disconnects the first client and connects
the second. The focused presence suite passes 55 tests; full workspace tests
and typechecks, the Web build, invariants, and diff hygiene are green. No
browser, lobby server, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Requested balance tokens are owned before wallet handoff

The balance input path validated caller tokens with `Array.prototype.some`
and then copied the same caller array with spread. A stateful proxy could
return one valid token during validation and a different valid token during
the later copy, changing both the wallet query and the response-correlation
allowlist after admission.

Requested tokens now pass through the same exact descriptor-owned array
boundary as provider result arrays before felt validation. The wallet receives
a separate mutable copy of those owned scalars, while response correlation
continues to use the same owned values. Sparse arrays, extra keys, accessors and
proxy traps fail before the wallet is called.

*Verified:* a public Wallet API regression supplies a caller proxy whose own
index descriptor is token `0x123` while ordinary reads substitute canonical
STRK. The base queried STRK and published that result; the corrected path asks
for `0x123`, publishes `0x123` and invokes no caller `get` trap. Focused Wallet
API verification passes 193 tests and privacy typecheck passes. Full workspace
gates are recorded in the owning commit. Deterministic fakes only: no browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Presence reconnect requests are deferred during drop publication

Presence drop handling clears the retained peer snapshot before publishing the
`unavailable` state. A peer subscriber can synchronously request reconnect
during that clear; before this correction, the controller still looked
`connecting` and started a second join on the failed client instead of
retiring it and constructing the explicit replacement.

Drop publication now tracks nested unavailable transitions and holds a
reconnect request made by a peer or state subscriber until the transition has
finished. The request then follows the existing stale-client replacement path;
ordinary drops, failed-join retries, and peer cleanup remain unchanged.

*Verified:* a public regression rejects a deferred join and requests reconnect
from the retained-peer clear callback. The base invokes the failed client's
`connect()` twice and never creates a replacement; the corrected path invokes
it once, disconnects it once, and connects one fresh client. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Wallet capability versions are owned before admission

Capability detection validated that the wallet returned an array, but then
traversed that provider array with ordinary `map` reads. A stateful proxy could
therefore expose an unsupported version in its own index descriptor and
substitute the minimum supported version during traversal, causing the wallet
to pass financial capability admission on a value the provider result did not
own.

Capability detection now owns the exact array length and indexed values from
data-property descriptors before semantic-version parsing. Holes, extra keys
and proxy descriptor traps fail through the existing invalid-capability path;
non-string entries retain the existing ignored-value behavior. Recipient
registration remains a primitive felt boundary and has no corresponding
object ownership window.

*Verified:* a public Wallet API regression supplies a version-array proxy whose
own index descriptor is `0.9.0` while an ordinary read substitutes `0.10.3`.
The base reported STRK20 support; the corrected decoder reports unsupported
with version `0.9.0` and performs no length or index reads. Focused Wallet API
verification passes 192 tests and privacy typecheck passes. Full workspace
gates are recorded in the owning commit. Deterministic fakes only: no browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Wallet balance result arrays are owned before decoding

Balance entry fields were descriptor-owned, but the wallet's result array was
still traversed with `Array.prototype.map`. A stateful proxy could substitute
an indexed entry or array length through ordinary reads before the entry
decoder ran, so the immutable published snapshot could describe a value absent
from the wallet result's own descriptors. Sparse arrays and extra array or
entry fields were also not an exact provider shape.

The balance decoder now owns the array length and every indexed element from
data-property descriptors, rejects holes and extra array keys, and requires
each entry to contain exactly the two owned fields `token` and `balance`.
Duplicate numeric tokens, requested-token correlation, felt validation and
frozen publication are unchanged and run only over the owned values.

*Verified:* a public Wallet API regression supplies an array proxy whose own
index descriptor contains balance `0x64` while an ordinary index read returns
`0x32`. The base published total 50; the corrected decoder publishes total 100
without reading the provider's length or index. Focused Wallet API verification
passes 191 tests and privacy typecheck passes. Full workspace gates are
recorded in the owning commit. Deterministic fakes only: no browser, external
provider, RPC, wallet, proof, signature, funds or transaction was used.*

### 2026-08-30 — Wallet balances publish descriptor-owned values

The balance decoder checked that wallet entries exposed own data properties,
but then destructured `token` and `balance` through ordinary property reads.
A stateful proxy could therefore present valid descriptors and substitute a
different token or amount for the immutable balance snapshot published to the
game. Accessor-only and inherited fields were rejected, but descriptor checks
alone did not own the values.

Balance decoding now reads both fields directly from their own data-property
descriptors inside the controlled wallet-result boundary. Descriptor traps are
mapped to the existing invalid-balance failure, and the subsequent felt,
requested-token, duplicate-token and immutable-publication rules operate only
on those owned scalar values.

*Verified:* a public Wallet API regression supplies a stateful proxy whose
balance descriptor says `0x64` while ordinary reads substitute `0x32`. The base
published total 50 and invoked the proxy trap; the corrected decoder publishes
total 100 and records zero ordinary reads. Focused Wallet API verification
passes 190 tests and privacy typecheck passes. Full workspace gates are
recorded in the owning commit. Deterministic fakes only: no browser, external
provider, RPC, wallet, proof, signature, funds or transaction was used.*

### 2026-08-30 — Fly ready-child supervisor test uses a post-handoff trigger

The Fly composition correctly rejects a private child that exits while
startup is still in progress. The ready-child supervisor regression used a
100 ms post-ready timer, so a busy full test run could cross that timer before
the composition was handed to the supervisor; the test then failed while
assuming it was exercising a post-handoff exit.

The fixture now keeps a ready child alive until the test creates an explicit
marker after composition handoff. Production startup ordering is unchanged:
pre-handoff exits remain startup failures and post-handoff exits still invoke
the supervisor fatal callback.

*Verified:* the marker is created only after `startFlyComposition()` returns,
so the post-handoff exit regression is deterministic under suite load. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Failed presence joins retire their status authority

When an asynchronous Lobby join rejected, PresenceController published
`unavailable` but left the failed client's status listener active. A queued
`connected` callback from that failed client could then resurrect the presence
state and make the stale client authoritative again, even though no join was
in flight. The same stale callback could interfere with an explicit retry.

Connect failure handling now deactivates and detaches the current client's
status listener before publishing `unavailable`; cleanup is detached before
invocation and cleanup errors remain contained. Peer delivery and explicit
reconnect ownership are otherwise unchanged, and normal disconnect rejection
semantics are preserved.

*Verified:* a public regression rejects a deferred connect, then delivers a
late `connected` callback; the old path resurrects `connected`, while the
corrected path remains `unavailable`. The focused presence suite passes 54
tests; full workspace tests and typechecks, the Web build, invariants, and
diff hygiene are green. No browser, lobby server, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Production bootstrap destroys rejected session candidates

After the bootstrap began freezing and revalidating loaded sessions, a
candidate that failed that admission could still be dropped without teardown.
That included a session with malformed operations and a proxy that mutated its
operations during validation; the failure surface was reported, but the
candidate's wallet session remained unowned.

Rejected loaded candidates now go through the same contained data-method
destructor used for late and retired sessions before startup failure is
reported. Primitive or accessor-only malformed values remain harmless no-ops,
while valid data-backed destroy methods run once. Accepted sessions, HMR
retirement, render failures and duplicate disposal behavior are unchanged.

*Verified:* red-first regressions observed zero destruction for malformed
operations and validation-mutating candidates; the corrected path destroys
each exactly once. Focused bootstrap tests pass 14 tests; workspace gates are
recorded on the candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Swap decoder owns array lengths without proxy reads

The owned swap-plan decoder took root and nested field values from property
descriptors, but still read the `length` of the provider's executor-call and
calldata arrays through ordinary property access. Exact own-key checks made a
simple substituted length fail closed later, yet the provider-controlled `get`
trap still executed inside the authority boundary and could throw or cause
side effects before rejection.

The decoder now reads both array lengths from their own data-property
descriptors, alongside the already descriptor-owned elements. No provider
`get` trap is invoked while acquiring array shape; malformed descriptors and
proxy traps retain the existing controlled malformed-plan classification.

*Verified:* a public Wallet API regression installs a stateful executor-call
array proxy whose `length` getter reports a substituted value and records each
ordinary read. The base invoked that trap once; the corrected decoder owns the
real descriptor length, publishes the complete valid review and records zero
ordinary reads. Focused Wallet API verification passes 189 tests and the
privacy package typecheck passes. Full workspace gates are recorded in the
owning commit. Deterministic fakes only: no browser, external provider, RPC,
wallet, proof, signature, funds or transaction was used.*

### 2026-08-30 — Production bootstrap owns an immutable admitted session

Session shape validation alone did not close the ownership boundary. A
hostile Proxy could return valid descriptors while mutating the session's
`operations` object during the final method check; the original mutable
session would then be handed to the renderer in a different shape than the
one that was validated.

After validation, bootstrap now freezes both the session and its privacy
operations object, then repeats validation before publication. This closes
the synchronous validation-to-render TOCTOU while preserving the original
method values and receiver. Freeze or revalidation traps fail closed through
the existing startup failure surface; no facade or rebinding is introduced.

*Verified:* a red-first public bootstrap regression mutated `operations` from
inside a descriptor trap and reached `render()` on the old path. The corrected
path reports failure, and a separate regression confirms both admitted objects
are frozen before rendering. Focused bootstrap tests pass 14 tests; workspace
gates are recorded on the candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Swap plans are owned before semantic validation

The private-swap adapter previously validated an AVNU plan through ordinary
property reads and only afterwards spread and snapshotted that same provider
object. A stateful proxy could therefore return one executor while validation
ran and substitute another executor for the frozen plan later used to build the
wallet action. Exact key counts did not close this time-of-check/time-of-use
gap because they did not take ownership of the values behind those keys.

Swap preparation now reads the exact seven root fields, every executor-call
field and every calldata element from own data-property descriptors into one
deeply frozen graph. Proxy traps, accessors, sparse or extended arrays and
malformed nested calls fail closed before review. The same owned plan is the
only authority for the published review, confirmation-time semantic checks and
the eventual wallet action; the nested relay fee keeps its existing owning
decoder and live fee-policy recheck.

*Verified:* a public Wallet API regression first supplied a stateful proxy that
returned executor `0x999` during validation and `0x888` during the later spread;
the base prepared the wallet withdrawal to the unvalidated `0x888`. The owned
decoder prepares and confirms only `0x999`. Focused Wallet API verification
passes 188 tests and the privacy package typecheck passes. Full workspace gates
are recorded in the owning commit. Deterministic fakes only: no browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Production bootstrap validates the privacy operations seam

The production bootstrap validator checked that a loaded session had an
object-shaped `operations` property, but did not validate the five methods of
the `PrivacyOperations` seam. A value such as `operations: {}` therefore
passed admission and was rendered as a usable wallet session; a proxy whose
descriptor inspection throws could also escape the intended controlled
failure path.

Bootstrap admission now requires own data methods for `capability`,
`poolConfig`, `balances`, `recipientStatus` and `prepare`, in addition to the
existing WalletSession methods. Descriptor/proxy failures remain contained as
a startup failure. The session and operation method values are not rebound or
mutated, preserving the existing WalletSession receiver contract; teardown
continues to use its captured data method.

*Verified:* red-first bootstrap regressions first rendered a session carrying
`operations: {}` and accepted an operations proxy that cannot be safely
inspected; the corrected path renders neither and reports each failure once.
Focused bootstrap tests pass 12 tests; workspace gates are recorded on the
candidate. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Swap plans and executor calls have exact provider shapes

Swap validation required the fields it used but accepted extra root and nested
executor-call fields. A nested descriptor trap could also escape as a raw
provider error. That weakened the exact quote boundary and made malformed AVNU
objects inconsistently classified.

The existing mature validation/snapshot path now additionally requires exactly
seven own root fields and three own fields per executor call. Root and nested
ownKeys/descriptor traps are contained as the existing `unknown` invalid-plan
failure. Quote semantics, owned relay fees, executor-call snapshotting and
confirmation behavior are unchanged.

*Verified:* public regressions were red for extra root/call fields and a nested
descriptor trap; a root ownKeys trap remained fail-closed. The focused Wallet
API suite passes 187 tests and privacy typecheck. Full workspace verification
is recorded with the owning commit. Deterministic fakes only: no browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Relay fee authority is an owned exact snapshot

Relay fee validation checked own data descriptors but then re-read the provider
object normally and copied it with object spread. A hostile Proxy could expose
safe descriptor values during validation, substitute recipient or authorization
through `get`, or throw during inspection/spread, making the reviewed fee differ
from the fee later proved and submitted.

One exact five-field decoder now contains ownKeys/descriptor traps, validates
descriptor values only and returns a frozen quote. Pool-native estimates and
swap-plan fee ownership use that same snapshot; extra provider fields are
rejected and proxy getters cannot substitute authority.

*Verified:* public regressions were red for recipient/authorization
substitution, descriptor and ownKeys traps, and an extra provider field. The
focused Wallet API suite passes 183 tests and privacy typecheck. Full workspace
verification is recorded with the owning commit. Deterministic fakes only: no
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Pool-config proxy traps stay inside the provider boundary

The owned pool-config decoder rejected accessors and extra fields, but its
descriptor and own-key inspection could itself throw on a hostile Proxy. Those
raw trap errors were then mapped as a network outage rather than an invalid
provider result.

Decoder inspection now runs inside one contained block, reads only own data
descriptor values into locals, and converts every inspection trap into the
existing `unknown` invalid-configuration error. Exact key counting includes
string and symbol fields, so provider metadata cannot cross the snapshot; no
ordinary getter is invoked.

*Verified:* public regressions were red for descriptor and ownKeys traps and
green after containment. Extra string/symbol fields, inherited/accessor fields,
valid frozen snapshots and all live confirmation consumers remain covered.
The focused Wallet API suite passes 179 tests and privacy typecheck. Full
workspace verification is recorded with the owning commit. Deterministic fakes
only: no browser, wallet, provider, RPC, proof, signature, funds or transaction
was used.*

### 2026-08-30 — Production bootstrap contains malformed loaded sessions

The production bootstrap trusted the runtime value fulfilled by its dynamic
loader because TypeScript's `Promise<WalletSession>` annotation does not
validate a thenable or module boundary. A malformed value could therefore be
published to the production renderer as a wallet session. Teardown also used
ordinary `session.destroy` property access, so a hostile proxy getter could
prevent destruction even when the underlying data method was valid.

Bootstrap now requires an object with own data `operations` and all WalletSession
methods before publishing it, containing descriptor/proxy failures as a
controlled startup failure. Teardown reads the own data `destroy` method and
invokes that function directly, preserving valid receiver behavior without
triggering a hostile property getter. Native Promise assimilation continues to
contain throwing then getters and ignore duplicate fulfillment; late malformed
values remain unpublished after disposal.

*Verified:* red-first bootstrap regressions first rendered `42` as a session
and failed to call the target destroy method through a hostile proxy getter;
the corrected path renders neither and destroys valid data-backed sessions.
Throwing then getters and double-fulfilling thenables are also covered. Focused
bootstrap tests pass 10 tests; workspace gates are recorded on the candidate.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Presence drops and retries survive consumer cleanup errors

Presence teardown previously let a remote-peer clear callback or stale status
cleanup throw through lifecycle control. A dropped client could therefore
remain reported as connected when clearing its retained peer source failed,
and a synchronous `connect()` failure could not be retried if replacing the
stale client encountered a throwing status cleanup.

Drop handling now still publishes `unavailable` after best-effort peer
cleanup, and stale-client replacement attempts status and peer cleanup before
retiring the old owner and starting the explicit replacement. Failed setup
rollback also preserves its original error when state subscribers throw after
the owner has been retired. These cleanup-error suppressions do not change
normal disconnect rejection handling.

*Verified:* public regressions cover a synchronous connect failure with a
throwing status cleanup and a remote-peer clear callback that throws during a
drop. The old path either threw before retry or failed to publish unavailable;
the corrected path remains unavailable and constructs/connects the replacement.
The focused presence suite passes 53 tests; full workspace tests and
typechecks, invariants, and diff hygiene are green. No browser, lobby server,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Presence setup preserves registration errors across throwing cleanup

When peer-listener setup failed after status registration, the presence
controller attempted to stop the status listener directly. A cleanup callback
that threw masked the original peer-registration failure and prevented the
failed client from being retired; an explicit reconnect then threw again from
that stale cleanup instead of creating a replacement client.

The failed setup path now attempts status cleanup best-effort, preserves the
original peer setup error, and always retires the exact partially initialized
client through the existing setup rollback. Normal teardown error behavior is
unchanged; this suppression applies only while preserving a more authoritative
setup failure.

*Verified:* a public regression makes peer registration throw and makes the
already-installed status cleanup throw. The old path throws the cleanup error
on reconnect and never constructs the replacement; the corrected path retires
the failed owner and reconnects through the second client. The focused
presence suite passes 51 tests, with Web typecheck and diff hygiene green. No
browser, lobby server, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Presence client setup failures retire the failed owner

`PresenceController.ensureClient()` published a client reference before
installing the status and peer callbacks, but did not contain synchronous
errors from either registration. A client whose `onStatus()` attached the
callback and then threw could therefore remain the active owner; a later
status event from that failed setup could publish `connected` without a
successful join. The same gap in `onPeers()` allowed a callback attached
before the throw to publish stale remote peers after startup had failed.

Setup registration is now an ownership transaction. Both callback paths
deactivate their local delivery guards, retire the exact failed client,
clear the retained peer snapshot, restore unavailable state, and preserve the
original registration error. A failed setup cannot be revived by a late
status/peer callback or strand the controller as a partially initialized
client.

*Verified:* public regressions make `onStatus()` and `onPeers()` attach their
callback and then throw. The status case first reproduces a late connected
event reviving the failed controller; the peer case first reproduces a stale
remote snapshot after failed setup. The corrected presence suite passes 50
tests, Web typecheck passes, and diff hygiene is clean. No browser, lobby
server, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Remote peer sources retain queued state after listener errors

`createRemotePeerSource()` queued reentrant publications while a listener was
being delivered, but cleared that queue when the listener threw. A newer full
snapshot produced during an older remote-avatar render could therefore be
discarded by the source before the World layer saw it, leaving stale
presentation state despite the source having accepted the newer update.

The source now stops the failing listener's current delivery, continues
draining queued authoritative snapshots, and rethrows the original error (or
an aggregate when multiple queued deliveries fail) after the queue is
exhausted. Listener generation checks, immutable snapshots, and ordinary
error propagation remain unchanged.

*Verified:* a red-first public World source regression queued x=80 while the
x=40 listener delivery threw; the old source observed only x=40, while the
corrected source observes x=40 then x=80 and still throws the original error.
Removing queued-drain continuation restores the failure. No browser, lobby,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Production bootstrap contains synchronous lifecycle failures

The production bootstrap assumed both HMR disposal registration and the
loader would return without throwing. A synchronous `hot.dispose()` or loader
failure therefore escaped before the controlled failure surface; thenable
assimilation was not explicit either.

Bootstrap setup now treats disposal registration as an admission boundary and
fails closed without starting the loader if registration fails. Loader
invocation is normalized through `Promise.resolve` and synchronous throws are
routed to the contained failure reporter. Existing late-load retirement,
render ownership and fallback behavior remain unchanged.

*Verified:* red-first public regressions made HMR registration and loader
setup throw; the old bootstrap leaked both exceptions, while the corrected
path reports each once and performs no load after failed HMR setup. Focused
bootstrap tests pass 6 tests; workspace gates are recorded on the candidate.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Remote avatar errors do not discard newer queued state

The remote-avatar render queue preserved reentrant ordering, but its outer
drain cleared pending snapshots as soon as an older render reported an error.
A newer authoritative peer update delivered during that failed render was
therefore lost until the lobby happened to publish again; the layer retained
the old pose even though the source had already supplied a replacement.

The drain now records render failures, continues processing every queued newer
snapshot, and reports the original failure (or an aggregate of failures) only
after the queue is exhausted. Existing last-successful-pose retention,
teardown guards, and source error propagation remain unchanged.

*Verified:* a red-first public World fake delivered x=80 during an x=56
render whose position setter threw; the old layer ended at x=40 and discarded
the newer update, while the corrected layer ends at x=80 and still rethrows the
original error. Removing the queue-drain error handling restores the failure.
No browser, lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Pool configuration is owned at every authority read

Pool configuration validation read provider properties normally and then
spread the same object. Inherited data could be accepted but disappear from
the published snapshot, accessors could execute and be misclassified as a
network failure, and shield/private/swap confirmation used fresh pool results
without validating them before fee checks or wallet handoff.

One decoder now requires exactly four own data properties, validates their
felt, u256 and integer semantics, and returns a frozen snapshot. Public reads
and every confirmation-time refresh use that owned result before fee
comparison, relay estimation, swap revalidation or wallet authority.

*Verified:* public regressions were red for inherited and accessor-backed
configuration and for malformed live shield, transfer and swap refreshes. All
now fail before wallet/submission handoff, while the existing immutable
snapshot regression remains green. The focused Wallet API suite passes 175
tests and privacy typecheck. Full workspace verification is recorded with the
owning commit. Deterministic fakes only: no browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.*

### 2026-08-30 — Production bootstrap retires sessions whose render fails

The production wallet bootstrap took ownership of a loaded session before
calling `render()`, but a synchronous render failure only showed the failure
surface and left the unpublished session owned until a later HMR disposal.
That retained wallet connection state after the composition had failed.

The render-failure path now releases and destroys the exact loaded session
before reporting the failure. Reentrant disposal during render remains
idempotent, and a successfully rendered session stays owned until explicit
bootstrap disposal.

*Verified:* a red-first bootstrap regression made `render()` throw and
observed zero session destruction on the old path; the corrected path destroys
it once. A reentrant dispose/render-failure regression confirms no double
destruction. Focused bootstrap tests pass 4 tests; workspace gates are
recorded on the candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Confirmation fee ceilings are u256-bounded authority

Confirmation accepted any nonnegative bigint fee ceiling. A value above
`u256::MAX` could therefore cross the review boundary and effectively disable
the ceiling even though every actual fee and total is u256-denominated.

The common confirmation validator now requires the inclusive
`0..u256::MAX` range before any live pool read, wallet action, proof or relay
handoff. Shield, private transfer and swap share the same rule; the exact
maximum remains valid.

*Verified:* public regressions were red across all three confirmation routes
for `2^256`, then proved rejection before live reads or handoff after the fix.
An exact-maximum shield confirmation remains green. The focused Wallet API
suite passes 170 tests and privacy typecheck. Full workspace verification is
recorded with the owning commit. Deterministic fakes only: no browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Remote avatar teardown cannot resurrect its retained peer map

`createRemoteAvatarLayer.render()` could continue after a synchronous Scene
shutdown destroyed the layer during sprite presentation. Cleanup correctly
cleared `peers`, but the in-flight render then assigned its already-built
snapshot afterward, making the destroyed layer report live remote peers until
another callback (which teardown had correctly made inert) arrived.

The render now checks teardown ownership immediately before committing its
retained map. A shutdown during presentation leaves the public layer empty and
does not resurrect stale World state; ordinary rendering, reentrant queueing,
and cleanup error behavior remain unchanged.

*Verified:* a red-first public World fake triggered shutdown from the initial
sprite position setter; the old layer retained one peer after destruction,
while the corrected layer retains an empty map. Removing the post-render
destroy guard restores the failure. No browser, lobby, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Production bootstrap contains failure-renderer rejection

The production wallet bootstrap detached its dynamic-load promise. A render
failure was routed to the configured failure renderer, but if that renderer
also threw, the detached promise rejected without a handler and produced an
unhandled rejection after the original startup failure.

Failure reporting now has its own quiet boundary. The original load or render
failure remains contained, and a second failure from the fallback renderer
cannot escape the retired bootstrap. Normal failure rendering and late-load
retirement behavior are unchanged.

*Verified:* a red-first public bootstrap regression made `render()` throw and
then made `failure()` throw; the old detached promise emitted an unhandled
rejection, while the corrected path reports no unhandled rejection. Focused
bootstrap tests pass 2 tests; workspace gates are recorded on the candidate.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Pool and combined fees remain inside u256

Pool configuration accepted any nonnegative bigint fee. A provider value at
`2^256` could therefore be published as the pool fee and total cost, while two
individually valid pool and relay fees could produce an out-of-domain combined
cost at preparation or confirmation.

Pool fees now require the inclusive u256 range. Private and swap preparation
and their live confirmation rechecks use one checked pool-plus-relay helper,
which rejects totals above `u256::MAX` before wallet handoff. The exact maximum
total remains valid; zero governance pool fees and the existing relay-policy
ceiling remain unchanged.

*Verified:* public regressions were red for an oversized pool fee, an
overflowing prepared total, and a live confirm-time overflow; the exact maximum
boundary stayed green. The focused Wallet API suite passes 166 tests and
privacy typecheck. Full workspace verification is recorded with the owning
commit. Deterministic fakes only: no browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Production wallet bootstrap retires late dynamic imports

The production entrypoint started the asynchronous `@strkworld/privacy`
import and registered an HMR cleanup that closed over a mutable session
variable. If disposal happened before the import resolved, the callback saw
no session; the late completion then created and rendered a wallet session
into a retired entrypoint, with no owner left to destroy it.

Production wallet loading now has an explicit bootstrap owner. Disposal
retires the owner, destroys a session that resolves after retirement, and
suppresses late render/failure publication. A normally resolved session is
still rendered and is destroyed by the same HMR cleanup. Wallet policy,
composition and dynamic-import boundaries are unchanged.

*Verified:* a red-first deferred-load public regression disposed the entrypoint
before session resolution; the old shape rendered the late session and never
destroyed it, while the corrected bootstrap renders nothing and destroys it
once. Focused bootstrap and architecture tests pass 7 tests; workspace gates
are recorded on the candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Caller intent amounts are bounded to u256 before dependencies

Wallet API intent validation required positive bigints but did not cap them at
the protocol amount domain. Shield, transfer and unshield values at `2^256`
could therefore survive preparation and later be serialized into an invalid
action felt; swap input and minimum-output values relied on stricter downstream
plan behavior rather than the common caller boundary.

All caller-controlled amounts now require the inclusive `1..u256::MAX` range
inside `validateIntents()`, before pool reads, registration checks, relay
estimation, swap planning or wallet calls. The exact maximum remains valid.
Route policy, batching, relay aggregation and swap token direction are
unchanged.

*Verified:* public regressions cover out-of-range shield, transfer, unshield,
swap input and swap minimum output, assert no dependency call, and preserve the
exact maximum boundary. The focused Wallet API suite passes 162 tests and
privacy typecheck. Full workspace verification is recorded with the owning
commit. Deterministic fakes only: no browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Wallet session replacement survives old unsubscribe failures

`WalletSessionProvider` passed the session's unsubscribe callback directly to
`useSyncExternalStore`. When a session prop was replaced, a synchronous throw
from the old session's cleanup aborted React's passive-effect transition
before the replacement subscription was installed, leaving the new session
without updates and surfacing a stale provider lifecycle failure.

The provider now owns a guarded subscription wrapper: setup failures become a
no-op cleanup, and retired-session unsubscribe failures are contained so a
replacement can subscribe independently. Snapshot projection, session
methods, and normal unsubscribe behavior are unchanged.

*Verified:* a red-first public jsdom regression replaced a subscribed session
whose unsubscribe throws and observed the old exception before the new
session subscribed. The corrected provider invokes both subscriptions and
retains the replacement render. Focused WalletSessionProvider tests pass
3 tests; Web typecheck, full tests, build, invariants and diff hygiene are
recorded on the candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Remote avatar presentation serializes reentrant snapshots

`createRemoteAvatarLayer()` reconciled a source snapshot directly from its
listener. A source or presentation callback could synchronously deliver a
newer full snapshot while that reconciliation was still rendering; the nested
render updated the sprite and retained map, but the outer render then
committed its older snapshot over the newer one. The World could therefore
keep stale peer coordinates until another publication arrived.

The layer now queues source callbacks that reenter during reconciliation and
drains them in order before returning, clearing pending work on teardown or a
render failure. Existing validation, failed-update retention, removal retry,
and shutdown ownership remain unchanged.

*Verified:* a red-first public World fake source reentered with an x=80
snapshot while the initial x=40 snapshot was rendering; the old layer ended
at x=40, while the corrected layer finishes with x=80 on both its retained
map and sprite. The focused remote-avatar and remote-peer suites pass 38
tests. No browser, lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Wallet route policy is semantically validated before discovery

The wallet session already copied policy data into an immutable snapshot, but
accepted runtime values that only matched the TypeScript shape nominally. A
`NaN` maximum intent count made the batch-size ceiling comparison permanently
false; fractional, negative and unsafe counts, negative relay fees, unknown or
duplicate routes, malformed or numerically duplicated token felts, and an
enabled swap without valid chain/slippage policy could all survive session
construction.

Policy construction now fails closed before wallet discovery for invalid
scalar bounds, non-bigint or negative relay fees, unknown/duplicate routes,
zero or above-field token felts, numeric token duplicates, and incomplete or
invalid swap semantics. Valid route ordering and token encodings are preserved;
the owned arrays and objects remain frozen and wallet identity is never read.

*Verified:* sixteen public session regressions were red together before the
semantic boundary and green after it, including `NaN` intent authority,
numeric token aliases and swap-without-policy. The focused WalletSession suite
passes 100 tests and package typecheck. Full workspace verification is recorded
with the owning commit. Deterministic fakes only: no browser, wallet, provider,
RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Lobby disconnect does not publish through a replacement room

`LobbyClient.disconnect()` retired its room and emitted the `closed` status
before awaiting `room.leave(true)`, allowing a synchronous status listener to
start a replacement connection. The old disconnect continuation then emitted
its cleared peer snapshot after the leave settled, even though the replacement
room already owned the client's peer stream. That produced a duplicate,
stale delivery through the live replacement connection and made the old
transport operation observable after authority had moved on.

Disconnect now records its generation and emits the post-cleanup empty peer
snapshot only if that generation remains current. A replacement connection
therefore owns all subsequent peer delivery, while ordinary disconnects and
leave-error cleanup still publish the removal and preserve the original error.

*Verified:* a red-first public fake-room regression deferred room A's leave,
reconnected synchronously from the `client-left` status listener, and observed
the replacement peer snapshot twice on the old path. The corrected path emits
it once. Removing the generation guard restores the failure. No browser,
external lobby, wallet, provider, RPC, proof, signature, funds or transaction
was used.

### 2026-08-30 — Production composition owns hostile wallet snapshots

`WalletSessionProvider` previously passed `session.getSnapshot()` directly
through `useSyncExternalStore`. Production composition then read fields such
as `snapshot.phase` and `snapshot.account` with ordinary property access. A
descriptor-valid proxy snapshot could throw from its `get` trap and escape
the wallet gate before the app could fail closed.

The provider now caches an own-data projection for each raw snapshot identity,
deep-freezes the wallet choices, and returns an empty selection snapshot when
the session snapshot or any required field is malformed. Stable session
snapshot identity remains stable for external-store consumers; the session
and its financial operations are otherwise unchanged.

*Verified:* red-first public ProductionRoot regressions supplied a
descriptor-valid snapshot proxy whose property-read trap throws and a
connected session whose snapshot read throws; the old composition leaked the
raw exception (or could retain the connected path), while the corrected
provider renders the wallet gate without invoking it. Removing the projection
restores the proxy failure. Focused ProductionRoot/WalletSessionProvider tests
pass 15 tests. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Privacy route-policy snapshots must bypass proxy reads

The WalletSession route-policy boundary validated own data descriptors, but
then read the policy and its nested collections through ordinary property
access and spread iteration. A proxy could report valid descriptors while its
`get` or iterator trap threw, leaking an arbitrary exception during session
construction instead of producing an owned policy snapshot.

Policy snapshots now read validated data-descriptor values and materialize
collections inside a controlled failure boundary. Optional swap metadata uses
the same descriptor-only reads. Inherited/accessor fields remain rejected and
valid policy values keep the same frozen shape; no wallet connection or
operation is created for a malformed policy.

*Verified:* a red-first public session regression supplied a descriptor-valid
proxy whose property-read trap throws; the old constructor leaked that raw
exception, while the corrected path constructs the session without invoking
the trap. Collection iteration failures are also mapped to the same
`PrivacyError`. Focused WalletSession tests pass 83 tests, Privacy tests pass
460 tests, and workspace gates are recorded on the candidate. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Privacy policy validation contains descriptor-trap failures

The WalletSession route-policy boundary used `Object.getOwnPropertyDescriptor()`
to reject inherited and accessor-backed fields, but did not contain a proxy's
descriptor trap. A malformed policy could therefore throw an arbitrary raw
exception while the session was being constructed, before the intended
controlled invalid-policy `PrivacyError` and before discovery began.

The shared own-data validator now treats descriptor inspection failures as a
failed validation. Existing inherited/accessor rejection, policy ownership and
valid route behavior are unchanged; no wallet connection or operation is
created for a malformed policy.

*Verified:* a red-first public session regression supplied a proxy-backed policy
whose descriptor trap throws; the old constructor leaked that exception, while
the corrected path returns `PrivacyError`. Removing the validator catch
restores the failure. No browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Lobby reconciliation avoids redundant timers after synchronous confirmation

`LobbyClient.#pump()` sent a move and unconditionally scheduled its retry timer
after the send returned. A transport/state callback can run synchronously from
`room.send()` and update the local entry before that return; the nested pump
then correctly clears the desired move, but the outer pump still left a stale
reconciliation timer behind.

The send path now checks whether the desired placement was cleared by that
synchronous confirmation before stamping the send time or scheduling another
timer. Asynchronous server updates, dropped-move retries, send-floor handling
and transport-closure ownership are unchanged.

*Verified:* a red-first public fake-room regression synchronously applied the
move and emitted a state change from `room.send`; the old client created one
redundant timer, while the corrected path sent once with no timer. Removing the
post-send desired-state guard restores the failure. No browser, external
lobby, wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby reconciliation verifies the entry identity

`LobbyClient.#serverSelf()` looked up the local session key in the decoded
peer map but trusted the entry's position without checking that its embedded
`gameId` still matched the local identity. A stale or malformed map entry could
therefore make a requested move appear acknowledged even though the state did
not describe this client, clearing reconciliation without sending the move.

Reconciliation now accepts a decoded entry as the local server position only
when its projected `gameId` exactly matches the current client identity. The
peer snapshot projection, movement normalization, and wire protocol are
unchanged; mismatched entries are treated as not-yet-known server state.

*Verified:* a red-first public fake-room regression keyed an entry by the local
id while embedding another identity and matching the requested position. The
old client sent no move; the corrected client sends the move. Removing the
identity guard restores the failure. No browser, external lobby, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby peer projection contains malformed decoded state

`LobbyClient.peers()` and its reconciliation lookup read decoded room-state
fields directly. A malformed state entry whose position accessor throws could
therefore escape through a normal state-change projection or timer-driven move
path and crash the consumer, even though the entry came from an untrusted wire
boundary.

Both paths now use a small guarded peer projection. A state entry that cannot
be read is ignored, while valid Colyseus schema entries retain the same plain
snapshot shape, self-filtering, reconciliation and immutable delivery
behavior. No lobby financial data or new protocol fields are introduced.

*Verified:* a red-first public fake-room regression injected an accessor-backed
peer position and observed `peers()` throw; the corrected projection returns an
empty snapshot. Removing the guard restores the failure. Valid real-server and
schema-backed Lobby tests remain green. No browser, external lobby, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby resume reads only own data placement fields

`LobbyClient.resume()` used ordinary property access for the runtime placement
coordinates. An accessor-backed `x` or `y` could therefore execute caller code
and leak its raw exception before the existing controlled invalid-placement
failure; inherited values were also eligible to cross the client boundary.

Resume now reads own data descriptors for `x`, `y` and `facing`, with descriptor
or proxy failures treated as absent. Required coordinates still fail closed with
`Lobby resume placement is invalid.`, while missing or malformed facing keeps
the existing default-to-down behavior. Valid placement normalization, wire
shape and transport lifecycle ownership are unchanged.

*Verified:* red-first public fake-room regressions supplied accessor-backed `x`
and `y` whose getters throw; the old client leaked those exceptions, while the
corrected path neither invoked the accessors nor sent a resume message.
Removing the own-data reads makes both regressions fail. No browser, external
lobby, wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby resume rejects malformed placement containers

`LobbyClient.resume()` assumed its runtime argument was a non-null placement
object and dereferenced `placement.x` and `placement.y` immediately. A
nullish value supplied at the client boundary therefore escaped as a raw
`TypeError` instead of the method's controlled invalid-placement failure,
leaving callers without a stable way to handle malformed resume input.

Resume now rejects null and non-object containers with the existing
`Lobby resume placement is invalid.` error before reading fields or sending a
wire message. Valid placements, finite-coordinate checks and world clamping,
facing normalization, sprite handling and transport lifecycle ownership are
unchanged.

*Verified:* red-first public fake-room regressions supplied `null` and
`undefined` after suspension; the old client threw property-access errors,
while the corrected path returns the controlled placement error without a
resume send. Removing the container guard makes both regressions fail. No
browser, external lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Lobby connect honors synchronous retirement during status delivery

`LobbyClient.connect()` published `connecting` before installing its join
attempt. A synchronous status listener could call `disconnect()` during that
publication, retiring the generation, but `connect()` then continued and
opened a room for the already-closed client. The stale room was eventually
left, but the public lifecycle call still performed an unauthorized transport
join and briefly created a server-side presence entry.

Connect now rechecks its generation and `connecting` status immediately after
the synchronous status handoff, before constructing the join promise. A
listener-retired attempt therefore resolves without opening transport, while
ordinary concurrent connect and explicit reconnect behavior remain unchanged.

*Verified:* a red-first public fake-room regression has a `connecting` status
listener synchronously disconnect the client; the old path called
`joinOrCreate()` and left the stale room, while the corrected path makes zero
join or leave calls and remains `closed`. The focused Lobby client suite passes
83/83. No browser, external lobby, wallet, provider, RPC, proof, signature,
funds or transaction was used.*

### 2026-08-30 — Lobby connected delivery does not retain retired-room handlers

`LobbyClient.#join()` published `connected` before registering the room's state,
error and leave callbacks. A synchronous status listener could disconnect while
that publication was in flight; the join continuation then attached handlers
to the already-retired room, retaining stale lifecycle closures until SDK room
cleanup and allowing unnecessary callbacks to be installed after ownership was
gone.

The join now rechecks the generation and room identity immediately after the
connected status handoff and stops before peer delivery or handler registration
when the room was retired. Normal connected delivery, suspend/reconnect, and
room callback registration remain unchanged.

*Verified:* a red-first public fake-room regression disconnects from a
`connected` status listener; the old path registered all three stale handlers,
while the corrected path leaves the room once and registers none. The focused
Lobby client suite passes 84/84. No browser, external lobby, wallet, provider,
RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Lobby resume normalizes facing before crossing the wire

`LobbyClient.resume()` forwarded its runtime `facing` value directly, even
though `LobbyPresence.resume()` normalizes malformed facings to `down`. A
malformed string or object could therefore cross the Lobby protocol while the
server silently stored a different facing, unlike the already-normalized move
path.

Resume now uses the shared `normalizeFacing()` policy before sending. Valid
facings, coordinate bounds, sprite selection, suspend/resume lifecycle and
transport-closure ownership are unchanged; malformed facing values fall back
to the established `down` value.

*Verified:* red-first public fake-room regressions supplied an unknown string
and a coercible object and observed the old values on the resume wire; the
corrected path sends `down`. Removing the normalizer makes both regressions
fail. Lobby and workspace tests, typechecks, build, invariants and diff
checks pass. No browser, external lobby, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — StreetScene restart cleanup survives shutdown-hook removal failure

`StreetScene.retireWorldOwnership()` removed the previous cycle's Phaser
shutdown hook before cleaning its owned resources. If the framework event
surface threw while removing that hook, the method exited before cleanup and a
defensive same-instance restart stranded the old player, controllers,
listeners, and display objects.

Restart retirement now records a hook-removal failure, still runs the complete
idempotent World cleanup, and then rethrows the original failure. If both hook
removal and cleanup fail, it reports an `AggregateError` after all cleanup
attempts; a stale hook is harmless because cleanup marks the cycle retired.

*Verified:* a red-first public StreetScene lifecycle regression makes shutdown
hook removal throw during repeated `create()` and confirms the old cycle is
fully destroyed while the exact removal error remains observable. Focused
StreetScene tests pass. No browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Remote-avatar layer rolls back failed shutdown-hook registration

`createRemoteAvatarLayer()` created its Phaser layer and then registered the
Scene shutdown hook. If the injected Scene event surface threw synchronously,
construction failed before a `RemoteAvatarLayer` handle was returned, leaving
the display-list layer orphaned with no way for the caller to destroy it.

The factory now treats the layer as owned while installing the lifecycle hook.
Registration failure immediately attempts layer teardown, preserves the
original registration error, and leaves normal shutdown, source subscription,
avatar ownership, and idempotent destruction unchanged.

*Verified:* a red-first public World regression injects a throwing shutdown
listener registration and confirms the exact error is preserved while the
created layer is destroyed once. Focused remote-avatar tests pass. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room exit rolls back failed state publication

`FixedRoomController.leave()` relinquished room ownership and completed the
presentation exit before publishing its outside snapshot. If the synchronous
`onChange` renderer threw, the controller stayed outside while the failed
transition could not be retried: a later exit update was ignored and no
authoritative completion could be delivered.

Exit publication now compensates the presentation and restores the prior room
state when delivery fails, while preserving the original publication error. A
reentrant destroy or transition remains authoritative, and a later explicit
exit can retry after the renderer recovers.

*Verified:* a red-first public World regression makes the first fixed-room
exit state publication throw; the old path left the controller outside and
blocked retry, while the corrected path re-enters for compensation, preserves
the exact error, and completes the second exit. Focused fixed-room tests pass
61/61. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Lobby resume uses the server's bounded placement policy

`LobbyClient.resume()` validated that coordinates were finite and rounded them,
but did not apply the server's `WORLD_LIMIT` clamp used by `LobbyPresence` and
by `updatePosition()`. A finite out-of-bounds resume therefore sent a placement
such as `(9192, -9192)` while the server stored `(8192, -8192)`, leaving the
client's reconnect handoff inconsistent with authoritative presence state.

Resume now runs both coordinates through the shared finite-round-and-clamp
policy before sending them. Invalid values still throw the existing resume
placement error; in-bounds placement, facing, sprite and transport-closure
ownership are unchanged.

*Verified:* a red-first public fake-room regression requested an out-of-bounds
resume and observed the old unbounded wire payload; the corrected path sends
`(WORLD_LIMIT, -WORLD_LIMIT)`. The focused resume test and mutation check pass.
No browser, external lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Fixed-room entry rolls back failed state publication

`createFixedRoomController.enter()` committed `inRoom = true` and completed
the presentation handoff before publishing its first state snapshot. If the
synchronous `onChange` renderer threw, entry surfaced an error but left the
controller and presentation inside the room; a later `enter()` became a no-op,
so the failed transition could not be retried coherently.

Entry publication now compensates the presentation and restores outside state
when delivery fails, while preserving the original publication error. A
reentrant destroy or prior lifecycle transition remains authoritative, and a
later explicit entry can retry after the renderer recovers.

*Verified:* a red-first public World regression makes the first fixed-room
state publication throw; the old path retained `inRoom` and blocked retry,
while the corrected path calls presentation exit once, preserves the exact
error, and successfully re-enters. Focused fixed-room tests pass 60/60. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Lobby startup cleans up after bound-port inspection failure

`startPresenceServer({ port: 0 })` successfully opened a listener and then
read the transport's bound address. If that inspection returned a malformed
or unavailable value, the function threw without closing the already-listening
server, leaving an unreachable process-owned socket behind and making retries
leak resources or fail with an occupied port.

Startup now shuts down the just-bound server when bound-port inspection fails,
while preserving the original inspection error. Normal ephemeral-port
reporting, explicit ports, and consecutive-port bind failure cleanup are
unchanged.

*Verified:* a red-first public Lobby server regression forced the bound address
to be invalid after listen; the old path made zero shutdown calls while the
corrected path shuts down exactly once and preserves the exact error. Focused
server tests pass. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — Lobby port retry ranges stay inside the TCP ceiling

`startPresenceServer()` validated the requested base port and the number of
retry attempts independently, then added the attempt offset without checking
the resulting port. If the final valid port was occupied — for example,
`port: 65535, portAttempts: 2` — startup attempted `65536` and leaked the
platform's invalid-port error instead of rejecting the impossible retry plan
before binding.

Startup now rejects any retry range whose highest candidate exceeds `65535`,
before CORS or transport setup. Valid explicit ports, port zero, and
consecutive fallback ranges that remain within the TCP port space are
unchanged.

*Verified:* a red-first public server-options regression makes the mocked
`65535` bind return `EADDRINUSE`; the old loop then calls `listen(65536)`, while
the corrected path returns `Lobby port retry range exceeds 65535.` without a
second bind. The focused Lobby server configuration suite passes 4 tests. No
browser, external lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Remote-avatar layer setup retains the Phaser layer on depth failure

`createRemoteAvatarLayer()` created its Phaser layer and immediately called
`setDepth(9)` before any cleanup owner could reach that layer. A synchronous
Phaser setup failure therefore threw from construction while leaving an
orphaned layer in the display list; the caller had no returned handle with
which to recover it.

The factory now treats the layer as owned immediately after creation. If the
initial depth setup throws, it attempts to destroy that layer, preserves the
original setup error, and leaves normal subscription, avatar ownership, and
layer teardown behavior unchanged.

*Verified:* a red-first public World regression injects a depth setter that
throws and confirms the exact error is preserved while the created layer is
destroyed once. Focused remote-avatar tests pass. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room render projection fails closed on malformed station snapshots

`fixedRoomStationPresentations()` previously called `.find()` directly on the
controller state's `stations` field. A malformed runtime state with a null
snapshot list (or a null entry) therefore threw during the Phaser-free render
projection instead of rendering configured stations as locked. A bad state
could consequently take down the World render path before the controller had a
chance to recover or replace it.

The projection now treats a non-array snapshot list as empty and ignores null
or non-object entries, preserving the configured station labels and locked
status. Valid controller snapshots and highlighting behavior are unchanged.

*Verified:* a red-first public World regression supplied both a null station
list and a null station entry; the old projection threw while the corrected
projection returns one locked presentation per configured station. Focused
fixed-room tests pass. No browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Backend listener cleanup consumes close failures

When `listenBackendServer()` discovered that a bound transport exposed no TCP
address, it attempted to close the server but attached only a `finally`
handler. A close rejection therefore escaped as an unhandled rejection even
though startup already had its authoritative invalid-address failure.

The cleanup rejection is now consumed while the same generic invalid-address
startup error is preserved. Successful cleanup and normal bind/error paths are
unchanged.

*Verified:* a public listener regression injects a close callback failure on
the invalid-address path and observes the old unhandled rejection. The
corrected path emits no unhandled rejection and retains the startup error;
Backend server tests pass 28 tests. No browser, provider, RPC, wallet, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Remote avatar updates retain the last rendered snapshot after failure

`createRemoteAvatarLayer.render()` previously committed the next peer snapshot
even when an existing avatar's position or visual presentation setter threw.
If no later lobby update arrived, the retained World map claimed the new pose
was rendered while the Phaser sprite still showed the previous pose, so the
failed update had no retry opportunity and later movement classification could
be wrong.

Existing-avatar update failures now retain that peer's last successfully
rendered snapshot while preserving the error. A later authoritative source
publication retries from the old pose; successful updates, first-construction
ownership, removal retry and teardown behavior are unchanged.

*Verified:* a red-first public World regression makes an existing sprite's
position setter throw for one changed snapshot; the old layer retained the
unrendered coordinates, while the corrected layer retains the prior snapshot
and preserves the exact error. Focused remote-avatar tests pass 18/18. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Backend shutdown registration rolls back partial signal setup

`registerBackendShutdown()` registered `SIGTERM` before `SIGINT` without a
rollback boundary. If the second lifecycle registration threw, the function
rejected while leaving the first signal hook installed, so a later retry could
invoke a stale shutdown callback.

Registration now detaches all previously installed hooks before propagating a
registration error. Normal two-signal setup, idempotent shutdown and explicit
disposal are unchanged.

*Verified:* a public shutdown-lifecycle regression makes `SIGINT` registration
throw after `SIGTERM` succeeds. The old path leaves one hook; the corrected
path preserves the exact error and leaves no hooks. Backend server tests pass
27 tests. No browser, provider, RPC, wallet, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Tiled property records fail closed without invoking accessors

`flattenProperties()` previously read each raw Tiled property's `name` and
`value` through ordinary property access. A malformed or hostile runtime
record with an accessor-backed field could therefore throw during map
decoding, aborting the whole object layer instead of being skipped as the
decoder contract promises.

The flattener now accepts only own data descriptors for both fields. Missing,
inherited and accessor-backed records are skipped without invoking getters;
valid Tiled records, duplicate-name last-write behavior, null-prototype
output, and non-array container handling are unchanged.

*Verified:* a red-first public World regression supplied getter-backed `name`
and `value` fields that throw if read; the old decoder invoked the getter and
failed, while the corrected decoder returns an empty record and records zero
getter reads. Focused Tiled-property tests pass 9/9. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Backend listener setup releases hooks after synchronous bind failure

`listenBackendServer()` installed its `error` and `listening` handlers before
calling Node's `server.listen()`. A synchronous transport throw rejected the
startup promise but left both handlers attached, so a later retry on the same
server could invoke stale startup callbacks and retain the failed attempt.

The bind call now removes both startup handlers before propagating a
synchronous error. Normal asynchronous bind errors, successful listening and
the existing close behavior are unchanged.

*Verified:* a public listener regression makes an injected `server.listen()`
throw synchronously and checks that the rejection preserves the exact error
while no new `error` or `listening` hooks remain. The old path failed with one
stale hook; the corrected Backend server suite passes 25 tests. No browser,
provider, RPC, wallet, proof, signature, funds or transaction was used.*

### 2026-08-30 — Street tile observers retain retryable ownership after failure

`StreetScene.reportTile()` rolled back its `lastTile` sentinel when the door
trigger failed, but an exception from the injected `onTileChanged` observer
escaped after the sentinel was committed. A movement/presence handoff failure
could therefore make the player remain on a tile that the Scene would never
report again.

The observer handoff now rolls back only its own sentinel when it fails. A
nested report or Scene teardown that has already taken ownership remains
authoritative, and the original observer error is preserved so the same tile
can be retried after the external consumer recovers.

*Verified:* a public StreetScene regression makes the first tile observer call
throw; the old path retained `{x: 0, y: 0}` and suppressed the retry, while the
corrected path restores `{-1, -1}` and successfully reports the same tile on
the next call. Focused StreetScene lifecycle tests pass 26/26. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio entry rolls back failed semantic announcement

`createAvatarStudioController.enter()` published the admitted Studio state and
then announced `avatar-studio:entered` without treating the event bus as an
external lifecycle boundary. If a synchronous listener threw, entry surfaced an
error but left `inRoom = true` and the presentation entered; a later `enter()`
was a no-op, so the failed transition could not be retried coherently.

The announcement now compensates the presentation and restores outside state
when delivery fails, while preserving the original announcement error. A
reentrant destroy or prior lifecycle transition remains authoritative, and a
later explicit enter can retry after the listener recovers.

*Verified:* a public regression makes the first `avatar-studio:entered`
announcement throw; the old path retained `inRoom` and blocked retry, while the
corrected path calls presentation exit once, preserves the exact error, and
successfully re-enters. Focused Avatar Studio tests pass 39/39. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio presentation entry rolls back partial handoffs

`createAvatarStudioPresentation.enter()` performed a sequence of external
visibility, physics, bounds and position calls without compensation. If a
later port call threw, earlier calls could leave the player disabled and the
street hidden even though the controller rolled back its logical `inRoom`
state; the next frame then ran street movement against a half-entered world.

Entry now attempts the known street restoration contract after any mid-handoff
failure, preserving the original error and attempting every restoration action
so a secondary port failure cannot skip the remaining repairs. A failed entry
remains retryable once the external port recovers.

*Verified:* a public presentation-port regression fails on the old path after
`setWorldBounds` throws, leaving body/visibility state partially entered; the
corrected path restores body, visibility, street bounds and position while
preserving the exact error. Focused Avatar Studio tests pass 38/38. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Financial HUD pending state retains every mounted owner

`BankPanel` and `ExchangePanel` each wrote the global `hud:pending` count as
a last-writer boolean. When one panel was busy and another mounted panel
unmounted, the idle panel's cleanup published `0` and hid the still-active
wallet handoff.

Financial panels now own one pending marker per Shell bus. The HUD count is
the number of currently busy mounted panels; changing a panel's stage keeps
its marker, and unmounting removes only that panel's marker. Single-panel
cleanup and wallet-operation state semantics are unchanged.

*Verified:* a public jsdom regression mounts two Bank panels on one Shell bus,
enters wallet approval in one, then unmounts the idle one. The old last-writer
path reports `0`; the corrected path retains `1` until the signing panel
settles or unmounts. The focused Bank/Exchange lifecycle files pass 3/3 tests.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Avatar Studio entry rolls back failed state publication

`createAvatarStudioController.enter()` committed `inRoom = true` and ran the
presentation handoff before publishing its state. If the synchronous
`onChange` renderer threw, the controller stayed in the Studio even though the
entry transition had failed; a later `enter()` became a no-op and the player
could remain in a partially admitted room.

Entry publication now rolls the controller back to outside and invokes the
existing presentation exit compensation when delivery fails. The original
publication error remains authoritative, and a later enter can retry the
normal handoff.

*Verified:* a public Avatar Studio regression makes the first state publication
throw; the old path retained `inRoom`, while the corrected path exits once,
preserves the exact error, and successfully re-enters after delivery recovers.
Focused Avatar Studio tests pass 37/37. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Bridge saved-quote resume retains its callback owner

`BridgePanel.resumeSavedQuote()` was the only public panel transition that
called another transition through `this`. A caller that extracted the method
for an event callback therefore lost the machine receiver after the refresh
and threw before the account-bound shield preflight could run.

The preflight transition is now a machine-owned closure, and resume calls that
closure directly. The extracted callback remains bound to the same panel
state, while refresh, account matching, plan validation and all existing close
ownership remain unchanged.

*Verified:* a public regression opens a saved quote, extracts
`resumeSavedQuote`, and completes the refresh plus preflight through the
extracted callback. The old path throws a receiver `TypeError`; the corrected
Bridge machine suite passes 49 tests. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar selection delivery must roll back the rendered sprite

`StreetScene` applied the new avatar sprite before delivering the existing
`avatar:selected` event to the Shell. The World selection rolls its logical
key back when that external delivery throws, but the Phaser visual stayed on
the new sprite. A synchronous Shell failure could therefore leave the Studio
reporting cosy `avatar-1` while the player was visibly wearing fighting
`avatar-9`; a later toggle started from the wrong visual state.

The Scene now tracks the rendered sprite and application revision, and rolls
the visual back when the same selection's delivery fails. A newer reentrant
selection is left authoritative, and a rollback failure never masks the
original delivery error.

*Verified:* a public lifecycle regression first observed logical `avatar-1`
with rendered `avatar-9` after a post-apply delivery failure; the corrected
path reapplies `avatar-1` and preserves the original error. Focused StreetScene
tests pass 25/25. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — Street tile observers must not outlive Scene ownership

`StreetScene.reportTile()` delivered the door transition first and then called
its injected `onTileChanged` observer without checking whether that synchronous
door delivery had retired the Scene. A Shell listener can destroy the Scene
while handling `building:entered` or another door event; the stale tile
observer then ran after World ownership was gone and could update a retired
movement/presence consumer.

The Scene now rechecks its cleanup ownership after `doors.update()` and skips
the external tile observer when the cycle was retired. Door rollback and the
normal observer ordering are unchanged.

*Verified:* a red-first public Scene regression supplied a door stub that
retired the Scene synchronously; the old path called `onTileChanged` once and
the corrected path calls it zero times. The focused StreetScene lifecycle
suite passes 24/24 after the guard. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Lobby server must report an ephemeral bound port

`startPresenceServer({ port: 0 })` asked Node for an ephemeral listener but
returned the requested value `0` in both `PresenceServer.port` and its
`endpoint`. A caller following the public server contract could therefore
receive `ws://127.0.0.1:0` (or `ws://localhost:0`) even though the server was
listening on another port; the next client connection failed before any lobby
protocol work. This was a server lifecycle/configuration boundary, not a
client payload policy.

When the requested port is zero, startup now reads the actual numeric port from
the transport's bound HTTP server and exposes that value in both fields. A
missing, non-numeric, or out-of-range bound address fails startup instead of
advertising an unusable endpoint; explicit ports and consecutive-port fallback
are unchanged.

*Verified:* a red-first public server-options regression started the server on
port zero and observed `server.port === 0`; the corrected test requires a
positive reported port and endpoint-port parity. The focused Lobby server
configuration suite passes 3/3. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Production capability checks retire with their gate

`WalletCapabilityGate` started capability detection without an owner signal.
If the wallet session disconnected or changed network while that check was
pending, the gate unmounted but the capability operation remained live beyond
the admission it belonged to. That could leave wallet work running after the
connected financial surface had been retired.

The gate now creates one `AbortController` for each mounted detection attempt,
passes its signal to `connect.connect`, and aborts it during cleanup. This is
abort-only: it does not call `disconnect` during cleanup, so React StrictMode's
probe does not invalidate a still-live flow and start another wallet query.
The retired result cannot be consumed by a mounted capability gate, presence
owner, or financial surface.

*Verified:* a red-first `ProductionRoot` regression used a deferred capability
operation, retired the connected session, and observed that the old gate passed
no signal. The corrected path receives a live signal and aborts it when the
session returns to the wallet gate. Focused ProductionRoot tests pass 10/10;
no browser, wallet prompt, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Remote avatar visual construction retains partial ownership

`createRemoteAvatarLayer` added a new sprite to the Phaser layer and then
constructed its visual controller before recording the sprite in `avatars`.
Because the visual controller renders immediately, a setter failure during
that constructor left the sprite in the Phaser layer with no cleanup or retry
owner; the next snapshot created a second sprite for the same peer.
This is distinct from the existing post-registration `updateAvatar()` guard:
that guard cannot run when the visual controller constructor itself throws.

New sprites are now registered before visual-controller construction. A failed
initial presentation retains the partial avatar for a later retry and for
explicit layer teardown; successful existing-avatar updates, removal retry and
aggregate cleanup behavior are unchanged.

*Verified:* a red-first public regression makes the first new sprite's
`setTexture` throw, republishes the same peer, and asserts the old path creates
a second sprite while leaving the first unowned. The corrected path retries on
the original sprite and destroys it exactly once at layer teardown. Removing
the early ownership registration fails the regression. Remote-avatar focused
tests, full World tests, World typecheck, invariants and diff checks are
recorded on this candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Exchange panels use the admitted route authority

`VisitLayer` admitted an Exchange station against its supplied route register,
but `ExchangePanel` did not accept or forward that register when it created
its owned machine. A custom composition could therefore pass the station gate
with one route authority while the Exchange panel opened using the canonical
global register.

`ExchangePanel` now accepts the route register and gives it to the owned
Exchange machine; the station wiring forwards the same register used for
admission. Injected machines retain their own authority, and the canonical
production register and financial handoff are unchanged.

*Verified:* a red-first public Exchange render supplied a register that
disabled `exchange.swap`; the old component rendered the balance form instead
of the existing fail-closed door. The corrected component renders
`unapproved-route` and no balance form. ExchangePanel and Visit tests pass;
typecheck, build, invariants and diff hygiene pass. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Web route records reject accessor-backed fields

The route resolver checked only whether each `RouteGrade` key was present as
an own property. An untrusted route record could therefore define an accessor
for `route` or another approval field; resolving the route then invoked that
accessor, allowing a throw to escape the fail-closed door decision.

Route records now require every field to be an own data property before any
route or building lookup reads it. Authored register entries and ordinary
custom fixtures retain their behavior; inherited and accessor-backed records
resolve as absent route data.

*Verified:* a red-first public routes regression supplied all required fields
but made `route` an accessor that throws. The old resolver escaped the error;
the corrected resolver returns the existing locked unknown-route decision
without invoking the accessor. Focused route tests pass 34/34. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Exchange reviews use their supplied route authority

`createExchangePanel()` accepted a caller-supplied route register for the
Exchange door, but its prepared review derived disclosures from the global
canonical register instead. A custom composition could therefore open using
one route authority while showing the disclosure belonging to another, and
the commit surface would not describe the route that admitted the panel.

Swap review construction now passes the same register used for door admission
into disclosure derivation. The canonical register and financial handoff are
unchanged; custom registers remain an explicit test/composition seam.

*Verified:* a red-first public Exchange-machine regression supplied a valid
register with a distinct Exchange disclosure. The old review showed the global
disclosure; the corrected review shows the supplied one. Removing the register
argument reproduces the failure. Exchange tests pass 29/29. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Bridge disclosures use their supplied route authority

`VisitLayer` admitted Bridge stations against its supplied route register, but
`BridgePanel` always read the global register when rendering the public bridge
disclosure. A custom composition could therefore admit a station with one
route authority while showing copy from another authority.

`BridgePanel` now accepts and uses the same register for both disclosure
surfaces and passes it into the nested shield Bank. Menu and station wiring
forward the register from `VisitLayer`; the canonical production register and
bridge behavior are unchanged.

*Verified:* a red-first public Bridge render supplied a valid register with a
distinct `bridge.deposit` disclosure. The old panel rendered the canonical
copy; the corrected panel renders the supplied copy. Removing either
disclosure argument reproduces the regression. Bridge and Visit tests pass
25/25. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Fixed-room input restoration cannot resume a retired transition

`createFixedRoomController.enter()` and `leave()` crossed the injected input
gate's synchronous `resume()` callback without rechecking controller
ownership. A gate callback that destroyed the controller could therefore still
invoke the presentation `onEnter`/`onExit` callback; a callback that re-entered
during exit could run the stale exit presentation as well. The controller's
state was already changed, so the stale callback described a transition that
no longer belonged to the active lifecycle.

Both transitions now recheck that the controller is still live and still owns
the expected room state immediately after input restoration. A retired or
re-entered transition stops before presentation callbacks; ordinary entry and
exit ordering is unchanged.

*Verified:* red-first public fixed-room regressions make input `resume()`
destroy the controller during entry and exit, and make it synchronously
re-enter during exit. Before the guard, stale `onEnter`/`onExit` callbacks ran;
after the guard, none runs for the retired turn. Removing either lifecycle
guard fails its corresponding regression. The focused fixed-room suite and
World package gates are recorded on the candidate. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Kenney runtime texture creation must recover from a partial pair

`createKenneyRuntimeTextures()` treated the `tiles` texture as the complete
runtime-resource sentinel. If `tiles` was created but the `door` canvas
allocation returned null or threw, the function left `tiles` registered and
failed. A later scene creation then returned early on the existing `tiles`
key, leaving the required door texture absent.

The runtime texture factory now owns the two keys as one pair. It removes a
stale half-pair before retrying, cleans up anything registered by a failed
allocation/render attempt, and returns early only when both textures exist.
The original creation error remains authoritative; normal complete-pair reuse
and all atlas geometry are unchanged.

*Verified:* a red-first public fake-texture regression made the door allocation
fail after tiles had registered; the old factory left tiles behind and could
not recover on the next call. The corrected test confirms both keys are absent
after failure, then confirms a retry creates both from a stale half-pair. The
package-focused test and mutation of the cleanup/pair guards fail as expected;
World typecheck, tests, invariants and diff checks are recorded on this
candidate. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Avatar outfit selection rejects forged runtime keys

The exported World outfit selection trusted its TypeScript-only
`AvatarSpriteKey` parameter. An untyped caller could therefore select an
arbitrary string, publish it through `avatar:selected`, and leave the local
selection authority in a state that the World avatar renderer cannot resolve.

`select()` now validates the key against the World-owned catalog and returns
`false` without changing state or emitting when the runtime value is unknown.
Valid cosy/fighting selections, toggle pairing, event delivery and rollback on
delivery failure are unchanged.

*Verified:* a red-first public regression cast `not-an-avatar` through the
selection seam after selecting `avatar-2`; the old selection changed authority
and emitted the forged key, while the corrected selection remains `avatar-2`
and emits nothing. Removing the runtime guard fails the regression. World
focused/full tests, typecheck, invariants and diff checks are recorded on this
candidate. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Avatar Studio presentation blocks transitions during teardown

`createAvatarStudioPresentation.destroy()` marked the presentation destroyed
only after calling the consumer-owned `port.destroyStudio()`. If that callback
re-entered `enter()` or `exit()` synchronously, the presentation started a new
transition while teardown was still in flight and could mutate already-retired
Phaser state.

Presentation transitions now treat the in-flight destroy operation as retired
ownership and return immediately while `destroying` is true. The existing
post-step destroyed guards, retry after a failed destroy, and normal entry/exit
ordering are unchanged.

*Verified:* a red-first public regression made `destroyStudio()` synchronously
call both an extracted `enter()` and `exit()` transition; before the guard the
port received transition calls during teardown, while after it received none.
Removing the `destroying` guard fails the regression. Avatar Studio focused and
full World tests, World typecheck, invariants and diff checks are recorded on
this candidate. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Exchange pending state reaches the world HUD

`ExchangePanel` drove private swap preparation and wallet submission without
publishing the shared `hud:pending` event. The Bank panel already publishes
that event, and the shared contract describes it as the ambient in-flight
operation indicator, so a swap could be awaiting wallet approval while the
world HUD continued to report no pending action.

The Exchange panel now publishes count `1` while its flow is `preparing` or
`submitting`, and emits count `0` when the panel unmounts. The machine's
financial state, wallet handoff and receipt behavior are unchanged.

*Verified:* a red-first jsdom regression mounted an Exchange panel with a
deferred confirmation, entered the wallet approval stage, and observed that
the old panel emitted no pending count. The corrected lifecycle test observes
`1`, unmounts before confirmation settles, observes the cleanup `0`, and then
allows the original confirmation to settle. No browser, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room destruction retries failed cleanup ownership

`createFixedRoomController().destroy()` marked the controller permanently
destroyed before teardown. If a Shell-listener stop callback or input
restoration threw, a later `destroy()` became a no-op even though that resource
could still be attached or the keyboard could still be suspended.

Destruction now retires the controller immediately but retains only failed
cleanup callbacks for a later retry. Successful listener removal and input
restoration are not repeated; reentrant destruction during one attempt is
ignored. The first cleanup error remains unchanged, multiple errors remain an
`AggregateError`, and successful destruction remains idempotent.

*Verified:* red-first public regressions make a listener stop and input
restoration fail once; the old controller cannot clean them on a second
`destroy()`, while the corrected controller retries only those failures and
completes cleanup. World tests pass 24 files / 332 tests; World typecheck and
invariants pass. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — Web event payload snapshots reject accessors at the boundary

The Web event bus snapshotter previously read payload members through normal
property access before entering its subscriber-isolation guard. An
accessor-backed or hostile Proxy payload could therefore throw out of
`emit()`, interrupting the producer before any subscriber ran.

Event snapshots now traverse own data descriptors only. If snapshotting finds
an accessor or another malformed object boundary, the event is dropped and
`emit()` returns without invoking subscribers. Plain records, arrays, cycles,
listener generation ownership and handler-error isolation are unchanged.

*Verified:* a red-first public bus regression supplied an accessor-backed
`hud:pending` payload whose getter threw; the old bus escaped the exception.
The corrected bus drops it without invoking the subscriber. Focused event-bus
tests pass 14/14. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — Fixed-room Scene ownership rolls back after controller entry failure

`StreetScene` provisionally set `activeRoom` before invoking a fixed-room
controller's `enter()`. If that controller entry threw, its own state rolled
back to outside, but the Scene retained the building as active and subsequent
updates could follow a stale interior ownership path.

The Scene now clears that provisional `activeRoom` only when the same building
handoff fails and no nested transition or teardown has replaced the ownership.
The original error and the controller's retryable entry behavior are
preserved; successful entry ordering is unchanged.

*Verified:* a red-first public StreetScene regression makes fixed-room
controller entry throw from a door transition and observes the old `activeRoom`
leak. The corrected Scene clears it while preserving the exact error. World
tests pass 24 files / 331 tests; World typecheck and invariants pass. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Avatar Studio Scene mode remains retryable after exit failure

`StreetScene.exitAvatarStudioRoom()` cleared the Scene's
`avatarStudioActive` flag before invoking the presentation exit handoff. If
that injected presentation callback threw, the Avatar Studio controller
restored its own `inRoom` state for retry, but the Scene remained in street
mode and subsequent updates followed the wrong movement path.

The Scene now restores its Studio mode flag when presentation exit fails,
unless the callback already retired the Scene. The original error remains
unchanged, the controller's retryable exit behavior is preserved, and a later
exit completes normally.

*Verified:* a red-first public StreetScene regression makes presentation exit
throw, then confirms the controller and Scene both remain in Studio mode; the
old path left `avatarStudioActive` false. The next exit succeeds and both
return outside. World tests pass 24 files / 330 tests; World typecheck and
invariants pass. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — Avatar Studio Scene mode rolls back after presentation failure

`StreetScene.enterAvatarStudioRoom()` marked the Scene's
`avatarStudioActive` flag before invoking the presentation handoff. If that
injected presentation callback threw, the Avatar Studio controller rolled back
to outside state but the Scene retained Studio mode, so later updates followed
the Studio movement path for a controller that was not in the Studio.

The Scene now clears its mode flag when presentation entry fails, preserving
the original error and allowing the controller's retryable entry transition to
run normally on the next attempt. Successful entry ordering and ordinary
teardown are unchanged.

*Verified:* a red-first public StreetScene regression makes the presentation
entry callback throw, then confirms the controller and Scene both remain
outside; the old path left `avatarStudioActive` true. The retry then succeeds
and both report Studio mode. World tests pass 24 files / 329 tests; World
typecheck and invariants pass. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Bank HUD pending state retires on panel unmount

`BankPanel` published `hud:pending` while preparing or submitting, but had no
cleanup publication. Closing the room during a wallet handoff could therefore
leave the World HUD showing a pending action forever: the machine may settle
later, but the unmounted panel cannot publish its final state.

The panel now emits a zero pending count when its shell-bus lifetime ends,
including a bus replacement. State-driven publications and the submission
itself are unchanged.

*Verified:* a red-first jsdom regression mounted a Bank panel, entered the
wallet approval stage, unmounted it before confirmation settled, and observed
the old last HUD count remain `1`. The corrected lifecycle test observes the
clearing `0` and then lets the original confirmation settle. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby movement converges to the server's bounded coordinates

`LobbyClient.updatePosition()` rounded finite coordinates but did not apply the
server's `WORLD_LIMIT` clamp. An out-of-bounds finite request therefore became
the client's desired position while the server stored its clamped position;
reconciliation could never observe equality and retried that move forever.

Movement now uses the shared finite-round-and-clamp policy before storing or
sending desired state. Nonfinite values remain ignored, valid in-bounds values
and facing normalization are unchanged, and the server remains authoritative.

*Verified:* a red-first public Lobby regression requested `(9000, -9000)` and
observed the old client send those values, then fail to converge against the
server's `(WORLD_LIMIT, -WORLD_LIMIT)` state. The corrected client sends the
bounded placement and clears desired state after the matching server snapshot.
Lobby tests pass 11 files / 250 tests; Lobby typecheck and invariants pass. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Avatar visual state and target rendering stay transactional

`createAvatarVisualController.present()` replaced its logical pose before
calling the Phaser target. If a target setter partially mutated the sprite and
then threw, the controller exposed the failed pose while its render cache still
held the prior key. Returning to that prior pose could therefore skip rendering
and leave the sprite with the partial failed mutation.

Pose presentation now renders the candidate first and commits logical state
only after success. A failed target call retains the last successful state and
invalidates the cache so a later retry reapplies the target even when its pose
key matches the previous successful key. Normal pose deduplication and
animation cadence are unchanged.

*Verified:* a red-first public World regression makes `setOrigin` throw after
the texture changes during a new pose, then returns to the original pose. The
old controller reports the new sprite and skips the repair; the corrected
controller preserves the old state and reapplies the original texture.
Avatar-visual tests pass 13/13. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Room resolution checks structured panel identity

`resolveRoom()` previously trusted that a panel stored under a building key
belonged to that building. A miswired or forged structured descriptor could
therefore put the Bank panel under Exchange (or another building), passing the
door and rendering the wrong financial route.

Room resolution now requires structured panel descriptors to carry an own data
`building` field matching the requested key. Generic non-object test seams
remain supported, while mismatched or accessor-backed descriptor identities
fail closed as unbuilt.

*Verified:* the red-first resolver regression placed the authored Bank
descriptor under the Exchange key; the old resolver returned `panel`, while
the corrected resolver returns the existing `unbuilt` result. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Visit listeners retire stale World generations

`VisitController.listen()` previously left every earlier World subscription
authoritative when the same controller was rebound. A replaced World bus could
therefore open or close a visit after a newer bus had become current, and a
stale cleanup could also restore controls for the wrong listener generation.

Each listener attachment now owns a generation. Older handlers become inert as
soon as a new attachment is made, and cleanup restores Shell-owned controls
only for the still-current attachment; each cleanup remains responsible for
detaching its own handlers.

*Verified:* a red-first public Visit regression rebound one controller from a
first World bus to a current bus, then emitted an entry on the retired bus. The
old controller opened Bank, while the corrected controller stays outside until
the current bus opens Exchange. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio tile delivery remains retryable after failure

`StreetScene.reportAvatarStudioTile()` committed its `lastTile` sentinel
before delegating to the Studio controller. If synchronous figure selection or
presentation delivery threw, the player remained on that tile but subsequent
frames treated it as already handled, so the selection could never retry.

Studio tile reporting now rolls back only its own sentinel when the controller
throws; a nested report that has already taken a newer sentinel remains
authoritative. Normal tile de-duplication and Studio lifecycle behavior are
unchanged.

*Verified:* a red-first public StreetScene regression makes the first
`avatar:selected` delivery throw on a figure tile, observes the old tile
sentinel retained, then retries the same tile and confirms the selection
completes. The corrected lifecycle suite passes 20/20; the full World suite,
typecheck and invariant evidence are recorded on the candidate. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio exit presentation failure remains retryable

`createAvatarStudioController.leave()` cleared Studio ownership before invoking
the consumer-owned `onExit` callback. If that callback threw, the original
error was propagated but the controller stayed outside the Studio, so a later
exit retry became a no-op and could never complete the presentation handoff.

Studio exit now restores the prior room ownership and highlighted figure when
`onExit` throws, unless that callback synchronously destroyed or re-entered the
controller. The existing post-callback ownership guard still suppresses stale
publication/events, and normal exit ordering is unchanged.

*Verified:* a red-first public Avatar Studio regression makes the first
`onExit` callback throw, observes the old controller outside the Studio, then
retries the same exit and confirms no second callback. The corrected path
preserves the exact original error, keeps Studio ownership for retry, and
completes the second exit. Focused Avatar Studio tests pass 35/35. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Bank mode configuration is snapshotted at construction

`createBankPanel()` previously retained the caller's `allowedModes` array
directly after validating it. A later mutation of that array could therefore
rewrite which financial route the existing panel accepted, even though its
machine and review state had already been constructed.

The validated mode list is now copied and frozen at construction. The panel's
mode authority cannot be changed through the caller's array; explicit panel
recreation remains the way to supply a new mode set.

*Verified:* a red-first Bank regression appended `transfer` to a panel created
with only `shield`; the old machine then accepted the new route, while the
corrected machine remains on the original Shield authority. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room exit presentation failure remains retryable

`FixedRoomController.leave()` relinquished room ownership before invoking the
consumer-owned `onExit` callback. If that callback threw, the original error
was propagated but the controller stayed outside the room, so a later exit
retry became a no-op and could never complete the presentation handoff.

Exit now restores the prior room ownership, control owner, highlighted station
and approach-arm state when `onExit` throws, unless that callback synchronously
destroyed or re-entered the controller. The existing post-callback ownership
guard still suppresses stale publication/events, and normal exit ordering is
unchanged.

*Verified:* a red-first public fixed-room regression makes the first `onExit`
callback throw, observes the old controller outside the room, then retries the
same exit and confirms no second callback. The corrected path preserves the
exact original error, keeps the room owned for retry, and completes the second
exit. Focused fixed-room tests pass 54/54. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Batch intent validation ignores accessor-backed fields

`createBatchAccumulator().accept()` previously read candidate intent fields
through ordinary property access and spread the candidate after validation. An
accessor-backed or proxy-shaped intent could therefore execute a getter or
throw out of the accumulator instead of returning its typed rejection, at the
financial boundary that must exclude arbitrary protocol-shaped input.

The parser now reads only own data descriptors, captures those values into a
fresh accepted record, and maps descriptor/proxy failures to the existing
`not-an-intent` rejection. Plain game intents retain their existing shape,
amount, route-mixing and batch-limit behavior.

*Verified:* the red-first accumulator regression supplied an enumerable
accessor-backed recipient whose getter threw; the old parser escaped the
exception and invoked the getter, while the corrected parser returns
`not-an-intent` without invoking it. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Lobby config resolution fails closed for malformed containers

`resolveRoomConfig()` assumed its operator override argument was always a
non-null object. A runtime `null` supplied through composition therefore threw
before the lobby could resolve its bounded defaults, turning a malformed
configuration into a startup failure rather than a safe configuration.

Resolution now treats null and non-object override containers as no overrides.
Valid operator fields, numeric clamps, sprite/default selection and the frozen
resolved configuration are unchanged; this does not widen any lobby policy.

*Verified:* a red-first public Lobby regression supplied a null override and
observed the old null dereference; the corrected resolver returns the frozen
default configuration. The focused Lobby privacy suite passes 17 tests. No
browser, external lobby, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Production capability admission validates connected state shape

`capabilityAdmits()` previously admitted any runtime object whose `name` was
`connected`, without checking the capability or registration fields needed to
establish a usable Wallet API verdict. A malformed or inherited connected
record at the Web composition boundary could therefore bypass the production
capability gate and mount the app.

The predicate now reads own data fields only and requires true STRK20 support,
a nonempty wallet API version, a valid registration value, and a matching
`registrationConfirmed` flag. `not-registered` remains an explicit admitted
room. Malformed, inherited or accessor-backed fields fail closed.

*Verified:* red-first production-root regressions supplied a connected record
without capability, with wrong runtime field types, and with all fields
inherited; the old predicate returned true for these shapes, while the
corrected predicate returns false. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Fixed-room entry rolls back after presentation failure

`createFixedRoomController.enter()` resumed input and marked the room owned
before invoking its injected `onEnter` presentation callback. If that callback
threw, the controller remained `inRoom` and a later doorway retry became a
no-op, leaving the failed presentation transition unrecoverable.

Entry now restores the controller's outside state when `onEnter` throws:
`inRoom` is cleared, control returns to World, the highlight is cleared and
station approach arming is reset. The original presentation error is
preserved, input restoration and successful entry ordering are unchanged, and
a later explicit entry retries the callback.

*Verified:* a red-first public World regression makes the first `onEnter`
callback throw, observes the old controller remain inside, then passes after
the rollback and confirms a second entry invokes the callback. Focused fixed
room tests pass 53 tests. No browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Web address identity rejects malformed runtime values

`sameAddress()` used numeric comparison when possible but fell back to raw
string equality on conversion failure. Two identical malformed values such as
`not-hex` were therefore treated as the same account or recipient. That could
weaken Bridge and financial identity checks when a structural caller supplied
runtime data outside the TypeScript address contract.

The comparator now requires both inputs to have the accepted lowercase `0x`
hexadecimal address shape before applying padding-tolerant numeric equality;
malformed, decimal and uppercase-prefix values fail closed. Valid address
spellings and all existing financial validation remain unchanged.

*Verified:* the red-first Web formatting regression observed identical
malformed, decimal and uppercase-prefix values comparing equal on the old
path. The corrected comparator returns false while retaining padded/unpadded
hex equality. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Visit Escape handlers retain their lifecycle owner when extracted

`VisitController.handleEscape()` called `this.dismissLocked()` and
`this.closeSurface()`. A legitimate event or callback consumer that extracted
the public handler before passing it to a key listener therefore lost the
controller receiver and threw instead of closing the active Menu/Station
surface or dismissing a locked door.

The controller now closes over its owned transition functions and publishes
`handleEscape` as a receiver-independent callback. Direct method calls and
the existing visit-layer Escape behavior are unchanged.

*Verified:* the red-first public visit regression extracted
`const handleEscape = controller.handleEscape` after opening a Bank menu; the
old path threw a TypeError reading `closeSurface`, while the corrected path
returns to Game Mode. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby movement normalizes malformed facing before reconciliation

`LobbyClient.updatePosition()` trusted its TypeScript `Facing` parameter at the
runtime boundary. An invalid string or object was sent unchanged, while the
server normalized it to `down`; the client then compared the unnormalized
desired facing with the server's value and retried the same movement forever.

Movement updates now reuse the Lobby policy's `normalizeFacing()` before storing
or sending the desired placement. Valid facings and the existing coordinate,
send-floor and reconciliation behavior are unchanged; malformed runtime input
falls back to the server's established `down` policy.

*Verified:* red-first public Lobby regressions supplied an unknown string and a
coercible object as facing, then published a matching server `down` state. The
old path sent the malformed value and sent again during reconciliation; the
corrected path sends one normalized move and converges. The focused Lobby client
suite passes 71 tests. No browser, World, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Lobby client drops non-finite movement updates

`LobbyClient.updatePosition()` rounded and queued every caller-provided
coordinate without checking finiteness. `NaN` or an infinity therefore crossed
the client-to-server move boundary immediately; because the server rejects
such placements, the desired value remained unconfirmed and reconciliation
would keep retrying malformed movement at the send interval.

The client now ignores updates with non-finite `x` or `y` before changing its
desired placement or scheduling reconciliation. Valid finite coordinates,
server-side bounds/clamping, facing, and send-floor behavior are unchanged;
this is a defensive client boundary and does not widen lobby state.

*Verified:* red-first public Lobby regressions supplied `NaN`, positive infinity
and negative infinity through `updatePosition()`; the old path sent each
malformed `move` payload, while the corrected path sends none and schedules no
retry. The focused Lobby client suite passes 69 tests. No browser, World,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Web room resolution fails closed for malformed panel containers

`resolveRoom()` already rejected inherited panel descriptors, but it assumed
the caller supplied an object for the panel registry. A malformed `null`
registry therefore threw from `hasOwnProperty.call()` while resolving a valid
building, replacing the room decision with an ErrorBoundary surface instead
of the existing unbuilt result.

Room resolution now treats null and non-object registries as empty. Valid
custom registries and the frozen authored registry are unchanged; malformed
containers fail closed to the existing `unbuilt` result after the privacy door
has run.

*Verified:* red-first public resolver regressions supplied `null`, object and
string registry containers. The old resolver threw for `null`; the corrected
resolver returns `unbuilt` for all three. The focused routes suite passes
32/32, and no browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Lobby disconnect publishes peer removal after leave failure

`LobbyClient.disconnect()` retired its local room and identity before awaiting
the SDK's `room.leave(true)`, but published the empty peer snapshot only after
that promise resolved. If transport cleanup rejected, the client was already
closed while peer subscribers retained the last visible avatars indefinitely.

Disconnect now always emits the cleared peer snapshot after attempting room
cleanup, then rethrows the original leave error. Local status and authority
retirement remain immediate, successful cleanup is unchanged, and a failed SDK
leave cannot strand stale World presentation state.

*Verified:* a red-first public Lobby regression connected a fake room, exposed
one peer, and rejected `room.leave(true)`. The old path left the listener's last
snapshot populated; the corrected path delivers `[]` while preserving the
exact rejection. The focused Lobby client suite passes 66 tests. No browser,
World, wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Web route resolvers fail closed for malformed register containers

The Web route gate validated individual `RouteGrade` entries but assumed the
caller supplied an array for the register itself. A malformed public
composition value such as `null`, an object or a string therefore threw from
`.find()`/`.filter()` instead of returning an explicit locked door. In a live
shell this could replace the route decision with an ErrorBoundary surface
rather than preserving fail-closed admission.

`findRoute()` now treats non-array register values as empty, and
`buildingRoutes()` does the same for building-level admission. Canonical and
valid custom arrays are unchanged; malformed containers resolve to the
existing unknown-route/coming-soon locks without invoking route work.

*Verified:* public route regressions supplied `null`, object and string
registers and observed TypeErrors on the old path. The corrected resolver
returns locked decisions for all three and the focused routes suite passes
29/29. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Street door handoffs remain retryable after a failed room entry

`StreetScene.reportTile()` previously committed its `lastTile` sentinel before
delegating a changed street tile to the door trigger. If the room controller's
entry handoff threw, the door trigger restored its own prior occupancy, but the
Scene retained the failed tile. A player who remained on that doorway could
therefore never retry the same entry: later updates were suppressed as a
duplicate tile even though the room was still outside.

The Scene now retains the sentinel during delivery to preserve nested-report
ordering, but rolls back only its own commit when the door handoff throws. A
nested transition or reset that already took ownership is left authoritative;
ordinary door delivery and tile-change callbacks are unchanged.

*Verified:* a red-first public StreetScene regression makes the Bank room entry
throw on the first update while the player remains on the same door tile. The
old path calls `enter()` once and suppresses the second update; the corrected
path retries and completes the second entry. The focused StreetScene lifecycle
suite passes 19 tests. No browser, lobby, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Bank mode tabs use the same route authority as the panel

`BankPanel` passed only the active mode's door into its tab renderer. Every
non-active tab then resolved its lock state against the default privacy
register, so a custom/current route register could show an unapproved mode as
open until the player clicked it. That made the tab presentation disagree with
the machine's actual admission decision.

The Bank view now accepts the route register used by its machine, resolves
every mode tab from that register, and Menu/Station composition forwards the
same register it used for admission. The active mode still uses the machine's
already-resolved door, and the default production register is unchanged.

*Verified:* a red-first static `BankPanel` regression supplied a private
shield route plus an unapproved unshield route and observed the old unshield
tab without its lock marker. The corrected render marks that tab locked.
Focused Bank rendering tests pass 21/21. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room station decoding ignores accessor-backed fields

`normalizeFixedRoomStations()` read Shell-provided station `station`, `label`
and `status` fields through ordinary property access. An accessor-backed field
could therefore execute arbitrary code or throw during synchronous Shell event
delivery instead of being treated as malformed station input.

Station matching and projection now read only own data properties. Accessor or
inherited values fail closed to the authored locked station without invoking a
getter; valid plain station snapshots retain their existing behavior.

*Verified:* a red-first World regression supplied an accessor-backed station id
whose getter threw; the old Shell handler escaped that error, while the
corrected handler ignored the entry, did not invoke the getter and kept the
station locked. The focused fixed-room suite passes 52 tests. No browser,
lobby, wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Published Web station snapshots are immutable

`stationSnapshot()` returned a fresh array but left both the array and each
station entry mutable. A Shell or World-bus consumer could rewrite a status,
label, or entry before another listener observed the same synchronous payload;
the TypeScript readonly event shape did not protect this station-admission
boundary.

The snapshot array and its flat entries are now frozen before publication.
Values remain derived from the current register and capabilities.

*Verified:* a red-first station-snapshot regression observed successful status
and array replacement; the corrected test rejects both and preserves the
available Bank station. The focused station suite passes 25 tests. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Bridge execution status requires string runtime data

`BridgeService.verifyStatusQuote()` required an own `status` property but did
not validate its runtime type. A malformed 1Click response could provide an
object with `toString() => 'SUCCESS'`; `mapStatus()` coerced it, parsed
settlement data, and published a settled status without a provider string.

Status verification now requires the own status field to be a runtime string
before mapping or settlement parsing. Valid provider strings and the existing
unknown-string error path are unchanged; coercible objects fail closed and
cannot update persisted progress.

*Verified:* a red-first Bridge regression supplied a coercible `SUCCESS`
status; the corrected path rejects it and preserves the awaiting-deposit
record. Removing the runtime type guard reproduces the failure. The focused
Bridge suite passes 104 tests. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio presentation retains failed destroy ownership

`createAvatarStudioPresentation().destroy()` marked the presentation retired
before calling its injected `destroyStudio` port. If that port threw part-way
through Scene-owned Phaser cleanup, later Scene cleanup calls returned and the
failed teardown could not be retried.

Presentation destruction now marks ownership retired only after the port
completes successfully, while an in-progress guard prevents synchronous
reentrant `destroy()` calls from recursing. A failed port call remains
retryable; successful destruction remains idempotent.

*Verified:* a red-first Avatar Studio regression makes the first port cleanup
throw; the corrected path retries and succeeds on the second call. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Initial Bridge quotes require own data fields

`BridgeService.createDeposit()` passed the untrusted 1Click quote response to
`assertSignedQuote()`, whose ordinary property access accepted inherited or
accessor-backed signed evidence, executable quote, and route request fields.
The object could then be retained as signed bridge evidence and used for player
instructions.

Signed quote validation now requires own data properties for every required
field Bridge reads, including evidence, quote containers, executable amounts
and deadlines, and route-request fields. Optional memo and mode fields are
also rejected when present only through inheritance or an accessor. Malformed
data fails before quote verification or persistence.

*Verified:* red-first Bridge regressions supplied an accessor-backed deposit
address and inherited executable fields. The corrected path rejects both,
never invokes the getter, and saves no record. The focused Bridge suite passes
103 tests. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Resolved Web station definitions are immutable

`resolveStation()` returned the internal station definition directly. A caller
could rewrite its view, route list, label, or Bank mode list, and the next visit
resolution would consume that forged definition. TypeScript readonly types did
not protect the runtime object or its nested arrays.

Authored station definitions, route arrays, and mode arrays are now frozen
before entering the private registry. Resolution and presentation values are
unchanged; custom route registers and capabilities remain supported.

*Verified:* a red-first station regression observed mutable definitions,
routes, and modes; the corrected test rejects view and route rewrites and
preserves the Post Office station. The focused station and visit suite passes
24 tests. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Input-gate unbind attempts every cleanup action

`bindInputGate()` returned an unbind function that removed the entry listener,
then the exit listener, then resumed input without isolating those operations.
If either listener cleanup threw, later cleanup was skipped: a panel could
leave its exit handler attached or leave Phaser keyboard input suspended even
though the binding was being torn down.

Unbind now attempts both listener removals and input restoration independently,
then rethrows one cleanup error unchanged or combines multiple failures in an
`AggregateError`. Normal event routing and idempotent input-gate behavior are
unchanged.

*Verified:* red-first public regressions make entry cleanup throw and observe
the old path skipped exit cleanup and input restoration; the corrected path
attempts both. A second regression covers an exit-cleanup throw while still
restoring input. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Intent route projection is immutable

`ROUTE_BY_INTENT_KIND` was exported as a mutable object. A same-bundle
consumer could rewrite the route associated with `shield`, `unshield`,
`transfer`, or `swap`; disclosure derivation and private-route checks read this
map when a batch reaches the commit surface. TypeScript's `Record` annotation
did not protect this runtime privacy and route authority.

The authored intent-to-route map is now a frozen `Readonly<Record<...>>`.
Intent shapes, the approved register, and custom register fixtures remain
unchanged; only mutation of the shared mapping is prevented.

*Verified:* a red-first public route regression observed that the map accepted
an `exchange.swap` replacement for `shield`; the corrected regression rejects
the rewrite and preserves `shield -> bank.shield`. The focused routes suite
passes 25/25; no browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — World host release cannot orphan on teardown scheduling failure

`createHost().release()` decremented its final lease before calling the
injectable teardown deferrer. If that scheduler threw, the release exited
without invoking `stop`, leaving the live World instance retained forever with
zero references and no pending teardown. A synchronous custom deferrer also
left its already-completed handle in `pending`, causing later remounts to
cancel unrelated work.

Release now falls back to immediate teardown when scheduling fails, preserves
the scheduling error (or combines it with a synchronous teardown error), and
does not retain a handle when a deferrer completes synchronously. Normal
deferred and asynchronous teardown semantics are unchanged.

*Verified:* public Host regressions prove a throwing deferrer still retires the
instance and a synchronous deferrer leaves no stale cancel handle. The focused
Host suite passes 22 tests. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Authored Web copy is immutable product authority

`COPY` was exported as a mutable object despite its `as const` TypeScript
annotation. A same-bundle consumer could rewrite nested wallet, privacy,
failure, or submission-uncertainty messages after startup; those strings are
the player-facing explanation of gates and financial outcomes, so the runtime
could present text that no longer matched the reviewed behavior.

The authored copy tree is now deeply frozen at module initialization. The
existing `allCopyStrings` traversal and exact copy values remain unchanged;
this protects the shared default while retaining its read-only consumer
contract.

*Verified:* a red-first public copy regression observed mutable root, nested
connect, and error records; the corrected test rejects a nested wallet-message
rewrite and preserves the authored wording. The focused copy suite passes 6/6;
no browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Relay fee felt checks reject coercible runtime values

`WalletApiPrivacyOperations` used `isFelt()` on external relay fee tokens,
but the helper assumed its TypeScript `string` input and let JavaScript
coercion run through regular-expression and bigint conversion. A gateway
response object with a `toString()` returning the configured token could
therefore pass the fee-token guard and cross into a Wallet API fee action as a
non-string value.

The felt predicate now requires a runtime string before applying the exact
lowercase-`0x`, hexadecimal and Stark-field bounds. Existing canonical token
rules, address comparisons and fee authorization semantics are unchanged;
coercible objects fail closed before preparation or wallet handoff.

*Verified:* a red-first public Wallet API regression supplied a coercible
object token to quote-bound relay-fee validation; the old path published the
batch, while the corrected path rejects it as an unexpected fee token.
Removing the runtime type guard reproduces the failure. The focused Wallet API
suite passes 80 tests; no browser, provider, RPC, wallet, proof, signature,
funds or transaction was used.

### 2026-08-30 — Bank mode route projection is immutable

`ROUTE_BY_MODE` was exported as a mutable object. A same-bundle consumer could
rewrite the route behind `shield`, `unshield`, or `transfer` after startup;
Bank UI mode tabs and the machine both read this map when projecting doors and
preparing the corresponding financial action. TypeScript's `Record` annotation
did not protect this runtime route authority.

The authored mode-to-route map is now a frozen `Readonly<Record<...>>`. The
Bank mode set and route register remain unchanged; this only prevents a shared
consumer from rewriting the approved route projection.

*Verified:* a red-first public Bank regression observed that the map accepted a
replacement on the prior integration head; the corrected regression rejects the
rewrite and preserves `shield -> bank.shield`. The focused Bank machine suite
passes 84/84; no browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Wallet capability versions require string runtime data

`WalletApiPrivacyOperations.capability()` passed every value from the wallet's
supported-version response into semver parsing. The parser coerced objects via
their `toString()` method, so a hostile or malformed response object could be
reported as a supported version and returned through the typed capability
snapshot, despite the Wallet API contract requiring version strings.

Capability parsing now ignores non-string version entries before semver
parsing. Valid version ordering, prerelease handling and support thresholds
are unchanged; malformed entries cannot grant capability or cross the privacy
boundary as a version value.

*Verified:* a red-first public Wallet API regression supplied an object whose
`toString()` returned `0.10.3`; the old path reported support and returned the
object as `walletApiVersion`, while the corrected path reports unsupported with
no version. Removing the runtime type guard reproduces the failure. The
focused capability suite passes 79 tests; the full Privacy suite passes 9
files / 246 tests. No browser, provider, RPC, wallet, proof, signature, funds
or transaction was used.

### 2026-08-30 — The Exchange asset catalog is immutable product authority

`EXCHANGE_CATALOG` was exported as a mutable array whose asset records were
also mutable. A same-bundle consumer could replace an entry or rewrite its
token, symbol, or decimals after startup; the Exchange panel and machine read
that shared value when presenting choices, reading balances, and constructing
the swap intent. The TypeScript `readonly` annotations did not protect the
runtime financial boundary.

The authored catalog and each asset record are now frozen. This protects the
default product catalog while retaining the existing `validateExchangeCatalog`
custom-fixture seam used by tests; no runtime wallet or route policy behavior
changes.

*Verified:* a red-first public catalog regression observed the mutable array and
asset; the corrected regression rejects replacement and token rewrites and
preserves the STRK record. The focused catalog suite passes 3/3; no browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Wallet balance responses require felt-shaped token entries

`WalletApiPrivacyOperations.balances()` previously trusted the Wallet API's
runtime `token` and `balance` fields. It converted `balance` with `BigInt()`
without first enforcing the Wallet API `FELT` wire shape, and published any
token string unchanged. A malformed token could therefore cross the privacy
boundary, while malformed balance text escaped as an `unreachable` parser
failure instead of the generic invalid-wallet-response error.

Balance mapping now requires both fields to be hexadecimal Stark field
elements before conversion. Valid zero and positive felts retain the existing
aggregate-balance semantics; negative, decimal, malformed and field-prime-or-
above values fail closed as `PrivacyError('unknown')`. No product-level balance
cap or maturity claim is added.

*Verified:* red-first public Wallet API regressions supplied a non-felt token
and a non-felt balance; the old path published the token and mapped the
malformed balance to `unreachable`, while the corrected path rejects both as
`unknown`. Removing the felt-shape guard makes both regressions fail. The
focused Wallet API suite passes 78 tests; the full Privacy suite passes 9
files / 245 tests. No browser, provider, RPC, wallet, proof, signature, funds
or transaction was used.

### 2026-08-30 — Fixed-room destroy attempts every listener cleanup

`createFixedRoomController().destroy()` marked the controller destroyed and
called its three Shell-listener stop callbacks sequentially without isolation.
If the first stop callback threw, the remaining listeners and input restoration
were skipped, while the destroyed flag made a later call a no-op. A controller
could therefore remain subscribed to Shell commands after teardown and leave
the input gate in the wrong state.

Destroy now attempts each registered listener stop and input restoration
independently, then rethrows one cleanup error unchanged or combines multiple
errors in an `AggregateError`. State is retired before cleanup, and repeated
destroy remains idempotent after all owned resources have been attempted.

*Verified:* a public fixed-room regression makes the first listener stop throw,
then confirms all three stops and input restoration still run, while a second
destroy performs no duplicate cleanup. The focused fixed-room suite passes 43
tests. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Private swap executor entrypoints reject malformed names

`WalletApiPrivacyOperations.validateSwapPlan()` previously rejected only a
falsey executor entrypoint. A malformed external planner response containing
whitespace-only or non-string entrypoint data therefore crossed quote
admission and produced a reviewed batch, even though it cannot name a valid
Starknet entrypoint and could later reach action construction.

Swap plan validation now requires a string entrypoint with non-whitespace
content, while preserving dynamic executor entrypoints from the reviewed AVNU
plan. The guard runs before a batch is published or the wallet is asked to
prove anything; contract, calldata and route checks are unchanged.

*Verified:* red-first public Wallet API regressions supplied empty,
whitespace-only and numeric entrypoints; the old path published all three
batches, while the corrected path rejects them as malformed executor calls
before proving. Removing the entrypoint guard makes all three regressions
fail. The focused swap admission suite passes 76 tests; the full Privacy
suite passes 9 files / 243 tests. No browser, provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-30 — Lobby movement does not continue after synchronous transport closure

`LobbyClient.#pump()` previously called `room.send('move', desired)` and then
unconditionally stamped `lastSentAt` and scheduled reconciliation. A transport
can synchronously invoke the room's `onLeave` callback from `send`; that retires
the room and cancels existing reconciliation, but the stale continuation then
installed a timer against the closed client. The client now rechecks both room
identity and connected status after the send before recording send state or
creating follow-up work.

*Verified:* a deterministic fake room closes synchronously from its move send.
The old path scheduled a 50ms reconciliation timer after the close; the public
regression now observes the closed status and zero new timers. Removing the
post-send ownership guard reproduces the failure. Normal movement and
reconciliation behavior are unchanged. The focused Lobby client suite passes
63 tests.

### 2026-08-30 — Web route and building lookups reject inherited records

The route gate used ordinary property access on caller-supplied `RouteGrade`
entries. A malformed object could inherit its route id or approval fields and
be treated as a playable route. `buildingRoutes()` had a separate version of
the same flaw: an inherited building id could make `buildingDoor()` open even
when `routeDoor()` rejected the corresponding entry.

Both lookups now share an own-record guard requiring every `RouteGrade` field
before admitting an entry. Authored register entries and custom valid fixtures
retain their behavior, while inherited or partial descriptors fail closed as
unknown/unbuilt route data.

*Verified:* red-first public route regressions cover inherited route identity,
inherited approval/disclosure fields, and inherited building identity. All
three are admitted on the old path and rejected by the corrected lookups; the
focused routes suite passes 24/24. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Private swap response amounts require decimal wire syntax

`BackendPrivacyClient.prepareSwap()` previously converted the backend's
`buyAmount` and nested relay-fee `amount` with `BigInt()` directly. JavaScript
accepts whitespace, signed values and hexadecimal strings in that conversion,
so malformed successful responses crossed the browser privacy boundary as
valid bigint values even though the backend emits decimal strings.

Swap response amount fields now use the existing decimal-string parser. This
rejects whitespace, signs, hexadecimal and fractional syntax with the generic
invalid-response `PrivacyError`; zero, leading-zero decimal and valid large
decimal values retain their existing mapping, while semantic positivity and
route bounds remain enforced by the operations layer.

*Verified:* red-first public BackendPrivacyClient regressions cover whitespace,
signed and hexadecimal `buyAmount` and nested fee amounts; all six resolved
before the guard and now reject with `kind: 'unknown'`. A mutation restoring
direct `BigInt()` made all eight malformed swap amount regressions fail,
including the existing fractional cases. The focused backend-client suite
passes 53 tests; the full Privacy suite passes 9 files / 241 tests. No browser,
provider, RPC, wallet, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar outfit binding retries failed listener cleanup

`createAvatarOutfitToggleBinding().destroy()` previously set its destroyed flag
before calling the keyboard emitter's `off`. If an emitter threw during that
cleanup, the listener could remain attached but every later `destroy()` call
returned immediately, so the Scene permanently retained an inert input
listener. The binding now keeps the handler inert immediately while tracking
detachment separately; a failed `off` remains owned and a later destroy
retries it, becoming idempotent only after successful removal.

*Verified:* a receiver-owned keyboard fake that throws on its first `off`
leaves one listener on the old implementation; the public regression now
observes the throw, retries cleanup, and confirms zero listeners after the
second call. The mutation restoring the destroyed-flag early return fails.
The change is World-local and does not alter input or avatar-selection
semantics. The focused outfit suite passes 9 tests.

### 2026-08-30 — Route resolvers require own route-grade fields

The Web route resolver used ordinary property access on caller-supplied
`RouteGrade` entries. A malformed entry could therefore inherit its route id
or its approval/disclosure fields from a prototype and be treated as a graded,
playable route. That would let configuration supplied through the public
resolver boundary alter the privacy door without carrying an authored record.

`findRoute()` now admits only object entries carrying every `RouteGrade` field
as an own property before matching the route id. This keeps the canonical
register and normal test fixtures unchanged while failing closed for inherited
or partial route descriptors; route-door immutability and panel-registry
ownership remain separate protections.

*Verified:* red-first public route regressions supplied a descriptor inheriting
the route id, then one with an own route id but inherited approval fields. Both
were admitted before the guard and both now resolve to a locked unknown route.
The focused routes suite passes 23/23; no browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Private swap planner quotes must target mainnet

`BackendApi.prepareSwap()` previously checked only that an external planner
returned a truthy `chainId`. A planner response for Sepolia or another chain
could therefore trigger paymaster fee construction and authorization issuance
before the browser rejected the quote against its mainnet Wallet API policy.

Swap quote admission now requires the exact canonical Starknet mainnet chain
identifier before any fee or authorization work. The configured production
planner already targets this chain; this is a defense-in-depth response
boundary and does not add a dynamic chain-selection feature.

*Verified:* a red-first Backend regression supplied the canonical Sepolia
chain ID; the old path returned `200` and issued a fee, while the corrected
path returns the existing `409` invalid-quote response with zero paymaster and
authorization calls. Removing the exact-chain guard reproduces the failure.
The focused Backend suite passes 105 tests. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — The default Web panel registry is immutable

`BUILDING_PANELS` was exported as a mutable object whose descriptors were also
mutable. A same-bundle consumer could therefore replace a panel or rewrite its
title/component after startup, changing the room composition behind the
already-graded route gate. The resolver's own-property guard prevents inherited
entries, but it does not protect authored entries from later mutation.

The default registry and each authored descriptor are now frozen. Custom panel
registries passed to `PanelLayer` or `VisitLayer` remain supported and retain
their caller-owned lifecycle; only the shared production registry is pinned.

*Verified:* a red-first public registry regression attempted to replace the
Exchange descriptor and rewrite its title; the mutable default accepted both.
The corrected registry rejects both mutations and preserves the authored
descriptor. The focused routes suite passes 21/21; no browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby suspend cannot resurrect a room closed during send

`LobbyClient.suspend()` sent the suspend command and then unconditionally
changed the wrapper to `suspended`. A synchronous transport callback could
report the room closed during that send; the stale continuation then exposed a
usable suspended client even though its room and server identity were already
retired.

Suspend now captures the room and rechecks room identity and connected status
after send before publishing `suspended`. A transport closure remains
authoritative; normal interior suspension and reconcile cancellation are
unchanged.

*Verified:* a red-first public Lobby regression makes a fake room deliver
`onLeave` synchronously from its suspend send; before the guard the client
ended `suspended`, while the corrected client remains `closed` with no game id.
Removing the post-send guard reproduces the failure. The focused Lobby client
suite passes 62 tests. No browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Lobby resume cannot resurrect a room closed during send

`LobbyClient.resume()` sent the resume command and then unconditionally set
the wrapper to `connected`. A synchronous transport callback could report the
room closed while that send was in progress; the stale continuation then
restored `connected` even though `#room` and the server-assigned identity had
already been retired.

Resume now captures the room and rechecks room identity and suspended status
after send before recording the placement or publishing `connected`. A
transport closure therefore remains authoritative; ordinary resume behavior
and explicit placement validation are unchanged.

*Verified:* a red-first public Lobby regression makes a fake room deliver
`onLeave` synchronously from its resume send; before the guard the client ended
`connected`, while the corrected client remains `closed` with no game id.
Removing the post-send guard reproduces the failure. The focused Lobby and
Backend suites pass 165 tests, and both package typechecks and diff hygiene
pass. No browser, wallet, provider, RPC, proof, signature, funds or transaction
was used.

### 2026-08-30 — Planner quote identifiers require string shape

`BackendApi.prepareSwap()` previously checked only the truthiness of the
external planner's `quoteId`. A malformed planner response containing a
number or object therefore crossed the backend boundary, triggered paymaster
fee construction and issued an authorization before the browser rejected the
response as invalid.

Swap quote admission now requires a nonempty string identifier before any fee
or authorization work. Existing opaque nonempty identifier handling and
quote-bound claims remain unchanged.

*Verified:* red-first Backend regressions supplied numeric and object quote
identifiers; both previously returned `200` and issued fees, while the
corrected path returns the existing `409` invalid-quote response with zero
paymaster and authorization calls. Removing the type guard independently
reproduces both regressions. The focused Lobby and Backend suites pass 165
tests, and both package typechecks and diff hygiene pass. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Room resolution ignores inherited panel descriptors

`resolveRoom()` read `panels[building]` through ordinary prototype lookup. A
prototype-polluted or otherwise non-record registry could therefore provide a
panel for a building that was not actually present in the registry, causing
the shell to render an injected room descriptor. The privacy door still runs
first, but the panel registry is a separate composition boundary and must not
accept inherited values as authored configuration.

Room resolution now requires an own property before admitting a panel;
inherited descriptors fall back to the existing `unbuilt` result. This keeps
the default registry behavior unchanged while making the public resolver
fail closed for hostile or malformed registry objects.

*Verified:* a red-first public resolver regression supplied an `exchange`
descriptor only through a custom prototype and received `panel` on the old
path. The corrected resolver returns `unbuilt`. The focused routes suite
passes 20/20; no browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — World host remount cancellation failures preserve teardown

`createHost.acquire()` incremented its lease before cancelling a deferred final
teardown. If the injected/default cancellation boundary threw, the failed
acquire left the host with a phantom reference; the queued stop then observed
that reference and never destroyed the retained instance.

The host now cancels the pending teardown before claiming the new lease. A
cancellation failure therefore leaves the original reference count and queued
cleanup untouched, while successful remounts retain the existing same-instance
behavior.

*Verified:* a red-first public host regression makes deferred cancellation
throw during a remount; before the fix the failed acquire left `refCount === 1`
and the queued stop was skipped, while the corrected path keeps zero refs and
retires the instance. Removing the ordering change reproduces the failure. The
focused Host suite passes 20 tests. No browser, lobby, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Pool configuration block windows require nonnegative values

`BackendPrivacyClient.config()` previously accepted any safe integer for the
backend's `proofValidityBlocks` and `noteMaturityBlocks`, including negative
values. A malformed successful pool-config response could therefore publish
an impossible proof window or maturity period through the privacy seam; the
later operation paths would receive invalid chain parameters instead of
failing at the wire boundary.

Config decoding now requires a positive proof-validity window and a
nonnegative note-maturity window. Existing safe-integer checks and valid
zero-maturity behavior remain unchanged; other response fields are untouched.

*Verified:* red-first BackendPrivacyClient regressions supplied `-1` for each
block field; both previously resolved and now reject with generic
`PrivacyError('unknown')`. Removing either minimum guard independently
reproduces its regression. The focused privacy and Host suites pass 67 tests,
and both affected package typechecks and diff hygiene pass. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Route-door decisions are immutable snapshots

`routeDoor()` and `buildingDoor()` returned a shared mutable `OPEN` object for
every playable route. A consumer that changed the returned `open`, `reason` or
`message` field could therefore alter later authorization and disclosure
decisions for every route using that object. Locked decisions were also
mutable, allowing a consumer to retain a forged door snapshot and present it
as current state.

Route decisions now freeze both the shared playable result and each newly
created locked result. The route register remains the only source of admission;
callers can inspect a decision but cannot rewrite it or poison later checks.

*Verified:* a red-first public routes regression attempted to mutate playable
and unknown-route decisions and then re-read them. The old shared result was
mutable; the corrected results are frozen and preserve their original values.
The focused routes suite passes 19/19. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room station activation does not resume after teardown

`createFixedRoomController.update()` suspended input and emitted
`station:activated`, then unconditionally resumed input when World still owned
the room. A synchronous station listener could destroy the controller during
that emission; destruction already resumed input, and the stale update then
resumed it a second time after the lifecycle had ended.

The post-event continuation now requires the controller to remain live, in the
room and World-owned before restoring input. Normal activation ordering and
Shell claims remain unchanged; teardown owns its single restoration.

*Verified:* a red-first public regression destroys the controller from
`station:activated`; before the guard the input sequence ended with two resumes
after the suspension, while the corrected sequence has exactly one teardown
resume. Removing the post-event lifecycle guard reproduces the failure. The
focused fixed-room and Backend run passes 144 tests, and both affected package
typechecks and diff hygiene pass. No browser, lobby, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Private swap planner outputs must fit uint256

`BackendApi.prepareSwap()` checked that an external planner's `buyAmount`
met the requested minimum but did not enforce the STRK20 `u256` upper bound.
An AVNU or planner response above `2^256 - 1` could therefore receive a fee
authorization and cross the backend response boundary, even though the
Wallet API cannot represent that output amount.

Swap quote admission now requires a runtime bigint output no greater than
`2^256 - 1` before paymaster fee construction or authorization issuance. The
existing stale/invalid-quote response and the exact maximum boundary are
unchanged.

*Verified:* a red-first Backend regression supplied `2^256`; the old path
returned `200` and issued a fee, while the corrected path returns `409` with
zero paymaster and authorization calls. An exact-maximum output remains
accepted. The focused fixed-room and Backend run passes 144 tests, and both
affected package typechecks and diff hygiene pass. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Door-trigger transitions are reentrancy-owned

`createDoorTrigger.update()` emitted building events before committing its new
active door. A synchronous listener could report another tile or reset the
trigger during that delivery; the outer update then overwrote the newer
occupancy and could emit a stale `building:entered` event. This made the World
door state disagree with the ordered callbacks that caused it.

The trigger now commits the candidate occupancy before event delivery and
guards each continuation with a transition revision. A nested update or reset
therefore remains authoritative, while ordinary exit-then-enter ordering and
locked-door behavior are unchanged.

*Verified:* red-first public regressions cover a nested bank-to-Post-Office
transition and an exit callback that redirects to the street; before the guard
the outer transition overwrote or announced stale occupancy, while the
corrected trigger preserves the nested result. The focused door-trigger suite
passes 8 tests. No browser, lobby, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Bridge shield-plan revalidation ownership is retired on close

The Web Bridge panel used one `revalidateBusy` flag for the lifetime of a
machine. Closing the panel while a settled-funds account read was pending did
not retire that flag, so a reopened panel could not revalidate its current
shield plan until stale work settled. The session clock prevented stale
publication, but the replacement validation was silently unavailable in the
meantime.

Shield-plan revalidation now has an owner token whose release is conditional
on that token still being current; close retires the owner immediately,
allowing a reopened panel to validate while the old read drains. Existing
attempt/session, account, evidence and plan guards still prevent stale results
from becoming executable.

*Verified:* a red-first public Bridge regression starts revalidation A with a
deferred account read, closes the panel, starts revalidation B and resolves B
before stale A. On the old path B returned `null` without planning; the
corrected path completes B and stale A returns `null`. Removing the owner
guard reproduces the failure. The focused Bridge suite passes 46/46; no
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Avatar Studio does not publish after selection teardown

`createAvatarStudioController.update()` selected a contacted figure and then
published a state snapshot. Selection emits synchronously through the shared
outfit event bus, so an `avatar:selected` listener could destroy the Studio or
leave it before the update resumed. The old continuation then published a
snapshot for a controller that no longer owned the lifecycle.

The update path now rechecks `destroyed` and `inRoom` after selection before
publishing. The selection remains Scene-owned and still emits normally; only
the stale post-selection publication is suppressed. This is distinct from the
existing pre-selection guard, which protects against teardown during the
highlight `onChange` callback.

*Verified:* a red-first public regression made the `avatar:selected` delivery
destroy the controller; before the guard the update produced two snapshots,
while the corrected path retains only the highlight snapshot and still selects
`avatar-8`. The focused Avatar Studio suite passes 29 tests. No browser,
lobby, wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Private swap request amounts must fit uint256

`BackendApi.prepareSwap()` previously accepted any positive decimal string for
`sellAmount` and `minAmountOut`. Values above the STRK20 `u256` range therefore
crossed the public API boundary and reached the swap planner, even though they
cannot be represented by the wallet action or the AVNU route. An overlarge
sell amount could return a successful quote response; an overlarge minimum
could consume planner work before being rejected as a stale quote.

Swap request amounts now require `1 <= value <= 2^256 - 1` before any planner,
RPC or paymaster work. The maximum remains accepted and the existing positive
decimal syntax and policy checks are unchanged.

*Verified:* red-first Backend regressions cover `2^256` for both sell amount
and minimum output and assert zero swap-planner calls; both previously crossed
the planner and returned `200`/`409`, while the corrected path returns generic
`400`. A maximum-uint256 sell amount remains accepted at the planner boundary.
The focused Backend suite and package gates are recorded on the candidate.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Fixed-room exit rechecks ownership after onExit

`FixedRoomController.leave()` invoked the consumer-owned `onExit` callback,
then unconditionally published its state and emitted `building:exited`. If
that callback synchronously destroyed or re-entered the controller, the
remaining continuation described a transition that no longer belonged to the
current controller lifecycle.

Exit now rechecks that the controller is still live and outside the room after
`onExit`; a retired or re-entered controller stops the stale continuation.
Normal exit ordering and the legitimate `building:exited` event are unchanged.

*Verified:* a red-first fixed-room regression made `onExit` destroy the
controller and observed one stale state publication; the corrected test emits
neither a stale state nor `building:exited`. Focused fixed-room tests pass
34/34. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Bridge source registry responses fail closed on malformed shapes

`loadSourceAssets()` previously caught only a rejected token request. A
malformed runtime response such as `null`, or an array containing `null`, was
then iterated and dereferenced as if it were the generated SDK type. The
source picker could crash instead of retaining its curated safe fallbacks.

The loader now requires an array response and skips non-object entries before
reading token metadata. Transport failures, malformed top-level responses and
bad entries all retain the fallback registry; valid live metadata continues
to override matching fallback entries under the existing decimal and chain
guards.

*Verified:* red-first public Bridge regressions cover a `null` registry
response and null/primitive array entries; the old loader threw, while the
corrected loader returns the six curated fallback assets. Removing either
guard reproduces its matching failure. The Bridge suite passes 66/66; package
typecheck, invariant scan and `git diff --check` pass. No browser, external
provider, RPC, wallet, proof, signature, funds or transaction was used.

### 2026-08-30 — Bridge shield planning ownership is retired on close

The Web Bridge panel used one `shieldBusy` flag for the lifetime of a machine.
Closing the panel while its settled-funds account or planner read was pending
did not retire that flag, so a reopened panel could not start its own shield
plan until stale work settled. The session clock prevented stale publication,
but the replacement action was silently unavailable in the meantime.

Shield planning now has an owner token whose release is conditional on that
token still being current; close retires the owner immediately, allowing a
reopened panel to plan while the old account/planner work drains. Existing
attempt/session, account, evidence and plan guards still prevent stale results
from becoming executable.

*Verified:* a red-first Bridge regression starts deferred shield planning A,
closes the panel, starts planning B and resolves B before stale A; on the old
path B never read the account, while the corrected path performs one planner
call and leaves stale A inert. Focused Bridge tests pass 43/43. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Fixed-room entry rechecks ownership after onEnter

`FixedRoomController.enter()` marked the room active, then invoked the
consumer-owned `onEnter` callback before publishing state. If that callback
synchronously destroyed the controller (for example during Scene teardown),
the method still published a post-destroy snapshot describing an already
retired transition.

Entry now rechecks the controller's destroyed and in-room ownership after
`onEnter` and stops the continuation when the callback retired it. Normal entry
ordering and input restoration are unchanged.

*Verified:* a red-first fixed-room regression made `onEnter` destroy the
controller and observed one stale `onChange` publication; the corrected test
publishes none and leaves the controller outside. Focused fixed-room tests pass
34/34. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Server-action span decoding must be bounded by remaining calldata

`Cursor.take()` previously allocated an array from the decoded span length
before checking whether that many words remained. A valid felt encoding of
`Number.MAX_SAFE_INTEGER` could therefore request an enormous allocation for a
truncated server-action payload, instead of failing closed at the wire
boundary.

The cursor now checks the requested count against the remaining calldata
words before slicing, preserving the existing truncation error and preventing
unbounded allocation. Variant, maximum-count and trailing-calldata rules are
unchanged.

*Verified:* a red-first public Backend regression uses a guarded `Array.from`
and a `Number.MAX_SAFE_INTEGER` span length; the old decoder attempted the
unbounded allocation, while the corrected decoder returns the generic
truncated-calldata error before allocation. Removing the remaining-input
guard fails the regression. The Backend suite passes 5 files / 159 tests;
package typecheck, invariant scan and `git diff --check` pass. No browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.

### 2026-08-30 — Fixed-room control ownership accepts only known owners

The fixed-room controller trusted the `owner` field of a matching
`world:control-owner` Shell event. A malformed runtime value such as `forged`
was stored in the public controller state and took the fallback input-resume
path, so the state projection no longer described the actual two-owner
protocol.

The handler now accepts only the protocol's `world` and `shell` values;
unknown owners are ignored without changing input state, room state or station
activation. Valid control handoffs retain their existing ordering.

*Verified:* a red-first fixed-room regression sent a matching building event
with an unknown owner and observed the old `forged` state plus an input resume;
the corrected test leaves World ownership unchanged and makes no input call.
Focused fixed-room tests pass 34/34. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Server-action span lengths must be nonnegative

`decodeServerActions()` previously accepted negative values anywhere a Cairo
span length was decoded. JavaScript's `Array.from({ length: -1 })` silently
creates an empty array, so malformed calldata such as a `WriteOnce` action
with span length `-1` passed the route decoder as a valid `other` action.

`Cursor.number()` now rejects negative values as malformed before converting
them to a JavaScript number. Existing maximum-length, truncation, variant and
trailing-calldata checks are unchanged.

*Verified:* a red-first public Backend regression first accepted
`[action_count=1, variant=0, storage=0x1, span_length=-1]`; the corrected
decoder returns the generic invalid-span-length error. Removing the
nonnegative guard reproduces acceptance. The Backend suite passes 5 files /
159 tests; package typecheck, invariant scan and `git diff --check` pass. No
browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.

### 2026-08-30 — Fixed-room shell decoders fail closed on null commands

The fixed-room controller subscribed directly to the Shell event bus and
dereferenced `world:stations`, `world:control-owner` and
`world:exit-building` payloads before checking their building. A malformed
runtime `null` payload therefore threw from a synchronous callback instead of
being ignored, allowing one bad cross-package command to escape the World
boundary and interrupt the caller.

The three handlers now use null-safe building and station reads. Malformed
`null` and `undefined` commands are ignored without changing room state,
input ownership or station admission; valid commands retain their existing
ordering and behavior.

*Verified:* a red-first fixed-room regression emitted a `null` payload through
each Shell command and observed the old dereference error; the corrected test
keeps the controller in the room with World ownership and no output events.
Focused fixed-room tests pass 35/35. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Bridge input amounts must fit uint256

`BridgeService.validateInput()` previously rejected only non-positive amounts.
An arbitrarily large positive `bigint`, including `2^256`, therefore reached
the OneClick quote client before failing against the returned quote. That
made an invalid blockchain amount cross the external bridge boundary and
spent a provider request on input that could never be represented by the
source transfer contract.

Bridge input validation now requires `0 < amountIn <= 2^256 - 1` before any
quote request. Existing source metadata, recipient, refund, slippage and
quote evidence rules are unchanged.

*Verified:* a red-first public Bridge regression passes `2^256` and confirms
the old path called the quote client before rejecting; the corrected path
returns the positive-uint256 error without a quote request. Removing the
upper-bound guard reproduces the failure. The Bridge suite passes 65/65; the
package typecheck, invariant scan and `git diff --check` pass. No browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.

### 2026-08-30 — Bridge saved-quote preflight ownership is retired on close

The Web Bridge panel used one `preflightBusy` flag for the lifetime of a
machine. Closing the panel while its saved-quote account read was pending did
not retire that flag, so a reopened panel could not begin its own preflight
until the stale read settled. The session clock prevented stale publication,
but also left the new recovery attempt silently unavailable.

Preflight now has an owner token whose release is conditional on that token
still being current; close retires the owner immediately, allowing a reopened
panel to preflight while the old account read drains. Existing attempt/session
guards still prevent stale account, planner or record results from publishing
over the replacement attempt.

*Verified:* a red-first Bridge regression starts deferred preflight A, closes
the panel, starts preflight B and resolves B before stale A; on the old path B
never read the account, while the corrected path runs B through planning and
keeps the stale completion inert. Focused Bridge tests pass 43/43. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Bridge refresh ownership is retired on close

The Web Bridge panel used one `refreshBusy` flag for the lifetime of a panel
machine. Closing the panel while its status refresh was pending did not retire
that flag, so a reopened panel could not start its own refresh until the stale
provider request settled. That left the recovery surface stuck behind an
unrelated old request.

Refresh now has an owner token whose release is conditional on that token still
being current; close retires the owner immediately, allowing a reopened panel
to refresh while the old provider call drains. Existing attempt/session guards
prevent the old result from publishing over the new panel state, and Watch
continues to exclude concurrent refreshes.

*Verified:* a red-first Bridge regression starts deferred refresh A, closes the
panel, starts refresh B, and resolves B before stale A; on the old path B was
never called, while the corrected path starts both and keeps the panel idle
after stale A settles. Focused Bridge tests pass 43/43. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Backend request records require own data fields

`requireRecord()` previously used its allowed-key list only to reject unknown
own enumerable fields; it did not require the listed request fields to exist
as own data properties. A malformed direct API request could therefore supply
`v` (or another required field) through a prototype and pass validation,
reaching the RPC or financial handler with inherited input.

Request validation now requires every declared field to be an own data
property, rejecting missing and accessor-backed fields before endpoint work.
The existing unknown-field, route, value, rate-limit and response contracts
are unchanged.

*Verified:* a red-first public Backend regression passes a pool-config request
whose only `v` is inherited from a custom prototype; the old path returned
`200` and called the RPC, while the corrected path returns generic `400` and
does not call it. The mutation removing the own-field guard reproduces the
failure. The Backend suite passes 5 files / 159 tests; package typecheck,
invariants and `git diff --check` pass. No browser, external provider, RPC,
wallet, proof, signature, funds or transaction was used.

### 2026-08-30 — Lobby placement decoders fail closed on null payloads

`LobbyPresence.admit()`, `.move()` and `.resume()` previously dereferenced
placement fields directly. A malformed runtime `null` payload therefore threw
a `TypeError` instead of taking the existing `bad-placement`, `rejected` or
`false` paths, allowing one malformed payload to escape the Lobby boundary as
an uncontrolled exception.

Placement reads now use null-safe access so `null` and `undefined` payloads
fail closed without mutating presence or rate-floor state. Valid placements and
the existing finite-coordinate behavior are unchanged.

*Verified:* a red-first Lobby regression supplied a `null` payload to every
public placement path and observed the old dereference error; the corrected
test returns `bad-placement`, `rejected` and `false`. Focused Lobby presence
tests pass 32/32. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — PanelLayer effect rolls back partial World listener setup

`PanelLayer` previously acquired its three World listeners in one array
expression. If a later `world.on()` call threw during React effect setup, the
earlier handlers remained attached even though React received no cleanup
function, so a failed remount could leave stale room updates subscribed to the
World bus.

The effect now owns listener registrations incrementally, rolls back every
handler acquired before a failing registration, attempts all rollback
callbacks even when one cleanup throws, preserves the original setup error,
and makes normal cleanup idempotent. Room reduction, wallet gating and close
behavior are unchanged.

*Verified:* a red-first Web regression makes the third registration throw after
attaching the first two and makes the first rollback throw; the corrected
effect calls both rollback callbacks once and rethrows the original error.
Focused PanelLayer tests pass 13/13. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Bridge persisted required fields must be own data

`deserializeBridgeRecord()` previously read required root fields through
ordinary property access. A malformed persisted record could omit `status`
and supply it through `Object.prototype`; the decoder then accepted the
record and `BridgeService.resume()` could expose inherited state.

Persistence now requires own data properties for every required root field
(`v`, `signedQuote`, `createdAt`, `updatedAt`, `amountIn`, and `status`).
Accessors and inherited values fail closed; valid serialized records and
optional-field semantics remain unchanged.

*Verified:* a red-first public Bridge persistence regression deletes the
required `status` from a serialized record and supplies it only through
`Object.prototype`; the old decoder returned a record and the corrected
decoder returns `null`. The focused Bridge suite passes 98/98, the Bridge
typecheck and all invariant checks pass, and `git diff --check` is clean. No
browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.

### 2026-08-30 — Tiled property containers fail closed when malformed

`flattenProperties()` previously iterated any truthy `properties` value. A
malformed Tiled object whose property container was an object or primitive
therefore threw `TypeError` out of `objectLayerToDoors()` instead of being
skipped, allowing one bad authored object to abort map parsing.

The flattener now requires an array before iterating and returns an empty
property record for any other runtime value. Valid Tiled arrays, duplicate-name
last-write behavior, and malformed individual-entry skipping are unchanged.

*Verified:* a red-first World regression supplied a non-array property
container and observed the old iterable TypeError; the corrected test returns
an empty record. Focused Tiled-property tests pass 7/7. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Visit world-listener setup rolls back partial registration

`VisitController.listen()` previously registered four world handlers in a
single array expression. If a later `world.on()` registration threw, the
earlier handlers remained attached even though no cleanup function was
returned, so a failed React effect setup could leak callbacks into the world
bus. Its normal cleanup also stopped at the first unsubscribe failure, which
could leave Shell-owned controls suspended.

Listener setup now owns registrations incrementally, rolls back every handler
acquired before the failing registration, attempts all cleanup callbacks, and
preserves the original setup error. Normal teardown releases Shell-owned
controls even when listener cleanup reports an error, while retaining
idempotent listener ownership. Visit routing and matching-exit semantics are
unchanged.

*Verified:* a red-first Web regression makes the fourth world registration
throw after attaching the first three and makes the first rollback throw; the
corrected path calls all three rollback callbacks once and rethrows the
original registration error. Focused Visit tests pass 23/23. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio presentation stops after synchronous destroy

`createAvatarStudioPresentation().enter()` and `.exit()` previously continued
their ordered port calls after one port callback synchronously destroyed the
presentation. A reentrant teardown could therefore restore or move the player,
camera and presence after the presentation had already retired its ownership.

Both transitions now recheck the presentation's destroyed state after every
port operation and stop immediately when teardown occurs. Normal operation
order and idempotent destruction remain unchanged.

*Verified:* a red-first World regression destroys the presentation from the
`setStudioVisible` callback and observes later bounds/position calls on the old
path; the corrected test stops the transition. Focused Avatar Studio tests pass
25/25. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Presence world-listener setup rolls back partial registration

`PresenceController.listen()` previously registered six world handlers in a
single array expression. If a later `world.on()` registration threw, the
earlier handlers remained attached even though no cleanup function was
returned, so a failed React effect setup could leak callbacks into the world
bus for the lifetime of the page.

Listener setup now owns registrations incrementally, rolls back every handler
acquired before the failing registration, attempts all rollback callbacks even
if one cleanup throws, preserves the original setup error, and makes the
returned cleanup idempotent. Normal event routing and controller ownership are
unchanged.

*Verified:* a red-first Web regression makes the third world registration
throw after attaching the first two and makes the first rollback throw; the
corrected path calls both rollback callbacks once and rethrows the original
registration error. Focused presence tests pass 46/46. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Wallet connection cleanup is not retained after synchronous retirement

`WalletSession.connectOwned()` previously assigned the unsubscribe callback
returned by `connected.subscribe()` even when that subscription synchronously
reported account removal and `retireConnectionBestEffort()` had already
retired and destroyed the connection. A later explicit `disconnect()` then
invoked cleanup for the already-retired connection; a throwing stale cleanup
could surface as a new disconnect failure despite there being no live wallet
connection.

The subscription cleanup is now installed only if the same connection still
owns the session after registration. Synchronous account replacement retains
the cleanup for its still-current connection, while synchronous retirement
leaves no stale cleanup to invoke. Connection destruction and explicit cleanup
error semantics are otherwise unchanged.

*Verified:* a red-first public session regression makes subscription report
account removal synchronously and return a cleanup that throws; the old path
rejected a later disconnect, while the corrected path resolves without
invoking stale cleanup. The existing synchronous account-replacement test also
confirms cleanup is retained for the current connection. The Privacy suite
passes 232 tests. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-30 — Input-gate binding rolls back partial event registration

`bindInputGate()` previously registered the entry listener and then registered
the exit listener without a rollback path. If the second `on()` call threw,
the entry listener remained attached even though no unbind function was
returned, leaving later building events able to suspend input permanently.

The binding now rolls back the acquired entry listener, restores input, and
preserves the original registration error if exit registration fails. Normal
event handling and unbind idempotence remain unchanged.

*Verified:* a red-first World regression makes exit-listener registration throw
after entry registration and observes the entry stop callback was not called on
the old path; the corrected test calls it once. Focused input-gate tests pass
10/10. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Avatar outfit binding rolls back partial keyboard registration

`createAvatarOutfitToggleBinding()` previously called `keyboard.on()` without
handling a registration failure. An emitter that attached the handler before
throwing left the Scene-lifetime F listener installed even though no binding
was returned, so `StreetScene.createAvatarOutfit()` could not destroy it on a
partial create cleanup.

Binding construction now removes the handler after a failed registration,
preserves the original error, and tolerates a cleanup failure. Normal binding
ownership, input filtering and idempotent destroy behavior are unchanged.

*Verified:* a red-first World regression makes keyboard registration attach
then throw and observes one leaked handler on the old path; the corrected test
removes it. Focused outfit tests pass 8/8. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-30 — Prepared swap responses require a nonempty quote identifier

`BackendPrivacyClient.prepareSwap()` previously accepted any string as
`quoteId`, including the empty string. The backend's swap boundary requires a
quote identifier and the Wallet API operations layer validates chain, amounts,
expiry, executor and fee data but did not recheck this identifier. A malformed
successful response could therefore produce a prepared quote with no
identifier for the quote-bound review/submission lifecycle.

Swap response parsing now requires an own nonempty string quote identifier.
Whitespace remains opaque and permitted, matching the backend's existing
nonempty check; all other swap response validation and quote binding are
unchanged.

*Verified:* a red-first public BackendPrivacyClient regression supplied an
empty `quoteId` with otherwise valid swap data; it resolved on the old path and
now rejects with `kind: 'unknown'`. The focused backend-client suite passes 44
tests. No browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.

### 2026-08-30 — Fixed-room listener registration rolls back partial controllers

`createFixedRoomController()` previously registered the three Shell listeners
sequentially without retaining or rolling back registrations when a later
`in.on()` call threw. During `StreetScene.createFixedRooms()`, that leaves a
partially-constructed controller's earlier listener attached even though the
controller is never stored and cannot be reached by Scene cleanup.

Controller construction now rolls back every listener registration acquired
before the failing registration, preserves the original registration error,
and attempts all rollback callbacks even if one rollback throws. Normal
controller ownership, listener behavior and destroy idempotence are unchanged.

*Verified:* a red-first World regression makes the second Shell listener
registration throw and observes the first stop callback was not called on the
old path; the corrected test calls it once. Focused fixed-room tests pass 36/36.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-30 — Dynamic room labels claim ownership before styling

`StreetScene.renderRoom()` previously inserted a newly-created station label
into `roomLabels` only after its presentation setters completed. A Phaser text
setter failure during the first station render could therefore leave an
allocated label outside the Scene-owned map, unreachable by shutdown or
partial-create cleanup.

Dynamic station labels are now registered immediately after construction,
before styling setters run. Existing label geometry, update behavior and normal
room teardown are unchanged; failed presentation setup remains owned by the
Scene.

*Verified:* a red-first World regression makes the first dynamic label styling
setter throw and observes missing ownership on the old path; the corrected test
retains it. Focused World art tests pass 6/6. No browser, wallet, provider,
RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Authorization wire claims require canonical own data

`fromWire()` previously accepted signed JSON claims through ordinary property
access and converted bigint strings with `BigInt()`. A validly signed but
malformed authorization could therefore inherit a missing claim from a
polluted prototype, accept signed forms such as `+7`, `0x7` or `007`, or carry
an incomplete swap binding into later claim validation.

The decoder now requires own data properties for all required top-level
claims, validates the optional swap binding as a complete object with typed
fields, and accepts only canonical decimal strings for bigint values. Safe
block and quote-expiry numbers, string fields and invoke-prefix entries are
shape-checked before conversion; valid issued claims remain unchanged.

*Verified:* red-first codec regressions cover a prototype-supplied amount,
noncanonical signed amounts and an incomplete signed swap binding. Before the
guards those tokens decoded successfully; after them they return `null`.
Removing the own-data, canonical-decimal, or swap-shape guard independently
revives its regression. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-30 — Pool fee tokens require canonical felt encoding at the browser boundary

`BackendPrivacyClient.config()` previously treated the backend's `feeToken`
as an arbitrary string. A malformed successful pool-config response could
therefore publish decimal or uppercase-prefix encodings, or a value at/above
the Stark field prime, as the configured fee token. Later route checks compare
tokens numerically and do not repair that malformed configuration, so an
invalid token representation could reach fee-action construction.

Config parsing now requires the token to be a lowercase-`0x` Stark field felt
before returning `PoolConfig`. Uppercase hexadecimal digits and zero remain
valid under the existing felt rule; no route allowlist or nonzero policy is
introduced here.

*Verified:* red-first public BackendPrivacyClient regressions cover a decimal
token, uppercase `0X` prefix and field-prime value; all three resolved on the
old path and now reject with `kind: 'unknown'`. The focused backend-client
suite passes 43 tests. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-30 — Exterior labels claim ownership before styling

`StreetScene.createExteriorLabels()` previously inserted each text object into
`exteriorLabels` only after `.setOrigin()` and `.setDepth()` completed. A
Phaser setter failure during Scene construction therefore left an allocated
label outside the Scene-owned collection and unreachable by partial-create
cleanup.

Each label is now registered immediately after construction, before its
presentation setters run. Label geometry and normal rendering/teardown are
unchanged; a failed setter leaves the object owned for `cleanShutdown()`.

*Verified:* a red-first World presentation regression makes the first label
styling setter throw and observes the created label missing from Scene
ownership on the old path. The corrected test retains it. The full World
suite passes 24 files / 266 tests; World typecheck, invariants and diff
hygiene pass. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Room graphics claim ownership before depth setup

`StreetScene.createRoomVisuals()` previously assigned each graphics object
only after `.setDepth()` returned. If a Phaser depth setter threw during Scene
construction, the newly allocated graphic was absent from the Scene-owned
fields and could not be reached by partial-create cleanup.

Each room/studio graphics object is now assigned immediately after creation,
before its depth setter runs. Rendering order and the existing cleanup path
are unchanged; a failed setter leaves the allocation owned and recoverable.

*Verified:* a red-first World presentation regression makes the first room
graphics depth setter throw and observes the created object missing from Scene
ownership on the old path. The corrected test retains it. The full World
suite passes 24 files / 265 tests; World typecheck, invariants and diff
hygiene pass. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Relay estimate amounts require decimal wire syntax

`BackendPrivacyClient.estimate()` previously converted the backend's decimal
fee amount with `BigInt()` directly. JavaScript accepts whitespace and signed
strings in that conversion, so malformed estimate responses such as `" "` or
`"+7"` crossed the browser boundary as valid `0n` or `7n`; fractional syntax
instead leaked a raw `SyntaxError`. The operations layer could only reject the
zero case and would otherwise admit the signed form into fee validation.

Estimate parsing now requires the existing decimal-string wire syntax before
conversion, mapping malformed values to the generic invalid-response error.
The parser imposes no additional fee ceiling; positive amount and route-policy
checks remain in the operations layer.

*Verified:* red-first public BackendPrivacyClient regressions cover whitespace,
signed and fractional estimate amounts; the first two resolved on the old
path and the fractional case leaked `SyntaxError`, while all three now reject
with `kind: 'unknown'`. The focused backend-client suite passes 40 tests. No
browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.

### 2026-08-30 — Bridge status envelopes require own data fields

`BridgeService` previously validated only the nested signed quote in a 1Click
execution-status response. `mapStatus()` then read `status` and `swapDetails`
through ordinary property access, so an inherited or accessor field could
cross the provider boundary and be persisted as user-visible bridge state;
the signed quote evidence itself could also be inherited.

Status verification now requires own data properties for `quoteResponse`,
`status`, and `swapDetails`. Inherited and accessor fields fail with the
existing generic invalid-execution-status error without invoking getters;
normal provider responses and omitted optional transaction hashes are
unchanged.

*Verified:* red-first public Bridge refresh regressions first accepted an
inherited or accessor status, inherited swap details, and inherited signed
quote evidence; the corrected path rejects all four and leaves the persisted
record awaiting deposit. Removing each own-data guard independently fails its
regression. No browser, network, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-30 — Street ground layers claim ownership before setup

`StreetScene.drawGround()` previously created a tilemap layer, configured its
depth and collision, and only then assigned `this.ground`. If either Phaser
setup call threw during Scene construction, the created layer was unreachable
from the existing partial-create cleanup path and could remain alive.

The layer is now assigned to the Scene-owned ground slot immediately after
creation, before styling and collision setup. Rendering and collision data are
unchanged; a failed setup remains recoverable by `cleanShutdown()`.

*Verified:* a red-first World presentation regression makes collision setup
throw and observes the created layer missing from Scene ownership on the old
path. The corrected test retains it. The full World suite passes 24 files /
264 tests; World typecheck, invariants and diff hygiene pass. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Malformed swap bigint fields stay inside the PrivacyError boundary

`BackendPrivacyClient.prepareSwap()` previously called `BigInt()` directly for
the backend's `buyAmount` and nested relay-fee `amount`. A malformed successful
response such as the fractional string `1.5` therefore escaped as a raw
JavaScript `SyntaxError` instead of the generic `PrivacyError('unknown')` used
for invalid private-service responses. That exposed parser/runtime details to
callers and made malformed swap responses behave differently from the other
validated response fields.

Swap bigint parsing now maps bigint conversion failures to the existing generic
invalid-response error. Valid decimal and bigint-sized values retain their
existing mapping; semantic amount bounds remain enforced by the operations
layer and are unchanged.

*Verified:* red-first public BackendPrivacyClient regressions cover malformed
`buyAmount` and nested fee `amount`; both leaked `SyntaxError` before the
parser guard and now reject with `kind: 'unknown'`. The focused backend-client
suite passes 37 tests. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-30 — Street door overlays claim Phaser objects before styling

`StreetScene.createDoorOverlays()` previously stored each image only after
`setDisplaySize()` and `setDepth()` completed. If either Phaser presentation
setter threw during Scene construction, the image had already been created but
was absent from `doorOverlays`; partial-create cleanup therefore could not
destroy it.

Door images are now added to the Scene-owned overlay collection immediately
after construction, before styling setters run. Existing rendering geometry
and normal teardown are unchanged, while a failed setter leaves the object
reachable by the existing cleanup path.

*Verified:* a red-first World presentation regression makes the first styling
setter throw and observes the created overlay missing from the ownership list
on the old path. The corrected test retains it for cleanup. The full World
suite passes 24 files / 263 tests; World typecheck, invariants and diff
hygiene pass. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-30 — Bridge status transaction hashes require own data fields

`BridgeService` previously accepted a status transaction entry whenever
`'hash' in entry` was true. A malformed or prototype-polluted 1Click response
could therefore supply an inherited hash, or an accessor whose getter ran
during status mapping, and have that value persisted and displayed as deposit
or settlement evidence.

Status mapping now requires an own data `hash` property before bounded hash
validation. Inherited and accessor hashes fail with the existing generic
invalid-execution-status error without invoking a getter; valid own string
hashes and empty transaction lists are unchanged.

*Verified:* red-first public Bridge refresh regressions first accepted an
inherited destination hash and an accessor hash; the corrected path rejects
both and leaves the persisted record awaiting deposit. The focused Bridge
suite passes 93 tests. No browser, network, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Interrupted Lobby joins cancel their welcome timer

`LobbyClient.connect()` raced the welcome wait against its disconnect
interrupt, but the welcome wait owned a separate timeout. When a caller
disconnected after the room joined but before the server identity arrived,
the outer join rejected while the timeout remained scheduled until its full
configured delay. Repeated interrupted joins could therefore retain timers
and their closures long after the client had retired the room.

The interrupt promise now belongs to `#awaitWelcome()` itself. Its `finally`
always clears the timeout whether welcome, timeout, room interruption or a
transport failure wins; normal timeout and identity semantics are unchanged.

*Verified:* a red-first fake-timer regression leaves the welcome message
pending, disconnects the joined client, and observes one timer still live on
the old path. The corrected path rejects the join and leaves zero timers.
The full Lobby suite passes 10 files / 225 tests; Lobby typecheck,
invariants and diff hygiene pass. No browser, external provider, RPC, wallet,
proof, signature, funds or transaction was used.

### 2026-08-30 — Pool fee wire values require decimal syntax

`BackendPrivacyClient.asUint256()` used `BigInt()` and range checks alone for
the backend's decimal-string `feeAmount`. JavaScript's bigint parser accepts
whitespace and signed forms, so a response containing only spaces was silently
converted to `0n` and published as a valid zero pool fee; `+6` was likewise
accepted as six. This made malformed pool configuration cross the browser
privacy boundary.

The parser now requires one or more decimal digits before applying the existing
uint256 bounds. Leading-zero decimal strings remain accepted, while whitespace,
signs and fractional syntax fail with the existing generic protocol error.

*Verified:* red-first BackendPrivacyClient regressions prove whitespace and
signed values were accepted before the guard and now reject; zero, leading-zero
decimal, maximum uint256, negative and above-uint256 cases retain their
intended outcomes. The focused BackendPrivacyClient suite passes 35 tests; the
Privacy suite passes 9 files / 219 tests. Package typecheck, invariants and
diff hygiene pass. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-30 — Wallet balance reads reject negative amounts

`WalletApiPrivacyOperations.balances()` converted each wallet-reported
`balance` with `BigInt()` but did not reject a negative value. A malformed or
hostile Wallet API response could therefore publish an impossible negative
private balance to the shell, where it was formatted as user funds and used by
asset selection logic.

Balance mapping now rejects negative amounts with the existing generic
`PrivacyError('unknown')`; zero and positive values retain the existing
aggregate-balance semantics. No product-level cap is imposed on user funds.

*Verified:* a red-first public Wallet API regression returned `balance: '-1'`
and observed `total: -1n` before the guard; it now rejects. Removing the
guard reproduces the failure. The focused Wallet API suite passes 74 tests;
the full Privacy suite passes 9 files / 218 tests. Package typecheck,
invariants and diff hygiene pass. No browser, external provider, RPC, wallet,
proof, signature, funds or transaction was used.

### 2026-08-30 — Avatar Studio lifecycle callbacks cannot publish after teardown

`createAvatarStudioController.enter()` and `leave()` changed lifecycle state,
then invoked their synchronous `onEnter`/`onExit` callbacks before publishing
the transition and emitting the corresponding event. If a callback destroyed
the controller during that handoff, the method resumed and published a stale
state or emitted `avatar-studio:entered`/`avatar-studio:exited` after teardown.
An exit callback that re-entered would likewise leave the outer exit event
describing the wrong transition.

Both methods now recheck lifecycle ownership after the callback. A destroyed
controller, or an exit callback that synchronously re-enters, suppresses the
stale outer publication/event; ordinary enter/exit ordering is unchanged.

*Verified:* red-first public regressions destroy the controller from
`onEnter` and `onExit`; before the guard each leaked a post-teardown state
publication, while after the guard neither leaked a snapshot nor lifecycle
event. The focused Avatar Studio suite passes 27 tests and the full World
suite passes 24 files / 262 tests. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-30 — Failed remote avatar removals must not be reused

The remote avatar layer retained a child whose removal had thrown in its
active avatar map. If that peer ID reappeared before cleanup succeeded, the
reconciliation loop treated the failed child as live and reused it, even
though its sprite or timer could already be partially destroyed. A repeated
cleanup failure could also be lost, leaving the old child without a retry
owner.

Failed removals now move to a retry-only ownership map. Each later snapshot
retries those children before creating replacements; an ID with an unresolved
cleanup is skipped rather than presented with the failed child. The latest
validated peer snapshot still advances, and layer destruction attempts both
active and retry-only children. Timer ownership is retained when Phaser
rejects timer removal so subsequent cleanup can retry it. Cleanup errors are
still surfaced as the existing single error or `AggregateError`, and all
other omitted children are attempted.

*Verified:* red-first public regressions cover a timer removal that throws
once (empty snapshot, then same-ID reappearance creates a fresh sprite only
after retry) and a timer removal that throws repeatedly (same-ID reappearance
retries without creating or reusing a child, and final destroy retries the
owned child). The focused remote-avatar suite passes 15 tests; the full World
suite passes 24 files / 260 tests. No browser, external provider, RPC,
wallet, proof, signature, funds or transaction was used.


## 6. Findings log

### 2026-08-30 — Browser relay fee tokens require strict felt encoding

`WalletApiPrivacyOperations.validateRelayFee()` previously compared the
external relay token with `sameAddress()`, whose `BigInt` coercion accepts
decimal strings and an uppercase `0X` prefix. A malformed backend or gateway
response could therefore match the configured token numerically while the
noncanonical token crossed into the Wallet API fee action.

Relay fee validation now requires the token to pass the existing strict felt
encoding rule before numeric comparison. Lowercase `0x` with uppercase hex
digits remains valid; decimal and uppercase-prefix encodings fail before a
prepared batch is returned. Fee recipient, amount, authorization and expiry
checks are unchanged.

*Verified:* red-first public regressions cover decimal and uppercase-prefix
tokens on ordinary transfer and quote-bound swap paths, with rejection before
wallet proving; a canonical lowercase-prefix token with uppercase hex digits
remains accepted. The focused Wallet API suite passes 73 tests. No browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.


## 6. Findings log

### 2026-08-30 — Issued fee authorizations require a safe block expiry

`BackendApi.fee()` and swap preparation formed authorization expiry with an
unchecked `issuedAtBlock + proofValidityBlocks` number addition. Although the
RPC adapter validates each input as a nonnegative safe integer, their sum can
round above `Number.MAX_SAFE_INTEGER`. The API then returned `200` and issued
an authorization whose expiry was unsafe; the later submission validator
rejected that same authorization as a claim mismatch.

Both issuance paths now reject an unsafe expiry before constructing or issuing
the authorization. The exact safe-integer boundary remains accepted, and
submission freshness behavior is unchanged.

*Verified:* red-first public Backend regressions set the block to
`Number.MAX_SAFE_INTEGER` with a one-block validity window and assert generic
upstream failure plus zero authorization issuance for ordinary and swap
routes. Matching cases at `Number.MAX_SAFE_INTEGER - 1` remain successful with
the exact safe expiry. Backend focused tests and diff hygiene pass; no
browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.*



### 2026-08-30 — AVNU nested executor call targets require nonzero felts

The Backend swap-preparation boundary checked each AVNU executor call target
with the generic felt rule, which accepts zero. A malformed plan could
therefore return `200`, issue a fee authorization and serialize an inner call
to `0x0`, even though the Wallet API rejects that target before handoff.

Nested executor call targets now require a nonzero Stark field felt before the
paymaster or authorization step. Selector validation remains felt-only; this
lane does not infer an additional nonzero-selector policy.

*Verified:* red-first Backend regressions cover `0x0`, `0x00` and
`0x00000000`; each previously returned `200` and issued an authorization, and
now returns the existing malformed-AVNU `502` without calling the paymaster
or authorization codec. Backend tests, typecheck, invariants and diff
hygiene pass. No browser, external provider, RPC, wallet, proof, signature,
funds or transaction was used.*


## 6. Findings log

### 2026-08-30 — Issued fee authorizations require a safe block expiry

`BackendApi.fee()` and swap preparation formed authorization expiry with an
unchecked `issuedAtBlock + proofValidityBlocks` number addition. Although the
RPC adapter validates each input as a nonnegative safe integer, their sum can
round above `Number.MAX_SAFE_INTEGER`. The API then returned `200` and issued
an authorization whose expiry was unsafe; the later submission validator
rejected that same authorization as a claim mismatch.

Both issuance paths now reject an unsafe expiry before constructing or issuing
the authorization. The exact safe-integer boundary remains accepted, and
submission freshness behavior is unchanged.

*Verified:* red-first public Backend regressions set the block to
`Number.MAX_SAFE_INTEGER` with a one-block validity window and assert generic
upstream failure plus zero authorization issuance for ordinary and swap
routes. Matching cases at `Number.MAX_SAFE_INTEGER - 1` remain successful with
the exact safe expiry. Backend focused tests and diff hygiene pass; no
browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.*


## 6. Findings log


## 6. Findings log

### 2026-08-30 — Remote avatar removal attempts every child cleanup

`createRemoteAvatarLayer.render()` removed omitted peers directly in a loop.
If one timer or sprite destructor threw, the loop aborted before later omitted
avatars were retired, and the authoritative peer map was never advanced. A
single presentation cleanup failure could therefore leave stale remote objects
visible and mask cleanup failures for the rest of the snapshot.

Removal now attempts every omitted avatar, retains any failed object for a
future retry, advances the authoritative snapshot, and rethrows one cleanup
error unchanged or multiple as an `AggregateError`. Existing-avatar
presentation and explicit layer-destroy ownership remain attempt-all and
idempotent.

*Verified:* public regressions omit two peers while the first destructor throws;
both cleanup calls now occur and the retained map clears. A second regression
throws from both destructors and confirms `AggregateError` after both attempts.
The focused remote-avatar suite passes 13 tests; the full World suite passes
24 files / 258 tests. World typecheck, all 13 invariants and diff hygiene pass.
No browser, network, wallet, RPC, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Vite proxy-boundary tests must isolate dependency optimization

The exact `/api` proxy test created a full Vite development server using the
production development config, which includes Phaser dependency optimization.
Vite's asynchronous scanner/esbuild lifecycle is independent of the HTTP
requests and `vite.close()` waits for it; repeated isolated runs intermittently
hung in teardown until the 15-second test timeout. This was a test-fixture
lifecycle trap, not a proxy matcher failure.

The test now disables dependency optimization only on its inline Vite server.
It still exercises the real configured proxy and asserts `/api` reaches the
fake backend while `/apis` and `/api2` do not. The production Vite config and
runtime optimization remain unchanged.

*Verified:* the unmodified fixture passed once and then timed out on its
second repeated run at `vite.close()`. The corrected exact test passed five
consecutive runs. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.*


### 2026-08-30 — Relay authorizations must contain non-whitespace data

`WalletApiPrivacyOperations.validateRelayFee()` previously rejected only an
empty authorization string. A relay response containing spaces, tabs or
newlines therefore produced a reviewable prepared batch and could cross into
wallet proof generation even though the backend's authorization verifier
would reject the token after the private proof was created. This is an
external-response validation defect at the wallet handoff boundary.

Relay fee validation now requires a string whose trimmed length is nonzero,
while preserving the original opaque authorization token for submission.
Ordinary private transfers and quote-bound swaps use the same validation;
their fee token, recipient, amount and expiry checks are unchanged.

*Verified:* red-first public regressions supplied whitespace-only
authorizations (`" \\t\\n"`) on both transfer and swap fee paths; both resolved
before the fix and now reject before `strk20PrepareInvoke`. The focused wallet
API suite passes 68 tests. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.


## 6. Findings log


## 6. Findings log

### 2026-08-30 — Remote avatar ownership is registered before first presentation

`createRemoteAvatarLayer.render()` created a new sprite, presented its first
pose, and only then stored the avatar in its ownership map. If a Phaser
presentation call or timer setup threw during that first update, the source
publication failed with a live sprite that `destroy()` could not reach. A later
snapshot created a second sprite while the first remained orphaned.

New avatars are now registered before `updateAvatar()` runs. A failed first
presentation therefore remains owned for teardown and can be retried by the
next authoritative snapshot; existing-avatar updates, removal, and aggregate
cleanup semantics are unchanged.

*Verified:* a public regression makes the first new-avatar presentation throw,
then republishes the same peer and confirms no second sprite is created; final
destroy reaches the original sprite exactly once. The focused remote-avatar
suite passes 11 tests. No browser, network, wallet, RPC, proof, signature,
funds or transaction was used.*

### 2026-08-30 — Vite proxy-boundary tests must isolate dependency optimization

The exact `/api` proxy test created a full Vite development server using the
production development config, which includes Phaser dependency optimization.
Vite's asynchronous scanner/esbuild lifecycle is independent of the HTTP
requests and `vite.close()` waits for it; repeated isolated runs intermittently
hung in teardown until the 15-second test timeout. This was a test-fixture
lifecycle trap, not a proxy matcher failure.

The test now disables dependency optimization only on its inline Vite server.
It still exercises the real configured proxy and asserts `/api` reaches the
fake backend while `/apis` and `/api2` do not. The production Vite config and
runtime optimization remain unchanged.

*Verified:* the unmodified fixture passed once and then timed out on its
second repeated run at `vite.close()`. The corrected exact test passed five
consecutive runs. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Paymaster fee tokens require strict felt encoding

`BackendApi.fee()` and swap preparation compared the paymaster's returned
`fee.token` with `sameAddress()`, whose `BigInt` coercion accepted decimal
strings, numbers, and an uppercase `0X` prefix when they represented the
configured token. The API could therefore issue a successful authorization
and expose a token encoding the browser and Wallet API do not accept.

Both fee paths now require the provider token to pass the existing strict
lowercase-`0x` Stark field validator before numeric address comparison. The
existing token-match behavior and `400` response contract remain unchanged;
recipient validation still rejects non-string values safely through its type
guard.

*Verified:* red-first Backend regressions cover decimal-string, numerically
equivalent, uppercase-prefix, and object provider tokens on ordinary fee
estimation and swap preparation, asserting no authorization issuance. Before
the guard, the three coercible forms returned `200` in each path; after it,
all eight cases pass with no authorization for any malformed value. No
browser, external provider, RPC, wallet, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Paymaster fee recipients require a nonzero felt

`BackendApi.fee()` and swap preparation validated the paymaster's returned fee
recipient with the generic felt rule. That rule accepts zero, so a malformed
provider response could issue an authorization directing the private fee
withdrawal to `0x0` (including leading-zero encodings), where it cannot
reimburse the paymaster.

Both fee paths now require a nonzero Stark field felt for the provider
recipient. The existing fee-token, amount, authorization and status contracts
are unchanged; malformed zero recipients return the existing `400` validation
response before authorization issuance.

*Verified:* red-first Backend regressions cover `0x0`, `0x00` and
`0x00000000` on ordinary fee estimation and swap preparation. Before the
guard, all six returned `200` and issued authorizations; after it, all six
return `HTTP_400` and issue none. No browser, external provider, RPC, wallet,
proof, signature, funds or transaction was used.*

### 2026-08-30 — Lobby peer deliveries freeze shared snapshots



## 6. Findings log

### 2026-08-30 — Browser pool fees require uint256 bounds

`BackendPrivacyClient.config()` converted the backend's decimal `feeAmount`
with `BigInt()` alone. Negative values and values above the pool's `u256`
fee domain therefore crossed the browser privacy seam as valid
`PoolConfig` data. Downstream fee-ceiling logic only imposed an upper bound,
so a negative fee could appear in review and pass the pre-wallet check.

Config parsing now requires `0 <= feeAmount <= 2^256 - 1`; zero remains valid
for governance-configured fees and the maximum value remains representable.
Malformed strings and out-of-range values use the existing generic invalid
response error. Other response amounts and schemas are unchanged.

*Verified:* red-first public regressions cover zero, maximum uint256, negative
and `2^256` fee values; the two invalid cases resolved before the guard and
now reject. The focused BackendPrivacyClient suite passes 31 tests; the full
Privacy suite passes 9 files / 209 tests, with package typecheck, invariants
and diff hygiene green. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Paymaster fee recipients require a nonzero felt

`BackendApi.fee()` and swap preparation validated the paymaster's returned fee
recipient with the generic felt rule. That rule accepts zero, so a malformed
provider response could issue an authorization directing the private fee
withdrawal to `0x0` (including leading-zero encodings), where it cannot
reimburse the paymaster.

Both fee paths now require a nonzero Stark field felt for the provider
recipient. The existing fee-token, amount, authorization and status contracts
are unchanged; malformed zero recipients return the existing `400` validation
response before authorization issuance.

*Verified:* red-first Backend regressions cover `0x0`, `0x00` and
`0x00000000` on ordinary fee estimation and swap preparation. Before the
guard, all six returned `200` and issued authorizations; after it, all six
return `HTTP_400` and issue none. No browser, external provider, RPC, wallet,
proof, signature, funds or transaction was used.*

### 2026-08-30 — Lobby peer deliveries freeze shared snapshots

`LobbyClient.peers()` returned a fresh array but left both that array and its
entry objects mutable. `#emitPeers()` then delivered the same snapshot to every
listener, so an earlier subscriber could change coordinates, pose, sprite or
membership before a later subscriber received it. This violated the readonly
peer seam at runtime and could make shell consumers disagree about one state
update.

Peer snapshots now freeze the array and each entry before delivery. This is
deliberately an immutability-only boundary fix: the World-owned
`reconcileRemotePeers()` remains responsible for validating untrusted runtime
identity, coordinates, facing and sprite values because the Lobby client does
not possess the server's trusted custom sprite allowlist.

*Verified:* a red-first public regression mutates a snapshot in listener A and
confirms listener B still receives the original one-entry snapshot, with both
runtime layers frozen. The focused client suite passes 59 tests; the full Lobby
suite passes 10 files / 224 tests. Lobby typecheck, all 13 invariants and diff
hygiene pass. No browser, network, wallet, RPC, proof, signature, funds or
transaction was used.*


## 6. Findings log




### 2026-08-30 — World remote-peer sources sanitize before replay

The Shell's Lobby-to-World adapter published raw peer fields into the
World-owned `RemotePeerSource`. Its retained source copied and cast those
fields without validation, so a direct source subscriber could receive a
malformed ID, NaN/Infinity coordinate, illegal facing or arbitrary sprite.
The renderer validated later, but that left the public source seam inconsistent
for any other World consumer.

The source now routes initial and published snapshots through the existing
`reconcileRemotePeers()` policy before freezing them. Invalid identity,
position or facing entries are dropped and unknown sprites use the approved
local fallback. The fixed World registry remains authoritative; no server
operator-specific Lobby sprite list is inferred in this package.

*Verified:* red-first World and Web regressions inject malformed peer fields
through the public retained-source paths and previously observed all of them;
the corrected paths expose only the valid fallback entry. The focused World
source suite passes 16 tests and the focused Presence suite passes 45 tests.
No browser, network, wallet, RPC, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Lobby peer deliveries freeze shared snapshots

`LobbyClient.peers()` returned a fresh array but left both that array and its
entry objects mutable. `#emitPeers()` then delivered the same snapshot to every
listener, so an earlier subscriber could change coordinates, pose, sprite or
membership before a later subscriber received it. This violated the readonly
peer seam at runtime and could make shell consumers disagree about one state
update.

Peer snapshots now freeze the array and each entry before delivery. This is
deliberately an immutability-only boundary fix: the World-owned
`reconcileRemotePeers()` remains responsible for validating untrusted runtime
identity, coordinates, facing and sprite values because the Lobby client does
not possess the server's trusted custom sprite allowlist.

*Verified:* a red-first public regression mutates a snapshot in listener A and
confirms listener B still receives the original one-entry snapshot, with both
runtime layers frozen. The focused client suite passes 59 tests; the full Lobby
suite passes 10 files / 224 tests. Lobby typecheck, all 13 invariants and diff
hygiene pass. No browser, network, wallet, RPC, proof, signature, funds or
transaction was used.*


## 6. Findings log

### 2026-08-30 — Private swap outputs require uint256 bounds

`WalletApiPrivacyOperations.validateSwapPlan()` previously checked only that
the external swap plan's `buyAmount` was a positive bigint. A malformed AVNU
or backend response above the STRK20 `u256` range could therefore become the
reviewed expected output and protected minimum, crossing quote admission with
an impossible amount.

Swap-plan admission now requires `0 < buyAmount <= 2^256 - 1`. The maximum
valid value remains accepted; values above it fail with the existing malformed
expected-output error before any wallet handoff. Other quote, fee, executor,
expiry and action-binding checks are unchanged.

*Verified:* red-first public regressions prove that `2^256 - 1` is accepted
and `2^256` is rejected before a review is returned. The focused Wallet API
suite passes 65 tests; the full Privacy suite passes 9 files / 205 tests,
with package typecheck, invariants and diff hygiene green. No browser,
external provider, RPC, wallet, proof, signature, funds or transaction was
used.*


## 6. Findings log

### 2026-08-30 — Backend privacy responses require own data fields

`BackendPrivacyClient` validated response values through ordinary property
lookup. A same-origin prototype pollution could therefore supply an omitted
config, public-key, relay-fee, submission, or swap field through
`Object.prototype`; an own accessor could also run during parsing. This let a
malformed backend response cross the browser privacy boundary and made the
result depend on ambient object state.

The client now requires every response field to be an own data property before
type conversion, including nested swap fee and executor-call records. Accessor
properties are rejected without invoking their getter; existing response
shapes and injected fetchers are unchanged.

*Verified:* red-first public regressions polluted `Object.prototype` for
config, public-key, nested fee, and nested executor-call fields; each
previously resolved on the current base and now rejects with the generic
`unknown` protocol error. A separate accessor regression confirms the getter
is not invoked. Privacy tests pass 27 tests; no browser, external provider,
RPC, wallet, proof, signature, funds or transaction was used.*

### 2026-08-30 — AVNU swap planning stops between provider awaits

`AvnuSwapPlanner.prepare()` passed its cancellation signal into the AVNU
quote and executor-call helpers, but did not recheck the signal after either
await. A cancellation-ignoring quote lookup could therefore trigger a second
provider call to construct private executor calldata, and a cancellation-
ignoring call-construction request could still publish a prepared swap plan.

The planner now rechecks the same signal after quote retrieval and after call
construction, throwing the signal's exact reason before starting the next
provider step or mapping/publishing the plan. The AVNU request shapes,
mainnet-chain checks, protected minimum and Wallet API handoff are unchanged.

*Verified:* red-first public adapter regressions abort immediately before a
deferred quote settles and immediately before a deferred executor-call plan
settles. Before the guards, the first case still called `quoteToCalls` and the
second returned a plan; after the guards both reject with the exact abort
reason and no stale executor plan is mapped. The focused Backend adapter suite
passes 49 tests. No browser, external provider, wallet, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Presence destroy completes ownership cleanup after disconnect failure

`PresenceController.destroy()` used `Promise.all()` and performed its final
ownership cleanup only after that promise fulfilled. A client whose
`disconnect()` rejected therefore left the controller retaining its client



## 6. Findings log

### 2026-08-30 — Paymaster fee amounts require runtime bigint validation

`BackendApi.fee()` and swap preparation compared the untrusted paymaster fee
amount directly with `bigint` policy limits but never checked its runtime
type. JavaScript relational coercion allowed fractional or nonnumeric strings,
numbers, `NaN` and objects to pass both comparisons. The API could then issue
an authorization and return a successful response containing an unusable fee
amount; later authorization verification or relay handling would disagree
with that earlier success.

Both fee paths now require the provider amount to be a runtime `bigint` before
policy comparison or authorization construction. Malformed provider data
therefore follows the existing opaque upstream-failure response, while valid
fee bounds, authorization claims and swap behavior are unchanged.

*Verified:* red-first Backend regressions cover fractional and nonnumeric
strings, a number, `NaN` and an object on both ordinary fee estimation and
swap preparation. Before the guard, all ten cases returned `200` and issued
authorizations; after it, all return generic `502` with zero authorization
issuance. The Backend suite passes 174 tests; Backend typecheck, invariants and
diff hygiene pass. No browser, external provider, wallet, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — AVNU swap planning stops between provider awaits

`AvnuSwapPlanner.prepare()` passed its cancellation signal into the AVNU
quote and executor-call helpers, but did not recheck the signal after either
await. A cancellation-ignoring quote lookup could therefore trigger a second
provider call to construct private executor calldata, and a cancellation-
ignoring call-construction request could still publish a prepared swap plan.

The planner now rechecks the same signal after quote retrieval and after call
construction, throwing the signal's exact reason before starting the next
provider step or mapping/publishing the plan. The AVNU request shapes,
mainnet-chain checks, protected minimum and Wallet API handoff are unchanged.

*Verified:* red-first public adapter regressions abort immediately before a
deferred quote settles and immediately before a deferred executor-call plan
settles. Before the guards, the first case still called `quoteToCalls` and the
second returned a plan; after the guards both reject with the exact abort
reason and no stale executor plan is mapped. The focused Backend adapter suite
passes 49 tests. No browser, external provider, wallet, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Presence destroy completes ownership cleanup after disconnect failure

`PresenceController.destroy()` used `Promise.all()` and performed its final
ownership cleanup only after that promise fulfilled. A client whose
`disconnect()` rejected therefore left the controller retaining its client
reference and replacement state, skipped listener cleanup, and made repeated
destroy calls return the same unfinished rejection. A client that threw
synchronously could reject before the destroy promise was retained at all.

Destroy now normalizes synchronous disconnect throws, waits for both the
current client and any replacement teardown with `Promise.allSettled()`, then
always clears client, replacement and subscriber ownership. It preserves one
cleanup error unchanged and combines multiple failures in an `AggregateError`.

*Verified:* red-first public regressions cover asynchronous disconnect
rejection and synchronous disconnect throw. Before the fix, the synchronous
case resolved on the repeated destroy call; after the fix, both calls reject
with the same error, disconnect runs once, and peer ownership is cleared.
The focused Presence suite passes 44 tests; Web typecheck, invariants and diff
hygiene pass. No browser, lobby server, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Wallet session guards synchronous subscription handoff



### 2026-08-30 — Lobby welcome timeout is bounded by the platform timer contract

`LobbyClient` copied `welcomeTimeoutMs` directly into `setTimeout`. NaN,
infinity, negative or fractional values, and delays beyond the platform timer
ceiling can clamp or wrap into an immediate timer, allowing `connect()` to
proceed before the server-issued game identity arrives. That temporarily
breaks the client's self-filtering guarantee and makes a configured timeout
mean something different across runtimes.

The constructor now requires a nonnegative safe integer at or below the
platform timer ceiling. Zero remains an intentional opt-out and the exact
ceiling remains valid; the documented option now states this bounded-integer
contract.

*Verified:* public Lobby-client cases reject NaN, infinity, -1, 1.5, one above
the timer ceiling and `Number.MAX_SAFE_INTEGER`, while accepting zero and the
exact ceiling. The focused Lobby client suite passes 58 tests. No browser,
network, wallet, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Presence destroy completes ownership cleanup after disconnect failure

`PresenceController.destroy()` used `Promise.all()` and performed its final
ownership cleanup only after that promise fulfilled. A client whose
`disconnect()` rejected therefore left the controller retaining its client
reference and replacement state, skipped listener cleanup, and made repeated
destroy calls return the same unfinished rejection. A client that threw
synchronously could reject before the destroy promise was retained at all.

Destroy now normalizes synchronous disconnect throws, waits for both the
current client and any replacement teardown with `Promise.allSettled()`, then
always clears client, replacement and subscriber ownership. It preserves one
cleanup error unchanged and combines multiple failures in an `AggregateError`.

*Verified:* red-first public regressions cover asynchronous disconnect
rejection and synchronous disconnect throw. Before the fix, the synchronous
case resolved on the repeated destroy call; after the fix, both calls reject
with the same error, disconnect runs once, and peer ownership is cleared.
The focused Presence suite passes 44 tests; Web typecheck, invariants and diff
hygiene pass. No browser, lobby server, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Wallet session guards synchronous subscription handoff

`createWalletSession()` captured the connection account and chain before
registering its Wallet Standard listener. A connection port is allowed to
replay its current event synchronously from `subscribe()`, so an account
replacement or account removal during registration was processed by the
listener and then overwritten by the stale continuation. The session could
therefore expose the old account with replacement operations, or reconnect an
account that had already been removed.

The handoff now rechecks `destroyed`, generation and connection ownership
after `subscribe()` returns, then reads and validates a fresh snapshot before
constructing or publishing initial operations. A stale continuation returns
without disturbing replacement state; an already-retired port is destroyed
once. This preserves the existing synchronous listener and Wallet API
ownership boundary.

*Verified:* red-first public regressions reproduced synchronous account
replacement and synchronous account removal during subscription; both failed
on the old continuation and pass with the post-subscribe ownership guard.
Session tests, privacy gates, typechecks, invariants and diff hygiene are
recorded on the candidate. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-30 — Wallet session cleanup cannot mask connection authority

Automatic cleanup of a stale or invalid WalletConnectionPort could throw from
`destroy()`. A stale connect result then rejected with the cleanup error
instead of preserving the already-retired session, and a `getSnapshot()`
failure could remain stuck in `connecting` because cleanup threw before the
failure state was published. Repeating cleanup could also invoke provider
teardown twice.

Automatic retirement now clears ownership first, attempts cleanup and destroy
at most once, and suppresses cleanup errors. The original stale snapshot or
mapped connection error remains authoritative. Explicit `disconnect()` and
`destroy()` use a separate path that attempts both teardown steps and still
surfaces the first explicit cleanup error.

*Verified:* red-first public regressions make stale destroy throw after a
pending connect is disconnected, and make both snapshot read and destroy
throw. The corrected tests preserve the retired snapshot, publish `failed`,
clear operations, and retain the mapped original error. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Explicit wallet teardown publishes retired state before errors

`session.disconnect()` and `session.destroy()` cleared connection authority
inside explicit retirement, but published `selection-required` only after that
retirement returned. An unsubscribe or connection `destroy()` error therefore
left the public snapshot claiming the old account was connected while
operations had already been cleared; `destroy()` could also skip listener
clearing and remain unsafe to repeat.

Explicit teardown now records cleanup errors, completes the public retired
state transition and listener clearing, then preserves the first explicit
error. `disconnect()` still reports provider teardown errors, and `destroy()`
remains idempotent after its first attempt.

*Verified:* public regressions inject unsubscribe and destroy failures. Both
now leave a selection-required/null-account snapshot with disconnected
operations; disconnect rethrows the exact cleanup error and destroy remains
safe on repeat. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.*


## 6. Findings log

### 2026-08-30 — Backend request records require own required fields

The Backend request-record helper treated its field list only as an
allowlist. Required values were read through normal prototype lookup, so a
polluted `Object.prototype.v = 1` made an otherwise empty pool-config request
pass version validation and reach the RPC. The same gap applied to route,
artifact and nested request fields.

`requireRecord()` now requires every listed field to be an own property as
well as rejecting unknown own fields. This keeps omitted request data from
being supplied by inherited properties and preserves the existing strict
route/artifact schemas.

*Verified:* red-first public regressions polluted `Object.prototype.v` for an
empty pool-config request and `Object.prototype.route` for a fee request with
the route omitted; both previously returned `200` and reached an external
port. After the fix both return `400`, with zero RPC or paymaster calls.
Backend tests pass 162 tests; package typecheck, invariants and diff hygiene
pass. No browser, provider, RPC, wallet, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Bridge status optional fields ignore inherited properties

Bridge persistence validated optional status fields with the `in` operator.
If same-origin code polluted `Object.prototype` with `depositTxHash`,
`settlementTxHash` or `strkReceived`, a valid status that omitted that field
could inherit the malformed value, fail deserialization and cause
`LocalBridgeStore` to clear the signed resume evidence.

Status validation now checks each optional field only when it is an own
property of the decoded status object. Genuine persisted hashes and bigint
amounts continue to round-trip unchanged, and inherited values cannot alter a
record's validity.

*Verified:* red-first public regressions set each of the three inherited
fields on `Object.prototype`; before the fix, deserialization returned null
and the local store cleared the valid record. After the fix, all three records
deserialize and load unchanged, with the stored signed evidence retained.
Bridge tests pass 91 tests; package typecheck and diff hygiene pass. No
browser, provider, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-30 — Bridge bigint revival ignores inherited markers

Bridge persistence used the `in` operator to recognize its JSON bigint
wrapper. If any same-origin code polluted `Object.prototype` with a string
`$strkworldBigInt`, every decoded object inherited that marker and was
converted to a bigint. A valid resumable record then failed its shape checks
and `LocalBridgeStore` cleared the signed evidence as corrupt.

The reviver now accepts the marker only when it is an own property of the
decoded object. Genuine serialized bigint wrappers continue to revive, while
inherited markers of string, numeric or object types are ignored.

*Verified:* the public persistence regression failed red for an inherited
string marker and passed green for all three inherited marker types after the
own-property guard; each test restores the previous prototype descriptor in a
`finally` block. The Bridge suite and workspace gates are recorded with this
commit. No browser, provider, RPC, wallet, proof, signature, funds or
transaction was used.*


### 2026-08-30 — Persisted Bridge status is validated before resume

`deserializeBridgeRecord()` previously checked only the signed quote's small
identity subset, timestamps and `amountIn`. It returned any decoded `status`,



## 6. Findings log

### 2026-08-30 — Avatar Studio figure teardown must attempt every object

`createAvatarStudioFigureLayer()` previously stopped at the first throwing
sprite destructor during construction-failure cleanup or normal `destroy()`.
That could mask the original construction error and leave later figure sprites
or the highlight alive; after `destroy()` set its retired flag, a later call
could not recover those objects. This is a World-owned presentation boundary,
so one Phaser object failure must not strand the rest of the layer.

Both paths now attempt every owned sprite and the highlight. Construction
preserves and rethrows its original error, while normal destruction rethrows a
single cleanup error unchanged or combines multiple failures in an
`AggregateError`; repeated destruction remains idempotent.

*Verified:* public regressions cover a throwing partial-construction destructor,
single-error normal teardown and multiple-error normal teardown. Every owned
object is attempted in each case, the original construction error remains
primary, and the focused Avatar Studio figure suite passes 8 tests. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-30 — Remote avatar teardown must survive unsubscribe errors

`createRemoteAvatarLayer().destroy()` previously marked the layer destroyed and
then called the retained source's unsubscribe before destroying any remote
sprites or the Phaser layer. A source-owned unsubscribe failure therefore
escaped part-way through teardown: every presentation object survived, while
the destroyed flag made a later cleanup call a no-op. This is a public
ownership seam because the source is injected by the Shell and the World must
retire its own presentation even when an external cleanup callback fails.

Teardown now attempts shutdown-listener removal, source unsubscribe, every
remote avatar (including its idle timer), and the layer independently. It
rethrows the one cleanup error unchanged or combines multiple failures in an
`AggregateError`; state is cleared and later destroy calls remain idempotent.
Idle callbacks also recheck the layer lifetime before touching a retired
sprite. Synchronous source replay and the pending-unsubscribe handoff are
unchanged.

*Verified:* the public regression injects an unsubscribe failure after replaying
two peers and confirms both sprites, the Phaser layer and retained peer state
are cleaned; a second regression adds a sprite failure and confirms an
`AggregateError` after all teardown attempts. The focused remote-avatar suite
passes 10 tests. No browser, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-30 — StreetScene construction failures retire partial ownership immediately

`StreetScene.create()` arms its World cleanup handler before construction, but
Phaser calls `Scene#create` directly and does not emit the Scene `shutdown`
event when that call throws. A failure after ground, player, remote-avatar,
input, outfit or room creation therefore left the partial cycle's resources,
listeners and shutdown callbacks live until an external lifecycle event that
might never arrive.

The construction sequence now runs inside a `try/catch`. A thrown create step
detaches the pending Scene cleanup handler, runs the existing idempotent World
cleanup without broadcasting Phaser `shutdown`, and rethrows the original
error. Player and ground are explicit Scene-owned resources and are destroyed
by that same cleanup. Cleanup attempts every owned destructor even when one
throws. During failed construction the original create error remains primary
and a secondary teardown error is swallowed after all attempts; during an
ordinary framework shutdown, cleanup errors are propagated (as one error or an
`AggregateError`) after all teardown has been attempted. A later framework
shutdown is harmless, and the retained Scene can create a fresh cycle normally.

*Verified:* the red lifecycle regression injects a failure at `createAvatarStudio`
and does not emit `shutdown`; it observes immediate destruction of the player,
ground, remote layer, room controller, input ownership, outfit binding and
overlays, with the original error preserved. Later shutdown/cleanup does not
double-destroy. A throwing ground destructor does not mask the original create
error or prevent later teardown, while a normal shutdown propagates that
cleanup error after attempting every resource. A subsequent create/ shutdown
cycle cleans normally. The
focused StreetScene lifecycle suite passes 15 tests; World typecheck and the
remaining workspace gates are recorded with the candidate. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-29 — Fly sanitizes private-child response headers

The Fly public edge previously copied every non-hop-by-hop response header
from the private child to the browser. A child response could therefore set
cookies, redirects, public caching, CORS permissions, content encoding,
cross-origin isolation, or arbitrary private metadata at the public origin.
That was an unnecessary response-boundary escape: the Backend JSON contract
only needs its content type and content-type protection marker, and dynamic


### 2026-08-30 — Bridge bigint revival ignores inherited markers

Bridge persistence used the `in` operator to recognize its JSON bigint
wrapper. If any same-origin code polluted `Object.prototype` with a string
`$strkworldBigInt`, every decoded object inherited that marker and was
converted to a bigint. A valid resumable record then failed its shape checks
and `LocalBridgeStore` cleared the signed evidence as corrupt.

The reviver now accepts the marker only when it is an own property of the
decoded object. Genuine serialized bigint wrappers continue to revive, while
inherited markers of string, numeric or object types are ignored.

*Verified:* the public persistence regression failed red for an inherited
string marker and passed green for all three inherited marker types after the
own-property guard; each test restores the previous prototype descriptor in a
`finally` block. The Bridge suite and workspace gates are recorded with this
commit. No browser, provider, RPC, wallet, proof, signature, funds or
transaction was used.*


### 2026-08-30 — Persisted Bridge status is validated before resume

`deserializeBridgeRecord()` previously checked only the signed quote's small
identity subset, timestamps and `amountIn`. It returned any decoded `status`,
so a corrupted or tampered browser-local record could make `BridgeService.resume()`
publish a null, unknown-leg or wrong-typed progress object even though the
signed quote itself reverified. Optional transaction hashes and received
amounts crossed the same boundary without runtime type checks.

Persistence now requires one of the seven declared Bridge legs, a nonempty
message, a boolean polling flag, bounded non-whitespace transaction hashes and
a nonnegative uint256 `strkReceived` when present. Invalid records are
discarded before a store or service can resume them; all valid status shapes
continue to round-trip unchanged.

*Verified:* red-first public regressions cover null, array, primitive, invalid
leg, non-string message, non-boolean polling flag, malformed optional hashes,
non-bigint received amounts and negative received amounts. Each was accepted
by the old parser and returned by `resume()`; the corrected parser returns
null and the service resumes no record. Seven valid Bridge legs round-trip.
No browser, provider, RPC, wallet, proof, signature, funds or transaction was
used.*


### 2026-08-30 — StreetScene repeated create retires player and ground objects

`StreetScene.cleanShutdown()` previously cleared the current ground reference
and avatar visual without destroying the Phaser ground layer or local player.
`retireWorldOwnership()` deliberately invokes this cleanup during a defensive
same-instance `create()` without emitting Phaser `shutdown`, so the old display
and physics objects could remain active while the replacement cycle allocated
another player and ground.

Cleanup now owns and destroys the cycle's player and ground before dropping the
ground reference; the player ownership flag prevents a failed or later shutdown
from double-destroying a completed cycle. Ground ownership is established before
its final presentation call so a partial create can also be retired. Framework
shutdown emission, controller ordering and the replacement cycle are unchanged.

*Verified:* a public same-instance lifecycle regression first observed zero
destroy calls for the old player and ground on repeated create. The corrected
regression proves each old object is destroyed once, replacement objects remain
live until the real shutdown, and repeated cleanup does not double-destroy. The
focused lifecycle suite passes 13 tests, World passes 20 files / 193 tests and
the full workspace passes 102 files / 1,589 tests. Workspace typechecks, the
production build, all 13 invariants and diff hygiene pass. No browser, lobby,
wallet, provider, RPC, proof, signature, funds or transaction was used.


### 2026-08-30 — Starknet RPC default fetch must retain its global receiver

`StarknetRpcPoolPort` previously stored the ambient `fetch` function and later
called it as a method of the port. Browser-compatible Fetch implementations
may require `globalThis` as their receiver, so the default path threw
`TypeError: Illegal invocation` before making any JSON-RPC request. The port
now uses a small globalThis-bound wrapper for its default fetcher; explicitly
injected fetchers retain their existing call behavior and receiver.

*Verified:* a receiver-sensitive global fetch fake first rejected the default
`getBlockNumber()` call before recording a request; after the wrapper it
returned the fake JSON-RPC result and recorded exactly one request. A separate
injected-fetcher regression preserves its URL, POST behavior, response mapping
and existing port receiver. Focused adapter tests and the backend/workspace
gates are recorded on the final candidate. No real network, wallet, provider,
proof, signature, funds or transaction was used.


### 2026-08-30 — Bridge status quote envelopes fail closed before dereference

The Bridge service treated the generated 1Click status type as runtime truth.
`verifyStatusQuote()` dereferenced `raw.quoteResponse.correlationId` before
checking that the response contained an object, and `assertSignedQuote()` did
the same for its nested `quote` and `quoteRequest` objects. A malformed
provider response therefore leaked a raw `TypeError` instead of the existing
generic invalid-execution-status error, even though persistence remained
unchanged.

The status boundary now requires an object quote response with object
`quote` and `quoteRequest` containers before comparing correlation/signature
evidence or validating the signed route. Valid mismatched signed evidence
still receives the existing quote-mismatch error, while malformed status data
remains generic and fail-closed.

*Verified:* public Bridge regressions for null, array, primitive and nested
malformed `quoteResponse` values failed red with either a raw `TypeError` or
the quote-mismatch error, then passed green with the generic invalid-status
error and the retained record still awaiting deposit. The focused Bridge suite
passes 68 tests; workspace gates are recorded with this commit. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.*


### 2026-08-30 — Synchronous Bridge loader failures release ownership

Bridge runtime loading is optional and lazy, but the provider called a
Promise-typed loader before entering its rejection boundary. A synchronous
chunk/storage throw escaped the mounted app and left the loader owner marked
pending forever, so no later replacement loader could recover the route.

Loader invocation now begins inside the existing asynchronous chain. Both
synchronous and asynchronous failure reach the same isolated catch/finally,
which releases ownership without affecting wallet or app admission.

*Verified:* a public provider regression mounts a synchronously throwing loader,
then replaces it with a successful runtime loader. Before the fix the first
throw escapes and recovery never runs; afterward the app remains mounted and
the replacement service is published. The focused BridgeProvider suite passes
12 tests; Web typecheck, all 13 invariants and diff hygiene pass. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.*


### 2026-08-30 — Remote avatar replay must own shutdown before subscribe returns

`createRemoteAvatarLayer()` previously subscribed to the retained remote-peer
source before registering the Scene `shutdown` listener. Subscription replays
its current snapshot synchronously, so teardown raised during replay was
missed; the layer stayed subscribed and its sprites survived the Scene's
shutdown. The returned unsubscribe handle also does not exist until that
replay returns.

The layer now registers shutdown ownership before subscribing and keeps a
pending-unsubscribe handoff for shutdown during synchronous replay. The handle
is invoked exactly once after `subscribe()` returns, while later publications
are ignored by the destroyed guard. Existing idempotent explicit and Scene
shutdown cleanup remains unchanged.

*Verified:* a public source fake that replays one peer, fires shutdown before
returning its unsubscribe handle, and then publishes again first left the
sprite, layer and subscription alive on `origin/main`. The corrected remote
avatar suite passes 8 tests; the full World and workspace gates are recorded on
the candidate. No browser, lobby, wallet, provider, RPC, proof, signature,
funds or transaction was used.


### 2026-08-30 — The lazy demo seam owns loader failures

`PrivacyProvider` loaded the explicit local demo seam with a bare dynamic
import promise. A missing chunk, a transient Vite restart or an offline local
build therefore produced an unhandled rejection while the provider stayed on
its loading fallback forever; the application's `ErrorBoundary` cannot catch
an asynchronous loader rejection. The provider now routes the import through
`privacy/demo-loader.ts`, consumes failures with a cancellation-aware catch,
and renders a deterministic retry surface. A retry starts a new lazy attempt.
An explicit `operations` prop remains authoritative during render, so a late
failed or resolved demo attempt cannot mask a replacement real seam; cleanup
also prevents a late rejection from updating an unmounted provider.

*Verified:* public jsdom regressions cover rejected-load error UI, successful
retry, replacement by an explicit seam before the old rejection settles, and
late rejection after unmount. The focused loader suite passes 4 tests and the
Web suite passes 43 files / 493 tests. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.


### 2026-08-30 — Avatar Studio does not select after callback teardown

`createAvatarStudioController.update()` publishes a synchronous highlight
change before selecting the contacted figure. Before the guard, an
`onChange` callback could destroy the Studio during that publication, then the
same update resumed and changed the shared outfit selection, emitting
`avatar:selected` after the controller had left its lifecycle.

The update path now rechecks `destroyed` and `inRoom` after highlight
publication and before selection. The shared selection remains owned by the
Scene; no separate Shell/control-owner state exists in Avatar Studio, so there
is no additional ownership-transfer branch to guard.

*Verified:* a public regression first failed on current `origin/main` when
`onChange` destroyed the controller while highlighting figure 8; the old path
changed the selection to `avatar-8` and emitted `avatar:selected`. The corrected
Avatar Studio suite passes 25 tests. No browser, lobby, wallet, provider, RPC,
proof, signature, funds or transaction was used.


### 2026-08-30 — Fixed-room station activation rechecks authority after onChange

`createFixedRoomController.update()` publishes a synchronous `onChange` snapshot
when the player first approaches a station. Before the guard, that callback
could destroy the controller or let Shell claim control, then the suspended
`update()` resumed and still activated the station using the old authority.
The result was a `station:activated` event and input suspension after teardown,
or activation after Shell had already claimed the station.

The update path now rechecks `destroyed`, `inRoom` and `controlOwner` after
`onChange` delivery and before station admission. Normal activation ordering,
station arming and Shell ownership are unchanged.

*Verified:* public fixed-room regressions first failed on current `origin/main`
when `onChange` destroyed the controller or synchronously transferred control
to Shell; both emitted station activation despite the new authority. The
corrected fixed-room suite passes 35 tests and the World suite passes 20 files
/ 195 tests. No browser, lobby, wallet, provider, RPC, proof, signature, funds
or transaction was used.


### 2026-08-30 — PrivacyProvider renders only the current financial seam

`PrivacyProvider` copied an explicit `operations` prop into state and exposed
that state to its children. When a host replaced the seam, the provider
therefore rendered one commit with the retired instance before its effect ran;
the same stale instance remained visible while a requested lazy demo seam was
loading. A child mounting in that window could begin reads or financial work
against an authority the host had already replaced.

The provider now treats an explicit `operations` prop as authoritative during
render and bypasses any retained real seam while entering lazy demo mode. The
demo import remains lazy and still renders the supplied fallback until it
resolves; an explicit seam swap reaches the existing `PrivacyRuntime`
composition immediately.

*Verified:* public jsdom rerender regressions first observed the old seam when
changing `operations` from instance A to B and when changing from a real seam
to lazy demo. The corrected tests observe no stale child render and require
the exact synchronous loading fallback for the real-to-demo transition. The
focused PrivacyProvider suite passes 10 tests; the Web suite passes 43 files /
498 tests; the full workspace passes 102 files / 1,590 tests. All workspace
typechecks, the Web production build, 13 invariants and diff hygiene pass. No
browser wallet, provider, RPC, proof, signature, funds or transaction was
used.


### 2026-08-30 — Stale prepare cleanup cannot mask session ownership

When an in-flight `WalletSession.operations.prepare()` settled after the
account changed, the session called the returned batch's `discard()` before
returning its changed-session result. A cleanup implementation that threw
could therefore replace the authoritative `user-rejected` outcome with a raw
cleanup exception.

Stale-result cleanup is now best-effort: the exact batch is still retired, but
any cleanup exception is swallowed so the changed-session error remains the
public result. Explicit caller `PreparedBatch.discard()` retains its prior
propagation semantics.

*Verified:* a public deferred preparation regression changes accounts before a
batch whose `discard()` throws settles; it confirms one cleanup call and the
expected `user-rejected` result. Privacy and repository gates are recorded on
the final candidate. No browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.*


### 2026-08-30 — WalletSession suppresses stale confirmation errors without masking uncertainty

The WalletSession prepared-batch wrapper checked account ownership before
calling `PreparedBatch.confirm()`, but did not recheck it when confirmation
settled with an error. A wallet/network failure from an old account could
therefore escape after a replacement account became authoritative, while the
old batch was never disposed. The success path has the same stale-result rule:
an old result must not be returned to the new account.

The wrapper now owns both settlement paths: stale success and ordinary stale
error discard the exact old batch and return the existing changed-session
`user-rejected` error. The D-034 `submission-uncertain` error is the deliberate
exception and is preserved unchanged after an account change, while the exact
old batch is still retired. Current-session errors and results are unchanged.

*Verified:* public session regressions cover stale success, stale ordinary
error, and stale `submission-uncertain`; each runs against deferred confirmation
settlement and asserts exact discard behavior. The focused WalletSession suite
passes 27 tests; Privacy passes 9 files / 175 tests and the full workspace
passes 102 files / 1,591 tests. Privacy typecheck, all 13 invariants and diff
hygiene pass. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.*


### 2026-08-30 — Bridge quote evidence must own a usable deposit address and source metadata

`BridgeService` previously treated any truthy `depositAddress` from the
untrusted 1Click response as executable evidence. A whitespace-only string or
non-string runtime value could therefore be persisted, rendered as deposit
instructions and passed back to the SDK for status/report calls. The service
also copied `input.source` only after awaiting the quote: a caller mutating its
source symbol or decimals during that await could persist metadata inconsistent
with the signed quote's asset and amount.

Signed quote validation and resume deserialization now require a nonempty,
non-whitespace string no longer than 256 characters, and quote creation takes a
shallow snapshot of the complete input and source metadata before the provider
await. The bound is above every supported 1Click address shape (including the
longest shielded UTXO forms); Stellar's memo remains separate deposit metadata.
The signed route, quote request, status schema and persistence format are
otherwise unchanged.

*Verified:* public Bridge regressions were red before the fix for whitespace
and overlong deposit addresses, persisted whitespace/overlong/non-string
addresses, and source symbol/decimal mutation during a deferred quote. Green
after the fix: the Bridge suite passes 1 file / 70 tests, including the
existing ownership/status/evidence cases; package typecheck and diff hygiene
pass. No browser, external provider, wallet, RPC, proof, signature, funds or
transaction was used.


### 2026-08-30 — Receipt identity follows the Starknet transaction felt

The application receipt ledger claimed idempotence by transaction hash but
compared raw strings. Equivalent Starknet hashes with different casing or
leading-zero padding therefore produced duplicate receipts and required
duplicate acknowledgement. Record and acknowledge now compare canonical
nonzero felt identity while preserving the first exact string as displayed
evidence. Malformed, zero or field-prime-and-above strings retain exact raw
identity rather than being silently folded into a valid transaction.

*Verified:* a public ledger regression records `0x000Ab` then `0xab`, proves
only the first exact receipt remains, and acknowledges it through `0x00AB`.
Raw-string comparison creates two receipts and fails the regression. The
same suite proves case-distinct values above the Stark field prime remain two
raw receipts and acknowledge independently; removing the prime bound folds
them together. The focused ledger suite passes 9 tests; the full workspace passes 102 files /
1,589 tests. Every workspace typecheck, the production build, all 13 invariants
and diff hygiene pass. No browser, network, wallet, RPC, proof, signature,
funds or transaction was used.*


### 2026-08-30 — Browser submission receipts require a nonzero Stark felt

The Backend validates paymaster submission hashes, but the browser privacy
adapter independently trusted any response string and called `onAccepted`
before validating it. A compromised or malformed same-origin response could
therefore record zero, decimal text, malformed hex or an out-of-field value as
a successful private transaction.

The browser boundary now admits only a nonzero hexadecimal Stark-field felt
before publishing acceptance. Invalid values are protocol failures and never
reach `onAccepted`; lost responses retain the existing submission-uncertain
contract, and valid accepted hashes remain authoritative.

*Verified:* a public `BackendPrivacyClient.submit()` table covers zero,
leading-zero zero, decimal, malformed hex, the field prime and a value above
the field. All six previously resolved and called `onAccepted`; they now reject
as `unknown` without publishing acceptance. Valid uppercase and leading-zero
nonzero felts remain accepted. The accepted receipt fixture and forward-
compatibility route receipts now use valid felts. The Privacy package passes 9
files / 184 tests; the full workspace passes 102 files / 1,600 tests, all
workspace typechecks, production build, all 13 invariants and diff hygiene. No browser, wallet, provider,
RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — A joined Lobby room owns lifecycle-registration failure

Lobby publishes a newly joined room before registering its state, error and
leave callbacks so synchronous SDK events can identify the room. If any of
those registrations threw, the join rejected but left the published room,
server identity and `connected` status intact. Callers then observed a phantom
connected client whose failed room was never released.

The join failure path now distinguishes a pre-room matchmaking failure from a
failure after room publication. A still-current published room is atomically
retired, its identity and reconciliation state are cleared, the client reports
closed/error, peers are cleared, and that exact room is left once before the
original registration error is rethrown. A failure before publication retains
the established idle/retry behavior.

*Verified:* public `LobbyClient.connect()` regressions inject synchronous
failures into reconnection setup and each of `onStateChange`, `onError` and
`onLeave` after `joinOrCreate()` returns. All four cases previously rejected
while leaking the joined room (the lifecycle registrations also retained
connected state); they now reject with the original error, leave the room
exactly once, report closed and expose no game ID. Existing pre-welcome error
and leave cases prove their callback-owned cleanup is not repeated. The focused
Lobby client suite passes 50 tests; the full workspace passes 102 files / 1,592
tests, all workspace typechecks, production build, all 13 invariants and diff
hygiene. No browser, external lobby, wallet, RPC, proof, signature, funds or
transaction was used.*

### 2026-08-30 — Backend reads recheck cancellation after transport settlement

The backend privacy adapter passes cancellation signals to fetch, but an
injected or non-conforming transport can ignore them and resolve later. Pool
config, public-key, relay-fee and swap-quote reads then returned stale results
after their caller had cancelled. The adapter now rechecks cancellation after
each awaited response and before parsing or publishing the value. Private
submission intentionally does not use this guard: once a submission response
contains an accepted transaction hash, receipt preservation remains
authoritative over a late cancellation.

*Verified:* one table-driven public `BackendPrivacyClient` regression defers a
transport that ignores its signal, aborts each of the four cancellable methods,
then resolves a valid response. All four cases returned stale data before the
fix and now reject as `user-rejected`. The Privacy package passes 9 files / 176
tests; the full workspace passes 102 files / 1,592 tests, all workspace
typechecks, production build, all 13 invariants and diff hygiene. Injected fetch
behavior and submission receipt tests remain green. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-30 — Presence setup and interior suspension retain transport ownership

The Web Presence controller previously treated setup and interior suspension as
single synchronous steps. A conforming client can replay its initial status and
then synchronously report a drop while the controller is installing status
delivery; setup still installed peer delivery and attempted to connect the
retired client. Likewise, `suspend()` can synchronously report that the
transport closed, but both the connected-status path and a just-settled join
then overwrote `unavailable` with `suspended`.

Setup now ignores only the mandatory first status replay, owns the rest of the
installation with a retirement token, and stops before peer delivery or connect
when a later callback drops the client. Connect and settlement have explicit
owners, and both suspension paths recheck their exact client/attempt after the
handoff. Reusing a client whose initial replay is already `closed` remains a
valid explicit reconnect, and existing queued-reconnect behavior is unchanged.

*Verified:* eight public `createPresenceController()` regressions cover an
initial replay followed by a synchronous setup drop, a connected status whose
interior suspension synchronously closes, and a resolved join whose interior
suspension synchronously closes. They also cover direct building-entry
suspension, a late status callback from a replaced client, synchronous
reconnect reentry while the connecting state is published, destruction during
that publication, and a building exit whose resume synchronously closes the
transport. The focused Presence suite passes 42 tests; the full workspace passes 102 files / 1,596
tests, all workspace typechecks,
production build, all 13 invariants and diff hygiene. No browser, lobby server,
wallet, provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-29 — Same-wallet connection requests share one authority flight

Wallet session generation correctly allowed only the newest connection attempt
to publish authority, but two same-key calls still started two wallet workflows
before the older result was retired. A rapid double-click could therefore open
duplicate connection prompts for one selection. The session now shares the
in-flight promise only for the same opaque wallet key; a different selection
still supersedes the old attempt under the existing generation rules.

*Verified:* public session regressions call `connect()` twice for the same
discovered key while the adapter is deferred, and disconnect that pending
attempt before reconnecting the same key. The first failed red with two
adapter calls and now passes with one call and one connected authority; the
second failed red by reusing the retired promise and now passes with two calls
and the replacement connected authority. Discovery removal and terminal
destroy also invalidate the pending flight. The existing different-wallet
concurrency regression remains green. The focused session suite passes 26
tests and the full workspace passes 102 files / 1,590 tests. All workspace
typechecks, the production build, all 13 invariants and diff hygiene pass. No
browser, live wallet, provider, RPC, proof, signature, funds or transaction was
used. Removing the same-key flight owner or lifecycle invalidation each
reproduces its matching regression.*

### 2026-08-29 — Fly sanitizes private-child response headers

The Fly public edge previously copied every non-hop-by-hop response header
from the private child to the browser. A child response could therefore set
cookies, redirects, public caching, CORS permissions, content encoding,
cross-origin isolation, or arbitrary private metadata at the public origin.
That was an unnecessary response-boundary escape: the Backend JSON contract
only needs its content type and content-type protection marker, and dynamic
API/lobby responses must not be publicly cached.

The edge now projects proxied responses onto the positive allowlist of
`content-type`, emits its own exact `x-content-type-options: nosniff`, and
forces `cache-control: no-store`. It does not forward `Set-Cookie`, `Location`,
`ETag`, `Vary`, `Server`, `Content-Encoding`, CORS, cross-origin isolation,
content length, or arbitrary child headers. Request bodies, status codes and
allowed response bodies remain unchanged; static responses and the explicit
WebSocket handshake path retain their own contracts.

*Verified:* a deterministic private-child fake first exposed each forbidden
header to a public API client, including an unsafe child `x-content-type-options`
value. The corrected regression confirms the allowed content type, edge-owned
`nosniff`, exactly `no-store`, absence of all forbidden headers, and
unchanged `200`/body behavior. Focused Fly edge tests pass 38 tests; all Fly
tests pass 4 files / 144 tests. The full local workspace run executes 102
files / 1,588 tests; 1,587 pass and the unrelated
`apps/web/vite.config.test.ts` exact-boundary test times out under this local
Node environment (twice); excluding that test, 101 files / 1,581 tests pass.
Fly/workspace typechecks, production build, 13 invariants, tilemap gate and
diff hygiene pass. No browser, external provider, RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-29 — Fly rejects ambiguous private-API request targets

The Fly public edge previously classified raw request targets with a literal
`/api/` prefix and forwarded the remaining bytes unchanged. Targets such as
`/api/../health`, single- or double-encoded delimiters, duplicate slashes and
semicolon path parameters therefore crossed into the private
Backend child. A downstream HTTP parser or proxy could normalize those bytes
differently, and the traversal shape bypassed the public edge's explicit
concealment of health and metrics routes.

The edge now validates the exact raw API target before reading or proxying the
body. It accepts origin-form `/api`, `/api/` and canonical fixed-ASCII
`/api/v1/...` paths, preserving queries unchanged, while rejecting every
percent escape in the path, literal dot segments, backslash, duplicate slash,
semicolon parameters, fragments and non-origin-form targets. Backend routes
contain no dynamic or percent-encoded path components, so encoded path bytes
add only downstream re-decoding ambiguity. Nearby `/apis` and `/api2`
static-shell routing remains outside the private namespace. Rejections are the
existing generic public `400`, do not echo the target and never reach the
private child.

*Verified:* deterministic raw-edge regressions first forwarded sixteen ambiguous
API targets to a private-child fake, including both literal and encoded health
traversals. The corrected edge rejects them with zero child calls and forwards
four canonical API/query targets byte-for-byte after stripping only `/api`.
The adversarial matrix includes mixed-case and mixed single/double-encoded dot,
slash, backslash and semicolon shapes. The focused Fly edge suite passes 37
tests and all Fly tests pass 4 files / 143 tests. The full workspace passes 102
files / 1,587 tests; Fly/workspace typechecks, production build, 13 invariants,
tilemap gate and diff hygiene pass. No browser, external provider, RPC, wallet,
proof, signature, funds or transaction was used.

### 2026-08-29 — HTTP edge rejects unsupported content encodings

The Fetch edge parsed request bytes as UTF-8 JSON but ignored
`Content-Encoding`. A request labelled `gzip`, `br` or `deflate` while carrying
an uncompressed JSON body therefore reached the backend core, whereas an
actually compressed body failed later as invalid UTF-8. That disagreement let
an intermediary and the core assign different meanings to the same HTTP
message and left the production Node adapter unable to enforce the boundary
because it did not forward the header.

The edge now accepts only an omitted or case-insensitive `identity`
`Content-Encoding` and returns a generic `415` before reading or forwarding the
body for every other encoding, including encoding lists. The Node HTTP adapter
passes the incoming header through to the Fetch boundary. Content length is
still measured in decoded request bytes before UTF-8 decoding, with fatal
UTF-8 handling, no decompression and no body echo.

*Verified:* deterministic Fetch tests first sent plain JSON labelled `gzip`,
`br` and `deflate`; each reached the fake core with `200`. The corrected edge
returns `415 ENCODING_NOT_ALLOWED` for those encodings and mixed lists,
accepts explicit `Identity`, and the raw Node listener test rejects a gzip
label before the core. Existing charset, BOM, invalid UTF-8, empty-body,
stream-byte-cap, malformed-JSON and no-echo behavior remains fail-closed.
Focused HTTP/server tests and the backend gates are recorded with the final
candidate. No external provider, RPC, wallet, proof, signature, funds or
transaction was used.

### 2026-08-29 — HTTP JSON rejects ambiguous and prototype-sensitive object keys

The Backend Fetch edge previously passed request text directly to
`JSON.parse()`. Duplicate object members therefore used JavaScript's last-key
wins behavior: `{"v":2,"v":1}` reached the core as version 1, and duplicate
nested financial fields could likewise be interpreted differently by another
parser or request-signing layer. Prototype-sensitive `__proto__`, `constructor`
and `prototype` members also crossed the HTTP boundary before exact-record
validation, creating an unnecessary future pollution surface.

The bounded HTTP body reader now performs a deterministic object-key pass over
the same decoded text before parsing. It rejects duplicate keys within each
object and all three reserved prototype keys at any depth, including equivalent
JSON escape encodings. Separate objects may reuse ordinary names; arrays,
escaped strings and JSON extension-free value semantics remain handled by the
native parser. Rejections keep the existing generic `400` response, never call
the Backend core and do not echo request content.

*Verified:* public deterministic HTTP regressions first forwarded duplicate
root/nested keys and prototype-sensitive members to a fake core. The corrected
edge rejects all of them, including `\\u0076` as a duplicate of `v` and an
escaped `__proto__`, while accepting the same key in separate objects and
strings containing JSON punctuation. A correction after independent review
replaced the initial global key-state scanner, which rejected string values
after array commas, with per-container object/array state. The differential
valid-JSON matrix now covers strings, numbers, booleans, nulls, nested arrays,
separate objects, punctuation/escapes and realistic multiword calldata, proof
output and proof-fact arrays. Removing duplicate detection fails three
regressions; removing the reserved-key guard fails four. The focused HTTP suite
passes 22 tests, Backend passes 5 files / 153 tests and the full workspace
passes 102 files / 1,562 tests. All workspace typechecks, production build, 13
invariants, tilemap gate and diff hygiene pass. No listener, browser, external
provider, RPC, wallet, proof, signature, funds or transaction was used.

### 2026-08-29 — Raw Starknet RPC responses require a correlated JSON-RPC envelope

`StarknetRpcPoolPort.rpc()` previously trusted any truthy `error` check and a
present `result` key. It therefore accepted a wrong JSON-RPC version, a
response for another request id, and a response containing both `result` and a
falsy `error` value. Arrays, nonobjects and malformed JSON either reached
downstream result parsing or leaked parser/runtime errors from the adapter.

The adapter now allocates positive safe numeric request IDs, wrapping at
`Number.MAX_SAFE_INTEGER` while skipping IDs owned by concurrent in-flight
calls and releasing each ID in `finally` on success, error or abort. It
requires a JSON-RPC 2.0 object with an own data `jsonrpc` property equal to
`2.0`, an own data numeric id matching the request, and exactly one own data
`result` or `error` property. Error presence is based on property presence
rather than truthiness, and malformed JSON is mapped to a generic
invalid-response error. JSON-RPC extension members are intentionally ignored:
the standard and installed Starknet v10.4 response type do not forbid them,
and this narrow adapter has no extension-specific behavior; arrays/batches and
conflicting standard members remain rejected.

*Verified:* deterministic adapter fakes first accepted wrong version/id,
result-plus-falsy-error envelopes, and leaked malformed/nonobject failures.
The focused adapter suite passes 45 tests; removing the version, id, exclusive
result/error, data-property, active-ID, or release guards independently fails
its public regression. The request-ID boundary regressions cover wraparound,
active-ID collision avoidance, and release after fetch, response-read, and
successful completion. Backend passes 5 files / 137 tests; the full workspace
passes 102 files / 1,546 tests. All workspace typechecks, production build, 13
invariants, tilemap gate and diff hygiene pass. Deterministic fakes only: no
external RPC, wallet, provider, proof, signature, funds or transaction was
used.

### 2026-08-29 — Paymaster submission success requires one nonzero transaction hash

`BackendApi` previously applied a client-input felt validator to the runtime
result of `PaymasterPort.submit()` and returned that provider object unchanged.
A provider response containing `0x0` was therefore reported as a successful
private submission, while missing, decimal or above-field hashes were
misclassified as client `400` errors after relay dispatch. Runtime-only extra
provider fields were also echoed across the public response boundary.

The submission boundary now requires an own data property containing one
nonzero Stark field felt, preserves its exact leading-zero and hex-case
encoding, and returns only `{transactionHash}`. A malformed provider success is
the existing opaque upstream `502`; it does not claim acceptance, expose raw
provider details, retry, or alter D-034's existing browser classification of a
lost response before a validated hash reaches the browser.

*Verified:* public deterministic BackendApi regressions first accepted `0x0`,
echoed provider status/correlation fields, and returned client `400` for a
missing, decimal or field-prime hash. The corrected boundary rejects those
values, leading-zero zero, and inherited/accessor hashes with the generic
upstream response, while preserving valid `0x00Ab`. Removing the nonzero guard
fails both zero cases; replacing own-property extraction with normal property
access fails the inherited/accessor cases. Backend passes 5 files / 117 tests;
the full workspace passes 102 files / 1,526 tests. All workspace typechecks,
the production build, 13 invariants, tilemap gate and diff hygiene pass.
Deterministic fakes only: no browser, wallet, provider, RPC, proof, signature,
funds or transaction was used.

### 2026-08-29 — Oversized submissions must not consume global admission

`BackendApi.handle()` previously took aggregate rate-limit admission before
validating the prepared-submission body. A proof string above the configured
`maxProofBytes` therefore returned the existing `413` only after consuming a
rate-limit slot; with a one-request window, the next valid request got `429`.
The HTTP edge still owns bounded streaming body reads. The API now performs a
cheap submission-specific schema and artifact-size preflight after the
existing pre-abort check and before the limiter. It preserves the global
kill-switch, valid-request rate limiting, generic errors, and all queue,
paymaster, proof, receipt and retry behavior.

*Verified:* a deterministic public regression first returned `429` for the
following valid pool-config request on the base; the corrected path returns
`413`, leaves `rateLimited` at zero, returns the next request at `200`, and
never calls the paymaster. Removing the pre-admission preflight reproduces the
failure. The full workspace passes 102 files / 1,518 tests. No browser,
wallet, external provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-29 — Receipt lookups require a nonzero transaction hash

The receipt endpoint previously reused the generic felt validator, which
accepts zero and therefore forwarded `0x0` and leading-zero zero encodings to
the RPC as if they were transaction hashes. A transaction hash is an
identifier, not the zero sentinel used by pool public-key reads; accepting the
sentinel wastes an upstream read and makes a nonexistent receipt look like a
valid lookup. The endpoint now uses a nonzero felt validator while preserving
leading-zero nonzero hashes and uppercase hex digits. Its exact `{v,
transactionHash}` body contract, opaque receipt response, and no-retry
semantics are unchanged.

*Verified:* a public BackendApi regression first forwarded `0x0` and `0x00`
to a deterministic receipt fake; after the guard both return generic `400`
without touching the RPC. Negative, decimal, invalid-prefix, malformed,
field-prime and above-field values are also rejected; `0x00Ab` is preserved.
Wrong versions and extra address/proof fields are rejected, and a provider
failure returns only the generic `502` response. The focused backend suite
passes 51 tests, with typecheck, invariants and diff hygiene green. No
external RPC, wallet, proof, signature, funds or transaction was used.

### 2026-08-29 — Public-key reads require one valid felt

`StarknetRpcPoolPort.getPublicKey()` previously accepted any string array from
the pool call, returned `0x0` for an empty array, and silently ignored trailing
words. A malformed `get_public_key(address)` response could therefore be
treated as an unregistered recipient or have an arbitrary first word reach the
privacy registration preflight. The adapter now requires exactly one valid
Stark field felt and returns it unchanged, preserving `0x0` and leading-zero
encodings for the privacy mapper. The backend and receipt path are unchanged.

*Verified:* deterministic adapter fakes first accepted empty, multiword,
decimal and field-prime results; the corrected adapter rejects them with the
generic invalid-public-key error while accepting `0x0`, `0x00` and `0x0001`.
The privacy mapper continues to classify valid zero as `unregistered`, valid
nonzero as `registered`, and malformed values as `unknown`. Adapter tests pass
25 tests and the backend typecheck passes. No external RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-29 — Starknet block numbers must be nonnegative

`StarknetRpcPoolPort.getBlockNumber()` previously accepted any safe integer
returned by `starknet_blockNumber`, including `-1`. That is not a valid
Starknet block number and could make downstream freshness and authorization
windows operate on an impossible chain position. The adapter now requires a
safe integer greater than or equal to zero. Response mapping, request
parameters, receipt handling and submission behavior are unchanged.

*Verified:* a deterministic RPC fake first made a public adapter regression
resolve `-1` on the current base; the corrected adapter rejects it with the
existing generic invalid-block-number error. Removing the nonnegative guard
reproduces the failure. Focused adapter tests pass 18 tests. No wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-29 — Starknet pool fee words require exact felt u128 validation

`StarknetRpcPoolPort.getPoolConfig()` previously converted the two raw fee
words with `BigInt()` alone. The adapter therefore accepted negative and
decimal strings, and values wider than the contract's `u128` limbs, returning
malformed pool configuration to the backend API. Its proof-validity parser
also accepted positive decimal strings even though Starknet RPC felts are
hex-encoded and the shared felt rule is strict.

The adapter now requires exactly two valid felt fee words, bounds each to
`u128`, and applies the same felt validation before accepting the positive
proof-validity window. Provider details remain mapped by the API's existing
generic upstream-failure response; no retry, transaction, receipt, logging or
privacy boundary changed.

*Verified:* deterministic adapter regressions first resolved malformed fee
words `-1`, decimal `123`, and `2^128` instead of rejecting them, and a
decimal proof-validity result also passed. The corrected adapter rejects all
four cases while the existing valid pool/public-key/block fixture remains
green. Focused adapter tests pass 17 tests. No wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-29 — Exchange quote expiry is rechecked after the live pool read

The Exchange confirm path checked a private-swap quote's `expiresAt` before
awaiting the live pool configuration read, but did not check it again after
that await. A quote could therefore expire while the fee and pool-validity
read was pending and still cross into the prepared batch's wallet handoff.
That would make the review stale at the commit point even though the initial
expiry check had passed.

Confirm now rechecks the same quote expiry immediately after the live pool
read and before any fee gate or wallet handoff. An expired quote is discarded
and returns to the existing `prepare-again` failure; a stale or closed attempt
still returns before touching the current batch. No accepted wallet handoff,
receipt, submission or uncertainty behavior changes.

*Verified:* a public deterministic regression advances a controlled clock
while the live pool read is deferred. On the old path the expired review
entered `batch.confirm`; the corrected path discards it exactly once, calls no
confirm and returns `prepare-again`. A separate close/reopen regression keeps
the replacement review authoritative when the old pool read settles. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-29 — Exchange composition edits retire reviewed batches

The Exchange machine invalidated a pending prepare while the panel was in
`preparing`, but once a batch reached `review`, changing the amount or asset
only patched the visible composition. The old prepared batch and its review
therefore remained live, so a subsequent confirm could submit the quote for
the pre-edit amount or pair. This was a financial-action ownership defect:
the review must describe the exact composition that confirm will submit.

Composition edits now advance the attempt, discard the reviewed batch, and
return the flow to `composing`. The existing preparing, signing-owner,
receipt, submission-uncertainty, close/remount and stale-result behavior is
unchanged. No edit is allowed to release a batch already in wallet handoff.

*Verified:* public deterministic regressions first failed on `origin/main`
because a reviewed 1 STRK batch was confirmed after changing the amount to 2,
or after changing either selected asset; the corrected path discards the exact
reviewed batch, leaves confirmation at zero and returns to composing. Removing
the reviewed-edit ownership branch reproduces all three failures. The focused
Exchange machine suite passes 24 tests (22 at the initial candidate checkpoint
plus the two asset-edit regressions), with the workspace gates recorded on the
final candidate. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-29 — Prepare-time quote and fee reads honor cancellation

`WalletApiPrivacyOperations.prepare()` already passed its caller signal into
the pool configuration and recipient reads, but the two remaining external
prepare collaborators could settle after cancellation without a final
ownership check. A cancellation-ignoring relay-fee estimate could therefore
return a usable pool-native batch, and a cancellation-ignoring AVNU quote
planner could return a quote-bound private-swap batch after the caller had
closed or changed authority. Either result retained a later confirmation
handle despite the canceled prepare request.

The prepare paths now check the same signal immediately after the awaited
relay estimate and quote planner. This changes no fee, quote, action,
submission, receipt, uncertainty or retry behavior; it only rejects the
canceled prepare before a batch is published.

*Verified:* public deferred-collaborator regressions first failed on
`origin/main` (`fa8851f`) because the aborted relay estimate and swap quote
each resolved to a prepared batch. The corrected paths return
`user-rejected`; removing either guard independently reproduces its matching
failure. The focused Wallet API suite passes 63 tests; Privacy passes 9 files
/ 172 tests; the full workspace passes 102 files / 1479 tests. Workspace
typechecks, production build, all 13 invariants, tilemap check and diff
hygiene pass. Deterministic fakes only: no browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-29 — Confirm-time pool reads stop before wallet handoff

Prepared shield, pool-native and private-swap confirmations re-read the pool
configuration immediately before wallet proof/signing or relay preparation.
Those reads previously trusted only the collaborator's `AbortSignal`: a
collaborator that ignored cancellation could settle after the caller closed or
changed authority, and confirmation would still cross into wallet handoff.
Each confirm-time pool read now checks the same signal after its await and maps
that cancellation through the existing `user-rejected` taxonomy. No guard is
placed after an accepted wallet or relay submission, so an existing receipt or
submission uncertainty remains authoritative and no retry is introduced.

*Verified:* public shield, pool-native and private-swap confirmation regressions
first failed on the current base: each deferred config read settled after
cancellation and crossed into wallet preparation or invocation. The corrected
paths return `user-rejected` with zero wallet preparation/invocation/submission;
removing each guard independently reproduces its failure, and none emits
`awaiting-approval`. Existing accepted-receipt, submission-uncertain and
single-confirmation tests remain green. The focused wallet API suite passes 61
tests; privacy passes 9 files / 170 tests and the full workspace passes 102
files / 1477 tests, all workspace typechecks, production build, all 13
invariants, tilemap check and `git diff --check`. Deterministic fakes only: no
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-29 — Pool configuration reads honor cancellation after the await

`WalletApiPrivacyOperations` already checked the caller's signal before and
after capability, private-balance and recipient-status reads, but
`poolConfig()` returned the backend result immediately after its awaited read.
If a caller disconnected while that read was in flight and the collaborator
ignored the signal, the public privacy seam could therefore publish stale pool
fee, validity or maturity configuration as a successful result. A caller that
uses that configuration to prepare or display a route would observe data from
an authority that had already been canceled.

`poolConfig()` now checks the same signal after the read and maps cancellation
through the existing `user-rejected` error taxonomy. The pool request remains
the same, and no wallet, proof, signing, submission, retry or transaction
behavior changes.

*Verified:* a public `WalletApiPrivacyOperations.poolConfig()` regression uses
a deferred deterministic pool read. It first fails on the current base because
an abort followed by read settlement resolves the stale config, then passes
after the post-await guard with `user-rejected`. The privacy package passes 9
files / 167 tests; the full workspace passes 102 files / 1,474 tests, all
workspace typechecks, the production build, all 13 invariants, the tilemap
check and `git diff --check`. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-29 — Canceled submissions stop before asynchronous relay admission

`BackendApi.handle()` races the caller/deadline signal against its bounded
submission task, so a disconnected caller can receive the existing generic
`504` while the task continues until an awaited collaborator settles. The
submission path previously had no ownership checkpoint after its in-queue
proof-freshness read or after the public asynchronous
`SponsorshipBudgetPort.take()` seam. A late freshness or budget resolution
could therefore continue into `paymaster.submit()` with an already-aborted
request, spending sponsorship after the caller had been retired.

The API now rechecks the request signal after each of those awaits and before
any relay dispatch. This preserves the existing generic abort classification,
queue capacity until a provider settles, budget and request metrics, and the
existing uncertainty behavior once `paymaster.submit()` has begun. It does not
add request-id state or retry behavior; D-034 still governs hashless
post-dispatch uncertainty.

*Verified:* two public BackendApi regressions first failed on current
`origin/main`: a deferred budget admission reached `paymaster.submit()` after
caller cancellation, and cancellation during the queued freshness read still
entered budget admission. Each failure is independently reproduced when its
corresponding post-await guard is removed. The corrected Backend suite passes;
full workspace gates, typechecks, build, invariants, tilemap and diff hygiene
are recorded with the final candidate. No browser, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-29 — Visit ownership ignores re-entrant building enters

`VisitController` previously accepted every `building:entered` event, even
while the Shell was already inside a room or station. The World door contract
emits `building:exited` before a legitimate new `building:entered`; therefore
an enter arriving during an active visit is stale or re-entrant. Accepting it
replaced the active station/window with a new room, republished station
metadata, and could leave the Shell describing a different building from the
World's fixed-room controller. This was especially unsafe during lifecycle
rebinds or duplicate event delivery because no exit had reset ownership.

`VisitController` now ignores `building:entered` while visiting. A matching
authoritative `building:exited` still resets the visit, after which a new enter
is accepted normally. Locked-door handling, station activation, close/exit
semantics and control ownership are unchanged.

*Verified:* a public regression first failed on current `origin/main` when a
duplicate same-building enter followed by a conflicting enter changed an
active Bank station visit into an Exchange room and published a second station
snapshot. The corrected focused Web visit-controller suite passes; the same
regression proves an exit followed by a new enter still transitions normally.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-29 — Lobby must validate the server-minted welcome identity

`LobbyClient` previously trusted every `welcome` payload and cast its
`gameId` directly to the branded `GameId` type. The authoritative lobby
protocol mints a 16-character lowercase hexadecimal identifier, but a
malformed or empty payload could therefore become the client's identity. If
the room state already contained the actual local entry, self-filtering then
failed and published that entry as a remote avatar. A second welcome could
also replace a valid identity mid-session and create the same leak.

The client now validates the payload with the existing exact `normalizeGameId`
rule. A malformed welcome clears the room and identity, emits the empty peer
snapshot, rejects the pending connect, and leaves that room once; it never
enters a usable connected state. After the first valid welcome, duplicate or
conflicting welcome messages are ignored for that room generation, preserving
the first server-assigned identity. A new explicit reconnect gets a fresh
generation and accepts its own valid welcome normally. No lobby message or
state field changed.

*Verified:* the public malformed-welcome regression first failed on current
`origin/main`, resolving connect while adopting `not-a-game-id` and exposing
the local entry through `peers()`. The duplicate-welcome regression also
demonstrated that a later valid identity changed the self-filter. Green is 46
LobbyClient tests and 211 tests across the lobby package; the full workspace
passes 102 files / 1,470 tests, all workspace typechecks, the production
build, all 13 invariants, the tilemap gate and `git diff --check`. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-29 — Interior movement must respect the authoritative avatar body

The fixed-room and Avatar Studio movement paths bypass Arcade collision and
previously tested only the avatar's anchor tile. The local player and Studio
contact contract is a centered 24x24 body, so the anchor could enter the tile
beside a wall or station while 12 pixels of that body overlapped solid space.
This made the custom interior collision semantics disagree with the body's
authoritative footprint; the outdoor Arcade collider did not cover these
manual interior moves.

The bounded movement helper now accepts an optional collision half-size and
rejects each axis candidate when any tile overlapped by that axis-aligned body
is solid. Fixed rooms and Avatar Studio pass the existing 12px half-size;
callers without a body size retain the prior anchor-only behavior. Substep
limits, axis ordering, speed, and total-travel bounds are unchanged.

*Verified:* a public movement regression first failed on current `origin/main`,
allowing the 24px body to reach center `y=128` against a station whose solid
tile began at `y=96..128`; the corrected body-aware path stops at `y=144` with
the 16px substep cadence. The focused World suite passes 24 files / 242 tests,
the full workspace passes 102 files / 1,467 tests, all workspace typechecks,
the production build, all 13 invariants, the tilemap gate and `git diff
--check`. No browser, lobby, wallet, provider, RPC, proof, signature, funds
or transaction was used.

### 2026-08-29 — Pre-aborted Backend requests do not consume aggregate rate admission

`BackendApi.handle()` previously evaluated `this.limiter.take()` while building
the promise passed to `abortable()`. An `ApiRequest` whose signal was already
aborted therefore consumed the process-wide aggregate rate-limit slot before
`abortable()` observed cancellation. With a one-request window, a canceled
request could deny the next live request with `RATE_LIMITED` without touching a
provider. This is an admission-control denial path, not a provider or request
identity feature.

The handler now checks the derived deadline signal before invoking the limiter.
It preserves the existing generic timeout response, request/failure metrics,
deadline disposal, provider non-invocation and all async limiter behavior. No
abort-reason classification, route policy, queue, response shape or logging
behavior changed.

*Verified:* the public BackendApi regression first failed on current
`origin/main` because the pre-aborted fee request was followed by `429` instead
of a successful pool-config read. Green proves the first request returns the
existing generic `504`, calls neither fee nor RPC providers, clears its one
deadline timer, records one request and one failure with no rate-limit count,
and leaves the following live request at `200` with `rateLimited: 0`. Removing
the single pre-admission guard reproduces the `429` failure. The focused
Backend suite passes 73 tests; the full workspace passes 102 files / 1,465
tests, all workspace typechecks, the production build, all 13 invariants, the
tilemap gate and `git diff --check`. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.

### 2026-08-29 — Recipient preflight rejects malformed pool keys

`WalletApiPrivacyOperations.recipientStatus()` previously treated every
nonzero value returned by the pool `get_public_key` read as a registered
recipient. The Wallet API seam therefore admitted negative decimal values,
decimal strings without the `0x` prefix, and values at or above the Stark
field prime. A malformed RPC/backend response could pass the recipient
preflight and reach relay estimation and eventual wallet preparation instead
of failing closed. A non-hex string happened to return `unknown` only because
`BigInt()` threw; that accidental behavior did not validate the full felt
contract.

The preflight now applies the existing `isFelt` rule before interpreting the
sentinel: malformed values return the existing `unknown` status, valid `0x0`
and leading-zero zero encodings remain `unregistered`, and valid nonzero
leading-zero felts remain `registered`. No public type or route changed.

*Verified:* the public `wallet-api.test.ts` matrix first failed red on current
`origin/main` for `-1`, `123`, the field prime and field-prime-plus-one, with
each incorrectly reported as `registered`; `0xnot-a-felt` already returned
`unknown`. The same public transfer-prepare path then proved malformed keys do
not call relay estimation or wallet preparation. Green is 57 focused Wallet
API tests and 166 tests across the privacy package. Replacing the guard with
an unconditional false branch reproduces the same four failures. The full
workspace passes 102 files / 1,464 tests, all workspace typechecks, the
production build, all 13 invariants, the tilemap gate and `git diff --check`.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.

### 2026-08-29 — Bank form edits retire stale recipient preflights

The Bank's transfer Add captures the recipient and amount before awaiting the
pool recipient preflight. Editing the form while that request is pending used
to let the old result queue the captured intent and clear the newer form. The
same stale write was reachable through the public MAX control, which remained
available while Add was resolving. Clear and Remove already advanced the
existing composition clock, but ordinary form writes did not.

The public form writers now share one small composition-edit helper. A changed
amount or recipient advances the preflight ownership generation; an accepted
mode selection advances it on every call because that public operation resets
both form fields and the notice; MAX advances it only when it changes the
displayed amount. Invalid mode selections and same-value amount/recipient
writes retain their previous no-data-change semantics. The prepare/confirm
attempt clock and the existing Clear/Remove composition behavior are otherwise
unchanged.

*Verified:* public `createBankPanel()` regressions first failed on current
`origin/main` for a deferred BOB/1 preflight followed by a BOB-to-ALICE/1-to-2
edit and for the same sequence through MAX. Green also covers recipient-only,
amount-only and active-mode reselection edits, while preserving the edited
fields and leaving the batch empty. Removing each of the amount, recipient,
mode and MAX ownership bumps makes its focused regression fail. The focused
Bank suite passes 83 tests; the full workspace passes 102 files / 1,456
tests, all workspace typechecks, the production build, all 13 invariants and
diff hygiene. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.

### 2026-08-29 — GitHub Actions references are immutable supply-chain inputs

The CI workflow previously selected `actions/checkout@v7` and
`actions/setup-node@v7`. Those readable major tags are mutable upstream
references, so a later tag move could change code executed with the repository
workflow's authority without changing this repository. Every remote workflow
`uses:` reference is now pinned to a full lowercase commit SHA, with the
reviewed release version retained only as a comment. A repository-owned scanner
allows only slash-separated ASCII letter, digit, `_`, `.`, or `-` path segments
before that SHA. It rejects tags, branches, abbreviated or malformed remote
references and all `docker://` steps, including digest pins, while allowing
local `./` actions; the Invariants job runs that scanner on every change. It
parses workflow YAML structurally at `jobs.<id>.uses` and
`jobs.<id>.steps[*].uses`: flow mappings, quoted or escaped keys, explicit keys
and aliases cannot bypass validation, while comments, command text and literal
`uses` inputs under `env` or `with` are not mistaken for action references.
Invalid YAML, YAML `<<` merge keys in the workflow root, jobs collection, job
maps or step maps, and non-string action references fail closed. GitHub
currently rejects those merge keys; denying them explicitly prevents a future
syntax change from creating an unscanned action seam. The structural parser is
the exact dev-only `yaml@2.9.0` lockfile dependency.

The Verify job separately runs a production-only high-severity `npm audit`
after the lockfile install. This is a recurring registry-advisory gate, not an
SBOM, provenance record, application security review or assertion about
development-only dependencies.

*Verified:* the official GitHub tag-ref API resolved `actions/checkout@v7` to
`3d3c42e5aac5ba805825da76410c181273ba90b1`; the action's `package.json` at
that commit reports `7.0.1`. It resolved `actions/setup-node@v7` to
`820762786026740c76f36085b0efc47a31fe5020`; that commit reports `7.0.0`.
Before the pins, the repository scanner failed red on all eight mutable
references. Its focused fixtures reject tag/branch and malformed pseudo-action
references while accepting exact remote pins, nested action paths, quoted
references with comments and repository-local actions. Separate regressions
pin flow mappings, quoted/escaped and explicit keys, aliases, invalid YAML,
benign non-key text, schema-position ownership, root/jobs/job/step merge-key
denial, Docker tag/digest denial and query/hash/backslash path rejection. The
pinned workflow passes the scanner, and the current production dependency
audit reports zero known advisories. The full workspace passes 102 files / 1,451
tests, all workspace typechecks, the production build, all 13 invariants, the
tilemap gate and `git diff --check`. No product code, wallet, provider, RPC,
proof, signature, funds or transaction was used.

### 2026-08-29 — Wallet attention follows human-owned operation stages

The inline pending sentence was not a reliable handoff when a wallet prompt
opened outside the game or took long enough for the player to look elsewhere.
Web now renders one fixed Avatar 1 attention cue while the production session
is connecting, a requested private-balance read is loading, or an operation
reports `awaiting-approval`. It deliberately stays absent during capability
detection, composition, proving, submission and network confirmation. The cue
also marks the browser tab and emits one best-effort local signal without
requesting notification permission; it contains no wallet identity, account,
balance, amount, route, transaction hash or lobby data.

World exposes only the approved sheet's cosmetic URL and frame geometry. It
does not learn why Web renders the image, and Web receives no Phaser object or
movement authority. React defers the local signal so StrictMode's effect probe
cannot sound twice for one handoff, and restores the prior tab title only while
it still owns the marker.

*Verified:* public render regressions hold connection and Bank/Exchange balance
reads open and find the exact Avatar 1 cue; a controlled Bank confirmation holds
`awaiting-approval` and proves the cue clears after settlement. A typed stage
matrix rejects every non-human operation stage, while a StrictMode lifecycle
regression records one signal and exact title restoration. A device-policy
regression makes `navigator.vibrate()` throw and proves that failure cannot
escape the best-effort signal or disturb the visual cue. Further lifecycle
regressions make audio close reject and replace the injected callback during
one active handoff; neither an unhandled rejection nor a second signal escapes.
The focused four files pass 39 tests; the full workspace passes 101 files /
1,438 tests, all
workspace typechecks, production build, 13 invariants and diff hygiene. In the
local browser, the mock gateway process was temporarily paused after explicit
wallet selection: the live page exposed one assertive cue and tab title
`● Wallet needs you — STRKWORLD`; resuming the same request removed the cue,
restored `STRKWORLD` and admitted the game. The canonical main Vite server was
then restored and multiplayer reverified connected. The browser check used no
real wallet, RPC, proof, signature, funds or transaction. Audibility remains a
device-dependent best-effort behavior, not a rendered acceptance claim.*

### 2026-08-29 — Failed remote-peer replays relinquish subscription ownership

`RemotePeerSource.subscribe()` replays its retained snapshot synchronously. It
previously registered the listener before that replay but left the generation
registered if the callback threw. Because the failed call never returned its
unsubscribe closure, the listener became permanently unremovable; every later
publication called it again, rethrew, and stopped healthy remote-avatar
subscribers from receiving that transition.

Replay failure now invokes the same token-owned, idempotent unsubscribe used by
a successful subscription before preserving the original error. If the
callback replaced itself with a new same-function subscription during replay,
the failed outer generation cannot delete that replacement. Errors from an
already-owned listener during a later publication retain their existing
propagation and stop semantics.

*Verified:* the first public `RemotePeerSource` regression failed red because a
later publish rethrew `replay failed`, called the failed listener twice and
left a healthy listener at its initial replay. A deliberately unconditional
rollback made that regression green but failed the second red regression by
deleting a same-function replacement created during the outer replay. The
token-owned cleanup makes both green; removing replay rollback reproduces the
first failure, removing generation ownership reproduces the second, and
wrapping the replay error in a fresh same-message `Error` fails both strict
identity assertions. The focused file passes 15 tests, the World package
passes 24 files / 240 tests,
the full workspace passes 100 files / 1,428 tests, all workspace typechecks,
the production build, all 13 invariants, the tilemap check and diff hygiene.
No browser, wallet, provider, RPC, proof, signature, funds or transaction was
 used.

### 2026-08-29 — Starknet Start's MockWallet omits the Wallet API capability RPC

`@starknetfoundation/starknet-start-react@2.0.1` supplies the four Wallet
Standard features and handlers for `wallet_strk20Balances`,
`wallet_strk20PrepareInvoke` and `wallet_strk20InvokeTransaction`, but its
request switch does not implement `wallet_supportedWalletApi`. It therefore
cannot drive STRKWORLD's complete production session unchanged: capability
detection correctly fails rather than probing a private balance or inferring
support from wallet identity.

The forward-compatibility regression uses that installed MockWallet for
connection and all three STRK20 handlers, and wraps only its generic Wallet API
request to answer the required `0.10.3` capability query. Its exact dispatcher
permits only chain-id, capability and the three STRK20 methods, and the request
ledger rejects extras and duplicate route handoffs. It then dynamically
registers the arbitrarily named provider and drives every `PrivacyOperations`
route through `WalletAccountV6`, the stable production session and the
same-origin backend client. A parsed production-source gate rejects direct or
destructured provider `id`/`name` property keys except the display-only
wallet-name projection. It
also rejects every non-literal computed property read outside an exact
allowlist of the package's existing non-identity indexes, closing indirect key
aliases rather than trying to constant-fold them. Its hostile fixtures cover
aliases, membership, switch, nested feature IDs and direct, aliased, literal-
computed or identifier-computed access, declaration destructuring and
arbitrarily nested assignment destructuring.
This is a test-fixture correction, not a production wallet exception or
permission to weaken version-based capability detection.

*Verified:* an unmodified public-seam test failed red with exact upstream error
`Unknown request type: wallet_supportedWalletApi`. Inspection of the installed
`src/connectors/mock.ts` found the three STRK20 switch cases and no capability
case. Adding only the wrapper made capability, config, balances, recipient
preflight and shield/unshield/transfer/swap prepare-confirm paths green while
the exact request ledger proved no balance read occurred during capability
detection and no extra or duplicate wallet RPC was used. Hostile parsed-source
fixtures and production mutations proved both alias-name and nested feature-ID
identity branches fail the gate.
No browser, external network, live wallet, RPC, proof, signature, funds or
transaction was used.

### 2026-08-29 — Production Bridge recovery does not require a shield planner

The production composition previously supplied Bridge only the connected
account reader and an intentionally null public-shield planner. With no service
or source loader, `BridgeProvider` resolved to its unavailable runtime. This
correctly locked the physical deposit station, but it also removed D-043's
independent recovery path: a wallet-admitted player could not import, inspect,
refresh or export an already signed 1Click record. The Bridge package and Web
documentation claimed production browser storage/recovery that the composition
did not actually own.

Production now gives `BridgeProvider` a dormant loader beside the current
account authority. Wallet discovery, capability admission and ordinary city
play do not import the 1Click/viem runtime. Only mounting the Bridge panel asks
the loader to verify persistent Web Storage and construct `BridgeService` over
`OneClickSdkClient` and `LocalBridgeStore`. A chunk or storage failure leaves
only Bridge recovery unavailable; it cannot replace the wallet gate or city.
Loading performs no provider request. The public
shield planner remains exactly null, so `available()` remains false: the World
station, new quotes, deposit instructions and Bridge-to-Bank continuation stay
locked. Opening the recovery-only Menu panel reads local evidence without
fetching unusable new-deposit source metadata; only an explicit status refresh
or watch may contact 1Click. Saved-record recovery becomes real without an implicit
provider call.

*Verified:* the public production-runtime test failed red because the module
did not exist, while the connected `ProductionRoot` regression received only
account/read/planner and lacked recovery ownership. Independent review then
caught that the first candidate imported Bridge during wallet bootstrap and
let restricted storage replace the whole app. New public regressions prove the
loader remains dormant until a Bridge surface asks for it, first-mount and
StrictMode child-effect loads retain their owned result, replacement loaders
discard stale deferred results, rejected loaders leave the mounted app alive,
read/write/remove-denied storage exposes no runtime, and a storage failure
during panel open resolves into a bounded failed state rather than an unhandled
rejection. Green also proves loading makes zero
1Click calls, source loading is explicit, separate factories own separate
services, and production composes the exact loader with the current account
and null planner. `BridgeProvider` separately proves a loaded service
is exposed while capability remains false; the existing Bridge panel suite
proves planner-null saved evidence retains refresh/export without exposing
deposit instructions. A red-first machine regression also proves opening the
planner-null recovery panel does not load source assets or refresh provider
status. The Web suite passes 41 files / 468 tests and the full workspace passes
99 files / 1,423 tests. Every workspace typecheck, the production build, all
13 invariants and diff hygiene pass. No provider request,
wallet prompt, RPC, proof, signature, submission, funds or transaction was
used.*

### 2026-08-29 — Lobby transitions own FIFO subscriber generations

`LobbyClient` previously published status and peer changes through live mutable
`Set` iteration. During a normal resume, status listener A could react to the
`connected` event by calling the public `suspend()` method. The nested
`suspended` transition reached listener B before the outer iteration later
delivered stale `connected`, so B ended with a state opposite to the client's
authoritative `suspended` status. A listener added or unsubscribed and
resubscribed during delivery could also inherit a transition captured before
that subscription existed, and an older cleanup could remove the replacement.
A subscriber exception escaped the lifecycle method; a throwing immediate
status replay remained registered without returning cleanup and could make the
next `connect()` reject before joining while leaving status at `connecting`.

Both channels now own listener generations in maps and capture listener/token
pairs with each payload. Status and peer payloads drain synchronously in FIFO
order, while only the still-current captured generation receives a delivery.
Immediate replay remains synchronous, but a new generation is not delivered
the older in-flight payload a second time. Cleanup removes only its generation,
and callback errors emit only a fixed content-free diagnostic before being
isolated from the lifecycle and remaining subscribers. The thrown value is not
forwarded into Lobby logs. Lobby traffic, room state and the synchronous public
API are unchanged.

*Verified:* a real-server regression connects and suspends a client, then has
the first of two subscribers suspend again during resume; both now observe
`connected` followed by `suspended`, and the authoritative status is
`suspended`. A transport-double regression publishes a one-peer snapshot whose
first subscriber synchronously publishes a distinct two-peer snapshot; both
subscribers now observe the one-peer payload before the two-peer payload.
Twelve no-network public regressions cover throwing immediate and transition
callbacks on both channels without forwarding the thrown value, add and
same-function replacement during delivery, unsubscribe before a captured turn,
and stale cleanup ownership for status and peers. Before the fix the ten
ownership/error cases failed, the real-server status case left the second
observer with stale `connected`, and the peer FIFO case delivered the newer
snapshot before the older one to its second observer; the two
unsubscribe-before-turn cases pin the captured-generation contract. The
focused pair passes 55 tests, and the full workspace passes 98 files / 1,408
tests. Every workspace typecheck,
the production build, all 13 invariants and diff hygiene pass. No wallet,
provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-29 — WalletSession subscribers own captured delivery generations

`WalletSession.subscribe()` is an exported package boundary even though its two
current production consumers are React `useSyncExternalStore` callbacks. Its
mutable `Set` previously used live `forEach` delivery. A custom subscriber that
added or unsubscribed and resubscribed a listener during publish could give the
new generation a transition captured before it existed. Reusing the same
function for a later subscription also let an older cleanup delete the current
subscription. A thrown subscriber escaped the wallet/discovery callback and
blocked every later listener; during a connection transition that could turn an
already accepted state change into the surrounding connection failure path.

Subscriptions now own generation tokens in a `Map`. Publish captures
listener/token pairs at its start and delivers only pairs that remain current.
Cleanup is idempotent and removes only its own generation. Subscriber errors
are reported and isolated so the accepted snapshot and remaining notifications
survive. Delivery remains synchronous, payloadless and non-replaying;
`getSnapshot()` is authoritative and no transition queue was added.

This is defensive exported-seam hardening, not a reproduced player incident.
The shipped React 19 consumers use distinct callbacks whose effect cleanup and
setup occur after the synchronous publish stack; a StrictMode harness found no
listener mutation during ordinary connect/disconnect delivery.

*Verified:* public `createWalletSession()` regressions cover no replay,
add-during-publish, unsubscribe/resubscribe during publish, unsubscribe before a
captured turn, stale cleanup after same-function replacement, a throwing
listener followed by a healthy one, and synchronous reentrant delivery reading
the latest authoritative snapshot. The focused WalletSession suite passes 24
tests, Privacy passes 8 files / 156 tests and the full workspace passes 97 files
/ 1,394 tests. Every workspace typecheck, the production build, all 13
invariants and diff hygiene pass. Removing token liveness revives in-flight
replacement delivery; using identity-only cleanup removes the replacement;
removing error isolation throws and blocks the later subscriber. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-29 — Duplicate wallet account events preserve reviewed authority

`WalletSession` previously treated every connection notification as a new
financial generation. Wallet Standard providers may re-announce the current
accounts array after unlock or another full-state event. Even when the account
and mainnet chain were unchanged, that duplicate retired the operations facade
and made an already reviewed `PreparedBatch` reject and discard before
confirmation. A notification whose connection snapshot threw also escaped the
provider callback after operations were nulled while the public snapshot could
still claim the session was connected.

The connection snapshot is now read before retirement. A live connected
session whose strictly valid hexadecimal account and felt-equivalent mainnet
chain match its current authority treats the event as a semantic no-op.
Account validation runs before equivalence, so a decimal or otherwise malformed
numeric equivalent fails closed instead of inheriting signing authority. A
genuinely changed account/network still advances the generation and
reconstructs or rejects authority exactly as before. An unreadable snapshot
advances the generation, clears operations and publishes `failed` without
escaping the callback. Route policy, Wallet API actions and the public session
shape are unchanged.

*Verified:* deterministic public `createWalletSession()` regressions connect a
mainnet account, prepare reviewed work and then emit a felt-equivalent padded
connection notification, a throwing snapshot, or decimal `273` in place of current
`0x111`. The duplicate keeps the same generation, constructs operations once
and confirms without discard. The unreadable and malformed snapshots publish
`failed`, reject further operations and discard the old prepared batch before
confirmation, without throwing through the callback. The focused suite passes
17 tests, Privacy passes 8 files / 149 tests and the full workspace passes 97
files / 1,387 tests. Every workspace typecheck, the production build, all 13
invariants and diff hygiene pass. Removing the semantic no-op guard revives the
generation change; bypassing snapshot-failure handling makes the provider
callback throw; moving validation behind equivalence preserves malformed
authority. No browser, wallet, provider, RPC, proof, signature, funds or
transaction was used.*

### 2026-08-28 — A retained Phaser Game must rebind to its current React owner

The ref-counted World host deliberately defers teardown so React 19 StrictMode
does not create two Phaser Games and two WebGL contexts. That same retention
previously ignored the parent passed by a later acquisition. During rapid
wallet capability or account-tree replacement, a fresh `WorldHost` could
therefore acquire the still-live Game while its canvas remained under the
detached old DOM node. The Scene also retained the old Shell buses and
remote-peer source captured by the first wallet tree.

Host acquisition now distinguishes same-owner retention from a changed owner.
A same host/config remount cancels teardown without restarting. A changed host
or World config reuses the single Game but moves its stable World-owned Phaser
parent to the new React host. ScaleManager's own parent remains unchanged; its
public bounds read runs before refresh so the replacement dimensions apply in
that cycle. The runtime updates the registry and restarts the Street Scene.
Remote avatars resolve their source from that current registry on every Scene
create, so restart retires the old subscription before the replacement becomes
active. No wallet, financial or lobby wire field enters World.

*Verified:* deterministic public `createHost()` and `acquireWorld()`
regressions perform acquire A, release, then acquire B before deferred teardown.
The unpatched host returns the same instance still owned by A; the corrected
path keeps exactly one Game, moves both rendered DOM nodes to B, refreshes
the stable mount from a 640x480 A to a 960x540 B, reads B's bounds before
refresh, restarts with config B and leaves same-owner StrictMode remounts on
the existing Scene cycle. A real StreetScene lifecycle regression proves source A
is unsubscribed exactly once, source B is subscribed, and final shutdown
unsubscribes B. The focused set passes 4 files / 42 tests, World passes 24
files / 237 tests, and the full workspace passes 97 files / 1,384 tests. Every
workspace typecheck, the production build, all 13 invariants and diff hygiene
pass. Removing the runtime retarget hook revives the detached-parent failure;
restoring the Scene's first-construction source instead of resolving the
current registry fails the replacement-source regression. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used in the
red-green loop.*

### 2026-08-28 — Store subscriptions own captured transition generations

`createStore()` previously represented subscribers with a `Set` and read its
mutable global state while delivering each callback. Subscribing the same
function again therefore had no independent owner: an older unsubscribe could
remove the replacement, and an unsubscribe/resubscribe during publication
could make the replacement inherit a transition it did not own. A reentrant
`setState()` also delivered the newer transition before later subscribers saw
the older one, after which those subscribers received the newer global state a
second time instead of the captured older value.

Each subscription now has a generation token. Each accepted state transition
captures both its state and subscriber generations, then a single synchronous
queue drains those transitions in order. Delivery checks that the captured
generation is still live, so unsubscribe remains idempotent and a replacement
cannot inherit or revoke another generation. Existing `Object.is` suppression
and per-subscriber exception isolation are unchanged.

*Verified:* three public red-first `createStore()` regressions cover stale
unsubscribe after same-function resubscription, replacement during publication
and reentrant state delivery order. Additional public cases pin the captured
subscriber set for a queued transition, exact `Object.is` behavior and
subscriber-exception isolation. Removing the unsubscribe token check fails the
stale-owner case; removing delivery-time token equality fails replacement
liveness; removing the queue gate or using mutable global state fails ordered
delivery; using the live subscriber map fails captured transition ownership;
replacing `Object.is` with `===` fails the equality case; and rethrowing a
subscriber failure prevents the later subscriber from receiving the accepted
transition. The focused suite passes 1 file / 6 tests, Web passes 41 files /
460 tests, and the full workspace passes 97 files / 1,380 tests. All workspace
typechecks, the production build, all 13 invariants and diff hygiene pass. No
browser, wallet, provider, RPC, proof, signature, funds or transaction was
used.*

### 2026-08-28 — Event-bus subscriptions retain generation ownership during synchronous emit

The Web event bus previously stored one `Set` per event and iterated a
snapshot without checking whether each snapshot entry was still current. A
handler unsubscribed before its turn, or all handlers cleared during an emit,
could still receive that in-flight event. Because cleanup called
`off(event, handler)` by function identity, an older unsubscribe could also
remove a newer subscription of the same handler. A same-handler
unsubscribe/resubscribe during an emit must not inherit the old snapshot, but
must receive later emits.

The bus now stores a per-event `Map<handler, token>`. Each subscription owns a
token; returned cleanup removes only its token, explicit `off` removes the
current generation, and emit checks token liveness before delivery. `clear()`
empties the per-event maps before dropping them so it suppresses the remainder
of an in-flight snapshot. Existing synchronous reentrant emission, `once`
semantics and exception isolation remain unchanged.

*Verified:* five public event-bus regressions cover unsubscribe-before-turn,
stale same-handler cleanup, replacement by another handler before its
captured turn, same-handler resubscription during emit, and clear-during-emit.
The unpatched `origin/main` failed four of the five; the focused suite passes
12/12 after the change. The replacement-before-turn regression fails if token
equality is weakened to handler-presence (`Map.has`), proving the captured
generation—not merely the handler—is authoritative. No browser, wallet,
provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-28 — Avatar PNG filters are validated once per decoded row

The Avatar 1 source-parity test previously ran a Vitest assertion for every
decoded RGBA byte while reconstructing the 384x256 PNG: 393,216 assertion-
framework calls for data whose PNG filter is constant across each row. Under
hosted full-suite load that otherwise-correct evidence crossed Vitest's five-
second default timeout. The decoder now rejects filter bytes outside `0..4`
once before each row's byte loop and computes the same predictors without an
assertion-framework call per byte. The timeout is unchanged, and the exact PNG
SHA, decoded cell coordinates, crop hashes and parity evidence remain intact.

*Verified:* CI run 33209879035 attempt 1 recorded the exact parity test at
5,138 ms and rejected it at the 5,000 ms timeout. Five local baseline runs put
the test body at 1.28-1.35 seconds; five optimized runs put the complete file
at 131-138 ms with the test body at 9 ms. A new negative regression passes an
unsupported row filter through the unfiltering seam and observes the exact
error; removing the row guard makes that regression fail. The focused file
passes 3 tests, World passes 24 files / 233 tests, the full workspace passes
96 files / 1,369 tests, all workspace typechecks, the production build, all 13
invariants and `git diff --check`. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-28 — Horizontal camera follow is immediate for sharp pixel motion

The street camera previously eased toward the player on both axes with a
`0.12` lerp. During east/west movement, that fractional horizontal follow
softened otherwise hard sprite edges even though the renderer already used
pixel-art filtering, rounded pixels and integer zoom. Horizontal follow is now
immediate (`lerpX = 1`) while vertical follow retains its `0.12` ease. Movement
speed, physics body, collision, camera bounds and zoom are unchanged.

*Verified:* a live-browser screenshot loop reproduced horizontal hard-edge loss
independently of the active sprite. Source inspection confirmed `pixelArt:
true`, rounded camera pixels and zoom `2`, leaving the symmetric follow lerp as
the remaining horizontal smoothing. A public StreetScene camera regression
then failed on the previous `startFollow(player, true, 0.12, 0.12)` call and
passes with exact axis ownership `startFollow(player, true, 1, 0.12)` while
also pinning the unchanged `1536x896` bounds and zoom `2`. Fresh post-merge
rendered verification remains the project-lead handoff after the canonical
localhost restart.*

### 2026-08-28 — Avatar 1 cosy passes live rendered acceptance

James accepted the exact Avatar 1 cosy replacement as looking good in the live
game. This closes rendered acceptance only for the six-column `avatar-1.png`
with SHA-256
`f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb`.
Avatar 1 fighting and avatars 2-16 remain outside that acceptance, so the
aggregate remaining-sheets rendered gate stays open.

*Verified:* James reported the Avatar looked good after loading the exact
source-authoritative sheet in the live game. The per-key manifest records
`renderedAcceptance: true` for Avatar 1 cosy while the aggregate review state
remains false and names the remaining sheets as pending. The horizontal blur
James reported in the same review happened regardless of sprite and is tracked
separately by the camera finding above.*

### 2026-08-28 — Avatar 1 cosy owns a six-column per-sheet contract

Avatar 1 cosy now uses the exact user-approved 384x256 production PNG with
SHA-256 `f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb`.
Its four 64x64 facing rows contain `idle`, `contact-left`, `passing-left`,
`contact-right`, `passing-right` and `settle`. World therefore owns width, row
stride, playback columns and remote-cycle duration per sheet instead of using
one global five-column assumption. Avatar 1 fighting and Avatar 2-16 retain
their prior five-column geometry and pixels; the lobby still carries only the
opaque cosmetic key.

The exact PNG preserves the approved down-eye correction. The rejected
left/right eye-lock pass remains excluded: the approved side rows are restored
pixel-identically and the up row is unchanged. The historical Aseprite source
does not encode the sixth column and must not overwrite this source-authoritative
PNG. Its 21 cells above the prior 24-colour cap are also intentional: Avatar 1
cosy alone has a maximum of 29 colours per frame, while Avatar 2-16 retain the
24-colour default. No palette remap or broader exception is authorized.

*Verified:* the source SHA and 384x256 PNG header were checked before and after
the copy. Dedicated public tests pin that exact hash, geometry, 24/24 passing
cell reports, binary alpha, all 24 decoded sheet-crop hashes, down-eye evidence,
side-row reversion, frozen nested playback authority, six-column preload/row
offsets and per-sheet remote idle duration while retaining the five-column
Avatar 2-16 contract. The focused suite passes 3 files / 20 tests; the exact
reviewed branch passes 95 files / 1,362 tests, all workspace typechecks,
the production build, all 13 invariants and diff hygiene. No browser, lobby,
wallet, RPC, proof, signature, funds or transaction was used at that checkpoint.
Its open Avatar 1 cosy rendered status is superseded by the rendered-acceptance
finding above; the remaining sheets stay open.*

### 2026-08-28 — Presence status subscribers retain transition ownership

`PresenceController` now snapshots status subscribers as listener/generation
pairs, checks that the generation is still current before delivery, and makes
each unsubscribe closure remove only its own generation. Before the fix, the
live `Set` could notify a listener added by an earlier callback during the
same status transition; an unsubscribe followed by resubscription of the
same function could revive the old recipient; and an older unsubscribe could
remove a newer replacement. A snapshot without a liveness check would also
call a listener that was unsubscribed before its turn. These cases could make
the Web shell observe extra or stale presence updates.

*Verified:* public `PresenceController` regressions drive transitions through
`listen(world)` and a controlled public client. Against origin/main, the
focused file had 34 tests with three failures: add-during-transition,
same-function unsubscribe/resubscribe, and stale-unsubscribe ownership. The
plain unsubscribe-before-turn test passes origin/main because native live
`Set` iteration skips a deleted listener. Removing the liveness check from
the fixed snapshot makes both unsubscribe-before-turn and resubscribe fail;
using `Map.has()` instead of generation equality makes resubscribe fail; and
unconditional deletion makes stale-unsubscribe fail. A reentrant status test
pins the existing synchronous current-state behavior: callbacks carry no
payload and read the latest `getState()` value, so no queue was introduced.
The focused file passes 34 tests, Web passes 40 files / 449 tests, the full
workspace passes 94 files / 1,363 tests, all workspace typechecks, the
production build, all 13 invariants and `git diff --check`. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.

### 2026-08-28 — Remote peer publication snapshots listeners

`RemotePeerSource.publish()` now snapshots its subscribers before synchronous
delivery and checks that each snapshot listener is still subscribed before
calling it, with a generation token preventing an old subscription from
matching a same-function replacement. Before the fix, a listener added by an
earlier listener during a publication received the retained snapshot once
from `subscribe()`'s synchronous replay and again when the live `Set`
iteration reached it. A snapshot-only intermediate fix also called a
listener that an earlier listener had unsubscribed and then resubscribed.
These paths could duplicate or revive a World-side remote-avatar
reconciliation for one lobby snapshot.

*Verified:* add-during-publish and reentrant-publication regressions failed on
the origin/main baseline. The plain unsubscribe regression passes origin/main
because the live `Set` skips a listener deleted before its turn, but fails
when the snapshot iteration has no liveness check. The same-function
resubscribe regression fails without generation-token matching, and the
stale-unsubscribe regression fails when an old closure can delete a
replacement. All pass after the queued snapshot drain, liveness check and
generation ownership fix. Removing the reentrancy gate reproduces the
ordering failure; removing token matching reproduces the resubscribe
failure; and removing token ownership from unsubscribe removes the replacement
subscription. An additional regression pins the existing synchronous
listener error propagation and stop behavior, while the existing clear/replay
tests remain green. The focused World suite passes 22 files / 227 tests; the
full workspace passes 94 files / 1,358 tests, all workspace
typechecks, the production build, all 13 invariants and `git diff --check`.
No browser, wallet, provider, RPC, proof, signature, funds or transaction
was used.

### 2026-08-28 — Lobby resume validates placement before claiming presence

`LobbyClient.resume()` previously sent a resumed placement and immediately
marked the wrapper `connected`, even when the placement contained a non-finite
coordinate. The server's `LobbyPresence.#place()` rejects that request, so the
connection remains suspended and absent from every peer view while the client
reports connected. That leaves the Shell with false presence state and no
future resume or move path to repair it.

The client now rejects a non-finite resume placement before sending
the message or changing status. Valid resume, explicit suspend and disconnect
ownership are unchanged; this is a local synchronous guard, so it cannot race
or overwrite a concurrent disconnect.

*Verified:* the table-driven public real-server regression first failed
against the unpatched client because both `resume({ x: NaN, y: 0 })` and
`resume({ x: 0, y: Infinity })` returned without throwing. It now observes the
walker appear, suspend and disappear from a second client, then proves each
invalid resume leaves the wrapper suspended and the server-side peer absent
after settlement. Removing either the x or y finite-coordinate clause makes
its corresponding case fail. The focused lobby drop/reconcile/presence suites
pass 33 tests, the full workspace passes 94 files / 1,352 tests, all workspace
typechecks, production build, all 13 invariants and `git diff --check` pass.
Verification used only a local lobby server; no browser, wallet, RPC, proof,
signature, funds or transaction was used.

### 2026-08-28 — Room navigation and three admitted stations pass; Bridge deposit stays locked

The live D-057 mock Chrome run now accepts physical entry and exit for every
fixed room. The avatar entered the Post Office, Exchange and Bank through each
street door, physically approached the gold/highlighted admitted station, and
automatically opened the correct panel: **Private transfer**, **The Exchange**
and **The Bank**, respectively. In each panel an `F` press while Shell owned
input was suppressed; after the panel closed, the avatar was still visibly
cosy without a fighting weapon. The avatar then walked through each room's
floor exit and returned to the connected multiplayer street.

The Bridge room's navigation is accepted separately: the avatar entered from
the street and physically exited back to multiplayer. Repeated physical
approach at `bridge:deposit` showed the **DEPOSIT** label but did not highlight
or activate an admitted station or open its panel. That result keeps the
Bridge station integration explicitly open/locked; it is not classified as a
defect. Current source intentionally requires both an account and an injected
public-shield planner before admitting that station, while the production
composition still supplies `planner: null`. World renders that locked station
in its grey state with the label visible and emits station activation only for
an available snapshot; the separately opened Menu Mode surface does not grant
physical-station admission. The production planner, live route and funded
Bridge handoff therefore remain their existing later gates.

Together with the previously accepted Avatar Studio flow, all room navigation
and physical exits are accepted. Bank, Post Office and Exchange rendered
station integration is accepted. Bridge station integration, subjective
final-art quality, live-wallet behavior and funded validation remain open.

*Verified:* direct visual inspection in live Chrome on canonical main
`8c892d0` confirmed the four fixed-room entry/exit paths, the three named
station panels, their highlighted approach state, panel-owned `F` suppression
and the unchanged cosy avatar after close. Direct inspection in Bridge
confirmed the visible **DEPOSIT** label without highlight, activation or panel
after repeated approach, followed by its physical exit. Source inspection of
`apps/web/src/visits/station-registry.ts`, `VisitLayer.tsx` and
`production/ProductionRoot.tsx`, plus `packages/world/src/fixed-room.ts` and
`scenes/street-scene.ts`, confirmed that Bridge admission requires both runtime
capabilities, production currently supplies no planner, and the locked World
presentation cannot activate. The gateway was mock-only. No real wallet or
live/private balance read, proof, signature, submission, transaction or funds
were used.

### 2026-08-28 — The rendered functional and interactive D-053 matrix is complete; subjective art remains open

**Room/station status superseded by [the rendered room and admitted-station
finding](#2026-08-28--room-navigation-and-three-admitted-stations-pass-bridge-deposit-stays-locked) above: Bank, Post Office and Exchange panel-specific integration is now accepted; Bridge remains open/locked. The generic D-053 evidence below remains accepted.**

The live D-057 Chrome run entered the Exchange and Bridge after the Bank. In
each room, one `F` press changed cosy to fighting with the weapon visible and a
second `F` press returned fighting to cosy. Combined with the already accepted
outdoor, Avatar Studio, Bank and Post Office pairs, both directions are now
rendered and verified everywhere the local avatar is playable: outdoors,
Avatar Studio and all four fixed rooms. This completes the positive outfit-pair
location matrix. The remaining Studio figure context is also accepted: while
the local avatar visibly overlapped the central green Studio figure, one `F`
press changed cosy to fighting with the weapon visible while the overlap was
maintained, and a second restored cosy. The generic station-panel gate is
accepted too: while the avatar was visibly cosy in Bridge, Menu Mode opened
the Bridge station panel and gave it input ownership; an `F` press while the
panel was open did not change the avatar, which remained visibly cosy without a
fighting weapon after the panel closed. Together these checks complete D-053's
rendered functional and interactive matrix. Subjective final-art quality
remains open.

*Verified:* direct visual inspection in live Chrome confirmed both outfit
transitions and the fighting-state weapon inside Exchange and Bridge. Earlier
checks in the same D-057 run already confirmed the identical pair outdoors,
inside Avatar Studio and inside Bank and Post Office. The localhost gateway was
mock-only. Direct inspection confirmed the Bridge panel suppression sequence.
D-053 defines one generic station-panel keyboard-ownership gate, and the shared
fixed-room controller routes every Shell-owned station panel through the same
`InputGate.suspended` guard, so this accepts that generic control without
claiming each panel UI. Direct inspection on canonical main `6b9d3e0` confirmed
both transitions while the avatar visibly overlapped the central green Studio
figure. No live wallet, proof, signature, submission, transaction or funds
were used.

### 2026-08-28 — The Bank two-client matrix and outfit pair pass rendered acceptance

The live D-057 Chrome run now closes D-038's exact Bank matrix. Reciprocal
movement between the two connected clients had already been verified. With B
visibly rendering A at the Bank doorway, A entered the Bank and disappeared
from B. After A used Leave building, A visibly reappeared in B at the restored
Bank doorway. Inside the Bank, one `F` press changed cosy to fighting with the
weapon visible and a second returned fighting to cosy. This supersedes the
open-Bank wording in the findings below. Exchange and Bridge interior outfit
pairs are accepted by the newer positive-location finding above; D-053's
generic panel suppression is also accepted there. Studio while standing on a
figure is accepted by the newer D-053 finding above; subjective final-art
quality stays open.

*Verified:* direct visual inspection of both live Chrome clients confirmed A
at the Bank doorway, disappearance on Bank entry and restored-doorway
reappearance after exit. Direct inspection inside Bank confirmed both outfit
transitions and the fighting-state weapon. Both clients used the localhost
D-057 mock provider. No live wallet, proof, signature, submission, transaction
or funds were used.

### 2026-08-28 — Outdoor, Post Office and Avatar Studio outfit pairs are rendered evidence, not the full F matrix

The live D-057 Chrome run at `http://127.0.0.1:5173/` now verifies both
directions on the same local avatar outdoors, inside the Post Office and inside
Avatar Studio: one `F` press changed the cosy outfit to the fighting outfit
with its weapon visible, and a second `F` press returned the fighting outfit to
the cosy outfit without the weapon. The hidden south portal was crossed and the
Studio's rendered figures were visible before its pair was checked. Leaving
through the Studio's top exit returned the avatar to the street spawn with
`Multiplayer connected`, and the other client rendered again. This supersedes
the earlier one-direction finding below. The Bank pair is recorded in the
newer finding above; Exchange and Bridge interiors, and subjective final-art
quality were still open at that checkpoint. The newer positive-location finding
above accepts those two interior pairs. D-053's remaining context/keyboard
status is superseded by that same finding: only Studio while standing on a
figure was still open at that checkpoint. The newer D-053 finding accepts it;
subjective quality stays open.

*Verified:* screenshots and direct visual inspection from the live Chrome
D-057 session captured the local avatar outdoors in the fighting state with its
weapon visible and then back in the cosy state after the second `F` press. The
same two-transition sequence was visually verified after entering the Post
Office interior and after crossing the hidden south portal into Avatar Studio,
where the rendered figures were visible. Direct inspection then confirmed the
Studio top exit restored the street spawn, the connected multiplayer status and
the other rendered client. The wallet-gated World and lobby were mounted
through the mock-only gateway. No live wallet, proof, signature, submission,
transaction or funds were used.

### 2026-08-28 — The Post Office two-client presence lifecycle is rendered partial evidence

**Its open-Bank status is superseded by [the accepted Bank matrix finding](#2026-08-28--the-bank-two-client-matrix-and-outfit-pair-pass-rendered-acceptance) above; the Post Office evidence remains accepted as recorded.**

Two promptless D-057 Chrome clients connected through the mock-only gateway
and each visibly rendered the other. Movement by client B was replayed in A,
and movement by A was replayed in B. When A entered the Post Office, A
disappeared from B; after A used Leave building, A reappeared in B at the
restored Post Office street placement. This accepts that exact Post Office
two-client lifecycle only. At that checkpoint D-038's Bank-entry matrix was
still open; the newer Bank finding above closes it.

*Verified:* direct visual inspection of both live Chrome clients confirmed
bidirectional remote movement, Post Office entry disappearance and restored-
placement reappearance after exit. Both clients used the localhost D-057 mock
provider. No live wallet, proof, signature, submission, transaction or funds
were used.

### 2026-08-28 — One outdoor outfit transition is rendered evidence, not the full F matrix

**SUPERSEDED on 2026-08-28 by [the outdoor, Post Office and Avatar Studio pair finding](#2026-08-28--outdoor-post-office-and-avatar-studio-outfit-pairs-are-rendered-evidence-not-the-full-f-matrix) above.**

The D-057 Chrome gateway at `http://127.0.0.1:5173/` admitted through the
wallet gate and mounted the World and lobby. While the local avatar was
outdoors on the street, one `F` press visibly changed it from the cosy outfit
to the fighting outfit with its weapon. This is evidence for that single
rendered transition only. The reverse fighting-to-cosy transition, Avatar
Studio, fixed-room interiors and subjective final-art quality remain open.

*Verified:* observed directly in the live Chrome D-057 session on the current
local build: wallet-gated World/lobby mounted, then one outdoor `F` press
changed the local avatar from cosy to fighting with the weapon visible. No
live wallet, proof, signature, submission, transaction or funds were used.

### 2026-08-23 — A fast-forward can leave Vite serving pre-merge modules

Fast-forwarding the canonical checkout while its Vite process remains alive
can leave the browser receiving transformed modules from before the merge;
HMR is not a sufficient post-merge freshness guarantee. After a fast-forward,
restart the affected dev server from the canonical checkout and verify a
served module or other current-build behavior before browser acceptance.

*Verified:* after the checkout advanced, the existing local Vite process still
served the pre-merge `main.tsx`; restarting Vite from the canonical checkout
then served the current source and the wallet-gated application rendered the
expected current behavior.

Append what you learn. Newest first. Include how you verified it — a finding
without a verification method is a rumour.

Format: `### YYYY-MM-DD — short title` then what, why it matters, how verified.

### 2026-08-23 — Browser fetch must retain its global receiver

`BackendPrivacyClient` previously captured the browser's `fetch` method as a
bare function and invoked it through the client instance. Window's Web IDL
fetch rejects that receiver before a request is sent, so a live pool-config
read surfaced the generic unreachable message even though the same endpoint
returned 200 through the Vite proxy.

The client now preserves injected test fetchers and binds its default fetcher
to `globalThis` at construction. This changes no URL, payload, response
schema, backend route, or financial behavior.

*Verified:* a public `BackendPrivacyClient.config()` regression uses a
receiver-sensitive browser-fetch double. It fails before the fix with
`TypeError: Illegal invocation` and passes after binding; the live Chrome
diagnostic captured the same pre-network failure from the Post Office pool
read. Privacy tests pass 8 files / 146 tests; the full workspace passes 94
files / 1,344 tests, all workspace typechecks, production build, 13
invariants and diff hygiene. No wallet prompt, RPC, proof, signature, funds
or transaction was used by the fix verification.

### 2026-08-23 — Bank signing ownership follows the confirmation attempt

The Bank panel used one mutable `signing` boolean and unconditionally cleared
its prepared-batch reference when any confirmation settled. If an older batch
A was still signing while a newer batch B was prepared or handed to the wallet,
A's late success or failure could clear B's ownership. Closing then discarded
B while it was signing, losing the receipt path; conversely, a newer prepared B
that had not entered wallet handoff could be left undisposed because the broad
signing flag suppressed every disposal.

The same stale-success path also cleared the shared accumulator before checking
attempt liveness. After close/reopen and a newer B was prepared, the review
still showed B while the underlying queue was empty; cancelling and preparing
again then reported nothing queued.

The panel now records the owning confirmation attempt and exact prepared batch.
Disposal is suppressed only when the current prepared batch is that signing
batch. A settling attempt clears the owner and prepared reference only when it
still owns them, and it clears the accumulator only while that attempt still
owns the live panel session. Receipt recording remains unconditional,
uncertainty remains single-attempt with no blind retry, and the existing
attempt, session, composition and balance-read clocks are otherwise unchanged.

*Verified:* four public `createBankPanel()` regressions use deferred distinct
batches. They cover stale A resolution followed by B failure, stale A rejection
while B is signing followed by close, A signing followed by preparation and
close of unconfirmed B, and stale A success after close/reopen while B remains
authoritative through cancel/reprepare. The focused Bank suite passes 78 tests,
Web passes 40 files / 416 tests, the full workspace passes 94 files / 1,321
tests, and all workspace typechecks, production build, 13 invariants and diff
hygiene pass. Replacing exact-batch disposal with broad signing suppression
fails the unconfirmed-B regression; removing owner-generation guards fails the
stale-A rejection regression; unconditionally clearing `prepared` fails
stale-A resolution; and unconditionally clearing the accumulator fails the
close/reopen composition regression. No browser, wallet, provider, RPC, proof,
signature, funds or transaction was used.*

### 2026-08-23 — Exchange signing ownership follows the confirmation attempt

The Exchange panel previously used one mutable `signing` boolean and one
mutable prepared-batch reference across panel sessions. A stale confirmation
could therefore clear the guard for a newer wallet handoff, causing close to
discard the newer batch while it was signing; a stale successful confirmation
could also clear the newer reference, so that batch could not be released when
its own confirmation failed. A newer prepared batch could also be silently
dropped when an older batch was still signing, because disposal was suppressed
for every active signing owner rather than only the batch in handoff.

The panel now owns the signing guard by confirmation attempt and exact batch,
and clears the prepared reference only when it still points to the settling
batch. A newer batch that never enters wallet handoff is disposed normally.
Receipt recording and stale-session behavior remain unchanged.

*Verified:* three public Exchange-machine regressions use deferred, distinct
batches. They cover stale A rejection while B is signing, stale A success
while B is live, and A signing followed by B preparation and close before B
handoff. The focused suite passes 21 tests, Web passes 39 files / 411 tests,
the full workspace passes 94 files / 1,317 tests, and typecheck, production
build, all 13 invariants and diff hygiene pass. Removing either attempt guard
or the exact-batch guard makes its corresponding regression fail. No browser,
wallet, provider, RPC, proof, signature, funds or transaction was used.*

### 2026-08-23 — D-005 raw-scans shell and YAML source

The D-005 static header gate no longer tries to parse shell or YAML comments.
Those syntaxes are executable/configuration grammars with nested `$()` scopes,
odd backslash continuations, heredoc expansion, multiline quoted scalars and
ANSI-C quoting; each new parser patch left another way to erase effective text
before the forbidden-header patterns ran. Shell and YAML now use the scanner's
`none` syntax, so `stripComments()` is an identity transform for those files
and comments are scanned as source. The narrower comment parser remains for
syntax the gate can own, such as JS block comments, HTML comments, SQL and
Dockerfile hash comments.

This is conservative for the actual repository. A raw inventory of every
`.sh`, `.bash`, `.zsh`, `.ksh`, `.yml` and `.yaml` file found only the
self-referential `scripts/check-invariants.sh` vocabulary; that file is already
explicitly excluded from the static header scan. No accepted non-self-
referential shell or YAML comment names a forbidden header, so raw scanning
does not create a repository false positive. This does not claim that every
future shell/YAML comment is inert: adding the forbidden vocabulary there is
intentionally a failure that must be removed or moved to an owned comment
syntax.

*Verified:* red-first public `scanText()` fixtures cover nested command
substitutions, three- and five-backslash continuations, an unquoted heredoc
expansion, a YAML multiline double-quoted scalar and ANSI-C quoting; each
reports the effective source line. Additional fixtures prove in-word and
escaped hashes are scanned, shell/YAML comments are scanned, and raw source is
not erased. The focused header suite passes 33 tests. A source inventory using
`rg` found only the excluded self-referential shell hit, and the static phase
scans 315 files with no violation. The exact head then passed the
production build, D-005 built/live checks with 30 responses, all 13
invariants, tilemap validation, workspace typecheck and 94 files / 1,314
tests. No browser, network, wallet, RPC, proof, signature, funds or
transaction was used.*

### 2026-08-23 — Production wallet authority is one privacy-owned generation

The production browser composition previously had no real wallet lifecycle: it
mounted the explicit demo path during development and refused that practice
seam in production. `packages/privacy` now owns a `WalletSession` around
dynamic Wallet Standard discovery, explicit provider selection and
`WalletAccountV6`. Web receives only frozen choices plus the current phase,
account and generation, and imports no wallet library or wallet-specific branch.

One generation owns its concrete account and wallet-backed operations. A newer
connect, account/network change, disconnect or wallet removal retires the old
authority. Results and failures from old reads are replaced with the generic
changed-account outcome; a batch returned after retirement is discarded, and a
previously returned batch rechecks ownership before confirmation. The production
composition gives Bridge that same reactive account authority while retaining a
null public-shield planner.

Production and explicit real-wallet development dynamically load this path;
the initial Shell graph remains free of the Starknet wallet implementation.
Public configuration accepts only `SN_MAIN`, an HTTPS credential-free browser
RPC and same-origin `/api`. Its frozen route policy has zero intents, zero
relay fee, no enabled routes and empty token lists, so Phase 1 can discover,
connect and query capability without authorizing preparation, proof, signature,
submission or funds movement.

*Verified:* public session regressions cover explicit selection, concurrent
connect ownership, wallet disappearance, wrong-network recovery, empty and
invalid accounts, disconnect, partial Wallet Standard change events that omit
accounts, account changes before and during preparation, old-result and
old-error suppression, replacement-adapter failure, immutable policy ownership
and an account event arriving during the initial chain read. The production
composition test pins the same operations/session/account authority; Connect UI
tests pin selection by opaque discovery key; config tests pin every deny-all and
fail-closed clause; the Shell architecture test caught and then rejected an
eager Starknet import. The complete workspace passes 94 files / 1,297 tests
with two workers; every workspace typecheck, the production build, all 13
invariants, the D-005 static/live header gate, tilemap check and diff hygiene
pass. That headless verification used no browser, external network, live
wallet, RPC, private-balance read, proof, signature, submission, funds or
transaction. A later Chrome preflight loaded the local real-wallet build,
entered the Post Office and rendered the explicit discovered-wallet picker; the
connected profile exposed MetaMask only and no Ready choice. No provider was
selected, account shared, wallet prompt opened, capability queried, balance
read, proof, signature, submission, funds or transaction used. Rendered Ready
behavior and every funded route remain explicit later gates.*

### 2026-08-20 — Bridge cancellation and supersession own different evidence

Bridge quote creation checks the active account before requesting a signed
provider quote, after that quote, and after planning the exact public shield.
The third check previously had no ownership checkpoint after its `await`. If
the panel closed while that read was pending, `close()` cancelled the quote
flight and advanced both session and attempt, but the late continuation still
published the shield plan, provider-fee notice and deposit instructions into the
closed panel. It also skipped the existing cancelled-quote cleanup, leaving the
just-saved signed record held by the service.

The final account read now distinguishes two owners. An explicit cancellation
(`close`, `discard` or a valid `import`) runs the existing signed-evidence
cleanup and restoration before returning. A stale attempt or session created
by a non-cancelling action such as Refresh returns without touching the signed
record that action adopted. Both paths stop before rereading service state or
publishing instructions. Quote contents, planner policy, account validation,
import and discard precedence, and the public Bridge interface are unchanged.

*Verified:* a public `createBridgePanel()` regression returns the active account
for the first two checks and defers the third. Red published
`instructionsVisible: true`, the shield plan and provider-fee notice instead of
preserving the closed snapshot; green preserves it, discards the cancelled
signed quote exactly once and leaves no saved record. The same third-read seam
pins Discard and Import, including restoration of imported evidence after
cleanup. Independent review exposed a second red: treating every stale attempt
as cancelled made Refresh discard the signed evidence it had just adopted.
Green retains that evidence without publishing the old continuation. Removing
the explicit-cancellation branch fails Close and Import; removing the stale
attempt return fails Refresh, so the two ownership clauses are independently
observed. The focused Bridge suite passes 1 file / 40 tests, the Web suite
passes 37 files / 400 tests and a one-worker full workspace run passes 89 files
/ 1,273 tests. Workspace typecheck, production build, all 13 invariants and
diff hygiene pass. The behavioral checks use only in-memory test doubles: no
browser, external network, wallet, RPC, proof, signature, funds or transaction
was used.*

### 2026-08-20 — The Backend launcher admits only a regular entry file

The standalone Backend launcher previously checked only that `BACKEND_ENTRY`
existed. A directory therefore passed deployment admission and reached Node's
dynamic import, which exited as an ordinary crash and printed the raw
`ERR_UNSUPPORTED_DIR_IMPORT` stack plus absolute host paths. Requiring a regular
file closed that static case, but `statSync()` and dynamic import remained a
time-of-check/time-of-use pair: replacing an admitted file with a directory in
between reproduced the same raw crash. Revoking the admitted file's read
permission in that interval similarly escaped as `EACCES` with a stack and
canonical host path. The process no longer reports any of those exact-entry
admission cases outside the bounded configuration failure that an orchestrator
can classify without leaking its image layout.

Launcher admission now requires the resolved entry to be a regular file before
any import can construct the Backend composition root or listener. A missing
path, directory or directory symlink returns the same path-free configuration
message and EX_CONFIG `78`. If the admitted target becomes missing or a
directory before Node resolves that exact entry URL, or becomes unreadable
before Node opens its exact absolute or canonical path, the launcher returns
the same result. Public Error fields are not phase ownership: Backend code can
throw the exact loader tuple `EACCES` / `open` / admitted-entry path. A
package-local ESM customization hook therefore wraps only Node's resolver and
loader for the exact absolute/canonical entry URL and sets a private shared bit
before rethrowing an admitted failure. Module evaluation begins only after that
hook returns, so the launcher's catch trusts the bit rather than the Error
shape. An exception thrown by the Backend or a missing or unreadable nested
dependency remains an ordinary startup crash. Successful regular-file startup,
Backend runtime configuration, request handling, logging and deployment layout
are unchanged.

*Verified:* public subprocess regressions cover a missing entry, a real
directory, a symlink to that directory and deterministic admitted-file races.
One process preload replaces the entry immediately after the launcher's
`statSync()` returns its regular-file result; another removes read permission
from both direct and symlinked regular-file entries at that same point. Before
the guards those races exited `1` with raw `ERR_UNSUPPORTED_DIR_IMPORT` or
`EACCES`, a stack and host paths. After the guards every admission case has
empty stdout, exact generic stderr, no raw Node error code, stack or configured,
absolute or canonical path, and exits `78` before the Backend can construct a
listener. Separate real-entry cases prove a Backend-thrown error and missing or
unreadable nested dependencies still exit `1` with their original diagnostics;
one now throws the loader's exact public tuple from Backend evaluation and
retains its marker, stack and exit `1`. Bypassing the private bit revives both
entry races; restoring a field-tuple fallback hides that Backend marker;
dropping exact URL scoping hides a nested resolution failure; and dropping
canonical identity revives the symlinked-entry race. A regular entry also exits
`0` with no launcher stderr. The focused launcher test passes five tests. The
[official Node 22.12 module documentation](https://nodejs.org/download/release/v22.12.0/docs/api/module.html)
confirms `module.register()` runs its asynchronous hooks on a separate loader
thread and passes caller data into `initialize()`. The full workspace passes 90
files / 1,274 tests; workspace typecheck, production build, all 13 invariants,
the tilemap check and diff hygiene pass. Runtime/test verification opened no
listener and used no wallet, RPC, proof, signature, secret, funds or
transaction; that single read-only documentation fetch was the only external
network access.*

### 2026-08-20 — A fixed-room station snapshot cannot grant itself admission

`createFixedRoomController()` publishes its current station presentation through
both the public `state` getter and `onChange`. Those readonly types previously
shared the controller's live, mutable station array and objects. Runtime
`readonly` provides no protection: a consumer could replace an array entry or
write its `status` from `locked` to `available`. The controller then trusted
that mutated status on the next approach and emitted `station:activated` even
though the Shell had never admitted the station.

Normalized station snapshots now own and freeze both levels of that authority:
the array and each flat station value. The controller may still replace the
whole internal snapshot when a legitimate matching `world:stations` event
arrives, while render projections, labels, control handoff and activation
ordering are unchanged.

*Verified:* two public controller regressions enter the Post Office with the
default locked snapshot, then attempt the mutation through `controller.state`
and through the value delivered to `onChange`. Before the fix, both object
writes succeeded and a station approach emitted the forged activation. Green
rejects item writes and array replacement, keeps the internal status locked and
emits nothing. Removing the per-item freeze fails both public paths; removing
the array freeze fails the replacement case, so both ownership levels are
independently observed. The existing legitimate Shell-admission activation and
station-presentation tests remain green. Local verification used no browser,
network, lobby, wallet, RPC, proof, signature, funds or transaction. The
focused fixed-room suite passes 33 tests, the World suite passes 22 files / 221
tests and the full workspace passes 89 files / 1,269 tests with two workers;
workspace typecheck, production build, all 13 invariants and diff hygiene
pass.*

### 2026-08-20 — A settled Connect query must release ownership after it acquires it

`createConnectFlow()` shares one in-flight wallet capability query so repeated
Connect/Recheck actions cannot open duplicate wallet work. Its attempt body
previously cleared that owner in an internal `finally`, then the caller assigned
the attempt to `inFlight`. Normally the first `await` delayed `finally` until
after assignment. A conforming adapter can also throw synchronously before it
returns a promise; that path ran `catch` and `finally` before the assignment,
then installed the already-settled promise permanently. The first Connect
correctly reached `unreachable`, but every later Try again/Recheck returned that
same stale result without asking the wallet again.

Attempt release is now registered only after the promise has acquired
`inFlight`. The existing generation guard still scopes release to its owner: an
older capability query cannot clear a newer recheck started after a later
operation established an account verdict. Concurrent callers still share one
query; disconnect, stale success/failure and operation-verdict ownership are
unchanged.

*Verified:* a public `createConnectFlow()` regression makes the first
`capability()` call throw synchronously and the second resolve registered. It
was red with two `unreachable` results and one adapter call; green reaches
`connected` on Recheck with exactly two calls. A second public-seam interleaving
starts query A, publishes a newer `not-registered` operation verdict, starts
recheck B, then settles A; B remains the shared owner. Removing the release
generation check makes that test start an unexpected third capability query.
The focused Connect suite passes 1 file / 20 tests and the Web suite passes 37
files / 396 tests. A one-worker full workspace run passes 89 files / 1,267
tests; workspace and Web typechecks, production build, all 13 invariants and
diff hygiene pass. Standard parallel full runs on the shared development host
also exposed unrelated timing-only failures in unchanged Fly/image-smoke and
demo-Bridge tests; exact-head hosted CI remains the standard parallel gate.
Local verification used no external network, wallet, RPC, proof, signature,
funds or transaction.*

### 2026-08-20 — An in-word hash cannot hide an effective header directive

**Superseded by “D-005 raw-scans shell and YAML source” above. The earlier
grammar-patch verification remains historical; shell/YAML comment exemptions
are no longer part of the gate.**

The D-005 static header gate treated every unquoted `#` in hash-comment file
types as the start of a comment. Bash and YAML both keep an in-word hash as
data, so effective shell or workflow code later on the same line disappeared
from the scan. The first boundary fix still read raw source characters rather
than shell tokens: an escaped space before `#`, or a backslash-newline before a
line-start `#`, kept the hash inside the active word in Bash but looked like a
comment boundary to the scanner. A deploy command could therefore set one of
the cross-origin isolation headers that break wallet popups while the dedicated
CI job reported the source clean.

Shell files now have their own hash-comment mode. Escaped whitespace does not
open a comment boundary, and an odd trailing backslash carries only whether the
next physical line begins inside the same shell word. A later review found two
more shell-token gaps: quote state reset at every physical newline even though
single and double quotes may span lines, and only whitespace or line start was
treated as a comment boundary even though an unescaped control operator also
ends the prior word. A multiline quote could therefore put a line-start hash
inside data and hide an effective directive after its closing quote, while a
real `;#` comment was falsely scanned as code.

The next exact-head review found one remaining quote-mode collapse. Bash
ANSI-C strings (`$'…'`) let a backslash escape an embedded single quote, while
ordinary single quotes treat backslashes literally. The scanner treated both
as ordinary single quotes, closed its quote at an ANSI-C escaped quote, then
misread the next line's leading hash as a comment and hid effective code after
the real closing quote.

Shell quote state now follows physical lines until the matching quote, and an
unescaped shell control operator opens a real hash-comment boundary. YAML and
the other hash-comment formats retain their independent start/whitespace rule;
ordinary single and ANSI-C quote modes are distinct, so only ANSI-C quoting
consumes a backslash escape. Genuine shell comments at line start or after
ordinary whitespace remain exempt. Other comment syntaxes and the
built-response phase are unchanged.

*Verified:* Bash itself parsed `safe#still-word after` as two ordinary
arguments. Through the exported `scanText` seam, red-first `.sh` fixtures put a
forbidden header after an in-word hash, an escaped-space hash and a continued
line-start hash; the original parser missed all three, and the first fix still
missed the latter two. A `.yml` in-word case is also caught, while the same
escaped-space source remains a YAML comment. Removing escaped-space handling
fails only its line-1 case; removing continuation carry fails only its line-2
case. Two further red-first fixtures span single and double shell quotes across
lines, and four operator fixtures preserve real comments after `;`, `&`, `&&`
and `||`; an escaped-operator fixture keeps the boundary rule honest.
Quote-carry and operator-boundary mutations fail their own cases independently.
Adjacent fixtures preserve real hash comments at line start and after
whitespace. A final red-first ANSI-C fixture keeps an escaped quote open across
the physical newline and reports the effective directive on line 2; an
ordinary-single-quote fixture proves the same backslash remains literal.
Collapsing ANSI-C back into ordinary single mode fails only the bypass case,
while giving ordinary single quotes ANSI-C escape behavior fails only the
preservation case. The focused header suite passes 39/39 tests, and the full
workspace passes 89 files / 1,286 tests with two workers. Workspace typecheck,
production build, the complete D-005 static/build/local-preview gate (305
source files and 30 production responses), all 13 invariants, tilemap and diff
checks pass. The local checks used only files, child processes and loopback
HTTP; no external network, RPC, wallet, proof, signature, funds or transaction
was used.*

### 2026-08-20 — An Exchange edit owns its pending preparation

The Exchange amount and asset controls remain editable while wallet
preparation is pending. Those edits now invalidate the preparation attempt
that captured the older composition. When that attempt eventually returns,
its prepared batch is discarded and cannot replace the edited form with an
obsolete review.

Exchange needs no additional ownership clock for this transition. Its
existing attempt version already owns preparation and confirmation, and an
edit is relevant to that owner only while the flow is `preparing`. The edit
advances that version and returns to `composing`; edits outside preparation,
signing, unconditional receipt retention, close invalidation and balance reads
retain their prior behavior.

*Verified:* one public-machine table defers `PrivacyOperations.prepare`, then
edits the amount, sell asset or buy asset before releasing the old batch. All
three cases were red with the old batch undiscarded and its review published;
green discards each returned batch exactly once, preserves the newer form and
leaves no old review. Removing the attempt advance restores the stale review,
and removing the flow transition leaves the edited panel stuck in preparing,
so both clauses are independently observed. The focused Exchange machine
passes 18 tests, the Web suite passes 36 files / 393 tests and the full
workspace passes 89 files / 1,255 tests; workspace typecheck, production build,
all 13 invariants and diff check pass. Local verification used no browser,
external network, wallet, RPC, proof, signature, funds or transaction.*
### 2026-08-20 — A private swap cannot authorize the zero executor

`BackendApi` accepted a planner result whose `executorAddress` was `0x0`
because zero is a syntactically valid Starknet felt. The production AVNU
adapter's truthiness check also accepts the non-empty string `"0x0"`. A public
swap-prepare request could therefore build a sponsor fee and issue an
authorization binding both the sell withdrawal and the later invoke to the
zero executor, even though no valid private executor had been admitted.

Swap-plan admission now requires the executor felt to be nonzero before fee
construction or authorization issuance. Quote selection, token/slippage
policy, executor-call serialization, route schema and submission behavior are
unchanged.

*Verified:* public `BackendApi.handle()` regressions replace only the external
planner result with otherwise valid mainnet private plans carrying `0x0` and
two accepted leading-zero encodings, `0x00` and `0x00000000`. Before the guard,
each request returned 200, called the paymaster fee builder and exposed an
authorization whose decoded swap binding contained the zero executor. Green
returns the existing generic 409 invalid-quote response and proves neither the
paymaster nor authorization issuer was called. Removing the nonzero clause
makes all three regressions fail; replacing its numeric felt comparison with a
string-only `=== '0x0'` check makes the two leading-zero cases fail. Local
verification used no live provider, external network, RPC, wallet, proof,
signature, funds or transaction.*

### 2026-08-20 — A Bank batch edit owns work started from the older batch

The Menu Mode Bank leaves its explicit Remove and Clear controls available
while recipient preflight or wallet preparation is pending. Those edits now
own the batch immediately. A late recipient preflight cannot re-add its
captured transfer after Clear/Remove, and a late prepared batch is discarded
instead of reopening review for the pre-edit intent set.

This ownership needs its own version. `attempt` identifies prepare/confirm
work, `session` identifies the mounted room and `balanceRead` identifies the
displayed balance; using any one of them for batch composition would cancel an
unrelated owner. Clear/Remove advance the composition version and invalidate
the active prepare attempt while leaving signing, unconditional receipt
retention, panel-close invalidation and balance reads unchanged.

*Verified:* deferred red/green tests use only the public Bank machine. Clear
during pending registered-recipient preflight previously re-queued the captured
transfer; Clear/Remove during pending prepare previously restored old review.
The returned stale batches now reject confirmation as discarded, and late
successful or rejected preflights after Remove/Clear cannot publish batch,
form, notice or provider-error state. Three isolated mutations are killed:
removing stale-batch `discard()`, removing the rejected-preflight composition
guard, and removing Remove's composition increment. The focused Bank machine
passes 74 tests, the Web suite passes 36 files / 390 tests and the full
workspace passes 87 files / 1,226 tests; workspace typecheck, production build,
all 13 invariants and diff check pass. The local verification used no browser,
external network, wallet, RPC, proof, signature, funds or transaction.

### 2026-08-20 — A replacement World must not inherit its first Shell bus

The World runtime retains its ref-counting host after the current Phaser game
has been completely destroyed. That host's `start` callback previously closed
over the first `WorldConfig` passed to `ensureHost()`. A later acquisition with
a different Shell bus therefore constructed a genuinely new game and scene but
installed the first bus again. Its fixed-room controllers subscribed to stale
Shell input, and its semantic output returned to the stale owner.

Each fresh host start now consumes the config belonging to the acquisition that
caused that start. The handoff is synchronous around `Host.acquire()` and is
cleared afterwards; retaining or releasing an already-live game is unchanged.
The singleton host still owns StrictMode-safe Phaser lifetime, but it no longer
owns the first caller's bus forever.

*Verified:* a public runtime regression acquires with bus A, releases it, runs
the complete deferred teardown, then acquires with distinct bus B. Before the
fix, the second scene's registry contained A and B received no fixed-room
subscription; the failure reproduced identically in three isolated runs. Green
records B at scene creation and observes B's `world:stations` subscription.
Removing the per-acquisition config assignment makes both runtime tests fail.
The focused runtime suite passes 1 file / 2 tests. No browser, network, lobby,
wallet, RPC, proof, signature, funds or transaction was used.

### 2026-08-20 — A local Lobby leave does not own its replacement room

`LobbyClient.disconnect()` clears the current room before awaiting the SDK's
`leave()`, and the client is deliberately reusable: an explicit `connect()` may
therefore establish replacement room B while old room A is still leaving. A
client-wide `leavingByRequest` flag previously remained true for that whole
await. If B's transport dropped in the meantime, B's current `onLeave` mistook
the drop for A's requested leave, cleared B and its identity but suppressed the
`closed/server-dropped` transition. The public client then reported
`connected` while owning no room, so the Shell could not offer truthful solo
mode or its explicit reconnect control.

Local-leave classification now follows room ownership instead of one mutable
client-wide flag. `disconnect()` already removes A from `#room` synchronously,
so A's eventual callback is stale under the existing complete
generation-and-room check. Any callback that still owns the current room is an
external close and publishes `closed/server-dropped` with its close code. Join
payloads, presence state, automatic-reconnect policy and network behavior are
unchanged.

*Verified:* a public-seam regression connects A, defers A's `leave()`, connects
B, then drops B with code 1006 before allowing A to finish. The old code leaves
the client `connected`; green reports exactly `closed/server-dropped` with code
1006. The current Lobby suite passes 9 files / 192 tests. Local verification
used only fake rooms plus the suite's local loopback server; no browser, remote
lobby, wallet, RPC, proof, signature, funds or transaction was used.
### 2026-08-20 — A prepared batch must own the intents it was admitted with

`PrivacyOperations.prepare()` is where every admission check lives: the route
policy and token allowlist, positive amounts, `maxIntents`, recipient
registration, the D-004 shield/spend separation, and the warnings the player
reads. All of it was reachable around, because `confirm()` did not own the
intents it proved.

Two independent leaks, one root cause. The **array**: `prepare(intents)` handed
its own parameter down to the route builders, whose `confirm()` re-read it at
confirmation time, so an intent the caller appended afterwards was proved and
signed — including the shield+transfer pair `prepare` refuses outright, which is
the exact public-leg link the pool exists to break. The **elements**:
`intents: [...intents]` is a shallow copy, so the published `readonly Intent[]`
held the caller's own objects; `readonly` is erased at runtime, so writing a
field reached `confirm()`.

The swap route was the worst case, not the protected one. Its action-binding
guard from PR #31 recomputes the expected action set from the canonical intent,
and that same object was published on the batch — so moving it moved the
guard's authority and the action together and the guard confirmed the
corruption. That is the tautology PR #31 avoided one level in, at
`snapshotExecutorCalls`, reintroduced one level out. The general rule is
stronger than "don't share an array with the SDK": **an expectation recomputed
from a published mutable object is not independent of what it checks.** The
input must be unreachable by anyone who could benefit from moving it, callers
included.

`prepare()` now takes one frozen snapshot *before* validating, and that snapshot
is the sole authority for admission, costing, warnings, the published batch and
the actions built at confirmation. There is no window in which the reviewed
batch and the proved batch can differ, and no handle with which to open one.
`FakePrivacyOperations` does the same: a double that grants a freedom
production does not lets consumer suites go green against behaviour that cannot
happen. `Intent` is a flat union of strings and bigints, so one level of
copy-and-freeze is a full deep freeze.

Scope, stated honestly: no exported type, signature or policy changed —
`PreparedBatch.intents` already declared `readonly`. Today's two Shell call
sites do not trigger this (`bank-machine.ts` spreads into a throwaway array,
`exchange-machine.ts` passes an object literal, and every consumer of
`batch.intents` only reads it), so this was a latent contract defect rather
than a live exploit. It is still the seam's job: the financial boundary must not
depend on callers in another package choosing not to write. The identical fix
already existed one level up in `ReceiptLedger` and one level in at
`snapshotExecutorCalls`; this was the unbound middle. It does **not** touch the
open executor identity/admission decision (D-018 vs D-023 vs D-042), and it
cannot detect a hostile plan — the swap guard remains self-consistency.

*Verified:* red first, all through the public `prepare(...)`/`confirm(...)` seam
against the package's existing fakes. Before the fix, an appended transfer made
a prepared shield sign
`[{deposit 0x1},{transfer 0x14→0x456}]`; an appended unshield made a prepared
transfer prove an unallowlisted `0xdeadbeef` withdraw to an unchecked `0xbad`;
writing `amount` on a published shield intent signed
`0xc9f2c9cd04674edea40000000` instead of the reviewed `0x1`; and on the swap
route, writing `amountIn` or `tokenIn` moved the sell leg to that amount or
token with the binding guard passing, using the **real** pinned
`@avnu/avnu-sdk@4.2.0` `buildStrk20Actions`. The fake recorded `90n` and
debited 100→10 STRK instead of 100→80. 11 of the 12 new cases failed red; the
twelfth (append against the fake) passed only because `canonicalizeIntents`
happened to copy, and it is load-bearing now that the snapshot is the single
authority.

Independent review then found the fix incomplete in the double, and it was the
same defect one turn later: `FakePrivacyOperations.prepare()` captured its
snapshot *after* `await this.tick(...)`. `tick()` is async, so awaiting it
yields a microtask even at zero latency, and a caller that mutated its own
array between the unawaited `prepare()` call and the settled promise won that
race — a shield reviewed at `1n` published `90000000000000000000n`. Production
was never exposed, because its capture sits after a synchronous
`throwIfAborted` and before anything awaited. **Taking the snapshot after the
first await is not taking it at all**, and "the double does what production
does" has to be checked against production's *ordering*, not just its
behaviour. Fixed by capturing synchronously, with a red-first timing
regression; a mirror-isolated mutation moving the capture back below `tick()`
kills that regression and nothing else.

The real seam is now pinned the same way, closing the residual gap that the
double's defect exposed: nothing had asserted that production captures
*synchronously*, so an `await` inserted above its snapshot would have
reintroduced the same race with every test still green. That pin was green on
first run — production was already correct — so its teeth come from mutation
rather than from a red observation: inserting `await Promise.resolve()` above
the production snapshot fails exactly that one case.

*Local, and issuing no network request of any kind:* `packages/privacy` 7 files
/ **131** tests (was 6 / 117), full workspace 89 files / **1252** tests,
workspace typecheck, production build, all 13 invariants, and the header gate's
30 live production responses, all re-run at the merge `ea25c16`, which contains
`origin/main` `5be7fd5`. An eight-mutation pass killed 8 of 8,
each with a distinct failure set, so no clause is redundant: dropping the
snapshot fails 7 cases; freezing only the array fails 4; freezing only the
elements fails 2; unfreezing the swap canonical intent fails 3; unfreezing the
swap published array fails 1; dropping the fake's snapshot fails 2; moving the
fake's snapshot below its first await fails exactly 1; and delaying the
production snapshot by one microtask fails exactly 1. That pass carries across
the syncs below because the four privacy source files are byte-identical from
`c628150` through `ea25c16`, checked with `git diff`, not assumed. Earlier
full-workspace figures in this entry's history — 1219 at `e79f34e`, 1226 at
`c63c9f3`, 1233 at `d675408`, 1234 at `5818105` — were each true of the tree
they were measured on and are superseded as `main` advanced; the privacy figure
held at 131 throughout. No wallet, account, provider, RPC, funds, proof,
signature or
submission was involved in any local run — the wallet, pool and gateway are
in-memory doubles, and the only real code exercised is the pinned AVNU action
builder and `starknet` serialization, both pure. The mutation passes ran in
throwaway mirrors under a scratch path, never against the live branch files,
which were checksum-verified unchanged after each.

*Hosted, and the only part of this evidence that touches the network:*
[GitHub Actions run 32401360829](https://github.com/Calcutatator/STRKWORLD/actions/runs/32401360829)
succeeded at `8b4f274`, an earlier head of this branch — 88 files / **1225**
tests, plus the headers, invariants and deployment jobs. Later heads, `ea25c16`
included, are covered by their own PR runs rather than by this one. Every
hosted run also executes this repo's standard **Protocol drift canary**, which
issues **three read-only** JSON-RPC reads of public mainnet state against the
pool at `latest`: `starknet_call` of `get_fee_amount`,
`starknet_getClassHashAt`, and `starknet_call` of `is_paused`. PR #41 later
hardened that gate to fail closed on unknown protocol state and to validate
each call's response shape; it did not change which three reads are issued, so
this disclosure still describes them exactly. It is pre-existing CI behaviour
on every PR, not something this change adds or depends on, and it involves no
key, viewing key, proof, signature, funds or transaction. Stating the local
runs as "no RPC" without this distinction was wrong, and is corrected here.

### 2026-08-20 — Fly startup requires the browser shell, not only its private listeners

The Fly composition previously launched both private children, accepted their
readiness messages and bound the public edge without checking that its static
root contained a usable `index.html`. A missing artifact, a directory named
`index.html`, or a link escaping the configured root therefore produced a
nominally ready Machine whose first shell request returned 404.

Startup now validates the shell file before spawning either private child,
rechecks an abort immediately after that awaited filesystem work, and validates
the shell again at the public ownership handoff. The resolved file must be a
regular file inside the resolved static root; otherwise startup fails with one
generic error, closes anything it started, and hands no composition to its
caller. Startup and request serving use the same package-local canonical-path,
containment and regular-file resolver, so the readiness gate cannot drift from
the edge's acceptance rule. This does not change static routing, build output,
image contents, ports, proxy behavior or shutdown ownership.

*Verified:* public composition-seam regressions supply each of the three
unusable roots above and use child-start instrumentation to prove zero private
children launch. Removing or moving that initial validation after child
readiness makes the instrumentation observe starts. A separate red-first case
waits until both children are launched, removes `index.html` while their
readiness is pending, and proves startup closes all three ports instead of
handing off the edge; before the handoff revalidation it returned a live
composition. The same handoff replaces the shell with an escaping symlink and
is rejected by the shared rule; weakening only the handoff check to a regular
file `stat` makes that case return a composition. The abort regression calls
startup, aborts while initial filesystem validation is pending and observes
zero child starts; moving the abort check above that await makes it observe two.
All 52 Fly composition tests pass; the Fly slice is 5 files / 143 tests and the
full workspace is 89 files / 1,265 tests. Workspace typecheck, production
build, all 13 invariants, tilemap and diff checks pass. The checks are
filesystem/process-local: no image build, container, deploy, registry, secret,
external network, RPC, wallet, proof, signature, funds or transaction was
used.*

### 2026-08-20 — An old Bridge watcher cannot adopt replacement evidence

`BridgeService.refresh()` may validly return provider status for deposit A
after the player has discarded A and retained replacement deposit B. The
refresh ownership guard correctly refuses to persist that late result, but
`watch()` previously passed the returned A status into its active-timeout
helper. That helper reloaded whichever record was current and unconditionally
saved the old status onto it. A late A response could therefore graft A's
origin transaction hash and progress onto B while leaving B's signed quote
identity intact.

Polling now owns the complete retained record version. Its internal refresh
returns both the verified provider status and the exact successor version only
when that version was persisted. The watcher advances only through those owned
successors; losing ownership before, during or after a refresh stops the old
watch without saving or adopting the replacement. The timeout save performs
the same complete-version comparison. Public `refresh()` and `watch()` still
return the verified provider status, and provider calls, record schemas and
wire behavior are unchanged.

*Verified:* a public-seam regression was observed red first: defer A's
`PROCESSING` response, start a one-millisecond watch, discard A, create distinct
B, then release A with origin hash `0xold-deposit`. The old code retained B's
quote but replaced B's pending status with A's solver progress, hash and
polling-stop copy. Green preserves B and its byte-identical export while the
old watcher still returns A's verified stopped result. The Bridge suite passes
1 file / 62 tests; the full workspace passes 87 files / 1,220 tests, workspace
typecheck, all 13 invariants and diff hygiene pass. Local verification used no
browser, live provider, external network, wallet, RPC, proof, signature, funds
or transaction.

### 2026-08-20 — Unknown protocol state fails the drift canary

The protocol drift canary used to treat an unreadable pool fee or
`is_paused()` result as a warning. If `starknet_getClassHashAt` still resolved,
CI exited successfully and printed `No drift.` even though it had not learned
the two operational values the job exists to protect. A selector change,
method-specific provider failure or changed contract surface could therefore
make the release gate green precisely when fee or pause state was unknown.

Unreadable fee and pause-state responses now each fail the canary. The output
remains generic and does not echo provider error detail or a response value.
The `starknet_call` parser also accepts only an array containing exactly one
hexadecimal felt below the Stark field modulus. This is part of the same gate:
the earlier array indexing accepted a scalar result such as `"0x1"` as its
first character, read that character as zero, and falsely reported not-paused.
Known healthy state still passes; a changed fee, a paused pool, malformed
result or unresolvable class fails.

*Verified:* a deterministic executable-seam test puts a fake `curl` first on
`PATH` and returns JSON-RPC-shaped local fixtures. Before the fix, fee and
pause errors plus a resolvable class printed both warnings and `No drift.` and
exited 0. The retained test checks each unreadable value independently while
the other two reads succeed; removing either new failure assignment makes its
own case exit 0. Known fee `6000000000000000000`, not-paused and class success
exit 0; changed-fee and paused fixtures exit 1. A scalar, object, empty array,
multi-value array, non-felt string, number and out-of-range felt are each
rejected with generic unreadable-state output. Removing the exact-length check
makes the multi-value fixture pass as healthy; removing the field-range check
misclassifies the out-of-range fixture as paused instead of unreadable. The
test harness waits for the child `close` event so its stdout and stderr are
fully drained before assertions. The local test opens no network, wallet, RPC,
proof, signature, funds or transaction. Hosted CI's standard canary remains
read-only and issues two public-mainnet `starknet_call` reads plus one
`starknet_getClassHashAt` at `latest`; it uses no key, signature, proof, funds
or transaction.*

### 2026-08-20 — A late Bridge status response cannot overwrite a newer retained version

`BridgeService.reportDepositTransaction()` and `refresh()` capture the complete
retained record before awaiting 1Click. The player can explicitly discard that
evidence, create a replacement, or receive newer progress for the same signed
quote while either call is in flight. A late response still verifies and returns
the provider status to its caller, but it persists that status only if the
complete retained record remains byte-identical to the version the call began
from. It cannot resurrect discarded evidence, replace a different quote, or
regress newer same-evidence progress.

Signed-evidence identity alone is not a persistence version: one quote can move
from `awaiting-deposit` through `deposit-detected` to `settled`. The guard uses
the package's serialized `BridgeRecord`, including status and local update time,
as an optimistic compare-and-save token. The origin transaction hash,
provider requests, returned statuses, record schema and wire behavior are
unchanged.

*Verified:* the discard and replacement regressions still prove a late report
cannot resurrect A or replace B and that it still returns `deposit-detected`.
Two additional deferred public-seam regressions cover the same quote in both
orders: a refresh persists `settled` before a late report returns
`deposit-detected`, and a report persists `deposit-detected` before a late
refresh returns `awaiting-deposit`. In each case the late call returns its mapped
status while `resume()` and the exact export preserve the newer record. Replacing
the version comparison with unconditional ownership makes both same-evidence
tests fail. The Bridge suite passes 1 file / 61 tests. Local verification used
no live provider, external network, wallet, RPC, proof, signature, funds or
transaction. Hosted CI also runs the repository's standard read-only drift
canary: two `starknet_call` reads and one `starknet_getClassHashAt` against public
pool state at `latest`; no key, signature, proof, funds or transaction is
involved.

### 2026-08-20 — A failed Backend fan-out closes the whole request signal

The Backend fee, swap-prepare and proof-freshness paths fan one request signal
out to concurrent provider calls. `Promise.all` rejects as soon as one call
fails, but clearing the request deadline alone did not abort a sibling that was
still running. The public handler could therefore return its generic failure
while an RPC or AVNU operation outlived the request with no remaining deadline.

The error path now aborts the shared request controller with the fixed generic
`AbortError` reason `Request failed.` before it maps the original error. The
original public 502 response remains authoritative and contains no provider
detail. Cancellation and deadline disposal are idempotent; an existing parent
abort or timeout reason is not overwritten. Successful requests and all route,
queue, budget, schema and provider behavior are unchanged.

*Verified:* red first through `BackendApi.handle()` on the public fee seam: an
immediate paymaster failure returned the expected generic 502 while a concurrent
abort-aware RPC signal remained live. Green after the request-level cancel:
the same RPC observed exactly one abort carrying only the generic reason. Two
adjacent regressions retain the parent `AbortError` and the deadline
`TimeoutError` plus their existing 504 mapping. The focused three cases pass;
the Backend suite is 5 files / 69 tests, full workspace is 87 files / 1,209
tests, workspace typecheck, production build, all 13 invariants and the tilemap
check pass. The focused and local workspace verification used no deploy,
external network, wallet, RPC, proof, signature, secret, funds or transaction.
Hosted CI subsequently ran the repository's standard read-only drift canary:
two `starknet_call` reads and one `starknet_getClassHashAt` against public pool
state at `latest`; no key, signature, proof, funds or transaction was involved.

### 2026-08-20 — A repeated StreetScene create retires the prior ownership cycle

`StreetScene.create()` may defensively run twice on one Scene instance without
Phaser first delivering `shutdown`. Replacing only the Scene fields in that
path leaves the prior fixed-room controllers subscribed to the Shell bus. A
room entered in the old cycle can then consume a late `world:exit-building`,
move the new Scene through its captured callbacks and publish a stale
`building:exited`; final shutdown reaches only the current controller map and
leaves the old subscriptions alive.

Repeat creation now retires only the live World-owned cycle before opening the
next one. The Scene removes its pending cleanup callback and invokes that
cleanup directly; the remote-avatar layer's idempotent `destroy()` also removes
its own pending callback. The Phaser `shutdown` event remains reserved for the
actual framework lifecycle, so defensive recovery cannot tear down the live
Scene's physics, cameras, input, timers or display list. Ordinary
shutdown-to-create and failed-create recovery remain unchanged. This changes
no room event payload, input rule, authored geometry, presence or financial
behavior.

*Verified:* the real-create headless regression first failed with the retained
Bank controller still in-room. An independent probe also observed Shell
listeners grow from 12 to 24, a stale exit publication and 12 listeners after
final shutdown. A framework-sentinel regression then failed red because the
first implementation broadcast `shutdown` during repeat creation. Green keeps
that sentinel pending, retires the prior Bank, holds Shell listeners at 12 and
World-owned shutdown listeners at two, emits no stale exit, then calls the
sentinel exactly once on the later real shutdown and leaves every count at
zero. Removing World retirement leaves the Bank live; removing remote callback
detachment leaves one extra shutdown listener, so both clauses are independently
load-bearing. The focused lifecycle and remote-layer files pass 17/17 tests and
all World tests pass 22 files / 218 tests. The full workspace passes 87 files /
1,215 tests; workspace typecheck, production build, all 13 invariants, the
tilemap check and diff check pass. No browser, network, wallet, RPC, proof,
signature, funds or transaction was used in the local verification.

### 2026-08-20 — A late Bridge refresh may report status, but it no longer owns persistence

**Persistence identity is superseded by “A late Bridge status response cannot
overwrite a newer retained version” above; the original discard/replacement
verification remains valid.**

`BridgeService.refresh()` captures the retained record before awaiting the
provider, so the player can discard that evidence or retain a replacement while
the request is in flight. A late response still maps and returns the provider
status to its caller, but it persists that status only if the store still holds
the same signed evidence, identified by correlation ID, signature and signed
timestamp. A refresh for evidence A therefore cannot resurrect A after an
explicit discard and cannot overwrite replacement evidence B or B's exact
export.

This extends the same ownership rule already applied to imports: the currently
retained signed evidence is authoritative, and an asynchronous result owns no
future store state merely because it started first. Provider calls, status
mapping, record schema and wire behavior are unchanged; the guard only decides
whether the mapped result may still be saved.

*Verified:* two deferred regressions start a refresh for A, then respectively
discard A or discard A and create B before releasing the provider response.
Both refresh calls return `solver-settling`; the first leaves `resume()` null,
and the second preserves both B and its byte-identical export. The current
Bridge suite passes 1 file / 57 tests. PR #27 head `3452a55` passed
[GitHub Actions run 32388660609](https://github.com/Calcutatator/STRKWORLD/actions/runs/32388660609)
and was merged as `51eea51`. No live provider, external RPC, wallet, proof,
signature, funds or transaction was used.

### 2026-08-20 — Established lobby transport drops stay player-owned

The pinned Colyseus SDK enables automatic room reconnection after an
established connection. `LobbyClient` now disables that owner on the joined
room before publishing it, so D-037's existing Shell control remains the only
way to reconnect. A dropped transport can no longer leave the wrapper reporting
`connected` while the SDK performs an unrequested hidden retry loop; the
existing status seam instead reaches `closed/server-dropped` with the real
WebSocket close code and truthful solo-mode fallback.

The transport emits a code-less SDK error immediately before its close event.
That error now defers to `onLeave`, which owns the paired close code; numeric
room or protocol errors still take the explicit `error` path. This changes no
presence payload, schema, identity, position, facing, sprite, origin policy or
financial boundary.

*Verified:* the real pinned SDK test keeps a local child-process lobby and
WebSocket connected beyond the SDK's 5,000 ms minimum uptime, kills the child
abruptly, and observes `closed/server-dropped` within 1,000 ms. Removing the
`room.reconnection.enabled = false` assignment makes that regression time out
inside the SDK retry loop. The current Lobby suite passes 9 files / 191 tests.
PR #25 head `7472729` passed
[GitHub Actions run 32388301046](https://github.com/Calcutatator/STRKWORLD/actions/runs/32388301046)
and was merged as `a3fad68`. No browser, remote lobby, wallet, RPC, proof,
signature, funds or transaction was used.

### 2026-08-20 — The swap executor is validated for shape, never for identity

`buildStrk20Actions` is a validation-free array literal that puts the
backend-supplied `executorAddress` in **two** places: the sell leg's `withdraw`
recipient and the `invoke` target. `packages/privacy` checked only that it was a
nonzero felt, so a well-formed but wrong executor was simultaneously a redirect
of the whole sell amount and an arbitrary contract call. `apps/backend` has no
executor allowlist either — the value comes straight from AVNU's
`quoteToCalls({ private: true })` response, and the HMAC binding plus
submission-time decode-and-match are operated by the same party that supplied
it, so they are self-consistency rather than independent admission.

Two adjacent facts that matter for anyone fixing this. `STRK20_INVOKE_ACTION` is
`{ type, contract, calldata }` with **no selector field** — the entry point lives
inside calldata — so a selector allowlist is not expressible against that action;
admission has to be on `contract`. And `@avnu/avnu-sdk@4.2.0` exports
`PRIVACY_POOL_ADDRESS` and `SEPOLIA_PRIVACY_POOL_ADDRESS` but **no executor
constant**, so an allowlist's contents cannot be source-verified from the SDK.

Whether the browser should pin executors is **an open decision, not a bug fix**:
SPEC §4 and D-018 say every active route allowlists its exact contracts, while
D-023 (which explicitly amends D-018) calls this executor *dynamic*, assigns the
binding duty to the backend, and reads "changed executor/call" as changed
relative to the authorized plan. D-042 restates the enforcement boundary as the
wallet policy plus `BACKEND_ROUTE_SWAP_ALLOWED_TOKENS` — tokens only. Per §3
that disagreement must be resolved and recorded, not picked silently. A worked
option (a required `WalletRoutePolicy.swap.allowedExecutors`, empty-or-malformed
locks the route, checked at prepare and confirm) was built and deliberately
withheld pending that decision.

What did land is the decision-free half: the action set is now verified against
the validated plan before `strk20PrepareInvoke`. That closes an ordering gap —
the relay's binding check cannot un-prove a proof — but it cannot detect a
hostile plan, because a hostile plan's actions match it faithfully.

*Verified:* read the installed `dist/index.mjs:1281-1309` and `dist/index.d.ts`
of `@avnu/avnu-sdk@4.2.0` (version confirmed from its `package.json`, integrity
matching `package-lock.json`), and the shipped `STRK20_ACTION` union in
`@starknet-io/types-js@0.10.3` `wallet-api/components.d.ts:187-234`. Traced
`apps/backend/src/avnu-swap-planner.ts:45-58`, `api.ts:291-350` and
`server-actions.ts:132-153` for the backend side. Red/green, all through the
package's public `prepare(...)`/`confirm(...)` seam against fakes: **22** explicit
corrupted action sets plus a separate mutating-SDK case. Before the guard existed
each corruption reached the fake wallet-preparation seam and its result reached
the fake submission port; after it, every one is rejected and neither fake is
reached. Nothing was proved or submitted in any real sense — the wallet and
gateway are test doubles, and the real-SDK path is pinned to exact output.
`packages/privacy` is 117 tests; workspace typecheck and all 13 invariants pass.

The guard binds the invoke payload, not just its target. `STRK20_INVOKE_ACTION`
has no selector field, so the entry point and its arguments live inside
calldata; checking only `contract` plus "a placeholder is present somewhere"
left the whole payload free. It is now recomputed independently from the
validated `executorCalls` with the same pinned helpers AVNU uses —
`transaction.fromCallsToExecuteCalldata_cairo1(...).map(num.toHex)`, prefixed by
the buy token and suffixed by `${openNoteIds[0]}` — and compared by exact length
and order, felt values normalized, with the placeholder pinned to the final
slot. Which cases were observed against which baseline, exactly. Seven reached
the fake wallet-preparation seam under the placeholder-count-only check and are
rejected once the payload is bound: substituted buy-token prefix, retargeted
inner call, substituted selector, altered inner calldata, appended felt,
reordered felts, and placeholder moved off the end. Six of those seven keep
exactly one placeholder in the final slot, so nothing but payload binding can
catch them. Two further cases — a felt trailing a correctly placed placeholder,
and a felt substituted into the placeholder slot — came from the mutation pass
below rather than that red run, and are the only cases that independently
exercise the exact-length check and the final-slot pin. The pre-existing "no
placeholder" case was already rejected by the count check it replaced.

A 12-mutant pass over the guard's clauses killed 10 and left two survivors — the
exact-length check and the final-slot placeholder pin — because every case
written at that point was also caught by another clause. The two extra cases
named above exist to make those clauses independently load-bearing; the pass now
kills 12 of 12. A guard clause no test can distinguish from its neighbours is
untested, even when the suite is green.

Recomputing an expectation is only worth anything if its input cannot be reached
by the thing it checks. The validated calls are therefore snapshotted before the
SDK is called and the SDK receives a separate copy; sharing one array let a
mutating SDK corrupt the action and the authority together, and that case was
observed passing tautologically. Freeze the snapshot only — freezing the SDK's
input made its mutation throw a `TypeError`, which `mapWalletError` classified as
`unreachable`, reporting a plan mismatch as a network outage.

Same shape, one level up, in the test fixture: a shared mutable `CALL` object let
the mutation test corrupt the next test's expectation. Fixtures for a
mutation-safety test must hand out fresh copies.

*Network use, stated exactly:* no wallet was opened, no account connected, no
proof generated, no signature produced and no transaction submitted; no funded
or live claim is made. One read-only run of `scripts/check-drift.sh` issued
**three** JSON-RPC reads against mainnet: `starknet_call` of `get_fee_amount`,
`starknet_call` of `is_paused`, and `starknet_getClassHashAt`, all against the
pool at `latest` via the script's default endpoint. They returned fee
`6000000000000000000`, class
`0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d`, not paused
— no drift. Public contract state only, no key or funds involved. An earlier
version of this entry claimed no RPC was used; that was wrong and is corrected
here.
### 2026-08-20 — The Shell accepts the financial seam; production still does not construct it

`App` now accepts one exact `PrivacyOperations` instance and passes it directly
to `PrivacyProvider`. Supplying the prop selects that instance; omitting it
selects the explicit demo path. The checked-in `main.tsx` still omits the prop,
and the demo provider still refuses a production build, so this merge creates a
production-host injection seam without silently making the local entry point a
real-money composition.

The next gap is not another `App` change. There is no non-test construction of
`WalletApiPrivacyOperations` anywhere in the repository, no concrete
`WalletRoutePolicy` instance outside its tests, and the Shell connect machine
only queries the already-constructed operations object. The production
bootstrap also passes neither an account nor an account reader to the Bridge
runtime. D-043 already decides the ownership: the real composition root retains
the concrete connected Wallet API account alongside `PrivacyOperations`, and
uses that account for the Bridge's recipient checks. The missing implementation
must preserve that decision while constructing the wallet-backed operations
dependencies and supplying the account to both existing seams. What remains
gated is the cross-lane interface for that lifecycle and the concrete route
policy, not account ownership. This finding records the blocker but does
**not** select or pre-authorize either choice. It also does not change D-043:
no production Ready public-shield planner is exported, and the fee-aware funded
gate remains closed.

*Verified:* source search at PR #21 merge `6f9dfa6` found the only
`new WalletApiPrivacyOperations(...)` calls in
`packages/privacy/src/wallet-api/wallet-api.test.ts`; `main.tsx` mounts `App`
without `operations`, while the regression in `App.test.tsx` injects a
`FakePrivacyOperations` through the public prop. The current focused App suite
passes 2/2 tests. PR #21 head `3753b39` passed
[GitHub Actions run 32383698923](https://github.com/Calcutatator/STRKWORLD/actions/runs/32383698923)
and was merged as `6f9dfa6`.
No wallet, account session, network, proof, signature, funds or transaction was
used.

### 2026-08-20 — Fly readiness must be proven by the child, not by its occupied port

The Fly occupied-private-port regression had a test expectation race rather
than a production lifecycle defect. Under workspace parallel load, the
parent's 500 ms readiness deadline could win before the backend child reached
its already occupied listener and exited, changing the correct rejection from
“exited before readiness” to “did not become ready.” The deterministic harness
now delays only the occupied backend past the deadline; the lobby child reaches
genuine IPC readiness normally. Startup still rejects and the public edge is
asserted unreachable.

This shape matters because a TCP-only readiness probe would accept the
unrelated listener already holding the backend port. Mutating the composition
to use that probe makes the public edge become reachable and exposes the
regression. Production Fly code did not change; the test now pins the IPC
ownership boundary without depending on scheduler ordering.

*Verified:* PR #23 head `c2f59f7` changes only
`deploy/fly/src/compose.test.ts`; the current focused file passes 47/47 tests.
That head passed
[GitHub Actions run 32386403965](https://github.com/Calcutatator/STRKWORLD/actions/runs/32386403965)
and was merged as `02e78cc`.
No deployment, external network, secret, wallet, RPC, proof, signature, funds
or transaction was used.

### 2026-08-20 — A validated request deadline must not remain a mutable config alias

Direct `BackendApi` construction now rejects `requestTimeoutMs` above Node's
signed 32-bit timer ceiling and captures the validated value at construction.
Without the capture, a caller could mutate the shared config afterwards to
`2_147_483_648`, which Node reduces to an approximately one-millisecond timer,
despite construction having validated a safe deadline.

The capture is deliberately narrow. `BackendApi` retains the configuration
alias for live fail-closed controls including `globalEnabled` and per-route
policy/kill switches; a queued request must still observe a route being
disabled. Do not generalize the deadline fix into freezing or snapshotting all
route policy.

*Verified:* the PR #22 constructor boundary accepts exactly `2_147_483_647` and
rejects `2_147_483_648`; a fake-timer regression mutates the caller's config
after construction and observes the original 30,000 ms timeout. Existing tests
also disable a route while its submission is queued. The current Backend suite
passes 5 files / 67 tests. Commits `cc58dee` and `7e36694` contain the
correction. PR #22 head `7e36694` passed
[GitHub Actions run 32385267570](https://github.com/Calcutatator/STRKWORLD/actions/runs/32385267570)
and was merged as `a06145e`.
No provider, credential, wallet, proof, signature, funds or transaction was
used.

### 2026-08-20 — Retained Bridge evidence is authoritative until explicit discard

`BridgeService.importResumeRecord()` cannot replace any currently valid
retained record. The guard runs before parsing or signature verification, so
older, equally recent, later, malformed and tampered imports all receive the
same discard-first refusal while `resume()` and `exportResumeRecord()` retain
the exact existing evidence. This is an ownership rule, not timestamp conflict
resolution: the player must explicitly discard the current record before a
different import can be considered and reverified.

Once the player discards, ordinary size, shape, route and quote-signature
validation still applies; the change does not make imported evidence trusted
or provider-settled by itself.

*Verified:* the PR #20 table-driven public-seam regression covers all five import
classes, checks the exact discard-first error, and proves both retained views
are unchanged. The current Bridge suite passes 1 file / 55 tests. Commits
`cf26d2b` and `d1a0517` contain the correction. PR #20 head `d1a0517` passed
[GitHub Actions run 32384585147](https://github.com/Calcutatator/STRKWORLD/actions/runs/32384585147)
and was merged as `4dc27c4`.
No provider request, wallet, proof, signature, funds or transaction was used.

### 2026-08-20 — A key binding owned by a room works only in that room

**Rendered-acceptance status superseded on 2026-08-28 by [the completed D-053
matrix finding](#2026-08-28--the-rendered-functional-and-interactive-d-053-matrix-is-complete-subjective-art-remains-open); the historical headless evidence below is unchanged.**

D-052 gave `F` to the Avatar Studio controller, which owned both the selected
opaque key *and* the `keydown-F` listener. That is why the outfit toggle
appeared to work nowhere else: outdoors and inside the fixed rooms there was no
listener to press. The earlier finding "Fighting-state input is owned only by
the active Avatar Studio" described that arrangement correctly and is now
superseded by D-053 for scope; its guard behaviours (repeat, editable target,
stale handler) still hold.

Two separate mistakes are easy to make when widening such a binding, and both
are silent:

- **Two selections diverge.** Give the Studio its own copy and toggle outdoors,
  and the Studio's copy is stale. The next press emits a key the avatar is
  already wearing, the dedupe swallows it, and nothing changes. The fix is one
  Scene-owned selection injected into the Studio — required, not defaulted, so
  a caller cannot silently opt back into a second copy.
- **Attach/detach per transition loses the listener.** Registering on room
  entry and removing on exit reintroduces the same class of bug across
  studio/room/outdoor transitions and same-instance restarts. One listener for
  the Scene's lifetime, gated by an `isActive()` predicate asked at press time,
  has no transition to get wrong. `InputGate.suspended` is the whole predicate:
  a panel or a Shell control claim owns the keyboard, and reading a cached flag
  instead would go stale on exactly the transition that matters.

The toggle stays cosmetic. It resolves through the existing
`pairedAvatarSprite` mapping and emits the existing `avatar:selected` with an
opaque `avatar-1..avatar-16` key. Toggling inside a financial room adds no
lobby traffic: `LobbyClient.updatePosition` carries no sprite, presence is
suspended while inside, and only `resume()` republishes the selected key on
exit. A consequence worth knowing rather than fixing here: an outdoor toggle
also does not reach other players until the next suspend/resume or join, which
is pre-existing D-047 wire behaviour, not something D-053 changed.

A third mistake is available to the *test*, not the code: stubbing `create()`.
The first restart test hand-rebuilt only the avatar visual and the binding, so
it stayed green no matter what order `create()` used — and building the Studio
before the Scene has a selection hands it the no-op left behind by
`cleanShutdown`, which changes nothing until someone presses F. Restart
coverage must therefore run the real generated `create()` twice on the same
instance, stubbing only the Phaser-heavy presentation steps, and must record
one avatar per cycle so "the new avatar changed" cannot be satisfied by an
absent `avatarVisual`.

*Verified:* red observed first on both public seams — `avatar-outfit.js` did
not resolve, and all nine `street-scene-lifecycle` cases failed on a missing
`createAvatarOutfit`. Green after implementation: 22 World files / 218 tests,
full workspace 86 files / 1,143 tests, workspace typecheck, production build,
invariants, drift and tilemap checks. Three mutations proved the tests have
teeth: forcing `isActive` to `true` failed the suspension case; handing the
Studio its own selection failed the outdoor/Studio case; and swapping
`createAvatarStudio` ahead of `createAvatarOutfit` in `create()` failed the
restart case at its cycle-2 assertion with the cycle-1 assertions blinded, so
the ordering is covered on the restart path and not only on first create. These
checks prove input, selection, event and lifecycle ownership headlessly only.
No browser, wallet, network, proof, signature or transaction was involved, and
at this checkpoint the rendered in-game acceptance at
`http://localhost:5173/` remained open. That status is superseded by the
2026-08-28 finding linked above; subjective final-art acceptance remains open.

### 2026-08-20 — Matching bounds do not prove cross-facing character identity

The D-052 handoff had equal top, height and feet measurements across facings,
but character 5/13 still changed from its long golden-haired robed identity in
the vertical rows to a compact grey/brown character in the side rows. Runtime
row/frame resolution was correct; the mismatch was baked into the source art.
Cross-facing QA must therefore compare the actual hair, face, torso, clothing,
palette and equipment construction, not only alpha bounds or size class.

Commit `0051fce` rebuilds only the twenty left/right cells for `avatar-5` and
`avatar-13` from their approved identity while preserving the authored
direction-specific fighting staff. Down/up cells, every other sheet,
`v1-review/`, runtime mapping, wire shape and the separate D-053 F-toggle todo
are unchanged. This is independently reviewed source/art evidence, not user
rendered in-game acceptance.

*Verified:* nearest-neighbour before/after inspection of four idle facings and
both five-pose side rows; independent cell diff showing exactly ten changed
left/right cells per key; a second Pillow scan over all 320 frames for sheet,
alpha, palette, feet, holes and motion bounds; and an independent decoder of
all 320 compressed Aseprite cels, each pixel-identical to its PNG cell. GitHub
Actions run 32374850224 passed all jobs for `0051fce`. No wallet, network,
financial or runtime code was exercised by the correction review.

### 2026-08-20 — A moving foot is not evidence of a whole-body gait

The first D-052 five-column art handoff passed frame dimensions, alpha, palette,
feet, anatomy-gap, edge and Aseprite round-trip checks, yet all 256 movement
cells changed only at `y=45..53`: the pelvis, torso and upper body were visibly
frozen while the lower legs moved. Mechanical silhouette cleanliness therefore
does not establish a readable walk cycle.

Avatar movement QA must compare every contact/passing cell with its directional
idle, require substantive changed-pixel coverage above the per-character hip
gate, and inspect repeated loops at the runtime cadence. Checking only the first
changed pixel is also insufficient because a token upper pixel could satisfy
it. The accepted correction at `8e92cfa` changes at least 243 pixels above the
hip in every movement cell, with at least 60.8% of each cell's total changed
pixels above that gate; motion reaches `y=8..27`. Its 320-frame Aseprite
round-trip is pixel-identical, and World commit `5c8c81a` plays all five columns
at 8/12 FPS. Rendered browser acceptance remains user-owned.

*Verified:* independent Pillow diff over all sixteen 320x256 sheets and all
four facings; the rejected `0ccf5b9` failed 256/256 cells and the corrective
`8e92cfa` passed 256/256. Independent review also confirmed fixed height and
feet, zero reported holes/channels/fringe pixels, contrasting-background
contacts, and regenerated ten-frame preview sequences. No runtime body, wire,
lobby, privacy or financial behavior changed.

### 2026-08-20 — A connected sprite mask can still contain an anatomy hole

The rear-facing `avatar-1` art has a transparent channel through the middle of
the legs/crotch that reads in-game as deleted pixels. Existing component,
baseline and bounds checks did not reject it because the remaining body is one
connected opaque component and the bad gap is connected to exterior
transparency rather than forming an enclosed island.

D-052 QA must therefore reject accidental transparent pinholes and narrow
channels through hair, torso, coat/skirt, pelvis, limbs, boots, hands and
weapon joins. Flood-filled interior-hole detection is necessary but not
sufficient: compare body masks with the approved turnaround guides, preserve
required shoulder-to-hand and pelvis-to-foot opaque corridors, scan 1–2 px
channels through the expected body envelope, and inspect enlarged silhouettes
plus repeated motion on contrasting backgrounds. Only stable, anatomically
readable intentional negative space may be explicitly whitelisted.

*Verified:* James supplied an in-game rear-view screenshot showing the missing
leg pixels; direct inspection of the committed `avatar-1.png` up-facing cells
reproduced the same transparent channel. World renders the authored alpha from
that facing row without direction-specific scaling or masking. No runtime,
wire, collision or privacy behavior is involved.

---

### 2026-08-20 — Fighting-state input is owned only by the active Avatar Studio

**SUPERSEDED for scope by D-053 and by the newer 2026-08-20 finding "A key
binding owned by a room works only in that room".** `F` is no longer owned by
Avatar Studio: `StreetScene` owns one selection and one listener for the whole
Scene. Read the paragraph below as the historical D-052 arrangement and the
reason it had to change, not as current behavior. What still holds and is still
enforced: the `pairedAvatarSprite()` resolution, the unchanged `avatar:selected`
event, figure contact selecting a cosy `avatar-1..8` state, the repeat and
input/textarea/select/content-editable guards, and a destroyed binding
rejecting an already-captured late handler. The verification recorded at the
end of this entry stands as of the commit it names.

The approved `F` action is a World-local Studio control. The Studio controller
switches its selected opaque key with `pairedAvatarSprite()` and emits the
existing `avatar:selected` event; contacting one of the eight figures still
selects its cosy `avatar-1..8` state. `StreetScene` installs the exact
`keydown-F` listener only after the real controller enters the Studio, removes
it on the controller's exit callback, and destroys it during same-instance
shutdown/restart. Repeat events and input, textarea, select or content-editable
targets are ignored. Inactive or destroyed bindings reject even an already-
captured late handler. No stance field, new event, lobby/Fly/shared change or
financial meaning was added, and the existing local visual selector retains
the avatar's current facing and movement pose.

The first lifecycle regression test was not sufficient: it stubbed
`createAvatarStudio()` and called private Scene enter/exit methods directly, so
it could stay green if the real controller callbacks stopped owning the
listener. The corrected harness constructs the real controller/binding, calls
public `enter()`, delivers `F`, exits through `update()` on the authored portal,
re-enters, then performs idempotent Scene cleanup. Removing enter activation
made the test fail red with zero rather than one listener; restoring that and
removing exit deactivation made it fail red with one rather than zero.

*Verified:* commit `8efc5a4` passed 22 World files / 206 tests and the full 85
files / 1,129 tests locally, plus workspace typecheck, production build,
invariants and diff checks. Independent re-review closed the lifecycle-test
P2. [GitHub Actions run 32357641789](https://github.com/Calcutatator/STRKWORLD/actions/runs/32357641789)
completed successfully at that commit. These checks prove input, state, event
and lifecycle ownership only; they do not accept the fighting animation art,
cadence, weapon extents or rendered in-game result. No browser, wallet,
network, proof, signature or transaction was used by the focused tests.

### 2026-08-20 — Submission uncertainty exposes observation, not mutation

The D-034/D-035 browser-session uncertainty gate now separates observation
from ownership. `createSubmissionUncertainty()` exposes a frozen
`ReadableStore` facade with only `subscribe`, `getState` and
`getServerSnapshot`; the writable store remains private to `retain()` and
`acknowledge()`. Its two-field state snapshots are readonly and frozen as
well. A consumer can therefore observe the gate for React rendering and
financial guards, but cannot use the public store to clear or rewrite a
retained uncertainty. A later `retain()` still re-locks an acknowledged gate.

This remains session-only, hashless uncertainty: reload starts a fresh browser
session, and the store retains no intent, recipient, timestamp, request handle
or transaction hash. The change does not make the flag durable or authoritative
transaction evidence, and changes no wallet operation, submission/retry rule,
balance-check acknowledgement, player copy or financial policy.

*Verified:* the red public-seam regression retained uncertainty and then used
the exposed `store.setState()` to change `active` back to false. Commit
`c75fa32` replaces that alias with the exact frozen read facade, proves the
public type and runtime keys contain no `setState`, rejects snapshot mutation,
and preserves idempotent retain/acknowledge behavior.
[GitHub Actions run 32330527646](https://github.com/Calcutatator/STRKWORLD/actions/runs/32330527646)
completed successfully at that commit. No browser, wallet, network, proof,
signature or transaction was used.

### 2026-08-20 — Deviation admission requires complete nonblank approval metadata

D-020 route admission now fails closed unless every below-private deviation
has nonblank string values for all four existing approval fields:
`approvedBy`, `approvedOn`, `rationale` and player-facing `disclosure`.
Previously `isRoutePlayable()` compared only `approvedBy` and `disclosure`
with `null`, so missing values, empty or whitespace text, and absent approval
date or rationale could be admitted. Complete canonical approvals remain
playable, `private` routes still need no approval metadata, and an unapproved
deviation remains locked.

This validates completeness only. It does not invent a date format, judge the
identity or quality of an approval/rationale, add fields, change route grades
or disclosures, or alter any financial operation.

*Verified:* fourteen of the sixteen missing/null/empty/whitespace field cases
failed red through the public admission function under the prior two-field
check. Commit `70a3941` makes all sixteen reject, while pinning the canonical,
private and unapproved boundaries.
[GitHub Actions run 32314240213](https://github.com/Calcutatator/STRKWORLD/actions/runs/32314240213)
completed successfully at that commit. No wallet, network, proof, signature or
transaction was used.

### 2026-08-20 — Pending World configuration changes retain one acquisition owner

`WorldHost` now keys its lease by the current event buses and remote-peer
source. The lease manager keeps same-key StrictMode remounts single-flight,
but a changed key replaces a stale zero-lease acquisition only after that
acquisition settles. A late success releases the stale World before the
replacement starts; a late rejection still advances the replacement. Every
queued replacement owns an observed promise immediately, so an A→B→C change
chain cannot lose its acquisition owner, and early cleanup still releases the
new World as soon as it arrives. This is an internal Web lifecycle seam; it
does not widen the World package API, event payloads, presence or financial
behavior, and it is not rendered Phaser acceptance.

*Verified:* the chained replacement case failed red with a `TypeError` while
reading `then` from B's null acquisition; commit `b6ea5c7` makes A, B and C
serialize with a peak of one live World. The same-key, stale-success,
stale-rejection, early-cleanup and fresh-acquisition cases also passed.
[GitHub Actions run 32313669728](https://github.com/Calcutatator/STRKWORLD/actions/runs/32313669728)
completed successfully at that commit. No browser, wallet, network or
transaction was used.

### 2026-08-20 — Every Node timer delay is capped without shortening its budget

All call sites that can reach Node timers now keep each scheduled delay at or
below `2_147_483_647` ms. Backend production parsing and direct composition
reject transfer or unshield queue delays above that ceiling. Lobby client
construction rejects an unsafe send interval, and reconciliation caps rollback
arithmetic without moving the monotonic send floor. Bridge polling caps each
sleep while counting every capped sleep toward the original cumulative active
budget, so a longer valid budget is completed as multiple delays instead of
being truncated. These are local scheduling guards: wire schemas, routing,
queue policy, provider status validation and abort/cancellation authority are
unchanged, and the Bridge cap does not time out a hung provider request.

*Verified:* red Backend cases accepted an overflowing environment/direct
route delay; red Lobby cases accepted unsafe intervals or scheduled overflow
after clock rollback; and red Bridge cases passed an over-ceiling sleep to its
timer. Commits `6637e2f`, `dfb1d4e` and `5c98ddc` make the exact ceiling pass,
reject or cap the next integer, preserve Lobby reconciliation, and split the
Bridge's `2_147_483_648` ms budget into `2_147_483_647` plus `1` ms. Their
hosted CI runs all completed successfully:
[Backend 32312060302](https://github.com/Calcutatator/STRKWORLD/actions/runs/32312060302),
[Lobby 32312864117](https://github.com/Calcutatator/STRKWORLD/actions/runs/32312864117),
and [Bridge 32313298876](https://github.com/Calcutatator/STRKWORLD/actions/runs/32313298876).
No server/socket, remote lobby, provider request, wallet, proof, signature or
transaction was used by the focused tests.

### 2026-08-20 — Final D-049 art passes mechanical review; the shared index is cumulative

The final handoff at `packages/world/assets/player-sprites/v1/` contains root
`README.md`, `manifest.json`, `avatar-1.png` through `avatar-16.png`, tagged
`source/player-sprites.aseprite`, and `qa/README.md`, `qa-report.json`,
`source-inspection.json`, `aseprite-roundtrip.json`,
`all-characters-movement.png`, `background-readability.png` and
`character-1-walk.gif` through `character-8-walk.gif`. Each sheet is a
192x256 RGBA 3x4 grid of 64x64 cells: down/left/right/up rows,
idle/walk-1/walk-2 columns, binary alpha, no clipping, at most 24 visible
colours and feet fixed at `(32, 56)`.

Independent decoding proved a valid 64x64 32-bit Aseprite source with 192
125 ms frames, one `art` layer, exact 80 key/direction tags and two documented
slices; all 192 reconstructed cels were pixel-identical to the PNGs. Separate
scans matched every committed QA frame/hash, movement, palette, edge/shadow
heuristic and approved idle. Provenance records project-owned original work
from the James Wilcock-directed Codex/ImageGen workflow and no third-party
pixels; that record is not an independent legal/originality determination.
The manifest still says
`final-art-handoff-awaiting-runtime-integration-and-rendered-acceptance`:
delivery proves neither World integration nor user-rendered acceptance.

Commit `86e8f5f` also exposed a shared-index trap. Another worker's art was
already staged; `git add -- AGENTS.md` did not remove it, so both scopes were
committed. Printing `git diff --cached` or `git status` in a command chain is
not a gate because a successful print lets the commit continue. Orchestration
must inspect the index separately, compare it with the exact intended path
allowlist, and stop before commit on any unexpected path.

*Verified:* commit inventory, Pillow frame/hash scans, direct Aseprite binary
parsing and cel reconstruction, committed QA JSON, and
`git show --name-status 86e8f5f`. No Aseprite executable was available, so no
new CLI export was claimed. No runtime code, browser, Phaser scene, wallet,
network or transaction was used.

### 2026-08-20 — StreetScene restarts own a fresh failure-safe lifecycle

**The thrown-`create()` cleanup limitation below is superseded by the
2026-08-30 construction-failure finding above; the restart and framework
shutdown verification here remains valid.**

Phaser may restart the same `StreetScene` instance, so `create()` now opens a
new cleanup cycle before its first allocation: it clears the prior ground
reference and tile-report sentinel, resets the idempotence guard, and registers
the scene's one-shot `shutdown` handler before construction begins. Cleanup
destroys the resources reached in the current cycle and clears their ownership
references, including room controllers/maps and active state, Studio state,
input gate, room graphics and labels, remote avatars, door overlays and Studio
figures. A successful restart, an early throw and a later partial throw can
therefore each receive shutdown cleanup once, followed by another successful
cycle on the same Scene instance, without re-destroying the completed prior
cycle or exposing its destroyed ground layer and last tile.

The regression harness must preserve that exact lifecycle. Constructing a new
Scene for each cycle hides stale instance state; calling `cleanShutdown()`
directly after a failed `create()` hides a handler that was armed too late; and
counting only one listener after the remote-avatar layer exists mistakes its
own shutdown listener for a duplicate. The tests therefore reuse one instance,
emit the real shutdown event after both failure positions, expect the scene
listener alone after the early throw and both legitimate listeners after the
partial throw, then call cleanup directly only to prove idempotence.

This does not catch or retry a thrown `create()`, and cleanup after failure
still depends on Phaser delivering shutdown. It does not change authored
geometry, movement, portals, event or presence payloads, wallet or financial
behavior; rendered restart acceptance remains untested.

*Verified:* the red same-instance cases either skipped later cleanup because
the old guard stayed set, retained destroyed prior-cycle references, or had no
scene cleanup listener when construction threw before the former end-of-create
registration. Commit `1a415f8` makes two complete cycles clean each owned
resource exactly once, delivers idempotent cleanup after the early failure,
cleans resources reached before the partial failure, resets the ground and
`lastTile` sentinel, and recovers with a later successful cycle. The focused
StreetScene lifecycle tests and World typecheck, invariant scan and diff check
passed.
[GitHub Actions run 32311268181](https://github.com/Calcutatator/STRKWORLD/actions/runs/32311268181)
also completed successfully. No Phaser runtime, browser, network, wallet or
transaction was used.

### 2026-08-20 — The receipt ledger owns immutable session snapshots

`ReceiptLedger.record()` now copies the building and transaction hash, clones
and freezes every current `Intent`, and retains them in frozen receipt, intent
list and ledger-state snapshots. `pending()` likewise returns a frozen filtered
view over the frozen held receipts. A caller can no longer mutate its original
receipt or intents after recording, or mutate a value returned by `pending()`,
to move settled evidence to another building, rewrite the hash used for
acknowledgement or change what the receipt says settled. That ownership matters
because the provider-level ledger is the evidence a reopened room uses after
the submitting panel has unmounted.

This is reference-alias protection for the current in-memory receipt shapes,
not durable or authoritative transaction history. Receipts still disappear on
reload, the ledger does not validate settlement, hashes or intents, and code
holding the exposed store's write capability can still replace its state.
Submission, acknowledgement, wallet and privacy semantics are unchanged.

*Verified:* the red source-alias case changed a recorded Bank receipt to
Exchange, rewrote `0xabc` so acknowledgement no longer matched, and replaced
and appended shield intents; the red read-alias case could mutate every held
layer exposed through `pending()`. Commit `c1577c4` makes the stored and returned
building, hash, current flat intent objects and their containing arrays remain
unchanged and frozen while acknowledgement by the original hash still clears
the receipt. The focused receipt-ledger tests and Web typecheck, invariant scan
and diff check passed.
[GitHub Actions run 32309718683](https://github.com/Calcutatator/STRKWORLD/actions/runs/32309718683)
also completed successfully. No browser, storage, wallet, network, proof,
signature or transaction was used.

### 2026-08-20 — Fly public and private service ports are pairwise distinct

The strict Fly environment boundary now parses the public, Backend and lobby
ports once and requires all three to differ, including when the private ports
come from their defaults. A collision between any pair fails with the same
generic `Fly service ports must be distinct.` error before the supervisor
starts either child or binds the public edge. The check prevents one
composition from assigning two services the same port; it does not prove a
port is free on the host, or establish Fly routing, TLS, domain ownership,
process readiness or deployment health. CORS, presence schema, financial
routes, logging and secrets are unchanged.

*Verified:* the red matrix previously accepted public/Backend, public/lobby
and Backend/lobby collisions; commit `572fa03` makes all three reject while
the existing valid/default environment cases remain green. The focused Fly
port-collision test and Fly build typecheck, invariant scan and diff check
passed.
[GitHub Actions run 32308940057](https://github.com/Calcutatator/STRKWORLD/actions/runs/32308940057)
also completed successfully. The port-collision test starts no process and
binds no socket; no deployment, wallet, RPC, proof, signature or transaction
was used.

### 2026-08-20 — Batch intent limits are positive safe integers

The Menu Mode batch accumulator now validates its internal `maxIntents`
configuration when it is constructed. Only positive safe integers are
accepted; `NaN`, infinities, zero, negatives, fractions and values above
`Number.MAX_SAFE_INTEGER` fail immediately with one fixed local error. Valid
limits still reject the first excess intent as `batch-full` with the configured
limit, including the minimum limit of one; the default remains sixteen. This
is a guard on trusted Shell composition, not a browser, wire or financial-input
parser, and it changes no intent validation, batching mode, wallet seam,
confirmation or transaction behavior.

*Verified:* the red parameterized cases constructed accumulators with malformed
limits; commit `f93da8a` makes all seven reject with
`maxIntents must be a positive safe integer`, while paired green cases pin
limits one and thirty-two plus their exact `batch-full` result. The focused
accumulator tests and Web typecheck, invariant scan and diff check passed. No
production build, browser, wallet, proof, signature or transaction was used.

### 2026-08-20 — Bridge active polling keeps its budget through clock rollback

`BridgeService.watch()` now measures its active window from the greatest
observed wall-clock elapsed value and the cumulative sleep it has scheduled.
A backward or oscillating clock therefore cannot erase polling time or keep a
pending watch alive indefinitely. The final sleep uses only the exact remaining
budget; exhaustion persists the existing resumable "still pending" status with
`pollingStopped: true`, while an explicit abort propagates its reason without
rewriting the pending record. This bounds the polling loop, not a separately
hung provider request; the caller's abort signal remains that cancellation
authority. Quote expiry, provider status validation, signed-evidence retention
and all wallet/financial seams are unchanged.

*Verified:* the red rollback and oscillation cases reached a guarded third
sleep instead of exhausting a 20 ms active window; commit `18d6749` makes both
stop within budget, pins a 7/7/6 ms final-sleep sequence for a 20 ms window,
and proves abort leaves the persisted pending status active for later resume.
The focused Bridge suite and package typecheck, invariant scan and diff check
passed. No provider request, wallet, RPC, proof, signature or transaction was
used.

### 2026-08-20 — Backend request timeouts stop at the Node timer ceiling

The strict production parser now accepts `BACKEND_REQUEST_TIMEOUT_MS` only
through `2_147_483_647`, the largest delay supported by Node's timer range,
and rejects the next integer with the existing generic variable-naming error.
That one value feeds both the HTTP server request timeout and the Backend API
deadline, so an overflowing production setting can no longer be accepted and
then execute with unintended timer behavior. This bound applies only to the
request timeout; it changes no valid configuration, route policy, queue,
authorization, response or submission semantics.

*Verified:* the red boundary previously allowed `2_147_483_648`; commit
`0e0069f` makes that regression green while a paired test accepts exactly
`2_147_483_647`. The focused Backend environment/server tests and Backend
typecheck, invariant scan and diff check passed.
[GitHub Actions run 32307155130](https://github.com/Calcutatator/STRKWORLD/actions/runs/32307155130)
also completed successfully. No server was bound, no request was sent, and no
wallet, RPC, proof, signature or transaction was used.

### 2026-08-20 — Stale wallet checks resolve to the authoritative current state

Generation invalidation already prevented a late capability success or failure
from mutating the connect store. It now governs the promise result too: if an
attempt becomes stale while awaiting the wallet, it resolves to the store's
current state rather than returning its obsolete classification. A caller
therefore sees `disconnected` after an intervening disconnect, or the newer
connected result after a fresh attempt wins. The underlying wallet request is
still not cancelled, and `PrivacyOperations`, capability classification and
wallet-status mapping are unchanged.

*Verified:* the red cases returned the stale success/failure classification
even though the store had moved on; commit `7c56661` makes both return
`disconnected` after disconnect and makes an older failed attempt return the
newer's connected result. The focused connect-flow tests and Web typecheck,
invariant scan and diff check passed.
[GitHub Actions run 32307101687](https://github.com/Calcutatator/STRKWORLD/actions/runs/32307101687)
also completed successfully. No wallet, proof, signature or transaction was
used.

### 2026-08-19 — Lobby movement timing is monotonic on both sides of the wire

Lobby movement and resume throttles now use `performance.now()` in both the
client and room process. The client keeps a nullable send floor rather than
using zero as a sentinel, preserves that floor through a clock rollback, and
reconciles the latest requested placement when the interval is genuinely due.
The server rejects negative or non-finite samples without moving a session,
never moves an accepted floor backward, and validates resume time before
restoring a suspended peer. These are local scheduling values only: no time,
identity, building or financial field was added to the presence protocol.

*Verified:* commit `009ae3f` added client rollback/reconciliation, throttle
rollback/oscillation/invalid-sample and presence move/resume tests. The focused
Lobby tests and typecheck, invariant scan and diff check passed. No browser,
remote lobby, wallet, network or financial action was used.

### 2026-08-19 — Disconnect invalidates an in-flight wallet capability result

The Shell connect flow now gives each capability check a generation. A
disconnect increments it, clears the shared in-flight slot and sets the store
to disconnected, so a late capability success or failure may settle its own
promise but cannot overwrite current UI state. A subsequent connect starts a
fresh check immediately and its result remains authoritative when the older
attempt later settles. This is logical stale-result suppression, not
cancellation of the underlying wallet call, and it changes neither
`PrivacyOperations` nor capability classification.

*Verified:* commit `84134e1` added deterministic deferred tests for late
success, late failure and a fresh attempt winning over its predecessor.
[GitHub Actions run 32292050613](https://github.com/Calcutatator/STRKWORLD/actions/runs/32292050613)
passed workspace typecheck/tests, invariants, header checks, drift canary and
both deployment image checks. No wallet, proof, signature or transaction was
used.

*Forward note — stale promise return behavior superseded by the 2026-08-20
finding above:* generation invalidation still owns the store, but a stale
capability promise now resolves to that authoritative current store state
rather than its own obsolete classification.

### 2026-08-19 — BridgeProvider derives live capability from current props

A supplied Bridge service is now composed synchronously from the current
provider props, so removing it or entering a production-rejected demo state
cannot leave a previously live runtime visible until an effect flushes. Only
the optional lazy demo uses resolved state; its generation guard is private to
the provider, clears stale demo state on configuration changes and prevents a
late import from resurrecting an obsolete runtime. Production still rejects
demo mode even when a service is present, and availability still requires both
the current account snapshot and planner, preserving D-043's production lock.

*Verified:* final corrective commit `b9adc4c` keeps the demo lifecycle guard
internal and tests unavailable, direct-live and production-rejected render
states. [GitHub Actions run 32291442814](https://github.com/Calcutatator/STRKWORLD/actions/runs/32291442814)
passed workspace typecheck/tests, invariants, header checks, drift canary and
both deployment image checks. No provider request, wallet, proof, signature or
transaction was used.

### 2026-08-19 — Interior movement uses bounded half-tile collision substeps

Fixed rooms and Avatar Studio now share a bounded movement helper that samples
collision in pixel substeps no larger than half a tile, preserves the existing
axis-separated diagonal behavior, and caps extreme finite frame travel. A late
or unusually large frame can no longer jump from one side of an authored solid
interior tile to the other; malformed movement inputs fail closed. The helper
changes movement robustness only and does not alter room geometry, portal
direction, presence payloads or financial behavior.

*Verified:* commit `cce0489` added large-delta tunnelling, diagonal ordering,
normal/sprint displacement, malformed-input and Avatar Studio coverage; the
focused World movement suite, World typecheck, invariant scan and diff check
passed. No browser, wallet, network or transaction was used.

### 2026-08-19 — Lobby joins reject on pre-welcome room failure and same-turn closure

`LobbyClient.connect()` now shares one interruptible join attempt and rejects
promptly when the joined room errors, leaves, or is explicitly disconnected
before welcome. The room is published before lifecycle callbacks are attached,
so an immediate error can be identified and cleaned up exactly once. A welcome
followed in the same turn by error or leave does not resolve `connect()` as
connected; stale callbacks remain generation- and room-guarded, and a fresh
connect can proceed cleanly. The lobby protocol and privacy-minimal payload are
unchanged.

*Verified:* commit `74ebcb5` added pre-welcome error/leave/disconnect,
concurrent-caller and same-turn welcome/closure tests; the focused Lobby suite,
Lobby typecheck, invariant scan and diff check passed. No browser, wallet,
network or financial action was used.

### 2026-08-19 — World host teardown owns an async stop transition

The World host now enters a stopping state before invoking `stop`, keeps the
doomed instance as the lifecycle owner until an async stop settles, and clears
that ownership on both success and failure. Nested `acquire` and `release`
during synchronous or asynchronous teardown are rejected before changing
references or queuing a second teardown; a failed stop can be retried with a
fresh instance. This preserves the existing deferred final-release and
construction reentrancy rules without adding a Phaser or Shell seam.

*Verified:* commit `e5850c3` added caught/uncaught nested teardown and async
success/failure tests; the focused World tests, World typecheck, invariant scan
and diff check passed. No browser, wallet, network or financial action was
used.

### 2026-08-19 — Bridge planning is invalidated before account reads can race close

Bridge saved-quote preflight and settled shield planning now begin their
generation/session guard before the first account read. Closing the room while
that read is pending therefore invalidates the attempt before a planner call,
state patch or later account check can continue; the existing planner and
commit guards remain in force after each subsequent await. This is a lifecycle
guard only: it does not alter the public-shield planner contract, quote
evidence, account binding or D-043 production lock.

*Verified:* commit `02619ba` added deterministic deferred-account tests for both
saved preflight and shield planning; the focused Shell tests, Web typecheck,
invariant scan and diff check passed. No wallet, provider, planner network call,
proof, signature or transaction was used.

### 2026-08-19 — Backend body abort races preserve generic 400 and authoritative 413

The Backend HTTP boundary races each body read against the request abort,
cancels a hanging stream and releases its reader lock defensively. A client
abort before or immediately after JSON parsing returns the same generic 400
`INVALID_JSON` response and never calls the Backend core. If a body already
exceeds the byte limit, `REQUEST_TOO_LARGE` 413 remains authoritative even
when hostile stream cancellation rejects; cancellation errors must not rewrite
the size violation.

*Verified:* commit `fb89749` adds hanging-body, post-parse-abort and rejecting-
cancel tests; the focused Backend HTTP tests and typecheck passed. The boundary
still forwards only `{method, path, body, signal}` and records no request
identity or body data.

### 2026-08-19 — World host acquisition must roll back refs and reject reentrancy

`createHost.acquire()` increments its lease before starting the instance, so a
throwing `start()` must restore the previous ref count and deferred-teardown
handle before the caller retries. While `start()` runs, nested `acquire()` or
`release()` is rejected with the lifecycle error; otherwise a nested callback
can corrupt refs or orphan a successfully created instance. A successful start
still uses the ordinary deferred final release cleanup.

*Verified:* commit `894f8a0` adds failed-start retry and nested acquire/release
tests; the World tests, World typecheck, invariant scan and diff check passed.
No browser or Phaser runtime was used.

### 2026-08-19 — Production origin classification is one internal Node-only seam

The lobby production entrypoint and Fly startup must consume the same
`packages/lobby/src/production-origin.ts` classifier. It owns hostname policy,
including IPv4 `127/8`, IPv4-mapped IPv6 loopback in dotted and hexadecimal
forms, localhost descendants, `.invalid` names and bounded placeholder labels;
the callers retain whole-origin parsing and formatting. Keep this helper out
of the browser/root lobby export and `packages/shared`, or a deployment-only
policy becomes a client contract. Substring domains such as
`placeholdertech.com` remain legitimate.

*Verified:* commit `d6f2bad` routes both `packages/lobby/src/production.ts`
and `deploy/fly/src/main.ts` through the helper, with the lobby and Fly tests
pinning the same adversarial and legitimate-domain matrix. This changes no
CORS, protocol schema, presence, financial, logging or browser behavior and
does not prove domain ownership, TLS or host readiness.

### 2026-08-19 — Fly startup owns pre-start cancellation and treats forced child termination as failure

The Fly supervisor installs `SIGTERM`/`SIGINT` ownership before private
children start and passes an `AbortSignal` through readiness, public listen and
the final handoff turn. A signal before the composition is returned cancels
startup; only stop code `0` together with the exact typed
`FlyStartupAbortError` is a clean abort. Any other startup rejection,
including cleanup failure, becomes exit `1`. Shutdown observes an `exit` event
from every child: crossing the graceful deadline sends `SIGKILL` but remains a
failure, and a second bounded wait rejects if a child never reports exit.
`Promise.allSettled` waits for both child outcomes before startup cleanup
reports failure. Do not resolve cleanup merely because `kill()` returned.

*Verified:* commit `93dad50`'s Fly composition/supervisor tests cover aborts
after both children are ready, after public listen and immediately before the
return handoff, plus forced termination and listener removal; the focused Fly
suite (4 files / 47 tests), full workspace suite (79 files / 884 tests), Fly
and workspace typechecks, invariant scan, smoke-image syntax and diff check
were green. No deployment, provider, wallet or funded route was used.

### 2026-08-19 — Hosted CI proves both production images stop cleanly

The standalone Backend originally reached TCP readiness but failed its image
smoke after Docker's three-second stop grace. Its exec-form Node process was
PID 1 and owned no `SIGTERM`/`SIGINT` listener. Node 22.12's default handler
resets and re-raises the signal, while Linux gives PID 1 special default-signal
semantics; the unlogged result was therefore consistent with Docker exhausting
the grace and forcing `SIGKILL`, but exit `137` was never directly observed.

D-050 now gives `apps/backend` explicit lifecycle ownership. Both signals feed
one injectable single-flight path that retains and closes the live
`RunningBackendServer` exactly once, exits `0` on success and nonzero on close
failure. The standalone image smoke requires that bounded clean exit and never
accepts a forced kill. This is the same lifecycle shape already used by the
passing Fly composition, without adding a route, log, schema or financial
field.

*Verified:* the lifecycle and smoke tests were observed red against the missing
handler/old exit expectation, then green after the D-050 implementation at
commit `375bad4`. GitHub Actions run
[`32282522737`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737)
passed all 78 test files / 852 tests. Its hosted deployment job
[`96164346536`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737/job/96164346536)
completed in 1m12s with both deploy typechecks, image builds and quarantined
image smokes green. The prior failing run was
[`32279807295`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32279807295).
No secret, API request, RPC/paymaster call, staging deployment, wallet or funded
transaction was used; this evidence must not be cited as funded-route or live
provider readiness.

### 2026-08-19 — Clean CI now proves both deploy images and the Fly edge fails closed

The public Fly edge no longer forwards ambient browser identity carriers into
private children. API requests are rebuilt with only validated JSON
`content-type` and `content-length`; matchmaking and WebSocket traffic likewise
use narrow route-specific headers, excluding cookies, authorization,
proxy-authorization, forwarding and custom player-identity headers. Duplicate
body metadata, missing or malformed JSON content type, non-decimal length and
malformed raw HTTP are rejected generically before the backend is reached.

The composition readiness test had a clean-checkout trap: it served
`apps/web/dist`, an ignored local build that does not exist in CI, so the real
edge correctly returned its static 404 after both children were ready. The test
now creates and asserts its own temporary `index.html`. CI also has explicit
no-emit checks for both non-workspace deploy targets and builds both repository
Dockerfiles from the correct root context.

*Verified:* commit `b369cae` adversarial edge and composition tests, Fly and
backend deploy typechecks, invariant checks, and GitHub Actions run
[`32274724770`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32274724770)
at the same commit. The run passed all 77 test files / 817 tests and built both
`strkworld-fly:ci` and `strkworld-backend:ci` images. No deployment, secret,
wallet or funded network action was performed.

### 2026-08-19 — Authored World geometry fails closed before Phaser owns it

Runtime types are not trusted as authored map validation. The Avatar Studio
now rejects malformed, fractional, border-touching, overlapping or unreachable
selector rectangles, invalid spawn tiles and any exit outside its fixed
envelope before presentation objects or listeners are created. Tiled door
import likewise accepts only finite safe-integer, positive, tile-aligned pixel
rectangles inside validated map bounds; unknown buildings or malformed
geometry produce no door instead of a rounded or out-of-map trigger.

*Verified:* commit `d2a28ab` validator and adversarial tests for the canonical
Studio plus zero, negative, fractional, non-finite, unsafe and out-of-bounds
Tiled geometry; the focused World tests, World typecheck, invariant scan and
diff check passed. This finding validates the fail-closed mechanism, not the
older bottom-wall portal direction, which is superseded by D-048.

### 2026-08-19 — Avatar Studio foundation passes rendered acceptance; cosmetic handoff has two lifecycle gates

D-047's non-financial foundation is implemented and has passed user-run
rendered acceptance on localhost. A hidden pavement path runs south from spawn
to the bottom-edge trigger and enters a validated 18×12 Avatar Studio with
eight collision-selectable cosy figures. World uses only the three approved
`WorldEvents`; World, lobby and Fly share the existing single `sprite` field
across the sixteen opaque keys, with `avatar-1` as the default/fallback. The
Shell keeps selection only for the current page runtime, resumes it with street
presence and maps remote states to deterministic placeholder tints. No stance,
building, wallet, account or financial field was added.

The ordering is part of the privacy/lifecycle contract. On exit, the restored
street `player:moved` placement must publish before `avatar-studio:exited`
resumes presence. A selection made while a lobby join is in flight makes that
client stale and requires one replacement; replacement waits while inside and
deduplicates reconnect requests. Presentation tests must drive the same
adapter and teardown seam used by `StreetScene`, or a green fake can miss a
production cleanup leak. The keyboard toggle is deliberately unbound pending
the user's key choice. The PNG sheets committed at `e5eaea9` are review art,
not runtime assets. At that point their review recorded transparent-alpha
cleanup, exact 32×32 extraction, manual anchor/feet validation and user art
approval as pending; D-049 supersedes the 32×32 extraction instruction with
the fixed transparent 64×64 logical canvas while preserving the verified
review provenance and the remaining cleanup/approval gates.

*Verified:* exact World presentation/lifecycle ordering and teardown tests,
World/shared tests and typechecks, lobby admission/resume tests, Fly edge
allowlist tests, Shell presence replacement/reconnect tests, invariant checks
and diff validation. On 2026-08-19 the user manually hard-refreshed
`http://localhost:5173/` and confirmed the facade door surround, hidden south
path and entry, all eight placeholder figures, collision selection/colour
change, and two-tab presence hide/restore. No agent browser automation was
used. The fighting-state toggle and final runtime sprite art were not accepted
by that test and were still open at that checkpoint; the newest 2026-08-28
D-053 finding above supersedes the functional/interactive toggle status, while
subjective final-art judgment remains open. No wallet, proof, signature or
transaction was used.

*Forward note — navigation and art details superseded by D-048/D-049:* the
hidden exterior street trigger remains at the south map edge, but the Studio
interior now requires a centered 2×1 **top-wall** portal with entry immediately
inside and exit back upward. The provisional 32×32 extraction is no longer the
runtime target: all sixteen visual states use one transparent 64×64 logical
canvas with feet at `(32, 56)` over an unchanged authoritative 24×24 gameplay
body/contact footprint. The current review PNGs remain non-runtime art, and
both changes require fresh implementation and user-rendered acceptance.

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

*Forward note — superseded by D-047:* the current `avatar-1` through
`avatar-8` deployment is not the final cosmetic contract. D-047 fixes the
existing single lobby `sprite` field at sixteen opaque keys: `avatar-1..8`
cosy/default and `avatar-9..16` fighting, paired `1↔9` through `8↔16`; no
stance field or message is added. The hidden Avatar Studio stays outside
`BuildingId`/`BUILDINGS` and uses dedicated non-financial world events, so it
must not enter the financial VisitLayer. Default/fallback is `avatar-1`, and
selection is page/runtime-only. The source registries are now expanded
atomically offline as recorded in the newest Avatar Studio finding above; no
production deployment or runtime sprite-art readiness is implied. The newest
finding records the separate localhost rendered-foundation acceptance.

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
