/**
 * D-133: the lookout swing's shared seam — the roof-local geometry both sides
 * measure from, and the normalizer every snapshot passes before anyone draws
 * it. The same discipline as `normalizeArenaRing`: own data fields only, and
 * null for anything that does not hold together.
 */

import { describe, expect, it } from 'vitest';
import {
  ROOF_PRESENCE_GRID,
  ROOF_SWING_TARGET_ID,
  SWING_APPROACH,
  SWING_APPROACH_SLACK_PX,
  SWING_COOLDOWN_MS,
  SWING_END_REASONS,
  SWING_FRAME_TILES,
  SWING_PHASES,
  SWING_RIDE_MS,
  SWING_RIDER_WALKABLE,
  SWING_SEAT_FACING,
  SWING_SEAT_TILE,
  SWING_STEP_OFF_FACING,
  SWING_STEP_OFF_TILE,
  isOnSwingApproach,
  normalizeRoofSwing,
  roofTileCentre,
  type RoofSwingSnapshot,
} from './index.js';

/** A snapshot that normalizes, so each test can spoil exactly one field. */
function idle(): Record<string, unknown> {
  return { phase: 'idle', round: 3, riderId: null, secondsLeft: 0, reason: null };
}
function riding(): Record<string, unknown> {
  return { phase: 'riding', round: 4, riderId: 'abc123', secondsLeft: 12, reason: null };
}
function cooldown(): Record<string, unknown> {
  return { phase: 'cooldown', round: 4, riderId: null, secondsLeft: 0, reason: 'timeout' };
}

