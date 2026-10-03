import {
  Box3,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Vector3,
  Color,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { SANDBOX_ENTRANCE, type BuildingId } from '@strkworld/shared';
import {
  isSolidAt,
  westRoadColumn,
  type BuildingExteriorLabel,
  type DistrictMap,
  type DoorZone,
  type TileKind,
} from '../map/street.js';
import {
  EXCHANGE_TICKER,
  GeometryBin,
  PALETTE,
  PITCH_THEME,
  ResourceBag,
  SANDBOX_THEME,
  AVNU,
  NEAR,
  STRK20,
  VESU,
  addVesuMark,
  aoPaint,
  beamGeometry,
  boxGeometry,
  buildingTheme,
  clamp01,
  coneGeometry,
  createOpacityFader,
  createTickerStrip,
  cylinderGeometry,
  faceBox,
  faceDisc,
  facePanel,
  facePipe,
  faceQuad,
  faceTorus,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  lift,
  liftLabelText,
  mixColor,
  pick,
  prismX,
  prismY,
  prismZ,
  roomTheme,
  shade,
  sphereGeometry,
  stadiumPoints,
  standardMaterial,
  unlitMaterial,
  valueNoise,
  type BuildingTheme,
  type Face,
  type Paint,
  type Vec3,
} from './palette.js';
import type { FloatingStyleOptions, SignStyleOptions } from './labels.js';
import {
  FIXED_ROOM_LEVELS,
  createFixedRoomLevel,
  type FixedRoomLevelId,
  type FixedRoomLevelMap,
} from '../fixed-room.js';
import { CITY_FRONT, HINTERLAND, OUTSKIRT, RIM_SETBACK, backdropCity, backdropTrees, hills, layHinterland } from './backdrop.js';
import { bevelledBlockGeometry } from './sandbox-view.js';
import { buildRoofSwing, type RoofSwingView } from './roof-swing.js';
import { buildPitch, type PitchOccluder } from './pitch-builder.js';
import { buildPlaza, type PlazaOccluder } from './plaza-builder.js';
import { buildBunkerEntrance } from './bunker-builder.js';
import { buildColosseum, type ColosseumOccluder } from './colosseum-builder.js';
import { SOUTH_SHORE_Z, createSouthVista } from './south-vista.js';
import { createSkyIsland, rockSpanAtZ } from './sky-island.js';
import { BUNKER_BUILDING } from '../map/bunker.js';
import { COLOSSEUM_BUILDING } from '../map/colosseum.js';
import type { LabelFactory, Occluder, OccluderBounds, PitchView, PlazaView, StreetView, TextLabel } from './types.js';

/** The sandbox square's sign: behind the north hedge, facing the street (D-060). */
export const SANDBOX_SIGN_TEXT = 'SANDBOX\nPICK UP \u00b7 STACK \u00b7 BUILD';

/** The board on the gate's lintel, facing the street as you walk in (D-060). */
export const SANDBOX_GATE_TEXT = 'SANDBOX';

/** A roof's lift label wears the same type as the building's rooms' labels. */
const ROOF_LIFT_LABEL: FloatingStyleOptions = roomTheme('exchange').label;

/**
 * The district as a low-poly golden-hour street (D-059).
 *
 * Presentation only: collision stays tile-based in the session, so nothing
 * here may put a volume where the player can walk. Volumes live on solid
 * tiles or outside the map; inside walkable bounds there are only flat
 * things — paint, paving, flowers, light pools — and what hangs above head
 * height. Buildings are derived from connected wall and facade tiles, so the
 * street follows the map, not a copy of it. The road runs through a toy-block
 * gate in the sandbox square's wall onto its build plate (D-060); the blocks
 * players stack are a separate view (sandbox-view.ts) layered on top.
 */

/** Height of raised pavement; `streetSurfaceHeightAt` reports it per tile. */
export const PAVEMENT_HEIGHT = 0.08;
const KERB_HEIGHT = 0.1;
const KERB_WIDTH = 0.12;
/** Doors sit this far behind the facade row's north edge, in the solid wall row. */
const DOOR_RECESS = 0.2;
/** Walls sit inside the footprint so cornices and sills stay on solid tiles. */
const SIDE_INSET = 0.1;
const JAMB = 0.12;
/**
 * The sandbox wall, in the toy blocks players stack (D-060). Two high reads
 * as the wall it is: the step rule makes any stack two or more above you
 * unclimbable.
 */
const WALL_BLOCKS = 2;
/**
 * The gate's pillars, in blocks. The lintel rests on them, so its underside
 * is this high: clear of a tall avatar (2.05) holding a block overhead.
 */
const PILLAR_BLOCKS = 4;
/** Same chamfer as the sandbox's own blocks (sandbox-view.ts). */
const TOY_BEVEL = 0.07;

const BODY = 'body';
const GLASS = 'glass';
const LIT = 'lit';
const GLOW = 'glow';
const BEACON = 'beacon';
/** Additive washes of light on a facade (the Bridge's aurora); RGBA paint. */
const AURA = 'aura';
/** Self-lit vertex colour, untouched by the light (the Vault's Vesu mark). */
const MARK = 'mark';

type Animator = (elapsedMs: number) => void;

/**
 * A street occluder, naming what it fades: a building, the sandbox gate, a
 * Privacy Plaza piece (D-076), the pitch gate (D-078) or the gladiator
 * pit's arch (D-114).
 */
export type StreetOccluder = BuildingOccluder | GateOccluder | PlazaOccluder | PitchOccluder | ColosseumOccluder;

/** A street occluder that also names the building it fades. */
export interface BuildingOccluder extends Occluder {
  readonly kind: 'building';
  readonly building: BuildingId | null;
  readonly object: Object3D;
}

/**
 * The sandbox gate's superstructure (D-060): the pillar blocks above the
 * wall, the lintel and its caps, which fade like a building when they hide
 * the player. Not a building; the two-high wall below is decor and never
 * fades.
 */
export interface GateOccluder extends Occluder {
  readonly kind: 'sandbox-gate';
  readonly object: Object3D;
}

/**
 * Walking-surface height of a street tile: raised pavement is
 * `PAVEMENT_HEIGHT`, everything else 0. Lets a presenter lift the avatar's
 * feet onto the kerb instead of sinking them into it.
 */
export function streetSurfaceHeightAt(map: DistrictMap, tileX: number, tileY: number): number {
  const kind = classifyTile(map, Math.floor(tileX), Math.floor(tileY));
  // The Privacy Plaza's paving is level with the pavement (D-076), and so is
  // the hidden stair's top step (D-107).
  if (kind === 'bunker') return map.tiles[Math.floor(tileY)]?.[Math.floor(tileX)] === 'stairhead' ? PAVEMENT_HEIGHT : 0;
  // The gladiator pit's threshold too (D-114); its rim and bowl are solid.
  if (kind === 'colosseum') return map.tiles[Math.floor(tileY)]?.[Math.floor(tileX)] === 'colstep' ? PAVEMENT_HEIGHT : 0;
  return kind === 'sidewalk' || kind === 'plaza' ? PAVEMENT_HEIGHT : 0;
}

/** What the street reads from its host beyond the map and labels. */
export interface StreetBuildOptions {
  /** Reduced motion: the pit's braziers flicker slowly (D-114). Never off either way. */
  readonly reducedMotion?: () => boolean;
  /**
   * Scenery detail. `'low'` thins the sky island and the south vista for
   * phones; the playable map, the buildings and the interiors are the same
   * either way. Default `'high'`.
   */
  readonly quality?: 'low' | 'high';
}

export function buildStreet(map: DistrictMap, labels: LabelFactory, options: StreetBuildOptions = {}): StreetView {
  const res = new ResourceBag();
  const ground = new Group();
  ground.name = 'street:ground';
  const doors = new Group();
  doors.name = 'street:doors';
  const signs = new Group();
  signs.name = 'street:labels';
  // D-135: moving bodies the street owns — the pitch's dummies. Their own
  // group, because `ground` is the static scene and must stand clear of every
  // walkable tile, while these walk the field as a player does.
  const figures = new Group();
  figures.name = 'street:figures';
  const textLabels: TextLabel[] = [];
  const animators: Animator[] = [];
  const occluders: StreetOccluder[] = [];
  let plaza: PlazaView | null = null;
  let pitch: PitchView | null = null;
  /** D-133: the Exchange roof's lookout swing, from whichever building has one. */
  let swing: RoofSwingView | null = null;

  try {
    const kinds = classifyGround(map);
    buildGround(map, kinds, res, ground);

    const footprints = findFootprints(map);
    const built = new Map<Footprint, BuiltBuilding>();
    for (const footprint of footprints) {
      const building = buildBuilding(footprint, res);
      built.set(footprint, building);
      ground.add(building.group);
      occluders.push(building.occluder);
      animators.push(building.animate);
      if (building.swing) swing = building.swing;
    }

    for (const door of map.doors) {
      // The hidden stair has no portal: nothing marks it (D-107). The
      // gladiator pit's door is its own arch (D-114).
      if (door.building === BUNKER_BUILDING || door.building === COLOSSEUM_BUILDING) continue;
      const footprint = footprints.find((candidate) => doorInside(candidate, door));
      const portal = buildDoorPortal(door, footprint ? built.get(footprint) : undefined, res);
      doors.add(portal.group);
      animators.push(portal.animate);
    }

    for (const exterior of map.exteriorLabels) {
      const footprint = footprints.find((candidate) => labelInside(candidate, exterior));
      const placement = footprint ? built.get(footprint)?.sign : undefined;
      // The theme's full style, as a typed value: factories that understand
      // gradients and type treatments use them; others read the base options.
      const style: SignStyleOptions = buildingTheme(exterior.building).sign;
      const label = labels.sign(exterior.text, style);
      textLabels.push(label);
      const position = placement ?? { x: exterior.x, y: 3, z: exterior.y + 0.5 };
      label.object.position.set(position.x, position.y, position.z);
      label.object.userData['building'] = exterior.building;
      signs.add(label.object);
    }

    // Each protocol's name on its building, in its own type (not its mark).
    for (const footprint of footprints) {
      const placement = built.get(footprint)?.brand;
      const brand = buildingTheme(footprint.building).brand;
      if (!placement || !brand) continue;
      const label = labels.sign(brand.text, brand.style);
      textLabels.push(label);
      label.object.position.set(placement.x, placement.y, placement.z);
      label.object.userData['brand'] = footprint.building;
      signs.add(label.object);
    }

    // A walkable roof's lift pads, labelled like the ones indoors.
    for (const footprint of footprints) {
      for (const lift of built.get(footprint)?.lifts ?? []) {
        const style: FloatingStyleOptions = { lineHeight: 0.26, ...ROOF_LIFT_LABEL };
        const label = labels.floating(liftLabelText(lift.from, lift.to), style);
        textLabels.push(label);
        label.object.position.set(lift.x, lift.y, lift.z);
        label.object.userData['lift'] = lift.to;
        label.object.userData['building'] = footprint.building;
        signs.add(label.object);
      }
    }

    const sandboxSign = sandboxSignPlacement(kinds);
    if (sandboxSign) {
      const style: SignStyleOptions = SANDBOX_THEME.sign;
      const label = labels.sign(SANDBOX_SIGN_TEXT, style);
      textLabels.push(label);
      label.object.position.set(sandboxSign.x, sandboxSign.y, sandboxSign.z);
      label.object.userData['area'] = 'sandbox';
      signs.add(label.object);
    }

    const gate = findGate(map);
    if (gate) {
      const label = labels.sign(SANDBOX_GATE_TEXT, GATE_SIGN_STYLE);
      textLabels.push(label);
      const placement = gateSignPlacement(gate);
      label.object.position.set(placement.x, placement.y, placement.z);
      // A sign faces +Z at rotation 0; this turns it to face -X, the street.
      label.object.rotation.y = -Math.PI / 2;
      label.object.userData['area'] = 'sandbox-gate';
      signs.add(label.object);
    }

    const gateOccluder = buildDecor(map, kinds, res, ground, animators, sandboxSign, gate);
    if (gateOccluder) occluders.push(gateOccluder);

    // The Privacy Plaza (D-076), in its own module: paving, furniture, the
    // monument and its signs, merged into the street's groups and budget.
    const plazaOccluders: PlazaOccluder[] = [];
    plaza = buildPlaza(map, labels, res, {
      ground,
      labels: signs,
      textLabels,
      animators,
      occluders: plazaOccluders,
      floorHeight: PAVEMENT_HEIGHT,
    });
    occluders.push(...plazaOccluders);

    // The hidden stair (D-107), in its own module: the cut, the door ajar at
    // its foot, the vending machine and the cat, merged into the street's
    // ground. No label and no sign: nothing here names it.
    buildBunkerEntrance(map, res, { ground, animators, floorHeight: PAVEMENT_HEIGHT });

    // The Colosseum (D-114, D-129), in its own module: the stacked arcades,
    // the attic with its banners and cressets, the grand arch on the west
    // front and the nameplate, merged into the street's groups. The building
    // fades like any other when it stands between the camera and the player.
    const colosseumOccluders: ColosseumOccluder[] = [];
    buildColosseum(map, labels, res, {
      ground,
      labels: signs,
      textLabels,
      animators,
      occluders: colosseumOccluders,
      floorHeight: PAVEMENT_HEIGHT,
      ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
    });
    occluders.push(...colosseumOccluders);

    // The football pitch (D-078), likewise in its own module and merged into
    // the street's groups: its field, stands, goals, fence and scoreboard.
    const pitchOccluders: PitchOccluder[] = [];
    pitch = buildPitch(map, labels, res, {
      ground,
      figures,
      labels: signs,
      textLabels,
      animators,
      occluders: pitchOccluders,
    });
    occluders.push(...pitchOccluders);

    // The south vista (D-124): the river past the map's south edge, the
    // station across it and the city behind, in its own module so the
    // Exchange roof's swing can mount the same thing. It goes into the
    // street's ground group, which means it hides with the street indoors and
    // stays drawn on the roof — the roof is the building's top in the street
    // scene, not a room of its own (presenter.ts). Nothing of it is walkable,
    // it casts and receives no shadow, and it stands entirely south of the
    // map, so no camera that looks north ever sees it.
    const quality = options.quality ?? 'high';
    // Read once: both are built once, and their only motion is a glitter on
    // the water, two boats that take minutes to cross, and the falls.
    const still = options.reducedMotion?.() === true;
    const vista = createSouthVista({ quality, reducedMotion: still });
    ground.add(vista.group);
    animators.push((elapsed) => vista.update(elapsed));
    res.disposable(vista);

    // The sky island (D-132): the rock all of it stands on, the cloud sea
    // round it and the falls where the river goes over the rim. Same group,
    // for the same reasons as the vista, and laid out around the map rather
    // than on it, so nothing playable moves.
    const island = createSkyIsland({ quality, reducedMotion: still });
    ground.add(island.group);
    animators.push((elapsed) => island.update(elapsed));
    res.disposable(island);
  } catch (error) {
    for (const label of textLabels) {
      try {
        label.dispose();
      } catch {
        // The construction error stays authoritative.
      }
    }
    res.dispose();
    throw error;
  }

  let elapsed = 0;
  let disposed = false;
  return {
    ground,
    doors,
    labels: signs,
    figures,
    occluders,
    plaza,
    pitch,
    swing,
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      for (const animate of animators) animate(elapsed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const label of textLabels) {
        try {
          label.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      textLabels.length = 0;
      for (const group of [ground, doors, signs]) {
        group.removeFromParent();
        group.clear();
      }
      res.dispose();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Street disposal failed');
    },
  };
}

// ---------------------------------------------------------------------------
// Tile classification
// ---------------------------------------------------------------------------

/**
 * What the ground looks like, which the tile kind alone does not say: a
 * pavement strip crossing the road is a zebra crossing at road level, a
 * pavement run through grass is a garden path, road or pavement meeting the
 * sandbox plate or the pitch square's walkway is its gate's stone threshold
 * at road level, the rest is raised kerbed pavement. The pitch square's own
 * tiles are laid by pitch-builder.ts (D-078), as the plaza's are by
 * plaza-builder.ts.
 */
type GroundKind = 'grass' | 'road' | 'sidewalk' | 'crossing' | 'path' | 'plate' | 'threshold' | 'solid' | 'plaza' | 'pitch' | 'bunker' | 'colosseum';

function kindAt(map: DistrictMap, x: number, y: number): TileKind | undefined {
  return map.tiles[y]?.[x];
}

function classifyGround(map: DistrictMap): GroundKind[][] {
  const rows: GroundKind[][] = [];
  for (let y = 0; y < map.height; y++) {
    const row: GroundKind[] = [];
    for (let x = 0; x < map.width; x++) row.push(classifyTile(map, x, y));
    rows.push(row);
  }
  return rows;
}

function classifyTile(map: DistrictMap, x: number, y: number): GroundKind {
  const kind = kindAt(map, x, y);
  // The Privacy Plaza paves its own tiles, furniture footings included (D-076).
  if (kind === 'plaza' || kind === 'plinth') return 'plaza';
  // So does the pitch square, its field, walkway and footings (D-078).
  if (kind === 'turf' || kind === 'walkway' || kind === 'footing') return 'pitch';
  // And the hidden stair, its cut and the vending machine's pad (D-107).
  if (kind === 'stairhead' || kind === 'service') return 'bunker';
  // And the Colosseum, its wall, its core and its threshold (D-114, D-129).
  if (kind === 'colwall' || kind === 'colcore' || kind === 'colstep') return 'colosseum';
  if (kind === undefined || isSolidAt(map, x, y)) return 'solid';
  if (kind === 'sandbox') return 'plate';
  if ((kind === 'road' || kind === 'pavement') && touchesPlate(map, x, y)) return 'threshold';
  if (kind === 'road') return 'road';
  if (kind !== 'pavement') return 'grass';
  const [west, east] = runEnds(map, x, y, 1, 0);
  const [north, south] = runEnds(map, x, y, 0, 1);
  if ((west === 'road' && east === 'road') || (north === 'road' && south === 'road')) return 'crossing';
  // A path is a pavement run laid across the lawn. The Colosseum's threshold
  // (D-114) counts as a lawn end: the branch to its west arch runs from the
  // Studio's path to the arch, over grass the whole way, so it is a flush path
  // and not a kerbed sidewalk — and it must not raise the Studio's path it leaves.
  if ((isLawnEnd(west) && isLawnEnd(east)) || (isLawnEnd(north) && isLawnEnd(south))) return 'path';
  return 'sidewalk';
}

/** Where a path across the lawn ends: the lawn itself, or the Colosseum's threshold (D-114). */
function isLawnEnd(kind: TileKind | undefined): boolean {
  return kind === 'grass' || kind === 'colstep';
}

/**
 * Whether a tile borders the sandbox floor or the pitch square's walkway
 * (D-078): where the street reaches one of its two squares.
 */
function touchesPlate(map: DistrictMap, x: number, y: number): boolean {
  const square = (kind: TileKind | undefined): boolean => kind === 'sandbox' || kind === 'walkway';
  return (
    square(kindAt(map, x + 1, y)) ||
    square(kindAt(map, x - 1, y)) ||
    square(kindAt(map, x, y + 1)) ||
    square(kindAt(map, x, y - 1))
  );
}

/** The tile kinds just past both ends of the pavement run through (x, y). */
function runEnds(
  map: DistrictMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
): [TileKind | undefined, TileKind | undefined] {
  let ax = x;
  let ay = y;
  while (kindAt(map, ax, ay) === 'pavement') {
    ax -= dx;
    ay -= dy;
  }
  let bx = x;
  let by = y;
  while (kindAt(map, bx, by) === 'pavement') {
    bx += dx;
    by += dy;
  }
  return [kindAt(map, ax, ay), kindAt(map, bx, by)];
}

interface Span {
  readonly x0: number;
  readonly x1: number;
}

/** Rows that are mostly road, grouped into east-west bands. */
function roadBands(map: DistrictMap, kinds: GroundKind[][]): { r0: number; r1: number }[] {
  const bands: { r0: number; r1: number }[] = [];
  let start = -1;
  for (let y = 0; y <= map.height; y++) {
    const row = kinds[y];
    const roadCount = row ? row.filter((kind) => kind === 'road' || kind === 'crossing').length : 0;
    const isRoad = row !== undefined && roadCount >= Math.min(8, map.width / 2);
    if (isRoad && start < 0) start = y;
    if (!isRoad && start >= 0) {
      bands.push({ r0: start, r1: y - 1 });
      start = -1;
    }
  }
  return bands;
}

function crossingRuns(kinds: GroundKind[][], band: { r0: number; r1: number }, width: number): Span[] {
  const runs: Span[] = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    let crossing = false;
    for (let y = band.r0; y <= band.r1 && x < width; y++) {
      if (kinds[y]?.[x] === 'crossing') crossing = true;
    }
    if (crossing && start < 0) start = x;
    if (!crossing && start >= 0) {
      runs.push({ x0: start, x1: x });
      start = -1;
    }
  }
  return runs;
}

/** The x-range [x0, x1) a road band's road and crossing tiles cover. */
function roadExtent(kinds: GroundKind[][], band: { r0: number; r1: number }, width: number): Span {
  let x0 = width;
  let x1 = 0;
  for (let y = band.r0; y <= band.r1; y++) {
    const row = kinds[y];
    if (!row) continue;
    row.forEach((kind, x) => {
      if (kind !== 'road' && kind !== 'crossing') return;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x + 1);
    });
  }
  return x1 > x0 ? { x0, x1 } : { x0: 0, x1: 0 };
}

