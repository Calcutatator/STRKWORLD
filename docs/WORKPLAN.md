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
| **Chain** | `packages/privacy` | Active; private seam and D-054 production WalletSession complete, D-043 planner port/fake complete, production Bridge planner and funded wallet validation remain open |
| **World** | `packages/world` + `packages/lobby` | Active; four fixed rooms, multiplayer, Avatar Studio, D-052 five-column runtime and D-053 global F toggle are headlessly complete; D-057 has accepted every room's rendered navigation/physical exit, the exact Bank two-client matrix, the complete rendered functional/interactive D-053 matrix, and Bank/Post Office/Exchange station integration; Bridge station integration and subjective visuals stay open |
| **Shell** | `apps/web` | Active; production wallet gate, transfer/shield policy parsing and all v1 room surfaces are complete; D-057 has accepted rendered Bank/Post Office/Exchange station integration, while the production Bridge planner/station, live routes and funded validation remain open |
| **Backend** | `apps/backend` | Active; bounded APIs, same-origin local proxy, D-050 and hosted image smokes complete; host, domain, secrets, Alchemy controls, live staging and funded checks remain |
| **Bridge** | `packages/bridge` | Active; offline manual/recovery flow complete, production planner and funded-provider acceptance open |
| **Art** | `packages/world/assets` | D-052 final source/runtime corrections are merged through PR #33 and mechanically reviewed; rendered in-game visual acceptance remains |
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

The schedule below is the historical dependency plan, not current status; the
table and lane briefs above/below own the current frontiers.

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

**D-054/D-056/D-057 current wallet boundary:** the privacy-owned production
`WalletSession`, dynamic explicit Wallet Standard selection, account/network
generations and stable operations facade are implemented. Web's public config
defaults every route to deny-all, can parse an explicit transfer tuple, and may
enable only D-056's three-variable canonical-STRK shield exception; neither
implementation is funded acceptance. D-057's independent sibling gateway has
passed a mock Bank shield through the production public seams with no key, RPC,
proof, signature, submission or funds. Ready/Xverse behavior and every live
receipt remain separate gates.

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
widening the frozen shared event bus. A D-057 run first accepted the partial
Post Office two-client matrix: both players saw each other and bidirectional
movement, then one disappeared on Post Office entry and reappeared at the
restored Post Office street placement after exit. It then accepted D-038's
exact Bank matrix: B visibly rendered A at the Bank doorway, A disappeared from
B on Bank entry, and A reappeared in B at the restored Bank doorway after Leave
building. With the earlier reciprocal movement result, D-038's rendered
functional gate is complete.

The D-039 implementation is complete and headlessly verified. The accepted
Bank behavior now runs through one validated, data-driven fixed-room core, and
the Post Office is the second room with one opaque
`post-office:transfer` station. Bank geometry and behavior remain unchanged;
the shared buses and privacy seam remain frozen. Its remaining functional
acceptance is complete: the rendered D-057 mock run physically entered and
exited both rooms, and each gold/highlighted station automatically opened only
its admitted surface (**The Bank** and **Private transfer**).

**D-042 complete offline:** the Exchange is the third definition in the same
fixed-room core, with one opaque `exchange:swap` station. No new scene, shared
event, lobby field or financial meaning entered World. Headless tests pin its
geometry, station presentation and boot-order snapshot. Its rendered room and
station integration is accepted: the D-057 mock run physically entered and
exited Exchange, and approaching the gold/highlighted station automatically
opened **The Exchange** panel.

**D-043 complete offline:** the Bridge is another definition of the same
fixed-room core with one opaque `bridge:deposit` station. World owns geometry,
highlight, activation, exit and teardown only; it gained no recipient, quote,
deposit address, status or wallet concept. Rendered Bridge navigation and its
physical floor exit are accepted. Its station integration remains open/locked:
repeated physical approach showed the **DEPOSIT** label but no highlight,
activation or panel, consistent with Shell requiring the still-missing
production public-shield planner before admitting `bridge:deposit`. World
renders the locked snapshot grey with its label and activates only available
stations; independently opening Menu Mode does not change that admission.

**D-047 foundation, D-048 portal and D-052 art/runtime integration complete;
rendered gate remains:** the hidden south path and bottom-edge
street trigger enter a non-financial 18×12 Avatar Studio outside
`BuildingId`/`BUILDINGS`, with no facade, public label or `VisitLayer` route.
The centered 2×1 top-wall portal spawns immediately inside and exits by
walking back upward through the same opening, preserving the existing
restored-street-placement-before-exit-event ordering. Eight collision
selectors choose the cosy/default states. The three dedicated `WorldEvents`
are the only event-bus extension, and World, lobby and Fly share the existing
single `sprite` field across `avatar-1..16`; there is no stance field or
message. Shell retains the selected allowlisted key for the page runtime,
replaces an in-flight client that captured an older sprite, defers that
replacement while inside and deduplicates reconnect intent. Exit publishes
the restored street placement before `avatar-studio:exited` resumes presence.
Reload, tab close or a new session still resets to `avatar-1`.

