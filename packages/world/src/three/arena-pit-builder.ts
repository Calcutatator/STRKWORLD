import { Box3, Color, PlaneGeometry, type Group, type Material, type Mesh, type Object3D } from 'three';
import {
  ARENA_PIT_DOOR,
  ARENA_PIT_GATEPOSTS,
  ARENA_PIT_TORCHES,
} from '../map/arena-pit.js';
import type { DistrictMap, TileKind } from '../map/street.js';
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
  faceTorus,
  flatQuad,
  flushBin,
  hash01,
  mixHex,
  prismX,
  prismZ,
  shade,
  standardMaterial,
  unlitMaterial,
  type Face,
  type Point2,
} from './palette.js';
import type { LabelFactory, Occluder, OccluderBounds, TextLabel } from './types.js';

/**
 * The gladiator pit in 3D (D-114): an old-style sunken pit on the south
 * lawn. A bowl sunk 1.2 below the grass with a raked sand floor, its inner
 * wall of dressed stone with a band of blind arched niches and iron rings,
 * a low parapet of weathered blocks with a darker coping, a flight of steps
 * down from the arch, four braziers on the rim, and a round-headed arch on
 * two gateposts over the door with red-and-gold banners and the sign.
 *
 * Presentation only, under the street's rule: the parapet, posts and
 * braziers stand on solid `pitrim` tiles, the steps and the bowl lie on (and
 * below) the solid `pitbowl` tiles, and over the walkable threshold there is
 * only its flush slab and the arch, whose underside clears head height. The
 * arch is the one tall part, so it fades like the plaza gateway when it
 * hides the player on the path. Four draw calls: the stone and sand (lit),
 * the arch and banners (lit, its own fadeable material), the additive
 * flames, and the sign.
 */

export const ARENA_PIT_SIGN_TEXT = 'GLADIATOR PIT';

/** How far the bowl's floor is sunk below the lawn. */
export const ARENA_PIT_DEPTH = 1.2;
/** The parapet's height above the lawn, coping included. */
export const ARENA_PIT_PARAPET = 0.38;
/** Head clearance under the arch over the walkable threshold. */
export const ARENA_PIT_ARCH_SPRING = 1.9;

/** The ember palette (docs/brand/README.md). */
export const ARENA_EMBER = Object.freeze({
  ember: 0xf56a16,
  gold: 0xffc12e,
  sunTop: 0xffd23a,
  sunBottom: 0xe8501a,
  drop: 0xb8400c,
  outline: 0x24120a,
  cream: 0xfff6e6,
});