/**
 * Rows whose tile on one map edge is road or pavement: where the street runs
 * off the map on that side. The east end now runs into the sandbox instead.
 * The west end runs into the pitch square (D-078), and the road runs on west
 * past it: its rows are those the square's gate lets in (`westRunoff`).
 */
function edgeBand(map: DistrictMap, kinds: GroundKind[][], side: 'west' | 'east'): { top: number; bottom: number } | null {
  const edgeX = map.width - 1;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < map.height; y++) {
    const kind = side === 'west' ? westRunoff(map, y) : kinds[y]?.[edgeX];
    if (kind === 'road' || kind === 'sidewalk' || kind === 'crossing') {
      if (top < 0) top = y;
      bottom = y + 1;
    }
  }
  return top < 0 ? null : { top, bottom };
}

/**
 * What runs off the map's west edge on row `y`: road, pavement or nothing.
 * Read at `westRoadColumn`, which is the west edge itself where the street
 * runs off the map, and the pitch square's gate where the square takes the
 * road's west end (D-078): past the square the road carries on west as it
 * did past the map before, so the outskirts, the barrier, the lamps and the
 * backdrop's houses and trees line it as they always did.
 */
function westRunoff(map: DistrictMap, y: number): 'road' | 'sidewalk' | null {
  const x = westRoadColumn(map);
  const kind = x < 0 ? undefined : map.tiles[y]?.[x];
  return kind === 'road' ? 'road' : kind === 'pavement' ? 'sidewalk' : null;
}

/** Tile bounds of the sandbox build plate, if the map has one. */
function plateBounds(kinds: GroundKind[][]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  kinds.forEach((row, y) =>
    row.forEach((kind, x) => {
      if (kind !== 'plate') return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + 1);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 1);
    }),
  );
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

/** Just beyond the north map edge over the plate's centre, above the hedge. */
function sandboxSignPlacement(kinds: GroundKind[][]): { x: number; y: number; z: number } | null {
  const plate = plateBounds(kinds);
  if (!plate || plate.minY > 0) return null;
  return { x: (plate.minX + plate.maxX) / 2, y: 1.72, z: -1.28 };
}

/** The gap in the sandbox wall where the street runs in (D-060). */
interface Gate {
  /** The wall's column: the opening spans world x to x + 1. */
  readonly x: number;
  /** Open rows [z0, z1); the pillars stand on rows z0 - 1 and z1. */
  readonly z0: number;
  readonly z1: number;
}

/**
 * The first walkable run in a column of fence tiles with fence at both ends.
 * Read from the tiles, like the buildings: move the gate in the map and the
 * pillars, lintel and sign follow it.
 */
function findGate(map: DistrictMap): Gate | null {
  for (let x = 0; x < map.width; x++) {
    let fence = -1;
    for (let y = 0; y < map.height; y++) {
      if (kindAt(map, x, y) !== 'fence') continue;
      if (fence >= 0 && y - fence > 1) {
        let open = true;
        for (let row = fence + 1; row < y && open; row++) open = !isSolidAt(map, x, row);
        if (open) return { x, z0: fence + 1, z1: y };
      }
      fence = y;
    }
  }
  return null;
}

/** The square's sign style, sized for the lintel's one-block face. */
const GATE_SIGN_STYLE: SignStyleOptions = Object.freeze({ ...SANDBOX_THEME.sign, width: 3, height: 0.72 });

/** Centred over the opening on the lintel's street face, just proud of it. */
function gateSignPlacement(gate: Gate): SignPlacement {
  return { x: gate.x - 0.02, y: PILLAR_BLOCKS + 0.5, z: (gate.z0 + gate.z1) / 2 };
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

function grassColor(x: number, z: number, seed: number): Color {
  const warm = valueNoise(x / 13 + 40, z / 13, 5);
  const patch = valueNoise(x / 6, z / 6, 3) - 0.5;
  return shade(mixColor(PALETTE.grassCool, PALETTE.grassWarm, warm), patch * 0.08 + (seed - 0.5) * 0.025);
}

function buildGround(map: DistrictMap, kinds: GroundKind[][], res: ResourceBag, parent: Group): void {
  const bin = new GeometryBin();
  try {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        switch (kinds[y]![x]!) {
          case 'grass':
            grassTile(bin, x, y);
            break;
          case 'road':
          case 'crossing':
            roadTile(bin, x, y);
            break;
          case 'sidewalk':
            sidewalkTile(bin, kinds, x, y);
            break;
          case 'path':
            grassTile(bin, x, y);
            pathStone(bin, x, y);
            break;
          case 'plate':
            plateTile(bin, kinds, x, y);
            break;
          case 'threshold':
            thresholdTile(bin, x, y);
            break;
          case 'plaza':
            // Paved by plaza-builder.ts, level with the pavement.
            break;
          case 'pitch':
            // Laid by pitch-builder.ts: turf, walkway and footings (D-078).
            break;
          case 'bunker':
            // Laid by bunker-builder.ts: the stair's slab and cut (D-107).
            break;
          case 'colosseum':
            // Laid by colosseum-builder.ts: the building's own footing and
            // the threshold under its grand arch (D-114, D-129).
            break;
          case 'solid':
            // Under the sandbox wall a stone footing, which shows in the blocks'
            // bevels like a contact shadow; under the pitch fence its kerb
            // (D-078); under buildings the apron.
            bin.add(
              'sidewalk',
              flatQuad(x, y, x + 1, y + 1, 0),
              kindAt(map, x, y) === 'fence' ? SANDBOX_THEME.border : kindAt(map, x, y) === 'railing' ? PITCH_THEME.kerb : PALETTE.apron,
            );
            break;
        }
      }
    }
    entranceApron(bin, kinds);
    paintRoadMarkings(map, kinds, bin);
    buildOutskirts(map, kinds, bin);
    scatterGroundDecals(map, kinds, bin);

    const groundMaterial = res.material(standardMaterial({ roughness: 0.94 }));
    const paintMaterial = res.material(standardMaterial({ roughness: 0.7 }));
    flushBin(bin, 'grass', groundMaterial, res, parent, { name: 'street:grass', receive: true });
    flushBin(bin, 'road', groundMaterial, res, parent, { name: 'street:road', receive: true });
    flushBin(bin, 'sidewalk', groundMaterial, res, parent, { name: 'street:pavement', receive: true });
    // Paint is a decal: it never casts, but it darkens with the road it lies on.
    flushBin(bin, 'paint', paintMaterial, res, parent, { name: 'street:markings', receive: true });
    flushBin(bin, 'decal', groundMaterial, res, parent, { name: 'street:decals', receive: true });
    flushBin(bin, 'plate', groundMaterial, res, parent, { name: 'street:sandbox-floor', receive: true });
  } finally {
    bin.dispose();
  }
}

/** In-map lawns get soft mowing stripes: a tended park, not wild meadow. */
function grassTile(bin: GeometryBin, x: number, y: number): void {
  const stripe = Math.floor(x / 2) % 2 === 0 ? 0.02 : -0.012;
  bin.add('grass', flatQuad(x, y, x + 1, y + 1, 0), shade(grassColor(x + 0.5, y + 0.5, hash01(x, y, 1)), stripe));
}

function roadTile(bin: GeometryBin, x: number, y: number): void {
  bin.add('road', flatQuad(x, y, x + 1, y + 1, 0), jitterColor(PALETTE.asphalt, hash01(x, y, 2), 0.012));
  if (hash01(x, y, 3) < 0.05) {
    const a = 0.15 + hash01(x, y, 4) * 0.3;
    const b = 0.15 + hash01(x, y, 5) * 0.3;
    bin.add('road', flatQuad(x + a, y + b, x + a + 0.4, y + b + 0.3, 0.005), shade(PALETTE.asphalt, -0.035));
  }
}

function sidewalkTile(bin: GeometryBin, kinds: GroundKind[][], x: number, y: number): void {
  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      const seed = hash01(x * 2 + sx, y * 2 + sy, 4);
      const base = seed < 0.5 ? PALETTE.sidewalk : PALETTE.sidewalkAlt;
      bin.add(
        'sidewalk',
        flatQuad(x + sx * 0.5, y + sy * 0.5, x + sx * 0.5 + 0.5, y + sy * 0.5 + 0.5, PAVEMENT_HEIGHT),
        jitterColor(base, hash01(x * 2 + sx, y * 2 + sy, 5), 0.02),
      );
    }
  }
  const sides: Array<[number, number, 'n' | 's' | 'w' | 'e']> = [
    [0, -1, 'n'],
    [0, 1, 's'],
    [-1, 0, 'w'],
    [1, 0, 'e'],
  ];
  for (const [dx, dy, side] of sides) {
    const neighbour = kinds[y + dy]?.[x + dx];
    // Off-map pavement continues into the outskirts; walls cover their own
    // edge; the Privacy Plaza's paving is level with the pavement (D-076).
    // The hidden stair's slab is flush with it too (D-107).
    if (neighbour === undefined || neighbour === 'sidewalk' || neighbour === 'solid' || neighbour === 'plaza' || neighbour === 'bunker') continue;
    const dropped = neighbour === 'crossing';
    // Pavement meets the gate's threshold at a flush kerb: you walk straight in.
    const flush = dropped || neighbour === 'threshold';
    const height = flush ? PAVEMENT_HEIGHT + 0.004 : KERB_HEIGHT;
    const k = KERB_WIDTH;
    const edge =
      side === 'n'
        ? boxGeometry(x, 0, y, x + 1, height, y + k)
        : side === 's'
          ? boxGeometry(x, 0, y + 1 - k, x + 1, height, y + 1)
          : side === 'w'
            ? boxGeometry(x, 0, y, x + k, height, y + 1)
            : boxGeometry(x + 1 - k, 0, y, x + 1, height, y + 1);
    bin.add('sidewalk', edge, PALETTE.kerb);
    if (dropped) {
      // Tactile paving where the kerb drops to a crossing.
      const t = 0.34;
      const strip =
        side === 'n'
          ? flatQuad(x + 0.06, y + k, x + 0.94, y + k + t, PAVEMENT_HEIGHT + 0.008)
          : side === 's'
            ? flatQuad(x + 0.06, y + 1 - k - t, x + 0.94, y + 1 - k, PAVEMENT_HEIGHT + 0.008)
            : side === 'w'
              ? flatQuad(x + k, y + 0.06, x + k + t, y + 0.94, PAVEMENT_HEIGHT + 0.008)
              : flatQuad(x + 1 - k - t, y + 0.06, x + 1 - k, y + 0.94, PAVEMENT_HEIGHT + 0.008);
      bin.add('sidewalk', strip, PALETTE.tactile);
    }
  }
}

/**
 * The sandbox build plate: warm concrete, a faint one-tile grid, and a darker
 * border that opens where the road and pavements run in. The entrance apron
 * is a lighter tone without the grid (see `entranceApron`). All flat.
 */
function plateTile(bin: GeometryBin, kinds: GroundKind[][], x: number, y: number): void {
  const apron = inEntrance(x, y);
  const tone = apron ? SANDBOX_THEME.entrance : SANDBOX_THEME.plate;
  bin.add('plate', flatQuad(x, y, x + 1, y + 1, 0), jitterColor(tone, hash01(x, y, 501), 0.012));
  const g = 0.014;
  const grid = (nx: number, ny: number): boolean => kinds[ny]?.[nx] === 'plate' && !(apron && inEntrance(nx, ny));
  if (grid(x - 1, y)) bin.add('plate', flatQuad(x - g, y, x + g, y + 1, 0.003), SANDBOX_THEME.grid);
  if (grid(x, y - 1)) bin.add('plate', flatQuad(x, y - g, x + 1, y + g, 0.003), SANDBOX_THEME.grid);
  const b = 0.14;
  const closed = (nx: number, ny: number): boolean => {
    const kind = kinds[ny]?.[nx];
    return kind === undefined || kind === 'grass' || kind === 'path' || kind === 'solid';
  };
  if (closed(x - 1, y)) bin.add('plate', flatQuad(x, y, x + b, y + 1, 0.005), SANDBOX_THEME.border);
  if (closed(x + 1, y)) bin.add('plate', flatQuad(x + 1 - b, y, x + 1, y + 1, 0.005), SANDBOX_THEME.border);
  if (closed(x, y - 1)) bin.add('plate', flatQuad(x, y, x + 1, y + b, 0.005), SANDBOX_THEME.border);
  if (closed(x, y + 1)) bin.add('plate', flatQuad(x, y + 1 - b, x + 1, y + 1, 0.005), SANDBOX_THEME.border);
}

function inEntrance(x: number, y: number): boolean {
  const e = SANDBOX_ENTRANCE;
  return x >= e.x && x < e.x + e.width && y >= e.y && y < e.y + e.height;
}

/**
 * The way in (D-060): the apron just inside the gate, where sky drops never
 * land. A thin outline closes it off from the build grid and faint chevrons
 * point into the square. Paint on the plate, never volumes.
 */
function entranceApron(bin: GeometryBin, kinds: GroundKind[][]): void {
  const { x, y, width, height } = SANDBOX_ENTRANCE;
  for (let ty = y; ty < y + height; ty++) {
    for (let tx = x; tx < x + width; tx++) if (kinds[ty]?.[tx] !== 'plate') return;
  }
  const x1 = x + width;
  const y1 = y + height;
  const o = 0.06;
  // Open to the gate on the west; the plate's own border meets it at both ends.
  bin.add('plate', flatQuad(x, y, x1, y + o, 0.006), SANDBOX_THEME.border);
  bin.add('plate', flatQuad(x, y1 - o, x1, y1, 0.006), SANDBOX_THEME.border);
  bin.add('plate', flatQuad(x1 - o, y + o, x1, y1 - o, 0.006), SANDBOX_THEME.border);
  const zc = y + height / 2;
  const half = Math.min(0.9, height / 2 - 0.5);
  const depth = 0.42;
  const t = 0.15;
  if (half < 0.2) return;
  const step = width > 1 ? (width - 0.6 - depth - t) / (width - 1) : 0;
  const colour = shade(SANDBOX_THEME.entrance, -0.07);
  for (let i = 0; i < width; i++) {
    const xa = x + 0.3 + i * step;
    bin.add('plate', flatPolygon([[xa, zc - half], [xa + t, zc - half], [xa + t + depth, zc], [xa + depth, zc]], 0.004), colour);
    bin.add('plate', flatPolygon([[xa + depth, zc], [xa + t + depth, zc], [xa + t, zc + half], [xa, zc + half]], 0.004), colour);
  }
}

/**
 * The gate's threshold (D-060): where the road and pavements pass the sandbox
 * wall, setts between two sill stones replace asphalt and paving, so the
 * street finishes at the gate instead of butting into the plate. Flat and at
 * road level; the pavements step down to it at a flush kerb.
 */
function thresholdTile(bin: GeometryBin, x: number, y: number): void {
  bin.add('sidewalk', flatQuad(x, y, x + 1, y + 1, 0), shade(PALETTE.kerb, -0.12));
  const sill = 0.16;
  const j = 0.012;
  bin.add('sidewalk', flatQuad(x + j, y + j, x + sill - j, y + 1 - j, 0.006), jitterColor(PALETTE.pathStone, hash01(x, y, 611), 0.02));
  bin.add('sidewalk', flatQuad(x + 1 - sill + j, y + j, x + 1 - j, y + 1 - j, 0.006), jitterColor(PALETTE.pathStone, hash01(x, y, 612), 0.02));
  const a = x + sill;
  const w = (1 - sill * 2) / 2;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      const seed = hash01(x * 2 + col, y * 3 + row, 613);
      bin.add(
        'sidewalk',
        flatQuad(a + col * w + j, y + row / 3 + j, a + (col + 1) * w - j, y + (row + 1) / 3 - j, 0.006),
        jitterColor(seed < 0.5 ? PALETTE.kerb : PALETTE.sidewalkAlt, hash01(x * 2 + col, y * 3 + row, 614), 0.035),
      );
    }
  }
}

function pathStone(bin: GeometryBin, x: number, y: number): void {
  const inset = 0.07 + hash01(x, y, 6) * 0.05;
  const shift = (hash01(x, y, 7) - 0.5) * 0.08;
  bin.add(
    'sidewalk',
    boxGeometry(x + inset + shift, 0, y + 0.1, x + 1 - inset + shift, 0.045, y + 0.9),
    jitterColor(PALETTE.pathStone, hash01(x, y, 8), 0.05),
  );
}

function paintRoadMarkings(map: DistrictMap, kinds: GroundKind[][], bin: GeometryBin): void {
  const y = 0.012;
  for (const band of roadBands(map, kinds)) {
    const crossings = crossingRuns(kinds, band, map.width);
    const centre = (band.r0 + band.r1 + 1) / 2;
    const top = band.r0 + 0.14;
    const bottom = band.r1 + 1 - 0.14;
    // Paint runs off the map only where the road does; where the road ends
    // (into the sandbox, or into the pitch square, D-078), the lines end with it.
    const extent = roadExtent(kinds, band, map.width);
    // The rock's rim is the end of the world (D-132): the backdrop stops its
    // own asphalt a setback short of the drop, so the paint on it stops there
    // too rather than running out over the lip.
    const rim = rockSpanAtZ(centre, RIM_SETBACK);
    const westLimit = Math.max(-HINTERLAND, rim ? rim[0] : -HINTERLAND);
    const eastLimit = Math.min(map.width + HINTERLAND, rim ? rim[1] : map.width + HINTERLAND);
    const start = extent.x0 <= 0 ? westLimit : extent.x0;
    const end = extent.x1 >= map.width ? eastLimit : extent.x1;
    // Dashes keep to one grid counted from the street's own start, a gap short of either square.
    const anchor = Math.max(0, extent.x0);
    const dashStart = extent.x0 <= 0 ? start : start + 1.2;
    const dashEnd = extent.x1 >= map.width ? end : end - 1.2;
    const lanes = (from: number, to: number, dashFrom: number, dashTo: number): void => {
      for (let x = anchor + Math.ceil((dashFrom - anchor) / 1.2 - 1e-9) * 1.2; x < dashTo; x += 1.2) {
        const a = x + 0.25;
        const b = Math.min(x + 0.95, dashTo);
        if (b - a < 0.2) continue;
        if (crossings.some((run) => b > run.x0 - 1.4 && a < run.x1 + 1.4)) continue;
        bin.add('paint', flatQuad(a, centre - 0.05, b, centre + 0.05, y), PALETTE.paintCentre);
      }
      for (const [za, zb] of [
        [top, top + 0.07],
        [bottom - 0.07, bottom],
      ] as const) {
        let edge = from;
        for (const run of crossings) {
          if (run.x1 <= from || run.x0 >= to) continue;
          if (run.x0 - 0.1 > edge) bin.add('paint', flatQuad(edge, za, run.x0 - 0.1, zb, y), PALETTE.paint);
          edge = run.x1 + 0.1;
        }
        if (to > edge) bin.add('paint', flatQuad(edge, za, to, zb, y), PALETTE.paint);
      }
    };
    lanes(start, end, dashStart, dashEnd);
    // Past the pitch square the road runs on west, off the map, as it did
    // before the square took its end (D-078): its paint runs on with it.
    if (extent.x0 > 0 && westRunoff(map, band.r0) === 'road') lanes(westLimit, 0, westLimit, 0);
    for (const run of crossings) {
      for (let row = band.r0; row <= band.r1; row++) {
        for (const offset of [0.125, 0.625]) {
          bin.add('paint', flatQuad(run.x0 + 0.12, row + offset, run.x1 - 0.12, row + offset + 0.25, y), PALETTE.paint);
        }
      }
      // Stop lines: eastbound traffic (south half) meets the crossing from the
      // west, westbound (north half) from the east.
      bin.add('paint', flatQuad(run.x0 - 1.1, centre + 0.08, run.x0 - 0.96, bottom - 0.08, y), PALETTE.paint);
      bin.add('paint', flatQuad(run.x1 + 0.96, top + 0.08, run.x1 + 1.1, centre - 0.08, y), PALETTE.paint);
    }
  }
}

