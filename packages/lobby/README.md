# @strkworld/lobby

**Multiplayer presence. Deliberately the dumbest package in the repo.**

A Colyseus room that broadcasts where avatars are. That is all it does, and
that is all it is permitted to do.

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
- Player identity is an **ephemeral per-session `gameId`**, generated
  client-side, never derived from an address, discarded on disconnect.
- No persistence. When the room empties, nothing remains.

If a feature seems to need an address in the lobby, it needs a different
design. Raise it as a decision entry before writing code.

---

## What this owns

- The Colyseus room, its schema and its transport
- Position broadcast and interest management
- Ephemeral session identity

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

It prints the endpoint and nothing else, ever. There is no per-connection line
to print — joins, leaves and positions are exactly the things this package is
not allowed to record. Aggregate counters are available on the room
(`PresenceRoom.counters`) and name no individual player.

---

## The client wrapper

`LobbyClient` is what `packages/world` consumes. Plain data in, plain data out;
no Phaser, no React, no DOM.

```ts
import { LobbyClient } from '@strkworld/lobby/client';

const lobby = new LobbyClient({
  endpoint: 'ws://localhost:2567',
  start: { x: 400, y: 300 },
  sprite: 'avatar-3',
});

await lobby.connect();                        // explicit. never automatic
const stop = lobby.onPeers((peers) => scene.render(peers));
lobby.updatePosition(x, y, 'left');           // safe to call every frame
lobby.suspend();                              // on building entry (D-019)
lobby.resume({ x, y, facing: 'down' });       // on exit
await lobby.disconnect();
stop();
```

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

`updatePosition` is cheap enough for an update loop. It discards unchanged
positions, and anything inside the send floor is held and flushed once the
floor passes, so the final position of a movement always arrives.

`resume` throws if the client was never connected or has been disconnected.
Reconnecting is the shell's decision to make explicitly, not a side effect of
resuming.

---

## What travels

The room schema mirrors the frozen `PresenceState` from `@strkworld/shared`
field for field and adds nothing:

| Field | Type | Constrained to |
|---|---|---|
| `gameId` | string | Exactly 16 lowercase hex characters. Rejected otherwise |
| `position` | `{ x, y }` | Finite numbers, rounded to whole pixels, clamped to ±8192 |
| `facing` | string | One of `up` `down` `left` `right`. Substituted otherwise |
| `sprite` | string | A key from the room's sprite list. Substituted otherwise |

Every field is narrowed at the boundary, which is the second half of the
enforcement. A schema with the right field names but a free-form string in one
of them would still be a channel: a player could set their sprite to their own
address. Nothing outside those ranges reaches an entry.

The client-to-server vocabulary is three verbs — `move`, `suspend`, `resume` —
and a join payload. There is no message through which a client could tell the
room anything else, because there is no field for it.

---

## Rate and reach

**Throttling.** The server accepts at most one move per session per 50ms (20/s,
matching the patch rate). Anything earlier is dropped, never queued: a
superseded position is worthless and queueing would only add latency. A second,
much higher ceiling (`maxMessagesPerSecond`) disconnects a client that ignores
the rate entirely.

**Interest management.** An observer receives only peers inside a 640px square
box, nearest first, capped at 24. The radius alone would not bound traffic when
a crowd forms on one corner; the cap does, and it incidentally bounds how much
of the street any single observer can watch.

Both are enforced by Colyseus's `StateView` rather than by a filter the room
could forget to apply: an entry reaches a client only while it is in that
client's view.

Recomputing every observer's interest set after every change is O(sessions²).
That is fine at this size — the room caps at 48 sessions and moves are capped
at 20/s each, so the worst case is a few tens of thousands of coordinate
comparisons per second. It is also exactly correct, which an incremental update
of only the mover would not be.

---

## Building presence in v1

When a player enters a building, the client leaves or suspends lobby presence.
Other players see the avatar disappear. A nearby observer may therefore infer
the chosen building and visit timing from the last coordinate; that leak is an
explicitly accepted v1 trade-off (D-019).

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
| `presence.test.ts` | Admission, movement, suspend/resume, counters |
| `privacy.test.ts` | Schema field set, suspend, randomised leak hunt |
| `client.test.ts` | The wrapper against a real server on a real socket |

`privacy.test.ts` is the point of this package. The vocabulary it scans for
lives in `src/testing/forbidden-vocabulary.json` rather than in TypeScript,
because check 5 of `scripts/check-invariants.sh` fails the build on those words
appearing in any lobby `.ts` file — a test that spelled them in TypeScript
would trip the very gate it exists to reinforce.
