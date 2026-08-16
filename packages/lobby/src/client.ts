/**
 * Client wrapper around `@colyseus/sdk`.
 *
 * Plain data in, plain data out. No Phaser, no React, no DOM: the consumer is
 * a Phaser scene in `packages/world` driven by the shell, and the scene should
 * receive arrays of numbers, not schema instances whose change callbacks it
 * would have to manage.
 *
 * ## The lifecycle contract
 *
 * **Nothing in this class performs network I/O except `connect`, `resume` and
 * `disconnect`, and those only when you call them.** Constructing a client
 * opens nothing. Subscribing with `onPeers` opens nothing. That rule exists
 * because the consumer mounts under React StrictMode, where a scene
 * constructor, a `create()` or a mount effect runs twice: a join hidden inside
 * any of those produces two presence entries for one player, and the second
 * one is a ghost that walks around after the real player leaves.
 *
 * So joining is an explicit, imperative, shell-driven call. As defence in
 * depth, `connect` is idempotent — a second call while connected returns
 * immediately, and two concurrent calls share one attempt and produce one
 * presence entry. `client.test.ts` asserts exactly that against a real server.
 *
 * Suspend and resume follow the same rule: the shell calls `suspend()` on
 * interior entry (D-019) and `resume()` on exit. Neither happens by itself.
 */

import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import type { Facing, GameId } from '@strkworld/shared';
import {
  DEFAULT_ROOM_NAME,
  DEFAULT_SPRITE,
  MESSAGE,
  MIN_UPDATE_INTERVAL_MS,
} from './config';
import { createGameId } from './policy';
import type { LobbyState } from './state';

export type LobbyStatus =
  /** Constructed, never connected. */
  | 'idle'
  /** A join is in flight. */
  | 'connecting'
  /** On the street and visible to nearby peers. */
  | 'connected'
  /** Connected but off the street. See D-019. */
  | 'suspended'
  /** Left, by request or because the server closed. Reusable. */
  | 'closed';

/** One nearby player, as plain data. */
export interface PeerSnapshot {
  readonly gameId: string;
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
  readonly sprite: string;
}

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly facing?: Facing;
}

export interface LobbyClientOptions {
  /** For example `ws://localhost:2567`. */
  endpoint: string;
  /** Where the avatar first appears. */
  start: Placement;
  /**
   * Ephemeral session identifier. Generated if omitted, which is the normal
   * case. Supply one only to make a test deterministic — never derive it from
   * anything that outlives the session.
   */
  gameId?: GameId;
  /** Cosmetic. An unrecognised key is replaced by the server's default. */
  sprite?: string;
  /** Defaults to `street`. */
  roomName?: string;
  /**
   * Floor between two position messages, in ms. Defaults to the server's own
   * floor, so the world can call `updatePosition` every frame for free.
   */
  minSendIntervalMs?: number;
}

type PeersListener = (peers: readonly PeerSnapshot[]) => void;

export class LobbyClient {
  readonly #options: LobbyClientOptions;
  readonly #gameId: GameId;
  readonly #minSendIntervalMs: number;
  readonly #listeners = new Set<PeersListener>();

  #room: ColyseusRoom<unknown, LobbyState> | null = null;
  #joining: Promise<void> | null = null;
  #status: LobbyStatus = 'idle';

  #lastSentAt = 0;
  #lastSent: Required<Placement> | null = null;
  #queued: Required<Placement> | null = null;
  #flushHandle: ReturnType<typeof setTimeout> | null = null;

  /** Pure. Opens no connection. */
  constructor(options: LobbyClientOptions) {
    this.#options = options;
    this.#gameId = options.gameId ?? createGameId();
    this.#minSendIntervalMs = options.minSendIntervalMs ?? MIN_UPDATE_INTERVAL_MS;
  }

  get gameId(): GameId {
    return this.#gameId;
  }

  get status(): LobbyStatus {
    return this.#status;
  }

