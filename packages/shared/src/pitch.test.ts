import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_WIN_SCORE,
  PITCH_FIELD,
  PITCH_GOAL,
  STREET_SEATS,
  type GameId,
  type PitchMatchSnapshot,
  type TileRect,
} from './index.js';
import {
  PITCH_APPROACH_SLACK_PX,
  PITCH_COUNTDOWN_MS,
  PITCH_FIELD_MIRROR,
  PITCH_GATES,
  PITCH_GATE_NORTH,
  PITCH_GATE_SIDES,
  PITCH_GATE_SOUTH,
  PITCH_GOAL_MIRROR,
  PITCH_MATCH_PHASES,
  PITCH_PEN,
  PITCH_PEN_INTERIOR,
  PITCH_QUARTERS,
  PITCH_SLOTS,
  PITCH_SLOT_EXITS,
  PITCH_SLOT_KINDS,
  PITCH_TILE_SIZE,
  isInsidePitchPen,
  isPitchFenceTile,
  isPitchGateTile,
  isPitchPenTile,
  normalizePitchMatch,
  pitchGateAt,
  pitchSlotSide,
  pitchTileCentre,
} from './pitch.js';

/**
 * D-135: the gated pitch's geometry and the match's normalizer. The mirrors
 * this module keeps of `PITCH_FIELD` and `PITCH_GOAL` are pinned here, which
 * is the only thing stopping the field from moving out from under the fence.
 */

const T = PITCH_TILE_SIZE;

function inTiles(rect: TileRect): string[] {
  const tiles: string[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) tiles.push(`${x},${y}`);
  }
  return tiles;
}

/** A valid match, as the authority produces: the shape every case below bends. */
const MATCH: PitchMatchSnapshot = Object.freeze({
  phase: 'playing' as const,
  round: 7,
  slots: Object.freeze([
    Object.freeze({ kind: 'player' as const, gameId: 'abcdef0123456789' as GameId, x: 0, y: 0 }),
    Object.freeze({ kind: 'dummy' as const, gameId: null, x: 320, y: 368 }),
    Object.freeze({ kind: 'empty' as const, gameId: null, x: 0, y: 0 }),
    Object.freeze({ kind: 'dummy' as const, gameId: null, x: 640, y: 624 }),
  ]),
  starks: 1,
  snarks: 2,
  secondsLeft: 0,
  winner: null,
});

const bend = (over: Partial<Record<string, unknown>>): unknown => ({ ...MATCH, ...over });

describe('the pitch mirrors its field and goal (D-135)', () => {
  it('holds the same field and goal the ball plays on', () => {
    expect(PITCH_FIELD_MIRROR).toEqual(PITCH_FIELD);
    expect(PITCH_GOAL_MIRROR.width).toBe(PITCH_GOAL.width);
    expect(PITCH_GOAL_MIRROR.depth).toBe(PITCH_GOAL.depth);
  });
});

