/**
 * The presence registry: room state and the operations on it, minus the
 * transport.
 *
 * This owns a real Colyseus state instance but knows nothing about sockets,
 * clients or the matchmaker, so every rule that matters — admission,
 * throttling, suspend, interest — is exercisable in a plain unit test against
 * the same objects that get encoded in production.
 *
 * Nothing here persists. When the last session leaves, the registry is empty
 * and the room disposes; there is no store behind it and no log of who was
 * ever in it.
 */

import { MapSchema } from '@colyseus/schema';
import type { Facing, GameId } from '@strkworld/shared';
import {
  DEFAULT_SPRITE,
  DEFAULT_SPRITE_KEYS,
  INTEREST_RADIUS,
  MAX_CLIENTS_PER_ROOM,
  MAX_VISIBLE_PEERS,
  MIN_UPDATE_INTERVAL_MS,
  WORLD_LIMIT,
} from './config';
import {
  UpdateThrottle,
  normalizeCoordinate,
  normalizeFacing,
  normalizeGameId,
  normalizeSprite,
  selectVisible,
} from './policy';
import { LobbyState, PresenceEntry } from './state';

/** What a client may offer when it joins or reappears. All of it untrusted. */
export interface PlacementRequest {
  gameId?: unknown;
  x?: unknown;
  y?: unknown;
  facing?: unknown;
  sprite?: unknown;
}

/** What a client may offer on the high-rate path. */
export interface MoveRequest {
  x?: unknown;
  y?: unknown;
  facing?: unknown;
}

export type AdmitRejection =
  /** Not 16 lowercase hex characters. */
  | 'malformed-id'
  /** Another live session already holds it. */
  | 'id-in-use'
  /** This connection already holds a session. */
  | 'session-in-use'
  /** Coordinates were absent or not finite. */
  | 'bad-placement'
  /** The room is full. */
  | 'at-capacity';

export type AdmitOutcome =
  | { readonly ok: true; readonly gameId: GameId }
  | { readonly ok: false; readonly reason: AdmitRejection };

export type MoveOutcome =
  /** Written to state. */
  | 'applied'
  /** Arrived inside the rate floor and was dropped. */
  | 'throttled'
  /** Coordinates were not finite. */
  | 'rejected'
  /** No live entry — unknown or currently suspended. */
  | 'absent';

/**
 * Aggregate counters. The complete set of numbers this package will ever
 * report, and none of them is per-player: no session identifier, no
 * coordinate, no timing of any individual join. See AGENTS.md §4.
 */
export interface PresenceCounters {
  readonly present: number;
  readonly suspended: number;
  readonly admitted: number;
  readonly refused: number;
  readonly departed: number;
  readonly suspensions: number;
  readonly resumptions: number;
  readonly throttled: number;
  readonly peak: number;
}

export interface LobbyPresenceOptions {
  spriteKeys?: readonly string[];
  defaultSprite?: string;
  interestRadius?: number;
  maxVisiblePeers?: number;
  minUpdateIntervalMs?: number;
  capacity?: number;
  worldLimit?: number;
}

interface Session {
  readonly gameId: GameId;
  /** True while the client is inside an interior overlay. See D-019. */
  suspended: boolean;
}

export class LobbyPresence {
  /** The live Colyseus state. Assigned to `Room.state` by the room. */
  readonly state: LobbyState;

  readonly #spriteKeys: readonly string[];
  readonly #defaultSprite: string;
  readonly #interestRadius: number;
  readonly #maxVisiblePeers: number;
  readonly #capacity: number;
  readonly #worldLimit: number;
  readonly #throttle: UpdateThrottle;

  /**
   * Connection key to session. Lives only as long as the connection: it is
   * how a suspended client reclaims its own identifier and how leave knows
   * what to erase.
   */
  readonly #sessions = new Map<string, Session>();

  #admitted = 0;
  #refused = 0;
  #departed = 0;
  #suspensions = 0;
  #resumptions = 0;
  #throttled = 0;
  #peak = 0;