function buildOutskirts(map: DistrictMap, kinds: GroundKind[][], bin: GeometryBin): void {
  const W = map.width;
  const H = map.height;
  // North only to where the backdrop's own ground starts (backdrop.ts).
  meadow(bin, -OUTSKIRT, CITY_FRONT, W + OUTSKIRT, 0, 2, 2);
  // South only to the shore: past it the south vista's water lies over this
  // ground, and grass under a river is grass nobody pays for (D-124).
  meadow(bin, -OUTSKIRT, H, W + OUTSKIRT, Math.min(H + OUTSKIRT, SOUTH_SHORE_Z), 2, 2);
  for (let y = 0; y < H; y++) {
    for (const side of [-1, 1] as const) {
      const edgeX = W - 1;
      // West, the road that runs on past the map, or past the pitch square (D-078).
      const kind = side < 0 ? westRunoff(map, y) : kinds[y]?.[edgeX];
      const x0 = side < 0 ? -OUTSKIRT : W;
      const x1 = side < 0 ? 0 : W + OUTSKIRT;
      if (kind === 'road' || kind === 'crossing') {
        for (let x = x0; x < x1; x += 2) {
          bin.add('road', flatQuad(x, y, x + 2, y + 1, 0), jitterColor(PALETTE.asphalt, hash01(x, y, 12), 0.012));
        }
      } else if (kind === 'sidewalk') {
        for (let x = x0; x < x1; x += 1) {
          for (let sy = 0; sy < 2; sy++) {
            const seed = hash01(x, y * 2 + sy, 13);
            bin.add(
              'sidewalk',
              flatQuad(x, y + sy * 0.5, x + 1, y + sy * 0.5 + 0.5, PAVEMENT_HEIGHT),
              jitterColor(seed < 0.5 ? PALETTE.sidewalk : PALETTE.sidewalkAlt, hash01(x, y, 14), 0.02),
            );
          }
        }
        for (const dy of [-1, 1]) {
          const neighbour = side < 0 ? westRunoff(map, y + dy) : kinds[y + dy]?.[edgeX];
          if (neighbour === 'sidewalk') continue;
          const z0 = dy < 0 ? y : y + 1 - KERB_WIDTH;
          bin.add('sidewalk', boxGeometry(x0, 0, z0, x1, KERB_HEIGHT, z0 + KERB_WIDTH), PALETTE.kerb);
        }
      } else {
        meadow(bin, x0, y, x1, y + 1, 2, 1);
      }
    }
  }
  layHinterland(map, bin, { pavementHeight: PAVEMENT_HEIGHT, kerbHeight: KERB_HEIGHT, kerbWidth: KERB_WIDTH, lawn: grassColor });
}

function meadow(bin: GeometryBin, x0: number, z0: number, x1: number, z1: number, cw: number, ch: number): void {
  for (let z = z0; z < z1; z += ch) {
    for (let x = x0; x < x1; x += cw) {
      const xb = Math.min(x1, x + cw);
      const zb = Math.min(z1, z + ch);
      bin.add('grass', flatQuad(x, z, xb, zb, 0), grassColor((x + xb) / 2, (z + zb) / 2, hash01(x, z, 15)));
    }
  }
}

/** Flowers and grass tufts: under 0.1 tall, so walking over them reads as grass. */
function scatterGroundDecals(map: DistrictMap, kinds: GroundKind[][], bin: GeometryBin): void {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (kinds[y]![x] !== 'grass') continue;
      const roll = hash01(x, y, 21);
      if (roll < 0.09) flowerCluster(bin, x, y);
      else if (roll < 0.26) tuft(bin, x + 0.2 + hash01(x, y, 22) * 0.6, y + 0.2 + hash01(x, y, 23) * 0.6, x * 31 + y);
    }
  }
  // A few beds just outside the map where the camera sees them.
  for (let y = map.height + 1; y < map.height + 6; y++) {
    for (let x = -6; x < map.width + 6; x++) {
      if (hash01(x, y, 24) < 0.12) flowerCluster(bin, x, y);
    }
  }
}

function flowerCluster(bin: GeometryBin, x: number, y: number): void {
  const count = 4 + Math.floor(hash01(x, y, 25) * 4);
  const colour = pick(PALETTE.flowers, hash01(x, y, 26));
  for (let i = 0; i < count; i++) {
    const px = x + 0.2 + hash01(x, y, 30 + i) * 0.6;
    const pz = y + 0.2 + hash01(x, y, 40 + i) * 0.6;
    bin.add('decal', flatPolygon(hexagon(px, pz, 0.075), 0.012), PALETTE.leaf);
    const petal = i % 3 === 2 ? pick(PALETTE.flowers, hash01(x, y, 50 + i)) : colour;
    bin.add('decal', flatPolygon(hexagon(px, pz, 0.045), 0.03 + hash01(x, y, 60 + i) * 0.02), petal);
  }
}

function hexagon(x: number, z: number, radius: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    points.push([x + Math.cos(angle) * radius, z + Math.sin(angle) * radius]);
  }
  return points;
}

function tuft(bin: GeometryBin, x: number, z: number, seed: number): void {
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + hash01(seed, i, 27);
    const blade = new ConeGeometry(0.03, 0.09, 3)
      .rotateZ(Math.cos(angle) * 0.35)
      .rotateX(Math.sin(angle) * 0.35)
      .translate(x + Math.cos(angle) * 0.04, 0.045, z + Math.sin(angle) * 0.04);
    bin.add('decal', blade, jitterColor(PALETTE.tuft, hash01(seed, i, 28), 0.05));
  }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

interface Footprint {
  readonly index: number;
  readonly building: BuildingId | null;
  /** Tile bounds; min inclusive, max exclusive — which is also world units. */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly gaps: readonly Span[];
  readonly door: DoorZone | null;
  readonly label: BuildingExteriorLabel | null;
  /** A rectangle solid everywhere except door gaps in its southern row. */
  readonly standard: boolean;
  hasTile(x: number, y: number): boolean;
}

/**
 * Tiles that make buildings. The sandbox wall's fence tiles are solid too,
 * but they are decor: no footprint, no occluder (see `sandboxWall`).
 */
function isBuildingAt(map: DistrictMap, x: number, y: number): boolean {
  const kind = kindAt(map, x, y);
  return kind === 'wall' || kind === 'facade';
}

/** Connected components of building tiles, north to south, west to east. */
function findFootprints(map: DistrictMap): Footprint[] {
  const key = (x: number, y: number) => y * map.width + x;
  const seen = new Set<number>();
  const components: { tiles: Set<number>; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (seen.has(key(x, y)) || !isBuildingAt(map, x, y)) continue;
      const tiles = new Set<number>();
      let minX = x;
      let maxX = x + 1;
      let minY = y;
      let maxY = y + 1;
      const queue: [number, number][] = [[x, y]];
      seen.add(key(x, y));
      while (queue.length > 0) {
        const [cx, cy] = queue.pop()!;
        tiles.add(key(cx, cy));
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx + 1);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy + 1);
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
          if (seen.has(key(nx, ny)) || !isBuildingAt(map, nx, ny)) continue;
          seen.add(key(nx, ny));
          queue.push([nx, ny]);
        }
      }
      components.push({ tiles, minX, maxX, minY, maxY });
    }
  }
  components.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  return components.map((component, index) => {
    const { minX, maxX, minY, maxY, tiles } = component;
    const facadeRow = maxY - 1;
    let standard = maxY - minY >= 2 && maxX - minX >= 3;
    for (let y = minY; y < facadeRow && standard; y++) {
      for (let x = minX; x < maxX; x++) if (!tiles.has(key(x, y))) standard = false;
    }
    const gaps: Span[] = [];
    let start = -1;
    for (let x = minX; x <= maxX; x++) {
      const open = x < maxX && !tiles.has(key(x, facadeRow));
      if (open && start < 0) start = x;
      if (!open && start >= 0) {
        gaps.push({ x0: start, x1: x });
        start = -1;
      }
    }
    const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    const door =
      map.doors.find(
        (candidate) =>
          candidate.x >= minX &&
          candidate.x + candidate.width <= maxX &&
          candidate.y >= minY &&
          candidate.y + candidate.height <= maxY,
      ) ?? null;
    const label = map.exteriorLabels.find((candidate) => inside(candidate.x, candidate.y)) ?? null;
    return {
      index,
      building: door?.building ?? label?.building ?? null,
      minX,
      maxX,
      minY,
      maxY,
      gaps,
      door,
      label,
      standard,
      hasTile: (x: number, y: number) =>
        x >= 0 && x < map.width && y >= 0 && y < map.height && tiles.has(key(x, y)),
    };
  });
}

function doorInside(footprint: Footprint, door: DoorZone): boolean {
  return (
    door.x >= footprint.minX &&
    door.x + door.width <= footprint.maxX &&
    door.y >= footprint.minY &&
    door.y + door.height <= footprint.maxY
  );
}

function labelInside(footprint: Footprint, label: BuildingExteriorLabel): boolean {
  return (
    label.x >= footprint.minX &&
    label.x <= footprint.maxX &&
    label.y >= footprint.minY &&
    label.y <= footprint.maxY
  );
}

interface SignPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A lift pad on a walkable roof, for its label (the Exchange tower's roof). */
interface RoofLift extends SignPlacement {
  readonly from: FixedRoomLevelId;
  readonly to: FixedRoomLevelId;
}

interface BuiltBuilding {
  readonly group: Group;
  readonly occluder: BuildingOccluder;
  readonly doorTop: number;
  readonly sign: SignPlacement;
  /** Where the theme's brand plate goes, when the style makes room for one. */
  readonly brand?: SignPlacement;
  readonly lifts?: readonly RoofLift[];
  /** D-133: the lookout swing's swinging seat, when this building has one. */
  readonly swing?: RoofSwingView | null;
  readonly animate: Animator;
}

interface BuildingCtx {
  readonly fp: Footprint;
  readonly theme: BuildingTheme;
  readonly bins: GeometryBin;
  readonly res: ResourceBag;
  readonly group: Group;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  /** South edge of the facade row: the street-facing line. */
  readonly zf: number;
  /** North edge of the facade row, where doors stand. */
  readonly rowZ: number;
  readonly gaps: readonly Span[];
  /** The door's gap (the alcove), if any. */
  readonly gap: Span | null;
  readonly doorCentre: number;
}

interface StyleResult {
  readonly doorTop: number;
  readonly sign: SignPlacement;
  readonly brand?: SignPlacement;
  readonly lifts?: readonly RoofLift[];
  /** D-133: the lookout swing's swinging seat, for the view to drive. */
  readonly swing?: RoofSwingView | null;
  /**
   * Top of the occluder box, when it is not the building's highest point: a
   * walkable roof's deck, so nothing standing on it can hide the player.
   */
  readonly occluderHeight?: number;
  /** A glass mass that casts a solid shadow (a tower), not the lattice of its frame. */
  readonly solidGlass?: boolean;
  readonly fadeMaterials?: readonly Material[];
  readonly animate?: Animator;
}

type Style = (ctx: BuildingCtx) => StyleResult;

const STYLES: Readonly<Record<BuildingTheme['style'], Style>> = {
  bank: bankStyle,
  exchange: exchangeStyle,
  'post-office': postOfficeStyle,
  bridge: bridgeStyle,
  vault: vaultStyle,
  generic: genericStyle,
};

function buildBuilding(fp: Footprint, res: ResourceBag): BuiltBuilding {
  const theme = buildingTheme(fp.building);
  const group = new Group();
  group.name = `building:${fp.building ?? fp.index}`;
  group.userData['building'] = fp.building;
  const bins = new GeometryBin();
  try {
    const doorGap =
      (fp.door && fp.gaps.find((gap) => fp.door!.x < gap.x1 && fp.door!.x + fp.door!.width > gap.x0)) ??
      [...fp.gaps].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0] ??
      null;
    const ctx: BuildingCtx = {
      fp,
      theme,
      bins,
      res,
      group,
      x0: fp.minX,
      x1: fp.maxX,
      z0: fp.minY,
      zf: fp.maxY,
      rowZ: fp.maxY - 1,
      gaps: fp.gaps,
      gap: doorGap,
      doorCentre: doorGap ? (doorGap.x0 + doorGap.x1) / 2 : (fp.minX + fp.maxX) / 2,
    };
    const style = fp.standard ? STYLES[theme.style](ctx) : fallbackStyle(ctx);

    // Per-building materials: fading one building must never fade another.
    const fade: Material[] = [...(style.fadeMaterials ?? [])];
    const name = group.name;
    const addMesh = <M extends Material>(key: string, make: () => M, cast: boolean, receive: boolean): M | null => {
      if (!bins.has(key)) return null;
      const material = res.material(make());
      flushBin(bins, key, material, res, group, { name: `${name}:${key}`, cast, receive });
      fade.push(material);
      return material;
    };
    addMesh(BODY, () => standardMaterial({ roughness: 0.84 }), true, true);
    addMesh(GLASS, () => standardMaterial({ roughness: 0.28, metalness: 0.15 }), style.solidGlass === true, true);
    addMesh(LIT, () => standardMaterial({ roughness: 0.5, emissive: theme.windowGlow, emissiveIntensity: 1.25 }), false, false);
    addMesh(GLOW, () => standardMaterial({ roughness: 0.5, emissive: theme.glow, emissiveIntensity: theme.glowIntensity ?? 1.6 }), false, false);
    const beacon = addMesh(
      BEACON,
      () => standardMaterial({ roughness: 0.5, emissive: theme.beacon, emissiveIntensity: 2 }),
      false,
      false,
    );
    addMesh(AURA, () => unlitMaterial({ additive: true }), false, false);
    addMesh(MARK, () => unlitMaterial(), false, false);

    group.updateMatrixWorld(true);
    const box = new Box3().setFromObject(group);
    const bounds: OccluderBounds = Object.freeze({
      minX: fp.minX,
      maxX: fp.maxX,
      minZ: fp.minY,
      maxZ: fp.maxY,
      height: style.occluderHeight ?? (Number.isFinite(box.max.y) ? box.max.y : theme.height),
    });
    const occluder: BuildingOccluder = Object.freeze({
      kind: 'building',
      building: fp.building,
      object: group,
      bounds,
      setOpacity: createOpacityFader(fade),
    });
    const phase = hash01(fp.index, 3, 71) * Math.PI * 2;
    const animate: Animator = (elapsed) => {
      if (beacon) beacon.emissiveIntensity = Math.sin(elapsed / 1000 * 3.1 + phase) > 0.55 ? 3 : 0.25;
      style.animate?.(elapsed);
    };
    if (style.swing) group.add(style.swing.object);
    return {
      group,
      occluder,
      doorTop: style.doorTop,
      sign: style.sign,
      brand: style.brand,
      lifts: style.lifts,
      swing: style.swing ?? null,
      animate,
    };
  } finally {
    bins.dispose();
  }
}

// -- shared building parts ---------------------------------------------------

function isLit(ctx: BuildingCtx, k: number): boolean {
  return hash01(ctx.fp.index + 1, k, 17) < ctx.theme.litRatio;
}

function overlapsGap(ctx: BuildingCtx, a: number, b: number): boolean {
  return ctx.gaps.some((gap) => a < gap.x1 && b > gap.x0);
}

/** The facade row's solid runs: the complement of its gaps. */
function solidRuns(ctx: BuildingCtx): Span[] {
  const runs: Span[] = [];
  let cursor = ctx.x0;
  for (const gap of ctx.gaps) {
    if (gap.x0 > cursor) runs.push({ x0: cursor, x1: gap.x0 });
    cursor = Math.max(cursor, gap.x1);
  }
  if (cursor < ctx.x1) runs.push({ x0: cursor, x1: ctx.x1 });
  return runs;
}

function sideFaces(ctx: BuildingCtx): Face[] {
  return [
    { normal: 'x-', plane: ctx.x0 + SIDE_INSET },
    { normal: 'x+', plane: ctx.x1 - SIDE_INSET },
  ];
}

/** Centres for windows of `width` spread evenly across [a, b]. */
function distribute(a: number, b: number, width: number, minGap: number): number[] {
  const span = b - a;
  if (span < width) return [];
  const count = Math.max(1, Math.floor((span + minGap) / (width + minGap)));
  const step = span / count;
  return Array.from({ length: count }, (_, i) => a + step * (i + 0.5));
}

/**
 * The building mass with a one-tile entrance alcove per door gap: a back
 * block, front blocks either side of each gap, a lintel over it, and jambs
 * framing a door that stands in the solid wall row behind the alcove. A
 * `vestibule` runs each doorway that much deeper into the back block, door
 * high, for a door that stands open inside it (the opened Vault's, D-077);
 * without one the back block is a single box, as it always was.
 */
function massing(
  ctx: BuildingCtx,
  height: number,
  frontInset: number,
  doorTop: number,
  paint: Paint,
  bin = BODY,
  vestibule = 0,
): number {
  const { x0, x1, z0, zf, rowZ } = ctx;
  const front = zf - frontInset;
  const doorBack = rowZ - DOOR_RECESS;
  if (vestibule > 0) {
    // Behind the vestibules, the full block; beside them, the facade row's
    // solid runs; over each, its ceiling at the door's height.
    const back = doorBack - vestibule;
    ctx.bins.add(bin, boxGeometry(x0 + SIDE_INSET, 0, z0 + SIDE_INSET, x1 - SIDE_INSET, height, back), paint);
    for (const run of solidRuns(ctx)) {
      const a = run.x0 <= x0 ? x0 + SIDE_INSET : run.x0;
      const b = run.x1 >= x1 ? x1 - SIDE_INSET : run.x1;
      if (b - a > 0.01) ctx.bins.add(bin, boxGeometry(a, 0, back, b, height, doorBack), paint);
    }
    for (const gap of ctx.gaps) ctx.bins.add(bin, boxGeometry(gap.x0, doorTop, back, gap.x1, height, doorBack), paint);
  } else {
    ctx.bins.add(bin, boxGeometry(x0 + SIDE_INSET, 0, z0 + SIDE_INSET, x1 - SIDE_INSET, height, doorBack), paint);
  }
  for (const run of solidRuns(ctx)) {
    const a = run.x0 <= x0 ? x0 + SIDE_INSET : run.x0;
    const b = run.x1 >= x1 ? x1 - SIDE_INSET : run.x1;
    if (b - a > 0.01) ctx.bins.add(bin, boxGeometry(a, 0, doorBack, b, height, front), paint);
  }
  for (const gap of ctx.gaps) {
    ctx.bins.add(bin, boxGeometry(gap.x0, doorTop, doorBack, gap.x1, height, front), paint);
    ctx.bins.add(BODY, boxGeometry(gap.x0, 0, doorBack, gap.x0 + JAMB, doorTop, rowZ), ctx.theme.trim);
    ctx.bins.add(BODY, boxGeometry(gap.x1 - JAMB, 0, doorBack, gap.x1, doorTop, rowZ), ctx.theme.trim);
  }
  return front;
}

/** A horizontal band on the front, sides and back; split around door gaps below the lintel. */
function band(
  ctx: BuildingCtx,
  y0: number,
  y1: number,
  out: number,
  color: Paint,
  front: number,
  doorTop: number,
  key = BODY,
): void {
  const xa = ctx.x0 + SIDE_INSET;
  const xb = ctx.x1 - SIDE_INSET;
  const za = ctx.z0 + SIDE_INSET;
  if (y0 < doorTop) {
    for (const run of solidRuns(ctx)) {
      const a = Math.max(run.x0, xa - out);
      const b = Math.min(run.x1, xb + out);
      if (b - a > 0.01) ctx.bins.add(key, boxGeometry(a, y0, front - 0.01, b, y1, front + out), color);
    }
  } else {
    ctx.bins.add(key, boxGeometry(xa - out, y0, front - 0.01, xb + out, y1, front + out), color);
  }
  ctx.bins.add(key, boxGeometry(xa - out, y0, za - out, xa + 0.01, y1, front), color);
  ctx.bins.add(key, boxGeometry(xb - 0.01, y0, za - out, xb + out, y1, front), color);
  ctx.bins.add(key, boxGeometry(xa, y0, za - out, xb, y1, za + 0.01), color);
}

function roofSlab(ctx: BuildingCtx, height: number, front: number, color: number): void {
  ctx.bins.add(
    BODY,
    boxGeometry(ctx.x0 + SIDE_INSET, height - 0.02, ctx.z0 + SIDE_INSET, ctx.x1 - SIDE_INSET, height + 0.03, front),
    color,
  );
}

function parapet(ctx: BuildingCtx, height: number, rise: number, thickness: number, color: number, front: number): void {
  const xa = ctx.x0 + SIDE_INSET;
  const xb = ctx.x1 - SIDE_INSET;
  const za = ctx.z0 + SIDE_INSET;
  const top = height + rise;
  ctx.bins.add(BODY, boxGeometry(xa, height, front - thickness, xb, top, front), color);
  ctx.bins.add(BODY, boxGeometry(xa, height, za, xb, top, za + thickness), color);
  ctx.bins.add(BODY, boxGeometry(xa, height, za, xa + thickness, top, front), color);
  ctx.bins.add(BODY, boxGeometry(xb - thickness, height, za, xb, top, front), color);
}

interface WindowOptions {
  readonly frame?: number;
  readonly mullion?: boolean;
  readonly sill?: boolean;
  readonly keystone?: boolean;
}

