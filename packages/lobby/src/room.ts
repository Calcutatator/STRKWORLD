/**
 * The Colyseus room. Wiring only — every rule lives in `presence.ts`,
 * `policy.ts`, `sandbox.ts`, `sandbox-rules.ts`, `football.ts` and
 * `football-rules.ts`.
 *
 * The room's whole client-facing surface is six message types and a join
 * payload, and none of them has a field for anything the lobby is forbidden
 * to hold. That is the enforcement: not a filter that strips money out of
 * traffic, but a surface with nowhere to put it. The two sandbox verbs
 * (D-060) take a tile and nothing else, and the two sandbox broadcasts, a sky
 * drop and a burst (D-071), each name a tile and nothing else. The kick
 * (D-078) takes nothing at all, and the goal broadcast names a side.
 *
 * ## Configuration is trusted; onCreate options are not
 *
 * Under Colyseus matchmaking, `onCreate` is called with
 * `merge({}, clientOptions, handlerOptions)` — and `clientOptions` is the join
 * payload of whichever client happened to create the room, i.e. attacker
 * input. When this room first shipped it read its config (sprite list,
 * capacity, interest radius, rate floor, world bounds) straight out of that
 * argument, so one unauthenticated `POST /matchmake/joinOrCreate` could set the
 * room's entire configuration — including a `spriteKeys`/`defaultSprite`
 * allowlist the attacker wrote, through which a hex id and a token amount
 * reached honest players' screens. That is a direct break of "the lobby never
 * sees money".
 *
 * The fix, defence in depth:
 *   1. This class reads config only from `this.roomConfig`, a field set at
 *      construction from a trusted source. Its `onCreate` argument is ignored
 *      for configuration entirely — treated as the untrusted input it is.
 *   2. `startPresenceServer` additionally passes the trusted config as
 *      define-time handler options, so even Colyseus's own merge favours it
 *      (handler options are merged last and win on key collision).
 *
 * A server operator configures the room through `definePresenceRoom(config)`
 * or `startPresenceServer({ room })`, both of which run in the trusted server
 * process. A client cannot reach either.
 *
 * Reconnection tokens are deliberately not used. A reconnection token would
 * be an identifier that outlives a connection, and the point of an ephemeral
 * session is that nothing does.
 */

import { Room, ServerError, type Client, type Delayed } from '@colyseus/core';
import { Encoder, StateView } from '@colyseus/schema';
import { FOOTBALL_TICK_MS, type FootballSide, type GameId, type SandboxTile } from '@strkworld/shared';
import {
  DEFAULT_ROOM_CONFIG,
  MESSAGE,
  SERVER_MESSAGE,
  type PresenceRoomConfig,
} from './config.js';
import {
  LobbyPresence,
  type MoveRequest,
  type PlacementRequest,
  type PresenceCounters,
} from './presence.js';
import type { LobbyState, PresenceEntry } from './state.js';

/**
 * The size every room state encode buffer starts at, in bytes.
 *
 * ⚠ Not a tuning knob — a correctness floor. `@colyseus/core@0.17.50`'s
 * `SchemaSerializer.getFullState` (the full state a joining client receives)
 * encodes the shared state into a `fullEncodeBuffer` it allocated once, at
 * `Encoder.BUFFER_SIZE` (8 KB by default). When that overflows,
 * `@colyseus/schema@4.0.30`'s `Encoder.encode` re-encodes into a grown copy
 * and returns it — but the serializer keeps its reference to the old buffer
 * and hands *that* to the per-client `encodeAllView`, so every shared byte
 * past 8 KB reaches the joiner as zeros. With `peers` filtered by a
 * `StateView`, every joiner takes that path. D-060's sandbox alone is about
 * 24 KB at its worst (900 blocks over all 784 tiles), about 33.5 KB with 128
 * visible peers: a late joiner would see a corrupted sandbox (and the server
 * logs "buffer overflow" per join). 64 KB keeps the whole worst case inside
 * the first buffer, so the stale-buffer path is never taken.
 */
export const STATE_ENCODE_BUFFER_BYTES = 64 * 1024;

