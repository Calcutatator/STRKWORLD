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
`F` swaps the paired outfit anywhere the avatar is (D-053).

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
emitter.on('hud:balance', (b: { display: string | null }) => { ... })
```

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

Four buildings in v1: the Bank, the Exchange, the Post Office, and a visible
but locked Vault so the world reads as complete, plus the Bridge.
