import { BUILDINGS, SANDBOX_AREA, SANDBOX_ENTRANCE, STREET_ORIGIN_X, type BuildingId } from '@strkworld/shared';
import { flattenProperties, type TiledObject } from '../tiled-object-props.js';
import { ARENA_PIT_BUILDING, ARENA_PIT_DOOR, paintArenaPit } from './arena-pit.js';
import { BUNKER_BUILDING, BUNKER_DOOR, paintBunker } from './bunker.js';
import { paintPitch } from './pitch.js';
import { paintPlaza } from './plaza.js';

/**
 * The first district, as data.
 *
 * Deliberately plain data rather than renderer calls, for two reasons. It is
 * unit-testable without a browser, and it is the same shape a parsed Tiled map
 * produces — so replacing this with a real export is a swap, not a rewrite.
 *
 * Placeholder art is generated from these tile kinds at runtime. That is on
 * purpose: a walkable world exists today rather than after a licence audit, and
 * when real tiles arrive they drop into a scene that already works.
 */

export const TILE_SIZE = 32;

/** What a tile is. `solid` drives collision; nothing else here does. */
export type TileKind =
  | 'grass'
  | 'road'
  | 'pavement'
  | 'wall'
  | 'facade'
  | 'sandbox'
  | 'fence'
  | 'plaza'
  | 'plinth'
  | 'turf'
  | 'walkway'
  | 'footing'
  | 'railing'
  | 'stairhead'
  | 'service'
  | 'pitrim'
  | 'pitbowl'
  | 'pitstep';

export interface TileSpec {
  kind: TileKind;
  solid: boolean;
  /** Placeholder fill, replaced when real tiles land. */
  colour: number;
}

export const TILES: Readonly<Record<TileKind, Readonly<TileSpec>>> = Object.freeze({
  grass: Object.freeze({ kind: 'grass', solid: false, colour: 0x4a7c3f }),
  road: Object.freeze({ kind: 'road', solid: false, colour: 0x3d3d47 }),
  pavement: Object.freeze({ kind: 'pavement', solid: false, colour: 0x8a8a94 }),
  wall: Object.freeze({ kind: 'wall', solid: true, colour: 0x5a4a3f }),
  /** The front face of a building. Solid — you enter through the door. */
  facade: Object.freeze({ kind: 'facade', solid: true, colour: 0x6b5847 }),
  /**
   * The block sandbox floor (D-060). Walkable; the shared block stacks on it
   * add height, which the session reads from the sandbox channel, not here.
   */
  sandbox: Object.freeze({ kind: 'sandbox', solid: false, colour: 0xd9cdb8 }),
  /**
   * The low wall along the sandbox square's street side (D-060). Solid — you
   * come in through the gate, where the road runs through it.
   */
  fence: Object.freeze({ kind: 'fence', solid: true, colour: 0xb8a98f }),
  /** The Privacy Plaza's paving (D-076). Walkable, level with the pavement. */
  plaza: Object.freeze({ kind: 'plaza', solid: false, colour: 0xd4c6ab }),
  /**
   * Under a piece of plaza furniture: the monument, the shell-game table, a
   * bench, a lamp, a planter or a gateway post (D-076). Solid; the renderer
   * stands every plaza volume on these.
   */
  plinth: Object.freeze({ kind: 'plinth', solid: true, colour: 0xa89a82 }),
  /** The football pitch's field (D-078). Walkable: the ball is shared state on top of it. */
  turf: Object.freeze({ kind: 'turf', solid: false, colour: 0x5a9a48 }),
  /** The paved walkway round the field, inside the pitch square (D-078). Walkable. */
  walkway: Object.freeze({ kind: 'walkway', solid: false, colour: 0xcfc4b0 }),
  /**
   * Under a piece of pitch furniture: a stand, a bleacher, a floodlight or a
   * goal's net and posts (D-078). Solid; the renderer stands every pitch
   * volume on these.
   */
  footing: Object.freeze({ kind: 'footing', solid: true, colour: 0x9a948a }),
  /**
   * The pitch square's fence on its street side (D-078). Solid — you come in
   * through the gate, where the road runs through it.
   */
  railing: Object.freeze({ kind: 'railing', solid: true, colour: 0x8e959c }),
  /**
   * The hidden stair's top step, in the alley between the west lot (the
   * Bridge since D-110) and the Exchange (D-107). Walkable: it carries the
   * stair's door.
   */
  stairhead: Object.freeze({ kind: 'stairhead', solid: false, colour: 0x8f8a84 }),
  /**
   * Under the hidden stair's flight and the vending machine beside it
   * (D-107). Solid; the renderer stands both on these.
   */
  service: Object.freeze({ kind: 'service', solid: true, colour: 0x6f6a66 }),
  /**
   * The gladiator pit's rim (D-114): a low parapet of weathered blocks round
   * the sunken bowl, and the arch's gateposts. Solid; the renderer stands the
   * rim, the posts and the braziers on these.
   */
  pitrim: Object.freeze({ kind: 'pitrim', solid: true, colour: 0x8f8574 }),
  /**
   * The gladiator pit's sunken bowl (D-114). Solid: nobody walks down into
   * it, the arch's door takes them into the arena. The street ground skips
   * these tiles and the pit builder draws the bowl below the lawn.
   */
  pitbowl: Object.freeze({ kind: 'pitbowl', solid: true, colour: 0xcdb38a }),
  /**
   * The gladiator pit's threshold under its arch (D-114), at pavement
   * height. Walkable: it carries the arena's door.
   */
  pitstep: Object.freeze({ kind: 'pitstep', solid: false, colour: 0x9d9384 }),
});

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
  /**
   * Locked doors emit `building:locked` and never open. The Vault, unless the
   * Shell opens it (D-077).
   */
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