The D-049 final-avatar resolver now drives local players, remote peers and
Studio selectors in headless World coverage. The earlier browser recording
failed to establish rendered acceptance, so it is not a pass. D-052
originally authorized F only inside Avatar Studio; D-053 supersedes that scope
with one lifecycle-owned one-press, no-repeat cosy/fighting toggle outdoors and
in existing interiors through the same opaque `avatar:selected` key. It adds no
stance or wire field. Gait correction `8e92cfa`, character 5/13 cross-facing
correction `0051fce`, and five-column runtime commit `5c8c81a` are
independently reviewed and headlessly complete. A later localhost review
verified the complete pair outdoors, inside the Post Office and inside Avatar
Studio: one `F` press changed cosy to fighting with the weapon visible, and a
second returned fighting to cosy. The Studio check crossed the hidden south
portal and rendered its figures; its top exit then restored the street spawn,
`Multiplayer connected` status and the other rendered client. The complete
pair also passed inside Bank, Exchange and Bridge. Both directions are therefore
rendered and verified outdoors, in Avatar Studio and in all four fixed rooms;
the positive outfit-pair location matrix is complete. D-053's Studio checks
while standing on a figure also passed: both transitions worked while the local
avatar visibly overlapped the central green figure. Its generic station-panel
suppression gate passed in Bridge: the visibly cosy avatar remained cosy
without a weapon after `F` was pressed while the Menu Mode station panel owned
input and was then closed. D-053's rendered functional/interactive matrix is
complete. Subjective visual quality remains open.