/** Glass flush on the wall, a proud frame, a sill: reads as a window from any angle. */
function windowOnFace(
  ctx: BuildingCtx,
  face: Face,
  cu: number,
  v0: number,
  width: number,
  height: number,
  lit: boolean,
  options: WindowOptions = {},
): void {
  const t = ctx.theme;
  const frame = options.frame ?? t.trim;
  const u0 = cu - width / 2;
  const u1 = cu + width / 2;
  const v1 = v0 + height;
  const f = 0.06;
  const d = 0.045;
  const seed = hash01(Math.round(cu * 10), Math.round(v0 * 10), ctx.fp.index + 7);
  ctx.bins.add(
    lit ? LIT : GLASS,
    faceBox(face, u0, v0, 0, u1, v1, 0.015),
    lit ? jitterColor(t.windowLit, seed, 0.05) : jitterColor(t.windowDark, seed, 0.04),
  );
  ctx.bins.add(BODY, faceBox(face, u0 - f, v0, 0, u0, v1, d), frame);
  ctx.bins.add(BODY, faceBox(face, u1, v0, 0, u1 + f, v1, d), frame);
  ctx.bins.add(BODY, faceBox(face, u0 - f, v1, 0, u1 + f, v1 + f, d), frame);
  if (options.mullion) {
    ctx.bins.add(BODY, faceBox(face, cu - 0.018, v0, 0, cu + 0.018, v1, d * 0.8), frame);
    const mid = v0 + height * 0.62;
    ctx.bins.add(BODY, faceBox(face, u0, mid - 0.018, 0, u1, mid + 0.018, d * 0.8), frame);
  }
  if (options.sill !== false) {
    ctx.bins.add(BODY, faceBox(face, u0 - f - 0.03, v0 - 0.07, 0, u1 + f + 0.03, v0, d + 0.05), frame);
  }
  if (options.keystone) {
    ctx.bins.add(BODY, faceBox(face, cu - 0.08, v1 + f, 0, cu + 0.08, v1 + f + 0.16, d + 0.01), frame);
  }
}

/** A wall lantern; shallow facades get a flatter one so it stays on solid tiles. */
function sconce(ctx: BuildingCtx, x: number, y: number, front: number): void {
  const depth = Math.min(0.22, ctx.zf - front - 0.01);
  if (depth < 0.06) return;
  const face: Face = { normal: 'z+', plane: front };
  const dark = 0x2b2826;
  ctx.bins.add(BODY, faceBox(face, x - 0.05, y - 0.08, 0, x + 0.05, y + 0.3, 0.03), dark);
  ctx.bins.add(BODY, faceBox(face, x - 0.09, y, 0.02, x + 0.09, y + 0.03, depth), dark);
  ctx.bins.add(GLOW, faceBox(face, x - 0.065, y + 0.03, 0.035, x + 0.065, y + 0.22, depth - 0.015), ctx.theme.glow);
  ctx.bins.add(BODY, faceBox(face, x - 0.09, y + 0.22, 0.02, x + 0.09, y + 0.26, depth), dark);
}

/** Two leaves with lit glass: the building is open. */
function doubleDoor(ctx: BuildingCtx, gap: Span, doorTop: number): void {
  const t = ctx.theme;
  const back = ctx.rowZ - DOOR_RECESS + 0.02;
  const face = ctx.rowZ - 0.02;
  const a = gap.x0 + JAMB;
  const b = gap.x1 - JAMB;
  const mid = (a + b) / 2;
  for (const [l, r] of [
    [a, mid - 0.01],
    [mid + 0.01, b],
  ] as const) {
    ctx.bins.add(BODY, boxGeometry(l, 0, back, r, doorTop - 0.04, face), t.door);
    ctx.bins.add(LIT, boxGeometry(l + 0.1, 0.95, face, r - 0.1, doorTop - 0.3, face + 0.012), t.windowLit);
    const handle = l < mid ? r - 0.09 : l + 0.09;
    ctx.bins.add(BODY, boxGeometry(handle - 0.025, 0.95, face, handle + 0.025, 1.25, face + 0.045), t.accent);
  }
  ctx.bins.add(BODY, boxGeometry(a, doorTop - 0.04, back, b, doorTop, face), t.trim);
}

// -- styles -------------------------------------------------------------------

/**
 * STRK20: the classical bank in near-black stone, its podium, frieze,
 * pediment rakes and cornice drawn in the one burnt-orange accent, under a
 * dark dome ringed in the same light. The measured near-blacks are lifted
 * (see `lift`) only as far as the stone needs to read.
 */
function bankStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const H = t.height;
  const doorTop = 2.3;
  const front = massing(ctx, H, 0.55, doorTop, aoPaint(t.wall, 0.04));
  const gc = ctx.doorCentre;
  if (ctx.gap) doubleDoor(ctx, ctx.gap, doorTop);
  const metal = lift(STRK20.hairline, 0.05);

  const half = Math.max(1, Math.min(3, gc - ctx.x0, ctx.x1 - gc));
  const px0 = gc - half;
  const px1 = gc + half;
  const colZ = (front + ctx.zf) / 2;
  for (const run of solidRuns(ctx)) {
    const a = Math.max(run.x0, px0);
    const b = Math.min(run.x1, px1);
    if (b - a < 0.05) continue;
    ctx.bins.add(BODY, boxGeometry(a, 0, front, b, 0.22, ctx.zf - 0.01), t.wallAlt);
    ctx.bins.add(BODY, boxGeometry(a, 0.22, front, b, 0.32, ctx.zf - 0.06), t.trim);
    ctx.bins.add(GLOW, boxGeometry(a + 0.02, 0.29, ctx.zf - 0.075, b - 0.02, 0.325, ctx.zf - 0.055), t.glow);
  }
  const columns = [gc - 2.6, gc - 1.35, gc + 1.35, gc + 2.6].filter(
    (x) => x - 0.25 >= px0 - 1e-6 && x + 0.25 <= px1 + 1e-6 && !overlapsGap(ctx, x - 0.25, x + 0.25),
  );
  for (const x of columns) {
    ctx.bins.add(BODY, boxGeometry(x - 0.23, 0.32, colZ - 0.23, x + 0.23, 0.42, colZ + 0.23), t.wallAlt);
    ctx.bins.add(BODY, cylinderGeometry(x, 0.42, colZ, 0.15, 0.17, 3.2 - 0.42, 10), t.trim);
    ctx.bins.add(BODY, boxGeometry(x - 0.24, 3.2, colZ - 0.24, x + 0.24, 3.35, colZ + 0.24), t.trim);
  }
  // Entablature with a frieze of light, then the pediment outlined in it.
  ctx.bins.add(BODY, boxGeometry(px0, 3.35, front - 0.12, px1, 3.9, ctx.zf - 0.03), t.trim);
  ctx.bins.add(GLOW, boxGeometry(px0, 3.47, ctx.zf - 0.03, px1, 3.52, ctx.zf), t.glow);
  const peak = 3.9 + half * 0.36;
  ctx.bins.add(BODY, prismZ([[px0, 3.9], [px1, 3.9], [gc, peak]], front - 0.1, ctx.zf - 0.04), t.trim);
  const rakeZ = ctx.zf - 0.05;
  ctx.bins.add(GLOW, beamGeometry([px0 + 0.03, 3.93, rakeZ], [gc, peak - 0.01, rakeZ], 0.03, 0.05), t.glow);
  ctx.bins.add(GLOW, beamGeometry([px1 - 0.03, 3.93, rakeZ], [gc, peak - 0.01, rakeZ], 0.03, 0.05), t.glow);
  const tympanum: Face = { normal: 'z+', plane: ctx.zf - 0.04 };
  const emblemY = 3.9 + (peak - 3.9) * 0.42;
  ctx.bins.add(BODY, faceDisc(tympanum, gc, emblemY, 0, 0.24, 0.02, 16), lift(STRK20.black, 0.04));
  ctx.bins.add(GLOW, faceTorus(tympanum, gc, emblemY, 0.012, 0.27, 0.018, { tubularSegments: 20 }), t.glow);

  // The sign hangs between the inner columns from two dark rods.
  const signY = 2.85;
  const signZ = ctx.zf - 0.07;
  for (const dx of [-0.75, 0.75]) {
    ctx.bins.add(
      BODY,
      boxGeometry(gc + dx - 0.012, signY + t.sign.height / 2 - 0.02, signZ - 0.012, gc + dx + 0.012, 3.36, signZ + 0.012),
      metal,
    );
  }

  const face: Face = { normal: 'z+', plane: front };
  const frame = lift(STRK20.black, 0.1);
  const sorted = [...columns].sort((a, b) => a - b);
  let k = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (overlapsGap(ctx, a, b)) continue;
    windowOnFace(ctx, face, (a + b) / 2, 0.75, 0.52, 1.8, isLit(ctx, k++), { frame, mullion: true, keystone: true });
  }
  for (const [a, b] of [
    [ctx.x0 + SIDE_INSET, px0],
    [px1, ctx.x1 - SIDE_INSET],
  ] as const) {
    if (b - a >= 0.75) windowOnFace(ctx, face, (a + b) / 2, 0.75, 0.5, 1.8, isLit(ctx, k++), { frame, mullion: true, keystone: true });
  }
  for (const side of sideFaces(ctx)) {
    for (const z of distribute(ctx.z0 + 0.8, front - 0.6, 0.52, 1.1)) {
      windowOnFace(ctx, side, z, 0.75, 0.52, 1.8, isLit(ctx, k++), { frame, mullion: true, keystone: true });
    }
  }

  band(ctx, H - 0.24, H + 0.06, 0.1, t.trim, front, doorTop);
  band(ctx, H - 0.3, H - 0.26, 0.06, t.glow, front, doorTop, GLOW);
  roofSlab(ctx, H, front, t.roof);
  const domeZ = (ctx.z0 + front) / 2;
  ctx.bins.add(BODY, cylinderGeometry(gc, H, domeZ, 1.05, 1.05, 0.42, 14), t.trim);
  ctx.bins.add(GLOW, cylinderGeometry(gc, H + 0.42, domeZ, 1.08, 1.08, 0.05, 14), t.glow);
  ctx.bins.add(
    BODY,
    sphereGeometry(gc, H + 0.47, domeZ, 1, { widthSegments: 14, heightSegments: 5, hemisphere: true }),
    lift(STRK20.raised, 0.07),
  );
  ctx.bins.add(BODY, cylinderGeometry(gc, H + 1.42, domeZ, 0.16, 0.18, 0.3, 8), t.trim);
  ctx.bins.add(GLOW, coneGeometry(gc, H + 1.72, domeZ, 0.1, 0.26, 8), t.glow);
  // STRK20 on the entablature, just proud of its orange frieze line.
  return { doorTop, sign: { x: gc, y: signY, z: signZ }, brand: { x: gc, y: (3.35 + 3.9) / 2, z: ctx.zf + 0.006 } };
}

/**
 * avnu: an indigo glass tower on slate floor bands with blue light panels, a
 * pill-shaped canopy (avnu's buttons are pills) and a blue LED ticker. Where
 * a floor of the building is its roof (the Exchange's), the glass runs on up
 * to that roof, far above the street camera's frame, with a second LED band
 * across the podium's crown that the street does see; the rooftop, ticker
 * and all, is up there, walkable (`towerRoof`).
 */
function exchangeStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const roof = rooftopFor(ctx.fp);
  // The podium is the old block: its bands, sign and plate stay where the
  // street sees them. A tower carries the glass on to the roof.
  const podium = t.height;
  const H = roof?.rooftop ? roof.rooftop.height : podium;
  const doorTop = 2.4;
  const front = massing(ctx, H, 0.45, doorTop, (_x, y) => shade(t.wall, 0.05 * Math.min(1, y / podium) + 0.04 * (y / H) - 0.03), GLASS);
  const gc = ctx.doorCentre;
  const xa = ctx.x0 + SIDE_INSET;
  const xb = ctx.x1 - SIDE_INSET;
  const za = ctx.z0 + SIDE_INSET;
  const frame = lift(AVNU.indigoBorder, 0.06);
  const panel = (seed: number) => mixColor(AVNU.lightBlue, AVNU.blue, hash01(ctx.fp.index, seed, 9));

  band(ctx, 0, 0.35, 0.03, t.wallAlt, front, doorTop);
  const levels = [2.55, 3.6, 4.6];
  // Up the tower, a floor every unit above the podium.
  const floors: number[] = [];
  if (roof) for (let y = podium + TOWER_FLOOR; y < H - 0.5; y += TOWER_FLOOR) floors.push(y);
  for (const y of [...levels, ...floors]) band(ctx, y - 0.07, y + 0.07, 0.05, t.trim, front, doorTop);
  if (roof) band(ctx, podium - 0.08, podium + 0.08, 0.07, t.trim, front, doorTop);
  band(ctx, H - 0.1, H + 0.2, 0.06, t.trim, front, doorTop);

  const bays = 8;
  const step = (xb - xa) / bays;
  for (let i = 0; i <= bays; i++) {
    const x = xa + i * step;
    const y0 = overlapsGap(ctx, x - 0.05, x + 0.05) ? levels[0]! + 0.07 : 0.35;
    ctx.bins.add(BODY, boxGeometry(x - 0.03, y0, front, x + 0.03, H - 0.1, front + 0.04), frame);
  }
  const rows: Array<readonly [number, number]> = [
    [0.4, 2.46],
    [2.64, 3.51],
    [3.69, 4.51],
    [4.69, podium - 0.12],
  ];
  // The row above the podium carries the LED band on the front, so its
  // panels are only on the sides.
  const towerRows = [podium, ...floors].map((y) => [y + 0.09, Math.min(H - 0.12, y + TOWER_FLOOR - 0.09)] as const);
  let k = 0;
  [...rows, ...towerRows.slice(1)].forEach(([y0, y1], row) => {
    for (let i = 0; i < bays; i++) {
      const a = xa + i * step + 0.05;
      const c = xa + (i + 1) * step - 0.05;
      k++;
      if (row === 0 && overlapsGap(ctx, a, c)) continue;
      if (!isLit(ctx, k)) continue;
      ctx.bins.add(LIT, boxGeometry(a, y0 + 0.04, front, c, y1 - 0.04, front + 0.015), panel(k));
    }
  });
  for (const side of sideFaces(ctx)) {
    const count = Math.max(2, Math.round((front - za) / 1.1));
    const sideStep = (front - za) / count;
    for (let i = 0; i <= count; i++) {
      const u = za + i * sideStep;
      ctx.bins.add(BODY, faceBox(side, u - 0.03, 0.35, 0, u + 0.03, H - 0.1, 0.04), frame);
    }
    for (const [y0, y1] of [...rows, ...towerRows]) {
      for (let i = 0; i < count; i++) {
        k++;
        if (!isLit(ctx, k)) continue;
        ctx.bins.add(LIT, faceBox(side, za + i * sideStep + 0.05, y0 + 0.04, 0, za + (i + 1) * sideStep - 0.05, y1 - 0.04, 0.015), panel(k));
      }
    }
  }

  if (ctx.gap) {
    const g = ctx.gap;
    doubleDoor(ctx, g, doorTop);
    const back = front - 0.02;
    const edge = ctx.zf - 0.02;
    const radius = (edge - back) / 2;
    const halfLength = (g.x1 - g.x0) / 2 + 0.45;
    ctx.bins.add(BODY, prismY(stadiumPoints(gc, back + radius, halfLength, radius, 6), 2.47, 2.6), AVNU.card);
    ctx.bins.add(GLOW, prismY(stadiumPoints(gc, back + radius, halfLength - 0.06, radius - 0.05, 6), 2.44, 2.47), t.glow);
    // Planters either side of the entrance, on the solid facade row.
    for (const [a, b] of [
      [g.x0 - 0.95, g.x0 - 0.2],
      [g.x1 + 0.2, g.x1 + 0.95],
    ] as const) {
      if (overlapsGap(ctx, a, b) || a < ctx.x0 || b > ctx.x1) continue;
      ctx.bins.add(BODY, boxGeometry(a, 0, front + 0.02, b, 0.42, ctx.zf - 0.03), lift(AVNU.card, 0.1));
      const cx = (a + b) / 2;
      const cz = (front + ctx.zf) / 2;
      for (const dx of [-0.18, 0.16]) {
        ctx.bins.add(
          BODY,
          sphereGeometry(cx + dx, 0.58, cz, 0.2, { widthSegments: 6, heightSegments: 4, scaleY: 0.9 }),
          jitterColor(PALETTE.hedgeLight, hash01(Math.round(cx * 10), Math.round(dx * 100), 3), 0.05),
        );
      }
    }
  }

  const tickers: Mesh[] = [];
  const sign = { x: gc, y: 3.07, z: front + 0.07 };
  // avnu across the podium's top floor, in front of its mullions.
  const brand = { x: gc, y: 5.08, z: front + 0.055 };
  if (!roof) {
    blockRoof(ctx, H, front, tickers);
    return tickerResult({ doorTop, sign, brand, tickers });
  }
  // The street's LED band: navy across the podium's crown, avnu's blue LEDs
  // scrolling, the one piece of the tower's signage the street camera sees.
  const bandA = xa + 0.18;
  const bandB = xb - 0.18;
  const [bandLow, bandHigh] = [podium + 0.16, podium + 0.84];
  ctx.bins.add(BODY, boxGeometry(bandA, bandLow, front, bandB, bandHigh, front + 0.08), AVNU.navy);
  ctx.bins.add(GLOW, boxGeometry(bandA, bandLow - 0.04, front, bandB, bandLow, front + 0.09), t.glow);
  tickers.push(tickerFace(ctx, bandB - bandA - 0.16, bandHigh - bandLow - 0.16, (bandA + bandB) / 2, (bandLow + bandHigh) / 2, front + 0.085, 0, 'podium-ticker'));
  const swings: RoofSwingView[] = [];
  const lifts = towerRoof(ctx, roof, H, front, tickers, swings);
  return tickerResult({ doorTop, sign, brand, tickers, lifts, swing: swings[0] ?? null, occluderHeight: H, solidGlass: true });
}

/** Height of one of the tower's floors above the podium, in world units. */
const TOWER_FLOOR = 1;

/**
 * The walkable roof over a footprint, if a floor of its building is one (the
 * Exchange tower's). Only a grid lying exactly over the footprint counts, so
 * a map that moves the building gets the plain block rather than a roof in
 * the air.
 */
function rooftopFor(fp: Footprint): FixedRoomLevelMap | null {
  if (!fp.building) return null;
  for (const level of FIXED_ROOM_LEVELS[fp.building] ?? []) {
    const roof = level.rooftop;
    if (!roof) continue;
    if (roof.x !== fp.minX || roof.y !== fp.minY) continue;
    if (level.width !== fp.maxX - fp.minX || level.height !== fp.maxY - fp.minY) continue;
    return createFixedRoomLevel(level);
  }
  return null;
}

/** The ticker meshes scroll together; they fade with the building. */
function tickerResult(options: {
  readonly doorTop: number;
  readonly sign: SignPlacement;
  readonly brand: SignPlacement;
  readonly tickers: readonly Mesh[];
  readonly lifts?: readonly RoofLift[];
  readonly swing?: RoofSwingView | null;
  readonly occluderHeight?: number;
  readonly solidGlass?: boolean;
}): StyleResult {
  const pixelsPerSecond = 9;
  const strips = options.tickers.map((mesh) => (mesh.material as MeshBasicMaterial).map!);
  const width = (strips[0]?.image as { width: number } | undefined)?.width ?? 1;
  return {
    doorTop: options.doorTop,
    sign: options.sign,
    brand: options.brand,
    lifts: options.lifts,
    swing: options.swing ?? null,
    occluderHeight: options.occluderHeight,
    solidGlass: options.solidGlass,
    fadeMaterials: options.tickers.map((mesh) => mesh.material as MeshBasicMaterial),
    animate: (elapsed) => {
      const offset = ((elapsed / 1000) * pixelsPerSecond / width) % 1;
      for (const strip of strips) strip.offset.x = offset;
    },
  };
}

/**
 * One LED face showing `EXCHANGE_TICKER`, `width` by `height`, centred at
 * (x, y, z) and tipped back by `tilt` radians about its horizontal axis.
 */
function tickerFace(ctx: BuildingCtx, width: number, height: number, x: number, y: number, z: number, tilt: number, name: string): Mesh {
  const tickerStrip = createTickerStrip(EXCHANGE_TICKER);
  const strip = ctx.res.texture(tickerStrip.texture);
  const pixelSize = height / tickerStrip.height;
  strip.repeat.set(width / pixelSize / tickerStrip.width, 1);
  const material = ctx.res.material(new MeshBasicMaterial({ map: strip, toneMapped: false }));
  const geometry = ctx.res.geometry(new PlaneGeometry(width, height));
  const ticker = new Mesh(geometry, material);
  ticker.name = `${ctx.group.name}:${name}`;
  ticker.position.set(x, y, z);
  ticker.rotation.x = -tilt;
  ctx.group.add(ticker);
  return ticker;
}