/** The sign on the arch's attic: cream caps on the outline brown, an ember rule. */
export const ARENA_PIT_SIGN: SignStyleOptions = Object.freeze({
  width: 2.5,
  height: 0.36,
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

/** The arch: a street occluder, fading its stone, banners and sign together. */
export interface ArenaPitOccluder extends Occluder {
  readonly kind: 'arena-pit';
  readonly object: Object3D;
}

export interface ArenaPitParts {
  /** `street:ground`: the pit's meshes. */
  readonly ground: Group;
  /** `street:labels`: the sign. */
  readonly labels: Group;
  readonly textLabels: TextLabel[];
  readonly animators: Array<(elapsedMs: number) => void>;
  readonly occluders: ArenaPitOccluder[];
  /** Height of the walking surface on the threshold: level with the pavement. */
  readonly floorHeight: number;
  /** Braziers flicker slowly for reduced motion; never off either way. */
  readonly reducedMotion?: () => boolean;
}

const STONE = 0x9a8f7c;
const STONE_DARK = 0x6f6656;
const STONE_WARM = 0xb3a184;
const COPING = 0x857a66;
const SAND = 0xd8bd8f;
const SAND_DARK = 0xb79a6c;
const IRON = 0x3a3532;
const BANNER_RED = 0xa8261d;

/** Wall slab thickness, standing in the rim tile behind the face. */
const WALL_T = 0.14;
const STEPS = 4;
const STEP_RUN = 0.42;
/** The arch's ring: intrados rise over the 2-tile opening and the voussoir depth. */
const ARCH_RISE = 0.3;
const ARCH_RING = 0.32;
/** The attic over the arch, carrying the sign, and its cornice. */
const ATTIC_TOP = 2.95;
const CORNICE_TOP = 3.07;
const ARCH_Z0 = ARENA_PIT_DOOR.y + 0.18;
const ARCH_Z1 = ARENA_PIT_DOOR.y + 0.82;
const SIGN_Y = 2.73;

type PitKind = 'pitrim' | 'pitbowl' | 'pitstep';

function pitKind(map: DistrictMap, x: number, y: number): PitKind | null {
  const kind: TileKind | undefined = map.tiles[y]?.[x];
  return kind === 'pitrim' || kind === 'pitbowl' || kind === 'pitstep' ? kind : null;
}

export function buildArenaPit(map: DistrictMap, labels: LabelFactory, res: ResourceBag, parts: ArenaPitParts): void {
  // A map without the pit (a test district) builds nothing.
  if (pitKind(map, ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y) !== 'pitstep') return;
  const bin = new GeometryBin();
  try {
    bowl(map, bin);
    rim(map, bin, parts.floorHeight);
    steps(bin);
    for (const torch of ARENA_PIT_TORCHES) brazier(bin, torch.x + 0.5, torch.y + 0.5);
    arch(bin);

    const stone = res.material(standardMaterial({ roughness: 0.9 }));
    flushBin(bin, 'stone', stone, res, parts.ground, { name: 'pit:stone', cast: true, receive: true });
    const archMaterial = res.material(standardMaterial({ roughness: 0.88 }));
    const archMesh = flushBin(bin, 'arch', archMaterial, res, parts.ground, { name: 'pit:arch', cast: true, receive: true });
    const flameMaterial = res.material(unlitMaterial({ additive: true }));
    flushBin(bin, 'flame', flameMaterial, res, parts.ground, { name: 'pit:flames', renderOrder: 2 });

    const sign = labels.sign(ARENA_PIT_SIGN_TEXT, ARENA_PIT_SIGN);
    parts.textLabels.push(sign);
    sign.object.position.set(ARENA_PIT_DOOR.x + ARENA_PIT_DOOR.width / 2, SIGN_Y, ARCH_Z1 + 0.012);
    sign.object.userData['area'] = 'arena-pit';
    sign.object.userData['text'] = ARENA_PIT_SIGN_TEXT;
    parts.labels.add(sign.object);

    if (archMesh) parts.occluders.push(archOccluder(archMesh, [archMaterial, ...materialsOf(sign.object)]));

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

/** The braziers' flicker at `t` seconds: two incommensurate waves, never below 0.6. */
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

function archOccluder(mesh: Mesh, materials: readonly Material[]): ArenaPitOccluder {
  const box = new Box3().setFromObject(mesh);
  const post = (x: number): OccluderBounds =>
    Object.freeze({ minX: x + 0.15, maxX: x + 1, minZ: ARCH_Z0, maxZ: ARCH_Z1, height: ARENA_PIT_ARCH_SPRING });
  const [west, east] = ARENA_PIT_GATEPOSTS;
  const span: OccluderBounds = Object.freeze({
    minX: box.min.x,
    maxX: box.max.x,
    minZ: ARCH_Z0,
    maxZ: ARCH_Z1,
    minY: ARENA_PIT_ARCH_SPRING,
    height: box.max.y,
  });
  return Object.freeze({
    kind: 'arena-pit',
    object: mesh,
    bounds: Object.freeze({ ...span, minY: 0 }),
    boxes: Object.freeze([post(west!.x), { ...post(east!.x), minX: east!.x, maxX: east!.x + 0.85 }, span]),
    setOpacity: createOpacityFader(materials),
  });
}

// ---------------------------------------------------------------------------
// The bowl: sand, walls, niches
// ---------------------------------------------------------------------------

function bowl(map: DistrictMap, bin: GeometryBin): void {
  const floor = -ARENA_PIT_DEPTH;
  const tiles: [number, number][] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) if (pitKind(map, x, y) === 'pitbowl') tiles.push([x, y]);
  }
  if (tiles.length === 0) return;
  const cx = tiles.reduce((sum, [x]) => sum + x + 0.5, 0) / tiles.length;
  const cz = tiles.reduce((sum, [, y]) => sum + y + 0.5, 0) / tiles.length;
  const isBowl = (x: number, y: number): boolean => pitKind(map, x, y) === 'pitbowl';

  // Raked sand in concentric rings, darker where it meets the wall: one
  // strip per row of the bowl, painted per vertex.
  const sand = (px: number, _py: number, pz: number): Color => {
    const d = Math.hypot((px - cx) / 1.6, pz - cz);
    const raked = Math.sin(d * Math.PI * 2.6) > 0.55 ? -0.035 : 0.01;
    const edge = edgeDistance(isBowl, Math.min(px, Math.ceil(px) - 1e-3), Math.min(pz, Math.ceil(pz) - 1e-3));
    const base = edge < 0.35 ? mixHex(SAND_DARK, SAND, edge / 0.35) : SAND;
    return shade(base, raked + (hash01(Math.round(px * 4), Math.round(pz * 4), 3) - 0.5) * 0.02);
  };
  const rows = new Map<number, number[]>();
  for (const [x, y] of tiles) rows.set(y, [...(rows.get(y) ?? []), x]);
  for (const [y, xs] of rows) {
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs) + 1;
    const geometry = new PlaneGeometry(x1 - x0, 1, (x1 - x0) * 4, 4).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, floor, y + 0.5);
    bin.add('stone', geometry, sand);
  }
  for (const [x, y] of tiles) {
    // The inner wall on every side the bowl ends, standing in the tile behind.
    const sides: [number, number, Face, number][] = [
      [0, -1, { normal: 'z+', plane: y }, x],
      [0, 1, { normal: 'z-', plane: y + 1 }, x],
      [-1, 0, { normal: 'x+', plane: x }, y],
      [1, 0, { normal: 'x-', plane: x + 1 }, y],
    ];
    for (const [dx, dy, face, u0] of sides) {
      if (isBowl(x + dx, y + dy)) continue;
      // The steps come down from the threshold: no wall there.
      if (pitKind(map, x + dx, y + dy) === 'pitstep') continue;
      wall(bin, face, u0, u0 + 1, floor);
    }
  }
}

