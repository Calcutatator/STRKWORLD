/**
 * Sittable benches in the shared overworld — D-127.
 *
 * ⚠ Part of the FROZEN SEAM. The wire carries one number for sitting: an index
 * into `STREET_SEATS`, or -1 for standing (`PresenceState.seat`). So this table
 * is the shared vocabulary of where a player may sit, and both sides read it:
 * the World offers the nearest free seat, and the lobby accepts a claim only
 * for a real index whose own spot is where it already holds that player, and
 * only while nobody else holds it.
 *
 * Only the overworld's benches are here. The Privacy Plaza's four benches
 * (D-076) and the two bleachers on the football pitch's south side (D-078) are
 * on the street, which is a presence area, so other players must see you
 * sitting. The Bridge room's lounge seats (D-105) are in a solo interior and
 * never reach the lobby: the World keeps those seats to itself.
 *
 * This file holds the bench runs as data, not the renderer's geometry. A World
 * test (`seats.test.ts`) pins each run against the fixture it is drawn from
 * (`PLAZA_FIXTURES`, `PITCH_FIXTURES`), so the two cannot drift.
 */

import type { Facing } from './index.js';

/** World pixels per street tile. Mirrors the World's `TILE_SIZE`; a World test pins it. */
export const STREET_TILE_PX = 32;

/**
 * Mirrors `STREET_ORIGIN_X` (D-078), deliberately as a value of its own rather
 * than an import: `index.ts` re-exports this file, and a value read back out of
 * it at module scope would be a cycle this seam does not need. `seats.test.ts`
 * fails if the two drift.
 */
const STREET_ORIGIN_X_MIRROR = 29;

/**
 * One run of bench with a sitter's place on it. `across` and `inset` are the
 * builder's own numbers (three/plaza-builder.ts's `bench`, pitch-builder.ts's
 * `bleacher`), so a seated avatar lands on the seat the eye sees rather than on
 * the tile's middle.
 */
export interface BenchRun {
  /**
   * What drew it; presentation only, for tests and renders. `'room'` is a
   * fixed room's own bench (the Bridge lounge), which is never in `BENCH_RUNS`
   * because a solo interior's seats never reach the lobby.
   */
  readonly area: 'plaza' | 'pitch' | 'room';
  /** The run's tile rect, in street tiles. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The way a sitter looks: out from the bench's back. */
  readonly facing: Facing;
  /** How many may sit on it, 2 or 3. */
  readonly seats: number;
  /** Where the seat is across the run, in tiles from its back edge. */
  readonly across: number;
  /** Dead length at each end of the run, in tiles. */
  readonly inset: number;
}

/** Where one sitter sits: World pixels, whole numbers, and the way they look. */
export interface SeatSpot {
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
}

const run = (value: BenchRun): BenchRun => Object.freeze({ ...value });

/** The plaza's benches are laid out from the street's first column, like the rest of it (D-078). */
const at = (x: number): number => STREET_ORIGIN_X_MIRROR + x;

/**
 * The plaza's seat slats span 0.2 to 0.65 of a tile in from the bench's back
 * (plaza-builder.ts), so a sitter's middle is 0.425 in.
 */
const PLAZA_ACROSS = 0.425;
/** The plaza bench's own end inset. */
const PLAZA_INSET = 0.1;
/**
 * A bleacher's front plank runs 0.2 to 0.62 into its row, measured from the
 * row's south edge backwards (pitch-builder.ts's `bleacher`, row 0), which is
 * 0.59 in from the back of a north-facing run.
 */
const BLEACHER_ACROSS = 0.59;
/** The bleacher's own end inset. */
const BLEACHER_INSET = 0.1;

/**
 * Every bench run in the shared overworld, in the order their seats are
 * indexed. Appending is safe; reordering or removing a run renumbers live
 * seats, so it needs a decision entry of its own.
 *
 * The plaza's four benches are two tiles long and seat two. Each bleacher's
 * front row is the one a walker can reach from the walkway — the row behind it
 * is a step up — so it is one long run seating three, and the whole stand reads
 * as filling up rather than as sixteen separate perches.
 */
