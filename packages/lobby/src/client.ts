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
 * opens nothing. Subscribing with `onPeers` or `onStatus` opens nothing. That
 * rule exists because the consumer mounts under React StrictMode, where a scene
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
 *
 * ## Identity is the server's to assign
 *
 * The session identifier is minted by the server and delivered to this client
 * in a one-off `welcome` message; `connect()` resolves only once it has
 * arrived, so `gameId` is known and self-filtering is correct from the first
 * `peers()` call. The client does not choose its own identity.
 *
 * ## Sending is floored and reconciled
 *
 * `updatePosition` may be called every frame. The client never sends faster
 * than `MIN_CLIENT_SEND_INTERVAL_MS`, which is at or above the server's hard
 * message ceiling, so it cannot be force-disconnected for flooding. And it
 * keeps re-sending the latest requested position until the server's copy of
 * this avatar matches it, so the final position of a movement always lands even
 * if an intermediate send was dropped by the server's own rate floor.
 */

import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import type { Facing, GameId } from '@strkworld/shared';
import {
  DEFAULT_ROOM_NAME,
  DEFAULT_SPRITE,
  MESSAGE,
  MIN_CLIENT_SEND_INTERVAL_MS,
  SERVER_MESSAGE,
} from './config';
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

/** Why a status transition happened. Present on transitions into `closed`. */
export type LobbyStatusReason =
  /** `disconnect()` was called locally. */
  | 'client-left'
  /** The server closed the connection (drop, restart, kick). */
  | 'server-dropped'
  /** A transport or matchmaking error. */
  | 'error';

export interface LobbyStatusEvent {
  readonly status: LobbyStatus;
  readonly reason?: LobbyStatusReason;
  /** The websocket close code, when the server dropped the connection. */
  readonly code?: number;
}

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
  /** Cosmetic. An unrecognised key is replaced by the server's default. */
  sprite?: string;
  /** Defaults to `street`. */
  roomName?: string;
  /**
   * Requested floor between two position messages, in ms. Raised to
   * `MIN_CLIENT_SEND_INTERVAL_MS` if smaller — a consumer cannot ask the client
   * to send fast enough to be disconnected by the server's hard ceiling.
   */
  minSendIntervalMs?: number;
  /**
   * How long `connect()` waits for the server's `welcome` (identity) message
   * before proceeding without it, in ms. Defaults to 5000. On timeout the
   * connection is still usable; self-filtering just starts once the message
   * eventually arrives.
   */
  welcomeTimeoutMs?: number;
}

type PeersListener = (peers: readonly PeerSnapshot[]) => void;
type StatusListener = (event: LobbyStatusEvent) => void;

interface WelcomePayload {
  gameId: string;
}

export class LobbyClient {
  readonly #options: LobbyClientOptions;
  readonly #minSendIntervalMs: number;
  readonly #welcomeTimeoutMs: number;
  readonly #peerListeners = new Set<PeersListener>();
  readonly #statusListeners = new Set<StatusListener>();

  #room: ColyseusRoom<unknown, LobbyState> | null = null;
  #joining: Promise<void> | null = null;
  #status: LobbyStatus = 'idle';

  /** The server-assigned identity. Null until the `welcome` message arrives. */
  #gameId: GameId | null = null;

  /** True while a local `disconnect()` is in progress, so onLeave can tell. */
  #leavingByRequest = false;

  /** The latest requested position not yet confirmed on the server. */
  #desired: Required<Placement> | null = null;
  #lastSentAt = 0;
  #reconcileHandle: ReturnType<typeof setTimeout> | null = null;