/** Distance from (x, z) to the nearest non-bowl tile edge, capped at 1. */
function edgeDistance(isBowl: (x: number, y: number) => boolean, x: number, z: number): number {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  let best = 1;
  if (!isBowl(tx - 1, tz)) best = Math.min(best, x - tx);
  if (!isBowl(tx + 1, tz)) best = Math.min(best, tx + 1 - x);
  if (!isBowl(tx, tz - 1)) best = Math.min(best, z - tz);
  if (!isBowl(tx, tz + 1)) best = Math.min(best, tz + 1 - z);
  return best;
}

/** One tile of dressed stone wall, a blind arched niche and an iron ring in it. */
function wall(bin: GeometryBin, face: Face, u0: number, u1: number, floor: number): void {
  // Coursed: three courses of slightly different stones.
  const courses = 3;
  const h = -floor / courses;
  for (let c = 0; c < courses; c++) {
    const v0 = floor + c * h;
    const seed = hash01(u0 * 3 + c, face.plane * 5, 41);
    bin.add('stone', faceBox(face, u0 - WALL_T, v0, -WALL_T, u1 + WALL_T, v0 + h, 0), shade(STONE, -0.06 + seed * 0.08 - c * 0.02));
    // A recessed joint line under each course.
    bin.add('stone', faceQuad(face, u0, v0 + h - 0.015, u1, v0 + h + 0.01, 0.003), STONE_DARK);
  }
  // The niche: a dark recess with a round head, and an iron ring hanging in it.
  const uc = (u0 + u1) / 2;
  bin.add('stone', faceQuad(face, uc - 0.2, floor + 0.22, uc + 0.2, floor + 0.78, 0.004), shade(STONE_DARK, -0.12));
  bin.add('stone', faceDisc(face, uc, floor + 0.78, 0.001, 0.2, 0.004, 10), shade(STONE_DARK, -0.12));
  bin.add('stone', faceTorus(face, uc, floor + 0.55, 0.03, 0.07, 0.013, { tubularSegments: 10 }), IRON);
  bin.add('stone', faceBox(face, uc - 0.015, floor + 0.62, 0, uc + 0.015, floor + 0.7, 0.04), IRON);
}

