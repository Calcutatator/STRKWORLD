import { Color, type BufferGeometry, type Group, type Material, type Mesh, type Object3D } from 'three';
import {
  COLOSSEUM_AREA,
  COLOSSEUM_DOOR,
  COLOSSEUM_GATEPOSTS,
  COLOSSEUM_TORCHES,
} from '../map/colosseum.js';
import type { DistrictMap, TileKind } from '../map/street.js';
import {
  COLOSSEUM_ARCADE_TOP,
  COLOSSEUM_ARCH_SPRING,
  COLOSSEUM_ATTIC_TOP,
  COLOSSEUM_EMBER,
  COLOSSEUM_PLINTH,
  COLOSSEUM_STONE,
  COLOSSEUM_WALL_TOP,
} from './colosseum-style.js';
import type { SignStyleOptions } from './labels.js';
import {
  GeometryBin,
  ResourceBag,
  boxGeometry,
  clamp01,
  coneGeometry,
  createOpacityFader,
  cylinderGeometry,
  faceBox,
  faceDisc,
  faceQuad,
  flatQuad,
  flushBin,
  hash01,
  mixHex,
  prismX,
  shade,
  standardMaterial,
  unlitMaterial,
  type Face,
  type Point2,
} from './palette.js';
import type { LabelFactory, Occluder, OccluderBounds, TextLabel } from './types.js';

/**
 * The Colosseum in 3D (D-114, D-129): the stadium on the south lawn, the
 * building the arena room is the inside of.
 *
 * It replaced the sunken gladiator pit that stood on this lot, which read as
 * a hole in the grass while the room behind its arch was a five-tier
 * stadium. Nothing a walker can feel changed: the same footprint, the same
 * three-tile door on the west front, the same branch path and the same
 * return tile and facing (map/colosseum.ts). Only the model is new.
 *
 * An oval of arcades in warm sandstone, rounded at its east end and square
 * across its west front: a plinth, a storey of arches on piers, a blind attic
 * with banners, a cornice, and four cressets burning on its corners. It stood
 * three floors tall and hid the street's own buildings behind it, so the
 * middle storey of arches came off (amended 2026-10-03): two floors now, the
 * ground arcade and the attic, to the lower `COLOSSEUM_WALL_TOP` the arena
 * room's attic colonnade also came down to.
 *
 * The grand arch over the walkable threshold is the one piece of it that
 * stands over a tile a player can be on, so its underside clears head
 * height (`COLOSSEUM_ARCH_SPRING`) and it fades as its own occluder, as the
 * plaza gateway does. Everything else stands on solid `colwall` tiles or on
 * the solid `colcore` the wall encloses, where a stepped cavea and a sliver
 * of raked sand catch the light the camera glimpses over the near wall.
 *
 * The camera always looks north (D-059), so the face the street reads is the
 * south one: the nameplate hangs on the south attic and the whole shell
 * fades, like any building, when it stands between the camera and a player on
 * the lawn behind it.
 *
 * Draw calls: the stone (lit), the grand arch (lit, its own fadeable
 * material), the additive flames, and the sign. Four.
 */

/** The nameplate: the pit's "GLADIATOR PIT" became the building's own name. */
export const COLOSSEUM_SIGN_TEXT = 'COLOSSEUM';

/** Re-exported so the street and its tests read the building's height from one place. */
export { COLOSSEUM_ARCH_SPRING, COLOSSEUM_WALL_TOP } from './colosseum-style.js';

/** The ember palette (docs/brand/README.md). */
export const ARENA_EMBER = COLOSSEUM_EMBER;

/** The nameplate on the south attic: cream caps on the outline brown, an ember rule. */
export const COLOSSEUM_SIGN: SignStyleOptions = Object.freeze({
  width: 2.8,
  height: 0.4,
  background: '#24120A',
  foreground: '#FFF6E6',
  accent: '#F56A16',
  gradient: Object.freeze(['#FFD23A', '#E8501A']),
  cornerRadius: 0.06,
  borderWidth: 0.06,
  hairline: false,
  titleFont: 'display',
  titleWeight: 900,
  titleTracking: 0.12,
  uppercase: true,
} satisfies SignStyleOptions);

/** A street occluder, naming which of the building's two materials it fades. */
export interface ColosseumOccluder extends Occluder {
  readonly kind: 'colosseum';
  /** `shell`: the building and its nameplate. `arch`: the grand arch over the threshold. */
  readonly part: 'shell' | 'arch';
  readonly object: Object3D;
}