/** What the Shell decides about the street when it composes the World. */
export interface StreetMapOptions {
  /**
   * The Vault opens on shadow accounts, behind the Shell's switch (D-077).
   * Absent or false, it is D-007's locked facade.
   */
  readonly vaultOpen?: boolean;
  /**
   * Leaderboard phase 1: the placement stand east of the plaza, behind the
   * Shell's switch. Absent or false, the lawn is as it always was.
   */
  readonly placementStand?: boolean;
}

/**
 * The starting street.
 *
 * A horizontal road with pavement either side, five buildings along the north
 * edge. Four are always enterable; the Vault is a visible facade with a
 * locked door, so the world reads as complete while v1 ships without it
 * (D-007), until the Shell opens it (D-077): then its door is as open as the
 * others and its sign names its counter. Nothing else changes. The road ends
 * in the block sandbox square (D-060) at its east end and in the football
 * pitch square (D-078) at its west end, and the Privacy Plaza sits below the
 * street's west end, beside the pitch (D-076).
 *
 * Every street tile is laid out from `STREET_ORIGIN_X`, the column past the
 * pitch square's fence: the pitch came last, and the street moved east to
 * make room for it rather than the map growing a negative-x region, so the
 * grid stays a zero-based array and every seam that reads it is unchanged.
 */
