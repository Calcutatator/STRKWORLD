import {
  BENCH_RUNS,
  NO_SEAT,
  seatSpotsOf,
  type BenchRun,
  type Facing,
  type SeatSpot,
} from '@strkworld/shared';
import type { FixedRoomLevelMap } from './fixed-room.js';
import { FIXED_ROOM_TILE_SIZE } from './fixed-room.js';
import { TILE_SIZE } from './map/street.js';
import { ROOM_ORIGIN } from './world-layout.js';
import type { InteractionPoint, InteractionRect, InteractionTarget } from './interaction.js';

/**
 * Sittable benches — D-127.
 *
 * Renderer-free, like the rest of the session's gameplay. A bench is not a
 * station: it opens nothing, costs nothing and means nothing financially. It is
 * an `InteractionSource` all the same, so it inherits D-117's rules for free —
 * the nearest-or-faced choice, the E gates, the combat yield — and D-123's key
 * chip reads "[E] SIT".
 *
 * What a bench deliberately does *not* inherit is D-123's other two cues. Its
 * targets carry `cue: 'none'` (interaction.ts), so nothing shimmers and nothing
 * takes an edge glow: the chip is the whole signal, which is what the lead
 * asked for. No bench has an affordance shell built for it either, and a test
 * pins both halves of that.
 *
 * Where the benches are:
 *
 * - **The plaza** (four benches) and **the football pitch's south bleachers**
 *   (two) are on the street, a shared presence area, so the seat has to reach
 *   other players. Their seats are the frozen seam's `STREET_SEATS`, and the
 *   index into it is the whole of what the wire carries.
 * - **The Bridge room's lounge seats** (two runs of three, D-105) are in a solo
 *   interior. They are built here from the room's own `prop: 'bench'` fixtures
 *   and never leave the client: `seat` stays -1 everywhere the lobby can see.
 *
 * A bench a player cannot reach is never offered, and neither is one whose
 * seats are all taken — by a peer sitting there, or by the player themselves.
 */

/** The chip's words at a bench: "[E] SIT". */
export const SIT_LABEL = 'SIT';

/**
 * How close the player's centre must be to a bench's footprint to be offered
 * it, World pixels: one tile, the same reach a counter's approach ring gives
 * (D-033). Measured to the footprint's nearest point, so a long bleacher is
 * reachable all along its front.
 */
export const SEAT_REACH_PX = TILE_SIZE;

/** Which bench a seat belongs to, and where its sitter sits. */
export interface WorldSeat {
  /** Unique within a session: the target id of the bench, plus the seat's place on it. */
  readonly id: string;
  /** The bench this seat is on. */
  readonly bench: string;
  /**
   * The seat's index in `STREET_SEATS`, or -1 for a room's own seat, which
   * never reaches the lobby.
   */
  readonly index: number;
  /** Where the sitter sits, World pixels. */
  readonly x: number;
  readonly y: number;
  /** The way the sitter looks: out from the bench's back. */
  readonly facing: Facing;
}

/** One bench: its footprint, and the seats on it in order. */
export interface WorldBench {
  /** The interaction target's id, e.g. `seat:plaza:0` or `seat:bridge:0`. */
  readonly id: string;
  /** The footprint E is offered from, World pixels. */
  readonly rect: InteractionRect;
  readonly seats: readonly WorldSeat[];
}

const freezeBench = (bench: WorldBench): WorldBench => Object.freeze({
  ...bench,
  rect: Object.freeze({ ...bench.rect }),
  seats: Object.freeze(bench.seats.map((seat) => Object.freeze({ ...seat }))),
});

function benchRect(run: BenchRun, tilePx: number, originX: number, originY: number): InteractionRect {
  return {
    x: originX + run.x * tilePx,
    y: originY + run.y * tilePx,
    width: run.width * tilePx,
    height: run.height * tilePx,
  };
}

/**
 * The overworld's benches: the plaza's four and the pitch's two, with their
 * seats numbered as `STREET_SEATS` numbers them. Built once; the table is
 * frozen data.
 */
export const STREET_BENCHES: readonly WorldBench[] = Object.freeze((() => {
  const benches: WorldBench[] = [];
  let next = 0;
  BENCH_RUNS.forEach((run, order) => {
    const id = `seat:${run.area}:${order}`;
    const seats = [...seatSpotsOf(run, TILE_SIZE)].map((spot, slot) => ({
      id: `${id}:${slot}`,
      bench: id,
      index: next + slot,
      x: spot.x,
      y: spot.y,
      facing: spot.facing,
    }));
    next += seats.length;
    benches.push(freezeBench({ id, rect: benchRect(run, TILE_SIZE, 0, 0), seats }));
  });
  return benches;
})());

/**
 * A fixed-room floor's own benches: every `prop: 'bench'` fixture, drawn as the
 * Bridge's lounge seats are (room-builder.ts's `loungeSeats`: a cushion 0.18 to
 * `height - 0.24` into the fixture with its back at the south edge, so a sitter
 * faces north into the room, and one seat per 0.9 tiles of its length).
 *
 * Room-local: every seat's `index` is -1, so nothing here can be claimed on the
 * wire. The Bank's hall bench (D-104) is a fixture with no prop and is not
 * sittable; only a fixture that says `prop: 'bench'` is.
 */