  /** Pure. Opens no connection. */
  constructor(options: LobbyClientOptions) {
    this.#options = options;
    this.#minSendIntervalMs = Math.max(
      options.minSendIntervalMs ?? MIN_CLIENT_SEND_INTERVAL_MS,
      MIN_CLIENT_SEND_INTERVAL_MS,
    );
    this.#welcomeTimeoutMs = options.welcomeTimeoutMs ?? 5000;
  }

  /** The server-assigned identifier, or null before it has been received. */
  get gameId(): GameId | null {
    return this.#gameId;
  }

  get status(): LobbyStatus {
    return this.#status;
  }

  /**
   * Join the room. Explicit, imperative, and safe to call twice.
   *
   * Concurrent callers share one attempt; a caller that arrives after the join
   * succeeded returns immediately. Resolves once the server has assigned this
   * client its identity.
   */
  async connect(): Promise<void> {
    if (this.#room !== null) return;
    if (this.#joining !== null) return this.#joining;

    this.#setStatus('connecting');
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
   * Cheap enough to call from an update loop. The position is recorded as the
   * desired one and reconciled toward the server: sent no faster than the floor,
   * re-sent until the server's copy matches, and dropped only once confirmed. A
   * call made while suspended or disconnected does nothing.
   */
  updatePosition(x: number, y: number, facing: Facing = 'down'): void {
    if (this.#status !== 'connected' || this.#room === null) return;
    this.#desired = { x: Math.round(x), y: Math.round(y), facing };
    this.#pump(Date.now());
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
    this.#cancelReconcile();
    this.#desired = null;
    this.#room.send(MESSAGE.suspend);
    this.#setStatus('suspended');
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
    const next: Required<Placement> = {
      x: Math.round(placement.x),
      y: Math.round(placement.y),
      facing: placement.facing ?? 'down',
    };
    this.#room.send(MESSAGE.resume, {
      ...next,
      sprite: this.#options.sprite ?? DEFAULT_SPRITE,
    });
    // The server writes this placement unconditionally on resume, so it is the
    // confirmed position; nothing to reconcile until the consumer moves again.
    this.#desired = null;
    this.#lastSentAt = Date.now();
    this.#setStatus('connected');
  }

  /**
   * Subscribe to nearby players. Returns an unsubscribe function.
   *
   * Opens nothing. The listener fires once immediately with the current
   * snapshot — a synchronous local read, not a request — and then on every
   * state change until it is removed.
   */
  onPeers(listener: PeersListener): () => void {
    this.#peerListeners.add(listener);
    listener(this.peers());
    return () => {
      this.#peerListeners.delete(listener);
    };
  }

  /**
   * Subscribe to connection-status changes. Returns an unsubscribe function.
   *
   * Fires once immediately with the current status, then on every transition.
   * A transition into `closed` carries a `reason` distinguishing a local
   * `disconnect()` (`client-left`) from a server drop (`server-dropped`, with
   * the close `code`) or an error (`error`) — so the consumer can tell "the
   * player left" from "the connection died" rather than inferring it from an
   * empty peer list.
   */
  onStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    listener({ status: this.#status });
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /** The current nearby players. Excludes this client's own avatar. */
  peers(): readonly PeerSnapshot[] {
    const room = this.#room;
    if (room === null) return [];
    const out: PeerSnapshot[] = [];
    room.state?.peers?.forEach((entry) => {
      if (this.#gameId !== null && entry.gameId === this.#gameId) return;
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
    this.#cancelReconcile();
    this.#desired = null;
    const room = this.#room;
    this.#room = null;
    this.#gameId = null;
    this.#leavingByRequest = true;
    this.#setStatus('closed', 'client-left');
    try {
      if (room !== null) await room.leave(true);
    } finally {
      this.#leavingByRequest = false;
    }
    this.#emitPeers();
  }

  async #join(): Promise<void> {
    const sdk = new ColyseusClient(this.#options.endpoint);
    try {
      const room = await sdk.joinOrCreate<LobbyState>(
        this.#options.roomName ?? DEFAULT_ROOM_NAME,
        {
          x: Math.round(this.#options.start.x),
          y: Math.round(this.#options.start.y),
          facing: this.#options.start.facing ?? 'down',
          sprite: this.#options.sprite ?? DEFAULT_SPRITE,
        },
      );

      const welcomed = new Promise<void>((resolve) => {
        room.onMessage(SERVER_MESSAGE.welcome, (payload: WelcomePayload) => {
          this.#gameId = payload.gameId as GameId;
          this.#emitPeers();
          resolve();
        });
      });

      room.onStateChange(() => {
        this.#emitPeers();
        if (this.#status === 'connected') this.#pump(Date.now());
      });
      room.onError((code, message) => {
        this.#room = null;
        this.#gameId = null;
        this.#cancelReconcile();
        this.#setStatus('closed', 'error', code);
        this.#emitPeers();
        void message;
      });
      room.onLeave((code) => {
        this.#room = null;
        this.#gameId = null;
        this.#cancelReconcile();
        if (!this.#leavingByRequest) {
          this.#setStatus('closed', 'server-dropped', code);
        }
        this.#emitPeers();
      });

      this.#room = room;
      this.#desired = null;
      this.#lastSentAt = 0;
      this.#setStatus('connected');
      this.#emitPeers();

      await this.#awaitWelcome(welcomed);
    } catch (error) {
      this.#setStatus('idle');
      throw error;
    }
  }

  /** Resolve when the welcome message arrives, or after the timeout. */
  async #awaitWelcome(welcomed: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#welcomeTimeoutMs);
    });
    try {
      await Promise.race([welcomed, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Send the desired position if it is due, otherwise schedule a retry; clear
   * it once the server's copy of this avatar matches.
   */
  #pump(now: number): void {
    if (this.#status !== 'connected' || this.#room === null) return;
    const desired = this.#desired;
    if (desired === null) return;

    const self = this.#serverSelf();
    if (self !== null && samePlacement(desired, self)) {
      this.#desired = null;
      this.#cancelReconcile();
      return;
    }

    const elapsed = now - this.#lastSentAt;
    if (elapsed >= this.#minSendIntervalMs) {
      this.#room.send(MESSAGE.move, desired);
      this.#lastSentAt = now;
      // Re-check after an interval: if the server accepted this move its state
      // change will clear #desired; if it was dropped by the server floor, we
      // resend. Converges once the server's copy matches.
      this.#scheduleReconcile(this.#minSendIntervalMs);
    } else {
      this.#scheduleReconcile(this.#minSendIntervalMs - elapsed);
    }
  }

  /** The server's current position for this client's own avatar, if known. */
  #serverSelf(): Required<Placement> | null {
    const id = this.#gameId;
    if (id === null || this.#room === null) return null;
    const entry = this.#room.state?.peers?.get(id);
    if (entry === undefined) return null;
    return {
      x: entry.position.x,
      y: entry.position.y,
      facing: entry.facing as Facing,
    };
  }

  #scheduleReconcile(delay: number): void {
    this.#cancelReconcile();
    this.#reconcileHandle = setTimeout(() => {
      this.#reconcileHandle = null;
      this.#pump(Date.now());
    }, delay);
  }

  #cancelReconcile(): void {
    if (this.#reconcileHandle !== null) {
      clearTimeout(this.#reconcileHandle);
      this.#reconcileHandle = null;
    }
  }

  #setStatus(status: LobbyStatus, reason?: LobbyStatusReason, code?: number): void {
    this.#status = status;
    if (this.#statusListeners.size === 0) return;
    const event: LobbyStatusEvent = { status, ...(reason ? { reason } : {}), ...(code !== undefined ? { code } : {}) };
    for (const listener of this.#statusListeners) listener(event);
  }

  #emitPeers(): void {
    if (this.#peerListeners.size === 0) return;
    const snapshot = this.peers();
    for (const listener of this.#peerListeners) listener(snapshot);
  }
}

function samePlacement(a: Required<Placement>, b: Required<Placement>): boolean {
  return a.x === b.x && a.y === b.y && a.facing === b.facing;
}
