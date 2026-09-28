/**
 * The presence registry: room state and the operations on it, minus the
 * transport.
 *
 * This owns a real Colyseus state instance but knows nothing about sockets,
 * clients or the matchmaker, so every rule that matters — admission,
 * throttling, suspend, interest, and the block sandbox's actions and returns
 * (D-060) — is exercisable in a plain unit test against the same objects that
 * get encoded in production.
 *
 * Nothing here persists. When the last session leaves, the registry is empty
 * and the room disposes; there is no store behind it and no log of who was
 * ever in it.
 */

import { MapSchema } from '@colyseus/schema';
import type { Facing, GameId, SandboxColumn, SandboxTile } from '@strkworld/shared';
import {
  resolveRoomConfig,
} from './config.js';
import {
  UpdateThrottle,
  createGameId,
  normalizeCoordinate,
  normalizeFacing,
  normalizeSandboxColour,
  normalizeSprite,
  selectVisible,
} from './policy.js';
import {
  LobbySandbox,
  type SandboxAction,
  type SandboxActionOutcome,
} from './sandbox.js';
import type { SandboxPlayer } from './sandbox-rules.js';
import { LobbyState, PresenceEntry, type SandboxColumnEntry } from './state.js';

/**
 * What a client may offer when it joins or reappears. All of it untrusted.
 *
 * Note there is deliberately no `gameId`: the identifier is minted on the
 * server (see `admit`), so a client-supplied one has nowhere to arrive. Any
 * such field on the wire is ignored by construction.
 */