/** The old block's roof: plant, a second box, the mast, the ticker along the front. */
function blockRoof(ctx: BuildingCtx, H: number, front: number, tickers: Mesh[]): void {
  const t = ctx.theme;
  roofSlab(ctx, H, front, t.roof);
  ctx.bins.add(BODY, boxGeometry(ctx.x0 + 0.8, H, ctx.z0 + 0.8, ctx.x0 + 2.2, H + 0.5, ctx.z0 + 1.9), AVNU.slate);
  ctx.bins.add(BODY, cylinderGeometry(ctx.x0 + 1.5, H + 0.5, ctx.z0 + 1.35, 0.4, 0.4, 0.04, 10), AVNU.navy);
  ctx.bins.add(BODY, boxGeometry(ctx.x0 + 4.2, H, ctx.z0 + 0.7, ctx.x0 + 5.1, H + 0.35, ctx.z0 + 1.4), lift(AVNU.slate, -0.08));
  const mastX = ctx.x1 - 1;
  const mastZ = ctx.z0 + 1.2;
  ctx.bins.add(BODY, cylinderGeometry(mastX, H, mastZ, 0.035, 0.05, 1.25, 6), AVNU.slate);
  ctx.bins.add(BEACON, sphereGeometry(mastX, H + 1.3, mastZ, 0.08, { widthSegments: 6, heightSegments: 4 }), t.beacon);
  // Ticker: a navy board on legs along the roof's front edge, blue LEDs scrolling.
  const boardA = ctx.x0 + 0.55;
  const boardB = ctx.x1 - 0.55;
  const boardBack = front - 0.45;
  const boardFront = front - 0.2;
  for (const x of [boardA + 0.45, boardB - 0.6]) {
    ctx.bins.add(BODY, boxGeometry(x, H, boardBack + 0.05, x + 0.15, H + 0.42, boardFront - 0.05), lift(AVNU.navy, 0.06));
  }
  ctx.bins.add(BODY, boxGeometry(boardA, H + 0.4, boardBack, boardB, H + 1.1, boardFront), AVNU.navy);
  ctx.bins.add(GLOW, boxGeometry(boardA + 0.05, H + 0.36, boardFront - 0.06, boardB - 0.05, H + 0.4, boardFront), t.glow);
  tickers.push(tickerFace(ctx, boardB - boardA - 0.16, 0.54, (boardA + boardB) / 2, H + 0.75, boardFront + 0.005, 0, 'ticker'));
}

/** D-133: how far the lookout's top deck cantilevers past the tower, all round. */
export const ROOF_OVERHANG = 1;
/** The cantilever's pale fascia, its brighter lip and its soffit. */
const ROOF_FASCIA = 0xdfe3ea;
const ROOF_FASCIA_LIP = 0xf1f3f7;
const ROOF_SOFFIT = 0xc8cedb;
/** The panoramic band under it: dark glass, almost black against the pale slab. */
const ROOF_GLAZING = 0x171b2a;
/** The deck's own paving: pale, chequered, so avnu's blue reads as the inlay. */
const ROOF_DECK_PALE = 0xcdd3dd;
const ROOF_DECK_PALE_ALT = 0xbfc6d2;
/** The deck cap's thickness: the pale slab the overhang reads as. */
const ROOF_CAP_DEPTH = 0.46;
/** The dark panoramic glazing under the cap: its top and bottom, below the deck. */
const ROOF_GLAZING_TOP = ROOF_CAP_DEPTH + 0.1;
const ROOF_GLAZING_BOTTOM = ROOF_GLAZING_TOP + 1.5;

/**
 * The Exchange tower's roof, a floor of the building (fixed-room.ts), and the
 * lookout it became in D-133.
 *
 * The top is a wide flat deck cantilevered a whole unit past the tower on
 * every side, with a pale fascia round its rim and a pale soffit under the
 * overhang, and a band of dark panoramic glazing in the tower's face just
 * beneath it — the avnu ticker runs along that band's south face, where the
 * street camera reads it.
 *
 * On top: a deck on the roof grid's walkable tiles at exactly the roof's
 * height, a planted ledge over the grid's solid ring and out onto the
 * overhang, and a glass balustrade all round at the overhang's rim, so
 * nobody can walk off. The old rooftop model stands on that ring, out of the
 * way: the plant in the north-west corner, the mast in the north-east, and
 * the roof's own ticker along the north side, tipped back towards the deck
 * and the camera looking down on it. The lift down is a lit pad with a glass
 * cab beside it, and the lookout swing's A-frame stands on the south ledge
 * (`roof-swing.ts`). Nothing below head height stands on a walkable tile.
 */
function towerRoof(
  ctx: BuildingCtx,
  roof: FixedRoomLevelMap,
  H: number,
  front: number,
  tickers: Mesh[],
  swings: RoofSwingView[],
): RoofLift[] {
  const t = ctx.theme;
  const origin = roof.rooftop!;
  const xa = ctx.x0 + SIDE_INSET;
  const xb = ctx.x1 - SIDE_INSET;
  const za = ctx.z0 + SIDE_INSET;
  const walkable = (x: number, y: number): boolean => {
    const tile = roof.tiles[y]?.[x];
    return tile === 'floor' || tile === 'lift';
  };
  // The deck's extent: the walkable tiles' bounding box, in world units.
  let dx0 = Infinity;
  let dx1 = -Infinity;
  let dz0 = Infinity;
  let dz1 = -Infinity;
  for (let y = 0; y < roof.height; y++) {
    for (let x = 0; x < roof.width; x++) {
      if (!walkable(x, y)) continue;
      dx0 = Math.min(dx0, origin.x + x);
      dx1 = Math.max(dx1, origin.x + x + 1);
      dz0 = Math.min(dz0, origin.y + y);
      dz1 = Math.max(dz1, origin.y + y + 1);
    }
  }
  // D-133, the lookout's cantilever. A wide pale cap whose top is exactly the
  // roof's height, overhanging the tower on every side, with a soffit set
  // back under it so the overhang reads as a slab with a shadow line, and a
  // proud fascia round its rim.
  const rx0 = ctx.x0 - ROOF_OVERHANG;
  const rx1 = ctx.x1 + ROOF_OVERHANG;
  const rz0 = ctx.z0 - ROOF_OVERHANG;
  const rz1 = ctx.zf + ROOF_OVERHANG;
  /** The four strips of a rectangular ring `thickness` wide, inside (x0, z0)-(x1, z1). */
  const ring = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    thickness: number,
  ): ReadonlyArray<readonly [number, number, number, number]> => [
    [x0, z0, x1, z0 + thickness],
    [x0, z1 - thickness, x1, z1],
    [x0, z0 + thickness, x0 + thickness, z1 - thickness],
    [x1 - thickness, z0 + thickness, x1, z1 - thickness],
  ];
  ctx.bins.add(BODY, boxGeometry(rx0, H - ROOF_CAP_DEPTH, rz0, rx1, H - 0.1, rz1), ROOF_FASCIA);
  ctx.bins.add(BODY, boxGeometry(rx0 - 0.05, H - 0.1, rz0 - 0.05, rx1 + 0.05, H, rz1 + 0.05), ROOF_FASCIA_LIP);
  // The soffit: the overhang's pale underside, set back from the fascia.
  ctx.bins.add(
    BODY,
    boxGeometry(rx0 + 0.14, H - ROOF_CAP_DEPTH - 0.12, rz0 + 0.14, rx1 - 0.14, H - ROOF_CAP_DEPTH, rz1 - 0.14),
    ROOF_SOFFIT,
  );
  // The dark panoramic glazing in the tower's own face, just beneath it.
  for (const [x0, z0, x1, z1] of ring(xa - 0.05, za - 0.05, xb + 0.05, front + 0.05, 0.1)) {
    ctx.bins.add(GLASS, boxGeometry(x0, H - ROOF_GLAZING_BOTTOM, z0, x1, H - ROOF_GLAZING_TOP, z1), ROOF_GLAZING);
  }
  // The avnu ticker runs along that band's south face, where the street reads it.
  const glazeA = xa + 0.3;
  const glazeB = xb - 0.3;
  tickers.push(tickerFace(
    ctx,
    glazeB - glazeA,
    ROOF_GLAZING_BOTTOM - ROOF_GLAZING_TOP - 0.22,
    (glazeA + glazeB) / 2,
    H - (ROOF_GLAZING_TOP + ROOF_GLAZING_BOTTOM) / 2,
    front + 0.06,
    0,
    'lookout-ticker',
  ));
  // The slab the deck sits on, its top exactly at the roof's height.
  ctx.bins.add(BODY, boxGeometry(xa, H - 0.12, za, xb, H, front), t.roof);
  for (let y = 0; y < roof.height; y++) {
    for (let x = 0; x < roof.width; x++) {
      if (!walkable(x, y)) continue;
      const wx = origin.x + x;
      const wz = origin.y + y;
      // D-133: a pale terrace, as the lookout's is, with avnu's blue left for
      // the inlaid ring and the lift pad.
      ctx.bins.add(BODY, flatQuad(wx + 0.02, wz + 0.02, wx + 0.98, wz + 0.98, H + 0.004), (x + y) % 2 === 0 ? ROOF_DECK_PALE : ROOF_DECK_PALE_ALT);
    }
  }
  // An avnu-blue ring inlaid in the deck's middle.
  const ringX = (dx0 + dx1) / 2;
  const ringZ = (dz0 + dz1) / 2;
  const ringR = Math.min(dx1 - dx0, dz1 - dz0) / 2 - 0.45;
  if (ringR > 0.3) {
    ctx.bins.add(GLOW, new RingGeometry(ringR - 0.05, ringR, 40).rotateX(-Math.PI / 2).translate(ringX, H + 0.007, ringZ), t.glow);
  }
  // The ledge ring: planted, knee high, over every solid tile of the grid and
  // on out across the cantilever to its rim.
  const ledgeTop = H + 0.45;
  // D-133: the parapet is the cantilever's own pale stone, not the tower's navy.
  const ledge = ROOF_FASCIA;
  const ledges: ReadonlyArray<readonly [number, number, number, number]> = [
    [rx0, rz0, dx0, rz1],
    [dx1, rz0, rx1, rz1],
    [dx0, rz0, dx1, dz0],
    [dx0, dz1, dx1, rz1],
  ];
  for (const [x0, z0, x1, z1] of ledges) {
    if (x1 - x0 < 0.02 || z1 - z0 < 0.02) continue;
    ctx.bins.add(BODY, boxGeometry(x0, H, z0, x1, ledgeTop, z1), ledge);
    ctx.bins.add(BODY, boxGeometry(x0, ledgeTop, z0, x1, ledgeTop + 0.03, z1), ROOF_FASCIA_LIP);
  }
  // Greenery along the north and west ledges, clear of the corners' kit, the
  // swing's frame on the south ledge and the balustrade at the rim.
  for (let x = dx0 + 0.5; x < dx1; x += 1) {
    shrub(ctx, x, ledgeTop, (rz0 + dz0) / 2 + 0.2, 0.16);
  }
  for (let z = dz0 + 0.5; z < dz1 - 1; z += 1) {
    shrub(ctx, (rx0 + dx0) / 2 + 0.2, ledgeTop, z, 0.17);
  }
  // A continuous glass balustrade at the cantilever's rim, a slate rail along
  // its top: the deck is enclosed all the way out to the overhang's edge.
  const railTop = ledgeTop + 0.75;
  const glass = lift(AVNU.lightBlue, -0.2);
  for (const [x0, z0, x1, z1] of ring(rx0, rz0, rx1, rz1, 0.07)) {
    ctx.bins.add(GLASS, boxGeometry(x0, ledgeTop, z0, x1, railTop, z1), glass);
    ctx.bins.add(BODY, boxGeometry(x0 - 0.02, railTop, z0 - 0.02, x1 + 0.02, railTop + 0.06, z1 + 0.02), AVNU.slate);
  }
  // D-133: the lookout swing's A-frame on the south ledge, its seat hanging
  // out past the balustrade. The frame merges into the building's own bins;
  // the seat is its own group, which swings.
  swings.push(buildRoofSwing(ctx.bins, ctx.res, {
    originX: origin.x,
    originZ: origin.y,
    deckY: H,
    ledgeY: ledgeTop + 0.03,
  }));
  // The old rooftop model, moved up here: the plant in the north-west corner...
  const nw = { x: (rx0 + dx0) / 2, z: (rz0 + dz0) / 2 };
  ctx.bins.add(BODY, boxGeometry(nw.x - 0.36, ledgeTop, nw.z - 0.32, nw.x + 0.36, ledgeTop + 0.42, nw.z + 0.32), AVNU.slate);
  ctx.bins.add(BODY, cylinderGeometry(nw.x, ledgeTop + 0.42, nw.z, 0.24, 0.24, 0.04, 10), AVNU.navy);
  // ...the mast and its beacon in the north-east...
  const ne = { x: (dx1 + rx1) / 2, z: (rz0 + dz0) / 2 };
  ctx.bins.add(BODY, cylinderGeometry(ne.x, ledgeTop, ne.z, 0.035, 0.05, 1.25, 6), AVNU.slate);
  ctx.bins.add(BEACON, sphereGeometry(ne.x, ledgeTop + 1.3, ne.z, 0.08, { widthSegments: 6, heightSegments: 4 }), t.beacon);
  // ...and the ticker along the north side, tipped back to face the deck.
  const boardA = dx0 + 0.2;
  const boardB = dx1 - 0.2;
  const boardZ = (rz0 + dz0) / 2 + 0.5;
  const tilt = 0.5;
  const boardHeight = 0.7;
  const boardY = ledgeTop + 0.3 + (boardHeight / 2) * Math.cos(tilt);
  for (const x of [boardA + 0.5, boardB - 0.5]) {
    ctx.bins.add(BODY, boxGeometry(x - 0.06, ledgeTop, boardZ - 0.08, x + 0.06, boardY, boardZ + 0.02), lift(AVNU.navy, 0.06));
  }
  const board = new BoxGeometry(boardB - boardA, boardHeight, 0.12).rotateX(-tilt).translate((boardA + boardB) / 2, boardY, boardZ - 0.05);
  ctx.bins.add(BODY, board, AVNU.navy);
  const faceDepth = 0.061;
  tickers.push(tickerFace(
    ctx,
    boardB - boardA - 0.16,
    boardHeight - 0.16,
    (boardA + boardB) / 2,
    boardY + faceDepth * Math.sin(tilt),
    boardZ - 0.05 + faceDepth * Math.cos(tilt),
    tilt,
    'ticker',
  ));
  // The lift down: its pad lit on the deck, a glass cab on the ledge beside it.
  const lifts: RoofLift[] = [];
  for (const pad of roof.lifts) {
    const x0 = origin.x + pad.x;
    const z0 = origin.y + pad.y;
    const x1 = x0 + pad.width;
    const z1 = z0 + pad.height;
    ctx.bins.add(BODY, flatQuad(x0 + 0.08, z0 + 0.08, x1 - 0.08, z1 - 0.08, H + 0.006), lift(AVNU.navy, 0.02));
    const e = 0.05;
    for (const [a, b, c, d] of [
      [x0 + 0.08, z0 + 0.08, x1 - 0.08, z0 + 0.08 + e],
      [x0 + 0.08, z1 - 0.08 - e, x1 - 0.08, z1 - 0.08],
      [x0 + 0.08, z0 + 0.08, x0 + 0.08 + e, z1 - 0.08],
      [x1 - 0.08 - e, z0 + 0.08, x1 - 0.08, z1 - 0.08],
    ] as const) {
      ctx.bins.add(GLOW, flatQuad(a, b, c, d, H + 0.009), AVNU.lightBlue);
    }
    // Chevrons pointing south: down the tower.
    const cx = (x0 + x1) / 2;
    for (const zc of [(z0 + z1) / 2 - 0.12, (z0 + z1) / 2 + 0.16]) {
      for (const side of [-1, 1]) {
        ctx.bins.add(GLOW, flatPolygon([[cx, zc + 0.11], [cx, zc + 0.03], [cx + side * 0.24, zc - 0.13], [cx + side * 0.24, zc - 0.05]], H + 0.01), AVNU.lightBlue);
      }
    }
    // The cab: a glass box with a lit roof on the ledge to the pad's east.
    const cabX0 = x1;
    const cabX1 = rx1 - 0.12;
    if (cabX1 - cabX0 > 0.3) {
      const cz0 = z0 - 0.3;
      const cz1 = Math.min(rz1 - 0.12, z1 + 0.25);
      ctx.bins.add(GLASS, boxGeometry(cabX0 + 0.06, ledgeTop, cz0, cabX1, ledgeTop + 0.72, cz1), lift(AVNU.lightBlue, -0.1));
      ctx.bins.add(BODY, boxGeometry(cabX0 + 0.03, ledgeTop + 0.72, cz0 - 0.03, cabX1 + 0.03, ledgeTop + 0.8, cz1 + 0.03), AVNU.navy);
      ctx.bins.add(GLOW, boxGeometry(cabX0 + 0.1, ledgeTop + 0.8, cz0 + 0.06, cabX1 - 0.04, ledgeTop + 0.82, cz1 - 0.06), AVNU.lightBlue);
    }
    lifts.push({ from: roof.level, to: pad.to, x: cx, y: H + 1.86, z: (z0 + z1) / 2 });
  }
  return lifts;
}

/** A low clump of greenery standing on a ledge. */
function shrub(ctx: BuildingCtx, x: number, y: number, z: number, radius: number): void {
  const seed = hash01(Math.round(x * 10), Math.round(z * 10), 23);
  ctx.bins.add(
    BODY,
    sphereGeometry(x, y + radius * 0.7, z, radius, { widthSegments: 6, heightSegments: 4, scaleY: 0.8 }),
    jitterColor(seed > 0.5 ? PALETTE.hedgeLight : PALETTE.hedge, seed, 0.06),
  );
}

/** Red brick, blue trim, a striped awning over the door, a pillar box, a slate gable. */
function postOfficeStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const H = t.height;
  const doorTop = 2.2;
  const front = massing(ctx, H, 0.5, doorTop, aoPaint(t.wall, 0.08));
  const gc = ctx.doorCentre;
  band(ctx, 0, 0.32, 0.03, t.wallAlt, front, doorTop);
  band(ctx, H - 0.2, H, 0.04, t.accent, front, doorTop);
  for (const side of sideFaces(ctx)) {
    ctx.bins.add(BODY, faceBox(side, ctx.z0 + SIDE_INSET, 1.98, 0, front, 2.06, 0.03), t.accent);
  }

  const face: Face = { normal: 'z+', plane: front };
  let k = 0;
  if (ctx.gap) {
    const g = ctx.gap;
    doubleDoor(ctx, g, doorTop);
    awning(ctx, g.x0 - 0.3, g.x1 + 0.3, front, 2.62, 2.3, t.accent, t.trim);
    pillarBox(ctx, g.x1 + 0.45, front + 0.26);
    sconce(ctx, g.x0 - 0.2, 1.72, front);
    sconce(ctx, g.x1 + 0.2, 1.72, front);
  }
  const clearance = (x: number) => (ctx.gap && x > ctx.gap.x1 - 0.01 && x < ctx.gap.x1 + 0.9 ? 0.75 : 0);
  for (const run of solidRuns(ctx)) {
    const a = Math.max(run.x0, ctx.x0 + SIDE_INSET) + 0.15 + clearance(run.x0);
    const b = Math.min(run.x1, ctx.x1 - SIDE_INSET) - 0.15;
    const centre = (a + b) / 2;
    if (b - a < 0.8) continue;
    windowOnFace(ctx, face, centre, 0.75, 0.7, 1.05, isLit(ctx, k++), { mullion: true });
    flowerBox(ctx, face, centre, 0.7, 0.68);
  }
  const signHalf = t.sign.width / 2 + 0.2;
  for (const [a, b] of [
    [ctx.x0 + SIDE_INSET + 0.15, gc - signHalf],
    [gc + signHalf, ctx.x1 - SIDE_INSET - 0.15],
  ] as const) {
    for (const x of distribute(a, b, 0.5, 0.35)) {
      windowOnFace(ctx, face, x, 2.75, 0.5, 0.62, isLit(ctx, k++), { mullion: true });
    }
  }
  for (const side of sideFaces(ctx)) {
    for (const z of distribute(ctx.z0 + 0.7, front - 0.5, 0.6, 1.0)) {
      windowOnFace(ctx, side, z, 0.75, 0.6, 1.0, isLit(ctx, k++), { mullion: true });
      windowOnFace(ctx, side, z, 2.6, 0.55, 0.65, isLit(ctx, k++), { mullion: true });
    }
  }

  // Slate gable, ridge running east-west, brick gable ends under the overhang.
  const za = ctx.z0 + 0.02;
  const zb = Math.min(ctx.zf - 0.02, front + 0.4);
  const zr = (za + zb) / 2;
  const yr = H + 1.4;
  const th = 0.18;
  ctx.bins.add(BODY, prismX([[zb, H - 0.05 - th], [zb, H - 0.05], [zr, yr], [zr, yr - th]], ctx.x0, ctx.x1), t.roof);
  ctx.bins.add(BODY, prismX([[za, H - 0.05 - th], [zr, yr - th], [zr, yr], [za, H - 0.05]], ctx.x0, ctx.x1), shade(t.roof, -0.04));
  ctx.bins.add(BODY, boxGeometry(ctx.x0, yr - 0.05, zr - 0.09, ctx.x1, yr + 0.06, zr + 0.09), shade(t.roof, -0.08));
  ctx.bins.add(
    BODY,
    prismX([[ctx.z0 + SIDE_INSET, H - 0.05], [front, H - 0.05], [zr, yr - th - 0.02]], ctx.x0 + SIDE_INSET, ctx.x1 - SIDE_INSET),
    t.wall,
  );
  for (let i = 1; i <= 4; i++) {
    const f = i / 5;
    const y = H - 0.05 + (yr - H + 0.05) * f;
    const z = zb + (zr - zb) * f;
    ctx.bins.add(BODY, beamGeometry([ctx.x0, y, z], [ctx.x1, y, z], 0.05, 0.035), shade(t.roof, -0.07));
  }
  const chimneyX = ctx.x0 + (ctx.x1 - ctx.x0) * 0.78;
  ctx.bins.add(BODY, boxGeometry(chimneyX, H + 0.4, za + 1.4, chimneyX + 0.5, H + 1.95, za + 1.9), t.wallAlt);
  ctx.bins.add(BODY, boxGeometry(chimneyX - 0.05, H + 1.95, za + 1.35, chimneyX + 0.55, H + 2.05, za + 1.95), 0x3a3434);
  return { doorTop, sign: { x: gc, y: 3.05, z: front + 0.03 } };
}

