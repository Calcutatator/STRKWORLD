/**
 * D-114: the gladiator pit's arena. Geometry the World draws and the lobby
 * enforces, the ring's state as the wire carries it, and combat constants.
 * Nothing financial; the codename is never shown.
 */
import type { Facing, GameId, Position, PresenceAreaGrid, TileRect } from './index.js';

export const ARENA_BUILDING = 'arena' as const;
export const ARENA_TILE_SIZE = 32;
/** The arena is drawn at the interiors' origin like every fixed room (ROOM_ORIGIN, 2 tiles). */
export const ARENA_ORIGIN_PX = 2 * 32;
export const ARENA_WIDTH = 41;
export const ARENA_HEIGHT = 33;

export interface ArenaTile { readonly x: number; readonly y: number }

export const ARENA_SPAWN: ArenaTile = Object.freeze({ x: 20, y: 30 });
export const ARENA_EXIT: TileRect = Object.freeze({ x: 19, y: 32, width: 3, height: 1 });
export const ARENA_TUNNEL: TileRect = Object.freeze({ x: 19, y: 24, width: 3, height: 9 });
export const ARENA_STAIRS: readonly TileRect[] = Object.freeze([
  Object.freeze({ x: 6, y: 15, width: 1, height: 3 }),
  Object.freeze({ x: 34, y: 15, width: 1, height: 3 }),
]);
export const ARENA_BOX: ArenaTile = Object.freeze({ x: 20, y: 7 });
export const ARENA_RING_FENCE: TileRect = Object.freeze({ x: 15, y: 12, width: 11, height: 9 });
export const ARENA_RING_INTERIOR: TileRect = Object.freeze({ x: 16, y: 13, width: 9, height: 7 });
export const ARENA_RING_GATE: TileRect = Object.freeze({ x: 19, y: 20, width: 3, height: 1 });
export const ARENA_GATE_APPROACH: TileRect = Object.freeze({ x: 19, y: 21, width: 3, height: 2 });
export const ARENA_DUMMY_TILE: ArenaTile = Object.freeze({ x: 20, y: 14 });
export const ARENA_RING_SPAWN: ArenaTile = Object.freeze({ x: 20, y: 18 });
export const ARENA_RING_SPAWN_FACING: Facing = 'up';
export const ARENA_RING_RETURN: ArenaTile = Object.freeze({ x: 20, y: 22 });
export const ARENA_RING_RETURN_FACING: Facing = 'down';
/** The ring interior minus the dummy: walkable for the challenger only. */
export const ARENA_RING_WALKABLE: readonly TileRect[] = Object.freeze([
  Object.freeze({ x: 16, y: 13, width: 9, height: 1 }),
  Object.freeze({ x: 16, y: 14, width: 4, height: 1 }),
  Object.freeze({ x: 21, y: 14, width: 4, height: 1 }),
  Object.freeze({ x: 16, y: 15, width: 9, height: 5 }),
]);

export type ArenaTileKind =
  | 'void' | 'arcade' | 'tier' | 'podium' | 'stair' | 'sand'
  | 'fence' | 'gate' | 'ring' | 'dummy' | 'tunnel' | 'tunnel-wall' | 'box';

/** Stadium oval: distance from the segment (15.5,16.5)-(25.5,16.5), in tiles. */
const OVAL = Object.freeze({ cx: 20.5, cy: 16.5, half: 5, sand: 8.5, podium: 9.5, tiers: 5, arcade: 15.5 });

function inRect(r: TileRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
function ovalDistance(x: number, y: number): number {
  const px = x + 0.5, py = y + 0.5;
  const sx = Math.max(OVAL.cx - OVAL.half, Math.min(OVAL.cx + OVAL.half, px));
  return Math.hypot(px - sx, py - OVAL.cy);
}

/** What an arena-local tile is. Out of bounds is void. Pure; the one source of truth. */
export function arenaTileAt(x: number, y: number): ArenaTileKind {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= ARENA_WIDTH || y >= ARENA_HEIGHT) return 'void';
  if (inRect(ARENA_TUNNEL, x, y)) return 'tunnel';
  if ((x === ARENA_TUNNEL.x - 1 || x === ARENA_TUNNEL.x + ARENA_TUNNEL.width) && y >= ARENA_TUNNEL.y + 1) return 'tunnel-wall';
  if (x === ARENA_BOX.x && y === ARENA_BOX.y) return 'box';
  if (x === ARENA_DUMMY_TILE.x && y === ARENA_DUMMY_TILE.y) return 'dummy';
  if (inRect(ARENA_RING_GATE, x, y)) return 'gate';
  if (inRect(ARENA_RING_INTERIOR, x, y)) return 'ring';
  if (inRect(ARENA_RING_FENCE, x, y)) return 'fence';
  const d = ovalDistance(x, y);
  if (d <= OVAL.sand) return 'sand';
  if (d <= OVAL.podium) return ARENA_STAIRS.some((r) => inRect(r, x, y)) ? 'stair' : 'podium';
  if (d <= OVAL.podium + OVAL.tiers) return 'tier';
  if (d <= OVAL.arcade) return 'arcade';
  return 'void';
}

