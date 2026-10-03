import { ARENA_BUILDING, STREET_ORIGIN_X, type BuildingId, type Facing } from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The Colosseum (D-114, D-128), as data: the stadium on the south lawn just
 * east of the Avatar Studio's path, entered through a three-tile grand arch
 * on its west front. A short stone path branches east off the Studio's path
 * to the arch, so walking east off the branch through the arch enters the
 * arena, and leaving puts the player back on the branch facing west (amended
 * 2026-10-02: the arch was on the north side, off the road).
 *
 * The footprint is exactly what the sunken pit's was (D-128 replaced the pit
 * with the building the arena is from the inside, and changed nothing a
 * walker can feel): the same lot, the same door tiles, the same branch and
 * the same return tile and facing.
 *
 * Like the plaza and the hidden stair it is plain tile data: the map paints
 * it (`paintColosseum`), collision reads the tiles, and the renderer
 * (three/colosseum-builder.ts) stands every volume on a solid `colwall` tile
 * (the outer wall's ring) or on the solid `colcore` it encloses. The arch's
 * threshold (`colstep`) is walkable and carries the door, so walking (or
 * jumping, D-097: a jump never changes collision) onto it enters the arena
 * through the fixed rooms' machinery. `arena` is a codename for code only.
 *
 * The rows are spelled out one by one, so the wall follows the oval's rounded
 * east end and square west front exactly and no corner of the building is an
 * invisible wall: every solid tile carries masonry, and every tile drawn as
 * lawn is walkable.
 */

export const COLOSSEUM_BUILDING: BuildingId = ARENA_BUILDING;

export interface ColosseumRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Laid out from the street's first column, as the plaza is (D-078). */
const at = (x: number): number => STREET_ORIGIN_X + x;

/** The building's whole footprint: street x 57-70, rows 20-26. */
export const COLOSSEUM_AREA: ColosseumRect = Object.freeze({ x: at(28), y: 20, width: 14, height: 7 });

/** The grand arch's threshold, three tiles tall on the west front: the door. */
export const COLOSSEUM_DOOR: ColosseumRect = Object.freeze({ x: at(28), y: 22, width: 1, height: 3 });

/**
 * The stone branch path, east off the Avatar Studio's path (street x 52-53)
 * to the arch: three tiles long, as tall as the arch's opening.
 */
export const COLOSSEUM_PATH: ColosseumRect = Object.freeze({ x: at(25), y: 22, width: 3, height: 3 });

/**
 * Where a player leaving the arena stands: on the branch just outside the
 * arch, facing west, back along the branch to the Studio's path.
 */
export const COLOSSEUM_RETURN = Object.freeze({ x: at(27), y: 23 });
export const COLOSSEUM_RETURN_FACING: Facing = 'left';

/** The grand arch's two piers, on the west front either side of the threshold. */
export const COLOSSEUM_GATEPOSTS: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  Object.freeze({ x: at(28), y: 21 }),
  Object.freeze({ x: at(28), y: 25 }),
]);

/** The four cressets: two over the arch on the west front's corners, two at the east ends of the long walls. */
export const COLOSSEUM_TORCHES: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  Object.freeze({ x: at(28), y: 20 }),
  Object.freeze({ x: at(39), y: 20 }),
  Object.freeze({ x: at(28), y: 26 }),
  Object.freeze({ x: at(39), y: 26 }),
]);

/** One row of the building: its wall runs, its core run and any door run, in street x. */
interface ColosseumRow {
  readonly y: number;
  readonly wall: readonly (readonly [number, number])[];
  readonly core: readonly [number, number] | null;
  readonly step: readonly [number, number] | null;
}

/**
 * The exact rows (inclusive x ranges):
 *
 *   row 20     wall 57-68
 *   row 21     wall 57, 69       core 58-68   (57: the north pier)
 *   row 22-24  step 57 (door)    core 58-69   wall 70
 *   row 25     wall 57, 69       core 58-68   (57: the south pier)
 *   row 26     wall 57-68
 */
export const COLOSSEUM_ROWS: readonly ColosseumRow[] = Object.freeze(
  [
    { y: 20, wall: [[at(28), at(39)]], core: null, step: null },
    { y: 21, wall: [[at(28), at(28)], [at(40), at(40)]], core: [at(29), at(39)], step: null },
    { y: 22, wall: [[at(41), at(41)]], core: [at(29), at(40)], step: [at(28), at(28)] },
    { y: 23, wall: [[at(41), at(41)]], core: [at(29), at(40)], step: [at(28), at(28)] },
    { y: 24, wall: [[at(41), at(41)]], core: [at(29), at(40)], step: [at(28), at(28)] },
    { y: 25, wall: [[at(28), at(28)], [at(40), at(40)]], core: [at(29), at(39)], step: null },
    { y: 26, wall: [[at(28), at(39)]], core: null, step: null },
  ].map((row) =>
    Object.freeze({
      y: row.y,
      wall: Object.freeze(row.wall.map((run) => Object.freeze(run) as readonly [number, number])),
      core: row.core ? (Object.freeze(row.core) as readonly [number, number]) : null,
      step: row.step ? (Object.freeze(row.step) as readonly [number, number]) : null,
    }),
  ),
);

/** What the building makes of one street tile, or null off it (lawn, path). */
export function colosseumTileAt(x: number, y: number): 'colwall' | 'colcore' | 'colstep' | null {
  const row = COLOSSEUM_ROWS.find((candidate) => candidate.y === y);
  if (!row) return null;
  if (row.step && x >= row.step[0] && x <= row.step[1]) return 'colstep';
  if (row.core && x >= row.core[0] && x <= row.core[1]) return 'colcore';
  if (row.wall.some(([x0, x1]) => x >= x0 && x <= x1)) return 'colwall';
  return null;
}

/** Paint the building and its branch path into an existing grid. */
export function paintColosseum(tiles: TileKind[][]): void {
  for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
    for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
      const kind = colosseumTileAt(x, y);
      if (kind && tiles[y]?.[x] !== undefined) tiles[y]![x] = kind;
    }
  }
  for (let y = COLOSSEUM_PATH.y; y < COLOSSEUM_PATH.y + COLOSSEUM_PATH.height; y++) {
    for (let x = COLOSSEUM_PATH.x; x < COLOSSEUM_PATH.x + COLOSSEUM_PATH.width; x++) {
      if (tiles[y]?.[x] !== undefined) tiles[y]![x] = 'pavement';
    }
  }
}

export function inColosseumRect(rect: ColosseumRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
