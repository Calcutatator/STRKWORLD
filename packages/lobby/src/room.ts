/**
 * The Colyseus room. Wiring only — every rule lives in `presence.ts`,
 * `policy.ts`, `sandbox.ts`, `sandbox-rules.ts`, `football.ts`,
 * `football-rules.ts`, `arena.ts` and `arena-rules.ts`.
 *
 * The room's whole client-facing surface is ten message types and a join
 * payload, and none of them has a field for anything the lobby is forbidden
 * to hold. The area verb (D-087) names one of the presence areas —
 * `street`, `roof`, `studio`, `bunker` (D-112) — and a placement, and the area is kept on the
 * server's side: no field of the state says which area anyone is in. That is the enforcement: not a filter that strips money out of
 * traffic, but a surface with nowhere to put it. The two sandbox verbs
 * (D-060) take a tile and nothing else, and the two sandbox broadcasts, a sky
 * drop and a burst (D-071), each name a tile and nothing else. The kick
 * (D-078) takes nothing at all, and the goal broadcast names a side. The
 * arena ring's three verbs (D-114) take nothing either, and the ring answers
 * only through its one view-filtered state entry, sent to arena members.
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

import { ClientState, Room, ServerError, type Client, type Delayed } from '@colyseus/core';
import { Encoder, StateView } from '@colyseus/schema';
import { FOOTBALL_TICK_MS, type FootballSide, type GameId, type SandboxTile } from '@strkworld/shared';

/**
 * How often the room runs the arena ring's clock while a fight is on, in ms
 * (D-114): deadlines land within this, and `secondsLeft` is refreshed. Only
 * while the ring has a deadline; an idle ring costs nothing.
 */