export interface ColosseumParts {
  /** `street:ground`: the building's meshes. */
  readonly ground: Group;
  /** `street:labels`: the nameplate. */
  readonly labels: Group;
  readonly textLabels: TextLabel[];
  readonly animators: Array<(elapsedMs: number) => void>;
  readonly occluders: ColosseumOccluder[];
  /** Height of the walking surface on the threshold: level with the pavement. */
  readonly floorHeight: number;
  /** Cressets flicker slowly for reduced motion; never off either way. */
  readonly reducedMotion?: () => boolean;
}

const STONE = COLOSSEUM_STONE;

/** The arches' openings, as a fraction of a tile, in each storey. */
const ARCH_HALF = 0.3;
/** The cornices stand proud; above head height, so nothing a walker can clip. */
const CORNICE_PROUD = 0.08;
const CORNICE_DEPTH = 0.2;

/**
 * The grand arch is drawn in its own frame, as if it stood across an
 * east-west wall: local x runs along the opening (world z, north to south)
 * and local z through its thickness, 0.18 to 0.82 of the door tile. The frame
 * turns its face to the west, towards the branch path.
 */
const ARCH_Z0 = 0.18;
const ARCH_Z1 = 0.82;
/** World x of the grand arch's west and east faces. */
const ARCH_WEST = COLOSSEUM_DOOR.x + ARCH_Z0;
const ARCH_EAST = COLOSSEUM_DOOR.x + ARCH_Z1;
/** The ring over the three-tile opening: its rise and the voussoirs' depth. */
const ARCH_RISE = 0.45;
const ARCH_RING = 0.36;

/**
 * The nameplate on the building's south attic, facing south: the camera
 * always looks north (D-059), so this is the face the street reads.
 */
const SIGN_Y = (COLOSSEUM_ARCADE_TOP + COLOSSEUM_ATTIC_TOP) / 2;
const SIGN_Z = COLOSSEUM_AREA.y + COLOSSEUM_AREA.height;
const SIGN_X = COLOSSEUM_DOOR.x + 6;

type ColosseumKind = 'colwall' | 'colcore' | 'colstep';

function colosseumKind(map: DistrictMap, x: number, y: number): ColosseumKind | null {
  const kind: TileKind | undefined = map.tiles[y]?.[x];
  return kind === 'colwall' || kind === 'colcore' || kind === 'colstep' ? kind : null;
}

export function buildColosseum(map: DistrictMap, labels: LabelFactory, res: ResourceBag, parts: ColosseumParts): void {
  // A map without the building (a test district) builds nothing.
  if (colosseumKind(map, COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y) !== 'colstep') return;
  const bin = new GeometryBin();
  try {
    footing(map, bin, parts.floorHeight);
    shell(map, bin);
    cavea(map, bin);
    entranceRecess(map, bin);
    attic(map, bin);
    for (const torch of COLOSSEUM_TORCHES) cresset(bin, torch.x + 0.5, torch.y + 0.5);
    grandArch(bin);

    const stoneMaterial = res.material(standardMaterial({ roughness: 0.9 }));
    const stoneMesh = flushBin(bin, 'stone', stoneMaterial, res, parts.ground, {
      name: 'colosseum:stone',
      cast: true,
      receive: true,
    });
    const archMaterial = res.material(standardMaterial({ roughness: 0.88 }));
    const archMesh = flushBin(bin, 'arch', archMaterial, res, parts.ground, { name: 'colosseum:arch', cast: true, receive: true });
    const flameMaterial = res.material(unlitMaterial({ additive: true }));
    flushBin(bin, 'flame', flameMaterial, res, parts.ground, { name: 'colosseum:flames', renderOrder: 2 });

    const sign = labels.sign(COLOSSEUM_SIGN_TEXT, COLOSSEUM_SIGN);
    parts.textLabels.push(sign);
    sign.object.position.set(SIGN_X, SIGN_Y, SIGN_Z + 0.16);
    sign.object.userData['area'] = 'colosseum';
    sign.object.userData['text'] = COLOSSEUM_SIGN_TEXT;
    parts.labels.add(sign.object);

    // The shell fades with its nameplate: both stand on the south face, and
    // both are between the camera and a player on the lawn behind the
    // building at the same moment.
    if (stoneMesh) parts.occluders.push(shellOccluder(map, stoneMesh, [stoneMaterial, ...materialsOf(sign.object)]));
    if (archMesh) parts.occluders.push(archOccluder(archMesh, [archMaterial]));

    const reduced = (): boolean => {
      try {
        return parts.reducedMotion?.() === true;
      } catch {
        return false;
      }
    };
    let phase = 0;
    let last = 0;
    parts.animators.push((elapsed) => {
      // Reduced motion slows the flicker to a quarter; it never goes out.
      const dt = Math.max(0, elapsed - last);
      last = elapsed;
      phase += (dt / 1000) * (reduced() ? 0.25 : 1);
      flameMaterial.opacity = arenaFlameOpacity(phase);
    });
  } finally {
    bin.dispose();
  }
}