**D-053 global F toggle — rendered functional/interactive matrix complete;
subjective art stays open.** Branch
`codex/global-outfit-toggle` (PR #19) moves
keyboard ownership out of Avatar Studio activation into one StreetScene
lifecycle owner: `createAvatarOutfitSelection` is the Scene-wide source of
truth injected into the Studio controller, and `createAvatarOutfitToggleBinding`
owns a single `keydown-F` listener gated per press on `InputGate.suspended`.
The existing `pairedAvatarSprite` resolver and `avatar:selected` event are
preserved; the toggle is proven outdoors, in Avatar Studio and in each existing
fixed-room interior, along with repeat/editable/suspended/stale-handler guards
and transition/restart single-ownership through the real `create()` order.
Shared, lobby, Fly and financial seams are unchanged. **The rendered
cosy-to-fighting and fighting-to-cosy pair has been verified outdoors and in
Avatar Studio and all four fixed rooms: Bank, Post Office, Exchange and Bridge.
The positive location matrix and generic station-panel suppression are
accepted, as are both transitions while overlapping the central Studio figure.
The functional/interactive matrix is complete; subjective final-art quality is
not.**

D-057 now supplies an extension-free, mock-only production-seam gateway for
repeatable agent-run functional checks. The accepted rendered evidence covers
wallet admission, World/lobby mount, the Bank, one deliberate balance read, a
fixed mock shield receipt and multiplayer restoration after Bank exit. The
same live gateway later verified the complete outfit pair outdoors and inside
Avatar Studio and all four fixed rooms, plus the two-client
movement/disappear/reappear lifecycle through Post Office and Bank entry/exit.
These checks also verified that Studio's top exit restored the street spawn,
connected multiplayer status and the other rendered client. D-038's exact Bank
matrix and the positive outfit-pair location matrix are accepted. D-053's
generic station-panel keyboard control is also accepted from the Bridge panel
check, and both transitions while overlapping the central Studio figure are
accepted. D-053's rendered functional/interactive matrix is complete. Every
fixed-room navigation/exit path is now accepted, as are the Bank, Post Office
and Exchange station integrations: each admitted station highlighted and
opened its correct panel, panel-owned `F` was suppressed, and closing returned
to the unchanged cosy avatar. Bridge navigation/exit is accepted, but its
`bridge:deposit` station remains open/locked with only the **DEPOSIT** label
visible because the production planner capability is still absent. Subjective
final-art acceptance remains open. These checks prove no live-wallet or funded
behavior.

James has delegated the intermediate D-052 art gates to orchestration. The Art
lane should continue through internal identity, edge, movement, source/export
and independent-review gates without returning each scaffold or contact sheet
for user approval. Orchestration owns rejection and rework until the corrected
assets and five-column runtime are integrated. The next user-facing checkpoint
is one completed in-game review; final rendered acceptance remains user-owned.

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
truthful solo fallback. D-055 now puts a production wallet-entry gate above
that composition: before a connected mainnet account passes the STRK20
capability check, `App`, Phaser, presence and building panels do not mount.
React owns wallet and financial state; Phaser receives presentation data and
never reads back.

**Current frontier:** D-055's production gate is headlessly complete: explicit
wallet selection is required, the connected tree owns a fresh presence
controller, and account loss, disconnect or wrong-network state tears it down
and returns to the gate. D-019/D-037 behavior remains in force once admitted.
The retained source clears on drop/replacement/destroy and suppresses
pre-welcome self snapshots until the server-minted ID permits filtering.
D-038's exact two-browser Bank matrix is now rendered and accepted as described
in the World lane. Do not widen `ShellEvents`, expose the LobbyClient to Phaser,
or change the completed D-033–D-036 Game Mode, uncertainty and financial-seam
behavior.

D-054/D-055 production composition is live in source, PR #59 implements the
disabled-by-default transfer tuple, and D-056/PR #65 implements the independent
disabled-by-default canonical-STRK shield tuple. D-057 then passed the wallet
gate, World/lobby mount and one complete mock Bank shield without an extension
or popup. That is the only rendered production-seam financial flow accepted so
far; it is mock-only and does not accept a live wallet, real receipt or funds.

D-039 is complete and headlessly verified: the opaque Post Office station is
admitted and the existing financial machine is configured for one transfer
mode and one intent. Game Mode reuses recipient preflight, route admission,
`ConfirmGate`, receipts and uncertainty handling. D-040 completes Post Office
Menu Mode with the same transfer-only machine and Menu Mode's compatible
multi-transfer batching. Rendered room/station integration is accepted in the
World lane; live-wallet and funded transfer behavior remain separate open
gates.

**D-042 complete offline:** the dedicated Exchange machine and panel use the
checked-in six-asset display catalog in both Menu and Game Mode, one swap at a
time. The player explicitly requests balances; the prepared review carries the
canonical D-024 disclosure, expected and protected outputs, slippage, absolute
expiry and exact fees at `ConfirmGate`; receipts are owned by `exchange` and
outlive the room. Catalog metadata is never route authority. Rendered
room/station integration is accepted in the D-057 mock run; live-wallet and
funded Exchange behavior remain open.

**D-043 complete offline:** the manual-only Bridge machine and room retain the
concrete connected account beside the privacy seam, bind every new quote to its
address, keep the signed Bridge record in browser-local Bridge storage, and
retain BridgeStore evidence for later recovery, but production access to the
Bridge UI is behind D-055's wallet gate; only explicit demo/test compositions
may inspect it without a wallet. New quotes require both a matching
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
backend frontier is operational: an approved aggregate-only signal, host,
domain and secret controls, Alchemy account/key and provider-control
verification, live staging checks, and the funded Wallet API/paymaster checks
retained by D-028. Do not invent a health or metrics route without the D-014
privacy review recorded in `docs/OPS.md`.

**D-045/D-046 deployment direction:** target one Fly.io app/Machine with a
same-origin edge/composition process for the web build, `/api` and lobby
WebSocket. Use Alchemy provisionally with separate browser/public and
server/private applications or keys. Account creation, domain setup, secret
procurement, provider controls and production deployment remain gated
operational work; no credentials are present.

**D-050 complete:** commit `375bad4` retains the live
`RunningBackendServer`, coalesces `SIGTERM`/`SIGINT` into one close, exits `0`
after success and nonzero after close failure. GitHub Actions run
[`32282522737`](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737)
passed both deployment typechecks, builds and network-none image smokes,
including the standalone Backend's TCP readiness and bounded clean exit. This
closes image lifecycle only; host/provider/funded gates above remain.

**D-051 complete:** commit `d6f2bad` adds the internal Node-only
`packages/lobby/src/production-origin.ts` classifier and routes both
`packages/lobby/src/production.ts` and `deploy/fly/src/main.ts` through it.
The helper stays out of the browser/root lobby export and `packages/shared`;
each caller retains canonical whole-origin parsing. Lobby and Fly tests pin the
same loopback/localhost/`.invalid`/placeholder rejection matrix, including
dotted and hexadecimal IPv4-mapped IPv6 loopback, plus legitimate
substring-domain cases. This changes no CORS, schema, presence, financial or
logging behavior and closes the implementation brief; deployment, TLS,
provider and funded-route gates remain open.

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
are baked rather than transparent. D-049 supersedes the provisional 32×32
target: the final handoff is sixteen transparent 192×256 sheets, one per
`avatar-1..16`, each a 3-column × 4-row grid of 64×64 cells with fixed feet at
`(32, 56)`. It also includes one tagged editable Aseprite source and no
mega-atlas. Smaller art stays padded and characters 4 and 7 may use more of the
same canvas. Source frames contain no baked shadow pixels; World may add one
consistent shadow separately. At that review stage the final target still
needed frame-by-frame anchor validation and the user's final-art approval. Do
not wire the review PNGs into runtime textures or call them accepted final art.
Those historical requirements apply to `v1-review/`, not the completed `v1/`
handoff described below.

**D-049 final-art gate complete; World integration ready:** The complete v1
handoff is committed at `86e8f5f`; independent QA verified its mechanical and
source contracts, and James visually approved the committed assets for runtime
integration. The 64×64 canvas, `(32, 56)` feet, authoritative 24×24
gameplay/contact body, per-key 192×256 sheet topology, no mega-atlas and
no-baked-shadow policy remain fixed. The art-owned final destination is exactly
`packages/world/assets/player-sprites/v1/`: root-level `avatar-1.png` through
`avatar-16.png`, `manifest.json` and `README.md`, plus
`source/player-sprites.aseprite` and mechanical evidence under `qa/`. Preserve
`v1-review/` as the existing provenance package; do not overwrite it. World
must integrate the final `v1/` sheets, never the baked review sheets or
intermediate prototypes. This approval is not a claim that integration exists
or that the sprites have passed in-game rendered acceptance.

The implementation slice is World-local. The D-049 semantic avatar-visual
resolver is now wired to local players, remote peers and Studio selectors in
headless coverage, keyed only by the existing allowlisted
`avatar-1..avatar-16` values. It preserves the 64×64 logical canvas, `(32, 56)`
feet origin and authoritative 24×24 local and Studio bodies. The browser
recording failed to establish rendered acceptance. D-052 supersedes only the
movement geometry and toggle status: replacement sheets are 320×256 with five
columns per facing and 320 total Aseprite frames. D-053 supersedes the
Studio-only toggle scope: one World-lifecycle binding toggles the existing
opaque cosy/fighting pair outdoors and in the existing interiors without new
lobby/wire fields, shared types, Fly allowlists or financial seams. That toggle
is headlessly implemented and verified. Its rendered functional/interactive
matrix was accepted on 2026-08-28; only subjective final-art review remains
open.

Intermediate D-052 art approval is orchestration-owned: do not block the lane
on user review of model sheets, contacts or QA artifacts. Present the user only
with the completed, independently reviewed, runtime-integrated correction for
the required final localhost acceptance.

**Licence audit is the real work here.** Popular "free" packs are frequently
non-commercial only, and this is a public project handling real funds. Audit
per pack, not per tag. A pack that cannot be cleared gets dropped, not
grandfathered.

**Then:** five building facades (four active plus the locked Vault) themed to
their protocols, the eight-character/two-state sprite handoff from the
separate studio, and the Aseprite → embedded-tileset export pipeline. D-033
keeps the first Bank room procedural; final room/station art starts only after
World freezes its footprints and asset names. Avatar visuals retain D-049's
fixed 64×64 logical canvas and `(32, 56)` feet while the authoritative local
body and Studio contact footprint remain 24×24. D-052 replaces the movement
handoff with 320×256 sheets, five columns per facing and 320 total Aseprite
frames; vertical rows preserve hip/depth continuity, side rows move along x,
each cycle keeps a planted baseline foot and no new bright edge contamination.
Reject accidental transparent pinholes or narrow channels through the expected
body, pelvis, limbs, clothing, hair and weapon joins even when the remaining
pixels form one connected component; only reviewed, anatomically readable
negative space is allowed. The final source remains one sheet per opaque key
rather than a mega-atlas, and source pixels contain no shadow. D-053 replaces
the Studio-only F scope with a World-wide one-press, no-repeat toggle through
the existing opaque key; it is headlessly implemented and verified, and its
rendered functional/interactive matrix was accepted on 2026-08-28. Background
and subjective final-art review remain open.

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
interactive test script against that URL and wait for their result unless they
have explicitly authorized browser automation. Under that authorization,
D-057's extension-free sibling gateway at `http://127.0.0.1:5173/` may drive
repeatable agent-run mock functional checks through the production public seams.
It never substitutes for Ready/Xverse prompts, funded/onchain evidence or the
user's subjective visual approval. Agents still own headless, unit, integration,
type, build and invariant checks. The live preview is a collaboration surface,
not acceptance evidence by itself.

**`packages/shared` is frozen.** A change there needs a decision entry, because
it breaks three lanes simultaneously.

**Findings go in `AGENTS.md`.** When a lane learns something — a wallet
behaviour, a version trap, a Phaser quirk — it goes in the findings log with
how it was verified. That log is how lanes teach each other without meetings.

**Phase 0 results are broadcast.** The spike's four answers change design in
Shell and World, not just Chain. Write them up the day they land.
