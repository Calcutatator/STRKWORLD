# Architecture

How STRKWORLD is put together, and what must never cross a boundary.

---

## The shape

Four concerns that barely talk to each other, composed by a thin shell.

```
┌─────────────────────────────────────────────────────────────────────┐
│  apps/web — the shell                                                │
│  routing · layout · event bus · providers · bridge→shield sequencing │
└───────┬───────────────┬───────────────┬───────────────┬─────────────┘
        │               │               │               │
┌───────▼───────┐ ┌─────▼─────────┐ ┌───▼───────────┐ ┌─▼─────────────┐
│ packages/     │ │ packages/     │ │ packages/     │ │ packages/     │
│ privacy       │ │ bridge        │ │ world         │ │ lobby         │
│               │ │               │ │               │ │               │
│ Starknet.     │ │ 1Click.       │ │ Phaser.       │ │ Colyseus.     │
│ Money.        │ │ Public        │ │ Movement.     │ │ Positions.    │
│ Wallet.       │ │ funding.      │ │ Tilemaps.     │ │ Ephemeral IDs.│
│               │ │               │ │               │ │               │
│ Knows nothing │ │ Knows nothing │ │ Knows nothing │ │ Knows nothing │
│ about the game│ │ about the pool│ │ about money   │ │ about anything│
└────────┬──────┘ └───────────────┘ └───────────────┘ └───────────────┘
         │
    ┌────▼─────┐
    │  Wallet  │  holds viewing key · discovers notes
    │          │  generates proof · submits to Starknet
    └──────────┘
```

The wallet is outside our trust boundary in the useful sense: we never hold
key material, so we cannot lose it.

---

## Data flow

### Reading a balance

```
React (useStrk20Balances)
  → walletV6.strk20Balances([])
  → wallet resolves from its own note discovery
  → React state
  → event emitter → Phaser HUD
```

Phaser never calls Starknet. It receives values it can render.

### Performing a shielded action

```
Player enters building
  → Phaser emits `building:entered`
  → shell suspends lobby presence
  → React opens the building panel
  → player confirms a typed, capability-bounded intent
  → packages/privacy admits one approved route
      ├─ pool-native Wallet API action         (Bank, Post Office)
      ├─ first-party private executor         (AVNU Exchange)
      └─ audited app-specific anonymizer      (Vault)
  → wallet prompts and proves
  → route submits; backend queues only eligible prepared calls
  → receipt → React state → HUD
```

The building is an interface, not a transaction composer. The shell never
accepts a target, selector or calldata blob from the player. `packages/privacy`
owns exact contract and token allowlists, quote/slippage/expiry checks, action
limits, fee ceilings and route kill switches. If an approved private route is
unavailable, the building is locked; there is no unshield-and-call or public
frontend fallback (D-018).

Route admission is also graded (D-020): **absolute privacy is the default**,
and any route below `private` is a deviation needing the project lead's
recorded approval *plus* player-facing disclosure, both stored in
`packages/shared/src/privacy-grades.ts`. An unapproved or undisclosed
deviation renders a locked door — CI check 8 enforces this rather than
trusting anyone to remember. A route that leaves player-held value sitting in
public (`bridge.deposit`) must offer the next step back into the pool — the
`returnToPool` property on the register entry (D-021). AVNU's private swap is
the D-023 exception because its bought asset lands directly in an OPEN pool
note.

A custom anonymizer atomically receives pool input, calls the external
protocol and returns the output to a pool note. It keeps the player's wallet
address out of the protocol action, but the application, action, timing and
open-note amount may remain public. AVNU already supplies its own private
executor, so the Exchange does not need project-owned Cairo.

The backend submission queue can add bounded jitter only when STRKWORLD
controls the prepare/submit path. It never delays quote-bound AVNU actions, and
it must not be presented as defeating timing correlation (D-015).

### Multiplayer presence

```
Phaser position tick
  → WorldEvents.player:moved → Shell presence controller
  → throttled → lobby client
  → Colyseus room broadcasts { gameId, x, y, sprite }
  → other clients → Shell adapter
  → replaying RemotePeerSource → Phaser
```

`gameId` is ephemeral and per-session. It is minted by the trusted lobby
server, never derived from an address, and discarded on disconnect. Entering a
building leaves or suspends presence, so other clients see the avatar
disappear. The lobby receives no building ID or entry event. Building-choice
and visit-timing inference from that disappearance is an accepted v1 trade-off
(D-019).

