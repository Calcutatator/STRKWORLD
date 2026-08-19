# Work plan — division of labour

How STRKWORLD gets built, and how several agents work in parallel without
colliding.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the boundaries and
[`SPEC.md`](SPEC.md) for what is being built. This document is about *who does
what, in what order*.

---

## The lanes

Six active lanes aligned to package boundaries. The package boundary **is**
the lane boundary — that is why the repo is shaped the way it is.

| Lane | Package | Status in v1 |
|---|---|---|
| **Chain** | `packages/privacy` | Active; private seam frozen, D-043 planner port/fake complete, production Ready planner blocked |
| **World** | `packages/world` + `packages/lobby` | Active; Avatar Studio foundation and doorway surround accepted on localhost; keyboard toggle and runtime sprite art remain |
| **Shell** | `apps/web` | Active, starts week 2 |
| **Backend** | `apps/backend` | Active; offline implementation and Fly hardening complete; host, Docker, domain, secrets, Alchemy controls and live staging remain |
| **Bridge** | `packages/bridge` | Active, fully independent |
| **Art** | `packages/world/assets` | Active; Kenney Urban CC0 acquired and role mappings corrected; sprite review sheets are not runtime-ready, and final visual direction, sprite cleanup/approval and station states remain user-gated |
| ~~Contracts~~ | — | **Dormant until post-v1** |

### Why Contracts is dormant

v1 needs no Cairo. The Bank, the Exchange and the Post Office are all reachable
through the Wallet API and AVNU's deployed executor. The Vault is the only
building requiring a `privacy_invoke` adapter, and it is out of v1 by decision
D-007 precisely to keep an audit off the critical path.

Standing up a Contracts lane now creates an idle agent and a seam with nothing
crossing it. When the Vault starts, Contracts becomes a real lane owned by the
Chain agent — the adapter and the client call that drives it are one piece of
work, and splitting them across two agents would mean designing an interface
between two halves of the same feature.

### Why World and Shell are separate

They look like one "frontend" job and are not. Phaser work is scenes, tilemaps,
collision, camera and sprite state. Shell work is React panels, wallet state
and the batch accumulator. Different files, different skills, and —
importantly — **the World lane has no dependency on the chain at all**, so it
can run at full speed from day one while Chain is still measuring wallet
behaviour.

### Why Backend is its own lane

Paymaster custody, privacy-safe RPC reads and a bounded prepare/submit queue
put the server on the financial path. It therefore gets its own owner and
threat model rather than hiding inside the shell. See D-014 and D-015.

### Why Lobby sits with World

The lobby is small and its only real coupling is to movement — position
throttling, interest management, the ephemeral-ID lifecycle. Giving it to a
separate agent means two agents negotiating the shape of a position update.
Same agent, same head.

---

## Before anyone starts: freeze the seams

**This is the highest-risk step and it is not parallel.** Several lanes building
against stubs will diverge, and the divergence surfaces at integration when it
is most expensive.

One agent (or the lead) locks these first:

1. **`PrivacyOperations`** — **frozen under D-036** from the completed
   shipped-code audit, D-018 route-admission shape and D-034/D-035 uncertainty
   contract. Funded behavior remains a pre-launch validation under D-028.
2. **`WorldEvents` / `ShellEvents`** — the event bus contract, in
   `packages/shared/src/index.ts`. Frozen for existing lanes; D-047 is the
   sole approved controlled extension, limited to three nonfinancial
   `WorldEvents` (`avatar-studio:entered`, `avatar-studio:exited`,
   `avatar:selected`). `ShellEvents` remains frozen.
3. **`PresenceState`** — the lobby room schema, in the same file. **Frozen.**
   It is the enforcement point for "the lobby never sees money": a field that
   is not in the type cannot leak.

`WorldEvents`, `PresenceState` and the source-derived financial seam are now
locked. `PrivacyOperations` froze under D-036; the funded wallet run validates
its source-derived assumptions before launch but did not gate that decision or
current development.

Once frozen, changes to `packages/shared` require a decision entry. Not
bureaucracy — a change there breaks three lanes at once, so it should be a
deliberate act rather than a convenient one.

---

## Sequencing

Lanes do not all start usefully at the same time.