/** The cressets' flicker at `t` seconds: two incommensurate waves, never below 0.6. */
export function arenaFlameOpacity(t: number): number {
  return 0.82 + 0.11 * Math.sin(t * 9.1) + 0.07 * Math.sin(t * 13.7 + 1.3);
}

function materialsOf(object: Object3D): Material[] {
  const found: Material[] = [];
  object.traverse((child) => {
    const material = (child as Mesh).material;
    if (Array.isArray(material)) found.push(...material);
    else if (material) found.push(material);
  });
  return found;
}

// ---------------------------------------------------------------------------
// Occluders
// ---------------------------------------------------------------------------

/** The solid x run of one row of the building, or null off it. */
function solidRun(map: DistrictMap, y: number): readonly [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
    const kind = colosseumKind(map, x, y);
    if (kind !== 'colwall' && kind !== 'colcore') continue;
    min = Math.min(min, x);
    max = Math.max(max, x + 1);
  }
  return Number.isFinite(min) ? [min, max] : null;
}

/**
 * The shell: one box per row, so the rounded east end is not an invisible
 * wall to the camera's sight lines either. A player can never be inside one
 * of these boxes — every tile under them is solid.
 */
function shellOccluder(map: DistrictMap, mesh: Mesh, materials: readonly Material[]): ColosseumOccluder {
  const boxes: OccluderBounds[] = [];
  for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
    const run = solidRun(map, y);
    if (!run) continue;
    boxes.push(Object.freeze({ minX: run[0], maxX: run[1], minZ: y, maxZ: y + 1, height: COLOSSEUM_WALL_TOP }));
  }
  return Object.freeze({
    kind: 'colosseum',
    part: 'shell',
    object: mesh,
    bounds: Object.freeze({
      minX: COLOSSEUM_AREA.x,
      maxX: COLOSSEUM_AREA.x + COLOSSEUM_AREA.width,
      minZ: COLOSSEUM_AREA.y,
      maxZ: COLOSSEUM_AREA.y + COLOSSEUM_AREA.height,
      height: COLOSSEUM_WALL_TOP,
    }),
    boxes: Object.freeze(boxes),
    setOpacity: createOpacityFader(materials),
  });
}

/** The grand arch: the piers either side of the opening, and the wall it carries over it. */
function archOccluder(mesh: Mesh, materials: readonly Material[]): ColosseumOccluder {
  const [north, south] = COLOSSEUM_GATEPOSTS;
  const pier = (minZ: number, maxZ: number): OccluderBounds =>
    Object.freeze({ minX: ARCH_WEST, maxX: ARCH_EAST, minZ, maxZ, height: COLOSSEUM_WALL_TOP });
  const span: OccluderBounds = Object.freeze({
    minX: ARCH_WEST,
    maxX: ARCH_EAST,
    minZ: COLOSSEUM_DOOR.y,
    maxZ: COLOSSEUM_DOOR.y + COLOSSEUM_DOOR.height,
    minY: COLOSSEUM_ARCH_SPRING,
    height: COLOSSEUM_WALL_TOP,
  });
  return Object.freeze({
    kind: 'colosseum',
    part: 'arch',
    object: mesh,
    bounds: Object.freeze({
      minX: ARCH_WEST,
      maxX: ARCH_EAST,
      minZ: north!.y,
      maxZ: south!.y + 1,
      height: COLOSSEUM_WALL_TOP,
    }),
    boxes: Object.freeze([
      pier(north!.y, COLOSSEUM_DOOR.y),
      pier(COLOSSEUM_DOOR.y + COLOSSEUM_DOOR.height, south!.y + 1),
      span,
    ]),
    setOpacity: createOpacityFader(materials),
  });
}

// ---------------------------------------------------------------------------
// The ground the building stands on
// ---------------------------------------------------------------------------

