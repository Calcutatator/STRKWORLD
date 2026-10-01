# @strkworld/lobby

**Multiplayer presence. Deliberately the dumbest package in the repo.**

A Colyseus room that broadcasts where avatars are, holds the shared block
sandbox at the east end of the road (D-060) and simulates the one football on
the pitch at its west end (D-078). That is all it does, and that is all it is
permitted to do.

---

## The rule

**The lobby never sees money.**

No address. No balance. No transaction hash. No building name. No financial
action. Not in traffic, not in server state, not in logs, not in metrics.

This is where a privacy failure would be quietest — the cryptography can be
perfect and the product still leaks, because the game itself becomes a
side channel. So the constraint is structural rather than a matter of care:

- The room schema is the enforcement point. A field that cannot be added to
  the schema cannot leak.
- The room's configuration is trusted server state, never client input. This
  is not an incidental detail: it is the fix for a confirmed break where a
  client's join payload became the room's config (see "Configuration is
  trusted" below).
- Player identity is an **ephemeral per-session `gameId`**, minted on the
  **server**, never derived from an address, discarded on disconnect. A
  client-supplied identifier is ignored.
- Sandbox state carries **no identity field**: stacks of palette indices keyed
  by tile. No column, drop, burst or other sandbox message names a player; the only
  per-player sandbox field is `carrying` on that player's own presence entry.
  That is weaker than "unattributable" — see "What the sandbox reveals" below.
- The football (D-078) is one ball, the score and the phase of play. The kick
  carries **no payload**, the goal broadcast names a side, and nothing counts
  a goal, a kick or a touch per player: there are no player statistics.
- No persistence. When the room empties, nothing remains — blocks and score
  included.

If a feature seems to need an address in the lobby, it needs a different
design. Raise it as a decision entry before writing code.

---

## What this owns

- The Colyseus room, its schema and its transport
- Position broadcast and interest management
- Ephemeral session identity
- The block sandbox authority (D-060): the rules, the room's copy of the
  stacks, the sky-drop spawner — and the same pure rules for the Shell's solo
  play at `@strkworld/lobby/sandbox`
- The football authority (D-078): the physics and match rules, the room's copy
  of the ball, its 40 ms step while anyone is near the pitch — and the same
  pure rules for the Shell's solo play and drawn ball at
  `@strkworld/lobby/football`

## What this must never do

- Import `@strkworld/privacy` or `starknet`
- Store or log anything that could identify a player across sessions
- Persist state

---

## Running it

```bash
npm run dev --workspace=@strkworld/lobby     # ws://localhost:2567
LOBBY_PORT=3000 npm run dev --workspace=@strkworld/lobby
```

**Port 2567**, the Colyseus convention. One room type, `street`. The entry
point fails loudly if the port is taken rather than quietly moving, because
the shell has the endpoint configured.

It prints one line — the endpoint — and logs nothing per connection of its own.
Colyseus's own `debug` channels *could* print joins, moves and message bodies
under `DEBUG=colyseus:*`; `startPresenceServer` force-disables the
per-connection ones (`connection`, `message`, `patch`, `presence`, `driver`,
`matchmaking`) so that switch cannot expose a player's coordinates. Aggregate
counters are available on the room (`PresenceRoom.counters`) and name no
individual player.

### The HTTP surface is real

Colyseus registers an HTTP matchmaking API on the same port
(`POST /matchmake/<method>/<room>` plus an `OPTIONS` preflight) — that is how
the websocket handshake is negotiated, so the presence port is not
websocket-only and the join payload rides as an HTTP body. Two consequences:

- **CORS.** Colyseus's default reflects any `Origin` back with
  `Access-Control-Allow-Credentials: true`. `startPresenceServer` replaces that
  with an origin allowlist (`allowedOrigins`, default the local Vite
  dev/preview origins) and drops the credentials header. A non-browser client
  sends no `Origin` and is unaffected.
- **Proxy logs.** A fronting proxy logs request bodies by default; this process
  cannot control that. It is why the join body must carry nothing sensitive —
  which, structurally, it cannot: the id is server-minted and every other field
  is a coordinate or a checked enum. Relevant to the backend's D-014 no-log
  posture if the two ever share a proxy.

### Configuration is trusted, never client-set

A room's sprite list, capacity, interest radius, rate floor and world bounds
come only from the server operator — `startPresenceServer({ room })` or
`definePresenceRoom(config)`. They are **not** read from the room's `onCreate`
options, because under Colyseus matchmaking those are
`merge({}, clientOptions, handlerOptions)` and the client half is a join
payload. A client cannot influence room config. (This closed a confirmed break
in which one unauthenticated `POST /matchmake/joinOrCreate` set the room's
entire config, including a `spriteKeys`/`defaultSprite` allowlist through which
a hex id and a token amount reached honest players' screens.)

---

## The client wrapper

`LobbyClient` is what the Shell consumes. Plain data in, plain data out; no
Phaser, no React, no DOM. Under D-038 the Shell maps peer snapshots into a
World-owned replaying source; `packages/world` never imports this client.
Peer snapshots remain empty until the server-minted welcome ID arrives, because
the client cannot reliably exclude its own room entry before that point. The
welcome handler publishes the first correctly self-filtered full snapshot.

```ts
import { LobbyClient } from '@strkworld/lobby/client';

const lobby = new LobbyClient({
  endpoint: 'ws://localhost:2567',
  start: { x: 400, y: 300 },
  sprite: 'avatar-3',
});

await lobby.connect();                        // explicit. never automatic
const stopPeers = lobby.onPeers(mapPeersIntoWorldSource);
const stopStatus = lobby.onStatus((e) => {    // learn if the connection dies
  if (e.status === 'closed' && e.reason === 'server-dropped') reconnectUI();
});
lobby.updatePosition(x, y, 'left');           // safe to call every frame
lobby.suspend();                              // on building entry (D-019)
lobby.resume({ x, y, facing: 'down' }, 'avatar-9'); // optional D-047 selection
lobby.enterArea('studio', { x, y, facing: 'down' }, 'avatar-9'); // D-087 shared room
lobby.enterArea('street', { x, y, facing: 'up' });  // and back out

// D-060 block sandbox
const stopSandbox = lobby.onSandbox(drawStacks); // replays now, then on change
const stopDrops = lobby.onSandboxDrop(animateFall); // hints only, no replay
lobby.pickBlock({ x: 60, y: 10 });            // street tile, integers
lobby.placeBlock({ x: 61, y: 10 });

await lobby.disconnect();
stopPeers();
stopStatus();
stopSandbox();
stopDrops();
```

Import the client from the root entry or `@strkworld/lobby/client`. The server
side lives at `@strkworld/lobby/server` — importing it pulls in `@colyseus/core`
and `@colyseus/ws-transport` (and, through the transport, `express`), so it
must never enter a browser bundle. The two entries are split precisely so the
shell and World lane get the client without the server's dependency tree.

### The lifecycle contract

**Nothing performs network I/O except `connect`, `resume` and `disconnect`, and
those only when the shell calls them.** Constructing a client opens nothing.
Subscribing with `onPeers` opens nothing.

That rule exists because the consumer mounts under React StrictMode, where a
scene constructor, a `create()` or a mount effect runs twice. A join hidden
inside any of those produces two presence entries for one player, and the
second is a ghost that keeps walking after the real player leaves. So joining
is an explicit, imperative, shell-driven call.

As defence in depth `connect()` is idempotent: a second call while connected
returns immediately, and concurrent calls share one attempt. `client.test.ts`
asserts against a real server that two `connect()` calls produce exactly one
presence entry.

`updatePosition` is cheap enough for an update loop. The client never sends
faster than `MIN_CLIENT_SEND_INTERVAL_MS` — which is at or above the server's
hard message ceiling — so a consumer cannot drive it into a flood-disconnect no
matter how small a `minSendIntervalMs` it requests. And it re-sends the latest
requested position until the server's copy of this avatar matches it, so the
final position of a movement lands even if the server's own rate floor dropped
an intermediate send.

`onStatus` reports connection-state transitions. A transition into `closed`
carries a `reason`: `client-left` for a local `disconnect()`, `server-dropped`
(with the close `code`) when the server closes the socket, or `error`. That is
how the consumer tells "the player left" from "the connection died" rather than
inferring it from an empty peer list.

Both subscription methods replay the current value synchronously, then deliver
captured transitions in FIFO order. A listener added or replaced during a
delivery receives its one immediate replay but cannot inherit the older
in-flight transition; an older cleanup cannot remove that replacement. A
subscriber exception emits only a fixed content-free diagnostic and is isolated
from the client lifecycle and the other subscribers; the thrown value is never
logged across the Lobby privacy boundary. `status` and `peers()` remain the
authoritative current snapshots during any reentrant callback.

The pinned Colyseus SDK enables a 15-attempt automatic reconnection loop on
every joined room by default. `LobbyClient` disables that room option before
publishing the connection. D-037 gives reconnect ownership to the Shell's
explicit player control; leaving the SDK default enabled would keep reporting
`connected` after an established transport drop and would perform network I/O
the player did not request. A code-less WebSocket error is left for its paired
close event so the wrapper reports the real close code as `server-dropped`;
numeric room/protocol errors remain `error`.

`resume` throws if the client was never connected or has been disconnected.
Reconnecting is the shell's decision to make explicitly, not a side effect of
resuming.

### The block sandbox (D-060)

`sandbox()` returns a frozen `SandboxSnapshot` — every stack in the room plus
the colour this client carries — and the same object for as long as nothing in
it changes. `onSandbox` replays it synchronously and then delivers only when a
column or the own carried colour changes, not on every room patch; delivery
follows `onPeers` exactly (FIFO, generation-owned, a throwing subscriber is
isolated behind a fixed content-free diagnostic).

- **Columns** come from the room-wide sandbox state, which is **not**
  interest-filtered: a player across the map sees the same stacks. They are
  validated here and fail closed — a column whose key, tile, height or any
  colour is off is skipped whole; an unreadable container is an empty sandbox;
  columns beyond the 900-block cap are not drawn. Sorted by `(y, x)`.
- **Own `carrying`** is read from this client's **own presence entry**. It is
  null unless the client is connected with a server identity, so it drops to
  null the moment `suspend()` is called (the server puts the block back then)
  and stays null after `resume` until a new pick lands.
- **`pickBlock(tile)` / `placeBlock(tile)`** send `{ x, y }` and nothing else.
  They are no-ops unless connected (not suspended) and for anything but an
  integer tile inside `SANDBOX_AREA` (read from own data properties only). One
  client-side floor, `SANDBOX_CLIENT_ACTION_INTERVAL_MS` (200 ms), covers both
  verbs: a call inside it is **held and sent when the floor opens** — so a
  place issued the moment a pick shows up still lands — and only the latest
  held call survives (a newer one replaces it; suspend, disconnect or a lost
  room discards it). The server may still refuse any request silently (rules,
  its own 150 ms floor); there is no reply, and the next snapshot is the only
  answer. A World or Shell that wants to show "this will work" must evaluate
  the rules itself (see below).
- **`onSandboxDrop`** relays sky-drop hints as frozen, validated tiles. There is
  no replay. A hint is broadcast after the patch that adds the block, so by the
  time it fires the snapshot already holds that block (unless someone took it
  in between).
- **`onSandboxBurst`** (D-071) relays bursts the same way: the frozen,
  validated tile of the column that tipped the sandbox, with no replay. A
  burst is broadcast at once, before the patch that removes the blocks, so
  when it fires the snapshot still holds everything it throws; the next
  snapshot is the emptied board.
- **`PeerSnapshot.carrying`** is the peer's carried colour, validated to an
  integer palette index, else null. It is presence data, so it is subject to
  interest management like the rest of the entry.

### The football (D-078)

`football()` returns a frozen `FootballSnapshot` — the ball's position and
velocity in World pixels, the simulation tick they are from, the score and
the phase (`live`, `goal`, `full-time`) — or null before a valid one has
arrived and after a disconnect; the same object while nothing changes, and
readable while suspended. `onFootball` replays it and then delivers each
change; `onGoal` relays goal cues, `{ side }` and nothing else, frozen, with
no replay, delivered before the snapshot that raises the score. Everything is
validated and fails closed: a tick that is not a whole uint32, a ball off the
pitch square or faster than the rules allow, a score past 5 or a phase byte
the rules do not have is no ball at all.

- **`kick()`** sends `football:kick` with no payload: the room kicks from the
  position and facing it holds. It returns false unless connected (not
  suspended) and outside the client floor, `FOOTBALL_CLIENT_KICK_INTERVAL_MS`
  (300 ms): an early kick is **dropped, not held**, because a late kick is a
  different kick. A newer position still waiting on the move floor goes
  first, so the room judges the kick from where the player stands now. The
  room applies its own rules (reach 1.3 tiles, live play) and its 250 ms
  floor, refused kicks included, and answers only through the ball.
- **The room steps the ball** on a fixed 40 ms tick, in four substeps, only
  while someone on the street is on the pitch or within 15 tiles of its gate;
  otherwise the ball comes to rest and the step timer stops. The entry is
  written only when the ball, score or phase changed, so a still ball costs no
  patches, and its tick dates each sample for the client's clock.

### Solo play: `@strkworld/lobby/sandbox`

```ts
import {
  createSandboxAuthority,
  sandboxSpawnDelay,
} from '@strkworld/lobby/sandbox';

const sandbox = createSandboxAuthority();          // { random } injectable
sandbox.pick({ key: 'me', x, y }, tile, []);       // false: nothing changed
sandbox.place({ key: 'me', x, y }, tile, others);  // tile, { burst: tile } or null
sandbox.spawn([{ key: 'me', x, y }]);              // tile, { burst: tile } or null
sandbox.returnCarried('me', [{ key: 'me', x, y }]); // leaving the street, likewise
sandbox.snapshotFor('me');                         // frozen SandboxSnapshot
setTimeout(tick, sandboxSpawnDelay(sandbox.totalBlocks));
```

The module imports nothing but `@strkworld/shared` — no Colyseus, no clock, no
network — and is the exact rule set the room enforces. Positions are World
pixels (`SANDBOX_TILE_SIZE` = 32 per tile). `columns()` is the same frozen array
until a stack changes, so `next.columns === prev.columns && next.carrying ===
prev.carrying` is a cheap change test; `snapshotFor` itself returns a new
object on every call. The Shell runs its own drop timer with
`sandboxSpawnDelay(totalBlocks)` and passes the local player to `spawn`, so
solo drops also avoid them. When the player leaves the street carrying a
block, the Shell calls `returnCarried(key, players)` — with the player's last
position among `players` — and shows the returned tile as a drop, exactly as
the room does. `isSandboxBurst(result)` tells a burst from a landing, and the
Shell announces a burst before publishing the emptied board, as the room
does.

**The rules.** A player's tile is `floor(x / 32), floor(y / 32)`; their level
is the stack height on that tile (0 outside the area). A target must be inside
`SANDBOX_AREA`, not the player's own tile, and have its centre within
`SANDBOX_ACTION_RANGE` (48 px) of the player's position as a **square box**
(Chebyshev, like interest) — which from anywhere in your tile covers all eight
neighbours, and it is never a tile another player stands on (D-060: nobody
picks from or places onto the tile under someone). **Pick**: not carrying;
the stack is at least 1 high and its top is within `level − 1 … level + 2`;
takes the top colour. **Place**: carrying; the new height is at most 256 and
within `level − 1 … level + 2`; pushes the carried colour. **Spawn**: only
below 900 blocks (carried blocks count); uniform over tiles more than one tile
(Chebyshev) from every player's tile and below the height cap, enumerated in
`(y, x)` order; colour uniform over the 8-colour palette. **Return**
(`returnCarried`): the carried block falls onto a tile chosen by the spawn
rules, keeping its colour; it is discarded only if no tile is allowed.
**Burst** (D-071, threshold set by D-075): a place, spawn or return onto a
column already holding `SANDBOX_BURST_HEIGHT` (14) blocks passes every check
above first, then removes every placed block instead of landing, the arriving
block with them; blocks other players carry stay carried. So no column ever
holds more than 14 and the 256 cap is never reached. A rejected action changes
nothing.

### What the sandbox reveals, and what it trusts

- **The rules are advisory against a hostile client.** Reach, adjacency and the
  one-block step are judged from the position the client reports. The server
  does not enforce movement continuity — legitimate jumps exist (leaving a
  building interior or the Avatar Studio puts you somewhere new) — so a
  hostile client can teleport beside any stack or stand "on" a tower it never
  climbed, and act from there. What bounds the damage is **conservation**:
  play never destroys a block but in a burst. Picking only moves one into a
  hand, and a carried block goes back to the sky when its carrier suspends or
  leaves, so the most a griefer can do block by block is rearrange the board,
  at the 150 ms action floor, never below the fixed total. Anyone, hostile or
  not, can empty it by building a pillar past 14 (D-071, threshold set by
  D-075): that is the reset, and it needs a real stand 13 blocks high beside
  the pillar.
- **The board is player-written content, visible to the whole room.** Blocks
  can spell words, draw symbols or write any pattern a player chooses —
  including text that means something off the board. The lobby does not and
  cannot vet it. It never records who placed what, but what is on the board is
  public to everyone in the room, so treat it like any shared canvas.
- **"No identity field" is not "unattributable".** Columns and drop hints name
  no one. But an observer inside the presence interest radius sees a peer's
  `carrying` change in the same patch as a neighbouring column, and so can
  tell who took or placed which block; and every observer learns that someone
  was within reach of a tile that changed. A block put back when its carrier
  leaves lands at a random allowed tile, never within a tile of where they
  stood, so the drop does not mark where they entered a building — but its
  timing coincides with their leaving. None of this involves money.

---

## What travels

The room schema mirrors the frozen `PresenceState` from `@strkworld/shared`
field for field and adds nothing:

| Field | Type | Constrained to |
|---|---|---|
| `gameId` | string | 16 lowercase hex characters, **minted on the server**. A client-supplied id is ignored |
| `position` | `{ x, y }` | Finite numbers, rounded to whole pixels, clamped to ±8192 |
| `facing` | string | One of `up` `down` `left` `right`. Substituted otherwise |
| `sprite` | string | A key from the room's **trusted** sprite list. Substituted otherwise |
| `carrying` | int8 | D-060: a sandbox palette index `0–7`, or `-1`. Written only by the room from its own record, never from client input |

Every field is narrowed at the boundary, which is the second half of the
enforcement. A schema with the right field names but a free-form string in one
of them would still be a channel: a player could set their sprite to their own
address. Nothing outside those ranges reaches an entry — and the allowlist a
sprite is checked against is trusted server config, never a list the joining
client supplied.

Beside the interest-filtered `peers` map, the root holds two more fields.
`sandbox` is a map keyed `"x,y"` of `{ x: uint8, y: uint8, colours: uint8[] }`,
one entry per non-empty stack, colours from the ground up. It is deliberately
**not** view-filtered — everyone shares one sandbox, and at most 900 blocks it
is small. It names tiles and colours and nothing else. `football` (D-078) is
one entry, shared the same way: `tick: uint32`, the ball's `x`, `y`, `vx`,
`vy` as `int32` in 64ths of a pixel (and of a pixel a second), `west`, `east`
and `phase` as `uint8`. Whole numbers throughout, written only by the room
from its own simulation.

The client-to-server vocabulary is seven verbs — `move`, `suspend`, `resume`,
`area` (`{ area, x, y, facing, sprite }`, D-087: go live in `street`, `roof`
or `studio`), `sandbox:pick` and `sandbox:place` (each `{ x, y }`, an integer
sandbox tile), and `football:kick`, whose payload is never read — and a join
payload. There is
no message through which a client could tell the room anything else, because
there is no field for it. The server sends four messages: `welcome`
(`{ gameId }`, the recipient's own id), `sandbox:drop` (`{ x, y }`, a sky-drop
animation hint broadcast to every client after the patch that adds the block),
`sandbox:burst` (`{ x, y }`, D-071: the column that burst the sandbox,
broadcast to every client at once, before the patch that removes the blocks)
and `football:goal` (`{ side }`, D-078: `west` or `east`, broadcast at once,
before the patch that raises the score).

---

## Rate and reach

**Throttling.** The server accepts moves at one per session per 50ms on
average (20/s, matching the patch rate), from a token bucket three deep
(`MOVE_BURST`, D-086): after a gap, up to three may arrive closer together, so
a move that is early only because network jitter delayed the one before it is
kept rather than dropped. Anything beyond the bucket is dropped, never queued:
a superseded position is worthless and queueing would only add latency. A
burst costs no bandwidth, since a patch carries only the latest position. A
second, much higher ceiling (`maxMessagesPerSecond`) disconnects a client that
ignores the rate entirely.

**Interest management.** An observer receives only peers inside a 640px square
box, nearest first, capped at 24. The radius alone would not bound traffic when
a crowd forms on one corner; the cap does, and it incidentally bounds how much
of the street any single observer can watch.

Both are enforced by Colyseus's `StateView` rather than by a filter the room
could forget to apply: an entry reaches a client only while it is in that
client's view.

**Sandbox actions.** At most one accepted pick or place per session per 150 ms
(`sandboxActionIntervalMs`, which an operator may set only within 50–200 ms:
never off, and never above the client's own floor, or honest held actions
would be dropped); anything earlier is dropped silently. The payload
is validated before the floor (a malformed one costs nothing and changes
nothing), and a well-formed request the rules refuse still consumes the floor.
The floor survives suspend/resume, like the move floor. The client holds itself
to 200 ms — holding an early action rather than sending it into the server's
floor — so a Shell at most sends 20 moves plus 5 sandbox actions a second, well
under the hard ceiling of 40, which still disconnects a flood of any kind.

**Kicks** (D-078). At most one accepted kick per session per 250 ms
(`footballKickIntervalMs`, which an operator may set only within 50–300 ms);
a kick the rules refuse still consumes it. The client holds itself to 300 ms
and drops an early kick, so moves, sandbox actions and kicks together stay
at most 20 + 5 + 3.3 a second.

**Sky drops.** The room keeps one drop pending while at least one session is on
the street (none while everyone is suspended or gone): every 1.5 s until the
sandbox holds 120 blocks, then every 5 s, up to the 900-block cap. A drop never
lands within one tile of a live player, nor in the entrance just inside the
square's gate (`SANDBOX_ENTRANCE`), so the rain never walls off the way in.
Players may still lay blocks there, one high at most — a place that would make
an entrance stack taller than one step is refused, so nobody can wall it off
either. When a carrier suspends or leaves, the
block they held is put back: it falls from the sky onto a random allowed tile —
never within a tile of where they stood — keeping its colour, with the usual
`sandbox:drop` hint. Only if no tile is allowed is it discarded; if that takes
the sandbox back under 120 blocks, a pending slow drop is brought forward
(never pushed back). All four numbers are trusted operator config
(`sandboxSpawnIntervalMs`, `sandboxSlowSpawnIntervalMs`,
`sandboxFastSpawnLimit`, `sandboxActionIntervalMs`), clamped by
`resolveRoomConfig`.

**Joiners get the whole state.** The server reserves a 64 KB state encode
buffer (`Encoder.BUFFER_SIZE`) before any room exists. Colyseus sizes a room's
full-state buffer once, and past it hands the per-client view encode a stale
copy, so a joiner receives everything beyond the default 8 KB as zeros. A full
sandbox is about 24 KB, and about 33.5 KB with 128 visible peers. See
`STATE_ENCODE_BUFFER_BYTES` in `room.ts`; `sandbox-capacity.test.ts` holds the
worst case to it.

**Interest sets are recomputed once per patch** (D-086), in the room's
`onBeforePatch`, not after every change. Each recompute is O(sessions²) and
exactly correct, which an incremental update of only the mover would not be;
doing it per move made it O(sessions³) a second, and one room of 100 sessions
saturated a core. Once per patch is also what keeps clients decoding: a view
that dropped and re-added the same entry between two encodes made
`@colyseus/schema@4.0.30` send a patch the clients could not apply (`"refId"
not found`), and that peer froze on their screens. The joiner's own view is
filled at once in `onJoin`, so its first full state already holds its
neighbours; everyone else's waits for the patch.

**Capacity.** A room holds 48 sessions (`MAX_CLIENTS_PER_ROOM`; operators may
set up to 128). When it is full, Colyseus's `joinOrCreate` puts the next joiner
into a new `street` room: nobody is refused, but the two rooms do not see each
other and each has its own sandbox and ball.

**Load test.** `npx tsx packages/lobby/tools/load-test.ts` forks a local,
instrumented lobby (`tools/load-test-server.ts`) and drives 10, 25, 50 and 100
real `LobbyClient` bots that walk, work the sandbox and see 20 ms of uplink
jitter. It reports tick time, CPU, memory, bytes per client, patch size and
rate, join latency, dropped moves, how evenly an observer sees peers move and
any patch a client could not decode. It never takes an endpoint, so it cannot
be pointed at production.

---

## Building presence in v1

When a player enters a building, the client leaves or suspends lobby presence.
Other players see the avatar disappear. A nearby observer may therefore infer
the chosen building and visit timing from the last coordinate; that leak is an
explicitly accepted v1 trade-off (D-019).

### Presence areas (D-087)

Two interiors are shared instead: the Exchange tower's roof (reached by lift)
and the Avatar Studio. A live session is in exactly one presence area —
`street`, `roof` or `studio` — and the room's interest sets only ever pair
sessions in the same area: the radius and cap apply within it, as on the
street. The area is the server's own bookkeeping, never a schema field, so no
client is told any other player's area, only shown the players in its own.
Every other interior (the Bank, the Vault, the Post Office, the Bridge, the
Exchange's ground and degen floors) still suspends.

- `area` switches a session from a suspend or from another area, keeping one
  entry and one `gameId`; views drop and pick it up at the next patch, once
  each. Like `resume` it stamps the move floor, so it is no faster a write
  channel than `move`. Leaving the street puts a carried block back and
  leaves the ball, as a suspend does.
- A shared room holds its players to its walkable tiles
  (`ROOF_PRESENCE_GRID`, `STUDIO_PRESENCE_GRID` in `@strkworld/shared`, kept
  equal to the World's rooms by a World test): a placement must land on one,
  and a move must land on one without its straight line crossing a solid tile
  (a step within one tile may clip a corner; no wall in either room is thinner
  than a tile). The street keeps its clamp to the world.
- A malformed switch, or one off the area's tiles, suspends the session: a
  client that disagrees with the room about where it stands is seen by no one
  rather than in the wrong place.
- The sandbox, the ball and the sky drops are street-only: a room's
  coordinates overlap the street's (the roof lies over the tower's footprint,
  the Studio is drawn over the hidden street by the pitch), so a room's
  players never count as on the street.
- `LobbyClient.enterArea` withholds peers until the room's copy of its own
  avatar shows the switch, so the area left is never drawn in the area
  entered; a suspended client is shown nobody.
- Overflow (D-086) is per room: a full room still sends the next joiner to a
  new one, and each room has its own street, roof and Studio.

Suspend **erases** the entry rather than hiding it — the position is discarded,
not retained — and `resume` takes a fresh placement from the client. The
identifier stays reserved to the connection while suspended so nobody else can
take it.

The lobby still never receives an entry event or building ID. Financial
submission remains a separate privacy problem: where the route permits it, the
backend decouples prepared-action broadcast from the avatar event. That
mitigation is bounded and must not be described as defeating timing
correlation (D-015).

---

## Dependencies

Assembled from the narrow packages, never the `colyseus` meta-package:

```
@colyseus/core          0.17.50
@colyseus/ws-transport  0.17.13
@colyseus/schema        4.0.30    (required peer of core; the room schema)
@colyseus/sdk           0.17.43   (client wrapper)
express                 5.2.1     (see below)
```

The meta-package pulls in a monitor, a playground and an HTTP surface this
server has no use for, and every one of those is another place a
per-connection detail could surface. `colyseus.js` is the legacy client and is
not used; `@colyseus/sdk` replaces it.

`express` is declared an **optional** peer dependency by `ws-transport`, but
its build imports it at the top level, so the transport cannot be loaded
without it. It is a direct dependency here for that reason and for no other —
nothing in this package uses it.

---

## Tests

| File | Covers |
|---|---|
| `policy.test.ts` | Normalisers, throttle, interest selection |
| `presence.test.ts` | Admission, server-minted id, movement, suspend/resume, counters |
| `privacy.test.ts` | Schema field sets (presence incl. `carrying`, sandbox column), **attacker-config model**, suspend, randomised leak hunts, sandbox anonymity on the shared wire |
| `sandbox-rules.test.ts` | Every pick/place rule and boundary (occupancy included), spawn avoidance/caps with seeded draws, `returnCarried` and conservation, release, snapshot immutability, block accounting |
| `sandbox.test.ts` | Registry wiring: payload validation, action floor, occupancy, carried blocks falling back on suspend/leave (conservation, incl. the pick-suspend-resume loop), spawn inputs, schema mirror through a real decoder |
| `client-sandbox.test.ts` | The wrapper's sandbox surface against a transport double: fail-closed decoding, change-only delivery, listener isolation, client floor |
| `sandbox-room.test.ts` | Real server: shared columns across interest, drop broadcast and ordering, pick/place round trip, hostile payloads, server floor, carried blocks falling back on suspend/leave |
| `sandbox-capacity.test.ts` | Real server: a late joiner receives the worst-case sandbox (900 blocks over all 784 tiles) exactly, with no encoder overflow; the worst case plus 128 peers fits one buffer |
| `client.test.ts` | The wrapper against a real server or transport double — idempotent connect, attacker-config over the wire, send-rate floor, FIFO status/peer transitions |
| `client-listener.test.ts` | Listener generation ownership and callback isolation without network I/O |
| `client-reconcile.test.ts` | The final position lands despite a server-dropped move |
| `client-drop.test.ts` | A server drop is reported as `server-dropped` |

`privacy.test.ts` is the point of this package. The vocabulary it scans for
lives in `src/testing/forbidden-vocabulary.json` rather than in TypeScript,
because check 5 of `scripts/check-invariants.sh` fails the build on those words
appearing in any lobby `.ts` file — a test that spelled them in TypeScript
would trip the very gate it exists to reinforce.

The `client-reconcile`, `client-drop`, `sandbox-room` and `sandbox-capacity`
suites each live in their own file with a single server: Colyseus's matchmaker is a process-global, so a test that
shuts a server down (or needs a differently tuned one) must not share a process
with another server. Vitest isolates test files, so one server per file keeps
them from corrupting each other.
