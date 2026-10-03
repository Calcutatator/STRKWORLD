import { describe, expect, it } from 'vitest';
import {
  BENCH_RUNS,
  MAX_STREET_SEATS,
  NO_SEAT,
  STREET_ORIGIN_X,
  STREET_SEATS,
  STREET_TILE_PX,
  isAtStreetSeat,
  seatSpotsOf,
  streetSeatAt,
  type BenchRun,
} from './index.js';

/**
 * D-127: the seat table the wire indexes into. The World pins each run against
 * the fixture it is drawn from (`packages/world/src/seats.test.ts`); this pins
 * the table itself and the two rules the lobby enforces with it.
 */

describe('the overworld seat table (D-127)', () => {
  it('mirrors the street origin and the tile size it is laid out from', () => {
    // The file keeps its own copy to stay off `index.ts`'s import graph.
    expect(BENCH_RUNS[0]?.x).toBe(STREET_ORIGIN_X);
    expect(STREET_TILE_PX).toBe(32);
  });

  it('is four plaza benches seating two and two bleacher rows seating three', () => {
    expect(BENCH_RUNS.filter((run) => run.area === 'plaza')).toHaveLength(4);
    expect(BENCH_RUNS.filter((run) => run.area === 'pitch')).toHaveLength(2);
    for (const run of BENCH_RUNS) {
      expect(run.seats).toBeGreaterThanOrEqual(2);
      expect(run.seats).toBeLessThanOrEqual(3);
    }
    expect(STREET_SEATS).toHaveLength(14);
  });

  it('fits in the one signed byte the wire gives it', () => {
    expect(STREET_SEATS.length).toBeLessThan(MAX_STREET_SEATS);
    expect(NO_SEAT).toBe(-1);
  });

  it('puts every seat on whole pixels, since the lobby rounds what it is sent', () => {
    for (const spot of STREET_SEATS) {
      expect(Number.isInteger(spot.x)).toBe(true);
      expect(Number.isInteger(spot.y)).toBe(true);
    }
  });

  it('spreads seats along a run and sits them across it, facing out from the back', () => {
    const run: BenchRun = {
      area: 'plaza', x: 10, y: 20, width: 2, height: 1,
      facing: 'up', seats: 2, across: 0.5, inset: 0,
    };
    // Facing up (north), the back edge is the south one, so the seat sits half
    // a tile north of it, and the two seats land on the tile centres.
    expect(seatSpotsOf(run, 32)).toEqual([
      { x: 336, y: 656, facing: 'up' },
      { x: 368, y: 656, facing: 'up' },
    ]);
    // Facing right (east), the run is read along y and the back edge is its west one.
    expect(seatSpotsOf({ ...run, facing: 'right', width: 1, height: 2 }, 32)).toEqual([
      { x: 336, y: 656, facing: 'right' },
      { x: 336, y: 688, facing: 'right' },
    ]);
  });

  it('names a seat only for a whole index inside the table', () => {
    expect(streetSeatAt(0)).toEqual(STREET_SEATS[0]);
    expect(streetSeatAt(STREET_SEATS.length - 1)).toEqual(STREET_SEATS.at(-1));
    for (const bogus of [NO_SEAT, -2, STREET_SEATS.length, 1.5, Number.NaN, '0', null, undefined, {}, [0]]) {
      expect(streetSeatAt(bogus)).toBeNull();
    }
  });

  it('accepts a claim only at the seat’s own spot', () => {
    const spot = STREET_SEATS[3]!;
    expect(isAtStreetSeat(3, spot.x, spot.y)).toBe(true);
    expect(isAtStreetSeat(3, spot.x + 1, spot.y)).toBe(false);
    expect(isAtStreetSeat(3, spot.x, spot.y - 1)).toBe(false);
    // A real spot, but not this seat's.
    expect(isAtStreetSeat(4, spot.x, spot.y)).toBe(false);
    expect(isAtStreetSeat(NO_SEAT, spot.x, spot.y)).toBe(false);
  });
});