// ---------------------------------------------------------------------------
// The rim, the threshold and the steps
// ---------------------------------------------------------------------------

function rim(map: DistrictMap, bin: GeometryBin, floorHeight: number): void {
  const posts = new Set(ARENA_PIT_GATEPOSTS.map((post) => `${post.x},${post.y}`));
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const kind = pitKind(map, x, y);
      if (kind === 'pitstep') {
        // The worn threshold slab, flush with the pavement.
        bin.add('stone', boxGeometry(x, -0.02, y, x + 1, floorHeight, y + 1), shade(0x9d9384, (hash01(x, y, 9) - 0.5) * 0.04));
        bin.add('stone', flatQuad(x + 0.15, y + 0.2, x + 0.85, y + 0.8, floorHeight + 0.002), shade(0x9d9384, -0.06));
        continue;
      }
      if (kind !== 'pitrim' || posts.has(`${x},${y}`)) continue;
      // Weathered blocks, two per tile, each its own height and tone.
      for (let half = 0; half < 2; half++) {
        const along = isHorizontalRun(map, x, y);
        const x0 = along ? x + half * 0.5 : x;
        const x1 = along ? x0 + 0.5 : x + 1;
        const z0 = along ? y : y + half * 0.5;
        const z1 = along ? y + 1 : z0 + 0.5;
        const seed = hash01(x * 2 + half, y, 17);
        const top = ARENA_PIT_PARAPET - 0.08 - seed * 0.03;
        bin.add('stone', boxGeometry(x0 + 0.01, 0, z0 + 0.01, x1 - 0.01, top, z1 - 0.01), shade(STONE_WARM, -0.1 + seed * 0.1));
      }
      // The darker coping course, overhanging a little.
      bin.add('stone', boxGeometry(x - 0.02, ARENA_PIT_PARAPET - 0.09, y - 0.02, x + 1.02, ARENA_PIT_PARAPET, y + 1.02), shade(COPING, (hash01(x, y, 23) - 0.5) * 0.05));
      // Moss in the joints at the foot of the parapet, on its own tile.
      if (hash01(x, y, 31) < 0.4) bin.add('stone', flatQuad(x + 0.05, y + 0.85, x + 0.6, y + 0.98, 0.006), 0x5b7a3a);
    }
  }
}

/** Whether a rim tile's run reads east-west (its blocks split along x). */
function isHorizontalRun(map: DistrictMap, x: number, y: number): boolean {
  return pitKind(map, x - 1, y) === 'pitrim' || pitKind(map, x + 1, y) === 'pitrim';
}