export const BENCH_RUNS: readonly BenchRun[] = Object.freeze([
  run({ area: 'plaza', x: at(0), y: 23, width: 1, height: 2, facing: 'right', seats: 2, across: PLAZA_ACROSS, inset: PLAZA_INSET }),
  run({ area: 'plaza', x: at(10), y: 25, width: 1, height: 2, facing: 'left', seats: 2, across: PLAZA_ACROSS, inset: PLAZA_INSET }),
  run({ area: 'plaza', x: at(2), y: 27, width: 2, height: 1, facing: 'up', seats: 2, across: PLAZA_ACROSS, inset: PLAZA_INSET }),
  run({ area: 'plaza', x: at(7), y: 27, width: 2, height: 1, facing: 'up', seats: 2, across: PLAZA_ACROSS, inset: PLAZA_INSET }),
  run({ area: 'pitch', x: 5, y: 25, width: 8, height: 1, facing: 'up', seats: 3, across: BLEACHER_ACROSS, inset: BLEACHER_INSET }),
  run({ area: 'pitch', x: 15, y: 25, width: 8, height: 1, facing: 'up', seats: 3, across: BLEACHER_ACROSS, inset: BLEACHER_INSET }),
]);

/**
 * Where each sitter sits on one run, in World pixels, in seat order: spread
 * evenly along the run inside its insets, all at the same place across it.
 *
 * Exported because the World draws the Bridge room's own seats with the same
 * rule, on a grid the lobby never sees.
 */
export function seatSpotsOf(bench: BenchRun, tilePx: number = STREET_TILE_PX): readonly SeatSpot[] {
  const alongX = bench.facing === 'up' || bench.facing === 'down';
  const length = alongX ? bench.width : bench.height;
  const start = (alongX ? bench.x : bench.y) + bench.inset;
  const span = Math.max(length - 2 * bench.inset, 0);
  // The back edge is the far side from the way a sitter looks.
  const back = bench.facing === 'up'
    ? bench.y + bench.height
    : bench.facing === 'down'
      ? bench.y
      : bench.facing === 'left'
        ? bench.x + bench.width
        : bench.x;
  const toward = bench.facing === 'up' || bench.facing === 'left' ? -1 : 1;
  const across = back + toward * bench.across;
  const count = Math.max(1, Math.trunc(bench.seats));
  const spots: SeatSpot[] = [];
  for (let index = 0; index < count; index += 1) {
    const along = start + (span * (index + 0.5)) / count;
    spots.push(Object.freeze({
      // Whole pixels: the lobby rounds every coordinate it is sent, so a seat's
      // own spot has to be a number a move can land on exactly.
      x: Math.round((alongX ? along : across) * tilePx),
      y: Math.round((alongX ? across : along) * tilePx),
      facing: bench.facing,
    }));
  }
  return Object.freeze(spots);
}

/**
 * Every seat in the shared overworld, in wire order: run by run, seat by seat.
 * The index into this list is the whole of what the wire carries.
 */
export const STREET_SEATS: readonly SeatSpot[] = Object.freeze(
  BENCH_RUNS.flatMap((bench) => [...seatSpotsOf(bench)]),
);

/**
 * The most seats the wire can carry. `PresenceState.seat` is one signed byte,
 * so -1 is standing and 0..126 is a seat; a test fails if the table outgrows
 * it, which is the moment the field would have to widen.
 */
export const MAX_STREET_SEATS = 127;

/** Standing. The value of `PresenceState.seat` for everyone who is not sitting. */
export const NO_SEAT = -1;

/**
 * The seat a wire value names, or null for standing and for anything else.
 * Takes `unknown`, so an untrusted payload can be asked directly.
 */
export function streetSeatAt(raw: unknown): SeatSpot | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= STREET_SEATS.length) return null;
  return STREET_SEATS[raw] ?? null;
}

/**
 * Whether `x, y` (World pixels, as the lobby holds a position) is exactly the
 * spot of seat `index`. The lobby's one rule for a seat claim: a player sits
 * where the seat is, or they are not sitting.
 */
export function isAtStreetSeat(index: unknown, x: unknown, y: unknown): boolean {
  const spot = streetSeatAt(index);
  if (spot === null) return false;
  return x === spot.x && y === spot.y;
}
