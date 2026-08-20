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
the rendered in-game acceptance at `http://localhost:5173/` remains open.

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
by that test and remain open; no wallet, proof, signature or transaction was
used.

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