/** Four steps down from the threshold into the bowl, between two cheek walls. */
function steps(bin: GeometryBin): void {
  const x0 = ARENA_PIT_DOOR.x;
  const x1 = ARENA_PIT_DOOR.x + ARENA_PIT_DOOR.width;
  const top = ARENA_PIT_DOOR.y + 1;
  const rise = ARENA_PIT_DEPTH / STEPS;
  for (let i = 0; i < STEPS; i++) {
    // Each step a block from the bowl's floor up to its own tread.
    const y = -rise * (i + 1);
    const z0 = top + STEP_RUN * i;
    bin.add('stone', boxGeometry(x0 + 0.12, -ARENA_PIT_DEPTH - 0.01, z0, x1 - 0.12, y, z0 + STEP_RUN), shade(STONE, -0.04 - 0.03 * i));
    // A worn nosing on each tread.
    bin.add('stone', flatQuad(x0 + 0.14, z0, x1 - 0.14, z0 + 0.06, y + 0.002), shade(STONE_WARM, 0.04));
  }
  const foot = top + STEP_RUN * STEPS;
  const cheek: Point2[] = [[top, 0.06], [top, -ARENA_PIT_DEPTH], [foot + 0.08, -ARENA_PIT_DEPTH], [foot + 0.08, -ARENA_PIT_DEPTH + 0.18]];
  bin.add('stone', prismX(cheek, x0, x0 + 0.12), STONE_DARK);
  bin.add('stone', prismX(cheek, x1 - 0.12, x1), STONE_DARK);
}

// ---------------------------------------------------------------------------
// Braziers
// ---------------------------------------------------------------------------

/** An iron brazier on the parapet, and its flames (additive, flickering). */
function brazier(bin: GeometryBin, x: number, z: number): void {
  const base = ARENA_PIT_PARAPET;
  for (const [dx, dz] of [[-0.12, -0.12], [0.12, -0.12], [0, 0.14]] as const) {
    bin.add('stone', boxGeometry(x + dx - 0.02, base, z + dz - 0.02, x + dx + 0.02, base + 0.22, z + dz + 0.02), IRON);
  }
  bin.add('stone', cylinderGeometry(x, base + 0.2, z, 0.22, 0.13, 0.16, 8), IRON);
  bin.add('stone', cylinderGeometry(x, base + 0.34, z, 0.2, 0.2, 0.02, 8), shade(ARENA_EMBER.drop, -0.2));
  const ember = new Color(ARENA_EMBER.ember);
  const gold = new Color(ARENA_EMBER.gold);
  const flame = (fx: number, fz: number, radius: number, height: number): void => {
    const y0 = base + 0.33;
    bin.add('flame', coneGeometry(fx, y0, fz, radius, height, 6), (_x: number, y: number) =>
      new Color().lerpColors(ember, gold, clamp01((y - y0) / height)).multiplyScalar(0.95),
    );
  };
  flame(x, z, 0.15, 0.5);
  flame(x - 0.07, z + 0.05, 0.09, 0.34);
  flame(x + 0.08, z - 0.04, 0.08, 0.3);
}

// ---------------------------------------------------------------------------
// The arch
// ---------------------------------------------------------------------------

/**
 * Two gateposts on the rim either side of the threshold, a segmental arch of
 * seven voussoirs over the two-tile opening (its underside never lower than
 * `ARENA_PIT_ARCH_SPRING`, above any head), an attic for the sign and a
 * cornice; a red-and-gold banner hangs from each post's street face.
 */