function awning(
  ctx: BuildingCtx,
  xa: number,
  xb: number,
  wallZ: number,
  yWall: number,
  yFront: number,
  stripeA: number,
  stripeB: number,
): void {
  const zFront = ctx.zf - 0.03;
  const count = Math.max(4, Math.round((xb - xa) / 0.28));
  const width = (xb - xa) / count;
  for (let i = 0; i < count; i++) {
    const a = xa + i * width;
    const b = a + width;
    const colour = i % 2 === 0 ? stripeA : stripeB;
    ctx.bins.add(BODY, prismX([[wallZ, yWall], [zFront, yFront], [zFront, yFront - 0.05], [wallZ, yWall - 0.05]], a, b), colour);
    ctx.bins.add(BODY, boxGeometry(a, yFront - 0.2, zFront - 0.02, b, yFront - 0.04, zFront), colour);
  }
  for (const x of [xa + 0.03, xb - 0.03]) {
    ctx.bins.add(BODY, beamGeometry([x, yWall - 0.35, wallZ], [x, yFront - 0.05, zFront - 0.05], 0.03, 0.03), 0x2b2b30);
  }
}

function flowerBox(ctx: BuildingCtx, face: Face, cu: number, width: number, v: number): void {
  ctx.bins.add(BODY, faceBox(face, cu - width / 2 - 0.05, v - 0.16, 0, cu + width / 2 + 0.05, v, 0.2), 0x6b4a2f);
  for (let i = 0; i < 5; i++) {
    const u = cu - width / 2 + (i + 0.5) * (width / 5);
    const colour = pick(PALETTE.flowers, hash01(i, Math.round(cu * 10), 3));
    ctx.bins.add(BODY, faceBox(face, u - 0.075, v, 0.03, u + 0.075, v + 0.05, 0.17), PALETTE.leaf);
    ctx.bins.add(BODY, faceBox(face, u - 0.055, v + 0.05, 0.05, u + 0.055, v + 0.12, 0.15), colour);
  }
}

/** A red pillar box standing on the solid facade row, beside the door. */
function pillarBox(ctx: BuildingCtx, x: number, z: number): void {
  const red = 0xc8302c;
  const dark = 0x2a2a2e;
  ctx.bins.add(BODY, cylinderGeometry(x, 0, z, 0.22, 0.22, 0.08, 10), dark);
  ctx.bins.add(BODY, cylinderGeometry(x, 0.08, z, 0.19, 0.2, 0.92, 10), red);
  ctx.bins.add(BODY, cylinderGeometry(x, 1, z, 0.215, 0.215, 0.06, 10), red);
  ctx.bins.add(BODY, sphereGeometry(x, 1.06, z, 0.2, { widthSegments: 10, heightSegments: 3, hemisphere: true, scaleY: 0.6 }), red);
  ctx.bins.add(BODY, boxGeometry(x - 0.11, 0.78, z + 0.15, x + 0.11, 0.82, z + 0.205), dark);
  ctx.bins.add(BODY, boxGeometry(x - 0.07, 0.52, z + 0.16, x + 0.07, 0.64, z + 0.2), 0xf3ead6);
}

/**
 * NEAR (deposits route through NEAR Intents): black glass in a thin grey
 * frame, and a cable-stayed span across the front. Two steel pylons carry a
 * slim deck over the entrance on cables drawn in NEAR green light, clear of
 * the middle, where the sign sits on a black card with crosshair marks at
 * its corners. A faint aurora washes the glass around the card, and a run of
 * slashes marks the plinth.
 */
function bridgeStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const H = t.height;
  const doorTop = 2.4;
  const deck = 2.62;
  const front = massing(ctx, H, 0.42, doorTop, (_x, y) => shade(t.wall, 0.035 * (y / H) - 0.01), GLASS);
  const gc = ctx.doorCentre;
  const xa = ctx.x0 + SIDE_INSET;
  const xb = ctx.x1 - SIDE_INSET;
  const za = ctx.z0 + SIDE_INSET;
  const steel = t.wallAlt;
  const mark = lift(NEAR.muted, 0.1);
  // Light lines: a near-black body, lit only by the GLOW material's green.
  const line = lift(NEAR.green, -0.38);
  if (ctx.gap) doubleDoor(ctx, ctx.gap, doorTop);

  // Plinth: a green line along its top and a run of slashes on its face.
  band(ctx, 0, 0.34, 0.04, steel, front, doorTop);
  band(ctx, 0.34, 0.37, 0.05, line, front, doorTop, GLOW);
  for (const run of solidRuns(ctx)) {
    const a = Math.max(run.x0, xa) + 0.1;
    const b = Math.min(run.x1, xb) - 0.1;
    for (let x = a; x + 0.12 <= b; x += 0.2) {
      ctx.bins.add(BODY, beamGeometry([x, 0.09, front + 0.046], [x + 0.12, 0.27, front + 0.046], 0.012, 0.024), mark);
    }
  }

  // The curtain wall: a grey grid over black glass, two rows of panes per
  // floor, a few of them lit; the shopfront's lower row stays dark.
  const ground = 1.36;
  const upper = (deck + 0.16 + H - 0.24) / 2;
  const floors: ReadonlyArray<readonly [number, number]> = [
    [0.4, ground - 0.03],
    [ground + 0.03, deck - 0.05],
    [deck + 0.16, upper - 0.03],
    [upper + 0.03, H - 0.24],
  ];
  const bays = 9;
  const step = (xb - xa) / bays;
  for (let i = 0; i <= bays; i++) {
    const x = xa + i * step;
    const y0 = overlapsGap(ctx, x - 0.03, x + 0.03) ? doorTop : 0.37;
    ctx.bins.add(BODY, boxGeometry(x - 0.022, y0, front, x + 0.022, H - 0.2, front + 0.028), t.trim);
  }
  for (const y of [ground, upper]) {
    for (const run of y < doorTop ? solidRuns(ctx) : [{ x0: xa, x1: xb }]) {
      const a = Math.max(run.x0, xa);
      const b = Math.min(run.x1, xb);
      if (b - a > 0.05) ctx.bins.add(BODY, boxGeometry(a, y - 0.018, front, b, y + 0.018, front + 0.026), t.trim);
    }
  }
  const pane = (k: number) => jitterColor(t.windowLit, hash01(ctx.fp.index, k, 19), 0.04);
  let k = 0;
  floors.forEach(([y0, y1], row) => {
    for (let i = 0; i < bays; i++) {
      const a = xa + i * step + 0.03;
      const c = xa + (i + 1) * step - 0.03;
      k++;
      if (row === 0 || (row === 1 && overlapsGap(ctx, a, c)) || !isLit(ctx, k)) continue;
      ctx.bins.add(LIT, boxGeometry(a, y0, front, c, y1, front + 0.012), pane(k));
    }
  });
  band(ctx, deck - 0.05, deck + 0.16, 0.03, steel, front, doorTop);
  for (const side of sideFaces(ctx)) {
    const count = Math.max(2, Math.round((front - za) / 0.8));
    const sideStep = (front - za) / count;
    for (let i = 0; i <= count; i++) {
      const u = za + i * sideStep;
      ctx.bins.add(BODY, faceBox(side, u - 0.022, 0.37, 0, u + 0.022, H - 0.2, 0.028), t.trim);
    }
    for (const [y0, y1] of floors) {
      for (let i = 0; i < count; i++) {
        k++;
        if (!isLit(ctx, k)) continue;
        ctx.bins.add(LIT, faceBox(side, za + i * sideStep + 0.03, y0, 0, za + (i + 1) * sideStep - 0.03, y1, 0.012), pane(k));
      }
    }
  }

  // The span: a slim deck across the front with a green line under its edge,
  // two pylons, and cables fanning from each pylon head towards the middle.
  const zf = ctx.zf;
  ctx.bins.add(BODY, boxGeometry(xa + 0.02, deck, front - 0.02, xb - 0.02, deck + 0.1, zf - 0.03), steel);
  ctx.bins.add(GLOW, boxGeometry(xa + 0.08, deck - 0.024, zf - 0.09, xb - 0.08, deck, zf - 0.05), line);
  const pz = (front + zf) / 2;
  const top = H + 1.3;
  const card = { halfWidth: t.sign.width / 2 + 0.2, halfHeight: t.sign.height / 2 + 0.14 };
  const signY = deck + 0.12 + card.halfHeight;
  for (const [px, dir] of [
    [ctx.x0 + 0.36, 1],
    [ctx.x1 - 0.36, -1],
  ] as const) {
    ctx.bins.add(BODY, boxGeometry(px - 0.12, 0, pz - 0.12, px + 0.12, 0.34, pz + 0.12), shade(steel, -0.04));
    ctx.bins.add(BODY, boxGeometry(px - 0.085, 0, pz - 0.085, px + 0.085, top, pz + 0.085), steel);
    ctx.bins.add(GLOW, boxGeometry(px - 0.095, top - 0.06, pz - 0.095, px + 0.095, top, pz + 0.095), line);
    ctx.bins.add(BEACON, sphereGeometry(px, top + 0.08, pz, 0.07, { widthSegments: 6, heightSegments: 4 }), t.beacon);
    // Anchors stop short of the card, so no cable crosses the sign.
    const reach = Math.abs(gc - px) - card.halfWidth - 0.08;
    for (let i = 1; i <= 3; i++) {
      const anchor: Vec3 = [px + dir * reach * (i / 3), deck + 0.1, pz];
      ctx.bins.add(GLOW, beamGeometry([px, top - 0.12 - (3 - i) * 0.16, pz], anchor, 0.022, 0.022), line);
    }
    // A back-stay over the roof to an anchor block.
    ctx.bins.add(GLOW, beamGeometry([px, top - 0.1, pz], [px, H + 0.12, za + 0.9], 0.022, 0.022), line);
    ctx.bins.add(BODY, boxGeometry(px - 0.1, H, za + 0.8, px + 0.1, H + 0.14, za + 1), steel);
  }

  // The sign's card, crosshairs in its corners, and the aurora around it.
  const cardFront = zf - 0.08;
  ctx.bins.add(
    BODY,
    boxGeometry(gc - card.halfWidth, signY - card.halfHeight, front, gc + card.halfWidth, signY + card.halfHeight, cardFront),
    lift(NEAR.black, 0.06),
  );
  const cardFace: Face = { normal: 'z+', plane: cardFront };
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      crosshair(ctx, cardFace, gc + su * (card.halfWidth - 0.1), signY + sv * (card.halfHeight - 0.08), mark);
    }
  }
  // The card hides the aurora's core, so it is brightest where it shows: in a
  // band around the card's edge, fading out by the rim.
  const aurora = { x: gc, y: signY, rx: card.halfWidth + 0.9, ry: card.halfHeight + 0.42 };
  const inner = new Color(NEAR.green);
  const outer = mixColor(NEAR.teal, NEAR.violet, 0.5);
  const tint = new Color();
  ctx.bins.addRGBA(
    AURA,
    // Just in front of the mullions, so it washes over the frame as well.
    new RingGeometry(0, 1, 40, 6).scale(aurora.rx, aurora.ry, 1).translate(aurora.x, aurora.y, front + 0.034),
    (x, y) => {
      const r = clamp01(Math.hypot((x - aurora.x) / aurora.rx, (y - aurora.y) / aurora.ry));
      tint.copy(inner).lerp(outer, clamp01((r - 0.45) / 0.55));
      return [tint.r, tint.g, tint.b, 0.32 * clamp01((1 - r) / 0.42) ** 1.4];
    },
  );

  roofSlab(ctx, H, front, t.roof);
  parapet(ctx, H, 0.14, 0.1, steel, front);
  band(ctx, H - 0.2, H - 0.17, 0.035, line, front, doorTop, GLOW);
  ctx.bins.add(BODY, boxGeometry(ctx.x0 + 2.3, H, ctx.z0 + 0.8, ctx.x0 + 3.7, H + 0.4, ctx.z0 + 1.8), lift(NEAR.elevatedAlt, 0.08));
  // The NEAR Intents board on the roof between the pylons: black, on two
  // steel legs behind the parapet, a green line under it.
  const board = { x0: gc - 0.95, x1: gc + 0.95, y0: H + 0.28, y1: H + 0.98, z0: front - 0.32, z1: front - 0.24 };
  for (const dx of [-0.6, 0.6]) {
    ctx.bins.add(BODY, boxGeometry(gc + dx - 0.05, H, board.z0 + 0.01, gc + dx + 0.05, board.y0, board.z1 - 0.01), steel);
  }
  ctx.bins.add(BODY, boxGeometry(board.x0, board.y0, board.z0, board.x1, board.y1, board.z1), lift(NEAR.black, 0.06));
  ctx.bins.add(GLOW, boxGeometry(board.x0 + 0.04, board.y0 - 0.025, board.z1 - 0.025, board.x1 - 0.04, board.y0, board.z1), line);
  return {
    doorTop,
    sign: { x: gc, y: signY, z: zf - 0.06 },
    brand: { x: gc, y: (board.y0 + board.y1) / 2, z: board.z1 + 0.006 },
  };
}

/** A NEAR Intents crosshair: a small plus mark standing just proud of a face. */
function crosshair(ctx: BuildingCtx, face: Face, u: number, v: number, colour: number): void {
  const arm = 0.065;
  const bar = 0.018;
  ctx.bins.add(BODY, faceBox(face, u - arm, v - bar / 2, 0, u + arm, v + bar / 2, 0.008), colour);
  ctx.bins.add(BODY, faceBox(face, u - bar / 2, v - arm, 0, u + bar / 2, v + arm, 0.008), colour);
}

/**
 * Vesu (the Vault's lender, D-077), drawn from its app and its mark: a white
 * card of a building on a periwinkle plinth, tall windows of night-blue or
 * periwinkle-lit glass in rounded white frames, an ink portal round the
 * vault door between white planters, its sign as Vesu's primary button
 * (white on the electric blue), `vesu` in the wordmark's wide ink letters
 * across the attic, and the V itself standing on the roof, its bar and
 * iridescent triangle in the logo's own gradients. Blue light lines run along
 * the plinth, round the portal and under the cornice. The Vault opens on shadow
 * accounts, behind the Shell's switch (D-077): its door then stands swung
 * back in a vestibule, and nothing else changes. Locked, it is chained and
 * padlocked, as D-007's facade was.
 */
function vaultStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const H = t.height;
  const doorTop = 2.3;
  const open = ctx.fp.door !== null && !ctx.fp.door.locked;
  const front = massing(ctx, H, 0.42, doorTop, aoPaint(t.wall, 0.035), BODY, open ? VAULT_VESTIBULE : 0);
  const gc = ctx.doorCentre;
  const xa = ctx.x0 + SIDE_INSET;
  const xb = ctx.x1 - SIDE_INSET;
  const face: Face = { normal: 'z+', plane: front };
  const blueLine = lift(VESU.blue, -0.32);
  const frameTop = doorTop + 0.3;
  const signY = frameTop + 0.02 + t.sign.height / 2;

  // The plinth in Vesu's periwinkle, a blue light line along its top.
  band(ctx, 0, 0.38, 0.035, VESU.blueSoft, front, doorTop);
  band(ctx, 0.38, 0.405, 0.04, blueLine, front, doorTop, GLOW);

  // Tall windows of night-blue glass in rounded white frames edged in the
  // fill grey, as Vesu's cards sit on its page: beside the door, and down
  // both sides.
  let k = 0;
  const pane = (onFace: Face, x: number, v0: number, v1: number): void => {
    const [u0, u1] = [x - 0.3, x + 0.3];
    ctx.bins.add(BODY, facePanel(onFace, u0 - 0.1, v0 - 0.1, u1 + 0.1, v1 + 0.1, 0.012, 0.14), t.wallAlt);
    ctx.bins.add(BODY, facePanel(onFace, u0 - 0.075, v0 - 0.075, u1 + 0.075, v1 + 0.075, 0.03, 0.12), t.wall);
    const lit = isLit(ctx, k++);
    ctx.bins.add(lit ? LIT : GLASS, facePanel(onFace, u0, v0, u1, v1, 0.036, 0.08), lit ? t.windowLit : t.windowDark);
    // A slim transom low across each pane, like a card's divider.
    ctx.bins.add(BODY, faceBox(onFace, u0, v0 + 0.8, 0.036, u1, v0 + 0.83, 0.05), t.wall);
  };
  for (const run of solidRuns(ctx)) {
    const nearDoor = (x: number) => ctx.gap !== null && x > ctx.gap.x0 - 0.62 && x < ctx.gap.x1 + 0.62;
    const a = Math.max(run.x0, xa) + 0.22;
    const b = Math.min(run.x1, xb) - 0.22;
    for (const x of distribute(a, b, 0.62, 0.34)) {
      if (!nearDoor(x)) pane(face, x, 0.72, 2.62);
    }
  }
  for (const side of sideFaces(ctx)) {
    for (const z of distribute(ctx.z0 + 0.9, front - 0.7, 0.62, 0.9)) pane(side, z, 0.72, 2.62);
  }

  if (ctx.gap) {
    const g = ctx.gap;
    // Ink framing the alcove, the logo's black.
    for (const [a, b] of [
      [g.x0 - 0.26, g.x0],
      [g.x1, g.x1 + 0.26],
    ] as const) {
      ctx.bins.add(BODY, boxGeometry(a, 0, front - 0.02, b, frameTop, ctx.zf - 0.05), t.trim);
    }
    ctx.bins.add(BODY, boxGeometry(g.x0 - 0.26, doorTop, front - 0.02, g.x1 + 0.26, frameTop, ctx.zf - 0.05), t.trim);
    // A blue light line round the frame's face.
    const lineZ = ctx.zf - 0.05;
    for (const [a, b] of [
      [g.x0 - 0.2, g.x0 - 0.16],
      [g.x1 + 0.16, g.x1 + 0.2],
    ] as const) {
      ctx.bins.add(GLOW, boxGeometry(a, 0.42, lineZ - 0.005, b, frameTop - 0.06, lineZ + 0.012), blueLine);
    }
    ctx.bins.add(GLOW, boxGeometry(g.x0 - 0.2, frameTop - 0.1, lineZ - 0.005, g.x1 + 0.2, frameTop - 0.06, lineZ + 0.012), blueLine);
    if (open) openVaultDoor(ctx, g, doorTop);
    else vaultDoor(ctx, g, doorTop);
    // White planters either side of the portal, on the facade row.
    for (const [a, b] of [
      [g.x0 - 1.05, g.x0 - 0.34],
      [g.x1 + 0.34, g.x1 + 1.05],
    ] as const) {
      if (overlapsGap(ctx, a, b) || a < xa || b > xb) continue;
      const [z0, z1] = [front + 0.03, ctx.zf - 0.04];
      ctx.bins.add(BODY, boxGeometry(a, 0, z0, b, 0.46, z1), t.wall);
      ctx.bins.add(BODY, boxGeometry(a - 0.015, 0.46, z0 - 0.015, b + 0.015, 0.5, z1 + 0.01), t.wallAlt);
      const cx = (a + b) / 2;
      const cz = (z0 + z1) / 2;
      for (const dx of [-0.17, 0.15]) {
        ctx.bins.add(
          BODY,
          sphereGeometry(cx + dx, 0.64, cz, 0.19, { widthSegments: 6, heightSegments: 4, scaleY: 0.9 }),
          jitterColor(PALETTE.hedgeLight, hash01(Math.round(cx * 10), Math.round(dx * 100), 5), 0.05),
        );
      }
    }
  }

  // The attic: white, `vesu` across it, a blue line under the cornice.
  band(ctx, H - 0.14, H - 0.11, 0.03, blueLine, front, doorTop, GLOW);
  band(ctx, H - 0.11, H + 0.06, 0.05, t.wall, front, doorTop);
  roofSlab(ctx, H, front, t.roof);
  parapet(ctx, H, 0.2, 0.14, t.wall, front);
  // The parapet's rounded coping, in the fill grey.
  const za = ctx.z0 + SIDE_INSET;
  for (const [x0, z0, x1, z1] of [
    [xa, front - 0.14, xb, front],
    [xa, za, xb, za + 0.14],
    [xa, za, xa + 0.14, front],
    [xb - 0.14, za, xb, front],
  ] as const) {
    ctx.bins.add(BODY, boxGeometry(x0 - 0.015, H + 0.2, z0 - 0.015, x1 + 0.015, H + 0.24, z1 + 0.015), t.wallAlt);
  }

  // The V on the roof's front edge, facing the street on a low white base:
  // Vesu's mark as the building's crest, in the logo's own gradients (the
  // light-page art, whose ink bar reads against the sky).
  const crestSize = 2;
  const crestZ = front - 0.2;
  ctx.bins.add(BODY, boxGeometry(gc - 1.05, H + 0.2, crestZ - 0.34, gc + 1.05, H + 0.34, crestZ), t.wall);
  ctx.bins.add(BODY, boxGeometry(gc - 1.07, H + 0.34, crestZ - 0.36, gc + 1.07, H + 0.37, crestZ + 0.02), t.wallAlt);
  addVesuMark(ctx.bins, MARK, { normal: 'z+', plane: crestZ - 0.2 }, gc, H + 0.37, crestSize, 0, 0.14, 'light');

  return {
    doorTop,
    sign: { x: gc, y: signY, z: ctx.zf - 0.03 },
    brand: { x: gc, y: (signY + t.sign.height / 2 + H - 0.14) / 2, z: front + 0.02 },
  };
}