```
Week 0   ├── FREEZE SEAMS ──────────────────────────────────┐
         │                                                   │
Week 1   ├── Chain: shipped-wallet source audit              │
         ├── World: scenes, movement, collision              │
         ├── Bridge: port 1Click wrapper + pipeline          │
         └── Art: source packs, licence audit                │
                                                              │
Week 2-3 ├── Chain: PrivacyOperations implementation          │
         ├── World: tilemaps, buildings, lobby                │
         ├── Shell: event bus, panels, batch accumulator ◄──────┘
         ├── Backend: paymaster/RPC proxy + bounded queue
         └── Art: tilesets embedded, first facades
                                                
Week 4-5 ├── Shell: Bank + Post Office + Bridge panels wired
         ├── Chain: AVNU Exchange
         ├── Backend: route limits, kill switches, privacy tests
         └── World: second district, polish
                                                
Week 6-8 └── Integration, mainnet regression, hardening, launch
```

**D-028 supersedes the funded Phase 0 run as a development gate.** The Ready
5.33.8 source audit answered the structural questions needed to keep building:
private reads prompt, action arrays become one wallet action, deposits batch
approval calls, and arbitrary `invoke` remains unproven end to end. No lane
waits for wallet access. Rendered prompt sequence, real latency and AVNU
paymaster acceptance of a wallet-produced artifact stay on the pre-launch
checklist and any divergence is handled as a normal bug.

---

## Lane briefs

Each brief is written so an agent can be pointed at it and start.

### Lane: Chain

**Owns** `packages/privacy`. The STRK20 seam.

**First task — completed source audit, funded validation deferred.** Inspect the
shipped wallet implementation and package types, record source-derived behavior
in `AGENTS.md`, and implement against it. Before launch, drive all three methods
against a real extension on mainnet with tiny amounts and amend any finding the
live run contradicts (D-028).

**Then — complete:** implement `WalletApiPrivacyOperations` against the
source-derived seam, now frozen by D-036.
Wallet connection via `get-starknet-discovery` (never the static wallet list),
capability detection by version query only, action-array construction with the
open-note invariant, recipient preflight via the pool's `get_public_key`, and
the full error taxonomy mapped to `PrivacyErrorKind`. Add a route registry that
maps each typed intent to a pool-native action, AVNU's private executor or an
audited anonymizer deployment.

**Current frontier:** D-036 freezes the implemented `PrivacyOperations` seam,
and D-041/D-042 authorize one bounded prepared-swap review: sanitized expected
output, AVNU's policy-protected minimum, slippage and expiry, with no quote or
relay authority. Chain canonicalizes the prepared intent to that protected
minimum without changing the public shape. A lost submit response must never
become a blind retry; funded Wallet API/paymaster validation remains on the
pre-launch checklist.

**D-043 complete offline:** a separate optional public-shield planner port and
deterministic fake are implemented. It is not a method on the frozen
`PrivacyOperations` interface. The port defines `amountToShield` as the
deposit action amount and `plannedReserve = poolFee + estimated public gas`, with
`amountToShield + plannedReserve <= available` required. The token, pool fee,
gas estimate, reserve and shield amount share one Bridge public-STRK
denomination; mismatches fail closed. A zero pool fee is valid, while gas must
be positive so the reserve is non-zero. The current Ready
high-level route is explicitly unsupported: it visibly approves only the
deposit amount while the pool separately pulls its STRK fee. Do not invent an
extra approval, wallet execute fallback or AVNU/paymaster behavior. Shell can
inject a future reviewed production planner, but a real new Bridge quote and
deposit instructions stay locked while that capability is absent. The real
route remains a D-028 funded/source-verification gate.

**Dependency drift rechecked for D-036:** the 2026-08-18 integration freshness
check still finds get-starknet discovery's `next` tag at 6.0.4,
wallet-standard's at 6.0.5, and the upstream monorepo replacing the cited
`sub_account_anonymizer` path with `shadow_account_anonymizer`. The exact
tested pins and v1 routes do not change; any upgrade or route assumption needs
a separate verified Chain brief.

**Must not:** contain UI, import from `world` or `lobby`, branch on wallet
identity, read balances for feature detection, or expose an arbitrary target,
selector or calldata escape hatch.