The D-047 Avatar Studio foundation is implemented and user-rendered-accepted
on localhost as a hidden, non-financial 18×12 room outside `BuildingId` and
`BUILDINGS`. The south path still ends at a bottom-edge trigger with no facade
or public label. D-048 changes the interior to one centered 2×1 opening in the
top wall: entry spawns immediately below it so southward travel continues into
the room, and walking back up through it exits. Eight collision selectors
choose cosy/default character states.
Its dedicated
`avatar-studio:entered`, `avatar-studio:exited` and `avatar:selected` events
are ignored by `VisitLayer`. The existing single lobby `sprite` field now
allowlists sixteen opaque keys (`avatar-1..8` cosy/default,
`avatar-9..16` paired fighting states); no stance field or message exists.
Selection is page/runtime-only, defaults/falls back to `avatar-1`, resumes with
street presence and has no wallet, account, protocol or financial meaning.

On room exit, World publishes the restored street placement before emitting
`avatar-studio:exited`, so Shell resumes or replaces presence from real
coordinates. A selection made during an in-flight join invalidates that
client's captured sprite: Shell replaces it once, defers replacement while
inside and deduplicates reconnect requests. The presentation lifecycle is one
adapter used by both `StreetScene` and its deterministic teardown tests. The
F is authorized only inside Avatar Studio as a one-press, no-repeat toggle for
the current editable target's cosy/fighting pair through the existing opaque
`avatar:selected` key; no stance or wire field exists. Commit
`e5eaea9` contains review PNGs only. D-049 replaces their provisional 32×32
target with one transparent 64×64 logical canvas for every opaque state, fixed
feet at `(32, 56)` and the unchanged authoritative 24×24 gameplay/contact body.
Smaller characters use transparent padding, while characters 4 and 7 may use
more of the same canvas. Variable per-key canvases and layered weapons are not
part of the initial runtime. Commit `86e8f5f` contains the complete sixteen-key
`v1/` handoff and QA evidence; independent QA verified it, and James visually
approved those committed assets for runtime integration. World-local sprite
wiring now routes local players, remote peers and Studio selectors through one
semantic resolver in headless coverage, without changing any lobby/wire field,
shared type or Fly allowlist. The browser recording failed to establish
rendered acceptance. D-052 supersedes D-049's three-column movement geometry:
the replacement sheets are 320×256 with five columns per facing and 320 total
Aseprite frames, while the 64×64 cell, `(32, 56)` feet, 24×24 bodies and
no-baked-shadow rule remain. Vertical rows preserve hip/depth continuity and
side rows move along x; each cycle keeps a planted baseline foot and introduces
no new white or bright edge contamination. F is authorized only inside Avatar
Studio as a one-press, no-repeat cosy/fighting toggle through the existing
opaque `avatar:selected` key; no stance or wire field exists. Background and a
fresh user-run in-game review remain required; the failed recording is not a
pass.

---

## Boundaries

### `packages/privacy`

The only package that imports `starknet`. Exposes one interface so the rest
of the app never depends on how privacy is achieved:

```ts
interface PrivacyOperations {
  capability(signal?: AbortSignal): Promise<WalletCapability>
  poolConfig(signal?: AbortSignal): Promise<PoolConfig>
  balances(tokens?: Address[], signal?: AbortSignal): Promise<PrivateBalance[]>
  recipientStatus(address: Address, signal?: AbortSignal): Promise<RecipientStatus>
  prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch>
}
```

The interface is **source-derived and frozen under D-036**; changing it needs
a decision entry and a heads-up to dependent lanes, never a quiet edit.
`WalletApiPrivacyOperations` is the implemented pool-native adapter and
`FakePrivacyOperations` — same interface, fault injection, no chain — drives
deterministic offline work. The funded Wallet API/paymaster run remains a
pre-launch validation, not a development gate. The seam also owns first-party
and anonymizer-backed route adapters. Callers can request only typed intents;
they cannot supply arbitrary protocol calls.

**Must not:** import from `world` or `lobby`, contain UI, or branch on wallet
identity.

### `packages/bridge`

One-way funding: any asset on any chain → STRK on Starknet, then an optional,
explicit Bank shield when exact public-cost planning is available (D-012/D-043).
NEAR Intents 1Click
orchestration, resumable across reloads and devices. Since D-012 removed the
OUT direction it is chain-free on the Starknet side — 1Click + viem only, no
`starknet` import. The shell owns the bridge → shield sequencing, because this
package must never import `packages/privacy` (D-009, CI-enforced). D-043 keeps
the signed `BridgeRecord` as browser-local bridge evidence and binds its
recipient to the concrete connected Wallet API account retained by the
composition root; neither identity nor Bridge state is added to the frozen
private seam.

The post-settlement reserve is supplied through a separate optional Chain-owned
public-shield planning capability. It owns wallet-specific estimation of the
precise public call shape and fails closed when unsupported; the result is a
fresh plan, not a guaranteed fee, and it is not a method on
`PrivacyOperations`. Shell preflights against the signed minimum before showing
deposit instructions, replans from the actual settled amount, and revalidates
at the Bank commit point. The shield remains an explicit second transaction
with its own Bank-owned receipt, never an automatic Bridge action.