/**
 * Raise `Encoder.BUFFER_SIZE` to `STATE_ENCODE_BUFFER_BYTES` if it is lower.
 *
 * Process-wide and read only when a room's serializer and encoder are built
 * (its first `state` assignment), so it must run before any room exists:
 * `startPresenceServer` calls it before defining the room, and `onCreate`
 * calls it again before assigning state, for rooms composed without it.
 * Idempotent; never lowers a larger value set elsewhere.
 */
export function reserveStateEncodeBuffer(): void {
  if (!(Encoder.BUFFER_SIZE >= STATE_ENCODE_BUFFER_BYTES)) {
    Encoder.BUFFER_SIZE = STATE_ENCODE_BUFFER_BYTES;
  }
}

/**
 * Close code used when a join is refused.
 *
 * The reason travels as a plain word — `at-capacity`, `bad-placement` — which
 * is useful to a client author and says nothing about any player.
 */
export const PRESENCE_REFUSED = 4400;

export class PresenceRoom extends Room<{ state: LobbyState }> {
  /**
   * The room's trusted configuration.
   *
   * A field, not an `onCreate` argument, so its value comes from the server
   * process at construction and never from a client's join payload. The base
   * class ships the frozen defaults; `definePresenceRoom` returns a subclass
   * that overrides this with an operator-resolved config.
   */
  protected roomConfig: PresenceRoomConfig = DEFAULT_ROOM_CONFIG;

  #registry = new LobbyPresence();

  /** The pending sky drop, while anyone is on the street. D-060. */
  #spawnTimer: Delayed | undefined;

  /** The ball's step, while anyone is on or near the pitch. D-078. */
  #footballTimer: Delayed | undefined;

  /** Aggregate counters for this room. Never per-connection. */
  get counters(): PresenceCounters {
    return this.#registry.counters();
  }