/**
 * Street-builder lays no ground on the building's tiles, so the apron under
 * it and the worn threshold slab under the grand arch are laid here. The
 * threshold is the one walkable tile of the lot: its slab is flush with the
 * pavement and nothing else is drawn on it.
 */
function footing(map: DistrictMap, bin: GeometryBin, floorHeight: number): void {
  for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
    const run = solidRun(map, y);
    if (run) bin.add('stone', flatQuad(run[0], y, run[1], y + 1, 0), shade(STONE.plinth, (hash01(run[0], y, 3) - 0.5) * 0.04));
    for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
      if (colosseumKind(map, x, y) !== 'colstep') continue;
      bin.add('stone', boxGeometry(x, -0.02, y, x + 1, floorHeight, y + 1), shade(0x9d9384, (hash01(x, y, 9) - 0.5) * 0.04));
      bin.add('stone', flatQuad(x + 0.15, y + 0.2, x + 0.85, y + 0.8, floorHeight + 0.002), shade(0x9d9384, -0.06));
    }
  }
}

// ---------------------------------------------------------------------------
// The shell: stacked arcades on every wall tile
// ---------------------------------------------------------------------------

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/** The face of tile (x, y) looking towards its neighbour (dx, dy), and the run along it. */
function sideFace(x: number, y: number, dx: number, dy: number): { face: Face; u0: number; u1: number } {
  if (dy === -1) return { face: { normal: 'z-', plane: y }, u0: x, u1: x + 1 };
  if (dy === 1) return { face: { normal: 'z+', plane: y + 1 }, u0: x, u1: x + 1 };
  if (dx === -1) return { face: { normal: 'x-', plane: x }, u0: y, u1: y + 1 };
  return { face: { normal: 'x+', plane: x + 1 }, u0: y, u1: y + 1 };
}

function shell(map: DistrictMap, bin: GeometryBin): void {
  for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
    for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
      if (colosseumKind(map, x, y) !== 'colwall') continue;
      // The mass, course-shaded from the plinth up.
      bin.add('stone', boxGeometry(x, 0, y, x + 1, COLOSSEUM_WALL_TOP, y + 1), (_px: number, py: number) =>
        shade(STONE.wall, -0.12 + 0.14 * clamp01(py / COLOSSEUM_WALL_TOP) + (hash01(x, y, 11) - 0.5) * 0.035),
      );
      for (const [dx, dy] of NEIGHBOURS) {
        const neighbour = colosseumKind(map, x + dx, y + dy);
        const { face, u0, u1 } = sideFace(x, y, dx, dy);
        if (neighbour === null || neighbour === 'colstep') arcadeFace(bin, face, u0, u1, hash01(x, y, 17));
        else if (neighbour === 'colcore') innerFace(bin, face, u0, u1);
      }
    }
  }
}

/**
 * One tile of the outward façade: a plinth, a storey of arched openings
 * between piers, a blind attic panel and the cornices between them (amended
 * 2026-10-03: the middle storey of arches is gone, and the attic carries the
 * height it used to; the ground arcade is unchanged, so the grand arch and
 * the arches either side of it read exactly as they did).
 *
 * Everything below head height is flush or recessed, so nothing of the
 * building stands over the lawn a player walks on; only the cornices, all of
 * them above `COLOSSEUM_ARCH_SPRING`, are proud of the wall.
 */
