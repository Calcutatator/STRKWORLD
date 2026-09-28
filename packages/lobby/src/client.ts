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
 *
 * ## The block sandbox (D-060)
 *
 * `sandbox()` is a frozen snapshot of the room's shared stacks plus the colour
 * this client carries. Columns come from the room-wide sandbox state, which is
 * not interest-filtered; the carried colour comes from this client's **own
 * presence entry** (`carrying`), so it is only known while connected with an
 * identity and is null while suspended. `pickBlock`/`placeBlock` send one
 * tile each, floored client-side at `SANDBOX_CLIENT_ACTION_INTERVAL_MS`: a
 * call inside the floor is held and sent when it opens (only the latest held
 * call survives), and the server may still refuse any of them silently — the
 * next snapshot is the only answer.
 * `onSandboxDrop` relays sky-drop hints, which arrive after the state that
 * already holds the dropped block. Everything read from the server is
 * validated here and fails closed.
 */

import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import {
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  type Facing,
  type GameId,
  type SandboxColumn,
  type SandboxSnapshot,
  type SandboxTile,
} from '@strkworld/shared';
import {
  DEFAULT_ROOM_NAME,
  DEFAULT_SPRITE,
  MESSAGE,
  MIN_CLIENT_SEND_INTERVAL_MS,
  SANDBOX_CLIENT_ACTION_INTERVAL_MS,
  SERVER_MESSAGE,
  type LobbySprite,
} from './config';
import {
  normalizeCoordinate,
  normalizeFacing,
  normalizeGameId,
  normalizeSandboxColour,
  normalizeSandboxTile,
} from './policy';
import { isSandboxTile, sandboxTileKey } from './sandbox-rules';
import type { LobbyState, PresenceEntry } from './state';

export type { LobbySprite } from './config';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const INVALID_CLIENT_SEND_INTERVAL_ERROR = 'Lobby client send interval is invalid.';
const INVALID_WELCOME_TIMEOUT_ERROR = 'Lobby welcome timeout is invalid.';
const INVALID_RESUME_PLACEMENT_ERROR = 'Lobby resume placement is invalid.';
const INVALID_WELCOME_ERROR = 'Lobby welcome identity is invalid.';

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
  /**
   * D-060: the sandbox block colour this player carries, or null. Validated
   * to an integer palette index; anything else from the server is null.
   */
  readonly carrying: number | null;
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
   * before proceeding without it, in nonnegative integer ms. Defaults to 5000.
   * The value is bounded by the platform timer ceiling. On timeout the
   * connection is still usable; self-filtering just starts once the message
   * eventually arrives.
   */
  welcomeTimeoutMs?: number;
}

type PeersListener = (peers: readonly PeerSnapshot[]) => void;
type StatusListener = (event: LobbyStatusEvent) => void;
type SandboxListener = (snapshot: SandboxSnapshot) => void;
type SandboxDropListener = (tile: SandboxTile) => void;
type ListenerOwner<T> = readonly [listener: T, owner: symbol];

interface PeerDelivery {
  readonly listeners: readonly ListenerOwner<PeersListener>[];
  readonly snapshot: readonly PeerSnapshot[];
}

interface StatusDelivery {
  readonly listeners: readonly ListenerOwner<StatusListener>[];
  readonly event: LobbyStatusEvent;
}

interface SandboxDelivery {
  readonly listeners: readonly ListenerOwner<SandboxListener>[];
  readonly snapshot: SandboxSnapshot;
}

interface SandboxDropDelivery {
  readonly listeners: readonly ListenerOwner<SandboxDropListener>[];
  readonly tile: SandboxTile;
}

const EMPTY_SANDBOX: SandboxSnapshot = Object.freeze({
  columns: Object.freeze([]) as readonly SandboxColumn[],
  carrying: null,
});

interface WelcomePayload {
  gameId: string;
}

interface JoinAttempt {
  readonly generation: number;
  readonly promise: Promise<void>;
  readonly interrupt: (error: Error) => void;
}

export class LobbyClient {
  readonly #options: LobbyClientOptions;
  readonly #minSendIntervalMs: number;
  readonly #welcomeTimeoutMs: number;
  readonly #peerListeners = new Map<PeersListener, symbol>();
  readonly #statusListeners = new Map<StatusListener, symbol>();
  readonly #peerDeliveries: PeerDelivery[] = [];
  readonly #statusDeliveries: StatusDelivery[] = [];
  readonly #sandboxListeners = new Map<SandboxListener, symbol>();
  readonly #dropListeners = new Map<SandboxDropListener, symbol>();
  readonly #sandboxDeliveries: SandboxDelivery[] = [];
  readonly #dropDeliveries: SandboxDropDelivery[] = [];

