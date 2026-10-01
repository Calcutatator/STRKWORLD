/**
 * The presence registry: room state and the operations on it, minus the
 * transport.
 *
 * This owns a real Colyseus state instance but knows nothing about sockets,
 * clients or the matchmaker, so every rule that matters — admission,
 * throttling, suspend, presence areas (D-087), interest, the block sandbox's actions and returns
 * (D-060) and the football's kicks and steps (D-078) — is exercisable in a
 * plain unit test against the same objects that get encoded in production.
 *
 * Nothing here persists. When the last session leaves, the registry is empty
 * and the room disposes; there is no store behind it and no log of who was
 * ever in it.
 */

import { MapSchema } from '@colyseus/schema';
import type {
  Facing,
  FootballSnapshot,
  GameId,
  PresenceArea,
  SandboxColumn,
  SandboxTile,
} from '@strkworld/shared';
import { isAreaStepAllowed, isAreaWalkable, normalizePresenceArea } from './areas.js';
import { MOVE_BURST, resolveRoomConfig } from './config.js';
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
import { LobbyFootball, type KickOutcome } from './football.js';
import type { BallState, FootballEvent, FootballPlayer } from './football-rules.js';
import { LobbyState, PresenceEntry, type FootballEntry, type SandboxColumnEntry } from './state.js';

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

/**
 * D-087: what a client may offer when it goes live in a presence area. All of
 * it untrusted; `area` must name one of `PRESENCE_AREAS`.
 */
export interface AreaRequest extends PlacementRequest {
  area?: unknown;
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
  /**
   * Coordinates were not finite, or (D-087) not a step the session's shared
   * area allows: off its walkable tiles, or across a solid one.
   */
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
  /** Moves refused as malformed or, in a shared area, off its walkable tiles (D-087). */
  readonly rejected: number;
  /** Accepted changes of presence area (D-087). */
  readonly areaSwitches: number;
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
  /** D-078: per-session floor between two accepted kicks. */
  footballKickIntervalMs?: number;
  /** D-078: where the ball starts; a kick-off ball when absent. A test seam. */
  footballBall?: BallState;
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
  /**
   * D-071: told when a block bursts the sandbox — a place, a sky drop or a
   * returned block onto a column already holding `SANDBOX_BURST_HEIGHT` —
   * with that column's tile, once every placed block is gone from state. The
   * room broadcasts it as `sandbox:burst`. Tile only, like a drop.
   */
  onSandboxBurst?: (tile: SandboxTile) => void;
}

