import { describe, expect, it } from 'vitest';
import { BENCH_RUNS, STREET_SEATS, STREET_TILE_PX } from '@strkworld/shared';
import { PLAZA_FIXTURES } from './map/plaza.js';
import { PITCH_FIXTURES } from './map/pitch.js';
import { TILE_SIZE } from './map/street.js';
import { BANK_ROOM_DEFINITION, BRIDGE_ROOM_DEFINITION, FIXED_ROOM_TILE_SIZE, type FixedRoomFixture } from './fixed-room.js';
import { ROOM_ORIGIN } from './world-layout.js';
import {
  SEAT_REACH_PX,
  SIT_LABEL,
  STREET_BENCHES,
  benchTargets,
  nearestFreeSeat,
  roomBenches,
  streetSeatIdAt,
  withinSeatReach,
} from './seats.js';

/**
 * D-127: the benches the World offers, and the drift tests that keep the
 * frozen seam's seat table honest about the benches that are actually drawn.
 */

const FACING_OF: Record<string, string> = { north: 'up', south: 'down', east: 'right', west: 'left' };

describe('sittable benches (D-127)', () => {
  it('shares the street tile size with the seam', () => {
    expect(STREET_TILE_PX).toBe(TILE_SIZE);
  });

  it('has one bench run per plaza bench, with its own facing', () => {
    const drawn = PLAZA_FIXTURES.filter((piece) => piece.kind === 'bench');
    const runs = BENCH_RUNS.filter((run) => run.area === 'plaza');
    expect(runs).toHaveLength(drawn.length);
    runs.forEach((run, index) => {
      const bench = drawn[index]!;
      expect([run.x, run.y, run.width, run.height]).toEqual([bench.x, bench.y, bench.width, bench.height]);
      expect(run.facing).toBe(FACING_OF[bench.facing ?? 'north']);
      // A two-tile bench seats two.
      expect(run.seats).toBe(Math.max(bench.width, bench.height));
    });
  });

  it('has one bench run per pitch bleacher, on the front row a walker can reach', () => {
    const drawn = PITCH_FIXTURES.filter((piece) => piece.kind === 'bleacher');
    const runs = BENCH_RUNS.filter((run) => run.area === 'pitch');
    expect(runs).toHaveLength(drawn.length);
    runs.forEach((run, index) => {
      const bleacher = drawn[index]!;
      expect(run.x).toBe(bleacher.x);
      expect(run.width).toBe(bleacher.width);
      // The lower row, nearest the walkway; the row behind it is a step up.
      expect(run.y).toBe(bleacher.y);
      expect(run.height).toBe(1);
      // It faces the field, which is north of it.
      expect(run.facing).toBe('up');
      expect(run.y).toBeGreaterThan(0);
    });
  });

  it('numbers the street seats exactly as the seam does', () => {
    const seats = STREET_BENCHES.flatMap((bench) => bench.seats);
    expect(seats).toHaveLength(STREET_SEATS.length);
    seats.forEach((seat, index) => {
      expect(seat.index).toBe(index);
      expect({ x: seat.x, y: seat.y, facing: seat.facing }).toEqual(STREET_SEATS[index]);
      expect(streetSeatIdAt(index)).toBe(seat.id);
    });
    expect(streetSeatIdAt(STREET_SEATS.length)).toBeNull();
    expect(streetSeatIdAt(-1)).toBeNull();
    // Every bench id and every seat id is unique.
    expect(new Set(STREET_BENCHES.map((bench) => bench.id)).size).toBe(STREET_BENCHES.length);
    expect(new Set(seats.map((seat) => seat.id)).size).toBe(seats.length);
  });

  it('stands every street seat on its own bench’s footprint', () => {
    for (const bench of STREET_BENCHES) {
      for (const seat of bench.seats) {
        expect(seat.x).toBeGreaterThanOrEqual(bench.rect.x);
        expect(seat.x).toBeLessThanOrEqual(bench.rect.x + bench.rect.width);
        expect(seat.y).toBeGreaterThanOrEqual(bench.rect.y);
        expect(seat.y).toBeLessThanOrEqual(bench.rect.y + bench.rect.height);
      }
    }
  });

  it('builds the Bridge room’s two lounge runs of three, room-local', () => {
    const benches = roomBenches(BRIDGE_ROOM_DEFINITION);
    expect(benches.map((bench) => bench.id)).toEqual(['seat:bridge:0', 'seat:bridge:1']);
    for (const bench of benches) {
      expect(bench.seats).toHaveLength(3);
      for (const seat of bench.seats) {
        // Nothing here reaches the lobby: a room seat has no wire index.
        expect(seat.index).toBe(-1);
        expect(seat.facing).toBe('up');
        // Drawn at the interiors' origin, like the room itself.
        expect(seat.x).toBeGreaterThan(ROOM_ORIGIN.x);
        expect(seat.y).toBeGreaterThan(ROOM_ORIGIN.y);
      }
    }
    // The first run covers the fixture it is drawn on.
    const fixture = (BRIDGE_ROOM_DEFINITION.fixtures as readonly FixedRoomFixture[])
      .find((piece) => piece.prop === 'bench')!;
    expect(benches[0]!.rect).toEqual({
      x: ROOM_ORIGIN.x + fixture.x * FIXED_ROOM_TILE_SIZE,
      y: ROOM_ORIGIN.y + fixture.y * FIXED_ROOM_TILE_SIZE,
      width: fixture.width * FIXED_ROOM_TILE_SIZE,
      height: fixture.height * FIXED_ROOM_TILE_SIZE,
    });
  });

  it('leaves a fixture that is not a bench prop alone — the Bank’s hall bench is furniture', () => {
    expect(roomBenches(BANK_ROOM_DEFINITION)).toEqual([]);
  });

  it('offers a bench only within a tile of its footprint', () => {
    const bench = STREET_BENCHES[0]!;
    const beside = { x: bench.rect.x + bench.rect.width + SEAT_REACH_PX - 1, y: bench.rect.y + 8 };
    const away = { x: bench.rect.x + bench.rect.width + SEAT_REACH_PX + 2, y: bench.rect.y + 8 };
    expect(withinSeatReach(bench.rect, beside)).toBe(true);
    expect(withinSeatReach(bench.rect, away)).toBe(false);
    expect(benchTargets([bench], beside, new Set(), () => {})).toHaveLength(1);
    expect(benchTargets([bench], away, new Set(), () => {})).toHaveLength(0);
  });

  it('asks for the chip and nothing else: no cue object, label SIT', () => {
    const bench = STREET_BENCHES[0]!;
    const at = { x: bench.rect.x + bench.rect.width + 4, y: bench.rect.y + 8 };
    const [target] = benchTargets([bench], at, new Set(), () => {});
    expect(target?.label).toBe(SIT_LABEL);
    expect(target?.cue).toBe('none');
    expect(target?.object).toBeUndefined();
  });

  it('takes the nearest free seat, and offers no bench whose seats are all taken', () => {
    const bench = STREET_BENCHES[4]!;
    const [first, second, third] = bench.seats;
    const beside = { x: third!.x, y: bench.rect.y - 8 };
    expect(nearestFreeSeat(bench, beside, new Set())?.id).toBe(third!.id);
    expect(nearestFreeSeat(bench, beside, new Set([third!.id]))?.id).toBe(second!.id);
    expect(nearestFreeSeat(bench, beside, new Set([third!.id, second!.id]))?.id).toBe(first!.id);
    const full = new Set(bench.seats.map((seat) => seat.id));
    expect(nearestFreeSeat(bench, beside, full)).toBeNull();
    expect(benchTargets([bench], beside, full, () => {})).toHaveLength(0);
  });

  it('activating a target sits the player on the seat it chose', () => {
    const bench = STREET_BENCHES[2]!;
    const at = { x: bench.seats[0]!.x, y: bench.rect.y - 8 };
    const sat: string[] = [];
    const [target] = benchTargets([bench], at, new Set(), (seat) => sat.push(seat.id));
    target?.activate();
    expect(sat).toEqual([bench.seats[0]!.id]);
  });
});
