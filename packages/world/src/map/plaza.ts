import type { StationId } from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The Privacy Plaza (D-076), as data: a paved square south of the road's
 * west end, opposite the sandbox, with a pool-stats monument and a shell-game
 * table.
 *
 * No money, no wallet, no route. Its two stations open client-only windows,
 * and the plaza is a `BuildingId` only so those stations share the station
 * vocabulary; it has no door, no room and no lobby presence change. Like the
 * rest of the street it is plain tile data: the map paints it
 * (`paintPlaza`), collision reads the tiles, the session reads the station
 * approaches and the renderer (three/plaza-builder.ts) puts every volume on
 * a `plinth` tile.
 */

export interface PlazaRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The plaza's paving, in street tiles: x 0-10, y 19-27, below the south pavement. */
export const PLAZA_AREA: PlazaRect = Object.freeze({ x: 0, y: 19, width: 11, height: 9 });

/**
 * Where the monument is in the fixed north-looking camera's frame: the plaza,
 * the south pavement and the road in front of it. While the player is in
 * here, the Shell keeps the monument's figures fresh (`plaza:nearby`).
 */
export const PLAZA_NEARBY: PlazaRect = Object.freeze({ x: 0, y: 14, width: 16, height: 14 });

export const PLAZA_MONUMENT_STATION: StationId = 'plaza:monument';
export const PLAZA_SHELLS_STATION: StationId = 'plaza:shells';

/** The sign over the plaza's gateway, in the brand-plate style of the facades. */
export const PLAZA_SIGN_TEXT = 'PRIVACY PLAZA\nPOOL STATS · SHELL GAME';

export type PlazaFixtureKind = 'monument' | 'table' | 'arch-post' | 'planter' | 'tree' | 'bench' | 'lamp';

/** Which way a bench's seat faces. */
export type PlazaFacing = 'north' | 'south' | 'east' | 'west';

/** One piece of plaza furniture and the solid tiles it stands on. */
export interface PlazaFixture extends PlazaRect {
  readonly kind: PlazaFixtureKind;
  readonly facing?: PlazaFacing;
}

/**
 * A station: a fixture the player uses with E from any tile next to it (its
 * approach, the ring of tiles around it, as in the fixed rooms). The label is
 * the World's own prompt; the Shell resolves the id before it opens anything.
 */
export interface PlazaStation extends PlazaRect {
  readonly station: StationId;
  readonly label: string;
}

const fixture = (value: PlazaFixture): PlazaFixture => Object.freeze({ ...value });

/**
 * Every fixture, all inside `PLAZA_AREA`. The gateway (two arch posts with the
 * sign between them) is the way in from the pavement, flanked by planters;
 * the east side stays open to the grass. Nothing stands in a station's
 * approach, and the south row holds only low benches and slim lamps, since
 * the camera looks north from beyond it.
 */
export const PLAZA_FIXTURES: readonly PlazaFixture[] = Object.freeze([
  fixture({ kind: 'monument', x: 4, y: 22, width: 3, height: 3 }),
  fixture({ kind: 'table', x: 9, y: 23, width: 1, height: 1 }),
  fixture({ kind: 'arch-post', x: 3, y: 19, width: 1, height: 1 }),
  fixture({ kind: 'arch-post', x: 7, y: 19, width: 1, height: 1 }),
  fixture({ kind: 'planter', x: 0, y: 19, width: 3, height: 1 }),
  fixture({ kind: 'planter', x: 8, y: 19, width: 3, height: 1 }),
  fixture({ kind: 'tree', x: 0, y: 20, width: 1, height: 1 }),
  fixture({ kind: 'tree', x: 10, y: 20, width: 1, height: 1 }),
  fixture({ kind: 'bench', x: 0, y: 23, width: 1, height: 2, facing: 'east' }),
  fixture({ kind: 'bench', x: 10, y: 25, width: 1, height: 2, facing: 'west' }),
  fixture({ kind: 'bench', x: 2, y: 27, width: 2, height: 1, facing: 'north' }),
  fixture({ kind: 'bench', x: 7, y: 27, width: 2, height: 1, facing: 'north' }),
  fixture({ kind: 'lamp', x: 0, y: 27, width: 1, height: 1 }),
  fixture({ kind: 'lamp', x: 10, y: 27, width: 1, height: 1 }),
]);

/** The monument (live pool stats) and the shell-game table. */
export const PLAZA_STATIONS: readonly PlazaStation[] = Object.freeze([
  Object.freeze({ station: PLAZA_MONUMENT_STATION, label: 'POOL STATS', x: 4, y: 22, width: 3, height: 3 }),
  Object.freeze({ station: PLAZA_SHELLS_STATION, label: "WHERE'S THE NOTE?", x: 9, y: 23, width: 1, height: 1 }),
]);

/** Pave the plaza and mark every fixture's tiles solid, in an existing grid. */
export function paintPlaza(tiles: TileKind[][]): void {
  fillTiles(tiles, PLAZA_AREA, 'plaza');
  for (const piece of PLAZA_FIXTURES) fillTiles(tiles, piece, 'plinth');
}

export function inPlazaRect(rect: PlazaRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** The station whose approach holds this street tile, or null. A station's own tiles are not its approach. */
export function plazaStationAtApproach(x: number, y: number): PlazaStation | null {
  for (const station of PLAZA_STATIONS) {
    const halo = { x: station.x - 1, y: station.y - 1, width: station.width + 2, height: station.height + 2 };
    if (inPlazaRect(halo, x, y) && !inPlazaRect(station, x, y)) return station;
  }
  return null;
}

/** Whether a street tile has the plaza in view. */
export function isPlazaNearby(x: number, y: number): boolean {
  return inPlazaRect(PLAZA_NEARBY, x, y);
}

function fillTiles(tiles: TileKind[][], rect: PlazaRect, kind: TileKind): void {
  for (let row = rect.y; row < rect.y + rect.height; row++) {
    for (let col = rect.x; col < rect.x + rect.width; col++) {
      if (tiles[row]?.[col] !== undefined) tiles[row]![col] = kind;
    }
  }
}