No production Ready planner exists today: the visible Ready route does not
prove the fee allowance consumed separately by the pool. Production therefore
locks new quotes, deposit instructions and the Bridge-to-Bank handoff. The
offline demo supplies only a deterministic fake. Saved/imported signed evidence
remains inspectable, refreshable and exportable without a wallet or planner,
and no Bridge-to-shield correlation is stored.

**Must not:** import `@strkworld/privacy`, offer an OUT direction or a
destination-token choice, or present arrival as private — bridging is a
funding feature, and its copy must say the arrival leg is public.

### `packages/world`

Phaser scenes, tilemaps, collision, sprites, camera, input. Emits semantic
events (`building:entered`, `player:moved`) and consumes plain data.

**Must not:** import `starknet` or any wallet package. If Phaser code needs
to know a balance, it is being asked to do the wrong job.

Tilemaps: **embed tilesets on export.** Phaser rejects external `.tsx` — see
the findings log.

### `packages/lobby`

Colyseus room broadcasting positions. This package is where a privacy failure
would be quietest, so it is deliberately the dumbest thing in the repo.

**Must not:** receive, store, log or broadcast an address, balance,
transaction hash, building name, building-entry event, or any financial
action. It may know a street player is at a coordinate. On building entry the
client removes that player from presence (D-019).

Server state schema is the enforcement point — if a field cannot be added to
the schema, it cannot leak.

### `packages/shared`

Types and constants used across boundaries. No logic, no dependencies.

### `apps/web`

Providers, routing, layout, the event bus and typed building panels. Owns the
batch accumulator. It never constructs raw protocol calls.

### `apps/backend`

Paymaster-key custody, privacy-safe RPC reads and the bounded submission queue
for eligible prepared Wallet API calls. It never delays quote-bound routes.

**Must not:** log or persist per-request IPs, calls, proofs, timings,
recipients or transaction hashes. Aggregate operational counters only. It
validates fee ceilings and route kill switches before submission (D-014,
D-015, D-018).

### Deployment composition (D-045/D-046)

The target deployment is one public Fly.io app/Machine. An edge/composition
process serves the built Vite shell, routes same-origin `/api` requests to the
backend and upgrades the lobby WebSocket. Keep one active admission-control
instance while its rate limits and budgets are process-local. Alchemy is the
provisional Starknet RPC provider, split into a public origin-restricted
browser application/key and a private server/IP-restricted application/key;
neither account nor key is present in the repository. Provider edge access
logs and headers remain launch checks under D-014/D-005.

---

## The event bus (React ↔ Phaser)

One-directional by design.

- React owns wallet connection, balances, pending operations, and all
  financial state.
- Phaser owns scenes, movement and rendering.
- React pushes into Phaser via an event emitter.
- Phaser emits semantic events back; it never reads React state and never
  calls Starknet.

This means the game can run with no wallet connected — which is exactly what
Phase 1 builds, and what makes the world independently testable.

Remote peers are retained state rather than one-shot commands. D-038 gives
them a separate World-owned replaying source so a snapshot cannot be lost
while Phaser boots or remounts. The Shell maps `LobbyClient.onPeers()` into
that source; World receives only opaque peer ID, position, facing and approved
sprite key. The D-038 `WorldEvents` / `ShellEvents` contract remains unchanged;
D-047 is a later, explicitly controlled extension of `WorldEvents` only for
the nonfinancial Avatar Studio (`avatar-studio:entered`,
`avatar-studio:exited`, `avatar:selected`). `ShellEvents` and the lobby schema
remain unchanged.

Game Mode interiors use one data-driven fixed-room core (D-039). A definition
contains only local presentation geometry, an opaque building ID and opaque
station footprints; it contains no route, action, wallet or financial meaning.
The street scene remains the sole Phaser scene and renders the active
definition. Shell separately maps station IDs to admitted routes and sends only
labels/lock state across the frozen D-033 bus. This keeps collision, entry/exit,
control handoff and teardown in one World implementation across Bank, Post
Office, Exchange and Bridge.

---

## Forward compatibility

The privacy layer targets `WalletWithStarknetFeatures`, not a wallet. Web
wallets register on the same feature surface as extensions, so email/social
login lights up with no code change here when a vendor ships the methods.

Five rules keep that true — they are in [`SPEC.md`](SPEC.md) §5, and a CI
test enforces them. The load-bearing one: discover wallets dynamically via
`get-starknet-discovery`, never from the static `get-starknet-wallets` list.