/** Tier 1..5 for a tier tile, else 0. */
export function arenaTierAt(x: number, y: number): number {
  return arenaTileAt(x, y) === 'tier' ? Math.ceil(ovalDistance(x, y) - OVAL.podium) : 0;
}

/** Walkable for everyone (the static grid). The ring is not: see ARENA_RING_WALKABLE. */
export function isArenaFloorKind(kind: ArenaTileKind): boolean {
  return kind === 'sand' || kind === 'stair' || kind === 'tier' || kind === 'tunnel';
}

/** World pixel centre of an arena-local tile. */
export function arenaTileCentre(tile: ArenaTile): Position {
  return Object.freeze({
    x: ARENA_ORIGIN_PX + (tile.x + 0.5) * ARENA_TILE_SIZE,
    y: ARENA_ORIGIN_PX + (tile.y + 0.5) * ARENA_TILE_SIZE,
  });
}

/** Row runs of the floor kinds, for the lobby (D-087 grid shape). */
export const ARENA_PRESENCE_GRID: PresenceAreaGrid = (() => {
  const walkable: TileRect[] = [];
  for (let y = 0; y < ARENA_HEIGHT; y++) {
    let start = -1;
    for (let x = 0; x <= ARENA_WIDTH; x++) {
      const floor = x < ARENA_WIDTH && isArenaFloorKind(arenaTileAt(x, y));
      if (floor && start < 0) start = x;
      if (!floor && start >= 0) { walkable.push(Object.freeze({ x: start, y, width: x - start, height: 1 })); start = -1; }
    }
  }
  return Object.freeze({
    originX: ARENA_ORIGIN_PX, originY: ARENA_ORIGIN_PX, tileSize: ARENA_TILE_SIZE,
    width: ARENA_WIDTH, height: ARENA_HEIGHT, walkable: Object.freeze(walkable),
  });
})();

// -- combat ----------------------------------------------------------------
export const ARENA_MAX_HP = 100;
export const ARENA_HIT_DAMAGE = 10;
export const ARENA_REACH_PX = 52;
export const ARENA_HIT_MIN_COS = 0.25;
export const ARENA_POINT_BLANK_PX = 20;
export const ARENA_ATTACK_MIN_INTERVAL_MS = 400;
export const ARENA_ATTACK_CLIENT_INTERVAL_MS = 450;
export const ARENA_INTENT_MIN_INTERVAL_MS = 900;
export const ARENA_INTENT_CLIENT_INTERVAL_MS = 1000;
export const ARENA_COUNTDOWN_MS = 3_000;
export const ARENA_FIGHT_MS = 90_000;
export const ARENA_RESULT_MS = 4_000;
export const ARENA_ABORT_RESULT_MS = 1_500;
export const ARENA_SWING_MS = 350;

// -- the ring, as the wire carries it ------------------------------------------
export type ArenaPhase = 'idle' | 'countdown' | 'fighting' | 'ended';
/** Wire code = index. */
export const ARENA_PHASES: readonly ArenaPhase[] = Object.freeze(['idle', 'countdown', 'fighting', 'ended']);
export type ArenaSlotKind = 'empty' | 'player' | 'dummy';
/** Wire code = index. */
export const ARENA_SLOT_KINDS: readonly ArenaSlotKind[] = Object.freeze(['empty', 'player', 'dummy']);
export type ArenaEndReason = 'knockout' | 'timeout' | 'left' | 'disconnect';
/** Wire code = index + 1; 0 is "none". */
export const ARENA_END_REASONS: readonly ArenaEndReason[] = Object.freeze(['knockout', 'timeout', 'left', 'disconnect']);
export type ArenaSide = 'challenger' | 'opponent';
/** Wire code = index + 1; 0 is "none". */
export const ARENA_SIDES: readonly ArenaSide[] = Object.freeze(['challenger', 'opponent']);

export interface ArenaSlot {
  readonly kind: ArenaSlotKind;
  /** The player's presence id when kind is 'player'; null otherwise. */
  readonly gameId: GameId | null;
  /** 0..ARENA_MAX_HP. */
  readonly hp: number;
  /** Mod 256: +1 per on-time attack while fighting, hit or miss. Peers animate swings from it. */
  readonly swings: number;
  /** Mod 256: +1 each time this slot is hit. Damage shown = the hp delta. */
  readonly hits: number;
}

