import { STREET_ORIGIN_X, type BuildingId } from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The hidden stair (D-107), as data: a narrow service stair going down in the
 * alley between the Bank and the Exchange, across the road from the Privacy
 * Plaza, screened on its east side by a vending machine.
 *
 * Deliberately unmarked. No facade, no sign, no exterior label, no door
 * portal and no name anywhere a player can read it: the stair is found by
 * walking up to it, and its top step is a door like any other (`DoorZone`),
 * so entering and leaving reuse the fixed rooms' machinery. `bunker` is a
 * codename for code only.
 *
 * Like the plaza it is plain tile data: the map paints it (`paintBunker`),
 * collision reads the tiles, and the renderer (three/bunker-builder.ts)
 * stands every volume on a solid `service` tile. The stair's top step is
 * walkable (`stairhead`) and carries the door.
 */

export const BUNKER_BUILDING: BuildingId = 'bunker';

export interface BunkerRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Laid out from the street's first column, as the plaza is (D-078). */
const at = (x: number): number => STREET_ORIGIN_X + x;

/**
 * The alley the stair stands in: the two grass columns between the Bank
 * (street x 3-9) and the Exchange (x 12-18), rows 5-10, directly across the
 * road from the plaza's east edge (x 10).
 */
export const BUNKER_ALLEY: BunkerRect = Object.freeze({ x: at(10), y: 5, width: 2, height: 6 });

/** The stair's top step, at the alley's mouth on the north pavement: the door. */
export const BUNKER_DOOR: BunkerRect = Object.freeze({ x: at(10), y: 10, width: 1, height: 1 });

/** The flight down and the service door at its foot: a pit nobody walks into. */
export const BUNKER_STAIRWELL: BunkerRect = Object.freeze({ x: at(10), y: 9, width: 1, height: 1 });

/** The vending machine beside the stair, its back to the Exchange's west wall. */
export const BUNKER_VENDING: BunkerRect = Object.freeze({ x: at(11), y: 10, width: 1, height: 1 });

/** Every tile the stair changes: two tiles of stair and one of vending machine. */
export const BUNKER_TILES: readonly BunkerRect[] = Object.freeze([BUNKER_DOOR, BUNKER_STAIRWELL, BUNKER_VENDING]);

/** Paint the stair into an existing grid: the top step walkable, the rest solid. */
export function paintBunker(tiles: TileKind[][]): void {
  fillTiles(tiles, BUNKER_DOOR, 'stairhead');
  fillTiles(tiles, BUNKER_STAIRWELL, 'service');
  fillTiles(tiles, BUNKER_VENDING, 'service');
}

export function inBunkerRect(rect: BunkerRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function fillTiles(tiles: TileKind[][], rect: BunkerRect, kind: TileKind): void {
  for (let row = rect.y; row < rect.y + rect.height; row++) {
    for (let col = rect.x; col < rect.x + rect.width; col++) {
      if (tiles[row]?.[col] !== undefined) tiles[row]![col] = kind;
    }
  }
}