  /**
   * Join the room. Explicit, imperative, and safe to call twice.
   *
   * Concurrent callers share one attempt; a caller that arrives after the join
   * succeeded returns immediately. Either way the room holds one entry for
   * this client.
   */
  async connect(): Promise<void> {
    if (this.#room !== null) return;
    if (this.#joining !== null) return this.#joining;

    this.#status = 'connecting';
    this.#joining = this.#join();
    try {
      await this.#joining;
    } finally {
      this.#joining = null;
    }
  }

  /**
   * Report where the avatar is.
   *
   * Cheap enough to call from an update loop: identical positions are
   * discarded, and anything inside the send floor is held and flushed once the
   * floor passes, so the last position of a movement always arrives. A call
   * made while suspended or disconnected does nothing.
   */
  updatePosition(x: number, y: number, facing: Facing = 'down'): void {
    if (this.#status !== 'connected' || this.#room === null) return;

    const next = { x: Math.round(x), y: Math.round(y), facing };
    if (samePlacement(next, this.#lastSent)) return;

    const now = Date.now();
    const elapsed = now - this.#lastSentAt;
    if (elapsed >= this.#minSendIntervalMs) {
      this.#send(next, now);
      return;
    }

    this.#queued = next;
    if (this.#flushHandle === null) {
      this.#flushHandle = setTimeout(
        () => this.#flush(),
        this.#minSendIntervalMs - elapsed,
      );
    }
  }

  /**
   * Leave presence without closing the connection (D-019).
   *
   * The shell calls this when the player steps into an interior. Other players
   * see the avatar disappear; the server erases the position rather than
   * hiding it. No-op unless connected.
   */
  suspend(): void {
    if (this.#status !== 'connected' || this.#room === null) return;
    this.#cancelQueued();
    this.#room.send(MESSAGE.suspend);
    this.#status = 'suspended';
    this.#lastSent = null;
  }

  /**
   * Reappear on the street after a suspend.
   *
   * A placement is required because the server discarded the old one. Throws
   * if this client was never connected or has been disconnected: reconnecting
   * is the shell's decision to make explicitly, not a side effect of resuming.
   */
  resume(placement: Placement): void {
    if (this.#status === 'connected') return;
    if (this.#status !== 'suspended' || this.#room === null) {
      throw new Error(`resume() requires a suspended client, not "${this.#status}"`);
    }
    const next = {
      x: Math.round(placement.x),
      y: Math.round(placement.y),
      facing: placement.facing ?? ('down' as Facing),
    };
    this.#room.send(MESSAGE.resume, {
      ...next,
      sprite: this.#options.sprite ?? DEFAULT_SPRITE,
    });
    this.#status = 'connected';
    this.#lastSent = next;
    this.#lastSentAt = Date.now();
  }

  /**
   * Subscribe to nearby players. Returns an unsubscribe function.
   *
   * Opens nothing. The listener fires once immediately with the current
   * snapshot — a synchronous local read, not a request — and then on every
   * state change until it is removed.
   */
  onPeers(listener: PeersListener): () => void {
    this.#listeners.add(listener);
    listener(this.peers());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The current nearby players. Excludes this client's own avatar. */
  peers(): readonly PeerSnapshot[] {
    const room = this.#room;
    if (room === null) return [];
    const out: PeerSnapshot[] = [];
    room.state?.peers?.forEach((entry) => {
      if (entry.gameId === this.#gameId) return;
      out.push({
        gameId: entry.gameId,
        x: entry.position.x,
        y: entry.position.y,
        facing: entry.facing as Facing,
        sprite: entry.sprite,
      });
    });
    return out;
  }

  /** Leave the room. The client can be connected again afterwards. */
  async disconnect(): Promise<void> {
    this.#cancelQueued();
    const room = this.#room;
    this.#room = null;
    this.#status = 'closed';
    if (room !== null) await room.leave(true);
    this.#emit();
  }

  async #join(): Promise<void> {
    const sdk = new ColyseusClient(this.#options.endpoint);
    try {
      const room = await sdk.joinOrCreate<LobbyState>(
        this.#options.roomName ?? DEFAULT_ROOM_NAME,
        {
          gameId: this.#gameId,
          x: Math.round(this.#options.start.x),
          y: Math.round(this.#options.start.y),
          facing: this.#options.start.facing ?? 'down',
          sprite: this.#options.sprite ?? DEFAULT_SPRITE,
        },
      );
      room.onStateChange(() => this.#emit());
      room.onLeave(() => {
        this.#room = null;
        this.#status = 'closed';
        this.#cancelQueued();
        this.#emit();
      });
      this.#room = room;
      this.#status = 'connected';
      this.#lastSentAt = 0;
      this.#lastSent = null;
      this.#emit();
    } catch (error) {
      this.#status = 'idle';
      throw error;
    }
  }

  #send(placement: Required<Placement>, now: number): void {
    this.#room?.send(MESSAGE.move, placement);
    this.#lastSent = placement;
    this.#lastSentAt = now;
    this.#queued = null;
  }

  #flush(): void {
    this.#flushHandle = null;
    const queued = this.#queued;
    if (queued === null || this.#status !== 'connected') return;
    this.#send(queued, Date.now());
  }

  #cancelQueued(): void {
    if (this.#flushHandle !== null) {
      clearTimeout(this.#flushHandle);
      this.#flushHandle = null;
    }
    this.#queued = null;
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const snapshot = this.peers();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function samePlacement(
  a: Required<Placement>,
  b: Required<Placement> | null,
): boolean {
  return b !== null && a.x === b.x && a.y === b.y && a.facing === b.facing;
}