  /**
   * @param _untrustedOptions — Colyseus passes `merge({}, clientOptions,
   * handlerOptions)` here. It is deliberately ignored: configuration comes from
   * `this.roomConfig`, and reading it from this argument is the exact bug the
   * class comment describes. The parameter is named to make an accidental read
   * of it stand out in review.
   */
  override onCreate(_untrustedOptions?: unknown): void {
    const config = this.roomConfig;
    // Before `this.state` is assigned: that builds the serializer, which
    // sizes its full-state buffer from Encoder.BUFFER_SIZE exactly once.
    reserveStateEncodeBuffer();
    this.#registry = new LobbyPresence({
      ...config,
      onSandboxDrop: (tile) => this.#broadcastDrop(tile),
      onSandboxBurst: (tile) => this.#broadcastBurst(tile),
    });
    this.state = this.#registry.state;

    this.maxClients = config.capacity;
    this.patchRate = config.patchRateMs;
    this.autoDispose = true;

    /*
     * Two independent ceilings. The registry's throttle silently drops moves
     * that arrive too fast, because a superseded position is worthless; this
     * one disconnects a client that ignores the rate entirely. The client
     * wrapper floors its own send interval so it cannot reach this ceiling.
     */
    this.maxMessagesPerSecond = config.maxMessagesPerSecond;

    this.onMessage(MESSAGE.move, (client: Client, payload: MoveRequest) => {
      const outcome = this.#registry.move(
        client.sessionId,
        payload ?? {},
        performance.now(),
      );
      if (outcome === 'applied') {
        this.#syncViews();
        this.#scheduleFootball();
      }
    });

    this.onMessage(MESSAGE.suspend, (client: Client) => {
      if (this.#registry.suspend(client.sessionId)) {
        this.#syncViews();
        this.#scheduleSpawn();
        this.#scheduleFootball();
      }
    });

    this.onMessage(MESSAGE.resume, (client: Client, payload: PlacementRequest) => {
      if (this.#registry.resume(client.sessionId, payload ?? {}, performance.now())) {
        this.#syncViews();
        this.#scheduleSpawn();
        this.#scheduleFootball();
      }
    });

    /*
     * D-060. The payload is untrusted and read only for an integer tile; the
     * actor's position is the one the registry already holds. Every refusal
     * — malformed, throttled, out of reach — is silent: the client learns
     * the outcome from the shared state, and a refusal leaks nothing. No view
     * sync is needed, because neither verb moves anyone. A place that bursts
     * the sandbox (D-071) empties it, so the rain is re-paced after one.
     */
    this.onMessage(MESSAGE.sandboxPick, (client: Client, payload: unknown) => {
      this.#registry.pickBlock(client.sessionId, payload, performance.now());
    });

    this.onMessage(MESSAGE.sandboxPlace, (client: Client, payload: unknown) => {
      if (this.#registry.placeBlock(client.sessionId, payload, performance.now()) === 'applied') {
        this.#scheduleSpawn();
      }
    });

    /*
     * D-078. The payload is never read: the kicker's position and facing are
     * the ones the registry holds, and the ball's is the room's own. A
     * refused kick — throttled, out of reach, play not live — is silent; the
     * ball in state is the only answer.
     */
    this.onMessage(MESSAGE.kick, (client: Client) => {
      this.#registry.kickBall(client.sessionId, performance.now());
    });
  }

  override onJoin(client: Client, options?: unknown): void {
    const outcome = this.#registry.admit(
      client.sessionId,
      (options ?? {}) as PlacementRequest,
    );
    if (outcome.ok === false) {
      throw new ServerError(PRESENCE_REFUSED, outcome.reason);
    }
    client.view = new StateView();
    // Tell the client the identifier the server minted for it, so it can find
    // its own avatar in the shared state. Nothing about any other player.
    client.send(SERVER_MESSAGE.welcome, { gameId: outcome.gameId satisfies GameId });
    this.#syncViews();
    this.#scheduleSpawn();
    this.#scheduleFootball();
  }

  override onLeave(client: Client): void {
    // Colyseus also routes a failed onJoin through onLeave, so this must be
    // safe for a session the registry never admitted. release() is a no-op on
    // an unknown session, so it is.
    this.#registry.release(client.sessionId);
    this.#syncViews();
    this.#scheduleSpawn();
    this.#scheduleFootball();
  }

  override onDispose(): void {
    this.#spawnTimer?.clear();
    this.#spawnTimer = undefined;
    this.#footballTimer?.clear();
    this.#footballTimer = undefined;
  }

  /**
   * Keep the ball's step running while anyone on the street is on or near
   * the pitch, and stopped otherwise (D-078). Called after every change to
   * where anyone is; idempotent.
   *
   * A room clock interval, which fires as the clock ticks — at the patch
   * rate, just before each patch is encoded — and steps the simulation
   * through every whole `FOOTBALL_TICK_MS` up to now, so each patch carries
   * the latest ball, dated by its tick. `performance.now()` is the one time
   * base, as for moves.
   */
  #scheduleFootball(): void {
    const running = this.#registry.keepFootballRunning(performance.now());
    if (running && this.#footballTimer === undefined) {
      this.#footballTimer = this.clock.setInterval(() => this.#footballTick(), FOOTBALL_TICK_MS);
    } else if (!running && this.#footballTimer !== undefined) {
      this.#footballTimer.clear();
      this.#footballTimer = undefined;
    }
  }

  #footballTick(): void {
    try {
      for (const event of this.#registry.footballTick(performance.now())) {
        if (event.kind === 'goal') this.#broadcastGoal(event.side);
      }
    } catch {
      // The room clock runs this outside any handler; an escape would take
      // the process down with every room in it. A fixed, content-free line.
      console.error('lobby: football step failed');
    }
  }

  /**
   * Tell every client a goal went in for `side` (D-078). At once, ahead of
   * the patch that raises the score, so the celebration starts with the ball
   * still in the net. The payload is the side alone: nobody scored it.
   */
  #broadcastGoal(side: FootballSide): void {
    this.broadcast(SERVER_MESSAGE.goal, { side });
  }

  /**
   * Keep exactly one sky drop pending while anyone is on the street, and none
   * otherwise (D-060).
   *
   * A room clock timeout rather than an interval, re-armed after every drop,
   * so the delay can switch from fast to slow as the sandbox fills. Called
   * after every change to who is on the street — which is also every moment
   * a carried block can leave the game (put back where no tile is allowed) —
   * and idempotent.
   *
   * A pending drop is only ever brought forward, never pushed back: when a
   * lost block or a burst (D-071) takes the sandbox back under the fast
   * limit, a drop armed with the slow delay is re-armed with the fast one if
   * that lands sooner.
   */
  #scheduleSpawn(): void {
    if (!this.#registry.hasLivePlayers) {
      this.#spawnTimer?.clear();
      this.#spawnTimer = undefined;
      return;
    }
    const delay = this.#registry.nextSpawnDelayMs();
    const pending = this.#spawnTimer;
    if (pending !== undefined) {
      if (!(pending.time - pending.elapsedTime > delay)) return;
      pending.clear();
    }
    this.#spawnTimer = this.clock.setTimeout(() => this.#spawnTick(), delay);
  }

  #spawnTick(): void {
    this.#spawnTimer = undefined;
    try {
      // A landed block reaches clients through `#broadcastDrop`.
      if (this.#registry.hasLivePlayers) this.#registry.spawnBlock();
    } catch {
      // The room clock runs this outside any handler; an escape would take
      // the process down with every room in it. A fixed, content-free line.
      console.error('lobby: sandbox drop failed');
    }
    this.#scheduleSpawn();
  }

  /**
   * Tell every client a block fell onto `tile` — a spawn, or a carried block
   * put back when its carrier left the street. After the next patch, so a
   * client already holds the block by the time the hint arrives; the payload
   * is the tile alone, whoever caused it.
   */
  #broadcastDrop(tile: SandboxTile): void {
    this.broadcast(
      SERVER_MESSAGE.sandboxDrop,
      { x: tile.x, y: tile.y },
      { afterNextPatch: true },
    );
  }

  /**
   * Tell every client the sandbox burst at `tile` (D-071): a block would have
   * made that column taller than `SANDBOX_BURST_HEIGHT`, so every placed
   * block is gone. Sent at once, not after the next patch, so it arrives
   * while a client still holds the blocks and can throw them from where they
   * stand; the patch that removes them follows. The payload is the tile
   * alone, whoever caused it.
   */
  #broadcastBurst(tile: SandboxTile): void {
    this.broadcast(SERVER_MESSAGE.sandboxBurst, { x: tile.x, y: tile.y });
  }

  /**
   * Recompute every observer's interest set.
   *
   * Run after any change to the map, including an accepted move. That is
   * O(sessions²) per change, which sounds worse than it is: the room caps at
   * a few dozen sessions and the per-session rate floor caps moves at 20/second,
   * so the worst case is a few tens of thousands of coordinate comparisons per
   * second. Recomputing everything keeps the nearest-first cap exactly
   * correct, which an incremental update of only the mover would not.
   */
  #syncViews(): void {
    for (const client of this.clients) {
      const view = (client.view ??= new StateView());
      const wanted = new Set<PresenceEntry>(
        this.#registry.visibleTo(client.sessionId),
      );
      const own = this.#registry.entryFor(client.sessionId);
      if (own !== undefined) wanted.add(own);

      this.#registry.peers.forEach((entry) => {
        const visible = view.has(entry);
        if (wanted.has(entry)) {
          if (!visible) view.add(entry);
        } else if (visible) {
          view.remove(entry);
        }
      });
    }
  }
}

/**
 * Build a room class bound to a trusted configuration.
 *
 * Returns a subclass whose `roomConfig` field is the given config, captured in
 * the class definition rather than passed through matchmaking. `server.define`
 * takes a class, so this is how the trusted server process hands a room its
 * configuration without any of it travelling as client-reachable options.
 */
export function definePresenceRoom(
  config: PresenceRoomConfig,
): typeof PresenceRoom {
  // Own the operator's resolved configuration at class-definition time. A
  // room may be instantiated later by the matchmaker; retaining a mutable
  // caller object would let an intervening edit change its wire authority.
  const ownedConfig = Object.freeze({
    ...config,
    spriteKeys: Object.freeze([...config.spriteKeys]),
  });
  return class ConfiguredPresenceRoom extends PresenceRoom {
    protected override roomConfig = ownedConfig;
  };
}