**Done when:** every `PrivacyOperations` method works on mainnet with real
funds; every active financial building has a tested, allowlisted private route
and kill switch; and a mock implementing the same interface drives the app end
to end. A missing route must produce a locked door, never a public fallback.

**Reference:** [`SPEC.md`](SPEC.md) §3, §4, §6 · `packages/privacy/README.md`

---

### Lane: World

**Owns** `packages/world` and `packages/lobby`.

**Completed baseline:** a walkable street. Phaser 4 scene, generated player,
collision, camera follow, five facades, four active entrances emitting
`building:entered`, and a locked Vault.

**Current frontier:** D-033's procedural Bank room is implemented and manually
accepted: fixed square geometry, physical exit, one solid `bank:shielding`
station, proximity highlight, control handoff and local enter/exit transition.
The Phaser boot-order regression is headlessly pinned so the station receives
its Shell snapshot before interaction. The World half of D-019 now emits the
frozen street-only `player:moved` payload, suppresses interior coordinates and
restores placement before building exit. D-037 now composes the matching Shell
lifecycle: connect after the first placement, suspend before an interior can be
visible, resume from the restored placement, and degrade to explicit solo play
with manual reconnect.

The D-038 remote-avatar implementation is complete and headlessly verified.
The Shell adapts privacy-minimal lobby snapshots into a replaying World-owned
source; Phaser reconciles the full snapshot without importing the lobby or
widening the frozen shared event bus. Its remaining acceptance is manual:
two browsers must see one another move, then see the other avatar disappear on
Bank entry and return at the restored street placement on exit.

The D-039 implementation is complete and headlessly verified. The accepted
Bank behavior now runs through one validated, data-driven fixed-room core, and
the Post Office is the second room with one opaque
`post-office:transfer` station. Bank geometry and behavior remain unchanged;
the shared buses and privacy seam remain frozen. Its remaining acceptance is
manual: enter and physically exit both rooms, and confirm that each station
highlights and opens only its admitted surface.

**D-042 complete offline:** the Exchange is the third definition in the same
fixed-room core, with one opaque `exchange:swap` station. No new scene, shared
event, lobby field or financial meaning entered World. Headless tests pin its
geometry, station presentation and boot-order snapshot. Rendered room and
station acceptance remains user-run at `http://localhost:5173/`.

**D-043 complete offline:** the Bridge is another definition of the same
fixed-room core with one opaque `bridge:deposit` station. World owns geometry,
highlight, activation, exit and teardown only; it gained no recipient, quote,
deposit address, status or wallet concept. Rendered room and station acceptance
remains user-run at `http://localhost:5173/`.

**D-047 foundation complete and rendered-accepted locally:** the hidden south
path and bottom-edge trigger enter a non-financial 18×12 Avatar Studio outside
`BuildingId`/`BUILDINGS`, with no facade, public label or `VisitLayer` route.
Eight collision selectors choose the cosy/default states. The three dedicated
`WorldEvents` are the only event-bus extension, and World, lobby and Fly now
share the existing single `sprite` field across `avatar-1..16`; there is no
stance field or message. Shell retains the selected allowlisted key for the
page runtime, replaces an in-flight client that captured an older sprite,
defers that replacement while inside and deduplicates reconnect intent. Exit
publishes the restored street placement before `avatar-studio:exited` resumes
presence, and remote peers use deterministic placeholder tints. Reload, tab
close or a new session still resets to `avatar-1`. The exact keyboard toggle
remains open and unbound pending the user's choice, and runtime sprite art is
not complete. On 2026-08-19 the user manually accepted the hard-refreshed
localhost foundation: hidden entry, eight placeholder selectors, collision
colour selection and two-tab presence hide/restore. No fighting-toggle or
final-art acceptance is implied.

**Must not:** import `starknet` or any wallet package. Put an address, balance,
transaction hash, building name or entry event into lobby traffic. On local
entry, the shell leaves or suspends lobby presence; other players seeing the
avatar disappear is accepted for v1 (D-019).

**Watch for:** Tiled external tilesets. Phaser rejects them silently with only
a console warning. Embed on export.

**Done when:** two browsers see each other walk around a street; entering a
building fires a clean local event and removes that avatar from the other
browser; and nothing financial or building-specific enters lobby traffic.