function arcadeFace(bin: GeometryBin, face: Face, u0: number, u1: number, seed: number): void {
  const uc = (u0 + u1) / 2;
  // The plinth, recessed above so the base reads as a batter.
  bin.add('stone', faceQuad(face, u0, 0, u1, COLOSSEUM_PLINTH, 0.004), shade(STONE.plinth, -0.04 + seed * 0.06));
  bin.add('stone', faceQuad(face, u0, COLOSSEUM_PLINTH - 0.04, u1, COLOSSEUM_PLINTH, 0.006), shade(STONE.plinth, -0.2));

  const storey = (v0: number, v1: number, half: number): void => {
    // The arch's opening: a shadowed recess with a round head, between two piers.
    const head = v1 - 0.46;
    bin.add('stone', faceQuad(face, uc - half, v0 + 0.06, uc + half, head, 0.004), STONE.shadow);
    bin.add('stone', faceDisc(face, uc, head, 0.001, half, 0.004, 12), STONE.shadow);
    // The keystone and the ring's edge, flush with the wall.
    bin.add('stone', faceQuad(face, uc - half - 0.07, v0 + 0.06, uc - half, head + half * 0.6, 0.006), shade(STONE.pier, 0.04));
    bin.add('stone', faceQuad(face, uc + half, v0 + 0.06, uc + half + 0.07, head + half * 0.6, 0.006), shade(STONE.pier, 0.04));
    bin.add('stone', faceQuad(face, uc - 0.06, head + half - 0.05, uc + 0.06, head + half + 0.1, 0.007), shade(STONE.pier, 0.1));
  };
  storey(COLOSSEUM_PLINTH, COLOSSEUM_ARCADE_TOP, ARCH_HALF);

  // The cornices: proud of the wall, well above any head.
  for (const top of [COLOSSEUM_ARCADE_TOP + CORNICE_DEPTH, COLOSSEUM_WALL_TOP]) {
    bin.add('stone', faceBox(face, u0, top - CORNICE_DEPTH, 0, u1, top, CORNICE_PROUD), shade(STONE.cornice, -0.02 + seed * 0.05));
  }
  // The attic: a blind wall with a flat pilaster and a bronze boss every other tile.
  bin.add('stone', faceQuad(face, u0 + 0.06, COLOSSEUM_ARCADE_TOP + CORNICE_DEPTH + 0.04, u1 - 0.06, COLOSSEUM_ATTIC_TOP - 0.06, 0.004), shade(STONE.wall, 0.04));
  if (seed > 0.5) {
    bin.add('stone', faceDisc(face, uc, (COLOSSEUM_ARCADE_TOP + COLOSSEUM_ATTIC_TOP) / 2 + 0.1, 0.006, 0.16, 0.03, 10), shade(COLOSSEUM_EMBER.gold, -0.3));
  }
}

/**
 * A wall tile's face to the cavea it encloses. The camera looks down over the
 * near wall into the bowl (D-059), so this face is most of what it sees of
 * the inside: a flat shadow here read as a hole in the ground. It carries the
 * same bands the outside does instead — the stands' dark undercroft, the lit
 * back wall of the upper tiers, a cornice and the attic — so the inside of the
 * ring reads as the back of a stadium, as the arena room's arcade does.
 */
function innerFace(bin: GeometryBin, face: Face, u0: number, u1: number): void {
  // The undercroft's head, below the arcade's own top: the lit band above it
  // is as deep as it was when the wall carried two storeys of arches.
  const BACK = COLOSSEUM_ARCADE_TOP - 1.4;
  // Under the stands: deep shade, where the vaults would be.
  bin.add('stone', faceQuad(face, u0, 0, u1, BACK, 0.004), shade(STONE.shadow, 0.1));
  // The upper tiers' back wall, lit, with a blind arch every other bay.
  bin.add('stone', faceQuad(face, u0, BACK, u1, COLOSSEUM_ARCADE_TOP, 0.004), (_u: number, v: number) =>
    shade(STONE.wallDark, -0.1 + 0.12 * clamp01((v - BACK) / (COLOSSEUM_ARCADE_TOP - BACK))),
  );
  const uc = (u0 + u1) / 2;
  bin.add('stone', faceQuad(face, uc - 0.26, BACK + 0.1, uc + 0.26, COLOSSEUM_ARCADE_TOP - 0.5, 0.006), shade(STONE.shadow, 0.16));
  bin.add('stone', faceDisc(face, uc, COLOSSEUM_ARCADE_TOP - 0.5, 0.001, 0.26, 0.006, 10), shade(STONE.shadow, 0.16));
  // The cornice and the attic over it, as the outward face has.
  bin.add('stone', faceQuad(face, u0, COLOSSEUM_ARCADE_TOP, u1, COLOSSEUM_ARCADE_TOP + CORNICE_DEPTH, 0.006), shade(STONE.cornice, -0.06));
  bin.add('stone', faceQuad(face, u0, COLOSSEUM_ARCADE_TOP + CORNICE_DEPTH, u1, COLOSSEUM_WALL_TOP, 0.004), shade(STONE.wall, -0.06));
}

// ---------------------------------------------------------------------------
// The cavea the wall encloses
// ---------------------------------------------------------------------------

/** How many tiles a core tile is from the nearest tile that is not core. */
function coreDepth(map: DistrictMap, x: number, y: number): number {
  for (let d = 1; d <= 4; d++) {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
        if (colosseumKind(map, x + dx, y + dy) !== 'colcore') return d;
      }
    }
  }
  return 5;
}