export interface PlacementRequest {
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
  sandboxSpawnIntervalMs?: number;
  sandboxSlowSpawnIntervalMs?: number;
  sandboxFastSpawnLimit?: number;
  sandboxActionIntervalMs?: number;
  /**
   * Randomness source for server-minted identifiers. Injectable so a test can
   * be deterministic; production uses `crypto.getRandomValues`.
   */
  random?: (bytes: Uint8Array) => Uint8Array;
  /**
   * Uniform `[0, 1)` source for sandbox sky drops (D-060). Injectable so a
   * test can be deterministic; production uses `Math.random` — where a block
   * lands is public and cosmetic, so it needs no cryptographic source.
   */
  sandboxRandom?: () => number;
  /**
   * Told about every block that falls from the sky — a spawn, or a carried
   * block put back when its carrier leaves the street — after it is in state.
   * The room broadcasts it as the `sandbox:drop` hint. Tile only: nothing
   * about who caused it.
   */
  onSandboxDrop?: (tile: SandboxTile) => void;
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
  readonly #random: ((bytes: Uint8Array) => Uint8Array) | undefined;
  /** D-060: the room's block sandbox, mirrored into `state.sandbox`. */
  readonly #sandbox: LobbySandbox;
  readonly #onSandboxDrop: ((tile: SandboxTile) => void) | undefined;

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
    const config = resolveRoomConfig(options);
    this.#spriteKeys = config.spriteKeys;
    this.#defaultSprite = config.defaultSprite;
    this.#interestRadius = config.interestRadius;
    this.#maxVisiblePeers = config.maxVisiblePeers;
    this.#capacity = config.capacity;
    this.#worldLimit = config.worldLimit;
    this.#throttle = new UpdateThrottle(
      config.minUpdateIntervalMs,
    );
    this.#random = options.random;
    this.#sandbox = new LobbySandbox(
      this.state.sandbox as MapSchema<SandboxColumnEntry>,
      {
        ...(options.sandboxRandom === undefined ? {} : { random: options.sandboxRandom }),
        actionIntervalMs: config.sandboxActionIntervalMs,
        spawnIntervalMs: config.sandboxSpawnIntervalMs,
        slowSpawnIntervalMs: config.sandboxSlowSpawnIntervalMs,
        fastSpawnLimit: config.sandboxFastSpawnLimit,
      },
    );
    this.#onSandboxDrop = options.onSandboxDrop;
  }

  get peers(): MapSchema<PresenceEntry> {
    return this.state.peers as MapSchema<PresenceEntry>;
  }

  /**
   * Admit a connection, minting its session identifier on the server.
   *
   * The identifier is generated here, not supplied by the client — a
   * client-offered id has no field to arrive in (see `PlacementRequest`) and
   * would be ignored anyway. That is what makes "ephemeral per-session" an
   * enforced property rather than a client courtesy: the client cannot pin,
   * reuse or choose the entropy of its identity.
   *
   * Every rejection is a shape or capacity problem. There is no authentication
   * and deliberately nothing to authenticate against — a lobby session is
   * anonymous by construction.
   */
  admit(sessionKey: string, request: PlacementRequest): AdmitOutcome {
    if (this.#sessions.has(sessionKey)) {
      this.#refused += 1;
      return { ok: false, reason: 'session-in-use' };
    }
    if (this.#sessions.size >= this.#capacity) {
      this.#refused += 1;
      return { ok: false, reason: 'at-capacity' };
    }
    const gameId = this.#mintGameId();
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

    const x = normalizeCoordinate(ownDataField(request, 'x'), this.#worldLimit);
    const y = normalizeCoordinate(ownDataField(request, 'y'), this.#worldLimit);
    if (x === null || y === null) return 'rejected';

    if (!this.#throttle.accept(sessionKey, now)) {
      this.#throttled += 1;
      return 'throttled';
    }

    entry.position.x = x;
    entry.position.y = y;
    entry.facing = normalizeFacing(ownDataField(request, 'facing'));
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
   *
   * The session's rate-floor timestamp is deliberately *not* cleared. Clearing
   * it would let the first move after a resume bypass the floor, and a
   * suspend/resume cycle would become a way to write a position on demand
   * outside the rate limit. The sandbox action floor is kept for the same
   * reason.
   *
   * A sandbox block the player was carrying is put back (D-060): it falls
   * from the sky onto a random allowed tile — never within a tile of where
   * the player stood, so the drop cannot mark where they left the street —
   * and `resume` starts empty-handed.
   */
  suspend(sessionKey: string): boolean {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return false;
    // Every live position, the leaver's included, before their entry goes.
    const players = this.#livePlayers();
    session.suspended = true;
    this.peers.delete(session.gameId);
    this.#announce(this.#sandbox.returnCarried(sessionKey, players));
    this.#suspensions += 1;
    return true;
  }

  /**
   * Put a suspended avatar back on the street.
   *
   * The client supplies its position again because the room threw the old one
   * away. That is the point of erasing it.
   *
   * The placement is routed through the rate floor: `resume` stamps the throttle
   * with `now`, so a client cannot use repeated suspend/resume as an
   * unthrottled position-write channel, and the next `move` must still wait a
   * full interval. The un-suspend itself always succeeds — it is a rare state
   * transition gated by the shell's building-exit — but it can never write
   * faster than a move could.
   */
  resume(sessionKey: string, request: PlacementRequest, now: number): boolean {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || !session.suspended) return false;
    if (!isValidMonotonicTime(now)) return false;
    // A resume writes a position, so it must consume the same safe floor as a
    // move before that placement is allowed back into live state.
    if (!this.#place(session.gameId, request)) return false;
    // `now` was validated before writing, so this can neither reject nor leave
    // a newly placed session suspended. Keep the guard as local defence.
    if (!this.#throttle.stamp(sessionKey, now)) {
      this.peers.delete(session.gameId);
      return false;
    }
    session.suspended = false;
    this.#resumptions += 1;
    this.#peak = Math.max(this.#peak, this.peers.size);
    return true;
  }

  /**
   * Forget a connection completely. Called on leave and on dispose. A carried
   * sandbox block is put back as on suspend (D-060).
   */
  release(sessionKey: string): void {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined) return;
    const players = this.#livePlayers();
    this.peers.delete(session.gameId);
    this.#sessions.delete(sessionKey);
    this.#throttle.forget(sessionKey);
    this.#announce(this.#sandbox.forget(sessionKey, players));
    this.#departed += 1;
  }

  // -------------------------------------------------------------------------
  // The block sandbox — D-060
  // -------------------------------------------------------------------------

  /**
   * Take the top block of a neighbouring stack, for a session on the street.
   *
   * `request` is the untrusted client payload. The actor's position is the
   * one this registry already holds — never anything the request says — and
   * every other live entry counts as a player the rules must respect.
   */
  pickBlock(sessionKey: string, request: unknown, now: number): SandboxActionOutcome {
    return this.#actOnSandbox('pick', sessionKey, request, now);
  }

  /** Put the carried block on a neighbouring stack. See `pickBlock`. */
  placeBlock(sessionKey: string, request: unknown, now: number): SandboxActionOutcome {
    return this.#actOnSandbox('place', sessionKey, request, now);
  }

  /**
   * Drop one block from the sky, never within a tile of a live player. Null
   * when no block may fall (cap reached, nowhere allowed). Announced through
   * `onSandboxDrop` like every sky drop.
   */
  spawnBlock(): SandboxTile | null {
    const tile = this.#sandbox.spawn(this.#livePlayers());
    this.#announce(tile);
    return tile;
  }

  /** Whether any session is on the street — the spawner runs only then. */
  get hasLivePlayers(): boolean {
    for (const session of this.#sessions.values()) {
      if (!session.suspended && this.peers.has(session.gameId)) return true;
    }
    return false;
  }

  /** How long the room's spawner should wait before the next drop. */
  nextSpawnDelayMs(): number {
    return this.#sandbox.nextSpawnDelayMs();
  }

  /** Every non-empty stack, as the authority holds it. Frozen. */
  sandboxColumns(): readonly SandboxColumn[] {
    return this.#sandbox.columns();
  }

  /** The colour a connection carries, or null. Server-side only. */
  sandboxCarrying(sessionKey: string): number | null {
    return this.#sandbox.carrying(sessionKey);
  }

  /** Placed plus carried blocks. */
  get sandboxBlocks(): number {
    return this.#sandbox.totalBlocks;
  }

  #actOnSandbox(
    action: SandboxAction,
    sessionKey: string,
    request: unknown,
    now: number,
  ): SandboxActionOutcome {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return 'absent';
    const entry = this.peers.get(session.gameId);
    if (entry === undefined) return 'absent';

    const actor: SandboxPlayer = {
      key: sessionKey,
      x: entry.position.x,
      y: entry.position.y,
    };
    const outcome = this.#sandbox.act(
      action,
      actor,
      request,
      this.#livePlayers(sessionKey),
      now,
    );
    if (outcome === 'applied') {
      // The only per-player sandbox field on the wire, written from the
      // authority's own record rather than from anything the client said.
      entry.carrying = normalizeSandboxColour(this.#sandbox.carrying(sessionKey)) ?? -1;
    }
    return outcome;
  }

  #announce(tile: SandboxTile | null): void {
    if (tile !== null) this.#onSandboxDrop?.(tile);
  }

  /** Every live entry as a sandbox player, optionally leaving one session out. */
  #livePlayers(exceptSessionKey?: string): SandboxPlayer[] {
    const players: SandboxPlayer[] = [];
    for (const [key, session] of this.#sessions) {
      if (key === exceptSessionKey || session.suspended) continue;
      const entry = this.peers.get(session.gameId);
      if (entry === undefined) continue;
      players.push({ key, x: entry.position.x, y: entry.position.y });
    }
    return players;
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

  /** Mint a server-side identifier that no live session already holds. */
  #mintGameId(): GameId {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = createGameId(this.#random);
      if (!this.#isClaimed(candidate)) return candidate;
    }
    // 64 bits of entropy against at most HARD_MAX_CLIENTS live ids makes eight
    // collisions in a row astronomically unlikely; fail loud rather than spin.
    throw new Error('could not mint a unique gameId');
  }

  #isClaimed(gameId: GameId): boolean {
    for (const session of this.#sessions.values()) {
      if (session.gameId === gameId) return true;
    }
    return false;
  }

  /** Build and store an entry, or report that the placement was unusable. */
  #place(gameId: GameId, request: PlacementRequest): boolean {
    const x = normalizeCoordinate(ownDataField(request, 'x'), this.#worldLimit);
    const y = normalizeCoordinate(ownDataField(request, 'y'), this.#worldLimit);
    if (x === null || y === null) return false;

    const entry = new PresenceEntry();
    entry.gameId = gameId;
    entry.position.x = x;
    entry.position.y = y;
    entry.facing = normalizeFacing(ownDataField(request, 'facing')) satisfies Facing;
    entry.sprite = normalizeSprite(
      ownDataField(request, 'sprite'),
      this.#spriteKeys,
      this.#defaultSprite,
    );
    this.peers.set(gameId, entry);
    return true;
  }
}

function isValidMonotonicTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function ownDataField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