  #deliveringPeers = false;
  #deliveringStatus = false;
  #deliveringSandbox = false;
  #deliveringDrops = false;

  /** The last value `sandbox()` returned, reused while nothing changes. */
  #sandboxView: SandboxSnapshot = EMPTY_SANDBOX;
  /** The last value delivered to sandbox listeners, for change detection. */
  #sandboxPublished: SandboxSnapshot = EMPTY_SANDBOX;
  /** When the last pick/place left this client, for the client-side floor. */
  #lastSandboxActionAt: number | null = null;
  /** The latest pick/place requested inside the floor, sent when it opens. */
  #pendingSandboxAction: PendingSandboxAction | null = null;
  #sandboxActionHandle: ReturnType<typeof setTimeout> | null = null;

  #room: ColyseusRoom<unknown, LobbyState> | null = null;
  #joinAttempt: JoinAttempt | null = null;
  #joinGeneration = 0;
  #status: LobbyStatus = 'idle';

  /** The server-assigned identity. Null until the `welcome` message arrives. */
  #gameId: GameId | null = null;

  /** The latest requested position not yet confirmed on the server. */
  #desired: Required<Placement> | null = null;
  #lastSentAt: number | null = null;
  /** The last position actually put on the wire, to tell sent from waiting. */
  #lastSentPlacement: Required<Placement> | null = null;
  #reconcileHandle: ReturnType<typeof setTimeout> | null = null;

