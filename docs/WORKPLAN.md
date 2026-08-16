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
| **Chain** | `packages/privacy` | Active |
| **World** | `packages/world` + `packages/lobby` | Active |
| **Shell** | `apps/web` | Active, starts week 2 |
| **Backend** | `apps/backend` | Active; offline implementation in progress under D-028 |
| **Bridge** | `packages/bridge` | Active, fully independent |
| **Art** | `packages/world/assets` | Active, low coupling |
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

1. **`PrivacyOperations`** — provisional after D-015. D-028 removes the funded
   wallet run as a development gate: freeze it from the completed shipped-code
   audit and D-018 route-admission shape when the Chain lane records that
   decision. Funded behavior remains a pre-launch validation.
2. **`WorldEvents` / `ShellEvents`** — the event bus contract, in
   `packages/shared/src/index.ts`. **Frozen.**
3. **`PresenceState`** — the lobby room schema, in the same file. **Frozen.**
   It is the enforcement point for "the lobby never sees money": a field that
   is not in the type cannot leak.

`WorldEvents` and `PresenceState` are locked. The financial seam is deliberately
still source-derived and provisional (D-015/D-028); dependent lanes use it
behind adapters until the Chain lane records an explicit freeze decision. The
funded wallet run validates the result before launch but does not gate that
decision or current development.

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

**Then:** implement `WalletApiPrivacyOperations` against the provisional seam.
Wallet connection via `get-starknet-discovery` (never the static wallet list),
capability detection by version query only, action-array construction with the
open-note invariant, recipient preflight via the pool's `get_public_key`, and
the full error taxonomy mapped to `PrivacyErrorKind`. Add a route registry that
maps each typed intent to a pool-native action, AVNU's private executor or an
audited anonymizer deployment.

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

**First task:** a walkable street. Phaser 4 scene, player sprite with walking
animation, collision, camera follow, and four building entrances emitting
`building:entered`. No chain, no wallet, no money — this lane must run
correctly with nothing connected.

**Then:** tilemaps for the first district, the Colyseus room with the ephemeral
`gameId` lifecycle, position throttling and interest management.

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

**First task:** the event bus. React owns wallet and financial
state; Phaser receives plain data via an event emitter and never reads back.

**Then:** building panels, the connect flow with capability detection, the
`NOT_REGISTERED` and unsupported-wallet rooms as designed screens rather than
error toasts, and the typed adapters from each panel to the financial seam.

The **batch accumulator** collects typed intent during a building visit and
emits one atomic batch on confirmation. It never accepts raw protocol calldata.

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

**First task:** expose the minimum endpoints needed by `packages/privacy`, with
strict request schemas, fee ceilings, per-route allowlists, rate limits,
aggregate-only metrics and global plus per-route kill switches.

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

**First task:** port the 1Click wrapper and the resumable pipeline from
`shieldup`'s `src/bridge/` — `one-click.ts`, `persistence.ts`,
`source-tokens.ts`, `address-validation.ts`. Drop the OUT paths and the AVNU
leg; neither survives the narrowed scope (D-012). Port behaviour, not the
lockfile.

**Build manual deposit mode first.** A player funding from a centralised
exchange leaves the tab, goes to a withdrawal screen, and comes back minutes
later — possibly on another device — expecting to find the deposit still in
progress. That is the normal path, not an edge case, and it shapes the room.

**Must not:** import `@strkworld/privacy` (CI enforces it). Offer an OUT
direction, a token picker or a route choice. Imply that arriving is private.

**The honesty constraint defines this lane.** The solver delivers STRK publicly
and the shield that follows has its own public leg. Privacy begins after the
funds are in the pool. Copy must say so.

**Done when:** a player deposits from another chain, ends up with a shielded
balance, sees honest copy about what was public, and the flow survives a reload
mid-deposit. Before launch, the lead must also choose and verify either the
disclosed unauthenticated 1Click fee or a narrow server-side JWT proxy; the JWT
must never enter the browser bundle.

**Reference:** `packages/bridge/README.md` · DECISIONS.md D-009, D-012

---

### Lane: Art

**Owns** assets. Lowest coupling of any lane — can run entirely in parallel and
mostly hands over files.

**First task:** source a CC0 or permissively licensed top-down city base —
roads, grass, pavement, basic structures. Record the licence for **every** pack
in `assets/CREDITS.md` as it lands.

**Licence audit is the real work here.** Popular "free" packs are frequently
non-commercial only, and this is a public project handling real funds. Audit
per pack, not per tag. A pack that cannot be cleared gets dropped, not
grandfathered.

**Then:** four building facades themed to their protocols, a player sprite
sheet with four-direction walking, and the Aseprite → embedded-tileset export
pipeline.

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

**`packages/shared` is frozen.** A change there needs a decision entry, because
it breaks three lanes simultaneously.

**Findings go in `AGENTS.md`.** When a lane learns something — a wallet
behaviour, a version trap, a Phaser quirk — it goes in the findings log with
how it was verified. That log is how lanes teach each other without meetings.

**Phase 0 results are broadcast.** The spike's four answers change design in
Shell and World, not just Chain. Write them up the day they land.