function arch(bin: GeometryBin): void {
  const ox0 = ARENA_PIT_DOOR.x;
  const ox1 = ARENA_PIT_DOOR.x + ARENA_PIT_DOOR.width;
  const [west, east] = ARENA_PIT_GATEPOSTS;
  const spring = ARENA_PIT_ARCH_SPRING;
  // Posts: flush with the opening, a plinth and a capital.
  // Each post's plinth and capital overhang on its outer side only, never
  // into the opening.
  for (const [px0, px1, out0, out1] of [[west!.x + 0.15, ox0, 0.04, 0], [ox1, east!.x + 0.85, 0, 0.04]] as const) {
    bin.add('arch', boxGeometry(px0 - out0, 0, ARCH_Z0 - 0.04, px1 + out1, 0.24, ARCH_Z1 + 0.04), STONE_DARK);
    bin.add('arch', boxGeometry(px0, 0.24, ARCH_Z0, px1, spring, ARCH_Z1), (_x: number, y: number) => shade(STONE_WARM, -0.05 + 0.04 * (y / spring)));
    bin.add('arch', boxGeometry(px0 - out0 * 1.25, spring - 0.12, ARCH_Z0 - 0.05, px1 + out1 * 1.25, spring, ARCH_Z1 + 0.05), COPING);
  }
  // The voussoirs, each carried up to the attic as a convex block.
  const half = (ox1 - ox0) / 2;
  const radius = (half * half + ARCH_RISE * ARCH_RISE) / (2 * ARCH_RISE);
  const cx = (ox0 + ox1) / 2;
  const cy = spring + ARCH_RISE - radius;
  const limit = Math.asin(half / radius);
  const count = 7;
  for (let i = 0; i < count; i++) {
    const a0 = -limit + (2 * limit * i) / count;
    const a1 = -limit + (2 * limit * (i + 1)) / count;
    const p0: Point2 = [cx + radius * Math.sin(a0), cy + radius * Math.cos(a0)];
    const p1: Point2 = [cx + radius * Math.sin(a1), cy + radius * Math.cos(a1)];
    const keystone = i === Math.floor(count / 2);
    const ringTop = spring + ARCH_RISE + ARCH_RING + (keystone ? 0.1 : 0);
    const block: Point2[] = [p0, p1, [p1[0], ringTop], [p0[0], ringTop]];
    const colour = keystone ? shade(STONE_WARM, 0.08) : shade(STONE, i % 2 === 0 ? 0.02 : -0.04);
    bin.add('arch', prismZ(block, ARCH_Z0 - (keystone ? 0.03 : 0), ARCH_Z1 + (keystone ? 0.03 : 0)), colour);
  }
  // The attic over the posts and the arch, and its cornice.
  const ringTop = spring + ARCH_RISE + ARCH_RING;
  bin.add('arch', boxGeometry(west!.x + 0.15, spring, ARCH_Z0, ox0, ATTIC_TOP, ARCH_Z1), shade(STONE, -0.02));
  bin.add('arch', boxGeometry(ox1, spring, ARCH_Z0, east!.x + 0.85, ATTIC_TOP, ARCH_Z1), shade(STONE, -0.02));
  bin.add('arch', boxGeometry(ox0, ringTop, ARCH_Z0, ox1, ATTIC_TOP, ARCH_Z1), shade(STONE, -0.02));
  bin.add('arch', boxGeometry(west!.x + 0.05, ATTIC_TOP, ARCH_Z0 - 0.08, east!.x + 0.95, CORNICE_TOP, ARCH_Z1 + 0.08), COPING);
  // Banners from the posts' street faces: red, a gold band, a fringe.
  const face: Face = { normal: 'z+', plane: ARCH_Z1 };
  for (const [u0, u1] of [[west!.x + 0.28, ox0 - 0.08], [ox1 + 0.08, east!.x + 0.72]] as const) {
    bin.add('arch', faceBox(face, u0 - 0.03, 1.7, 0, u1 + 0.03, 1.76, 0.05), IRON);
    bin.add('arch', faceBox(face, u0, 0.86, 0.02, u1, 1.7, 0.04), (_x: number, y: number) => shade(BANNER_RED, -0.12 + 0.12 * clamp01((y - 0.86) / 0.84)));
    bin.add('arch', faceBox(face, u0, 1.38, 0.041, u1, 1.46, 0.046), ARENA_EMBER.gold);
    bin.add('arch', faceBox(face, u0, 0.98, 0.041, u1, 1.02, 0.046), ARENA_EMBER.gold);
    const mid = (u0 + u1) / 2;
    bin.add('arch', faceBox(face, mid - 0.06, 1.16, 0.041, mid + 0.06, 1.28, 0.047), ARENA_EMBER.sunTop);
    for (let k = 0; k < 4; k++) {
      const u = u0 + ((k + 0.5) * (u1 - u0)) / 4;
      bin.add('arch', faceBox(face, u - 0.025, 0.78, 0.02, u + 0.025, 0.86, 0.04), ARENA_EMBER.gold);
    }
  }
}
