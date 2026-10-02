import { ARENA_BUILDING, STREET_ORIGIN_X, type BuildingId, type Facing } from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The gladiator pit (D-114), as data: an old-style sunken stone pit on the
 * east half of the south lawn, entered through a two-tile arch on its north
 * side, reached by a one-row stone path from the south pavement.
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
 * corners exactly and no corner of the pit is an invisible wall: every solid
 * tile is drawn as rim or bowl, and every tile drawn as lawn is walkable.
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

/** The pit's whole footprint: street x 61-75, rows 20-26. */
export const ARENA_PIT_AREA: ArenaPitRect = Object.freeze({ x: at(32), y: 20, width: 15, height: 7 });

/** The arch's threshold, two tiles wide on the north rim: the door. */
export const ARENA_PIT_DOOR: ArenaPitRect = Object.freeze({ x: at(38), y: 20, width: 2, height: 1 });

/** The one-row stone path from the south pavement to the arch. */
export const ARENA_PIT_PATH: ArenaPitRect = Object.freeze({ x: at(38), y: 19, width: 2, height: 1 });

/**
 * Where a player leaving the arena stands: on the path, facing north, away
 * from the arch (the generic "a tile below the door" would be in the bowl).
 */
export const ARENA_PIT_RETURN = Object.freeze({ x: at(38), y: 19 });
export const ARENA_PIT_RETURN_FACING: Facing = 'up';

/** The arch's two gateposts, on the rim either side of the threshold. */
export const ARENA_PIT_GATEPOSTS: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  Object.freeze({ x: at(37), y: 20 }),
  Object.freeze({ x: at(40), y: 20 }),
]);

/** The four braziers on the rim's corners. */
export const ARENA_PIT_TORCHES: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  Object.freeze({ x: at(34), y: 20 }),
  Object.freeze({ x: at(44), y: 20 }),
  Object.freeze({ x: at(34), y: 26 }),
  Object.freeze({ x: at(44), y: 26 }),
]);

/** One row of the pit: its rim runs, its bowl run and any door run, in street x. */
interface PitRow {
  readonly y: number;
  readonly rim: readonly (readonly [number, number])[];
  readonly bowl: readonly [number, number] | null;
  readonly step: readonly [number, number] | null;
}

/**
 * The exact rows (inclusive x ranges), from the design's table:
 *
 *   row 20  rim 63-66, 69-73   step 67-68 (door)
 *   row 21  rim 62, 74         bowl 63-73
 *   row 22-24  rim 61, 75      bowl 62-74
 *   row 25  rim 62, 74         bowl 63-73
 *   row 26  rim 63-73
 */
export const ARENA_PIT_ROWS: readonly PitRow[] = Object.freeze(
  [
    { y: 20, rim: [[at(34), at(37)], [at(40), at(44)]], bowl: null, step: [at(38), at(39)] },
    { y: 21, rim: [[at(33), at(33)], [at(45), at(45)]], bowl: [at(34), at(44)], step: null },
    { y: 22, rim: [[at(32), at(32)], [at(46), at(46)]], bowl: [at(33), at(45)], step: null },
    { y: 23, rim: [[at(32), at(32)], [at(46), at(46)]], bowl: [at(33), at(45)], step: null },
    { y: 24, rim: [[at(32), at(32)], [at(46), at(46)]], bowl: [at(33), at(45)], step: null },
    { y: 25, rim: [[at(33), at(33)], [at(45), at(45)]], bowl: [at(34), at(44)], step: null },
    { y: 26, rim: [[at(34), at(44)]], bowl: null, step: null },
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

/** Paint the pit and its path into an existing grid. */
export function paintArenaPit(tiles: TileKind[][]): void {
  for (let y = ARENA_PIT_AREA.y; y < ARENA_PIT_AREA.y + ARENA_PIT_AREA.height; y++) {
    for (let x = ARENA_PIT_AREA.x; x < ARENA_PIT_AREA.x + ARENA_PIT_AREA.width; x++) {
      const kind = arenaPitTileAt(x, y);
      if (kind && tiles[y]?.[x] !== undefined) tiles[y]![x] = kind;
    }
  }
  for (let x = ARENA_PIT_PATH.x; x < ARENA_PIT_PATH.x + ARENA_PIT_PATH.width; x++) {
    if (tiles[ARENA_PIT_PATH.y]?.[x] !== undefined) tiles[ARENA_PIT_PATH.y]![x] = 'pavement';
  }
}

export function inArenaPitRect(rect: ArenaPitRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