**Reference:** `packages/world/README.md` · `packages/lobby/README.md`

---

### Lane: Shell

**Owns** `apps/web`. Starts week 2, once the seams are frozen and World has
something to mount.

**Completed baseline:** the event bus, connect/capability rooms, route gate,
Bank panel, batch accumulator, canonical disclosures, `ConfirmGate`, stale
write guards, session receipt ledger, and D-037's explicit lobby lifecycle with
truthful solo fallback. React owns wallet and financial state; Phaser receives
presentation data and never reads back.

**Current frontier:** D-019/D-037 Shell composition and the D-038 adapter are
complete. The retained source clears on drop/replacement/destroy and suppresses
pre-welcome self snapshots until the server-minted ID permits filtering. The
remaining D-038 gate is the user-run two-browser acceptance described in the
World lane. Do not widen `ShellEvents`, expose the LobbyClient to Phaser, or
change the completed D-033–D-036 Game Mode, uncertainty and financial-seam
behavior.

D-039 is complete and headlessly verified: the opaque Post Office station is
admitted and the existing financial machine is configured for one transfer
mode and one intent. Game Mode reuses recipient preflight, route admission,
`ConfirmGate`, receipts and uncertainty handling. D-040 completes Post Office
Menu Mode with the same transfer-only machine and Menu Mode's compatible
multi-transfer batching. The remaining rendered gate is user-run acceptance
recorded in the World lane.

**D-042 complete offline:** the dedicated Exchange machine and panel use the
checked-in six-asset display catalog in both Menu and Game Mode, one swap at a
time. The player explicitly requests balances; the prepared review carries the
canonical D-024 disclosure, expected and protected outputs, slippage, absolute
expiry and exact fees at `ConfirmGate`; receipts are owned by `exchange` and
outlive the room. Catalog metadata is never route authority. Rendered
acceptance remains user-run at `http://localhost:5173/`.

**D-043 complete offline:** the manual-only Bridge machine and room retain the
concrete connected account beside the privacy seam, bind every new quote to its
address, keep the signed Bridge record in browser-local Bridge storage, and
allow recovery inspection without a wallet. New quotes require both a matching
account and the separately injected public-shield planner
capability; before deposit instructions, preflight it against the signed
minimum output. Settlement uses provider-reported `strkReceived`, rechecks
account and requests a fresh plan, then revalidates at the Bank commit point
before offering the explicit ordinary shield. Until a reviewed production
planner proves the fee allowance/transfer path, the real new Bridge deposit
handoff is locked: only the deterministic offline demo creates new quotes,
while saved/imported record inspection, refresh and export remain usable.
It never auto-submits and never writes Bridge state into the privacy receipt
ledger. Account switches preserve the old record for refresh/export while
blocking new financial continuation. Direct unauthenticated 1Click is the
accepted v1 route, with its 0.2% provider fee disclosed and no fabricated fee
breakdown.

The browser recovery path now uses the persisted signed record: reopening the
Bridge offers one resume action that refreshes provider status first, then
shows only the next safe action. This preserves the stronger account and
planner gates while matching the concise recovery shape validated in Shieldup.
Saved evidence remains inspectable, refreshable and exportable even when a
production planner is unavailable; only real new quotes and deposit
instructions remain locked.

The **batch accumulator is Menu Mode only** under D-032. It collects typed
intent during a building visit and emits one atomic batch on confirmation. Game
Mode prepares and confirms each station function separately. Neither path ever
accepts raw protocol calldata.

**Critical constraint:** batching amortises fees, but **never bundle a deposit
with the transfer it funds**. Deposits carry a public ERC-20 leg naming the
depositor, so bundling publishes the link an observer needs. Shielding stays
its own earlier transaction.

**Must not:** contain logic belonging in a package, set `COOP`/`COEP` headers,
put a paymaster key in the browser bundle, or offer an unshield-and-call/public
frontend fallback when a route is unavailable.

**Done when:** a player connects, sees their balance, shields, and pays another
player — with honest in-product copy about what is and is not hidden.

**Reference:** [`SPEC.md`](SPEC.md) §4, §6 · `apps/web/README.md`

---

### Lane: Backend

**Owns** `apps/backend`. Paymaster custody, proxied RPC reads and bounded
submission for prepared Wallet API calls.

