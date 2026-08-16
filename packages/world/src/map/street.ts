import type { BuildingId } from '@strkworld/shared';

/**
 * The first district, as data.
 *
 * Deliberately plain data rather than Phaser calls, for two reasons. It is
 * unit-testable without a browser, and it is the same shape a parsed Tiled map
 * produces — so replacing this with a real export is a swap, not a rewrite.
 *
 * Placeholder art is generated from these tile kinds at runtime. That is on
 * purpose: a walkable world exists today rather than after a licence audit, and
 * when real tiles arrive they drop into a scene that already works.
 */

export const TILE_SIZE = 32;

/** What a tile is. `solid` drives collision; nothing else here does. */
export type TileKind = 'grass' | 'road' | 'pavement' | 'wall' | 'facade';

export interface TileSpec {
  kind: TileKind;
  solid: boolean;
  /** Placeholder fill, replaced when real tiles land. */
  colour: number;
}

export const TILES: Record<TileKind, TileSpec> = {
  grass: { kind: 'grass', solid: false, colour: 0x4a7c3f },
  road: { kind: 'road', solid: false, colour: 0x3d3d47 },
  pavement: { kind: 'pavement', solid: false, colour: 0x8a8a94 },
  wall: { kind: 'wall', solid: true, colour: 0x5a4a3f },
  /** The front face of a building. Solid — you enter through the door. */
  facade: { kind: 'facade', solid: true, colour: 0x6b5847 },
};

/**
 * A door, as a trigger zone in tile coordinates.
 *
 * Mirrors a Tiled object-layer entry: a rectangle carrying a `building`
 * property. Keeping the shape identical means the Tiled import replaces the
 * source of this array and nothing downstream changes.
 */
export interface DoorZone {
  building: BuildingId;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Locked doors emit `building:locked` and never open. The Vault, in v1. */
  locked: boolean;
}

export interface DistrictMap {
  name: string;
  width: number;
  height: number;
  /** Row-major, `height` rows of `width` tile kinds. */
  tiles: TileKind[][];
  doors: DoorZone[];
  spawn: { x: number; y: number };
}

/** Build a rectangular block of one kind into an existing grid. */
function fill(
  tiles: TileKind[][],
  x: number,
  y: number,
  w: number,
  h: number,
  kind: TileKind,
): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      if (tiles[row]?.[col] !== undefined) tiles[row]![col] = kind;
    }
  }
}

/**
 * The starting street.
 *
 * A horizontal road with pavement either side, five buildings along the north
 * edge. Four are enterable; the Vault is a visible facade with a locked door,
 * so the world reads as complete while v1 ships without it (D-007).
 */
export function createStreetMap(): DistrictMap {
  const width = 48;
  const height = 28;

  const tiles: TileKind[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 'grass' as TileKind),
  );

  // The road runs east-west through the middle, pavement on both sides.
  fill(tiles, 0, 13, width, 4, 'road');
  fill(tiles, 0, 11, width, 2, 'pavement');
  fill(tiles, 0, 17, width, 2, 'pavement');

  // Five buildings along the north side, evenly spaced.
  const plan: Array<{ building: BuildingId; x: number; locked: boolean }> = [
    { building: 'bank', x: 3, locked: false },
    { building: 'exchange', x: 12, locked: false },
    { building: 'post-office', x: 21, locked: false },
    { building: 'bridge', x: 30, locked: false },
    { building: 'vault', x: 39, locked: true },
  ];

  const doors: DoorZone[] = [];
  const buildingWidth = 7;
  const buildingHeight = 6;
  const buildingTop = 5;
  const facadeRow = buildingTop + buildingHeight - 1;

  for (const { building, x, locked } of plan) {
    fill(tiles, x, buildingTop, buildingWidth, buildingHeight - 1, 'wall');
    fill(tiles, x, facadeRow, buildingWidth, 1, 'facade');

    // The door is a gap in the facade, two tiles wide and centred.
    const doorX = x + Math.floor(buildingWidth / 2) - 1;
    doors.push({
      building,
      x: doorX,
      y: facadeRow,
      width: 2,
      height: 1,
      locked,
    });

    // A pavement approach so the door is reachable from the road.
    fill(tiles, doorX, facadeRow + 1, 2, buildingTop + buildingHeight - 4, 'pavement');
  }

  return {
    name: 'street',
    width,
    height,
    tiles,
    doors,
    spawn: { x: 24, y: 15 },
  };
}

/** Is this tile coordinate blocked? Out of bounds counts as blocked. */
export function isSolidAt(map: DistrictMap, tileX: number, tileY: number): boolean {
  const kind = map.tiles[tileY]?.[tileX];
  if (kind === undefined) return true;
  return TILES[kind].solid;
}

/**
 * Which door, if any, contains this tile coordinate.
 *
 * Returns the zone rather than a boolean so callers can distinguish a locked
 * door from an open one — a locked door is a designed state with its own copy,
 * not a failure.
 */
export function doorAt(map: DistrictMap, tileX: number, tileY: number): DoorZone | null {
  for (const door of map.doors) {
    if (
      tileX >= door.x &&
      tileX < door.x + door.width &&
      tileY >= door.y &&
      tileY < door.y + door.height
    ) {
      return door;
    }
  }
  return null;
}

/** Pixel centre of a tile. */
export function tileToWorld(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * TILE_SIZE + TILE_SIZE / 2, y: tileY * TILE_SIZE + TILE_SIZE / 2 };
}

/** Tile containing a pixel position. */
export function worldToTile(x: number, y: number): { x: number; y: number } {
  return { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) };
}