describe('the swing sits on the roof grid, south of the deck (D-133)', () => {
  it('stands on the ledge row south of the walkable deck, behind the north-facing camera (D-059)', () => {
    // The deck's walkable tiles are x 1..5, y 1..4; the ring is everything else.
    expect(SWING_FRAME_TILES.y).toBe(5);
    expect(SWING_SEAT_TILE.y).toBe(5);
    // South is +y in the roof grid, so the seat is south of its approach.
    expect(SWING_SEAT_TILE.y).toBeGreaterThan(SWING_APPROACH.y);
    expect(SWING_STEP_OFF_TILE.y).toBe(SWING_APPROACH.y);
    // The approach is the deck row the frame is reached from, directly north.
    expect(SWING_APPROACH.y + SWING_APPROACH.height).toBe(SWING_FRAME_TILES.y);
    expect(SWING_APPROACH.x).toBe(SWING_FRAME_TILES.x);
  });

  it('seats the rider facing south over the edge and stands them back facing the deck', () => {
    expect(SWING_SEAT_FACING).toBe('down');
    expect(SWING_STEP_OFF_FACING).toBe('up');
  });

  it('grants the rider the seat tile alone, which is ledge to everyone else', () => {
    expect(SWING_RIDER_WALKABLE).toEqual([
      { x: SWING_SEAT_TILE.x, y: SWING_SEAT_TILE.y, width: 1, height: 1 },
    ]);
  });

  it('is a press-E target id, not a station id, and runs for about twenty seconds', () => {
    expect(ROOF_SWING_TARGET_ID).toBe('roof:swing');
    expect(SWING_RIDE_MS).toBe(20_000);
    expect(SWING_COOLDOWN_MS).toBe(1_000);
  });

  it('converts a roof tile to the World pixel centre of that tile', () => {
    const grid = ROOF_PRESENCE_GRID;
    expect(roofTileCentre({ x: 3, y: 4 })).toEqual({
      x: grid.originX + 3.5 * grid.tileSize,
      y: grid.originY + 4.5 * grid.tileSize,
    });
  });

  it('accepts the approach tiles, with a quarter tile of slack, and nothing further off', () => {
    const grid = ROOF_PRESENCE_GRID;
    const centre = roofTileCentre({ x: SWING_APPROACH.x, y: SWING_APPROACH.y });
    expect(isOnSwingApproach(centre.x, centre.y)).toBe(true);
    // The slack reaches a quarter tile beyond the rect's north edge...
    const north = grid.originY + SWING_APPROACH.y * grid.tileSize;
    expect(isOnSwingApproach(centre.x, north - SWING_APPROACH_SLACK_PX + 0.5)).toBe(true);
    // ...and no further.
    expect(isOnSwingApproach(centre.x, north - SWING_APPROACH_SLACK_PX - 1)).toBe(false);
    // A tile to the side of the frame is not the approach.
    const aside = roofTileCentre({ x: SWING_APPROACH.x - 2, y: SWING_APPROACH.y });
    expect(isOnSwingApproach(aside.x, aside.y)).toBe(false);
  });

  it('refuses a position that is not a finite number', () => {
    expect(isOnSwingApproach(Number.NaN, 0)).toBe(false);
    expect(isOnSwingApproach(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('normalizeRoofSwing', () => {
  it('accepts each phase and freezes the result', () => {
    for (const value of [idle(), riding(), cooldown()]) {
      const snapshot = normalizeRoofSwing(value) as RoofSwingSnapshot;
      expect(snapshot).not.toBeNull();
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
    expect(normalizeRoofSwing(riding())).toEqual({
      phase: 'riding', round: 4, riderId: 'abc123', secondsLeft: 12, reason: null,
    });
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 0, 'riding', true, []]) {
      expect(normalizeRoofSwing(value as unknown)).toBeNull();
    }
  });

  it('refuses a phase outside the wire table', () => {
    expect(normalizeRoofSwing({ ...idle(), phase: 'swinging' })).toBeNull();
    expect(normalizeRoofSwing({ ...idle(), phase: 0 })).toBeNull();
  });

  it('refuses a round that is not a 16-bit integer', () => {
    for (const round of [-1, 0x10000, 1.5, Number.NaN, '3']) {
      expect(normalizeRoofSwing({ ...idle(), round })).toBeNull();
    }
    expect(normalizeRoofSwing({ ...idle(), round: 0xffff })).not.toBeNull();
  });

  it('carries a rider id exactly while riding', () => {
    // Riding with no rider is incoherent...
    expect(normalizeRoofSwing({ ...riding(), riderId: null })).toBeNull();
    expect(normalizeRoofSwing({ ...riding(), riderId: '' })).toBeNull();
    // ...and so is a rider on a swing nobody is on.
    expect(normalizeRoofSwing({ ...idle(), riderId: 'abc123' })).toBeNull();
    expect(normalizeRoofSwing({ ...cooldown(), riderId: 'abc123' })).toBeNull();
  });

  it('bounds the rider id, so junk cannot arrive as a presence id', () => {
    expect(normalizeRoofSwing({ ...riding(), riderId: 'x'.repeat(64) })).not.toBeNull();
    expect(normalizeRoofSwing({ ...riding(), riderId: 'x'.repeat(65) })).toBeNull();
  });

  it('carries a reason exactly while cooling down', () => {
    for (const reason of SWING_END_REASONS) {
      expect(normalizeRoofSwing({ ...cooldown(), reason })).not.toBeNull();
    }
    expect(normalizeRoofSwing({ ...cooldown(), reason: null })).toBeNull();
    expect(normalizeRoofSwing({ ...cooldown(), reason: 'bored' })).toBeNull();
    expect(normalizeRoofSwing({ ...idle(), reason: 'timeout' })).toBeNull();
    expect(normalizeRoofSwing({ ...riding(), reason: 'timeout' })).toBeNull();
  });

  it('holds secondsLeft inside the ride, and at zero off it', () => {
    expect(normalizeRoofSwing({ ...riding(), secondsLeft: 20 })).not.toBeNull();
    expect(normalizeRoofSwing({ ...riding(), secondsLeft: 21 })).toBeNull();
    expect(normalizeRoofSwing({ ...riding(), secondsLeft: -1 })).toBeNull();
    expect(normalizeRoofSwing({ ...idle(), secondsLeft: 1 })).toBeNull();
    expect(normalizeRoofSwing({ ...cooldown(), secondsLeft: 1 })).toBeNull();
  });

  it('reads own data properties only: a getter or an inherited field is not a value', () => {
    const viaGetter = Object.defineProperty({ ...idle() }, 'phase', { get: () => 'idle' });
    expect(normalizeRoofSwing(viaGetter)).toBeNull();
    const inherited = Object.create(idle()) as object;
    expect(normalizeRoofSwing(inherited)).toBeNull();
  });

  it('pins the wire tables, since the codes are their indices', () => {
    expect(SWING_PHASES).toEqual(['idle', 'riding', 'cooldown']);
    expect(SWING_END_REASONS).toEqual(['timeout', 'left', 'disconnect']);
  });
});