**Completed offline baseline:** the minimum `packages/privacy` endpoints,
strict schemas, fee ceilings, fixed per-route policy, rate limits, aggregate
budgets, global/per-route kill switches, strict environment loader, logging-free
HTTP composition root, and the Fly edge/composition integration. The remaining
backend frontier is operational: an approved aggregate-only signal, host and
Docker verification, domain and secret controls, Alchemy account/key and
provider-control verification, live staging checks, and the funded Wallet
API/paymaster checks retained by D-028. Do not invent a health or metrics route
without the D-014 privacy review recorded in `docs/OPS.md`.

**D-045/D-046 deployment direction:** target one Fly.io app/Machine with a
same-origin edge/composition process for the web build, `/api` and lobby
WebSocket. Use Alchemy provisionally with separate browser/public and
server/private applications or keys. Account creation, domain setup, secret
procurement, provider controls and production deployment remain gated
operational work; no credentials are present.

**D-042 complete offline:** Backend independently checks that AVNU's
slippage-protected output is at least the caller's requested quote floor before
issuing swap relay authority. The check uses AVNU's installed helper and adds
no response schema or endpoint.

**Must not:** log or persist IPs, calls, proofs, timings, recipients or
transaction hashes; accept arbitrary contract targets or calldata; delay a
quote-bound AVNU action; or expose the paymaster key to the client.

**Done when:** an eligible prepared call is validated and submitted without
per-request observability; stale proofs, expired quotes, excessive fees and
disabled routes fail closed; and the server cannot turn a locked building into
a public call.

**Reference:** [`ARCHITECTURE.md`](ARCHITECTURE.md) · D-014, D-015, D-018

---

### Lane: Bridge

**Owns** `packages/bridge`. One path in: any chain → STRK → the pool.

**Fully independent** — no dependency on the Phase 0 spike or the STRK20 seam.
Can start immediately at full speed.

**Completed offline baseline:** the deposit-only 1Click wrapper, manual-first
resumable pipeline, persistence/export/import, source-token/address validation
and refund/failure states are implemented behind a network/storage boundary.
The OUT path and AVNU leg do not exist (D-012). Runtime status data is now
validated before it can settle a record. D-043 chooses direct unauthenticated
1Click for v1; the Shell room/composition is complete offline, while a real new
quote and Bridge-to-Bank handoff remain locked behind the missing production
planner and live funded provider acceptance.

**Build manual deposit mode first.** A player funding from a centralised
exchange leaves the tab, goes to a withdrawal screen, and comes back minutes
later — possibly on another device — expecting to find the deposit still in
progress. That is the normal path, not an edge case, and it shapes the room.

**Must not:** import `@strkworld/privacy` (CI enforces it). Offer an OUT
direction, a token picker or a route choice. Imply that arriving is private.

**The honesty constraint defines this lane.** The solver delivers STRK publicly
and the shield that follows has its own public leg. Privacy begins after the
funds are in the pool. Copy must say so.

**Done when:** a player manually deposits from another chain to the bound active
account, recovers the signed record across reload/import, sees honest copy about
the public 0.2%-fee route, and explicitly shields the freshly planned remainder.
Malformed status, account mismatch or unavailable cost planning must fail
closed. The JWT must never enter the browser bundle.

**Reference:** `packages/bridge/README.md` · DECISIONS.md D-009, D-012, D-043

---

### Lane: Art

**Owns** assets. Lowest coupling of any lane — can run entirely in parallel and
mostly hands over files.

**D-044 placeholder import complete:** Kenney Urban CC0 at clean 2× is acquired,
credited and sliced at runtime for road, pavement, wall, facade and door roles.
Grass remains procedural and no Kenney frame is claimed as roof treatment. The
final visual direction, external-pack versus bespoke choice and station states
remain user-gated; a closer CC0 16-bit/JRPG-like base may still be compared
before any final art lock. Record the licence for **every** additional pack in
`assets/CREDITS.md` as it lands.

**D-047 sprite review package only:** commit `e5eaea9` records the generated
review sheets and manifest under `packages/world/assets/player-sprites/v1-review/`.
Those PNGs are explicitly `review-art-not-runtime-ready`: their backgrounds
are baked rather than transparent, and they still need exact 32×32 extraction,
manual frame-by-frame anchor/feet validation and the user's art approval. Do
not wire them into runtime textures or call them accepted final art.