export interface ArenaOutcome {
  readonly reason: ArenaEndReason;
  /** Null when nobody won (a timeout or a walk-out against the dummy). */
  readonly winner: ArenaSide | null;
}

export interface ArenaRingSnapshot {
  readonly phase: ArenaPhase;
  /** Mod 65536, +1 per accepted claim: a new value is a new fight. */
  readonly round: number;
  /** Slot A: whoever claimed. */
  readonly challenger: ArenaSlot;
  /** Slot B: the dummy in v1; a player once PvP lands. */
  readonly opponent: ArenaSlot;
  /** Whole seconds left in countdown or fighting; 0 otherwise. */
  readonly secondsLeft: number;
  /** Non-null exactly when phase is 'ended'. */
  readonly outcome: ArenaOutcome | null;
}


/** The longest presence id a slot may carry. The lobby mints 16 hex characters; this only bounds junk. */
const ARENA_GAME_ID_MAX_LENGTH = 64;
/** The most whole seconds `secondsLeft` may say in each timed phase. */
const ARENA_COUNTDOWN_SECONDS = Math.ceil(ARENA_COUNTDOWN_MS / 1000);
const ARENA_FIGHT_SECONDS = Math.ceil(ARENA_FIGHT_MS / 1000);

/** An own data property, never a getter or an inherited one; undefined otherwise. */
function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function normalizeArenaSlot(value: unknown): ArenaSlot | null {
  const kind = ownData(value, 'kind');
  const gameId = ownData(value, 'gameId');
  const hp = ownData(value, 'hp');
  const swings = ownData(value, 'swings');
  const hits = ownData(value, 'hits');
  if (typeof kind !== 'string' || !ARENA_SLOT_KINDS.includes(kind as ArenaSlotKind)) return null;
  if (kind === 'player') {
    if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > ARENA_GAME_ID_MAX_LENGTH) return null;
  } else if (gameId !== null) {
    return null;
  }
  if (!isIntegerIn(hp, 0, ARENA_MAX_HP) || !isIntegerIn(swings, 0, 0xff) || !isIntegerIn(hits, 0, 0xff)) return null;
  return Object.freeze({ kind: kind as ArenaSlotKind, gameId: gameId as GameId | null, hp, swings, hits });
}

function normalizeArenaOutcome(value: unknown): ArenaOutcome | null {
  const reason = ownData(value, 'reason');
  const winner = ownData(value, 'winner');
  if (typeof reason !== 'string' || !ARENA_END_REASONS.includes(reason as ArenaEndReason)) return null;
  if (winner !== null && (typeof winner !== 'string' || !ARENA_SIDES.includes(winner as ArenaSide))) return null;
  return Object.freeze({ reason: reason as ArenaEndReason, winner: winner as ArenaSide | null });
}

/**
 * Validate an untrusted snapshot, reading own data fields only (a getter or
 * an inherited field is never read). Integers in range, codes in the tables,
 * an outcome exactly when the phase is `ended`, a slot's `gameId` non-empty
 * exactly when its kind is `player`, hp at most `ARENA_MAX_HP`, and
 * `secondsLeft` within its phase (0 when idle or ended). Anything else is
 * null. The result is frozen, slots and outcome included. Same discipline as
 * `normalizeFootballFrame`.
 */
export function normalizeArenaRing(value: unknown): ArenaRingSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const phase = ownData(value, 'phase');
  const round = ownData(value, 'round');
  const secondsLeft = ownData(value, 'secondsLeft');
  if (typeof phase !== 'string' || !ARENA_PHASES.includes(phase as ArenaPhase)) return null;
  if (!isIntegerIn(round, 0, 0xffff)) return null;
  const maxSeconds = phase === 'countdown' ? ARENA_COUNTDOWN_SECONDS : phase === 'fighting' ? ARENA_FIGHT_SECONDS : 0;
  if (!isIntegerIn(secondsLeft, 0, maxSeconds)) return null;
  const challenger = normalizeArenaSlot(ownData(value, 'challenger'));
  const opponent = normalizeArenaSlot(ownData(value, 'opponent'));
  if (challenger === null || opponent === null) return null;
  const rawOutcome = ownData(value, 'outcome');
  let outcome: ArenaOutcome | null = null;
  if (phase === 'ended') {
    outcome = normalizeArenaOutcome(rawOutcome);
    if (outcome === null) return null;
  } else if (rawOutcome !== null) {
    return null;
  }
  return Object.freeze({ phase: phase as ArenaPhase, round, challenger, opponent, secondsLeft, outcome });
}
