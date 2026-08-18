# @strkworld/world

**The game. Phaser scenes, movement, tilemaps, sprites.**

This package knows nothing about wallets or money. If code here needs to know
a balance, it is being asked to do the wrong job — the value should be pushed
in as plain data by the shell.

---

## What this owns

- Phaser scenes, the game loop and camera
- Tilemaps, collision, world layout
- Player and NPC sprites, walking animation
- Building entrances and their trigger zones
- Semantic events out: `building:entered`, `building:exited`, `player:moved`

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
event. The Shell injects a World-owned replaying source before scene creation;
this package subscribes and reconciles complete presentation-only snapshots.
It never imports the lobby or controls its connection lifecycle.

The source is subscribe-only at the World boundary. The Shell keeps the
publisher/controller beside its lobby lifecycle and passes only the source to
`acquireWorld`:

```ts
const channel = createRemotePeerSource();
acquireWorld(parent, { out, in: shellIn, remotePeers: channel.source });
channel.publish(peers);
channel.clear();
```

Each snapshot contains only `{ id, x, y, facing, sprite }`. The World drops
invalid identity, position or facing data, replaces omitted IDs, and maps the
approved cosmetic sprite key onto its safe local avatar texture.

---

## Map authoring

**Embed tilesets on export.** Phaser's Tiled parser rejects external `.tsx`:

```js
// phaser/src/tilemaps/parsers/tiled/ParseTilesets.js:38
if (set.source) {
    console.warn('External tilesets unsupported. Use Embed Tileset and re-export');
```

In Tiled: *Map → Embed Tilesets* before exporting JSON, or flatten as a build
step. Maps authored with external tilesets load as empty with only a console
warning, which is easy to miss and annoying to diagnose.

### Growing the city

The map is meant to expand version by version. Keep each district a separate
tilemap with a shared tileset so a new street is an added file rather than an
edit to a large one, and keep building entrances data-driven — a trigger zone
with a `building` property, not a hardcoded coordinate.

---

## Art

Asset-pack base with bespoke building facades. Any pack must be checked for
commercial-use licensing before it lands — a per-pack audit, not a per-tag
assumption. Record the licence for each asset in `assets/CREDITS.md` as you
add it.

Four buildings in v1: the Bank, the Exchange, the Post Office, and a visible
but disabled Vault facade so the world reads as complete.
