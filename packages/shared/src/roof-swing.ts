/**
 * The lookout swing on the Exchange tower's roof. Geometry the World draws
 * and the lobby enforces, the swing's state as the wire carries it, and the
 * ride's timings. Nothing financial; the roof is a shared presence area
 * (D-087) and this adds no field that says who anyone is.
 *
 * Everything here is in the roof's own 7 by 6 tile grid — the same grid as
 * `ROOF_PRESENCE_GRID` and the World's `EXCHANGE_ROOF_LEVEL` — so no module
 * has to agree on a pixel origin twice. `roofTileCentre` converts, reading
 * the grid at call time (this module is re-exported from `./index.js`, so a
 * top-level read of it would be a cycle).
 *
 * The deck's walkable tiles are x 1..5, y 1..4; everything else in the grid
 * is the solid ledge ring. The A-frame stands on the ring's south row (y = 5)
 * and the seat hangs south of it, out over the edge, behind the north-facing
 * camera (D-059).
 */
import { ROOF_PRESENCE_GRID, type Facing, type GameId, type Position, type TileRect } from './index.js';

/** A tile of the roof's own grid. */
export interface RoofTile {
  readonly x: number;
  readonly y: number;
}

/** The press-E target's id (never a `StationId`: the roof is a floor, not a counter). */
export const ROOF_SWING_TARGET_ID = 'roof:swing';

/** The A-frame's footprint on the ledge's south row: what a press-E prompt measures to. */
export const SWING_FRAME_TILES: TileRect = Object.freeze({ x: 2, y: 5, width: 3, height: 1 });

/** The deck tiles the swing is claimed from: the south row of the walkable deck. */
export const SWING_APPROACH: TileRect = Object.freeze({ x: 2, y: 4, width: 3, height: 1 });

/** How far outside the approach a claim may stand, in World pixels: a quarter tile. */
export const SWING_APPROACH_SLACK_PX = 8;

/** Where the server stands the rider: the seat's tile, under the A-frame's beam. */
export const SWING_SEAT_TILE: RoofTile = Object.freeze({ x: 3, y: 5 });
/** Facing south, out over the edge, as the seat hangs. */
export const SWING_SEAT_FACING: Facing = 'down';

/** Where the server puts the rider down again: the deck tile north of the seat. */
export const SWING_STEP_OFF_TILE: RoofTile = Object.freeze({ x: 3, y: 4 });
export const SWING_STEP_OFF_FACING: Facing = 'up';

/**
 * The rider's extra walkable tile: the seat's, which is ledge for everyone
 * else. The lobby adds it for the rider alone, so the server's own placement
 * onto the seat is a legal position and nobody else can stand there.
 */
export const SWING_RIDER_WALKABLE: readonly TileRect[] = Object.freeze([
  Object.freeze({ x: SWING_SEAT_TILE.x, y: SWING_SEAT_TILE.y, width: 1, height: 1 }),
]);

/** How long a ride lasts: about twenty seconds over the scene. */
export const SWING_RIDE_MS = 20_000;
/** The breath between one rider stepping off and the next claiming. */
export const SWING_COOLDOWN_MS = 1_000;

/** Server-side floor between two accepted swing intents (a claim or a leave) from one session. */
export const SWING_INTENT_MIN_INTERVAL_MS = 900;
/** The floor the client wrapper holds its own swing intents to; above the server's, so jitter never drops one. */
export const SWING_INTENT_CLIENT_INTERVAL_MS = 1_000;

/** World pixel centre of a roof-local tile. Reads the shared grid at call time. */
export function roofTileCentre(tile: RoofTile): Position {
  const grid = ROOF_PRESENCE_GRID;
  return Object.freeze({
    x: grid.originX + (tile.x + 0.5) * grid.tileSize,
    y: grid.originY + (tile.y + 0.5) * grid.tileSize,
  });
}

/** Whether a World pixel position stands on the swing's approach, slack included. */
export function isOnSwingApproach(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const grid = ROOF_PRESENCE_GRID;
  const minX = grid.originX + SWING_APPROACH.x * grid.tileSize - SWING_APPROACH_SLACK_PX;
  const maxX = grid.originX + (SWING_APPROACH.x + SWING_APPROACH.width) * grid.tileSize + SWING_APPROACH_SLACK_PX;
  const minY = grid.originY + SWING_APPROACH.y * grid.tileSize - SWING_APPROACH_SLACK_PX;
  const maxY = grid.originY + (SWING_APPROACH.y + SWING_APPROACH.height) * grid.tileSize + SWING_APPROACH_SLACK_PX;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

// -- the swing, as the wire carries it ---------------------------------------

/** `idle`: free. `riding`: someone is on it. `cooldown`: the breath after a ride. */
export type SwingPhase = 'idle' | 'riding' | 'cooldown';
/** Wire code = index. */
export const SWING_PHASES: readonly SwingPhase[] = Object.freeze(['idle', 'riding', 'cooldown']);

/** Why a ride stopped: it ran its time, the rider got off (Esc, or left the roof), or they dropped. */
export type SwingEndReason = 'timeout' | 'left' | 'disconnect';
/** Wire code = index + 1; 0 is "none". */
export const SWING_END_REASONS: readonly SwingEndReason[] = Object.freeze(['timeout', 'left', 'disconnect']);

export interface RoofSwingSnapshot {
  readonly phase: SwingPhase;
  /** Mod 65536, +1 per accepted claim: a new value is a new ride. */
  readonly round: number;
  /** The rider's ephemeral presence id while riding; null otherwise. */
  readonly riderId: GameId | null;
  /** Whole seconds left in a ride; 0 otherwise. */
  readonly secondsLeft: number;
  /** How the last ride ended, while cooling down; null otherwise. */
  readonly reason: SwingEndReason | null;
}

/** The longest presence id the rider slot may carry. The lobby mints 16 hex characters; this only bounds junk. */
const SWING_GAME_ID_MAX_LENGTH = 64;
const SWING_RIDE_SECONDS = Math.ceil(SWING_RIDE_MS / 1000);

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

/**
 * Validate an untrusted snapshot, reading own data fields only. Integers in
 * range, the phase in its table, a rider id exactly while riding, a reason
 * exactly while cooling down, and `secondsLeft` within the ride (0 otherwise).
 * Anything else is null; the result is frozen. Same discipline as
 * `normalizeArenaRing`.
 */
export function normalizeRoofSwing(value: unknown): RoofSwingSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const phase = ownData(value, 'phase');
  const round = ownData(value, 'round');
  const riderId = ownData(value, 'riderId');
  const secondsLeft = ownData(value, 'secondsLeft');
  const reason = ownData(value, 'reason');
  if (typeof phase !== 'string' || !SWING_PHASES.includes(phase as SwingPhase)) return null;
  if (!isIntegerIn(round, 0, 0xffff)) return null;
  if (phase === 'riding') {
    if (typeof riderId !== 'string' || riderId.length === 0 || riderId.length > SWING_GAME_ID_MAX_LENGTH) return null;
  } else if (riderId !== null) {
    return null;
  }
  if (!isIntegerIn(secondsLeft, 0, phase === 'riding' ? SWING_RIDE_SECONDS : 0)) return null;
  if (phase === 'cooldown') {
    if (typeof reason !== 'string' || !SWING_END_REASONS.includes(reason as SwingEndReason)) return null;
  } else if (reason !== null) {
    return null;
  }
  return Object.freeze({
    phase: phase as SwingPhase,
    round,
    riderId: (riderId as GameId | null) ?? null,
    secondsLeft,
    reason: (reason as SwingEndReason | null) ?? null,
  });
}
