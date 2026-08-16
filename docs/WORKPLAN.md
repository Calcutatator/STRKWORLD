# Work plan — division of labour

How STRKWORLD gets built, and how several agents work in parallel without
colliding.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the boundaries and
[`SPEC.md`](SPEC.md) for what is being built. This document is about *who does
what, in what order*.

---

## The lanes

Four lanes, one package each. The package boundary **is** the lane boundary —
that is why the repo is shaped the way it is.

| Lane | Package | Status in v1 |
|---|---|---|
| **Chain** | `packages/privacy` | Active |
| **World** | `packages/world` + `packages/lobby` | Active |
| **Shell** | `apps/web` | Active, starts week 2 |
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
collision, camera and sprite state. Shell work is React panels, wallet state,
the batch accumulator and the submission queue. Different files, different
skills, and — importantly — **the World lane has no dependency on the chain at
all**, so it can run at full speed from day one while Chain is still measuring
wallet behaviour.

### Why Lobby sits with World

The lobby is small and its only real coupling is to movement — position
throttling, interest management, the ephemeral-ID lifecycle. Giving it to a
separate agent means two agents negotiating the shape of a position update.
Same agent, same head.

---

## Before anyone starts: freeze the seams

**This is the highest-risk step and it is not parallel.** Four agents building
against stubs will diverge, and the divergence surfaces at integration when it
is most expensive.

One agent (or the lead) locks these first:

1. **`PrivacyOperations`** — done, in `packages/privacy/src/operations.ts`.
2. **`WorldEvents` / `ShellEvents`** — the bridge contract, in
   `packages/shared/src/index.ts`. Currently a first draft; it needs a pass
   with the building panels in mind before it is frozen.
3. **The lobby room schema** — what a presence update contains. Not yet
   written. It is the enforcement point for "the lobby never sees money", so it
   is worth getting exactly right once.

Once frozen, changes to `packages/shared` require a decision entry. Not
bureaucracy — a change there breaks three lanes at once, so it should be a
deliberate act rather than a convenient one.

---

## Sequencing

Lanes do not all start usefully at the same time.

```
Week 0   ├── FREEZE SEAMS ──────────────────────────────────┐
         │                                                   │
Week 1   ├── Chain: Phase 0 wallet spike  ⚠ GATES DESIGN     │
         ├── World: scenes, movement, collision              │
         └── Art: source packs, licence audit                │
                                                              │
Week 2-3 ├── Chain: PrivacyOperations implementation          │
         ├── World: tilemaps, buildings, lobby                │
         ├── Shell: bridge, panels, batch accumulator ◄───────┘
         └── Art: tilesets embedded, first facades
                                                
Week 4-5 ├── Shell: Bank + Post Office panels wired
         ├── Chain: AVNU Exchange
         └── World: second district, polish
                                                
Week 6-8 └── Integration, mainnet regression, hardening, launch
```

**The Phase 0 spike gates real design decisions**, so it runs first and its
results are broadcast to every lane. Four questions no document can answer,
detailed in [`SPEC.md`](SPEC.md) §8 — whether the shipped wallet honours
arbitrary-contract `invoke`, whether `strk20Balances` prompts, whether a
multi-action array renders one confirmation or several, and real end-to-end
latency.

If `strk20Balances` prompts on every call, the Shell lane's balance HUD design
changes completely. Better to know in week one than week four.

---

## Lane briefs

Each brief is written so an agent can be pointed at it and start.

### Lane: Chain

**Owns** `packages/privacy`. The only lane that imports `starknet`.

**First task — the Phase 0 spike.** A scratch page, not production code. Drive
all three methods against a real extension on mainnet with tiny amounts.
Answer the four questions and write findings into `AGENTS.md`.

**Then:** implement `WalletApiPrivacyOperations` against the frozen interface.
Wallet connection via `get-starknet-discovery` (never the static wallet list),
capability detection by version query only, action-array construction with the
open-note invariant, recipient preflight via the pool's `get_public_key`, and
the full error taxonomy mapped to `PrivacyErrorKind`.

**Must not:** contain UI, import from `world` or `lobby`, branch on wallet
identity, or read balances for feature detection.

**Done when:** every `PrivacyOperations` method works on mainnet with real
funds, and a mock implementing the same interface drives the app end to end.

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
transaction hash or building name into lobby traffic. Broadcast *entry* into a
building — entry is a private fact; position is not.

**Watch for:** Tiled external tilesets. Phaser rejects them silently with only
a console warning. Embed on export.

**Done when:** two browsers see each other walk around a street, and entering a
building fires a clean event with nothing financial anywhere in the lobby.

**Reference:** `packages/world/README.md` · `packages/lobby/README.md`

---

### Lane: Shell

**Owns** `apps/web`. Starts week 2, once the seams are frozen and World has
something to mount.

**First task:** the React ↔ Phaser bridge. React owns wallet and financial
state; Phaser receives plain data via an event emitter and never reads back.

**Then:** building panels, the connect flow with capability detection, the
`NOT_REGISTERED` and unsupported-wallet rooms as designed screens rather than
error toasts, and the two subsystems this lane owns:

- **Batch accumulator** — collects intent during a building visit, emits one
  atomic action array on exit. Amortises the pool fee across a session.
- **Submission queue** — randomised delay between avatar action and broadcast.
  A privacy control with its own tests, not an optimisation.

**Critical constraint:** batching amortises fees, but **never bundle a deposit
with the transfer it funds**. Deposits carry a public ERC-20 leg naming the
depositor, so bundling publishes the link an observer needs. Shielding stays
its own earlier transaction.

**Must not:** contain logic belonging in a package. Set `COOP`/`COEP` headers.
Put a paymaster key in the browser bundle.

**Done when:** a player connects, sees their balance, shields, and pays another
player — with honest in-product copy about what is and is not hidden.

**Reference:** [`SPEC.md`](SPEC.md) §6 · `apps/web/README.md`

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
