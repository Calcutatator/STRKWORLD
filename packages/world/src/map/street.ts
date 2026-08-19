import { BUILDINGS, type BuildingId } from '@strkworld/shared';
import { flattenProperties, type TiledObject } from '../tiled-object-props.js';

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

/**
 * A non-interactive sign painted above a street facade.
 *
 * This is deliberately presentation-only. The text is authored world data,
 * not a wallet route or lobby field, and the coordinates are tile-space so a
 * renderer can place the sign without knowing anything about the building's
 * interaction state.
 */
export interface BuildingExteriorLabel {
  building: BuildingId;
  /** Placeholder name/function shown to help players read the test district. */
  text: string;
  /** Tile-space anchor, normally the centre of the building wall. */
  x: number;
  y: number;
}

/** The hidden, non-building Avatar Studio entrance at the south edge. */
export interface HiddenRoomEntrance {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DistrictMap {
  name: string;
  width: number;
  height: number;
  /** Row-major, `height` rows of `width` tile kinds. */
  tiles: TileKind[][];
  doors: DoorZone[];
  exteriorLabels: BuildingExteriorLabel[];
  avatarStudioEntrance: HiddenRoomEntrance;
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
  const plan: Array<{ building: BuildingId; x: number; locked: boolean; label: string }> = [
    { building: 'bank', x: 3, locked: false, label: 'BANK\nSHIELD / UNSHIELD' },
    { building: 'exchange', x: 12, locked: false, label: 'EXCHANGE\nSWAP' },
    { building: 'post-office', x: 21, locked: false, label: 'POST OFFICE\nTRANSFER' },
    { building: 'bridge', x: 30, locked: false, label: 'BRIDGE\nDEPOSIT' },
    { building: 'vault', x: 39, locked: true, label: 'VAULT\nCOMING SOON' },
  ];

  const buildingWidth = 7;
  const buildingHeight = 6;
  const buildingTop = 5;
  const facadeRow = buildingTop + buildingHeight - 1;
  const exteriorLabels: BuildingExteriorLabel[] = [];

  // Doors are authored as a Tiled-shaped OBJECT LAYER, not as hardcoded zones:
  // each object carries a raw `[{ name, type, value }]` property array with the
  // `building` id, exactly as Phaser hands an object layer through. Coordinates
  // are in pixels, Tiled's convention. `objectLayerToDoors` (below) flattens
  // and converts, so replacing this array with a real Tiled export is a swap of
  // the data source — the parsing path downstream is already the one under test.
  const doorObjects: TiledObject[] = [];

  for (const { building, x, locked, label } of plan) {
    fill(tiles, x, buildingTop, buildingWidth, buildingHeight - 1, 'wall');
    fill(tiles, x, facadeRow, buildingWidth, 1, 'facade');

    // The door is a gap in the facade, two tiles wide and centred.
    const doorX = x + Math.floor(buildingWidth / 2) - 1;

    // Carve the gap into the tile layer, not just the object layer. The facade
    // fill above covered the whole row as SOLID; without re-opening the door
    // columns the player collides with the facade one tile short of the trigger
    // row and `building:entered` never fires. The door tiles must be walkable
    // for the door to be reachable — a locked door stays reachable so it can
    // emit `building:locked`. (Reachability is asserted in street.test.ts.)
    fill(tiles, doorX, facadeRow, 2, 1, 'pavement');

    doorObjects.push({
      name: `door:${building}`,
      x: doorX * TILE_SIZE,
      y: facadeRow * TILE_SIZE,
      width: 2 * TILE_SIZE,
      height: 1 * TILE_SIZE,
      properties: [
        { name: 'building', type: 'string', value: building },
        { name: 'locked', type: 'bool', value: locked },
      ],
    });

    // A pavement approach so the door is reachable from the road.
    fill(tiles, doorX, facadeRow + 1, 2, buildingTop + buildingHeight - 4, 'pavement');

    exteriorLabels.push({
      building,
      text: label,
      x: x + buildingWidth / 2,
      y: buildingTop + 2,
    });
  }