/** The vault door's ring and bolts: chrome, as the mark's bar is capped. */
const VAULT_CHROME = 0xc9ccd2;
/** Its hub: Vesu's electric blue. */
const VAULT_HUB = VESU.blue;

/** A heavy steel door with a bolt ring, chained in an X and padlocked. */
function vaultDoor(ctx: BuildingCtx, gap: Span, doorTop: number): void {
  const t = ctx.theme;
  const back = ctx.rowZ - DOOR_RECESS;
  const doorFace = ctx.rowZ - 0.1;
  const a = gap.x0 + JAMB;
  const b = gap.x1 - JAMB;
  const cx = (a + b) / 2;
  const cy = 1.2;
  ctx.bins.add(BODY, boxGeometry(a, 0, back, b, doorTop - 0.02, doorFace), t.door);
  const plane: Face = { normal: 'z+', plane: doorFace };
  ctx.bins.add(BODY, faceTorus(plane, cx, cy, 0.05, 0.62, 0.045, { tubularSegments: 18 }), VAULT_CHROME);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const u = cx + Math.cos(angle) * 0.62;
    const v = cy + Math.sin(angle) * 0.62;
    ctx.bins.add(BODY, faceBox(plane, u - 0.05, v - 0.05, 0, u + 0.05, v + 0.05, 0.1), VAULT_CHROME);
  }
  ctx.bins.add(BODY, faceDisc(plane, cx, cy, 0, 0.12, 0.08, 10), VAULT_HUB);

  // Chains in an X: alternate links lie flat and stand on edge.
  const chain = 0x4a4d52;
  const corners: ReadonlyArray<readonly [Vec3, Vec3]> = [
    [[a + 0.15, doorTop - 0.25, 0], [b - 0.15, 0.35, 0]],
    [[b - 0.15, doorTop - 0.25, 0], [a + 0.15, 0.35, 0]],
  ];
  const linkZ = doorFace + 0.055;
  for (const [start, end] of corners) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const count = Math.floor(length / 0.1);
    for (let i = 0; i <= count; i++) {
      const f = i / count;
      const link = faceTorus({ normal: 'z+', plane: 0 }, 0, 0, 0, 0.045, 0.013, { radialSegments: 4, tubularSegments: 8 });
      link.scale(1.35, 1, 1);
      if (i % 2 === 1) link.rotateX(Math.PI / 2);
      link.rotateZ(angle);
      link.translate(start[0] + dx * f, start[1] + dy * f, linkZ);
      ctx.bins.add(BODY, link, chain);
    }
  }
  // Padlock where the chains cross.
  const lockY = (doorTop - 0.25 + 0.35) / 2;
  ctx.bins.add(BODY, boxGeometry(cx - 0.13, lockY - 0.16, doorFace + 0.02, cx + 0.13, lockY + 0.1, ctx.rowZ + 0.025), t.accent);
  ctx.bins.add(BODY, faceTorus({ normal: 'z+', plane: doorFace + 0.075 }, cx, lockY + 0.1, 0, 0.085, 0.022, { arc: Math.PI, tubularSegments: 8 }), 0x8d9096);
  ctx.bins.add(BODY, boxGeometry(cx - 0.02, lockY - 0.08, ctx.rowZ + 0.025, cx + 0.02, lockY, ctx.rowZ + 0.03), 0x151515);
}

/** How far the opened Vault's doorway runs into the building, over its solid wall rows (D-077). */
const VAULT_VESTIBULE = 2;
/** How far the opened Vault's door stands swung in on its hinge. */
const VAULT_DOOR_SWING = (65 * Math.PI) / 180;
/** The door's thickness once it shows its edge: heavy, as a vault door is. */
const VAULT_DOOR_THICKNESS = 0.24;

/**
 * The Vault opened (D-077): the same heavy steel door and bolt ring, swung
 * in on its east hinge against the vestibule's wall with its locking bolts
 * run out of the free edge, so the doorway is clear to walk into. Beyond it
 * the lender's light: a white floor and a periwinkle far wall, washed in
 * Vesu's blue. No chains and no padlock. Everything stands behind the
 * alcove, on the building's solid wall rows.
 */
function openVaultDoor(ctx: BuildingCtx, gap: Span, doorTop: number): void {
  const t = ctx.theme;
  const mouth = ctx.rowZ - DOOR_RECESS;
  const back = mouth - VAULT_VESTIBULE;
  const light = new Color(t.openPortal ?? t.portal);
  const floor = PAVEMENT_HEIGHT;
  ctx.bins.add(BODY, boxGeometry(gap.x0, 0, back, gap.x1, floor, ctx.rowZ), VESU.white);
  ctx.bins.add(BODY, boxGeometry(gap.x0, floor, back, gap.x1, doorTop, back + 0.02), VESU.blueSoft);
  ctx.bins.addRGBA(AURA, faceQuad({ normal: 'z+', plane: back + 0.025 }, gap.x0, floor, gap.x1, doorTop, 0), (_x, y) => [
    light.r,
    light.g,
    light.b,
    0.5 * Math.pow(1 - clamp01((y - floor) / (doorTop - floor)), 1.3),
  ]);
  ctx.bins.addRGBA(AURA, flatQuad(gap.x0, back, gap.x1, mouth, floor + 0.004), (_x, _y, z) => [
    light.r,
    light.g,
    light.b,
    0.35 * clamp01((mouth - z) / VAULT_VESTIBULE),
  ]);

  const a = gap.x0 + JAMB;
  const b = gap.x1 - JAMB;
  // The steel sill the door closes on, across the doorway's mouth.
  ctx.bins.add(BODY, boxGeometry(a, floor, mouth - 0.06, b, floor + 0.03, mouth + 0.06), t.trim);
  // The leaf in its own frame: the hinge on the local z axis, the free edge
  // at -w, the street face at +T. Swung about the hinge at the east jamb.
  const w = b - a;
  const T = VAULT_DOOR_THICKNESS;
  const swing = new Matrix4().makeRotationY(-VAULT_DOOR_SWING).setPosition(b, 0, mouth);
  const leaf = (geometry: BufferGeometry, paint: number): void => ctx.bins.add(BODY, geometry.applyMatrix4(swing), paint);
  const cu = -w / 2;
  const cv = 1.2;
  leaf(boxGeometry(-w, floor + 0.005, 0, 0, doorTop - 0.02, T), t.door);
  const face: Face = { normal: 'z+', plane: T };
  leaf(faceTorus(face, cu, cv, 0.05, 0.62, 0.045, { tubularSegments: 18 }), VAULT_CHROME);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const u = cu + Math.cos(angle) * 0.62;
    const v = cv + Math.sin(angle) * 0.62;
    leaf(faceBox(face, u - 0.05, v - 0.05, 0, u + 0.05, v + 0.05, 0.1), VAULT_CHROME);
  }
  leaf(faceDisc(face, cu, cv, 0, 0.12, 0.08, 10), VAULT_HUB);
  const edge: Face = { normal: 'z+', plane: 0 };
  for (const v of [0.55, 1.2, 1.85]) leaf(facePipe(edge, -w - 0.12, -w + 0.02, v, T / 2, 0.05, 8), 0x9ea3ab);
  // The heavy hinge knuckles, on the east jamb.
  for (const y of [0.4, 1.6]) ctx.bins.add(BODY, cylinderGeometry(b + 0.04, y, mouth, 0.07, 0.07, 0.34, 10), t.trim);
}

function genericStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const H = t.height;
  const doorTop = 2.2;
  const front = massing(ctx, H, 0.2, doorTop, aoPaint(t.wall));
  const gc = ctx.doorCentre;
  if (ctx.gap) doubleDoor(ctx, ctx.gap, doorTop);
  band(ctx, 0, 0.3, 0.03, t.wallAlt, front, doorTop);
  const face: Face = { normal: 'z+', plane: front };
  let k = 0;
  for (const run of solidRuns(ctx)) {
    for (const x of distribute(run.x0 + 0.25, run.x1 - 0.25, 0.6, 0.4)) {
      windowOnFace(ctx, face, x, 0.8, 0.6, 1.0, isLit(ctx, k++), { mullion: true });
    }
  }
  const signHalf = t.sign.width / 2 + 0.2;
  for (const [a, b] of [
    [ctx.x0 + 0.3, gc - signHalf],
    [gc + signHalf, ctx.x1 - 0.3],
  ] as const) {
    for (const x of distribute(a, b, 0.6, 0.4)) windowOnFace(ctx, face, x, 2.7, 0.6, 0.8, isLit(ctx, k++), { mullion: true });
  }
  band(ctx, H - 0.2, H + 0.05, 0.08, t.trim, front, doorTop);
  roofSlab(ctx, H, front, t.roof);
  return { doorTop, sign: { x: gc, y: 3.0, z: front + 0.03 } };
}

/** Irregular footprints: honest per-row blocks and nothing that could cover a walkable tile. */
function fallbackStyle(ctx: BuildingCtx): StyleResult {
  const t = ctx.theme;
  const { fp } = ctx;
  for (let y = fp.minY; y < fp.maxY; y++) {
    let start = -1;
    for (let x = fp.minX; x <= fp.maxX; x++) {
      const solid = x < fp.maxX && fp.hasTile(x, y);
      if (solid && start < 0) start = x;
      if (!solid && start >= 0) {
        ctx.bins.add(BODY, boxGeometry(start, 0, y, x, t.height, y + 1), aoPaint(t.wall));
        start = -1;
      }
    }
  }
  return {
    doorTop: 2.2,
    sign: { x: fp.label?.x ?? (fp.minX + fp.maxX) / 2, y: Math.min(t.height - 0.5, 2.9), z: fp.maxY + 0.02 },
  };
}

// ---------------------------------------------------------------------------
// Door portals
// ---------------------------------------------------------------------------

function buildDoorPortal(
  door: DoorZone,
  built: BuiltBuilding | undefined,
  res: ResourceBag,
): { group: Group; animate: Animator } {
  const group = new Group();
  group.name = `door:${door.building}`;
  group.userData['building'] = door.building;
  group.userData['locked'] = door.locked;
  group.userData['kind'] = 'door-portal';
  group.position.set(door.x + door.width / 2, 0, door.y + door.height / 2);

  const theme = buildingTheme(door.building);
  // A door that ships locked glows in its own colour once the Shell opens it:
  // the Vault's lender's blue (D-077). Every other door keeps its portal.
  const portal = door.locked ? theme.portal : theme.openPortal ?? theme.portal;
  const colour = new Color(portal);
  const doorTop = built?.doorTop ?? 2.3;
  const half = door.width / 2;
  // The door stands at the back of the zone: the facade row's north edge.
  const dz = -door.height / 2;
  const base = door.locked ? 0.6 : theme.portalIntensity ?? 1.8;
  const frameMaterial = res.material(
    standardMaterial({ color: 0x1d1a17, vertexColors: false, emissive: portal, emissiveIntensity: base }),
  );
  const lightMaterial = res.material(unlitMaterial({ additive: true }));
  const bin = new GeometryBin();
  try {
    bin.add('frame', boxGeometry(-half + 0.03, 0, dz - 0.01, -half + 0.09, doorTop, dz + 0.03), 0xffffff);
    bin.add('frame', boxGeometry(half - 0.09, 0, dz - 0.01, half - 0.03, doorTop, dz + 0.03), 0xffffff);
    bin.add('frame', boxGeometry(-half + 0.03, doorTop - 0.06, dz - 0.01, half - 0.03, doorTop, dz + 0.03), 0xffffff);
    const curtain = door.locked ? 0.2 : 0.5;
    const top = doorTop - 0.06;
    bin.addRGBA('light', faceQuad({ normal: 'z+', plane: dz + 0.035 }, -half + 0.12, 0.02, half - 0.12, top, 0), (_x, y) => [
      colour.r,
      colour.g,
      colour.b,
      curtain * Math.pow(1 - clamp01(y / top), 1.4),
    ]);
    const spill = door.locked ? 0.18 : 0.42;
    const reach = 1.9;
    bin.addRGBA(
      'light',
      flatPolygon(
        [
          [-half + 0.02, dz + 0.02],
          [half - 0.02, dz + 0.02],
          [half + 0.45, dz + reach],
          [-half - 0.45, dz + reach],
        ],
        PAVEMENT_HEIGHT + 0.008,
      ),
      (_x, _y, z) => [colour.r, colour.g, colour.b, spill * Math.pow(1 - clamp01((z - dz) / reach), 1.6)],
    );
    flushBin(bin, 'frame', frameMaterial, res, group, { name: `${group.name}:frame` });
    flushBin(bin, 'light', lightMaterial, res, group, { name: `${group.name}:light`, renderOrder: 2 });
  } finally {
    bin.dispose();
  }
  // The frame breathes by a quarter of its strength, locked or open.
  const amplitude = 0.25 * base;
  const speed = door.locked ? 0.8 : 2.2;
  const phase = hash01(door.x, door.y, 5) * Math.PI * 2;
  return {
    group,
    animate: (elapsed) => {
      const s = Math.sin((elapsed / 1000) * speed + phase);
      frameMaterial.emissiveIntensity = base + amplitude * s;
      lightMaterial.opacity = 0.82 + 0.18 * s;
    },
  };
}

// ---------------------------------------------------------------------------
// Decor: volumes only outside the map, or on the sandbox wall's solid tiles
// ---------------------------------------------------------------------------

function buildDecor(
  map: DistrictMap,
  kinds: GroundKind[][],
  res: ResourceBag,
  parent: Group,
  animators: Animator[],
  sandboxSign: { x: number; y: number; z: number } | null,
  gate: Gate | null,
): GateOccluder | null {
  const west = edgeBand(map, kinds, 'west');
  const east = edgeBand(map, kinds, 'east');
  const plate = plateBounds(kinds);
  const bin = new GeometryBin();
  let gateOccluder: GateOccluder | null = null;
  try {
    hedges(map, west, east, bin);
    if (west) barriers(-0.6, west, bin);
    if (east) barriers(map.width + 0.6, east, bin);
    if (sandboxSign) signPosts(sandboxSign, bin);
    southBushes(map, bin);
    backdropCity(map, bin);
    hills(map, bin);
    studioArch(map, bin);
    sandboxWall(map, gate, bin);

    const decorMaterial = res.material(standardMaterial({ roughness: 0.9 }));
    const farMaterial = res.material(standardMaterial({ roughness: 0.95 }));
    const farWindows = res.material(
      standardMaterial({ roughness: 0.6, emissive: PALETTE.backdropWindow, emissiveIntensity: 0.9 }),
    );
    const fairy = res.material(unlitMaterial());
    const archGlow = res.material(unlitMaterial({ additive: true }));
    flushBin(bin, 'decor', decorMaterial, res, parent, { name: 'street:decor', cast: true, receive: true });
    if (gate) gateOccluder = flushGate(bin, gate, res, parent);
    flushBin(bin, 'far', farMaterial, res, parent, { name: 'street:backdrop' });
    flushBin(bin, 'far-lit', farWindows, res, parent, { name: 'street:backdrop-windows' });
    flushBin(bin, 'fairy', fairy, res, parent, { name: 'street:fairy-lights' });
    flushBin(bin, 'arch-glow', archGlow, res, parent, { name: 'street:arch-glow', renderOrder: 2 });
    animators.push((elapsed) => {
      fairy.color.setScalar(0.78 + 0.22 * Math.sin((elapsed / 1000) * 2.6));
      archGlow.opacity = 0.7 + 0.3 * Math.sin((elapsed / 1000) * 1.3);
    });
  } finally {
    bin.dispose();
  }
  trees(map, west, east, sandboxSign, res, parent);
  lamps(map, west, east, plate, sandboxSign, res, parent);
  return gateOccluder;
}

/** Two posts carrying the sandbox sign, off the map behind the hedge. */
function signPosts(sign: { x: number; y: number; z: number }, bin: GeometryBin): void {
  const half = SANDBOX_THEME.sign.width / 2 - 0.25;
  for (const dx of [-half, half]) {
    bin.add('decor', boxGeometry(sign.x + dx - 0.06, 0, sign.z - 0.12, sign.x + dx + 0.06, sign.y + 0.5, sign.z - 0.02), SANDBOX_THEME.post);
  }
  bin.add('decor', boxGeometry(sign.x - half - 0.1, sign.y + 0.5, sign.z - 0.13, sign.x + half + 0.1, sign.y + 0.6, sign.z - 0.01), SANDBOX_THEME.post);
}

type Band = { top: number; bottom: number } | null;

function hedgeRun(bin: GeometryBin, x0: number, z0: number, x1: number, z1: number, height: number, seed: number): void {
  const alongX = x1 - x0 >= z1 - z0;
  const length = alongX ? x1 - x0 : z1 - z0;
  if (length <= 0.05) return;
  const count = Math.max(1, Math.round(length / 1.6));
  for (let i = 0; i < count; i++) {
    const a = i / count;
    const b = (i + 1) / count;
    const h = height * (0.92 + 0.16 * hash01(i, seed, 31));
    const colour = jitterColor(hash01(i, seed, 32) < 0.5 ? PALETTE.hedge : PALETTE.hedgeLight, hash01(i, seed, 33), 0.03);
    const [sa, sb, ta, tb] = alongX
      ? [x0 + (x1 - x0) * a, x0 + (x1 - x0) * b, z0, z1]
      : [z0 + (z1 - z0) * a, z0 + (z1 - z0) * b, x0, x1];
    const body = alongX ? boxGeometry(sa, 0, ta, sb, h, tb) : boxGeometry(ta, 0, sa, tb, h, sb);
    bin.add('decor', body, colour);
    const cap = alongX
      ? boxGeometry(sa + 0.04, h, ta + 0.08, sb - 0.04, h + 0.12, tb - 0.08)
      : boxGeometry(ta + 0.08, h, sa + 0.04, tb - 0.08, h + 0.12, sb - 0.04);
    bin.add('decor', cap, shade(colour, 0.03));
  }
}

function hedges(map: DistrictMap, west: Band, east: Band, bin: GeometryBin): void {
  const W = map.width;
  const H = map.height;
  const entrance = map.avatarStudioEntrance;
  hedgeRun(bin, -1, -1, W + 1, -0.15, 0.95, 1);
  hedgeRun(bin, -1, H + 0.15, entrance.x - 0.65, H + 0.8, 0.55, 2);
  hedgeRun(bin, entrance.x + entrance.width + 0.65, H + 0.15, W + 1, H + 0.8, 0.55, 3);
  for (const [x0, x1, seed, band] of [
    [-1, -0.15, 4, west],
    [W + 0.15, W + 1, 6, east],
  ] as const) {
    if (band) {
      hedgeRun(bin, x0, -0.15, x1, band.top - 0.1, 0.95, seed);
      hedgeRun(bin, x0, band.bottom + 0.1, x1, H + 0.15, 0.75, seed + 1);
    } else {
      hedgeRun(bin, x0, -0.15, x1, H + 0.15, 0.9, seed);
    }
  }
}

