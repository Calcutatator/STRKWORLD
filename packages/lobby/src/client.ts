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
 * ## Presence areas (D-087)
 *
 * A connected client is live in one presence area: the street after a join
 * or a resume, or the area named by its last `enterArea`. The room sends it
 * the peers in that area and, on the roof, the street's peers below it too
 * (one way: the street is never sent the roof). Switching is one message;
 * until the room's copy of this avatar shows the new placement, `peers()` is
 * empty, so peers of the area left are never drawn in the area entered. The
 * sandbox and the ball are on the street: away from it, pick, place and kick
 * send nothing and the snapshot carries nothing.
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
 * already holds the dropped block, and `onSandboxBurst` relays bursts
 * (D-071), which arrive before the state that empties the board. Everything
 * read from the server is validated here and fails closed.
 *
 * ## The football (D-078)
 *
 * `football()` is a frozen snapshot of the room's one ball — its position,
 * velocity and the simulation tick they are from — and the scoreboard, or
 * null before a valid one has arrived. `onFootball` delivers it whenever it
 * changes, and `onGoal` relays goal cues, which arrive before the state that
 * raises the score and name a side, never a player. `kick()` sends a kick
 * with no payload, floored client-side at `FOOTBALL_CLIENT_KICK_INTERVAL_MS`:
 * a kick inside the floor is dropped, not held, because a late kick is a
 * different kick. A newer position still waiting on the move floor goes
 * first, so the room judges the kick from where the player stands now.
 */

import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import {
  FOOTBALL_WIN_SCORE,
  PITCH_AREA,
  PRESENCE_AREAS,
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  type Facing,
  type FootballGoal,
  type FootballPhase,
  type FootballSnapshot,
  type GameId,
  type PresenceArea,
  type SandboxColumn,
  type SandboxSnapshot,
  type SandboxTile,
} from '@strkworld/shared';
import {
  DEFAULT_ROOM_NAME,
  DEFAULT_SPRITE,
  FOOTBALL_CLIENT_KICK_INTERVAL_MS,
  MESSAGE,
  MIN_CLIENT_SEND_INTERVAL_MS,
  SANDBOX_CLIENT_ACTION_INTERVAL_MS,
  SERVER_MESSAGE,
  type LobbySprite,
} from './config';
import { FOOTBALL_MAX_SPEED, FOOTBALL_TILE_SIZE } from './football-rules';
import { FOOTBALL_WIRE_SCALE } from './football';
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
const INVALID_AREA_ERROR = 'Lobby presence area is invalid.';
const NO_PEERS: readonly PeerSnapshot[] = Object.freeze([]);
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
type SandboxBurstListener = (tile: SandboxTile) => void;
type FootballListener = (snapshot: FootballSnapshot | null) => void;
type GoalListener = (goal: FootballGoal) => void;
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

interface SandboxBurstDelivery {
  readonly listeners: readonly ListenerOwner<SandboxBurstListener>[];
  readonly tile: SandboxTile;
}

interface FootballDelivery {
  readonly listeners: readonly ListenerOwner<FootballListener>[];
  readonly snapshot: FootballSnapshot | null;
}

interface GoalDelivery {
  readonly listeners: readonly ListenerOwner<GoalListener>[];
  readonly goal: FootballGoal;
}

const EMPTY_SANDBOX: SandboxSnapshot = Object.freeze({
  columns: Object.freeze([]) as readonly SandboxColumn[],
  carrying: null,
});

const EMPTY_COLUMN_MAP: ReadonlyMap<string, SandboxColumn> = new Map();

