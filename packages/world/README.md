# @strkworld/world

**The game. A tile-authored world, drawn in 3D with Three.js (D-059).**

This package knows nothing about wallets or money. If code here needs to know
a balance, it is being asked to do the wrong job — the value should be pushed
in as plain data by the shell.

---

## What this owns

- The gameplay session (`world-session.ts`): movement, tile collision, door
  triggers, fixed rooms and stations, the Avatar Studio, the outfit toggle and
  the input gate — engine-agnostic and tested headlessly
- The 3D presentation (`three/`): renderer, camera, lighting, procedural
  district and interiors, low-poly avatars, remote avatars
- World layout and building entrances with their trigger zones
- Semantic events out: `building:entered`, `building:exited`, `player:moved`

Gameplay stays in 2D pixel space — the same coordinates the lobby, door
triggers and room controllers always used. The renderer draws that plane in 3D:
one 32 px tile is one world unit, +X is east, +Z is south and +Y is up
(`three/coords.ts`). Nothing outside the renderer ever sees a 3D coordinate, so
no seam changed shape.

## Controls

Arrow keys and WASD move the avatar identically outdoors, in every fixed room
interior and in the Studio. Hold either Shift key to sprint at exactly 1.5×
walk speed. Diagonal movement stays normalized, including while sprinting.
`F` swaps the paired outfit anywhere the avatar is (D-053). In the block
sandbox at the end of the road, `E` picks up the block in front of you and `E`
again puts it down (D-060). At the Privacy Plaza, `E` uses the monument or
the shell-game table you stand beside (D-076).

The camera follows the player, north-up by default. Drag (left or right
button) to orbit, scroll to zoom. Movement keys are camera-relative — "up"
always walks away from the camera — and the facing published on the wire is
the cardinal nearest the intended World direction. The camera never turns on
its own, so a key held through a room or Studio handoff cannot walk the player
back out of the door. Buildings between the camera and the player fade.

On `building:entered`, the shell removes or suspends the player's lobby
presence while the local interior UI is open. The world emits the semantic
event only; it never sends the building ID through lobby traffic. Other
players seeing the avatar disappear is an accepted v1 trade-off (D-019).

## What this must never do

- Import `starknet`, any wallet package, or `@strkworld/privacy`
- Know what a token, balance or transaction is
- Read React state or call into the shell directly. Emit an event instead

---

## The event bus

One-directional. React owns wallet and financial state; this package receives
plain data and emits semantic events.

```ts
// out — something happened in the world
emitter.emit('building:entered', { building: 'bank' })

// in — the shell tells the world what to render
emitter.on('world:stations', ({ building, stations }) => { ... })
```

The `hud:*` and `wallet:status` events reach this package too, but the HUD is
drawn by the Shell's overlay (`apps/web/src/hud`), so the World ignores them.

The world must run correctly with no wallet connected at all. That is what
Phase 1 builds, and it is what makes the world independently testable.

Remote-avatar snapshots are the one retained-state side seam (D-038), not an
event. The Shell injects a World-owned replaying source; this package
subscribes and reconciles complete presentation-only snapshots, interpolating
each avatar between them. It never imports the lobby or controls its
connection lifecycle.

The source is subscribe-only at the World boundary. The Shell keeps the
publisher/controller beside its lobby lifecycle and passes only the source to
`acquireWorld`:

```ts
const channel = createRemotePeerSource();
acquireWorld(parent, { out, in: shellIn, remotePeers: channel.source });
channel.publish(peers);
channel.clear();
```

## Lifecycle

`acquireWorld` / `releaseWorld` go through the ref-counted host (`host.ts`),
which survives React's synchronous StrictMode remount. One engine owns one
WebGL context per mount. A same-owner remount keeps the current session. If
the host element or injected buses/remote-peer source change before deferred
teardown, the engine moves its stable World-owned mount to the new React host,
re-measures it, and rebuilds only the gameplay session against the new config:
it must not retain a detached React node, the first Shell bus or a stale
remote-peer source merely because the WebGL context survives.

Teardown is synchronous — stop the loop, dispose the session, every geometry,
material and texture, then the renderer and its context. A renderer that waited
for the next animation frame would never tear down in a hidden tab.

Frame stages are isolated. A failing session update, animation or camera step
is reported (rate-limited) and the frame still renders; the session's rollback
rules retry a failed Shell handoff on the next frame.

Each remote snapshot contains only `{ id, x, y, facing, sprite }`. The World
drops invalid identity, position or facing data, replaces omitted IDs, and maps
the approved cosmetic sprite key onto its local avatar look.

## The block sandbox (D-060)

The road runs through a gate into a 28×28 square (`SANDBOX_AREA`) where blocks
drop from the sky and players stack them. A two-block toy-block wall (solid
`fence` tiles) closes the square's street side. Sky drops keep clear of the
three tiles inside the gate (`SANDBOX_ENTRANCE`) and stacks there stay one
block high, so the way in always stays walkable; the aim highlight shows the
same limit. The stacks are shared state with one authority:
the lobby room when a lobby connection is open, or the same pure rules run by
the Shell for solo play. The World never imports the lobby; it receives a
World-owned `SandboxChannel` through `WorldConfig`, like the D-038 peer source.

- **Movement** (`sandbox.ts`): you stand on the tallest stack your body
  overlaps. A stack more than one block above that level is a wall; one block
  is a step up with a small hop; stepping down is free. With no blocks the
  mover is identical to the interiors' tile collision.