  // The hidden Avatar Studio has no facade or BUILDINGS entry. It is reached
  // by a two-tile path that continues directly south from the spawn column to
  // the bottom edge, where the offscreen trigger lives.
  fill(tiles, 23, 17, 2, height - 17, 'pavement');

  return {
    name: 'street',
    width,
    height,
    tiles,
    doors: objectLayerToDoors(doorObjects, { width, height }),
    exteriorLabels,
    avatarStudioEntrance: { x: 23, y: height - 1, width: 2, height: 1 },
    spawn: { x: 24, y: 15 },
  };
}

/**
 * Convert a Tiled object layer into door zones.
 *
 * This is the seam a real Tiled export drops into unchanged: hand it
 * `map.getObjectLayer('doors').objects` and it produces the same `DoorZone[]`
 * the procedural map produces today. It flattens each object's raw property
 * array (see `flattenProperties` and the trap it documents), reads the
 * `building` id and optional `locked` flag, and converts Tiled's pixel rects to
 * tile coordinates.
 *
 * Fails CLOSED: an object with no `building` property, one naming a building
 * the shared registry does not know, malformed/off-grid rectangle geometry,
 * or geometry outside the explicit map bounds is not a door and is skipped. A
 * mistyped property or pixel coordinate yields no door rather than a rounded
 * trigger somewhere else.
 */
export function objectLayerToDoors(
  objects: TiledObject[],
  bounds: Pick<DistrictMap, 'width' | 'height'>,
): DoorZone[] {
  const doors: DoorZone[] = [];
  if (!isValidMapBounds(bounds)) return doors;

  for (const obj of objects) {
    const props = flattenProperties(obj.properties);
    const building = props['building'];
    if (typeof building !== 'string' || !BUILDINGS.includes(building as BuildingId)) {
      continue;
    }
    const geometry = normalizeDoorGeometry(obj);
    if (geometry === null) continue;
    if (
      geometry.x > bounds.width - geometry.width ||
      geometry.y > bounds.height - geometry.height
    ) {
      continue;
    }
    doors.push({
      building: building as BuildingId,
      ...geometry,
      locked: props['locked'] === true,
    });
  }
  return doors;
}

function isValidMapBounds(bounds: Pick<DistrictMap, 'width' | 'height'>): boolean {
  return (
    Number.isSafeInteger(bounds.width) &&
    Number.isSafeInteger(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function normalizeDoorGeometry(
  object: Pick<TiledObject, 'x' | 'y' | 'width' | 'height'>,
): Pick<DoorZone, 'x' | 'y' | 'width' | 'height'> | null {
  const geometry = {
    x: object.x / TILE_SIZE,
    y: object.y / TILE_SIZE,
    width: object.width / TILE_SIZE,
    height: object.height / TILE_SIZE,
  };
  const values = [geometry.x, geometry.y, geometry.width, geometry.height];
  if (!values.every(Number.isSafeInteger)) return null;
  if (geometry.x < 0 || geometry.y < 0 || geometry.width <= 0 || geometry.height <= 0) {
    return null;
  }
  return geometry;
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

/** Which bottom-edge tile enters the hidden Avatar Studio? */
export function isAvatarStudioEntrance(
  map: DistrictMap,
  tileX: number,
  tileY: number,
): boolean {
  const entrance = map.avatarStudioEntrance;
  return (
    tileX >= entrance.x &&
    tileX < entrance.x + entrance.width &&
    tileY >= entrance.y &&
    tileY < entrance.y + entrance.height
  );
}

/** Pixel centre of a tile. */
export function tileToWorld(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * TILE_SIZE + TILE_SIZE / 2, y: tileY * TILE_SIZE + TILE_SIZE / 2 };
}

/** Tile containing a pixel position. */
export function worldToTile(x: number, y: number): { x: number; y: number } {
  return { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) };
}