  /** Pure. Opens no connection. */
  constructor(options: LobbyClientOptions) {
    // Keep the connection plan owned by this client. The shell commonly keeps
    // and reuses its mutable options object; retaining it here would let a
    // later edit silently redirect a reconnect or change its placement and
    // cosmetic identity after construction.
    this.#options = Object.freeze({
      ...options,
      start: Object.freeze({ ...options.start }),
    });
    const minSendIntervalMs = Math.max(
      options.minSendIntervalMs ?? MIN_CLIENT_SEND_INTERVAL_MS,
      MIN_CLIENT_SEND_INTERVAL_MS,
    );
    if (!Number.isFinite(minSendIntervalMs) || minSendIntervalMs > MAX_TIMER_DELAY_MS) {
      throw new Error(INVALID_CLIENT_SEND_INTERVAL_ERROR);
    }
    this.#minSendIntervalMs = minSendIntervalMs;
    const welcomeTimeoutMs = options.welcomeTimeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(welcomeTimeoutMs) ||
      welcomeTimeoutMs < 0 ||
      welcomeTimeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(INVALID_WELCOME_TIMEOUT_ERROR);
    }
    this.#welcomeTimeoutMs = welcomeTimeoutMs;
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
    if (this.#joinAttempt !== null) return this.#joinAttempt.promise;
    if (this.#room !== null) return;

    const generation = ++this.#joinGeneration;
    this.#setStatus('connecting');
    // Status delivery is synchronous. A listener may retire this connection
    // before the join attempt has been installed; do not start transport work
    // for that superseded generation.
    if (this.#joinGeneration !== generation || this.#status !== 'connecting') return;
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    const promise = Promise.race([this.#join(generation, interrupted), interrupted]);
    const attempt: JoinAttempt = { generation, promise, interrupt };
    this.#joinAttempt = attempt;
    try {
      await promise;
    } finally {
      if (this.#joinAttempt === attempt) this.#joinAttempt = null;
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
    // Match the server's finite rounding and world-bound clamp before storing
    // desired state. Without this, an out-of-bounds finite coordinate would be
    // accepted locally, clamped remotely, and retried forever because the two
    // values could never compare equal.
    const normalizedX = normalizeCoordinate(x);
    const normalizedY = normalizeCoordinate(y);
    if (normalizedX === null || normalizedY === null) return;
    this.#desired = {
      x: normalizedX,
      y: normalizedY,
      facing: normalizeFacing(facing),
    };
    this.#pump(performance.now());
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
    this.#cancelSandboxAction();
    this.#desired = null;
    const room = this.#room;
    room.send(MESSAGE.suspend);
    // A transport can report closure synchronously from send; do not let the
    // suspended command overwrite that authoritative lifecycle state.
    if (this.#room !== room || this.#status !== 'connected') return;
    this.#setStatus('suspended');
    // The server puts a carried block back on suspend; stop reporting it now
    // rather than when the patch that erases our entry arrives.
    this.#emitSandbox();
  }

  /**
   * Reappear on the street after a suspend.
   *
   * A placement is required because the server discarded the old one. D-047
   * may supply one validated opaque sprite key with that placement; omission
   * preserves the client configuration/default. Throws if this client was
   * never connected or has been disconnected: reconnecting is the shell's
   * decision to make explicitly, not a side effect of resuming.
   */
  resume(placement: Placement, sprite?: LobbySprite): void {
    if (this.#status === 'connected') return;
    if (this.#status !== 'suspended' || this.#room === null) {
      throw new Error(`resume() requires a suspended client, not "${this.#status}"`);
    }
    // The server rejects non-finite coordinates. Validate before claiming the
    // client is connected, otherwise a failed resume leaves this wrapper in a
    // false connected state while its server session remains suspended.
    if (placement === null || typeof placement !== 'object') {
      throw new Error(INVALID_RESUME_PLACEMENT_ERROR);
    }
    // Read only own data properties at this trust boundary. Ordinary property
    // access would invoke an accessor (or a proxy trap) supplied by the
    // caller, allowing a malformed placement to leak a raw exception before
    // the controlled validation error below. Missing/invalid facing keeps the
    // existing default-to-down behavior; coordinates remain required.
    const x = normalizeCoordinate(ownDataField(placement, 'x'));
    const y = normalizeCoordinate(ownDataField(placement, 'y'));
    if (x === null || y === null) {
      throw new Error(INVALID_RESUME_PLACEMENT_ERROR);
    }
    const next: Required<Placement> = {
      x,
      y,
      facing: normalizeFacing(ownDataField(placement, 'facing')),
    };
    const room = this.#room;
    room.send(MESSAGE.resume, {
      ...next,
      sprite: sprite ?? this.#options.sprite ?? DEFAULT_SPRITE,
    });
    // The transport may synchronously report its own closure while sending;
    // do not let this stale command resurrect a disconnected client.
    if (this.#room !== room || this.#status !== 'suspended') return;
    // The server writes this placement unconditionally on resume, so it is the
    // confirmed position; nothing to reconcile until the consumer moves again.
    this.#desired = null;
    this.#lastSentAt = performance.now();
    this.#lastSentPlacement = null;
    this.#setStatus('connected');
    this.#emitSandbox();
  }

  /**
   * Subscribe to nearby players. Returns an unsubscribe function.
   *
   * Opens nothing. The listener fires once immediately with the current
   * snapshot — a synchronous local read, not a request — and then on every
   * state change until it is removed.
   */
  onPeers(listener: PeersListener): () => void {
    const owner = Symbol('peer listener');
    this.#peerListeners.set(listener, owner);
    this.#notifyPeer(listener, this.peers());
    return () => {
      if (this.#peerListeners.get(listener) === owner) {
        this.#peerListeners.delete(listener);
      }
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
    const owner = Symbol('status listener');
    this.#statusListeners.set(listener, owner);
    this.#notifyStatus(listener, Object.freeze({ status: this.#status }));
    return () => {
      if (this.#statusListeners.get(listener) === owner) {
        this.#statusListeners.delete(listener);
      }
    };
  }

  /** The current nearby players. Excludes this client's own avatar. */
  peers(): readonly PeerSnapshot[] {
    const room = this.#room;
    // The room can exist briefly before the server's welcome message assigns
    // this session's id. Publishing during that window would make our own
    // entry indistinguishable from a peer and flash a duplicate local avatar.
    // The welcome handler emits again as soon as self-filtering is possible.
    if (room === null || this.#gameId === null) return [];
    const out: PeerSnapshot[] = [];
    room.state?.peers?.forEach((entry) => {
      const snapshot = readPeerSnapshot(entry);
      if (snapshot === null || snapshot.gameId === this.#gameId) return;
      out.push(snapshot);
    });
    // `onPeers` delivers one snapshot object to every listener. Freeze both
    // layers so one subscriber cannot mutate what a later subscriber sees or
    // alter the readonly value retained by a shell adapter.
    return Object.freeze(out.map((entry) => Object.freeze(entry)));
  }

  /**
   * The shared block sandbox as this client sees it (D-060). Frozen at every
   * level, and the same object for as long as nothing in it changes.
   *
   * Columns are every validated stack in the room — not interest-filtered —
   * sorted by `(y, x)`. `carrying` is read from this client's own presence
   * entry and is null unless connected with a server identity. Before the
   * first join and after a disconnect, the snapshot is empty.
   */
  sandbox(): SandboxSnapshot {
    const next = this.#readSandbox();
    if (sameSandbox(this.#sandboxView, next)) return this.#sandboxView;
    this.#sandboxView = next;
    return next;
  }

  /**
   * Subscribe to the block sandbox. Returns an unsubscribe function.
   *
   * Opens nothing. Fires once immediately with the current snapshot, then
   * whenever a column or this client's carried colour changes — not on every
   * room patch. Delivery follows `onPeers`: FIFO, generation-owned, and a
   * throwing subscriber is isolated behind a fixed diagnostic.
   */
  onSandbox(listener: SandboxListener): () => void {
    const owner = Symbol('sandbox listener');
    this.#sandboxListeners.set(listener, owner);
    this.#notifySandbox(listener, this.sandbox());
    return () => {
      if (this.#sandboxListeners.get(listener) === owner) {
        this.#sandboxListeners.delete(listener);
      }
    };
  }

  /**
   * Subscribe to sky-drop hints. Returns an unsubscribe function.
   *
   * No replay: a drop is an event, not state. Each hint is a frozen, validated
   * sandbox tile, delivered after the snapshot that already holds the block
   * (unless someone took it in between). It is an animation cue only.
   */
  onSandboxDrop(listener: SandboxDropListener): () => void {
    const owner = Symbol('sandbox drop listener');
    this.#dropListeners.set(listener, owner);
    return () => {
      if (this.#dropListeners.get(listener) === owner) {
        this.#dropListeners.delete(listener);
      }
    };
  }

  /**
   * Ask to pick up the top block of `tile`.
   *
   * A no-op unless connected (not suspended) and for anything but an integer
   * sandbox tile. Inside the client floor since the last pick or place, the
   * request is held and sent when the floor opens; a newer request replaces
   * a held one, and suspend, disconnect or a lost room discards it. The
   * server applies its own rules and floor and answers only through state.
   */
  pickBlock(tile: SandboxTile): void {
    this.#sendSandboxAction(MESSAGE.sandboxPick, tile);
  }

  /** Ask to put the carried block on `tile`. Same contract as `pickBlock`. */
  placeBlock(tile: SandboxTile): void {
    this.#sendSandboxAction(MESSAGE.sandboxPlace, tile);
  }

  /** Leave the room. The client can be connected again afterwards. */
  async disconnect(): Promise<void> {
    this.#cancelReconcile();
    this.#cancelSandboxAction();
    this.#desired = null;
    const disconnectGeneration = ++this.#joinGeneration;
    const attempt = this.#joinAttempt;
    this.#joinAttempt = null;
    attempt?.interrupt(new Error('Lobby join interrupted by disconnect()'));
    const room = this.#room;
    this.#room = null;
    this.#gameId = null;
    this.#setStatus('closed', 'client-left');
    let leaveFailed = false;
    let leaveError: unknown;
    if (room !== null) {
      try {
        await room.leave(true);
      } catch (error) {
        // Local authority is already retired. Preserve the transport error,
        // but do not let failed SDK cleanup strand stale peers downstream.
        leaveFailed = true;
        leaveError = error;
      }
    }
    // A status listener may synchronously start a replacement connection from
    // `client-left` while the old room's leave is pending. That replacement
    // now owns peer delivery; do not let this stale disconnect continuation
    // publish through its live stream when the old transport finally settles.
    if (this.#joinGeneration === disconnectGeneration) this.#emitRoomState();
    if (leaveFailed) throw leaveError;
  }

  async #join(generation: number, interrupted: Promise<never>): Promise<void> {
    const sdk = new ColyseusClient(this.#options.endpoint);
    let joinedRoom: ColyseusRoom<unknown, LobbyState> | null = null;
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
      joinedRoom = room;

      // D-037 gives reconnect ownership to the Shell's explicit player
      // control. The pinned SDK enables a 15-attempt automatic retry loop on
      // every Room by default; left enabled, an established transport drop
      // stays locally "connected" until that hidden loop gives up. Disable it
      // before publishing the room so the SDK turns a drop into onLeave and
      // the existing status seam can truthfully enter unavailable/solo play.
      room.reconnection.enabled = false;

      if (this.#joinGeneration !== generation) {
        await room.leave(true).catch(() => undefined);
        return;
      }

      // D-060 sky-drop hints. Registered before the room is published, like
      // welcome, so no hint can arrive without a handler; a hint that is not
      // a sandbox tile is dropped here and never reaches a subscriber.
      room.onMessage(SERVER_MESSAGE.sandboxDrop, (payload: unknown) => {
        if (!this.#isCurrentRoom(generation, room)) return;
        const tile = normalizeSandboxTile(payload);
        if (tile === null) return;
        this.#emitDrop(tile);
      });

      let rejectWelcome!: (error: Error) => void;
      let welcomeAccepted = false;
      const welcomed = new Promise<void>((resolve, reject) => {
        rejectWelcome = reject;
        room.onMessage(SERVER_MESSAGE.welcome, (payload: WelcomePayload) => {
          if (!this.#isCurrentRoom(generation, room)) return;
          // The server sends one identity for a room generation. Keep the
          // first valid identity stable so a duplicate or conflicting replay
          // cannot make the client publish its own state as a peer.
          if (welcomeAccepted) return;
          const payloadRecord =
            payload !== null && typeof payload === 'object' ? payload : null;
          const gameIdField = payloadRecord
            ? Object.getOwnPropertyDescriptor(payloadRecord, 'gameId')
            : undefined;
          const gameId = normalizeGameId(
            gameIdField && 'value' in gameIdField ? gameIdField.value : undefined,
          );
          if (gameId === null) {
            this.#room = null;
            this.#gameId = null;
            this.#cancelReconcile();
            this.#cancelSandboxAction();
            this.#setStatus('closed', 'error');
            this.#emitRoomState();
            rejectWelcome(new Error(INVALID_WELCOME_ERROR));
            void room.leave(true).catch(() => undefined);
            return;
          }
          welcomeAccepted = true;
          this.#gameId = gameId;
          this.#emitRoomState();
          resolve();
        });
      });

      // Publish the room before installing lifecycle callbacks. The SDK may
      // deliver an error/leave immediately after joinOrCreate resolves; those
      // callbacks must be able to identify this room even before welcome.
      this.#room = room;
      this.#desired = null;
      this.#lastSentAt = null;
      this.#lastSentPlacement = null;
      this.#lastSandboxActionAt = null;
      this.#cancelSandboxAction();
      this.#setStatus('connected');
      // Status delivery is synchronous. A listener may retire this exact
      // room before lifecycle callbacks are installed; do not attach stale
      // handlers to a room that no longer belongs to this client.
      if (!this.#isCurrentRoom(generation, room)) return;
      this.#emitRoomState();

      room.onStateChange(() => {
        if (!this.#isCurrentRoom(generation, room)) return;
        this.#emitRoomState();
        if (this.#status === 'connected') this.#pump(performance.now());
      });
      room.onError((code, _message) => {
        if (!this.#isCurrentRoom(generation, room)) return;
        // A WebSocket transport loss reaches the pinned SDK as a code-less
        // error immediately before its close event. Let onLeave own that pair
        // so the real close code is reported as server-dropped. Numeric room
        // and protocol errors do not carry that close signal and remain the
        // explicit error path below.
        if (code === undefined) return;
        this.#room = null;
        this.#gameId = null;
        this.#cancelReconcile();
        this.#cancelSandboxAction();
        this.#setStatus('closed', 'error', code);
        this.#emitRoomState();
        rejectWelcome(new Error('Lobby room error before welcome'));
        // onError does not prove the transport has closed. Leave this exact
        // room once; clearing #room first makes a resulting onLeave callback
        // stale and prevents recursive/double cleanup.
        void room.leave(true).catch(() => undefined);
      });
      room.onLeave((code) => {
        if (!this.#isCurrentRoom(generation, room)) return;
        this.#room = null;
        this.#gameId = null;
        this.#cancelReconcile();
        this.#cancelSandboxAction();
        this.#setStatus('closed', 'server-dropped', code);
        this.#emitRoomState();
        rejectWelcome(new Error('Lobby room left before welcome'));
      });

      await this.#awaitWelcome(welcomed, interrupted);
      if (!this.#isCurrentRoom(generation, room)) {
        throw new Error('Lobby room closed before connect completed');
      }
    } catch (error) {
      if (this.#joinGeneration === generation) {
        const failedRoom = this.#room;
        if (failedRoom !== null) {
          this.#room = null;
          this.#gameId = null;
          this.#cancelReconcile();
          this.#cancelSandboxAction();
          this.#desired = null;
          this.#setStatus('closed', 'error');
          this.#emitRoomState();
          await failedRoom.leave(true).catch(() => undefined);
        } else if (joinedRoom !== null && this.#status === 'connecting') {
          this.#gameId = null;
          this.#cancelReconcile();
          this.#cancelSandboxAction();
          this.#desired = null;
          this.#setStatus('closed', 'error');
          this.#emitRoomState();
          await joinedRoom.leave(true).catch(() => undefined);
        } else if (this.#status === 'connecting') {
          this.#setStatus('idle');
        }
      }
      throw error;
    }
  }

  #isCurrentRoom(generation: number, room: ColyseusRoom<unknown, LobbyState>): boolean {
    return this.#joinGeneration === generation && this.#room === room;
  }

  /** Resolve when the welcome message arrives, or after the timeout. */
  async #awaitWelcome(welcomed: Promise<void>, interrupted: Promise<never>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#welcomeTimeoutMs);
    });
    try {
      await Promise.race([welcomed, timeout, interrupted]);
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
    if (!isValidMonotonicTime(now)) {
      this.#scheduleReconcile(this.#minSendIntervalMs);
      return;
    }

    const self = this.#serverSelf();
    if (self !== null && samePlacement(desired, self)) {
      this.#desired = null;
      this.#cancelReconcile();
      return;
    }

    const elapsed = this.#lastSentAt === null ? null : now - this.#lastSentAt;
    if (elapsed === null || elapsed >= this.#minSendIntervalMs) {
      const room = this.#room;
      room.send(MESSAGE.move, desired);
      this.#lastSentPlacement = desired;
      // A transport can report closure synchronously from send. Do not stamp
      // the retired room's send time or schedule work against its replacement.
      if (this.#room !== room || this.#status !== 'connected') return;
      // A synchronous state callback may have confirmed this exact move while
      // the send was still on the stack. Do not leave a redundant timer behind
      // after that nested pump already cleared the desired placement.
      if (this.#desired === null) return;
      this.#lastSentAt = now;
      // Re-check after an interval: if the server accepted this move its state
      // change will clear #desired; if it was dropped by the server floor, we
      // resend. Converges once the server's copy matches.
      this.#scheduleReconcile(this.#minSendIntervalMs);
    } else {
      this.#scheduleReconcile(
        Math.min(this.#minSendIntervalMs - elapsed, MAX_TIMER_DELAY_MS),
      );
    }
  }

  /** The server's current position for this client's own avatar, if known. */
  #serverSelf(): Required<Placement> | null {
    const id = this.#gameId;
    if (id === null || this.#room === null) return null;
    const entry = this.#room.state?.peers?.get(id);
    if (entry === undefined) return null;
    const snapshot = readPeerSnapshot(entry);
    if (snapshot === null || snapshot.gameId !== id) return null;
    return snapshot;
  }

  #scheduleReconcile(delay: number): void {
    this.#cancelReconcile();
    this.#reconcileHandle = setTimeout(() => {
      this.#reconcileHandle = null;
      this.#pump(performance.now());
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
    const event: LobbyStatusEvent = Object.freeze({
      status,
      ...(reason ? { reason } : {}),
      ...(code !== undefined ? { code } : {}),
    });
    this.#statusDeliveries.push({ listeners: [...this.#statusListeners], event });
    if (this.#deliveringStatus) return;

    this.#deliveringStatus = true;
    try {
      for (;;) {
        const delivery = this.#statusDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#statusListeners.get(listener) !== owner) continue;
          this.#notifyStatus(listener, delivery.event);
        }
      }
    } finally {
      this.#deliveringStatus = false;
    }
  }

  #emitPeers(): void {
    if (this.#peerListeners.size === 0) return;
    this.#peerDeliveries.push({
      listeners: [...this.#peerListeners],
      snapshot: this.peers(),
    });
    if (this.#deliveringPeers) return;

    this.#deliveringPeers = true;
    try {
      for (;;) {
        const delivery = this.#peerDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#peerListeners.get(listener) !== owner) continue;
          this.#notifyPeer(listener, delivery.snapshot);
        }
      }
    } finally {
      this.#deliveringPeers = false;
    }
  }

  #notifyPeer(listener: PeersListener, snapshot: readonly PeerSnapshot[]): void {
    try {
      listener(snapshot);
    } catch {
      console.error('lobby client: peer subscriber threw');
    }
  }

  #notifyStatus(listener: StatusListener, event: LobbyStatusEvent): void {
    try {
      listener(event);
    } catch {
      console.error('lobby client: status subscriber threw');
    }
  }

  /** Publish everything read from room state: peers, then the sandbox. */
  #emitRoomState(): void {
    this.#emitPeers();
    this.#emitSandbox();
  }

  /**
   * Deliver the current sandbox snapshot if it differs from the last one
   * delivered. Room patches arrive at the patch rate whatever changed, so
   * without this a moving peer would re-deliver an identical sandbox 20 times
   * a second.
   */
  #emitSandbox(): void {
    const snapshot = this.sandbox();
    if (sameSandbox(snapshot, this.#sandboxPublished)) return;
    this.#sandboxPublished = snapshot;
    if (this.#sandboxListeners.size === 0) return;
    this.#sandboxDeliveries.push({ listeners: [...this.#sandboxListeners], snapshot });
    if (this.#deliveringSandbox) return;

    this.#deliveringSandbox = true;
    try {
      for (;;) {
        const delivery = this.#sandboxDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#sandboxListeners.get(listener) !== owner) continue;
          this.#notifySandbox(listener, delivery.snapshot);
        }
      }
    } finally {
      this.#deliveringSandbox = false;
    }
  }

  #emitDrop(tile: SandboxTile): void {
    if (this.#dropListeners.size === 0) return;
    this.#dropDeliveries.push({ listeners: [...this.#dropListeners], tile });
    if (this.#deliveringDrops) return;

    this.#deliveringDrops = true;
    try {
      for (;;) {
        const delivery = this.#dropDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#dropListeners.get(listener) !== owner) continue;
          this.#notifyDrop(listener, delivery.tile);
        }
      }
    } finally {
      this.#deliveringDrops = false;
    }
  }

  #notifySandbox(listener: SandboxListener, snapshot: SandboxSnapshot): void {
    try {
      listener(snapshot);
    } catch {
      console.error('lobby client: sandbox subscriber threw');
    }
  }

  #notifyDrop(listener: SandboxDropListener, tile: SandboxTile): void {
    try {
      listener(tile);
    } catch {
      console.error('lobby client: sandbox drop subscriber threw');
    }
  }

  #readSandbox(): SandboxSnapshot {
    const room = this.#room;
    if (room === null) return EMPTY_SANDBOX;
    const columns = readSandboxColumns(room);
    const carrying = this.#status === 'connected' ? this.#ownCarrying(room) : null;
    if (columns.length === 0 && carrying === null) return EMPTY_SANDBOX;
    return Object.freeze({ columns, carrying });
  }

  /** The colour on this client's own presence entry, validated, or null. */
  #ownCarrying(room: ColyseusRoom<unknown, LobbyState>): number | null {
    const id = this.#gameId;
    if (id === null) return null;
    let entry: PresenceEntry | undefined;
    try {
      entry = room.state?.peers?.get(id);
    } catch {
      return null;
    }
    if (entry === undefined || entry === null) return null;
    const snapshot = readPeerSnapshot(entry);
    if (snapshot === null || snapshot.gameId !== id) return null;
    return snapshot.carrying;
  }

  #sendSandboxAction(type: SandboxActionMessage, tile: SandboxTile): void {
    if (this.#status !== 'connected' || this.#room === null) return;
    // Own data properties only, like resume: a caller-supplied accessor or
    // proxy is never invoked, and anything but an in-sandbox integer tile is
    // not sent at all.
    const target = normalizeSandboxTile(tile);
    if (target === null) return;
    this.#pendingSandboxAction = { type, tile: target };
    this.#flushSandboxAction();
  }

  /**
   * Send the pending sandbox action if the client floor allows it, otherwise
   * hold it until the floor opens.
   *
   * Held, not dropped: the server floor would drop an early action silently,
   * so a pick followed at once by a place would lose the place. Only the
   * latest request is held — a newer one replaces it — and it is re-checked
   * against the connection and the floor when it finally goes. A clock that
   * runs backwards keeps the floor closed until it passes it again.
   */
  #flushSandboxAction(): void {
    this.#cancelSandboxTimer();
    const pending = this.#pendingSandboxAction;
    if (pending === null) return;
    if (this.#status !== 'connected' || this.#room === null) {
      this.#pendingSandboxAction = null;
      return;
    }
    const now = performance.now();
    if (!isValidMonotonicTime(now)) {
      this.#scheduleSandboxAction(SANDBOX_CLIENT_ACTION_INTERVAL_MS);
      return;
    }
    const last = this.#lastSandboxActionAt;
    if (last !== null && now - last < SANDBOX_CLIENT_ACTION_INTERVAL_MS) {
      this.#scheduleSandboxAction(
        Math.min(SANDBOX_CLIENT_ACTION_INTERVAL_MS - (now - last), MAX_TIMER_DELAY_MS),
      );
      return;
    }
    // A newer position still waiting on the move floor goes first, so the
    // server judges this action from where the player stands now rather than
    // from the tile they just left. Hold the action until that move can go.
    // A position already sent and awaiting confirmation does not hold it.
    const desired = this.#desired;
    const unsent = desired !== null &&
      (this.#lastSentPlacement === null || !samePlacement(desired, this.#lastSentPlacement));
    if (unsent) {
      const sinceMove = this.#lastSentAt === null ? null : now - this.#lastSentAt;
      if (sinceMove !== null && sinceMove < this.#minSendIntervalMs) {
        this.#scheduleSandboxAction(Math.min(this.#minSendIntervalMs - sinceMove, MAX_TIMER_DELAY_MS));
        return;
      }
      const before = this.#room;
      this.#pump(now);
      if (this.#room !== before || this.#status !== 'connected' || this.#room === null) {
        this.#pendingSandboxAction = null;
        return;
      }
    }
    this.#pendingSandboxAction = null;
    const room = this.#room;
    room.send(pending.type, { x: pending.tile.x, y: pending.tile.y });
    // A transport can report closure synchronously from send; a retired room
    // must not stamp the floor of whatever replaces it.
    if (this.#room !== room || this.#status !== 'connected') return;
    this.#lastSandboxActionAt = now;
  }

  #scheduleSandboxAction(delay: number): void {
    this.#cancelSandboxTimer();
    this.#sandboxActionHandle = setTimeout(() => {
      this.#sandboxActionHandle = null;
      this.#flushSandboxAction();
    }, delay);
  }

  #cancelSandboxTimer(): void {
    if (this.#sandboxActionHandle !== null) {
      clearTimeout(this.#sandboxActionHandle);
      this.#sandboxActionHandle = null;
    }
  }

  /** Forget a held sandbox action. Called wherever this client stops sending. */
  #cancelSandboxAction(): void {
    this.#pendingSandboxAction = null;
    this.#cancelSandboxTimer();
  }
}

interface PendingSandboxAction {
  readonly type: SandboxActionMessage;
  readonly tile: SandboxTile;
}

type SandboxActionMessage = typeof MESSAGE.sandboxPick | typeof MESSAGE.sandboxPlace;

function ownDataField(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function readPeerSnapshot(entry: PresenceEntry): PeerSnapshot | null {
  try {
    return {
      gameId: entry.gameId,
      x: entry.position.x,
      y: entry.position.y,
      facing: entry.facing as Facing,
      sprite: entry.sprite,
      carrying: normalizeSandboxColour(entry.carrying),
    };
  } catch {
    return null;
  }
}

/**
 * Every well-formed stack in the decoded room state, sorted by `(y, x)` and
 * frozen.
 *
 * Fails closed at every level: an unreadable container is an empty sandbox,
 * a malformed column is skipped whole (never partially trusted), and columns
 * beyond the room-wide block cap are not drawn.
 */
function readSandboxColumns(
  room: ColyseusRoom<unknown, LobbyState>,
): readonly SandboxColumn[] {
  const columns: SandboxColumn[] = [];
  try {
    const container: unknown = (room.state as { sandbox?: unknown } | undefined)?.sandbox;
    if (container === null || typeof container !== 'object') return EMPTY_SANDBOX.columns;
    const forEach = (container as { forEach?: unknown }).forEach;
    if (typeof forEach !== 'function') return EMPTY_SANDBOX.columns;
    Reflect.apply(forEach, container, [
      (value: unknown, key: unknown) => {
        const column = readSandboxColumn(value, key);
        if (column !== null) columns.push(column);
      },
    ]);
  } catch {
    return EMPTY_SANDBOX.columns;
  }
  if (columns.length === 0) return EMPTY_SANDBOX.columns;

  columns.sort((a, b) => a.y - b.y || a.x - b.x);
  const kept: SandboxColumn[] = [];
  const seen = new Set<string>();
  let blocks = 0;
  for (const column of columns) {
    const key = sandboxTileKey(column.x, column.y);
    if (seen.has(key)) continue;
    if (blocks + column.colours.length > SANDBOX_MAX_BLOCKS) break;
    seen.add(key);
    blocks += column.colours.length;
    kept.push(column);
  }
  return Object.freeze(kept);
}

/** One decoded stack, or null if any part of it is not exactly right. */
function readSandboxColumn(value: unknown, key: unknown): SandboxColumn | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const record = value as { x?: unknown; y?: unknown; colours?: unknown };
    const x = record.x;
    const y = record.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !isSandboxTile(x, y)) return null;
    // The room keys every column by its own tile; a mismatch is not ours.
    if (key !== sandboxTileKey(x, y)) return null;
    const stack = record.colours;
    if (stack === null || typeof stack !== 'object') return null;
    const length = (stack as { length?: unknown }).length;
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > SANDBOX_MAX_HEIGHT
    ) {
      return null;
    }
    const colours: number[] = [];
    for (let index = 0; index < length; index += 1) {
      const colour = normalizeSandboxColour((stack as Record<number, unknown>)[index]);
      if (colour === null) return null;
      colours.push(colour);
    }
    return Object.freeze({ x, y, colours: Object.freeze(colours) });
  } catch {
    return null;
  }
}

function sameSandbox(a: SandboxSnapshot, b: SandboxSnapshot): boolean {
  if (a === b) return true;
  if (a.carrying !== b.carrying || a.columns.length !== b.columns.length) return false;
  for (let index = 0; index < a.columns.length; index += 1) {
    const left = a.columns[index] as SandboxColumn;
    const right = b.columns[index] as SandboxColumn;
    if (left.x !== right.x || left.y !== right.y) return false;
    if (left.colours.length !== right.colours.length) return false;
    for (let level = 0; level < left.colours.length; level += 1) {
      if (left.colours[level] !== right.colours[level]) return false;
    }
  }
  return true;
}

function isValidMonotonicTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function samePlacement(a: Required<Placement>, b: Required<Placement>): boolean {
  return a.x === b.x && a.y === b.y && a.facing === b.facing;
}