**Licence audit is the real work here.** Popular "free" packs are frequently
non-commercial only, and this is a public project handling real funds. Audit
per pack, not per tag. A pack that cannot be cleared gets dropped, not
grandfathered.

**Then:** five building facades (four active plus the locked Vault) themed to
their protocols, the eight-character/two-state sprite handoff from the
separate studio, and the Aseprite → embedded-tileset export pipeline. D-033
keeps the first Bank room procedural; final room/station art starts only after
World freezes its 32 px footprints and asset names. Avatar Studio figures must
preserve a stable 32 px runtime footprint and anchor; their final style and
state-to-key art manifest remain subject to the user's approval, while the
sixteen-key wire seam is fixed by D-047.

**Frozen first-room asset contract (D-033 tracer):** the procedural Bank is an
18×12 grid of 32 px tiles (576×384 px), with a one-tile perimeter, spawn at
tile `(9, 9)`, a walkable two-tile exit at `x=8..9, y=11`, and the solid
`bank:shielding` station at `x=8..9, y=3` (64×32 px). A future art handoff
therefore needs seamless floor, perimeter wall, walkable exit, and station
assets. The station needs available, locked and highlighted presentation
states, either as separate art or a deterministic code treatment; that choice
is not made yet. Keep `SHIELD / UNSHIELD` as live text rather than baking it
into pixels, and do not encode route, wallet or authorization meaning in art.

The acquired Kenney files and runtime atlas mappings have an
`assets/CREDITS.md` record naming their source, creator, licence and licence
URL, required attribution, modification/redistribution terms, verification
date, and third-party status. Every additional landed file or atlas frame must
meet the same record. Final palette, final external pack versus bespoke work,
atlas format and station-state treatment remain open and require the user's
review before final art writes.

**Done when:** the world renders as a coherent place, every asset has a
recorded licence cleared for commercial use, and exported maps load in Phaser
without warnings.

---

## Keeping lanes from colliding

**One package per lane.** Enforced by `scripts/check-invariants.sh` in CI —
`starknet` outside `packages/privacy` fails the build, as does a financial
identifier in lobby code.

**Branch per lane, small PRs.** `chain/…`, `world/…`, `shell/…`, `art/…`.
Long-lived lane branches accumulate conflicts; merge often.

**The project-lead task orchestrates; workers execute.** Product direction,
cross-lane seam choices, adversarial review and final integration stay in the
project-lead task. Lane workers receive bounded package-owned briefs and use a
lower-cost model by default; reserve the highest-cost reasoning model for lead
decisions or a worker escalation that genuinely needs it. A worker does not
quietly turn an implementation detail into product direction — it reports the
choice and the lead records it in `DECISIONS.md` before dependent work starts.
Whenever a key choice is not already settled, or the worker is undecided about
what to execute, it stops **before writing** and pings the orchestration task at
`codex://threads/01a014f6-ede0-7681-818d-5428e71cfb6f`. It resumes only after
the lead has presented the options, consequences and recommendation to the
user in that task, the user has answered, and the resulting direction is
recorded in the repository. The lead does not silently make product or
cross-lane decisions on the user's behalf.

**Keep the current world live while orchestrating.** While the project-lead
task is active, serve the current working tree at `http://localhost:5173/`.
After an integrated World or Shell change, give the user a concise visual and
interactive test script against that URL and wait for their result. Do not
automate Chrome or the in-app browser unless the user explicitly requests it;
browser automation has proved slow and unreliable for game testing. Agents
still own headless, unit, integration, type, build and invariant checks. The
live preview is a collaboration surface, not acceptance evidence by itself.

**`packages/shared` is frozen.** A change there needs a decision entry, because
it breaks three lanes simultaneously.

**Findings go in `AGENTS.md`.** When a lane learns something — a wallet
behaviour, a version trap, a Phaser quirk — it goes in the findings log with
how it was verified. That log is how lanes teach each other without meetings.

**Phase 0 results are broadcast.** The spike's four answers change design in
Shell and World, not just Chain. Write them up the day they land.