  constructor(options: LobbyPresenceOptions = {}) {
    this.state = new LobbyState();
    this.#spriteKeys = options.spriteKeys ?? DEFAULT_SPRITE_KEYS;
    this.#defaultSprite = options.defaultSprite ?? DEFAULT_SPRITE;
    this.#interestRadius = options.interestRadius ?? INTEREST_RADIUS;
    this.#maxVisiblePeers = options.maxVisiblePeers ?? MAX_VISIBLE_PEERS;
    this.#capacity = options.capacity ?? MAX_CLIENTS_PER_ROOM;
    this.#worldLimit = options.worldLimit ?? WORLD_LIMIT;
    this.#throttle = new UpdateThrottle(
      options.minUpdateIntervalMs ?? MIN_UPDATE_INTERVAL_MS,
    );
  }

  get peers(): MapSchema<PresenceEntry> {
    return this.state.peers as MapSchema<PresenceEntry>;
  }

  /**
   * Admit a connection under a client-generated identifier.
   *
   * Every rejection reason is a shape or capacity problem. There is no
   * authentication here and there is deliberately nothing to authenticate
   * against — a lobby session is anonymous by construction.
   */
  admit(sessionKey: string, request: PlacementRequest): AdmitOutcome {
    if (this.#sessions.has(sessionKey)) {
      this.#refused += 1;
      return { ok: false, reason: 'session-in-use' };
    }
    const gameId = normalizeGameId(request.gameId);
    if (gameId === null) {
      this.#refused += 1;
      return { ok: false, reason: 'malformed-id' };
    }
    if (this.#isClaimed(gameId)) {
      this.#refused += 1;
      return { ok: false, reason: 'id-in-use' };
    }
    if (this.#sessions.size >= this.#capacity) {
      this.#refused += 1;
      return { ok: false, reason: 'at-capacity' };
    }
    const placed = this.#place(gameId, request);
    if (!placed) {
      this.#refused += 1;
      return { ok: false, reason: 'bad-placement' };
    }
    this.#sessions.set(sessionKey, { gameId, suspended: false });
    this.#admitted += 1;
    this.#peak = Math.max(this.#peak, this.peers.size);
    return { ok: true, gameId };
  }

  /** Apply a movement, subject to the per-session rate floor. */
  move(sessionKey: string, request: MoveRequest, now: number): MoveOutcome {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return 'absent';
    const entry = this.peers.get(session.gameId);
    if (entry === undefined) return 'absent';

    const x = normalizeCoordinate(request.x, this.#worldLimit);
    const y = normalizeCoordinate(request.y, this.#worldLimit);
    if (x === null || y === null) return 'rejected';

    if (!this.#throttle.accept(sessionKey, now)) {
      this.#throttled += 1;
      return 'throttled';
    }

    entry.position.x = x;
    entry.position.y = y;
    entry.facing = normalizeFacing(request.facing);
    return 'applied';
  }

  /**
   * Drop the avatar out of the world while the connection stays open.
   *
   * The shell calls this when the player steps into an interior (D-019). The
   * entry is erased, not hidden: nothing about where the player was standing
   * survives the call, so a later leak cannot reconstruct it. The identifier
   * stays reserved to this connection so no one else can take it and so
   * `resume` puts the same player back.
   */
  suspend(sessionKey: string): boolean {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return false;
    session.suspended = true;
    this.peers.delete(session.gameId);
    this.#throttle.forget(sessionKey);
    this.#suspensions += 1;
    return true;
  }

  /**
   * Put a suspended avatar back on the street.
   *
   * The client supplies its position again because the room threw the old one
   * away. That is the point of erasing it.
   */
  resume(sessionKey: string, request: PlacementRequest): boolean {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || !session.suspended) return false;
    if (!this.#place(session.gameId, request)) return false;
    session.suspended = false;
    this.#resumptions += 1;
    this.#peak = Math.max(this.#peak, this.peers.size);
    return true;
  }

  /** Forget a connection completely. Called on leave and on dispose. */
  release(sessionKey: string): void {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined) return;
    this.peers.delete(session.gameId);
    this.#sessions.delete(sessionKey);
    this.#throttle.forget(sessionKey);
    this.#departed += 1;
  }

  /** The identifier a connection currently holds, if any. */
  gameIdFor(sessionKey: string): GameId | undefined {
    return this.#sessions.get(sessionKey)?.gameId;
  }

  /** The live entry for a connection, if it has one on the street. */
  entryFor(sessionKey: string): PresenceEntry | undefined {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return undefined;
    return this.peers.get(session.gameId);
  }

  /**
   * The other entries this connection should receive: inside the interest
   * radius, nearest first, capped. The observer's own entry is not included —
   * the room adds that separately, so the cap means what its name says.
   */
  visibleTo(sessionKey: string): PresenceEntry[] {
    const self = this.entryFor(sessionKey);
    if (self === undefined) return [];
    const others: PresenceEntry[] = [];
    this.peers.forEach((entry) => {
      if (entry !== self) others.push(entry);
    });
    return selectVisible(
      self,
      others,
      this.#interestRadius,
      this.#maxVisiblePeers,
    );
  }

  counters(): PresenceCounters {
    let suspended = 0;
    for (const session of this.#sessions.values()) {
      if (session.suspended) suspended += 1;
    }
    return {
      present: this.peers.size,
      suspended,
      admitted: this.#admitted,
      refused: this.#refused,
      departed: this.#departed,
      suspensions: this.#suspensions,
      resumptions: this.#resumptions,
      throttled: this.#throttled,
      peak: this.#peak,
    };
  }

  #isClaimed(gameId: GameId): boolean {
    for (const session of this.#sessions.values()) {
      if (session.gameId === gameId) return true;
    }
    return false;
  }

  /** Build and store an entry, or report that the placement was unusable. */
  #place(gameId: GameId, request: PlacementRequest): boolean {
    const x = normalizeCoordinate(request.x, this.#worldLimit);
    const y = normalizeCoordinate(request.y, this.#worldLimit);
    if (x === null || y === null) return false;

    const entry = new PresenceEntry();
    entry.gameId = gameId;
    entry.position.x = x;
    entry.position.y = y;
    entry.facing = normalizeFacing(request.facing) satisfies Facing;
    entry.sprite = normalizeSprite(
      request.sprite,
      this.#spriteKeys,
      this.#defaultSprite,
    );
    this.peers.set(gameId, entry);
    return true;
  }
}