/**
 * Inside the wall: two stepped rings of seating and, in the middle, a sliver
 * of raked sand. Nothing here is walkable — the tiles are solid and the door
 * takes the player to the arena room — but the camera looks down from the
 * south, and over the near wall this is what it catches.
 */
function cavea(map: DistrictMap, bin: GeometryBin): void {
  // By distance from the wall: the top ring of seating under the arcade, a
  // middle ring, then the sand. The outer ring meets the wall's undercroft, so
  // the bowl reads as a rake and not as a shaft.
  // Amended 2026-10-03: the rake came down with the wall, so the top ring
  // still sits under the arcade's own top and not against the cornice.
  const tops = [0, 2.3, 1.4, 0.6];
  for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
    for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
      if (colosseumKind(map, x, y) !== 'colcore') continue;
      const depth = coreDepth(map, x, y);
      const top = tops[Math.min(depth, tops.length - 1)]!;
      const sand = depth >= 3;
      const base = sand ? STONE.sand : mixHex(STONE.wall, STONE.pier, depth === 1 ? 0.2 : 0.6);
      bin.add('stone', boxGeometry(x, 0, y, x + 1, top, y + 1), (_px: number, py: number) =>
        shade(base, -0.1 + 0.1 * clamp01(py / Math.max(top, 0.001)) + (hash01(x, y, 23) - 0.5) * 0.03),
      );
      if (sand) {
        // Raked rings on the sand, as the arena's own floor has.
        bin.add('stone', flatQuad(x + 0.04, y + 0.22, x + 0.96, y + 0.42, top + 0.004), shade(STONE.sandDark, -0.04));
        bin.add('stone', flatQuad(x + 0.04, y + 0.62, x + 0.96, y + 0.82, top + 0.004), shade(STONE.sandDark, -0.04));
        continue;
      }
      // A bench line along the step's inner edge, so the rings read as seats.
      bin.add('stone', boxGeometry(x + 0.06, top, y + 0.06, x + 0.94, top + 0.08, y + 0.44), shade(0x9c6b3e, (hash01(x, y, 29) - 0.5) * 0.08));
    }
  }
}

/**
 * The vomitorium behind the grand arch: on the first core tiles east of the
 * threshold, a dark arched mouth with the arena's light low in it, so the
 * doorway is a way in and not a blank wall.
 */
function entranceRecess(map: DistrictMap, bin: GeometryBin): void {
  const x = COLOSSEUM_DOOR.x + 1;
  if (colosseumKind(map, x, COLOSSEUM_DOOR.y) !== 'colcore') return;
  const face: Face = { normal: 'x-', plane: x };
  const cz = COLOSSEUM_DOOR.y + COLOSSEUM_DOOR.height / 2;
  const half = 1.1;
  const spring = 1.95;
  bin.add('stone', faceQuad(face, cz - half, 0, cz + half, spring, 0.004), 0x1f1812);
  bin.add('stone', faceDisc(face, cz, spring, 0.001, half, 0.004, 14), 0x1f1812);
  bin.add('stone', faceQuad(face, cz - half + 0.14, 0, cz + half - 0.14, 1.2, 0.006), (_u: number, v: number) =>
    shade(mixHex(STONE.sand, 0xfff1cf, 0.5), -0.3 + 0.3 * clamp01(1 - v / 1.2)),
  );
}

// ---------------------------------------------------------------------------
// The attic's banners and the corner cressets
// ---------------------------------------------------------------------------

/** One banner hanging on the attic: the cloth, two gold bands and a sun. */
function bannerOn(bin: GeometryBin, face: Face, u0: number, u1: number, red: boolean): void {
  const top = COLOSSEUM_ATTIC_TOP - 0.1;
  const bottom = COLOSSEUM_ARCADE_TOP + CORNICE_DEPTH + 0.1;
  const main = red ? COLOSSEUM_EMBER.bannerRed : COLOSSEUM_EMBER.navy;
  const trim = red ? COLOSSEUM_EMBER.gold : COLOSSEUM_EMBER.bone;
  bin.add('stone', faceBox(face, u0 - 0.03, top, CORNICE_PROUD, u1 + 0.03, top + 0.05, CORNICE_PROUD + 0.05), STONE.iron);
  bin.add('stone', faceBox(face, u0, bottom, CORNICE_PROUD + 0.01, u1, top, CORNICE_PROUD + 0.03), (_u: number, v: number) =>
    shade(main, -0.12 + 0.12 * clamp01((v - bottom) / (top - bottom))),
  );
  for (const v of [top - 0.18, bottom + 0.12]) {
    bin.add('stone', faceBox(face, u0, v, CORNICE_PROUD + 0.031, u1, v + 0.06, CORNICE_PROUD + 0.036), trim);
  }
  const mid = (u0 + u1) / 2;
  bin.add('stone', faceBox(face, mid - 0.07, (top + bottom) / 2 - 0.07, CORNICE_PROUD + 0.031, mid + 0.07, (top + bottom) / 2 + 0.07, CORNICE_PROUD + 0.038), COLOSSEUM_EMBER.sunTop);
}