export function createStreetMap(options?: StreetMapOptions): DistrictMap {
  // Fails closed: only a real `true` opens the Vault.
  const vaultOpen = options?.vaultOpen === true;
  // D-078: the street's own columns count from here.
  const X = STREET_ORIGIN_X;
  // The original street is 48 tiles wide; the road then runs on into the block
  // sandbox square at its east end (D-060), and the pitch square lies west of
  // it (D-078).
  const width = SANDBOX_AREA.x + SANDBOX_AREA.width;
  const height = 28;

  const tiles: TileKind[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 'grass' as TileKind),
  );

  // The road runs east-west through the middle, pavement on both sides.
  fill(tiles, 0, 13, width, 4, 'road');
  fill(tiles, 0, 11, width, 2, 'pavement');
  fill(tiles, 0, 17, width, 2, 'pavement');

  // Five buildings along the north side, evenly spaced, on five equal lots.
  // The Bridge stands on the west lot and the Bank on the fourth (D-110); a
  // building's look, door and room go with it wherever its lot is.
  const plan: Array<{ building: BuildingId; x: number; locked: boolean; label: string }> = [
    { building: 'bridge', x: X + 3, locked: false, label: 'BRIDGE\nDEPOSIT' },
    { building: 'exchange', x: X + 12, locked: false, label: 'EXCHANGE\nSWAP' },
    { building: 'post-office', x: X + 21, locked: false, label: 'POST OFFICE\nTRANSFER' },
    { building: 'bank', x: X + 30, locked: false, label: 'BANK\nSHIELD / UNSHIELD' },
    vaultOpen
      ? { building: 'vault', x: X + 39, locked: false, label: 'VAULT\nSUPPLY / REDEEM' }
      : { building: 'vault', x: X + 39, locked: true, label: 'VAULT\nCOMING SOON' },
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
  fill(tiles, X + 23, 17, 2, height - 17, 'pavement');

  // The Privacy Plaza (D-076): a paved square below the south pavement at the
  // street's west end, clear of the Studio path and the spawn (see plaza.ts).
  paintPlaza(tiles, { placementStand: options?.placementStand === true });

  // The hidden stair (D-107): two tiles of stair and a vending machine in the
  // alley mouth between the west lot (the Bridge, D-110) and the Exchange,
  // across from the plaza.
  // Unmarked: no facade, no sign, no label (see bunker.ts).
  paintBunker(tiles);

  // The gladiator pit (D-114): a sunken stone bowl on the south lawn just
  // east of the Studio's path, its arch on its west front and a short stone
  // path branching east off the Studio's path to it (see arena-pit.ts).
  paintArenaPit(tiles);

  // The football pitch square where the road begins (D-078): its walkway,
  // field and furniture, and the fence on its street side with a gate where
  // the road and both pavements run in (see pitch.ts).
  paintPitch(tiles);

  // The block sandbox square where the road ends (D-060). Its floor is plain
  // walkable ground; block stacks are shared state layered on top of it.
  fill(tiles, SANDBOX_AREA.x, SANDBOX_AREA.y, SANDBOX_AREA.width, SANDBOX_AREA.height, 'sandbox');

  // A wall closes the square's street side, one tile west of it, except for
  // the gate: the gap where the road and both pavements run in, in line with
  // the entrance apron that sky drops keep clear of.
  const gateTop = SANDBOX_ENTRANCE.y;
  const gateBottom = SANDBOX_ENTRANCE.y + SANDBOX_ENTRANCE.height;
  fill(tiles, SANDBOX_AREA.x - 1, SANDBOX_AREA.y, 1, gateTop - SANDBOX_AREA.y, 'fence');
  fill(tiles, SANDBOX_AREA.x - 1, gateBottom, 1, SANDBOX_AREA.y + SANDBOX_AREA.height - gateBottom, 'fence');

  return {
    name: 'street',
    width,
    height,
    tiles,
    // The hidden stair's top step is a door like the others, so entering and
    // leaving reuse the rooms' machinery; it is added here rather than in the
    // Tiled layer, whose loader admits only `BUILDINGS` (D-107). So is the
    // gladiator pit's arch (D-114).
    doors: [
      ...objectLayerToDoors(doorObjects, { width, height }),
      { building: BUNKER_BUILDING, ...BUNKER_DOOR, locked: false },
      // The pit's arch (D-114), likewise a codename building outside `BUILDINGS`.
      { building: ARENA_PIT_BUILDING, ...ARENA_PIT_DOOR, locked: false },
    ],
    exteriorLabels,
    avatarStudioEntrance: { x: X + 23, y: height - 1, width: 2, height: 1 },
    spawn: { x: X + 24, y: 15 },
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
  if (!Array.isArray(objects)) return doors;
  if (!isValidMapBounds(bounds)) return doors;

  for (const obj of objects) {
    if (obj === null || typeof obj !== 'object') continue;
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
  // Geometry is decoded from an untrusted parsed object. Require own data
  // fields so a prototype or accessor cannot manufacture a door rectangle.
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
  }
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

/**
 * The column whose road and pavements run on west, past the map's edge: the
 * west edge itself on a street that runs off the map there, or — with the
 * pitch square at that end (D-078), which the road enters through a gate —
 * the first column that carries road. Past the square the backdrop carries
 * that road on west, closed by the barrier where the square interrupts it.
 * -1 on a map without road.
 */
export function westRoadColumn(map: DistrictMap): number {
  for (let x = 0; x < map.width; x++) {
    if (map.tiles.some((row) => row[x] === 'road')) return x;
  }
  return -1;
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
