import { STREET_ORIGIN_X, type StationId } from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The Privacy Plaza (D-076), as data: a paved square south of the street's
 * west end, beside the football pitch (D-078), with a pool-stats monument and
 * a shell-game table.
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

/**
 * D-078: the plaza is laid out from the street's first column, so it moved
 * east with the street when the pitch square took the road's west end, and
 * nothing in it moved relative to the street.
 */
const at = (x: number): number => STREET_ORIGIN_X + x;

/** The plaza's paving, in street tiles: the street's x 0-10, y 19-27, below the south pavement. */
export const PLAZA_AREA: PlazaRect = Object.freeze({ x: at(0), y: 19, width: 11, height: 9 });

/**
 * Where the monument is in the fixed north-looking camera's frame: the plaza,
 * the south pavement and the road in front of it. While the player is in
 * here, the Shell keeps the monument's figures fresh (`plaza:nearby`).
 */
export const PLAZA_NEARBY: PlazaRect = Object.freeze({ x: at(0), y: 14, width: 16, height: 14 });

export const PLAZA_MONUMENT_STATION: StationId = 'plaza:monument';
export const PLAZA_SHELLS_STATION: StationId = 'plaza:shells';
/** Leaderboard phase 1: the placement stand, built only while the Shell switches it on. */
export const PLAZA_PLACEMENT_STATION: StationId = 'plaza:placement';

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
  fixture({ kind: 'monument', x: at(4), y: 22, width: 3, height: 3 }),
  fixture({ kind: 'table', x: at(9), y: 23, width: 1, height: 1 }),
  fixture({ kind: 'arch-post', x: at(3), y: 19, width: 1, height: 1 }),
  fixture({ kind: 'arch-post', x: at(7), y: 19, width: 1, height: 1 }),
  fixture({ kind: 'planter', x: at(0), y: 19, width: 3, height: 1 }),
  fixture({ kind: 'planter', x: at(8), y: 19, width: 3, height: 1 }),
  fixture({ kind: 'tree', x: at(0), y: 20, width: 1, height: 1 }),
  fixture({ kind: 'tree', x: at(10), y: 20, width: 1, height: 1 }),
  fixture({ kind: 'bench', x: at(0), y: 23, width: 1, height: 2, facing: 'east' }),
  fixture({ kind: 'bench', x: at(10), y: 25, width: 1, height: 2, facing: 'west' }),
  fixture({ kind: 'bench', x: at(2), y: 27, width: 2, height: 1, facing: 'north' }),
  fixture({ kind: 'bench', x: at(7), y: 27, width: 2, height: 1, facing: 'north' }),
  fixture({ kind: 'lamp', x: at(0), y: 27, width: 1, height: 1 }),
  fixture({ kind: 'lamp', x: at(10), y: 27, width: 1, height: 1 }),
]);

/** The monument (live pool stats) and the shell-game table. */
export const PLAZA_STATIONS: readonly PlazaStation[] = Object.freeze([
  Object.freeze({ station: PLAZA_MONUMENT_STATION, label: 'POOL STATS', x: at(4), y: 22, width: 3, height: 3 }),
  Object.freeze({ station: PLAZA_SHELLS_STATION, label: "WHERE'S THE NOTE?", x: at(9), y: 23, width: 1, height: 1 }),
]);

/**
 * Leaderboard phase 1: the placement stand, a scoreboard kiosk on its own
 * paved apron on the plaza's open east lawn, beside the shell-game table and
 * inside the plaza's camera frame (`PLAZA_NEARBY`). Two tiles wide, facing the
 * camera (south). Its approach ring (x 11-14, y 21-23) touches no other
 * station's, so E is never ambiguous.
 */
export const PLACEMENT_STAND: PlazaRect = Object.freeze({ x: at(12), y: 22, width: 2, height: 1 });
/** The stand's apron: plaza paving round the stand, so it reads as part of the square. */
export const PLACEMENT_APRON: PlazaRect = Object.freeze({ x: at(11), y: 21, width: 4, height: 3 });
/** The World's own prompt over the stand: "E · CHECK PLACEMENT". */
export const PLACEMENT_STAND_LABEL = 'CHECK PLACEMENT';

const PLACEMENT_STAND_STATION: PlazaStation = Object.freeze({
  station: PLAZA_PLACEMENT_STATION,
  label: PLACEMENT_STAND_LABEL,
  ...PLACEMENT_STAND,
});

/** What the Shell decides about the plaza when it composes the World. */
export interface PlazaOptions {
  /** Leaderboard phase 1: the placement stand. Only a real `true` builds it. */
  readonly placementStand?: boolean;
}

/** The stations E can use: the monument and the table, and the stand when it is built. */
export function plazaStations(options?: PlazaOptions): readonly PlazaStation[] {
  return options?.placementStand === true ? PLAZA_STATIONS_WITH_STAND : PLAZA_STATIONS;
}

const PLAZA_STATIONS_WITH_STAND: readonly PlazaStation[] = Object.freeze([...PLAZA_STATIONS, PLACEMENT_STAND_STATION]);

/** Pave the plaza and mark every fixture's tiles solid, in an existing grid. */
export function paintPlaza(tiles: TileKind[][], options?: PlazaOptions): void {
  fillTiles(tiles, PLAZA_AREA, 'plaza');
  for (const piece of PLAZA_FIXTURES) fillTiles(tiles, piece, 'plinth');
  if (options?.placementStand === true) {
    fillTiles(tiles, PLACEMENT_APRON, 'plaza');
    fillTiles(tiles, PLACEMENT_STAND, 'plinth');
  }
}

/** Whether the map was painted with the placement stand. */
export function hasPlacementStand(tiles: readonly (readonly TileKind[])[]): boolean {
  for (let y = PLACEMENT_STAND.y; y < PLACEMENT_STAND.y + PLACEMENT_STAND.height; y++) {
    for (let x = PLACEMENT_STAND.x; x < PLACEMENT_STAND.x + PLACEMENT_STAND.width; x++) {
      if (tiles[y]?.[x] !== 'plinth') return false;
    }
  }
  return true;
}

export function inPlazaRect(rect: PlazaRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** The station whose approach holds this street tile, or null. A station's own tiles are not its approach. */
export function plazaStationAtApproach(
  x: number,
  y: number,
  stations: readonly PlazaStation[] = PLAZA_STATIONS,
): PlazaStation | null {
  for (const station of stations) {
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