/**
 * Banners on the attic of every outward face the street can see, alternating
 * red-and-gold and navy-and-bone as the arena's do inside, skipping the
 * nameplate's own stretch of the south wall.
 */
function attic(map: DistrictMap, bin: GeometryBin): void {
  let index = 0;
  for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
    for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
      if (colosseumKind(map, x, y) !== 'colwall') continue;
      for (const [dx, dy] of NEIGHBOURS) {
        const neighbour = colosseumKind(map, x + dx, y + dy);
        if (neighbour !== null && neighbour !== 'colstep') continue;
        // The camera looks north: banners go on the south and the two end
        // faces, which are the ones a player on the street ever sees.
        if (dy === -1) continue;
        index += 1;
        if (index % 2 !== 0) continue;
        const { face, u0, u1 } = sideFace(x, y, dx, dy);
        if (dy === 1 && Math.abs(x + 0.5 - SIGN_X) < COLOSSEUM_SIGN.width / 2 + 0.3) continue;
        bannerOn(bin, face, u0 + 0.2, u1 - 0.2, (index / 2) % 2 === 0);
      }
    }
  }
}

/** An iron cresset on the cornice, and its flames (additive, flickering). */
function cresset(bin: GeometryBin, x: number, z: number): void {
  const base = COLOSSEUM_WALL_TOP;
  for (const [dx, dz] of [[-0.12, -0.12], [0.12, -0.12], [0, 0.14]] as const) {
    bin.add('stone', boxGeometry(x + dx - 0.02, base, z + dz - 0.02, x + dx + 0.02, base + 0.26, z + dz + 0.02), STONE.iron);
  }
  bin.add('stone', cylinderGeometry(x, base + 0.24, z, 0.24, 0.14, 0.18, 8), STONE.iron);
  bin.add('stone', cylinderGeometry(x, base + 0.4, z, 0.22, 0.22, 0.02, 8), shade(COLOSSEUM_EMBER.drop, -0.2));
  const ember = new Color(COLOSSEUM_EMBER.ember);
  const gold = new Color(COLOSSEUM_EMBER.gold);
  const flame = (fx: number, fz: number, radius: number, height: number): void => {
    const y0 = base + 0.39;
    bin.add('flame', coneGeometry(fx, y0, fz, radius, height, 6), (_x: number, y: number) =>
      new Color().lerpColors(ember, gold, clamp01((y - y0) / height)).multiplyScalar(0.95),
    );
  };
  flame(x, z, 0.17, 0.58);
  flame(x - 0.08, z + 0.06, 0.1, 0.38);
  flame(x + 0.09, z - 0.05, 0.09, 0.34);
}

// ---------------------------------------------------------------------------
// The grand arch
// ---------------------------------------------------------------------------

/**
 * The west front's grand arch, over the walkable threshold: two piers either
 * side of the three-tile opening, a ring of nine voussoirs whose underside
 * never drops below `COLOSSEUM_ARCH_SPRING`, the wall it carries on up to the
 * building's cornice, and a banner on each pier's west face — the face you
 * walk up to along the branch. Drawn in the arch's own frame (see `ARCH_Z0`)
 * and then turned to face west.
 *
 * This is the one part of the building over a tile a player can stand on, so
 * it is its own material and its own occluder, and it fades like the plaza's
 * gateway when it hides a player on the branch or the threshold.
 */