export function roomBenches(map: Pick<FixedRoomLevelMap, 'building' | 'fixtures'>): readonly WorldBench[] {
  const benches: WorldBench[] = [];
  let order = 0;
  for (const fixture of map.fixtures) {
    if (fixture.prop !== 'bench') continue;
    const run: BenchRun = {
      area: 'room',
      x: fixture.x,
      y: fixture.y,
      width: fixture.width,
      height: fixture.height,
      facing: 'up',
      seats: Math.max(1, Math.round((fixture.width - 0.2) / 0.9)),
      across: ROOM_BENCH_ACROSS,
      inset: ROOM_BENCH_INSET,
    };
    const id = `seat:${map.building}:${order}`;
    order += 1;
    const seats = [...seatSpotsOf(run, FIXED_ROOM_TILE_SIZE)].map((spot, slot) => ({
      id: `${id}:${slot}`,
      bench: id,
      index: NO_SEAT,
      x: ROOM_ORIGIN.x + spot.x,
      y: ROOM_ORIGIN.y + spot.y,
      facing: spot.facing,
    }));
    benches.push(freezeBench({
      id,
      rect: benchRect(run, FIXED_ROOM_TILE_SIZE, ROOM_ORIGIN.x, ROOM_ORIGIN.y),
      seats,
    }));
  }
  return Object.freeze(benches);
}

/**
 * The lounge cushion runs 0.18 to `height - 0.24` into the fixture, so a
 * sitter's middle is 0.53 in from the back edge of a north-facing run.
 */
const ROOM_BENCH_ACROSS = 0.53;
/** The lounge seat's own end inset. */
const ROOM_BENCH_INSET = 0.1;

/**
 * The nearest seat on `bench` that nobody holds, or null when every seat on it
 * is taken. `taken` holds the seat ids in use (a peer sitting there, or the
 * player). Nearest by straight-line distance from `from`, then by seat order,
 * which is all the choosing a two- or three-seat bench needs.
 */
export function nearestFreeSeat(
  bench: WorldBench,
  from: InteractionPoint,
  taken: ReadonlySet<string>,
): WorldSeat | null {
  let best: WorldSeat | null = null;
  let bestDistance = Infinity;
  for (const seat of bench.seats) {
    if (taken.has(seat.id)) continue;
    const distance = Math.hypot(seat.x - from.x, seat.y - from.y);
    if (distance < bestDistance) {
      best = seat;
      bestDistance = distance;
    }
  }
  return best;
}

/** Whether the player's centre is within `SEAT_REACH_PX` of a bench's footprint. */
export function withinSeatReach(rect: InteractionRect, from: InteractionPoint): boolean {
  const nearX = Math.min(Math.max(from.x, rect.x), rect.x + rect.width);
  const nearY = Math.min(Math.max(from.y, rect.y), rect.y + rect.height);
  return Math.hypot(nearX - from.x, nearY - from.y) <= SEAT_REACH_PX;
}

/**
 * The interaction targets for `benches`, from where the player stands: one per
 * bench in reach that still has a free seat. Every one carries `cue: 'none'`
 * and no `object`, so only the chip shows.
 */
export function benchTargets(
  benches: readonly WorldBench[],
  from: InteractionPoint,
  taken: ReadonlySet<string>,
  sit: (seat: WorldSeat) => void,
): readonly InteractionTarget[] {
  const targets: InteractionTarget[] = [];
  for (const bench of benches) {
    if (!withinSeatReach(bench.rect, from)) continue;
    const seat = nearestFreeSeat(bench, from, taken);
    if (!seat) continue;
    targets.push({
      id: bench.id,
      label: SIT_LABEL,
      rect: bench.rect,
      cue: 'none',
      activate: () => sit(seat),
    });
  }
  return targets;
}

/** Every street seat's id, by its wire index, so a peer's `seat` names one. */
export const STREET_SEAT_IDS: readonly string[] = Object.freeze(
  STREET_BENCHES.flatMap((bench) => bench.seats.map((seat) => seat.id)),
);

/** The street seat a wire index names, or null. Takes anything. */
export function streetSeatIdAt(index: unknown): string | null {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return STREET_SEAT_IDS[index] ?? null;
}

/** Every street seat, by wire index. */
export const STREET_SEAT_LIST: readonly WorldSeat[] = Object.freeze(
  STREET_BENCHES.flatMap((bench) => [...bench.seats]),
);

/** Where a sitter sits and looks, for a wire index; null when it names no seat. */
export function streetSeatOf(index: unknown): SeatSpot | null {
  const seat = typeof index === 'number' && Number.isInteger(index) && index >= 0
    ? STREET_SEAT_LIST[index]
    : undefined;
  return seat ? Object.freeze({ x: seat.x, y: seat.y, facing: seat.facing }) : null;
}