- **`E`** aims at the neighbouring tile you face. Empty hands pick its top
  block; carrying places onto it. A ghost highlight shows the target and
  whether the shared reach rules allow it; the authority decides.
- **Presentation** (`three/sandbox-view.ts`): one instanced mesh for every
  block, sky drops fall from high above, carried blocks ride above heads for
  every player, and the camera, sun and fog follow you up tall towers.
- **Bursts** (D-071, threshold set by D-075): no column holds more than
  `SANDBOX_BURST_HEIGHT` (14) blocks; the block that would make one taller
  bursts the whole sandbox. The channel's `subscribeBursts` hint throws every
  drawn block away from that tile (the same throw on every client, seeded by
  each block's tile and
  level), or pops them out under `prefers-reduced-motion`; the emptied
  snapshot drops anyone standing on the stacks through the usual fall. The
  aim ring turns hot pink when a place would burst it.

## The Privacy Plaza (D-076)

A paved square below the road's west end (`map/plaza.ts`: street tiles
x 0-10, y 19-27), opposite the sandbox, with no money in it. The map paints
it with two tile kinds, walkable `plaza` paving and solid `plinth` under
every fixture, so collision stays tile-based. `three/plaza-builder.ts` draws
it into the street's groups and budget: paving level with the pavement, a
gateway with the "PRIVACY PLAZA" sign, benches, lamps, trees and planters,
the shell-game table, and the pool-stats monument, whose faces print the
Shell's pre-formatted `plaza:stats` figures (or "…").

- **Stations on the street.** `plaza:monument` and `plaza:shells` open with
  `E` from any tile beside their fixture (`plaza-stations.ts`). The handoff
  is the fixed rooms' own, with `plaza` as the building: input is suspended
  before `station:activated`, the Shell claims `world:control-owner` while
  it is delivered, and an unclaimed activation gives input straight back. No
  building is entered and presence is untouched.
- **In view.** The controller emits `plaza:nearby` when the player's tile
  enters or leaves `PLAZA_NEARBY`, and `{ near: false }` when a World torn
  down there goes, so the Shell reads the stats only while someone can see
  them.

## Fixed Game Mode rooms

D-039 makes fixed interiors data, not separate scenes. The room core owns
tiles, collision, physical exit, station approach/activation and Shell control
handoff for every definition; the session presents the currently active room.
A definition may name a building and opaque station but never a route or
action. Interiors are drawn at `ROOM_ORIGIN` over the hidden street
(`world-layout.ts`).

The Bank remains the frozen first tracer. The Post Office is the second, with
one `post-office:transfer` station labelled `TRANSFER`; the Exchange is the
third, with one `exchange:swap` station labelled `SWAP`. All use the same
18×12, 32 px envelope. Shell remains the authorization boundary: every visit
begins with stations locked until the matching current snapshot arrives.

The Vault's room (`VAULT_ROOM_DEFINITION`, one `vault:lending` station
labelled `SUPPLY / REDEEM`) exists only when the Shell opens the Vault
(D-077), so it is not in the always-open `FIXED_ROOM_DEFINITIONS`: the
session and the presenter build their rooms from
`fixedRoomDefinitionsFor({ vaultOpen })`. The engine reads `vaultOpen` once,
when it starts; a rebind keeps it, because the street and rooms are built
once.

---

## Map authoring

The street is procedural, Tiled-shaped data (`map/street.ts`): doors are an
object layer converted by `objectLayerToDoors`, so a real Tiled export is a
data-source swap. If one lands, **embed tilesets on export** (D-008) — Tiled
JSON with external `.tsx` references is not self-contained.

### Growing the city

The map is meant to expand version by version. Keep each district a separate
map, and keep building entrances data-driven — a trigger zone with a
`building` property, not a hardcoded coordinate.

Collision is tile-based and 3D props do not collide, so volumetric decor only
goes outside the walkable bounds or on solid building tiles. Inside the
walkable area use flat decor.

---

## Art

Procedural low-poly geometry, no third-party assets (D-059). Avatars are
procedural blocky figures, one look per opaque avatar key, coloured from the
approved D-049 sheets in `assets/player-sprites/v1/`; those sheets also feed
the Shell's wallet-attention cue (D-058). Any future model pack must be checked
for commercial-use licensing before it lands and recorded in
`assets/CREDITS.md`.

The one exception is the Exchange tower's Degen floor: its posters are the
token projects' own logos and art, composed into 512×768 WebPs in
`assets/degen-posters/` and credited in `assets/CREDITS.md`. They are bundled,
so the browser loads them from the game's own origin and never from a
project's CDN. Builders get them through an injected `ImageTextureLoader`
(the texture twin of `LabelFactory`); without one, or while one loads or if it
fails, each poster shows its procedural stand-in.

Four buildings in v1: the Bank, the Exchange, the Post Office, and a visible
Vault, plus the Bridge. The Vault is locked by default so the world reads as
complete (D-007); the Shell opens it on shadow accounts by passing
`vaultOpen: true` in `WorldConfig` (D-077), and then its door stands open onto
Vesu's room. The World learns only that the door is open. The Bank follows the
STRK20 visual theme, the Exchange avnu's and the opened Vault Vesu's; the Post
Office and Bridge keep the game's own palette.