/** At most this many sandbox reads in a row are skipped on the decoder hook's word: 5 s of patches. */
const SANDBOX_RESYNC_READS = 100;

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
  readonly #burstListeners = new Map<SandboxBurstListener, symbol>();
  readonly #sandboxDeliveries: SandboxDelivery[] = [];
  readonly #dropDeliveries: SandboxDropDelivery[] = [];
  readonly #burstDeliveries: SandboxBurstDelivery[] = [];
  readonly #footballListeners = new Map<FootballListener, symbol>();
  readonly #goalListeners = new Map<GoalListener, symbol>();
  readonly #footballDeliveries: FootballDelivery[] = [];
  readonly #goalDeliveries: GoalDelivery[] = [];

  #deliveringPeers = false;
  #deliveringStatus = false;
  #deliveringSandbox = false;
  #deliveringDrops = false;
  #deliveringBursts = false;
  #deliveringFootball = false;
  #deliveringGoals = false;

  /** The last value `sandbox()` returned, reused while nothing changes. */
  #sandboxView: SandboxSnapshot = EMPTY_SANDBOX;
  /**
   * The room and the columns last read from its decoded sandbox, by tile
   * key, so a patch that leaves the sandbox alone costs a read-only pass and
   * no allocation (D-086). Re-reading 900 blocks into fresh frozen objects on
   * every 20-a-second patch cost a near-full sandbox 0.5 ms a patch.
   */
  #sandboxReadRoom: ColyseusRoom<unknown, LobbyState> | null = null;
  #sandboxRead: readonly SandboxColumn[] = EMPTY_SANDBOX.columns;
  #sandboxReadByKey: ReadonlyMap<string, SandboxColumn> = EMPTY_COLUMN_MAP;
  /** Scratch list for the read; reused, so an unchanged patch allocates none. */
  readonly #sandboxScratch: SandboxColumn[] = [];
  /**
   * The room whose decoder tells this client which patches touched the
   * sandbox, the hook it runs, and whether one has since the last read. A
   * patch that only moved players then skips the sandbox read entirely.
   */
  #sandboxWatch: {
    readonly room: ColyseusRoom<unknown, LobbyState>;
    readonly serializer: object;
    readonly decoder: object;
    readonly hook: (changes: unknown) => void;
  } | null = null;
  #sandboxDirty = true;
  /**
   * Reads skipped on the hook's word since the last full one. Every
   * `SANDBOX_RESYNC_READS`th read is full regardless, so a patch whose
   * decode failed before it reached the hook cannot leave the sandbox stale
   * for longer than that.
   */
  #sandboxSkips = 0;
  /** The last value delivered to sandbox listeners, for change detection. */
  #sandboxPublished: SandboxSnapshot = EMPTY_SANDBOX;
  /** When the last pick/place left this client, for the client-side floor. */
  #lastSandboxActionAt: number | null = null;
  /** The latest pick/place requested inside the floor, sent when it opens. */
  #pendingSandboxAction: PendingSandboxAction | null = null;
  #sandboxActionHandle: ReturnType<typeof setTimeout> | null = null;

  /** The last value `football()` returned, reused while nothing changes. */
  #footballView: FootballSnapshot | null = null;
  /** The last value delivered to football listeners, for change detection. */
  #footballPublished: FootballSnapshot | null = null;
  /** When the last kick left this client, for the client-side floor. */
  #lastKickAt: number | null = null;
  /** A kick waiting only for a newer position to go first. */
  #kickHandle: ReturnType<typeof setTimeout> | null = null;

  #room: ColyseusRoom<unknown, LobbyState> | null = null;
  #joinAttempt: JoinAttempt | null = null;
  #joinGeneration = 0;
  #status: LobbyStatus = 'idle';

  /** The server-assigned identity. Null until the `welcome` message arrives. */
  #gameId: GameId | null = null;

  /** D-087: the presence area this client is live in; null unless connected. */
  #area: PresenceArea | null = null;
  /**
   * D-087: the placement of the last area switch, until the room's copy of
   * this avatar shows it (or a move sent after it). Peers are withheld until
   * then: the patch that moves this avatar is the one that swaps the views.
   */
  #areaSettle: { readonly x: number; readonly y: number } | null = null;

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

  /** D-087: the presence area this client is live in, or null unless connected. */
  get area(): PresenceArea | null {
    return this.#area;
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
    this.#areaSettle = null;
    this.#cancelReconcile();
    this.#cancelSandboxAction();
    this.#cancelKick();
    this.#desired = null;
    const room = this.#room;
    room.send(MESSAGE.suspend);
    // A transport can report closure synchronously from send; do not let the
    // suspended command overwrite that authoritative lifecycle state.
    if (this.#room !== room || this.#status !== 'connected') return;
    this.#setStatus('suspended');
    // The server puts a carried block back on suspend, and empties this
    // client's view; stop reporting either now rather than when the patch
    // that erases our entry arrives. In a shared-looking room drawn over the
    // street (D-087), stale street peers would otherwise show for a patch.
    this.#emitPeers();
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
   * Go live in a presence area at a placement in it (D-087): from a suspend,
   * from another area, or within the current one to refresh the placement
   * and the sprite. The shell calls it when the player reaches a shared room
   * (the Exchange roof, the Avatar Studio) and, with `street`, when they walk
   * out of one.
   *
   * The room checks the placement against the area: anywhere for the street,
   * a walkable tile for a shared room. A refusal suspends the session there,
   * so a client that disagrees with the room about where it stands is seen by
   * no one rather than seen in the wrong place. Throws, like `resume`, when
   * neither connected nor suspended, or when the area or placement is
   * malformed.
   */
  enterArea(area: PresenceArea, placement: Placement, sprite?: LobbySprite): void {
    const from = this.#status;
    if ((from !== 'connected' && from !== 'suspended') || this.#room === null) {
      throw new Error(`enterArea() requires a connected or suspended client, not "${from}"`);
    }
    if (!PRESENCE_AREAS.includes(area)) throw new Error(INVALID_AREA_ERROR);
    if (placement === null || typeof placement !== 'object') {
      throw new Error(INVALID_RESUME_PLACEMENT_ERROR);
    }
    // Own data properties only, as for resume.
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
    // Anything waiting to go was meant for the area being left.
    this.#cancelReconcile();
    this.#desired = null;
    if (area !== 'street') {
      this.#cancelSandboxAction();
      this.#cancelKick();
    }
    const room = this.#room;
    room.send(MESSAGE.area, {
      area,
      ...next,
      sprite: sprite ?? this.#options.sprite ?? DEFAULT_SPRITE,
    });
    // The transport may synchronously report its own closure while sending.
    if (this.#room !== room || this.#status !== from) return;
    // A refresh within the area (a new look) keeps the same peers in view.
    const sameArea = from === 'connected' && this.#area === area;
    this.#area = area;
    if (!sameArea) this.#areaSettle = { x: next.x, y: next.y };
    this.#lastSentAt = performance.now();
    this.#lastSentPlacement = null;
    if (from === 'suspended') this.#setStatus('connected');
    if (sameArea || this.#room !== room || this.#status !== 'connected') return;
    // Withdraw the area left's peers now, rather than at the next patch.
    this.#emitRoomState();
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
    // A suspended client is in no area and the room sends it no one (D-019).
    if (this.#status === 'suspended') return NO_PEERS;
    if (this.#areaSettle !== null) {
      // D-087: until the room shows this avatar where the switch put it, its
      // view may still hold the area left.
      if (!this.#areaSettled()) return NO_PEERS;
      this.#areaSettle = null;
    }
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
   * Subscribe to bursts (D-071). Returns an unsubscribe function.
   *
   * No replay, like drops. Each burst is the frozen, validated tile of the
   * column that tipped it, delivered before the snapshot that empties the
   * board, so the blocks it throws are still in `sandbox()`. It is an
   * animation cue only: that snapshot is the truth.
   */
  onSandboxBurst(listener: SandboxBurstListener): () => void {
    const owner = Symbol('sandbox burst listener');
    this.#burstListeners.set(listener, owner);
    return () => {
      if (this.#burstListeners.get(listener) === owner) {
        this.#burstListeners.delete(listener);
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

  /**
   * The room's ball and scoreboard (D-078), or null until a valid one has
   * arrived and after a disconnect. Frozen, and the same object for as long
   * as nothing in it changes. Room-wide, not interest-filtered, and readable
   * while suspended.
   */
  football(): FootballSnapshot | null {
    const next = this.#readFootball();
    if (sameFootball(this.#footballView, next)) return this.#footballView;
    this.#footballView = next;
    return next;
  }

  /**
   * Subscribe to the ball. Returns an unsubscribe function.
   *
   * Opens nothing. Fires once immediately with the current snapshot, then
   * whenever the ball or the scoreboard changes. Delivery follows
   * `onSandbox`: FIFO, generation-owned, and a throwing subscriber is
   * isolated behind a fixed diagnostic.
   */
  onFootball(listener: FootballListener): () => void {
    const owner = Symbol('football listener');
    this.#footballListeners.set(listener, owner);
    this.#notifyFootball(listener, this.football());
    return () => {
      if (this.#footballListeners.get(listener) === owner) {
        this.#footballListeners.delete(listener);
      }
    };
  }

  /**
   * Subscribe to goal cues (D-078). Returns an unsubscribe function.
   *
   * No replay: a goal is an event. Each cue is a frozen `{ side }`, delivered
   * before the snapshot that raises the score. A celebration cue only: the
   * score in `football()` is the truth.
   */
  onGoal(listener: GoalListener): () => void {
    const owner = Symbol('goal listener');
    this.#goalListeners.set(listener, owner);
    return () => {
      if (this.#goalListeners.get(listener) === owner) {
        this.#goalListeners.delete(listener);
      }
    };
  }

  /**
   * Kick the ball (D-078). The message carries nothing: the room kicks from
   * where it says this player stands. Returns whether a kick was sent or is
   * about to be; false while not connected (or suspended), or inside the
   * client floor since the last kick. The room applies its own rules and
   * floor and answers only through the ball.
   */
  kick(): boolean {
    if (!this.#onStreet() || this.#room === null) return false;
    if (this.#kickHandle !== null) return true;
    const now = performance.now();
    if (!isValidMonotonicTime(now)) return false;
    const last = this.#lastKickAt;
    if (last !== null && now - last < FOOTBALL_CLIENT_KICK_INTERVAL_MS) return false;
    // A newer position still waiting on the move floor goes first, so the
    // room judges the kick from where the player stands now.
    const desired = this.#desired;
    const unsent = desired !== null &&
      (this.#lastSentPlacement === null || !samePlacement(desired, this.#lastSentPlacement));
    if (unsent) {
      const sinceMove = this.#lastSentAt === null ? null : now - this.#lastSentAt;
      if (sinceMove !== null && sinceMove < this.#minSendIntervalMs) {
        // Claim the floor now, so a second press while this one waits is dropped.
        this.#lastKickAt = now;
        this.#kickHandle = setTimeout(() => {
          this.#kickHandle = null;
          this.#sendKick(true);
        }, Math.min(this.#minSendIntervalMs - sinceMove, MAX_TIMER_DELAY_MS));
        return true;
      }
    }
    return this.#sendKick(unsent);
  }

  /** Send the kick, after the waiting position if `moveFirst`. */
  #sendKick(moveFirst: boolean): boolean {
    if (!this.#onStreet() || this.#room === null) return false;
    const now = performance.now();
    if (moveFirst) {
      const before = this.#room;
      this.#pump(now);
      if (this.#room !== before || this.#status !== 'connected' || this.#room === null) return false;
    }
    const room = this.#room;
    room.send(MESSAGE.kick);
    // A transport can report closure synchronously from send; a retired room
    // must not stamp the floor of whatever replaces it.
    if (this.#room !== room || this.#status !== 'connected') return false;
    this.#lastKickAt = isValidMonotonicTime(now) ? now : this.#lastKickAt;
    return true;
  }

  /** Forget a held kick. Called wherever this client stops sending. */
  #cancelKick(): void {
    if (this.#kickHandle !== null) {
      clearTimeout(this.#kickHandle);
      this.#kickHandle = null;
    }
  }

  /** Leave the room. The client can be connected again afterwards. */
  async disconnect(): Promise<void> {
    this.#cancelReconcile();
    this.#cancelSandboxAction();
    this.#cancelKick();
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

      // D-071 bursts, under the same discipline: registered before the room
      // is published, and anything but a sandbox tile never reaches anyone.
      room.onMessage(SERVER_MESSAGE.sandboxBurst, (payload: unknown) => {
        if (!this.#isCurrentRoom(generation, room)) return;
        const tile = normalizeSandboxTile(payload);
        if (tile === null) return;
        this.#emitBurst(tile);
      });

      // D-078 goal cues, likewise: anything but a side never reaches anyone.
      room.onMessage(SERVER_MESSAGE.goal, (payload: unknown) => {
        if (!this.#isCurrentRoom(generation, room)) return;
        const goal = normalizeGoal(payload);
        if (goal === null) return;
        this.#emitGoal(goal);
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
            this.#cancelKick();
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
      this.#watchSandbox(room);
      this.#desired = null;
      this.#lastSentAt = null;
      this.#lastSentPlacement = null;
      this.#lastSandboxActionAt = null;
      this.#lastKickAt = null;
      this.#cancelSandboxAction();
      this.#cancelKick();
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
        this.#cancelKick();
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
        this.#cancelKick();
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
          this.#cancelKick();
          this.#desired = null;
          this.#setStatus('closed', 'error');
          this.#emitRoomState();
          await failedRoom.leave(true).catch(() => undefined);
        } else if (joinedRoom !== null && this.#status === 'connecting') {
          this.#gameId = null;
          this.#cancelReconcile();
          this.#cancelSandboxAction();
          this.#cancelKick();
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

  /** Whether the room's copy of this avatar shows the last area switch, or a move sent since. */
  #areaSettled(): boolean {
    const settle = this.#areaSettle;
    if (settle === null) return true;
    const self = this.#serverSelf();
    if (self === null) return false;
    if (self.x === settle.x && self.y === settle.y) return true;
    const sent = this.#lastSentPlacement;
    return sent !== null && self.x === sent.x && self.y === sent.y;
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

  /** Live on the street (D-087): the only place with a sandbox and a ball. */
  #onStreet(): boolean {
    return this.#status === 'connected' && this.#area === 'street';
  }

  #setStatus(status: LobbyStatus, reason?: LobbyStatusReason, code?: number): void {
    this.#status = status;
    // D-087: a join and a resume go live on the street; `enterArea` names
    // its area before it reports `connected`. Off the air, no area.
    if (status !== 'connected') {
      this.#area = null;
      this.#areaSettle = null;
    } else if (this.#area === null) {
      this.#area = 'street';
    }
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

  /** Publish everything read from room state: peers, the sandbox, then the ball. */
  #emitRoomState(): void {
    this.#emitPeers();
    this.#emitSandbox();
    this.#emitFootball();
  }

  /** Deliver the current ball if it differs from the last one delivered. */
  #emitFootball(): void {
    const snapshot = this.football();
    if (sameFootball(snapshot, this.#footballPublished)) return;
    this.#footballPublished = snapshot;
    if (this.#footballListeners.size === 0) return;
    this.#footballDeliveries.push({ listeners: [...this.#footballListeners], snapshot });
    if (this.#deliveringFootball) return;

    this.#deliveringFootball = true;
    try {
      for (;;) {
        const delivery = this.#footballDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#footballListeners.get(listener) !== owner) continue;
          this.#notifyFootball(listener, delivery.snapshot);
        }
      }
    } finally {
      this.#deliveringFootball = false;
    }
  }

  #emitGoal(goal: FootballGoal): void {
    if (this.#goalListeners.size === 0) return;
    this.#goalDeliveries.push({ listeners: [...this.#goalListeners], goal });
    if (this.#deliveringGoals) return;

    this.#deliveringGoals = true;
    try {
      for (;;) {
        const delivery = this.#goalDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#goalListeners.get(listener) !== owner) continue;
          this.#notifyGoal(listener, delivery.goal);
        }
      }
    } finally {
      this.#deliveringGoals = false;
    }
  }

  #notifyFootball(listener: FootballListener, snapshot: FootballSnapshot | null): void {
    try {
      listener(snapshot);
    } catch {
      console.error('lobby client: football subscriber threw');
    }
  }

  #notifyGoal(listener: GoalListener, goal: FootballGoal): void {
    try {
      listener(goal);
    } catch {
      console.error('lobby client: goal subscriber threw');
    }
  }

  /** The room's ball and scoreboard, validated, or null. */
  #readFootball(): FootballSnapshot | null {
    const room = this.#room;
    if (room === null) return null;
    let entry: unknown;
    try {
      entry = (room.state as { football?: unknown } | undefined)?.football;
    } catch {
      return null;
    }
    return readFootballEntry(entry);
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

  #emitBurst(tile: SandboxTile): void {
    if (this.#burstListeners.size === 0) return;
    this.#burstDeliveries.push({ listeners: [...this.#burstListeners], tile });
    if (this.#deliveringBursts) return;

    this.#deliveringBursts = true;
    try {
      for (;;) {
        const delivery = this.#burstDeliveries.shift();
        if (delivery === undefined) return;
        for (const [listener, owner] of delivery.listeners) {
          if (this.#burstListeners.get(listener) !== owner) continue;
          this.#notifyBurst(listener, delivery.tile);
        }
      }
    } finally {
      this.#deliveringBursts = false;
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

  #notifyBurst(listener: SandboxBurstListener, tile: SandboxTile): void {
    try {
      listener(tile);
    } catch {
      console.error('lobby client: sandbox burst subscriber threw');
    }
  }

  #readSandbox(): SandboxSnapshot {
    const room = this.#room;
    if (room === null) {
      // Let a retired room go rather than hold it for the next comparison.
      this.#sandboxReadRoom = null;
      this.#sandboxRead = EMPTY_SANDBOX.columns;
      this.#sandboxReadByKey = EMPTY_COLUMN_MAP;
      return EMPTY_SANDBOX;
    }
    const columns = this.#sandboxColumns(room);
    const carrying = this.#onStreet() ? this.#ownCarrying(room) : null;
    if (columns.length === 0 && carrying === null) return EMPTY_SANDBOX;
    return Object.freeze({ columns, carrying });
  }

  /**
   * The room's validated columns, read so that a patch which left the
   * sandbox alone allocates nothing and one that changed a column rebuilds
   * only that column (D-086). A decoded column equal to one already read
   * reuses that frozen column — exactly what `readSandboxColumn` would build
   * from it — and anything else is read and validated in full.
   */
  #sandboxColumns(room: ColyseusRoom<unknown, LobbyState>): readonly SandboxColumn[] {
    const sameRoom = room === this.#sandboxReadRoom;
    const watched = this.#sandboxWatched(room);
    if (sameRoom && watched && !this.#sandboxDirty && this.#sandboxSkips < SANDBOX_RESYNC_READS) {
      this.#sandboxSkips += 1;
      return this.#sandboxRead;
    }
    this.#sandboxSkips = 0;
    if (watched) this.#sandboxDirty = false;
    const read = readSandboxColumns(room, sameRoom ? this.#sandboxReadByKey : EMPTY_COLUMN_MAP, this.#sandboxScratch);
    if (read === null && sameRoom) return this.#sandboxRead;
    const columns = read ?? EMPTY_SANDBOX.columns;
    const byKey = new Map<string, SandboxColumn>();
    for (const column of columns) byKey.set(sandboxTileKey(column.x, column.y), column);
    this.#sandboxReadRoom = room;
    this.#sandboxRead = columns;
    this.#sandboxReadByKey = byKey;
    return columns;
  }

  /**
   * Ask `room`'s decoder to report every patch's changes, and mark the
   * sandbox dirty when one touches it (D-086). Uses the decoder's single raw
   * change hook — `getRawChangesCallback` in `@colyseus/schema` — only if
   * nothing else holds it, and `#sandboxWatched` checks every read that it
   * still does; otherwise the client simply reads the sandbox every patch.
   */
  #watchSandbox(room: ColyseusRoom<unknown, LobbyState>): void {
    this.#sandboxWatch = null;
    this.#sandboxDirty = true;
    try {
      const serializer: unknown = Reflect.get(room, 'serializer');
      if (serializer === null || typeof serializer !== 'object') return;
      const decoder: unknown = Reflect.get(serializer, 'decoder');
      if (decoder === null || typeof decoder !== 'object') return;
      if (Reflect.get(decoder, 'triggerChanges') !== undefined) return;
      const hook = (changes: unknown): void => {
        if (!this.#sandboxDirty && touchesSandbox(changes, room)) this.#sandboxDirty = true;
      };
      Reflect.set(decoder, 'triggerChanges', hook);
      this.#sandboxWatch = { room, serializer, decoder, hook };
    } catch {
      this.#sandboxWatch = null;
    }
  }

  /** Whether `room`'s decoder is still reporting to this client's hook. */
  #sandboxWatched(room: ColyseusRoom<unknown, LobbyState>): boolean {
    const watch = this.#sandboxWatch;
    if (watch === null || watch.room !== room) return false;
    try {
      // The SDK builds a new decoder on a handshake; the old one's hook says
      // nothing about the new one's patches.
      return (
        Reflect.get(watch.serializer, 'decoder') === watch.decoder &&
        Reflect.get(watch.decoder, 'triggerChanges') === watch.hook
      );
    } catch {
      return false;
    }
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
    if (!this.#onStreet() || this.#room === null) return;
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
    if (!this.#onStreet() || this.#room === null) {
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
 * frozen — or null when that would be exactly the columns of `previous`.
 *
 * Fails closed at every level: an unreadable container is an empty sandbox,
 * a malformed column is skipped whole (never partially trusted), and columns
 * beyond the room-wide block cap are not drawn.
 *
 * `previous` is the last result by tile key. A decoded column that matches
 * its entry there field for field is that entry, unread: it is what
 * `readSandboxColumn` would build from it. If every decoded column matched
 * and every previous column was matched, nothing changed and the result is
 * null — `scratch` is the only list it touched.
 */
function readSandboxColumns(
  room: ColyseusRoom<unknown, LobbyState>,
  previous: ReadonlyMap<string, SandboxColumn>,
  scratch: SandboxColumn[],
): readonly SandboxColumn[] | null {
  scratch.length = 0;
  let reused = 0;
  try {
    const container: unknown = (room.state as { sandbox?: unknown } | undefined)?.sandbox;
    if (container === null || typeof container !== 'object') return emptyUnless(previous);
    const forEach = (container as { forEach?: unknown }).forEach;
    if (typeof forEach !== 'function') return emptyUnless(previous);
    Reflect.apply(forEach, container, [
      (value: unknown, key: unknown) => {
        const known = typeof key === 'string' ? previous.get(key) : undefined;
        if (known !== undefined && columnMatches(value, known)) {
          scratch.push(known);
          reused += 1;
          return;
        }
        const column = readSandboxColumn(value, key);
        if (column !== null) scratch.push(column);
      },
    ]);
  } catch {
    scratch.length = 0;
    return emptyUnless(previous);
  }
  if (reused === scratch.length && reused === previous.size) {
    scratch.length = 0;
    return null;
  }
  if (scratch.length === 0) return EMPTY_SANDBOX.columns;

  const columns = scratch.slice();
  scratch.length = 0;
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

/**
 * Whether one patch's decoded changes could have touched the sandbox. Errs
 * towards yes: only a change to the peer map, a presence entry, a position or
 * the ball is known not to. The sandbox's refs are its map, its columns (the
 * only refs with `colours`) and their colour arrays (no `x`, no `gameId`).
 */
function touchesSandbox(changes: unknown, room: ColyseusRoom<unknown, LobbyState>): boolean {
  try {
    if (!Array.isArray(changes)) return true;
    const state = room.state as { peers?: unknown; football?: unknown } | undefined;
    for (const change of changes as unknown[]) {
      const ref: unknown = change !== null && typeof change === 'object' ? (change as { ref?: unknown }).ref : undefined;
      if (ref === null || typeof ref !== 'object') return true;
      if (ref === state?.peers || ref === state?.football) continue;
      if ('gameId' in ref) continue;
      if ('x' in ref && !('colours' in ref)) continue;
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** The empty sandbox, or null when the previous read was already empty. */
function emptyUnless(previous: ReadonlyMap<string, SandboxColumn>): readonly SandboxColumn[] | null {
  return previous.size === 0 ? null : EMPTY_SANDBOX.columns;
}

/** Whether a decoded column holds exactly `known`'s tile and colours. Reads only. */
function columnMatches(value: unknown, known: SandboxColumn): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { x?: unknown; y?: unknown; colours?: unknown };
  if (record.x !== known.x || record.y !== known.y) return false;
  const stack = record.colours;
  if (stack === null || typeof stack !== 'object') return false;
  const colours = known.colours;
  if ((stack as { length?: unknown }).length !== colours.length) return false;
  for (let index = 0; index < colours.length; index += 1) {
    if ((stack as Record<number, unknown>)[index] !== colours[index]) return false;
  }
  return true;
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

/** The phase a wire byte names, or null. */
const FOOTBALL_PHASES: readonly FootballPhase[] = Object.freeze(['live', 'goal', 'full-time']);

/** The pitch square in World pixels, with a tile to spare: nowhere else can the ball be. */
const BALL_BOUNDS = Object.freeze({
  minX: (PITCH_AREA.x - 1) * FOOTBALL_TILE_SIZE,
  maxX: (PITCH_AREA.x + PITCH_AREA.width + 1) * FOOTBALL_TILE_SIZE,
  minY: (PITCH_AREA.y - 1) * FOOTBALL_TILE_SIZE,
  maxY: (PITCH_AREA.y + PITCH_AREA.height + 1) * FOOTBALL_TILE_SIZE,
});

/**
 * The decoded ball entry as a frozen snapshot, or null if any part of it is
 * not exactly right: a tick that is not a whole uint32, a ball outside the
 * pitch square or faster than the rules allow, a score past the winning one,
 * a phase byte the rules do not have.
 */
function readFootballEntry(value: unknown): FootballSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const record = value as Partial<Record<'tick' | 'x' | 'y' | 'vx' | 'vy' | 'west' | 'east' | 'phase', unknown>>;
    const { tick, west, east, phase } = record;
    if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0 || tick > 0xffffffff) return null;
    // Whole 64ths of a pixel on the wire (FOOTBALL_WIRE_SCALE), World pixels here.
    const parts = [record.x, record.y, record.vx, record.vy];
    if (!parts.every((part) => typeof part === 'number' && Number.isSafeInteger(part))) return null;
    const [x, y, vx, vy] = (parts as number[]).map((part) => part / FOOTBALL_WIRE_SCALE) as [number, number, number, number];
    if (x < BALL_BOUNDS.minX || x > BALL_BOUNDS.maxX || y < BALL_BOUNDS.minY || y > BALL_BOUNDS.maxY) return null;
    if (Math.hypot(vx, vy) > FOOTBALL_MAX_SPEED * 1.01) return null;
    const score = (part: unknown): part is number =>
      typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= FOOTBALL_WIN_SCORE;
    if (!score(west) || !score(east)) return null;
    const named = typeof phase === 'number' && Number.isInteger(phase) ? FOOTBALL_PHASES[phase] : undefined;
    if (named === undefined) return null;
    return Object.freeze({ tick, x, y, vx, vy, west, east, phase: named });
  } catch {
    return null;
  }
}

/** A goal cue, or null: `{ side }`, read from an own data property, and nothing else. */
function normalizeGoal(payload: unknown): FootballGoal | null {
  if (payload === null || typeof payload !== 'object') return null;
  const side = ownDataField(payload, 'side');
  return side === 'west' || side === 'east' ? Object.freeze({ side }) : null;
}

function sameFootball(a: FootballSnapshot | null, b: FootballSnapshot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.tick === b.tick &&
    a.x === b.x &&
    a.y === b.y &&
    a.vx === b.vx &&
    a.vy === b.vy &&
    a.west === b.west &&
    a.east === b.east &&
    a.phase === b.phase
  );
}

function sameSandbox(a: SandboxSnapshot, b: SandboxSnapshot): boolean {
  if (a === b) return true;
  if (a.carrying !== b.carrying || a.columns.length !== b.columns.length) return false;
  if (a.columns === b.columns) return true;
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