/** Road-closed barriers where the street runs off the map (the west end only, now). */
function barriers(x: number, band: { top: number; bottom: number }, bin: GeometryBin): void {
  const za = band.top + 0.15;
  const zb = band.bottom - 0.15;
  const count = Math.max(2, Math.round((zb - za) / 0.45));
  for (let i = 0; i < count; i++) {
    const a = za + ((zb - za) * i) / count;
    const b = za + ((zb - za) * (i + 1)) / count;
    bin.add('decor', boxGeometry(x - 0.05, 0.52, a, x + 0.05, 0.78, b), i % 2 === 0 ? PALETTE.barrierRed : PALETTE.barrierWhite);
  }
  for (let z = za + 0.3; z < zb; z += 1.6) {
    bin.add('decor', beamGeometry([x - 0.25, 0, z], [x, 0.8, z], 0.05, 0.05), 0x55595e);
    bin.add('decor', beamGeometry([x + 0.25, 0, z], [x, 0.8, z], 0.05, 0.05), 0x55595e);
    bin.add('fairy', sphereGeometry(x, 0.86, z, 0.06, { widthSegments: 6, heightSegments: 4 }), 0xffb347);
  }
}

function southBushes(map: DistrictMap, bin: GeometryBin): void {
  const H = map.height;
  const entrance = map.avatarStudioEntrance;
  for (let z = H + 1.3; z < H + 5.5; z += 1.4) {
    for (let x = -8; x < map.width + 8; x += 1.6) {
      const seed = hash01(Math.round(x * 10), Math.round(z * 10), 61);
      if (seed < 0.55) continue;
      const px = x + hash01(Math.round(x * 10), Math.round(z * 10), 62) * 0.8;
      const pz = z + hash01(Math.round(x * 10), Math.round(z * 10), 63) * 0.6;
      if (pz < H + 3.2 && px > entrance.x - 2 && px < entrance.x + entrance.width + 2) continue;
      const r = 0.35 + hash01(Math.round(x * 10), Math.round(z * 10), 64) * 0.25;
      const bush = new IcosahedronGeometry(r, 0).scale(1, 0.65, 1).translate(px, r * 0.4, pz);
      bin.add('decor', bush, jitterColor(pick([PALETTE.hedge, PALETTE.hedgeLight, PALETTE.tuft], seed), seed, 0.04));
    }
  }
}

/** The hidden Studio's only marker: a hedge arch with fairy lights, just off the map. */
function studioArch(map: DistrictMap, bin: GeometryBin): void {
  const entrance = map.avatarStudioEntrance;
  const H = map.height;
  const xa = entrance.x;
  const xb = entrance.x + entrance.width;
  const z0 = H + 0.08;
  const z1 = H + 0.62;
  const zc = (z0 + z1) / 2;
  const top = 1.85;
  bin.add('decor', boxGeometry(xa - 0.62, 0, z0, xa - 0.04, top, z1), PALETTE.hedge);
  bin.add('decor', boxGeometry(xb + 0.04, 0, z0, xb + 0.62, top, z1), PALETTE.hedge);
  const cx = (xa + xb) / 2;
  const rx = (xb - xa) / 2 + 0.33;
  const ry = 0.75;
  const segments = 7;
  for (let i = 0; i < segments; i++) {
    const ta = Math.PI - (Math.PI * i) / segments;
    const tb = Math.PI - (Math.PI * (i + 1)) / segments;
    const pa: Vec3 = [cx + rx * Math.cos(ta), top + ry * Math.sin(ta), zc];
    const pb: Vec3 = [cx + rx * Math.cos(tb), top + ry * Math.sin(tb), zc];
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const len = Math.hypot(dx, dy);
    const ex = (dx / len) * 0.12;
    const ey = (dy / len) * 0.12;
    bin.add(
      'decor',
      beamGeometry([pa[0] - ex, pa[1] - ey, zc], [pb[0] + ex, pb[1] + ey, zc], z1 - z0, 0.5),
      jitterColor(PALETTE.hedge, hash01(i, 4, 97), 0.03),
    );
  }
  for (let i = 0; i <= 12; i++) {
    const angle = Math.PI - (Math.PI * i) / 12;
    const x = cx + (rx - 0.27) * Math.cos(angle);
    const y = top + (ry - 0.2) * Math.sin(angle);
    bin.add('fairy', sphereGeometry(x, y, z1 + 0.03, 0.045, { widthSegments: 5, heightSegments: 3 }), i % 3 === 0 ? 0xffd9a0 : PALETTE.fairyLight);
  }
  for (const x of [xa - 0.02, xb + 0.02]) {
    for (let y = 0.35; y < top; y += 0.35) {
      bin.add('fairy', sphereGeometry(x, y, z1 + 0.03, 0.04, { widthSegments: 5, heightSegments: 3 }), PALETTE.fairyLight);
    }
  }
  const glow = new Color(0xffe3a8);
  bin.addRGBA('arch-glow', flatPolygon([[xa, H + 0.01], [xb, H + 0.01], [xb + 0.3, H + 0.9], [xa - 0.3, H + 0.9]], 0.02), (_x, _y, z) => [
    glow.r,
    glow.g,
    glow.b,
    0.28 * (1 - clamp01((z - H) / 0.9)),
  ]);
}

/** `SANDBOX_THEME.blocks` indices: the cream the wall is laid in, and its accents. */
const TOY_CREAM = 7;
const TOY_BLUE = 5;
/** The top course's accents, every third block out from the gate: yellow, red, blue. */
const WALL_ACCENTS: readonly number[] = [2, 0, TOY_BLUE];
/** Bin key for the gate's superstructure: everything above the wall, in its own fading mesh. */
const GATE_TOP = 'gate';

function toyColour(index: number, seed: number): Color {
  return jitterColor(SANDBOX_THEME.blocks[index] ?? SANDBOX_THEME.plate, seed, 0.012);
}

/** One toy block centred on (x, y, z); a non-unit scale squashes it into a slab. */
function toyBlock(
  bin: GeometryBin,
  key: string,
  x: number,
  y: number,
  z: number,
  colour: Paint,
  scale: Vec3 = [1, 1, 1],
): void {
  bin.add(key, bevelledBlockGeometry(1, TOY_BEVEL).scale(scale[0], scale[1], scale[2]).translate(x, y, z), colour);
}

/**
 * The sandbox square's wall (D-060), in the toy blocks players stack: two
 * high on every fence tile, four at the gate's pillars. Every volume stands
 * on a solid fence tile; only the lintel, its caps and its lights reach over
 * the opening, all above head height. The wall is decor; what rises above it
 * at the gate is the superstructure, which fades (see `flushGate`).
 */
function sandboxWall(map: DistrictMap, gate: Gate | null, bin: GeometryBin): void {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (kindAt(map, x, y) !== 'fence') continue;
      // Blocks out from the gate along the wall; 0 is a pillar.
      const out = gate && x === gate.x ? (y < gate.z0 ? gate.z0 - 1 - y : y - gate.z1) : y + 1;
      const courses = out === 0 ? PILLAR_BLOCKS : WALL_BLOCKS;
      for (let k = 0; k < courses; k++) {
        const key = k < WALL_BLOCKS ? 'decor' : GATE_TOP;
        toyBlock(bin, key, x + 0.5, k + 0.5, y + 0.5, toyColour(wallBlockColour(out, k), hash01(x, y * 8 + k, 601)));
      }
    }
  }
  if (gate) gateLintel(gate, bin);
}

/**
 * The gate's superstructure as its own mesh and material, so that when the
 * pillar tops or the lintel come between the camera and the player it fades
 * the way a building does, and the wall beside it does not. It is solid only
 * in three boxes sharing one fader: the two pillar tops, from the wall's
 * height, and the lintel with its caps, from its underside. A sight line
 * through the open gap between them, from the street or the apron, is clear.
 */
function flushGate(bin: GeometryBin, gate: Gate, res: ResourceBag, parent: Group): GateOccluder | null {
  if (!bin.has(GATE_TOP)) return null;
  const material = res.material(standardMaterial({ roughness: 0.9 }));
  const mesh = flushBin(bin, GATE_TOP, material, res, parent, { name: 'street:sandbox-gate', cast: true, receive: true });
  if (!mesh) return null;
  const box = new Box3().setFromObject(mesh);
  const pillar = (z: number): OccluderBounds =>
    Object.freeze({ minX: gate.x, maxX: gate.x + 1, minZ: z, maxZ: z + 1, minY: WALL_BLOCKS, height: PILLAR_BLOCKS });
  const lintel: OccluderBounds = Object.freeze({
    minX: box.min.x,
    maxX: box.max.x,
    minZ: box.min.z,
    maxZ: box.max.z,
    minY: PILLAR_BLOCKS,
    height: box.max.y,
  });
  const occluder: GateOccluder = Object.freeze({
    kind: 'sandbox-gate',
    object: mesh,
    bounds: Object.freeze({ ...lintel, minY: box.min.y }),
    boxes: Object.freeze([pillar(gate.z0 - 1), pillar(gate.z1), lintel]),
    setOpacity: createOpacityFader([material]),
  });
  return occluder;
}

/**
 * Mostly cream. A pillar's top block, its capital, is the sign's blue; on the
 * wall's top course every third block out from the gate is an accent, in the
 * same order both ways, so the colour reads as laid rather than spilled.
 */
function wallBlockColour(out: number, course: number): number {
  if (out === 0) return course === PILLAR_BLOCKS - 1 ? TOY_BLUE : TOY_CREAM;
  if (course !== WALL_BLOCKS - 1 || out % 3 !== 0) return TOY_CREAM;
  return WALL_ACCENTS[(out / 3 - 1) % WALL_ACCENTS.length]!;
}

/**
 * A course of blocks across the pillar tops, capped over each pillar, with a
 * festoon of fairy lights along both edges. Its underside is `PILLAR_BLOCKS`
 * high over the whole opening; the festoons dip a little below it.
 */
function gateLintel(gate: Gate, bin: GeometryBin): void {
  const cx = gate.x + 0.5;
  for (let z = gate.z0 - 1; z <= gate.z1; z++) {
    toyBlock(bin, GATE_TOP, cx, PILLAR_BLOCKS + 0.5, z + 0.5, toyColour(TOY_CREAM, hash01(gate.x, z, 602)));
  }
  for (const z of [gate.z0 - 1, gate.z1]) {
    const cap = toyColour(TOY_CREAM, hash01(gate.x, z, 603));
    toyBlock(bin, GATE_TOP, cx, PILLAR_BLOCKS + 1.12, z + 0.5, cap, [1.12, 0.24, 1.12]);
  }
  // On each side two swags, pillar to pillar, meeting under the sign.
  const top = PILLAR_BLOCKS - 0.06;
  const span = (gate.z1 - gate.z0) / 2;
  const count = Math.max(2, Math.round(span / 0.4));
  for (const x of [gate.x - 0.07, gate.x + 1.07]) {
    for (let i = 0; i <= count * 2; i++) {
      const s = (i % count) / count;
      const y = top - 0.26 * 4 * s * (1 - s);
      bin.add(
        'fairy',
        sphereGeometry(x, y, gate.z0 + (i / count) * span, 0.045, { widthSegments: 5, heightSegments: 3 }),
        i % 3 === 0 ? 0xffd9a0 : PALETTE.fairyLight,
      );
    }
  }
}

const scratchMatrix = new Matrix4();
const scratchQuat = new Quaternion();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const UP = new Vector3(0, 1, 0);

interface TreeSpot {
  readonly x: number;
  /** The ground under it: 0, or a hill's slope in a backdrop park. */
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly yaw: number;
  readonly pine: boolean;
  readonly seed: number;
}

/** Groves off the map's east, west and far south edges, and the backdrop's parks, instanced per part. */
function trees(
  map: DistrictMap,
  west: Band,
  east: Band,
  sign: { x: number; y: number; z: number } | null,
  res: ResourceBag,
  parent: Group,
): void {
  const W = map.width;
  const H = map.height;
  const spots: TreeSpot[] = [];
  const push = (x: number, z: number, seed: number, y = 0): void => {
    spots.push({
      x,
      y,
      z,
      scale: 0.8 + hash01(seed, 1, 101) * 0.55,
      yaw: hash01(seed, 2, 101) * Math.PI * 2,
      pine: hash01(seed, 3, 101) < 0.35,
      seed,
    });
  };
  let seed = 1;
  for (const side of [-1, 1] as const) {
    for (let gz = -12; gz <= H + 14; gz += 2.7) {
      for (let gx = 0; gx < 4; gx++) {
        seed++;
        if (hash01(seed, 0, 102) < 0.3) continue;
        const offset = 3.4 + gx * 2.6 + hash01(seed, 4, 102) * 1.2;
        const x = side < 0 ? -offset : W + offset;
        const z = gz + (hash01(seed, 5, 102) - 0.5) * 1.6;
        const band = side < 0 ? west : east;
        if (band && gx < 3 && z > band.top - 1.5 && z < band.bottom + 1.5) continue;
        push(x, z, seed);
      }
    }
  }
  for (let x = 1; x < W; x += 3.3) {
    seed++;
    if (hash01(seed, 0, 103) < 0.25) continue;
    if (sign && Math.abs(x - sign.x) < SANDBOX_THEME.sign.width / 2 + 1.6) continue;
    push(x + (hash01(seed, 1, 103) - 0.5) * 1.2, -2.2 + (hash01(seed, 2, 103) - 0.5) * 0.3, seed);
  }
  for (let gz = H + 10; gz < H + 18; gz += 2.8) {
    for (let x = -10; x < W + 10; x += 2.9) {
      seed++;
      if (hash01(seed, 0, 104) < 0.45) continue;
      push(x + hash01(seed, 1, 104) * 1.2, gz + hash01(seed, 2, 104) * 1.2, seed);
    }
  }
  for (const tree of backdropTrees(map)) push(tree.x, tree.z, tree.seed, tree.y);

  const round = spots.filter((spot) => !spot.pine);
  const pines = spots.filter((spot) => spot.pine);
  const trunkGeometry = res.geometry(new CylinderGeometry(0.09, 0.13, 1, 6).translate(0, 0.5, 0));
  const canopyGeometry = res.geometry(new IcosahedronGeometry(1, 0));
  const pineGeometry = res.geometry(new ConeGeometry(1, 1, 7).translate(0, 0.5, 0));
  const trunkMaterial = res.material(standardMaterial({ color: PALETTE.trunk, vertexColors: false }));
  const leafMaterial = res.material(standardMaterial({ color: 0xffffff, vertexColors: false, roughness: 0.9 }));

  const trunks = res.disposable(new InstancedMesh(trunkGeometry, trunkMaterial, Math.max(1, spots.length)));
  trunks.name = 'street:tree-trunks';
  trunks.castShadow = true;
  spots.forEach((spot, i) => {
    const height = (spot.pine ? 0.6 : 1.1) * spot.scale;
    scratchQuat.setFromAxisAngle(UP, spot.yaw);
    scratchMatrix.compose(scratchPosition.set(spot.x, spot.y, spot.z), scratchQuat, scratchScale.set(spot.scale, height, spot.scale));
    trunks.setMatrixAt(i, scratchMatrix);
  });
  trunks.count = spots.length;

  const canopies = res.disposable(new InstancedMesh(canopyGeometry, leafMaterial, Math.max(1, round.length)));
  canopies.name = 'street:tree-canopies';
  canopies.castShadow = true;
  round.forEach((spot, i) => {
    const r = 1.05 * spot.scale;
    scratchQuat.setFromAxisAngle(UP, spot.yaw);
    scratchMatrix.compose(scratchPosition.set(spot.x, spot.y + 1.1 * spot.scale + r * 0.55, spot.z), scratchQuat, scratchScale.set(r, r * 0.9, r));
    canopies.setMatrixAt(i, scratchMatrix);
    const autumn = hash01(spot.seed, 6, 105) < 0.12;
    canopies.setColorAt(
      i,
      jitterColor(autumn ? PALETTE.canopies[4]! : pick(PALETTE.canopies.slice(0, 4), hash01(spot.seed, 7, 105)), hash01(spot.seed, 8, 105), 0.04),
    );
  });
  canopies.count = round.length;

  const cones = res.disposable(new InstancedMesh(pineGeometry, leafMaterial, Math.max(1, pines.length * 2)));
  cones.name = 'street:pine-canopies';
  cones.castShadow = true;
  pines.forEach((spot, i) => {
    const s = spot.scale;
    const colour = jitterColor(pick(PALETTE.pines, hash01(spot.seed, 9, 105)), hash01(spot.seed, 10, 105), 0.04);
    scratchQuat.setFromAxisAngle(UP, spot.yaw);
    scratchMatrix.compose(scratchPosition.set(spot.x, spot.y + 0.5 * s, spot.z), scratchQuat, scratchScale.set(0.95 * s, 1.6 * s, 0.95 * s));
    cones.setMatrixAt(i * 2, scratchMatrix);
    cones.setColorAt(i * 2, colour);
    scratchMatrix.compose(scratchPosition.set(spot.x, spot.y + 1.35 * s, spot.z), scratchQuat, scratchScale.set(0.68 * s, 1.3 * s, 0.68 * s));
    cones.setMatrixAt(i * 2 + 1, scratchMatrix);
    cones.setColorAt(i * 2 + 1, shade(colour, 0.03));
  });
  cones.count = pines.length * 2;

  for (const mesh of [trunks, canopies, cones]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    parent.add(mesh);
  }
}

/** Street lamps where the road runs off the map, and around the sandbox square. */
function lamps(
  map: DistrictMap,
  west: Band,
  east: Band,
  plate: { minX: number; maxX: number; minY: number; maxY: number } | null,
  sign: { x: number; y: number; z: number } | null,
  res: ResourceBag,
  parent: Group,
): void {
  const W = map.width;
  const spots: { x: number; z: number; yaw: number }[] = [];
  for (let k = 0; k < 4; k++) {
    if (west) {
      spots.push({ x: -3 - k * 6.5, z: west.top + 0.3, yaw: 0 });
      spots.push({ x: -3 - k * 6.5, z: west.bottom - 0.3, yaw: Math.PI });
    }
    if (east) {
      spots.push({ x: W + 3 + k * 6.5, z: east.top + 0.3, yaw: 0 });
      spots.push({ x: W + 3 + k * 6.5, z: east.bottom - 0.3, yaw: Math.PI });
    }
  }
  if (plate) {
    // Behind the north hedge facing south, and beyond the east hedge facing west.
    if (plate.minY === 0) {
      for (let x = plate.minX + 2.5; x < plate.maxX - 1; x += 6.5) {
        if (sign && Math.abs(x - sign.x) < SANDBOX_THEME.sign.width / 2 + 0.8) continue;
        spots.push({ x, z: -1.45, yaw: 0 });
      }
    }
    if (plate.maxX === W) {
      for (let z = plate.minY + 3.5; z < plate.maxY - 1; z += 7) spots.push({ x: W + 1.45, z, yaw: -Math.PI / 2 });
    }
  }
  if (spots.length === 0) return;
  const bin = new GeometryBin();
  let postGeometry: ReturnType<GeometryBin['take']> = null;
  try {
    const dark = PALETTE.lampPost;
    bin.add('post', cylinderGeometry(0, 0, 0, 0.1, 0.12, 0.18, 8), dark);
    bin.add('post', cylinderGeometry(0, 0.18, 0, 0.045, 0.055, 2.55, 6), dark);
    bin.add('post', beamGeometry([0, 2.62, -0.02], [0, 2.72, 0.46], 0.04, 0.04), dark);
    bin.add('post', boxGeometry(-0.13, 2.7, 0.33, 0.13, 2.76, 0.59), dark);
    postGeometry = bin.take('post');
  } finally {
    bin.dispose();
  }
  if (!postGeometry) return;
  res.geometry(postGeometry);
  const headGeometry = res.geometry(boxGeometry(-0.1, 2.56, 0.36, 0.1, 2.7, 0.56));
  const postMaterial = res.material(standardMaterial({ roughness: 0.6 }));
  const headMaterial = res.material(unlitMaterial({ color: PALETTE.lampGlow, vertexColors: false }));
  const posts = res.disposable(new InstancedMesh(postGeometry, postMaterial, spots.length));
  const heads = res.disposable(new InstancedMesh(headGeometry, headMaterial, spots.length));
  posts.name = 'street:lamp-posts';
  heads.name = 'street:lamp-heads';
  posts.castShadow = true;
  spots.forEach((spot, i) => {
    scratchQuat.setFromAxisAngle(UP, spot.yaw);
    scratchMatrix.compose(scratchPosition.set(spot.x, 0, spot.z), scratchQuat, scratchScale.set(1, 1, 1));
    posts.setMatrixAt(i, scratchMatrix);
    heads.setMatrixAt(i, scratchMatrix);
  });
  for (const mesh of [posts, heads]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    parent.add(mesh);
  }
}
