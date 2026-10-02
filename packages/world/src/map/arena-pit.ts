import { ARENA_BUILDING, STREET_ORIGIN_X, type BuildingId, type Facing } from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The gladiator pit (D-114), as data: an old-style sunken stone pit on the
 * south lawn just east of the Avatar Studio's path, entered through a
 * three-tile arch on its west side. A short stone path branches east off the
 * Studio's path to the arch, so walking east off the branch through the arch
 * enters the arena, and leaving puts the player back on the branch facing
 * west (amended 2026-10-02: the arch was on the north rim, off the road).
 *
 * Like the plaza and the hidden stair it is plain tile data: the map paints
 * it (`paintArenaPit`), collision reads the tiles, and the renderer
 * (three/arena-pit-builder.ts) stands every volume on a solid `pitrim` tile
 * or sinks it into the solid `pitbowl`. The arch's threshold (`pitstep`) is
 * walkable and carries the door, so walking (or jumping, D-097: a jump never
 * changes collision) onto it enters the arena through the fixed rooms'
 * machinery. `arena` is a codename for code only.
 *
 * The rows are spelled out one by one, so the rim follows the bowl's rounded
 * east corners and square west front exactly and no corner of the pit is an
 * invisible wall: every solid tile is drawn as rim or bowl, and every tile
 * drawn as lawn is walkable.
 */

export const ARENA_PIT_BUILDING: BuildingId = ARENA_BUILDING;

export interface ArenaPitRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Laid out from the street's first column, as the plaza is (D-078). */
const at = (x: number): number => STREET_ORIGIN_X + x;

/** The pit's whole footprint: street x 57-70, rows 20-26. */
export const ARENA_PIT_AREA: ArenaPitRect = Object.freeze({ x: at(28), y: 20, width: 14, height: 7 });

/** The arch's threshold, three tiles tall on the west front: the door. */
export const ARENA_PIT_DOOR: ArenaPitRect = Object.freeze({ x: at(28), y: 22, width: 1, height: 3 });

/**
 * The stone branch path, east off the Avatar Studio's path (street x 52-53)
 * to the arch: three tiles long, as tall as the arch's opening.
 */
export const ARENA_PIT_PATH: ArenaPitRect = Object.freeze({ x: at(25), y: 22, width: 3, height: 3 });

/**
 * Where a player leaving the arena stands: on the branch just outside the
 * arch, facing west, back along the branch to the Studio's path.
 */
export const ARENA_PIT_RETURN = Object.freeze({ x: at(27), y: 23 });
export const ARENA_PIT_RETURN_FACING: Facing = 'left';

/** The arch's two gateposts, on the west front either side of the threshold. */
export const ARENA_PIT_GATEPOSTS: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  Object.freeze({ x: at(28), y: 21 }),
  Object.freeze({ x: at(28), y: 25 }),
]);

/** The four braziers: two flanking the arch on the west front's corners, two at the east ends of the long rims. */
export const ARENA_PIT_TORCHES: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  Object.freeze({ x: at(28), y: 20 }),
  Object.freeze({ x: at(39), y: 20 }),
  Object.freeze({ x: at(28), y: 26 }),
  Object.freeze({ x: at(39), y: 26 }),
]);

/** One row of the pit: its rim runs, its bowl run and any door run, in street x. */
interface PitRow {
  readonly y: number;
  readonly rim: readonly (readonly [number, number])[];
  readonly bowl: readonly [number, number] | null;
  readonly step: readonly [number, number] | null;
}

/**
 * The exact rows (inclusive x ranges):
 *
 *   row 20     rim 57-68
 *   row 21     rim 57, 69        bowl 58-68   (57: the north gatepost)
 *   row 22-24  step 57 (door)    bowl 58-69   rim 70
 *   row 25     rim 57, 69        bowl 58-68   (57: the south gatepost)
 *   row 26     rim 57-68
 */
export const ARENA_PIT_ROWS: readonly PitRow[] = Object.freeze(
  [
    { y: 20, rim: [[at(28), at(39)]], bowl: null, step: null },
    { y: 21, rim: [[at(28), at(28)], [at(40), at(40)]], bowl: [at(29), at(39)], step: null },
    { y: 22, rim: [[at(41), at(41)]], bowl: [at(29), at(40)], step: [at(28), at(28)] },
    { y: 23, rim: [[at(41), at(41)]], bowl: [at(29), at(40)], step: [at(28), at(28)] },
    { y: 24, rim: [[at(41), at(41)]], bowl: [at(29), at(40)], step: [at(28), at(28)] },
    { y: 25, rim: [[at(28), at(28)], [at(40), at(40)]], bowl: [at(29), at(39)], step: null },
    { y: 26, rim: [[at(28), at(39)]], bowl: null, step: null },
  ].map((row) =>
    Object.freeze({
      y: row.y,
      rim: Object.freeze(row.rim.map((run) => Object.freeze(run) as readonly [number, number])),
      bowl: row.bowl ? (Object.freeze(row.bowl) as readonly [number, number]) : null,
      step: row.step ? (Object.freeze(row.step) as readonly [number, number]) : null,
    }),
  ),
);

/** What the pit makes of one street tile, or null off it (lawn, path). */
export function arenaPitTileAt(x: number, y: number): 'pitrim' | 'pitbowl' | 'pitstep' | null {
  const row = ARENA_PIT_ROWS.find((candidate) => candidate.y === y);
  if (!row) return null;
  if (row.step && x >= row.step[0] && x <= row.step[1]) return 'pitstep';
  if (row.bowl && x >= row.bowl[0] && x <= row.bowl[1]) return 'pitbowl';
  if (row.rim.some(([x0, x1]) => x >= x0 && x <= x1)) return 'pitrim';
  return null;
}

/** Paint the pit and its branch path into an existing grid. */
export function paintArenaPit(tiles: TileKind[][]): void {
  for (let y = ARENA_PIT_AREA.y; y < ARENA_PIT_AREA.y + ARENA_PIT_AREA.height; y++) {
    for (let x = ARENA_PIT_AREA.x; x < ARENA_PIT_AREA.x + ARENA_PIT_AREA.width; x++) {
      const kind = arenaPitTileAt(x, y);
      if (kind && tiles[y]?.[x] !== undefined) tiles[y]![x] = kind;
    }
  }
  for (let y = ARENA_PIT_PATH.y; y < ARENA_PIT_PATH.y + ARENA_PIT_PATH.height; y++) {
    for (let x = ARENA_PIT_PATH.x; x < ARENA_PIT_PATH.x + ARENA_PIT_PATH.width; x++) {
      if (tiles[y]?.[x] !== undefined) tiles[y]![x] = 'pavement';
    }
  }
}

export function inArenaPitRect(rect: ArenaPitRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