interface Session {
  readonly gameId: GameId;
  /** True while the client is inside an interior overlay. See D-019. */
  suspended: boolean;
  /**
   * D-087: the presence area the session is live in; meaningful only while
   * not suspended. Server-side only: no field of the room state says it, so
   * a client learns nothing about any other player's area but whether that
   * player is in its own.
   */
  area: PresenceArea;
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
  readonly #onSandboxBurst: ((tile: SandboxTile) => void) | undefined;
  /** D-078: the room's ball, mirrored into `state.football`. */
  readonly #football: LobbyFootball;
  /**
   * When each connection's position was last written, for the ball to read
   * how fast a player moves. Server-side only, and gone on leave.
   */
  readonly #movedAt = new Map<string, number>();

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
  #rejected = 0;
  #areaSwitches = 0;
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
    // A token bucket, not a strict gap, so network jitter on a stream sent
    // at the floor does not drop moves (D-086).
    this.#throttle = new UpdateThrottle(config.minUpdateIntervalMs, MOVE_BURST);
    this.#random = options.random;
    this.#sandbox = new LobbySandbox(
      this.state.sandbox as MapSchema<SandboxColumnEntry>,
      {
        ...(options.sandboxRandom === undefined ? {} : { random: options.sandboxRandom }),
        actionIntervalMs: config.sandboxActionIntervalMs,
        spawnIntervalMs: config.sandboxSpawnIntervalMs,
        slowSpawnIntervalMs: config.sandboxSlowSpawnIntervalMs,
        fastSpawnLimit: config.sandboxFastSpawnLimit,
        onBurst: (tile) => this.#onSandboxBurst?.(tile),
      },
    );
    this.#onSandboxDrop = options.onSandboxDrop;
    this.#onSandboxBurst = options.onSandboxBurst;
    this.#football = new LobbyFootball(this.state.football as FootballEntry, {
      kickIntervalMs: config.footballKickIntervalMs,
      ...(options.footballBall === undefined ? {} : { ball: options.footballBall }),
    });
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
    this.#sessions.set(sessionKey, { gameId, suspended: false, area: 'street' });
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
    if (x === null || y === null) {
      this.#rejected += 1;
      return 'rejected';
    }
    // D-087: a shared room holds its players to its own walkable tiles. The
    // street keeps its rule, a clamp to the world.
    if (session.area !== 'street' && !isAreaStepAllowed(session.area, entry.position, { x, y })) {
      this.#rejected += 1;
      return 'rejected';
    }

    if (!this.#throttle.accept(sessionKey, now)) {
      this.#throttled += 1;
      return 'throttled';
    }

    entry.position.x = x;
    entry.position.y = y;
    entry.facing = normalizeFacing(ownDataField(request, 'facing'));
    this.#movedAt.set(sessionKey, now);
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
    // Off the street, off the pitch: the ball stops following them (D-078).
    this.#football.lose(sessionKey);
    this.#movedAt.delete(sessionKey);
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
    session.area = 'street';
    this.#movedAt.set(sessionKey, now);
    this.#resumptions += 1;
    this.#peak = Math.max(this.#peak, this.peers.size);
    return true;
  }

  /**
   * D-087: go live in a presence area at a placement in it — from a suspend,
   * from another area, or within the same area to refresh the placement and
   * the sprite. Returns whether it was applied.
   *
   * The placement is checked against the area entered: anywhere in the world
   * for the street, as `resume`; a walkable tile for a shared room. It is not
   * checked against the area left, because the two do not share coordinates
   * — the Studio is drawn over the hidden street, the roof above it — and a
   * change of area is a teleport by nature.
   *
   * A malformed request, or a placement off the area's walkable tiles,
   * suspends a live session rather than leaving it where it was: a client
   * that disagrees with the room about where it stands would otherwise send
   * one area's coordinates as moves in another, and be drawn in the wrong
   * place. Seen by no one is the safe failure.
   *
   * Like `resume`, it always succeeds when well formed and stamps the move
   * floor with `now`, so switching areas is never a faster position-write
   * channel than moving. A live switch keeps the same entry: views drop it
   * and pick it up at the next patch, once each, like any move (D-086).
   * Leaving the street puts a carried block back and leaves the ball, as a
   * suspend does; a shared room has neither.
   */
  enterArea(sessionKey: string, request: AreaRequest, now: number): boolean {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined) return false;
    if (!isValidMonotonicTime(now)) return false;
    const area = normalizePresenceArea(ownDataField(request, 'area'));
    const x = normalizeCoordinate(ownDataField(request, 'x'), this.#worldLimit);
    const y = normalizeCoordinate(ownDataField(request, 'y'), this.#worldLimit);
    if (
      area === null ||
      x === null ||
      y === null ||
      (area !== 'street' && !isAreaWalkable(area, x, y))
    ) {
      this.suspend(sessionKey);
      return false;
    }

    if (session.suspended) {
      if (!this.#place(session.gameId, request)) return false;
      if (!this.#throttle.stamp(sessionKey, now)) {
        this.peers.delete(session.gameId);
        return false;
      }
      session.suspended = false;
    } else {
      const entry = this.peers.get(session.gameId);
      if (entry === undefined) return false;
      if (!this.#throttle.stamp(sessionKey, now)) return false;
      if (session.area === 'street' && area !== 'street') {
        // Every street position, the leaver's included, before they go.
        const players = this.#livePlayers();
        this.#announce(this.#sandbox.returnCarried(sessionKey, players));
        this.#football.lose(sessionKey);
        entry.carrying = -1;
      }
      entry.position.x = x;
      entry.position.y = y;
      entry.facing = normalizeFacing(ownDataField(request, 'facing'));
      entry.sprite = normalizeSprite(
        ownDataField(request, 'sprite'),
        this.#spriteKeys,
        this.#defaultSprite,
      );
    }
    if (session.area !== area) this.#areaSwitches += 1;
    session.area = area;
    this.#movedAt.set(sessionKey, now);
    this.#peak = Math.max(this.#peak, this.peers.size);
    return true;
  }

  /** D-087: the area a connection is live in, or null while suspended or unknown. */
  areaFor(sessionKey: string): PresenceArea | null {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return null;
    return session.area;
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
    this.#football.forget(sessionKey);
    this.#movedAt.delete(sessionKey);
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
   * when no block may fall (cap reached, nowhere allowed) or when it burst
   * the sandbox instead, which `onSandboxBurst` announces (D-071). A landed
   * block is announced through `onSandboxDrop` like every sky drop.
   */
  spawnBlock(): SandboxTile | null {
    const tile = this.#sandbox.spawn(this.#livePlayers());
    this.#announce(tile);
    return tile;
  }

  /** Whether any session is on the street — the spawner runs only then. */
  get hasLivePlayers(): boolean {
    for (const session of this.#sessions.values()) {
      if (!session.suspended && session.area === 'street' && this.peers.has(session.gameId)) return true;
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
    // The sandbox is on the street (D-087): a shared room's coordinates are
    // not street tiles, whatever their numbers say.
    if (session === undefined || session.suspended || session.area !== 'street') return 'absent';
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

  // -------------------------------------------------------------------------
  // The football — D-078
  // -------------------------------------------------------------------------

  /**
   * Kick the ball for a session on the street, from the position and facing
   * this registry holds: the kick message carries nothing, so nothing a client
   * says is read. Refusals are silent; the state is the only answer.
   */
  kickBall(sessionKey: string, now: number): KickOutcome {
    const session = this.#sessions.get(sessionKey);
    // The pitch is on the street (D-087); the Studio is drawn over it.
    if (session === undefined || session.suspended || session.area !== 'street') return 'absent';
    const entry = this.peers.get(session.gameId);
    if (entry === undefined) return 'absent';
    return this.#football.kick(
      { key: sessionKey, x: entry.position.x, y: entry.position.y, facing: normalizeFacing(entry.facing) },
      now,
    );
  }

  /**
   * Run the ball while anyone on the street is on or near the pitch, and
   * bring it to rest otherwise. Returns whether it runs; the room keeps its
   * step timer to match.
   */
  keepFootballRunning(now: number): boolean {
    return this.#football.keepRunning(this.#footballPlayers(), now);
  }

  /** Every whole simulation step up to `now`, and what happened in them. Nothing while the ball is at rest. */
  footballTick(now: number): FootballEvent[] {
    return this.#football.advance(now, this.#footballPlayers());
  }

  /** Whether the ball is running. */
  get footballRunning(): boolean {
    return this.#football.running;
  }

  /** The ball, the score and the phase, as the authority holds them. Frozen. */
  footballSnapshot(): FootballSnapshot {
    return this.#football.snapshot();
  }

  /** Every street entry as someone the ball meets, with when they last moved. */
  #footballPlayers(): FootballPlayer[] {
    const players: FootballPlayer[] = [];
    for (const [key, session] of this.#sessions) {
      if (session.suspended || session.area !== 'street') continue;
      const entry = this.peers.get(session.gameId);
      if (entry === undefined) continue;
      players.push({ key, x: entry.position.x, y: entry.position.y, at: this.#movedAt.get(key) ?? 0 });
    }
    return players;
  }

  /** Every street entry as a sandbox player, optionally leaving one session out. */
  #livePlayers(exceptSessionKey?: string): SandboxPlayer[] {
    const players: SandboxPlayer[] = [];
    for (const [key, session] of this.#sessions) {
      if (key === exceptSessionKey || session.suspended || session.area !== 'street') continue;
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

  /** The live entry for a connection, if it has one, in whichever area it is. */
  entryFor(sessionKey: string): PresenceEntry | undefined {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined || session.suspended) return undefined;
    return this.peers.get(session.gameId);
  }

  /**
   * The other entries this connection should receive: in its own presence
   * area (D-087), inside the interest radius, nearest first, capped. The
   * observer's own entry is not included — the room adds that separately, so
   * the cap means what its name says.
   *
   * The area comes first because the areas share coordinates: the roof lies
   * over the street, and the Studio is drawn over the hidden street near the
   * pitch, so distance alone would show a room's players on the street.
   */
  visibleTo(sessionKey: string): PresenceEntry[] {
    const observer = this.#sessions.get(sessionKey);
    if (observer === undefined || observer.suspended) return [];
    const self = this.peers.get(observer.gameId);
    if (self === undefined) return [];
    const others: PresenceEntry[] = [];
    for (const session of this.#sessions.values()) {
      if (session === observer || session.suspended || session.area !== observer.area) continue;
      const entry = this.peers.get(session.gameId);
      if (entry !== undefined) others.push(entry);
    }
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
      rejected: this.#rejected,
      areaSwitches: this.#areaSwitches,
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