function grandArch(bin: GeometryBin): void {
  const ox0 = COLOSSEUM_DOOR.y;
  const ox1 = COLOSSEUM_DOOR.y + COLOSSEUM_DOOR.height;
  const [northPier, southPier] = COLOSSEUM_GATEPOSTS;
  const spring = COLOSSEUM_ARCH_SPRING;
  const x0 = ARCH_WEST;
  const x1 = ARCH_EAST;
  /** A box in the arch's slab, spanning z `a`..`b` and y `v0`..`v1`. */
  const slab = (a: number, b: number, v0: number, v1: number, out = 0): BufferGeometry =>
    boxGeometry(x0 - out, v0, a, x1 + out, v1, b);

  // The piers, flush with the opening: a plinth, a shaft and a capital.
  for (const [a, b] of [[northPier!.y, ox0], [ox1, southPier!.y + 1]] as const) {
    bin.add('arch', slab(a, b, 0, COLOSSEUM_PLINTH, 0.04), shade(STONE.plinth, -0.04));
    bin.add('arch', slab(a, b, COLOSSEUM_PLINTH, spring), (_px: number, py: number) => shade(STONE.pier, -0.06 + 0.06 * (py / spring)));
    bin.add('arch', slab(a, b, spring - 0.14, spring, 0.05), STONE.cornice);
  }
  // The ring over the opening: nine voussoirs carried up to a flat extrados.
  // Each block's profile is given in (z, y) and extruded along x, so the ring
  // runs north to south across the opening.
  const half = (ox1 - ox0) / 2;
  const radius = (half * half + ARCH_RISE * ARCH_RISE) / (2 * ARCH_RISE);
  const cz = (ox0 + ox1) / 2;
  const cy = spring + ARCH_RISE - radius;
  const limit = Math.asin(half / radius);
  const count = 9;
  const extrados = spring + ARCH_RISE + ARCH_RING;
  for (let i = 0; i < count; i++) {
    const a0 = -limit + (2 * limit * i) / count;
    const a1 = -limit + (2 * limit * (i + 1)) / count;
    const p0: Point2 = [cz + radius * Math.sin(a0), cy + radius * Math.cos(a0)];
    const p1: Point2 = [cz + radius * Math.sin(a1), cy + radius * Math.cos(a1)];
    const keystone = i === Math.floor(count / 2);
    const top = extrados + (keystone ? 0.12 : 0);
    const colour = keystone ? shade(STONE.pier, 0.1) : shade(STONE.wall, i % 2 === 0 ? 0.03 : -0.04);
    const out = keystone ? 0.03 : 0;
    bin.add('arch', prismX([p0, p1, [p1[0], top], [p0[0], top]], x0 - out, x1 + out), colour);
  }
  // The wall the arch carries, on up to the building's cornice, and the two
  // cornices that cross it, so the west front reads as one facade.
  bin.add('arch', slab(ox0, ox1, extrados, COLOSSEUM_WALL_TOP), (_px: number, py: number) =>
    shade(STONE.wall, -0.1 + 0.12 * clamp01(py / COLOSSEUM_WALL_TOP)),
  );
  for (const top of [COLOSSEUM_ARCADE_TOP + CORNICE_DEPTH, COLOSSEUM_WALL_TOP]) {
    bin.add('arch', slab(ox0, ox1, top - CORNICE_DEPTH, top, CORNICE_PROUD), shade(STONE.cornice, 0));
  }
  // A banner on each pier's west face, the face the branch path walks up to.
  const west: Face = { normal: 'x-', plane: x0 };
  for (const [a, b] of [[northPier!.y + 0.2, ox0 - 0.1], [ox1 + 0.1, southPier!.y + 0.8]] as const) {
    bannerWest(bin, west, a, b);
  }
}

/** The grand arch's own banners, hung low on the piers so the branch sees them. */
function bannerWest(bin: GeometryBin, face: Face, u0: number, u1: number): void {
  const top = COLOSSEUM_ARCH_SPRING - 0.2;
  const bottom = 0.9;
  bin.add('arch', faceBox(face, u0 - 0.03, top, 0, u1 + 0.03, top + 0.06, 0.05), STONE.iron);
  bin.add('arch', faceBox(face, u0, bottom, 0.02, u1, top, 0.04), (_u: number, v: number) =>
    shade(COLOSSEUM_EMBER.bannerRed, -0.12 + 0.12 * clamp01((v - bottom) / (top - bottom))),
  );
  for (const v of [top - 0.22, bottom + 0.1]) {
    bin.add('arch', faceBox(face, u0, v, 0.041, u1, v + 0.06, 0.046), COLOSSEUM_EMBER.gold);
  }
  const mid = (u0 + u1) / 2;
  bin.add('arch', faceBox(face, mid - 0.06, (top + bottom) / 2 - 0.06, 0.041, mid + 0.06, (top + bottom) / 2 + 0.06, 0.047), COLOSSEUM_EMBER.sunTop);
}