export const ARENA_TICK_MS = 100;
import {
  DEFAULT_ROOM_CONFIG,
  MESSAGE,
  SERVER_MESSAGE,
  type PresenceRoomConfig,
} from './config.js';
import {
  LobbyPresence,
  type AreaRequest,
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

  /** The arena ring's clock, while it has a deadline. D-114. */
  #arenaTimer: Delayed | undefined;

  /**
   * Set when someone moved, arrived, left, stepped inside or came back out:
   * every interest set is stale until the next patch. D-086.
   */
  #viewsStale = false;

  /** Set by an accepted move: the ball's timer is stale until the next patch. */
  #moved = false;

  /** Scratch set for `#syncView`, reused so a sync allocates no set. */
  readonly #wanted = new Set<PresenceEntry>();

  /**
   * Patches begun so far: the clock `#erasedAt` and `#held` count in. A
   * change made before `onBeforePatch` returns is in that patch's encode,
   * since nothing runs between the two.
   */
  #patches = 0;

  /**
   * Sessions whose entry was erased (a suspend, or a refused area switch),
   * by the value of `#patches` then. D-087: see `#placeAgain`.
   */
  readonly #erasedAt = new Map<string, number>();

  /** Placements held by `#placeAgain` until their session's erasure has gone out. */
  readonly #held = new Map<string, () => void>();

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

    /*
     * The one high-rate message. An accepted move only marks the room's
     * interest sets stale: they are recomputed once, just before the next
     * patch is encoded (`onBeforePatch`), which is the only moment a view is
     * read. D-086.
     */
    this.onMessage(MESSAGE.move, (client: Client, payload: MoveRequest) => {
      const outcome = this.#registry.move(
        client.sessionId,
        payload ?? {},
        performance.now(),
      );
      if (outcome === 'applied') {
        this.#viewsStale = true;
        this.#moved = true;
      } else if (outcome === 'refused') {
        // D-106: a step up with no jump to carry it. Tell the climber where
        // the room holds them, so they stand there again.
        const at = this.#registry.resyncFor(client.sessionId, performance.now());
        if (at !== null) client.send(SERVER_MESSAGE.resync, { x: at.x, y: at.y });
      }
    });

    this.onMessage(MESSAGE.suspend, (client: Client) => {
      // A placement still held is dropped: the player went back inside
      // before it was applied.
      this.#held.delete(client.sessionId);
      if (this.#erasing(client.sessionId, () => this.#registry.suspend(client.sessionId, performance.now()))) {
        this.#viewsStale = true;
        this.#scheduleSpawn();
        this.#scheduleFootball();
        this.#scheduleArena();
      }
    });

    this.onMessage(MESSAGE.resume, (client: Client, payload: PlacementRequest) => {
      this.#placeAgain(client.sessionId, () => {
        if (this.#registry.resume(client.sessionId, payload ?? {}, performance.now())) {
          this.#viewsStale = true;
          this.#scheduleSpawn();
          this.#scheduleFootball();
        }
      });
    });

    /*
     * D-087. Go live in a presence area. The registry checks the placement
     * against the area entered; a refusal suspends the session, silently,
     * and the client learns it from its own entry. Views are synced at the next patch, so a switch
     * drops the avatar from one area's views and adds it to the other's in
     * the same encode. Leaving the street can return a carried block and
     * leaves the ball, so both timers are re-armed as for a suspend. A switch
     * that would place a session again in the patch that erased it is held
     * a patch (`#placeAgain`).
     */
    this.onMessage(MESSAGE.area, (client: Client, payload: AreaRequest) => {
      this.#placeAgain(client.sessionId, () => {
        // A refused switch suspends the session, so views are stale either way.
        this.#erasing(client.sessionId, () =>
          this.#registry.enterArea(client.sessionId, payload ?? {}, performance.now()),
        );
        this.#viewsStale = true;
        this.#scheduleSpawn();
        this.#scheduleFootball();
        this.#scheduleArena();
      });
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

    /*
     * D-097. The payload is never read. An accepted jump bumps the sender's
     * own `jumps` counter, which the next patch carries only to the views
     * that already hold its entry: the same area, the same interest radius.
     * No view sync: nobody moved.
     */
    this.onMessage(MESSAGE.jump, (client: Client) => {
      this.#registry.jump(client.sessionId, performance.now());
    });

    /*
     * D-114. The arena ring's three intents. No payload is read: the claim
     * is judged from where the registry holds the sender, an attack from
     * that position and facing, and damage is the rules' constant. Colyseus
     * hands this room one message at a time, so of two claims in one patch
     * the first takes the ring and the second finds it busy. Every refusal is
     * silent; the ring entry is the only answer. An accepted claim moves the
     * fighter into the ring, so views are stale; the clock runs while the
     * ring has a deadline.
     */
    this.onMessage(MESSAGE.arenaClaim, (client: Client) => {
      if (this.#registry.arenaClaim(client.sessionId, performance.now()) === 'applied') {
        this.#viewsStale = true;
      }
      this.#scheduleArena();
    });

    this.onMessage(MESSAGE.arenaAttack, (client: Client) => {
      this.#registry.arenaAttack(client.sessionId, performance.now());
      this.#scheduleArena();
    });

    this.onMessage(MESSAGE.arenaLeave, (client: Client) => {
      this.#registry.arenaLeave(client.sessionId, performance.now());
      this.#scheduleArena();
    });

    /*
     * D-128. The block's two intents and the emperor's box. A block changes
     * no position, so no view goes stale and no clock needs starting beyond
     * the one the fight already runs. An accepted press at the box moves the
     * champion onto (or off) the throne, so views are stale then.
     */
    this.onMessage(MESSAGE.arenaBlock, (client: Client) => {
      this.#registry.arenaBlock(client.sessionId, true, performance.now());
    });

    this.onMessage(MESSAGE.arenaUnblock, (client: Client) => {
      this.#registry.arenaBlock(client.sessionId, false, performance.now());
    });

    this.onMessage(MESSAGE.arenaSit, (client: Client) => {
      if (this.#registry.arenaSit(client.sessionId, performance.now()) === 'applied') {
        this.#viewsStale = true;
      }
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
    // The joiner's own view is filled at once, so the full state it is about
    // to receive already holds its avatar and its neighbours. It is then left
    // alone until the client acknowledges the join (`#syncViews` skips it):
    // patches are not encoded for a joining client, so every change queued
    // in its view meanwhile would reach it in one encode, and a peer that
    // left and re-entered its radius in that time would be the drop-and-re-add
    // this sync exists to prevent. Everyone else's view waits for the patch.
    client.view = new StateView();
    this.#syncView(client);
    this.#viewsStale = true;
    // Tell the client the identifier the server minted for it, so it can find
    // its own avatar in the shared state. Nothing about any other player.
    client.send(SERVER_MESSAGE.welcome, { gameId: outcome.gameId satisfies GameId });
    this.#scheduleSpawn();
    this.#scheduleFootball();
  }

  override onLeave(client: Client): void {
    // Colyseus also routes a failed onJoin through onLeave, so this must be
    // safe for a session the registry never admitted. release() is a no-op on
    // an unknown session, so it is.
    this.#registry.release(client.sessionId, performance.now());
    this.#held.delete(client.sessionId);
    this.#erasedAt.delete(client.sessionId);
    this.#viewsStale = true;
    this.#scheduleSpawn();
    this.#scheduleFootball();
    this.#scheduleArena();
  }

  /**
   * Bring every interest set, and the ball's timer, up to date with
   * everything since the last patch — once, just before the patch is encoded
   * (D-086).
   *
   * Once is the point, twice over. Recomputing on every accepted move made
   * each move O(sessions²), O(sessions³) a second: one room of 100 saturated
   * a core and its patch rate fell from 20 to about 10 a second. And a view that
   * changes more than once between two encodes can drop and re-add the same
   * entry inside one patch, which `@colyseus/schema@4.0.30` encodes so that
   * clients lose track of the entry: the SDK logs `"refId" not found` and
   * skips its updates, so that peer freezes on their screen. Syncing here
   * makes at most one change per entry per view per patch.
   */
  override onBeforePatch(): void {
    try {
      this.#releaseHeld();
      if (this.#viewsStale) {
        // Still stale while anyone is joining, so their view is brought up to
        // date on the first patch after they are in; and only cleared once
        // the sync has worked, so a failed one is retried on the next patch.
        this.#viewsStale = !this.#syncViews();
      }
      if (this.#moved) {
        this.#moved = false;
        this.#scheduleFootball();
      }
    } catch {
      // The patch interval runs this outside any handler; an escape would
      // take the process down with every room in it. A fixed, content-free
      // line, like the room clock's.
      console.error('lobby: interest sync failed');
    } finally {
      this.#patches += 1;
    }
  }

  /**
   * Run a registry call that may erase `sessionId`'s entry, and note it if
   * it did. Returns the call's result.
   */
  #erasing<T>(sessionId: string, call: () => T): T {
    const before = this.#registry.entryFor(sessionId);
    const result = call();
    if (before !== undefined && this.#registry.entryFor(sessionId) === undefined) {
      this.#erasedAt.set(sessionId, this.#patches);
    }
    return result;
  }

  /**
   * Put a session back into the shared state — a resume, or an area switch
   * — now, or once the patch that erases its previous entry has gone out.
   *
   * The two must not share a patch. `peers` is keyed by `gameId`, so erasing
   * an entry and placing its successor before the next encode makes one
   * `DELETE_AND_ADD` of that key, and `@colyseus/schema@4.0.30` filters that
   * one operation per view by the new entry alone: a view that held the old
   * entry and is not to see the new one (a street neighbour of a player
   * who went straight up to the roof) is sent nothing, and keeps a frozen
   * ghost of the old entry where it stood. Held a patch, the erasure reaches
   * every view that held the entry on its own, and the placement follows a
   * patch later, which each view takes or not as it would any arrival. A real
   * lift ride is longer than a patch; a back-to-back suspend and switch, or
   * suspend and resume, is not (D-087).
   *
   * The latest held placement wins, and one that arrives while another is
   * held is held too, so placements are applied in the order they came.
   */
  #placeAgain(sessionId: string, apply: () => void): void {
    if (this.#held.has(sessionId) || this.#erasedAt.get(sessionId) === this.#patches) {
      this.#held.set(sessionId, apply);
      return;
    }
    this.#erasedAt.delete(sessionId);
    apply();
  }

  /** Apply every held placement whose erasure an earlier patch carried. */
  #releaseHeld(): void {
    if (this.#held.size === 0) return;
    for (const [sessionId, apply] of [...this.#held]) {
      if ((this.#erasedAt.get(sessionId) ?? -1) >= this.#patches) continue;
      this.#held.delete(sessionId);
      this.#erasedAt.delete(sessionId);
      apply();
    }
  }

  override onDispose(): void {
    this.#spawnTimer?.clear();
    this.#spawnTimer = undefined;
    this.#footballTimer?.clear();
    this.#footballTimer = undefined;
    this.#arenaTimer?.clear();
    this.#arenaTimer = undefined;
  }

  /**
   * Keep the arena ring's clock running while the ring has a deadline, and
   * stopped otherwise (D-114). Called after every arena intent and every
   * change to who is in the room; idempotent.
   */
  #scheduleArena(): void {
    const active = this.#registry.arenaActive;
    if (active && this.#arenaTimer === undefined) {
      this.#arenaTimer = this.clock.setInterval(() => this.#arenaTick(), ARENA_TICK_MS);
    } else if (!active && this.#arenaTimer !== undefined) {
      this.#arenaTimer.clear();
      this.#arenaTimer = undefined;
    }
  }

  #arenaTick(): void {
    try {
      // The close returns the fighter to the gate: a move, so views are stale.
      if (this.#registry.arenaTick(performance.now())) this.#viewsStale = true;
    } catch {
      // The room clock runs this outside any handler; an escape would take
      // the process down with every room in it. A fixed, content-free line.
      console.error('lobby: arena step failed');
    }
    this.#scheduleArena();
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
   * Recompute every observer's interest set. Runs from `onBeforePatch`, at
   * most once per patch (D-086): O(sessions²) a patch, a few hundred
   * thousand coordinate comparisons a second at the hard cap. False when a
   * joining client was skipped and still needs its turn.
   */
  #syncViews(): boolean {
    let complete = true;
    for (const client of this.clients) {
      // A joining client's view stays as `onJoin` filled it until its full
      // state has been sent; the first patch after brings it up to date.
      if (client.state !== ClientState.JOINED) {
        complete = false;
        continue;
      }
      this.#syncView(client);
    }
    return complete;
  }

  /**
   * Make one observer's view hold exactly its own entry and the entries the
   * registry says it should see: inside the interest radius, nearest first,
   * capped; and, for an arena member only, the ring entry (D-114). Only the
   * difference is written, so an unchanged view costs the encoder nothing.
   */
  #syncView(client: Client): void {
    const view = (client.view ??= new StateView());
    const wanted = this.#wanted;
    wanted.clear();
    for (const entry of this.#registry.visibleTo(client.sessionId)) wanted.add(entry);
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
    wanted.clear();

    // D-114: the ring entry is in a view exactly while its client is live in
    // the arena. No one elsewhere is ever sent who is fighting.
    const ring = this.#registry.arenaRingEntry;
    const member = this.#registry.isArenaMember(client.sessionId);
    const holds = view.has(ring);
    if (member && !holds) view.add(ring);
    else if (!member && holds) view.remove(ring);
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