describe('the fence and its gates (D-135)', () => {
  it('runs round the field and both goals, with the stands outside it', () => {
    // Every field tile is inside the fence, and so is a tile beyond each goal line.
    for (const tile of inTiles(PITCH_FIELD)) {
      const [x, y] = tile.split(',').map(Number) as [number, number];
      expect(isPitchPenTile(x, y), tile).toBe(true);
    }
    expect(isPitchPenTile(PITCH_FIELD.x - 1, PITCH_FIELD.y + 1)).toBe(true);
    expect(isPitchPenTile(PITCH_FIELD.x + PITCH_FIELD.width, PITCH_FIELD.y + 1)).toBe(true);
    // The main stand to the north and the bleachers to the south are outside it.
    expect(isPitchPenTile(13, 2)).toBe(false);
    expect(isPitchPenTile(13, 25)).toBe(false);
  });

  it('keeps every street bench outside the fence, so they stay sittable (D-127)', () => {
    for (const seat of STREET_SEATS) {
      const tile = { x: Math.floor(seat.x / T), y: Math.floor(seat.y / T) };
      expect(isPitchPenTile(tile.x, tile.y), `seat ${tile.x},${tile.y}`).toBe(false);
      expect(isPitchFenceTile(tile.x, tile.y), `seat ${tile.x},${tile.y}`).toBe(false);
    }
  });

  it('is a closed ring: the border is fence and the inside is not', () => {
    for (const tile of inTiles(PITCH_PEN)) {
      const [x, y] = tile.split(',').map(Number) as [number, number];
      const border =
        x === PITCH_PEN.x || y === PITCH_PEN.y ||
        x === PITCH_PEN.x + PITCH_PEN.width - 1 || y === PITCH_PEN.y + PITCH_PEN.height - 1;
      expect(isPitchFenceTile(x, y), tile).toBe(border);
      expect(isPitchPenTile(x, y), tile).toBe(!border);
    }
    // Outside the rectangle entirely: neither.
    expect(isPitchFenceTile(PITCH_PEN.x - 1, PITCH_PEN.y)).toBe(false);
    expect(isPitchPenTile(PITCH_PEN.x - 1, PITCH_PEN.y)).toBe(false);
    // The interior is the rectangle less its border.
    expect(PITCH_PEN_INTERIOR).toEqual({
      x: PITCH_PEN.x + 1,
      y: PITCH_PEN.y + 1,
      width: PITCH_PEN.width - 2,
      height: PITCH_PEN.height - 2,
    });
  });

  it('has one gate on the north touchline and one on the south, both in the fence', () => {
    expect(PITCH_GATES.map((gate) => gate.side)).toEqual([...PITCH_GATE_SIDES]);
    expect(PITCH_GATE_NORTH.y).toBe(PITCH_PEN.y);
    expect(PITCH_GATE_SOUTH.y).toBe(PITCH_PEN.y + PITCH_PEN.height - 1);
    for (const gate of PITCH_GATES) {
      for (const tile of inTiles(gate.tiles)) {
        const [x, y] = tile.split(',').map(Number) as [number, number];
        // A gate is part of the fence, not a gap in it: solid, so only E gets you through.
        expect(isPitchFenceTile(x, y), tile).toBe(true);
        expect(isPitchGateTile(x, y), tile).toBe(true);
      }
      // The approach is outside, the spawn inside, and the exit outside again.
      expect(isPitchPenTile(gate.approach.x, gate.approach.y)).toBe(false);
      expect(isPitchFenceTile(gate.approach.x, gate.approach.y)).toBe(false);
      expect(isPitchPenTile(gate.spawn.x, gate.spawn.y)).toBe(true);
      expect(isPitchPenTile(gate.exit.x, gate.exit.y)).toBe(false);
      expect(isPitchFenceTile(gate.exit.x, gate.exit.y)).toBe(false);
    }
    expect(isPitchGateTile(0, 0)).toBe(false);
  });

  it('answers a press from a gate\'s approach and from just inside it, and nowhere else', () => {
    for (const gate of PITCH_GATES) {
      const outside = pitchTileCentre({ x: gate.approach.x, y: gate.approach.y });
      expect(pitchGateAt(outside.x, outside.y)?.side).toBe(gate.side);
      const inside = pitchTileCentre(gate.spawn);
      expect(pitchGateAt(inside.x, inside.y)?.side).toBe(gate.side);
      // A quarter-tile of slack, and no more than that plus a tile.
      expect(pitchGateAt(outside.x + PITCH_APPROACH_SLACK_PX, outside.y)?.side).toBe(gate.side);
      expect(pitchGateAt(outside.x, outside.y - T - PITCH_APPROACH_SLACK_PX - 2)).toBeNull();
    }
    // The halfway line, far from either gate.
    expect(pitchGateAt(14 * T, 15 * T)).toBeNull();
    expect(pitchGateAt(Number.NaN, 0)).toBeNull();
    expect(pitchGateAt(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('judges a pixel place inside the fence by the interior alone', () => {
    const inside = pitchTileCentre({ x: 14, y: 15 });
    expect(isInsidePitchPen(inside.x, inside.y)).toBe(true);
    // In the main stand, well north of the fence.
    expect(isInsidePitchPen(14 * T, 2 * T)).toBe(false);
  });

  it('centres a tile where the rest of the street does', () => {
    expect(pitchTileCentre({ x: 0, y: 0 })).toEqual({ x: T / 2, y: T / 2 });
    expect(pitchTileCentre({ x: 3, y: 7 })).toEqual({ x: 3.5 * T, y: 7.5 * T });
  });
});

describe('the four quarters (D-135)', () => {
  it('is two per team, one in each half of their own side', () => {
    expect(PITCH_QUARTERS).toHaveLength(PITCH_SLOTS);
    expect(PITCH_QUARTERS.map((quarter) => quarter.side)).toEqual(['starks', 'snarks', 'starks', 'snarks']);
    expect(PITCH_QUARTERS.map((quarter) => quarter.half)).toEqual(['north', 'north', 'south', 'south']);
    // Alternating teams, so two arrivals make one each.
    PITCH_QUARTERS.forEach((quarter, index) => expect(quarter.side).toBe(pitchSlotSide(index)));
    // Each quarter is a quarter of the field, and the four tile it exactly.
    const area = PITCH_QUARTERS.reduce((sum, quarter) => sum + quarter.quarter.width * quarter.quarter.height, 0);
    expect(area).toBe(PITCH_FIELD.width * PITCH_FIELD.height);
    expect(new Set(PITCH_QUARTERS.flatMap((quarter) => inTiles(quarter.quarter))).size).toBe(area);
  });

  it('stands each kick-off spot inside its own quarter, facing the goal it attacks', () => {
    for (const quarter of PITCH_QUARTERS) {
      expect(inTiles(quarter.quarter)).toContain(`${quarter.spot.x},${quarter.spot.y}`);
      expect(isPitchPenTile(quarter.spot.x, quarter.spot.y)).toBe(true);
      // The Starks keep the west goal, so they face east; the Snarks the other way.
      expect(quarter.facing).toBe(quarter.side === 'starks' ? 'right' : 'left');
    }
    expect(new Set(PITCH_QUARTERS.map((quarter) => `${quarter.spot.x},${quarter.spot.y}`)).size).toBe(PITCH_SLOTS);
  });

  it('grows each dummy\'s zone round its quarter without leaving the field', () => {
    PITCH_QUARTERS.forEach((quarter) => {
      const { zone, quarter: own } = quarter;
      expect(zone.x).toBeLessThanOrEqual(own.x);
      expect(zone.y).toBeLessThanOrEqual(own.y);
      expect(zone.x + zone.width).toBeGreaterThanOrEqual(own.x + own.width);
      expect(zone.y + zone.height).toBeGreaterThanOrEqual(own.y + own.height);
      // Never off the field.
      expect(zone.x).toBeGreaterThanOrEqual(PITCH_FIELD.x);
      expect(zone.y).toBeGreaterThanOrEqual(PITCH_FIELD.y);
      expect(zone.x + zone.width).toBeLessThanOrEqual(PITCH_FIELD.x + PITCH_FIELD.width);
      expect(zone.y + zone.height).toBeLessThanOrEqual(PITCH_FIELD.y + PITCH_FIELD.height);
    });
  });

  it('gives every slot its own exit tile, outside the fence by the gate it played nearest', () => {
    expect(PITCH_SLOT_EXITS).toHaveLength(PITCH_SLOTS);
    expect(new Set(PITCH_SLOT_EXITS.map((exit) => `${exit.spot.x},${exit.spot.y}`)).size).toBe(PITCH_SLOTS);
    PITCH_SLOT_EXITS.forEach((exit, index) => {
      expect(isPitchPenTile(exit.spot.x, exit.spot.y), `exit ${index}`).toBe(false);
      expect(isPitchFenceTile(exit.spot.x, exit.spot.y), `exit ${index}`).toBe(false);
      // The north half's two come out of the north gate, the south half's the south.
      expect(exit.facing).toBe(PITCH_QUARTERS[index]!.half === 'north' ? 'up' : 'down');
    });
  });
});

describe('normalizePitchMatch (D-135)', () => {
  it('accepts a match the authority would produce, frozen through and through', () => {
    const match = normalizePitchMatch(MATCH, FOOTBALL_WIN_SCORE)!;
    expect(match).toEqual(MATCH);
    expect(Object.isFrozen(match)).toBe(true);
    expect(Object.isFrozen(match.slots)).toBe(true);
    expect(Object.isFrozen(match.slots[0])).toBe(true);
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 0, 'playing', [], true]) {
      expect(normalizePitchMatch(value, FOOTBALL_WIN_SCORE), String(value)).toBeNull();
    }
  });

  it('refuses a phase, a kind or a winner the rules do not have', () => {
    expect(normalizePitchMatch(bend({ phase: 'fighting' }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ phase: 2 }), FOOTBALL_WIN_SCORE)).toBeNull();
    const slots = [...MATCH.slots];
    slots[2] = { kind: 'robot' as never, gameId: null, x: 0, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(PITCH_MATCH_PHASES).toEqual(['open', 'countdown', 'playing', 'ended']);
    expect(PITCH_SLOT_KINDS).toEqual(['empty', 'player', 'dummy']);
  });

  it('requires a winner exactly when the phase is ended', () => {
    expect(normalizePitchMatch(bend({ phase: 'ended' }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ phase: 'ended', winner: 'starks' }), FOOTBALL_WIN_SCORE)?.winner).toBe('starks');
    expect(normalizePitchMatch(bend({ phase: 'ended', winner: 'draw' }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ winner: 'starks' }), FOOTBALL_WIN_SCORE)).toBeNull();
  });

  it('holds the score to the winning one, and the round to its wrap', () => {
    expect(normalizePitchMatch(bend({ starks: FOOTBALL_WIN_SCORE + 1 }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ snarks: -1 }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ starks: 1.5 }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ round: 0x10000 }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ round: 0xffff }), FOOTBALL_WIN_SCORE)?.round).toBe(0xffff);
  });

  it('allows secondsLeft only during a countdown, and never past the countdown itself', () => {
    expect(normalizePitchMatch(bend({ secondsLeft: 1 }), FOOTBALL_WIN_SCORE)).toBeNull();
    const counting = { phase: 'countdown' as const, secondsLeft: Math.ceil(PITCH_COUNTDOWN_MS / 1_000) };
    expect(normalizePitchMatch(bend(counting), FOOTBALL_WIN_SCORE)?.secondsLeft).toBe(counting.secondsLeft);
    expect(normalizePitchMatch(bend({ ...counting, secondsLeft: counting.secondsLeft + 1 }), FOOTBALL_WIN_SCORE)).toBeNull();
  });

  it('wants exactly four slots', () => {
    expect(normalizePitchMatch(bend({ slots: MATCH.slots.slice(0, 3) }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ slots: [...MATCH.slots, MATCH.slots[0]] }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(normalizePitchMatch(bend({ slots: 'four' }), FOOTBALL_WIN_SCORE)).toBeNull();
    expect(PITCH_SLOTS).toBe(4);
  });

  it('wants a presence id on a player slot and none on any other, and a place only on a dummy', () => {
    const slots = [...MATCH.slots];
    slots[0] = { kind: 'player', gameId: null, x: 0, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    slots[0] = { kind: 'player', gameId: '' as GameId, x: 0, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    slots[0] = { kind: 'player', gameId: 'x'.repeat(65) as GameId, x: 0, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    // A dummy with a presence id, which would name a person who is not there.
    slots[0] = MATCH.slots[0]!;
    slots[1] = { kind: 'dummy', gameId: 'abcdef0123456789' as GameId, x: 10, y: 10 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    // A player or an empty slot standing somewhere, which no slot may say.
    slots[1] = MATCH.slots[1]!;
    slots[2] = { kind: 'empty', gameId: null, x: 40, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    // A dummy off the pitch square entirely.
    slots[2] = MATCH.slots[2]!;
    slots[3] = { kind: 'dummy', gameId: null, x: 99_999, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
    slots[3] = { kind: 'dummy', gameId: null, x: 12.5, y: 0 };
    expect(normalizePitchMatch(bend({ slots }), FOOTBALL_WIN_SCORE)).toBeNull();
  });

  it('reads own data fields only, so a getter or an inherited field is never believed', () => {
    const hostile = Object.create({ phase: 'playing', round: 1, slots: MATCH.slots, starks: 0, snarks: 0, secondsLeft: 0, winner: null });
    expect(normalizePitchMatch(hostile, FOOTBALL_WIN_SCORE)).toBeNull();
    const trap = { ...MATCH };
    Object.defineProperty(trap, 'phase', {
      get() {
        throw new Error('no');
      },
    });
    expect(normalizePitchMatch(trap, FOOTBALL_WIN_SCORE)).toBeNull();
  });
});
