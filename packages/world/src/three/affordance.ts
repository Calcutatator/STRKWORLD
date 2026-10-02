import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  SRGBColorSpace,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type InstancedMesh,
  type Material,
  type Object3D,
} from 'three';
import { GeometryBin, type Paint, type PaintRGBA } from './palette.js';

/**
 * What tells a player they can use something, now that the floor no longer
 * does (D-117, amended by D-123).
 *
 * Every usable thing (a counter, a Studio figure, the plaza's monument and
 * table, the bunker's lift) carries an "affordance shell": a copy of its own
 * surfaces drawn by one small additive shader. It does two jobs:
 *
 * - **Shimmer.** While the thing is usable, its surfaces carry a soft light in
 *   the thing's *own* colour (D-123 amended 2026-10-02): a base lift that
 *   breathes slowly (`SHIMMER_PERIOD_MS`), plus a diagonal band of light that
 *   glides across it every `SHIMMER_SWEEP_PERIOD_MS`, as on a shiny
 *   collectible. The sweep is what makes it legible from across a room: a
 *   brightness breathe alone reads as nothing on a dark counter, because the
 *   eye has no moving edge to catch. With reduced motion it is a still,
 *   slightly stronger tint instead.
 * - **Edge glow.** When the interaction system chooses it (in range and
 *   faced), the shimmer cross-fades over `AFFORDANCE_FADE_MS` into a soft
 *   ember rim: its surfaces brighten towards their edges (a fresnel term), and
 *   a thin band grows round its silhouette (an inverted hull: back faces
 *   pushed outward, which only show where nothing of the object is in front).
 *
 * Why this technique: the counters' desks, the plaza's pieces and the room
 * fixtures are merged into shared meshes per room (D-103), so there is no
 * per-station material to give a fresnel, and an OutlinePass would add a
 * depth-normal pass and several full-screen blurs every frame, on phones too.
 * The shell instead copies each station's own pieces at build time and merges
 * every station of an area into ONE mesh, with a per-vertex slot index into a
 * small uniform array of levels. So an area's whole affordance costs one draw
 * call, whether it holds one counter or sixteen figures, and a frame costs a
 * handful of float writes: no allocation, no material or program change.
 *
 * The shell is drawn twice from one buffer: a surface copy (front faces,
 * pulled forward by polygon offset, so it lands exactly on what the depth
 * buffer shows and never stacks where pieces overlap) and a band copy (back
 * faces, grown along each piece's corner direction by up to `GLOW_WIDTH`).
 * The fragment shader keeps each copy's own side only.
 *
 * Each station's shimmer takes its colour from the station itself. At build
 * time the shells tally the colours the station is actually painted in,
 * weighted by the area wearing them, pick the one that both covers it and
 * catches the eye, and bake it per vertex as `aTint` (one value per station,
 * so no uniform-array pressure on phones). The edge glow stays brand ember, so
 * the one thing E will use never reads as just another shimmer.
 *
 * The clock is shared: every shell reads one `uTime` uniform object, advanced
 * once a frame by the presenter (`advanceAffordanceClock`).
 */

/** Brand Ember (docs/brand/README.md): the colour of the one thing E will use. */
export const AFFORDANCE_EMBER = 0xf56a16;
/** The edge glow fades in and out over this long. */
export const AFFORDANCE_FADE_MS = 200;
/** One slow breath of the shimmer's base lift. */
export const SHIMMER_PERIOD_MS = 2500;
/** The base lift's peak, as additive tint over the surface. */
export const SHIMMER_PEAK = 0.2;
/** The base lift's trough: it never goes out, so it reads as a property of the thing. */
export const SHIMMER_FLOOR = 0.12;
/** One glide of the sweep: the band enters one side and leaves the other. */
export const SHIMMER_SWEEP_PERIOD_MS = 3000;
/**
 * The sweep band's half-width, as a fraction of the station's own extent along
 * `SHIMMER_SWEEP_AXIS`, so it crosses a Studio figure and a long desk alike.
 */
export const SHIMMER_SWEEP_WIDTH = 0.18;
/** The sweep's crest, on top of the base lift. */
export const SHIMMER_SWEEP_PEAK = 0.45;
/**
 * Each slot starts its breathe and its sweep this much further round the
 * cycle than the one before (golden ratio, so a long row never lines up).
 * Sixteen Studio figures pulsing in unison reads as a flashing room; the same
 * sixteen out of step read as a row of things quietly waiting to be used.
 */
export const SHIMMER_SLOT_PHASE = 0.618_033_988_75;
/**
 * The direction the sweep travels, in the area's space: mostly across (x),
 * leaning up (y) so the band sits diagonally, with a little depth (z) so top
 * and side faces catch it too rather than flashing all at once. Normalised.
 */
export const SHIMMER_SWEEP_AXIS = Object.freeze(new Vector3(0.68, 0.62, 0.39).normalize());
/** With reduced motion: a still tint, a shade stronger than the moving base, and no sweep. */
export const SHIMMER_STATIC = 0.24;
/** How far the glow's band grows past the silhouette, world units (a tile is 1). */
export const GLOW_WIDTH = 0.06;
/** Slots per shell: one per station in an area. */
export const AFFORDANCE_MAX_SLOTS = 32;

/** Every shimmer tint is lifted to this lightness, so a near-black station still shows one. */
export const SHIMMER_TINT_LIGHTNESS = 0.72;
/**
 * Below this chroma (colourfulness, max channel minus min) a station counts as
 * colourless and shimmers a pale warm white. Chroma, not HSL saturation:
 * saturation calls `#3b1b1b` a 37% red when the eye calls it black, which is
 * how a counter's dark bulk would otherwise out-vote its own gold trim.
 */
export const SHIMMER_TINT_MIN_CHROMA = 0.12;
/** The tint's saturation floor: enough that a near-grey station still reads as lit. */
export const SHIMMER_TINT_MIN_SATURATION = 0.16;
/** Neon stays neon, but not past this: a fully saturated additive tint clips to a flat blob. */
export const SHIMMER_TINT_MAX_SATURATION = 0.78;
/** The hue a colourless station borrows: warm, so grey stone reads as lit, not fogged. */
export const SHIMMER_TINT_WARM_HUE = 0.085;

/**
 * The shared clock wraps here: a whole number of both periods, so neither the
 * breathe nor the sweep jumps, and the float stays precise in a tab left open
 * all day. (4 minutes: 96 breaths, 80 sweeps.)
 */
export const AFFORDANCE_CLOCK_WRAP_MS = 240_000;

/** The one clock every shell reads, in ms, wrapped to whole shimmer periods. */
const sharedTime = { value: 0 };
/** 1 while the shimmer moves; 0 under reduced motion, which holds it still. */
const sharedMotion = { value: 1 };

/** Advance the shared shimmer clock; the presenter calls this once a frame. */
export function advanceAffordanceClock(deltaMs: number, reducedMotion: boolean): void {
  const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  sharedTime.value = (sharedTime.value + dt) % AFFORDANCE_CLOCK_WRAP_MS;
  sharedMotion.value = reducedMotion ? 0 : 1;
}

/** The shared clock and motion flag, read by tests. */
export function affordanceClock(): { readonly time: number; readonly motion: number } {
  return { time: sharedTime.value, motion: sharedMotion.value };
}

/** Where slot `index` sits in the cycle, 0 to 1: `SHIMMER_SLOT_PHASE` apart. */
export function shimmerSlotPhase(index: number): number {
  return (index * SHIMMER_SLOT_PHASE) % 1;
}

/** The shimmer's base lift at `timeMs` for a slot at `phase`: the slow breathe, or a still tint. */
export function shimmerBase(timeMs: number, reducedMotion: boolean, phase = 0): number {
  if (reducedMotion) return SHIMMER_STATIC;
  const breath = 0.5 - 0.5 * Math.cos((timeMs / SHIMMER_PERIOD_MS + phase) * Math.PI * 2);
  return SHIMMER_FLOOR + (SHIMMER_PEAK - SHIMMER_FLOOR) * breath;
}

/**
 * The sweep's contribution at `timeMs` to a point `along` a slot at `phase`
 * (0 at the near end of `SHIMMER_SWEEP_AXIS`, 1 at the far one). Reduced
 * motion has none.
 */
export function shimmerSweep(timeMs: number, along: number, reducedMotion: boolean, phase = 0): number {
  if (reducedMotion) return 0;
  // The band's centre runs from just off one end to just off the other, so the
  // station starts and ends each glide completely unlit by it.
  const glide = (timeMs / SHIMMER_SWEEP_PERIOD_MS + phase) % 1;
  const head = glide * (1 + 2 * SHIMMER_SWEEP_WIDTH) - SHIMMER_SWEEP_WIDTH;
  const band = 1 - Math.min(Math.abs(along - head) / SHIMMER_SWEEP_WIDTH, 1);
  return SHIMMER_SWEEP_PEAK * band * band * (3 - 2 * band);
}

/** The shimmer's strength at `timeMs`, exactly as the shader computes it. */
export function shimmerStrength(timeMs: number, along: number, reducedMotion: boolean, phase = 0): number {
  return shimmerBase(timeMs, reducedMotion, phase) + shimmerSweep(timeMs, along, reducedMotion, phase);
}

/**
 * The shells of one area (a room, the Studio, the plaza): which things they
 * cover, which of those are usable, and which one the interaction system
 * chose.
 */
export interface AffordanceSet {
  /** The one mesh drawing every shell in the area; hidden while nothing is usable or glowing. */
  readonly mesh: Mesh;
  /** The target ids this area covers, in slot order. */
  readonly ids: readonly string[];
  /** The id glowing now (or fading towards it), or null. */
  readonly focused: string | null;
  has(id: string): boolean;
  /** The colour this thing shimmers in, derived from its own paint at build time. */
  shimmerColor(id: string): number;
  /** Usable things shimmer and can glow; an unusable one (a locked counter) does neither. */
  setUsable(id: string, usable: boolean): void;
  isUsable(id: string): boolean;
  /** The interaction system's chosen target: glow it if it is here and usable, and let any other fade. */
  focus(id: string | null): void;
  /** 0 to 1: how far the glow has faded in. */
  glowLevel(id: string): number;
  /** 0 to 1: how much of the shimmer shows (usable, and not crossed into the glow). */
  shimmerLevel(id: string): number;
  update(deltaMs: number): void;
  dispose(): void;
}

/** Collects the pieces of each usable thing in an area, then merges them into one `AffordanceSet`. */
export interface AffordanceShells {
  /**
   * Add a piece of the thing named `id` (the id its interaction target
   * uses). The geometry is copied, never kept; `matrix` places it in the
   * area's space.
   */
  add(id: string, geometry: BufferGeometry, matrix?: Matrix4): void;
  /** Add every mesh under `object`, as it stands now, in the space of `space` (default: `object`'s parent). */
  addObject(id: string, object: Object3D, space?: Object3D | null): void;
  /**
   * A bin that fills `target` as usual and also records each piece for `id`,
   * so a builder that already merges a station into shared meshes hands its
   * shell over for free. `keep` filters the pieces (e.g. only those on the
   * station's own footprint). Glass is never recorded: a shell on it would
   * light whatever stands behind it too.
   */
  record(id: string, target: GeometryBin, keep?: (geometry: BufferGeometry) => boolean): GeometryBin;
  /** Declare `id` even before (or without) any piece, so its slot order is fixed. */
  declare(id: string): void;
  readonly size: number;
  /** One mesh for every piece added, named `name`; null when nothing was added. */
  build(name: string): AffordanceSet | null;
}

export function createAffordanceShells(): AffordanceShells {
  const order: string[] = [];
  const pieces = new Map<string, BufferGeometry[]>();
  /** What each station is painted in, by area: the shimmer's colour comes from here. */
  const tallies = new Map<string, TintTally>();
  const slotOf = (id: string): BufferGeometry[] => {
    let list = pieces.get(id);
    if (!list) {
      if (order.length >= AFFORDANCE_MAX_SLOTS) throw new Error(`An affordance shell holds at most ${AFFORDANCE_MAX_SLOTS} things`);
      list = [];
      pieces.set(id, list);
      tallies.set(id, new Map());
      order.push(id);
    }
    return list;
  };
  /**
   * One piece of `id`'s shell. `colour` says what the piece is painted in — the
   * builder's own paint, the geometry's baked vertex colours or its material —
   * and defaults to the geometry's own colours.
   */
  const add = (id: string, geometry: BufferGeometry, matrix?: Matrix4, colour?: TriangleColor | null): void => {
    const piece = shellPiece(geometry, matrix);
    if (!piece) return;
    slotOf(id).push(piece);
    const sampler = colour === undefined ? vertexColors(geometry) : colour;
    if (sampler) tallyColors(geometry, matrix, sampler, tallies.get(id)!);
  };
  return {
    get size() {
      return order.length;
    },
    declare(id) {
      slotOf(id);
    },
    add(id, geometry, matrix) {
      add(id, geometry, matrix);
    },
    addObject(id, object, space = object.parent) {
      object.updateWorldMatrix(true, true);
      const inverse = new Matrix4();
      if (space) {
        space.updateWorldMatrix(true, false);
        inverse.copy(space.matrixWorld).invert();
      }
      const matrix = new Matrix4();
      const instance = new Matrix4();
      object.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh || !(mesh.geometry instanceof BufferGeometry) || mesh.userData['affordance']) return;
        matrix.multiplyMatrices(inverse, mesh.matrixWorld);
        // Its baked vertex colours if it has them (a merged bin), else its material's.
        const colour = vertexColors(mesh.geometry) ?? materialColor(mesh.material);
        const instanced = mesh as unknown as InstancedMesh;
        if (instanced.isInstancedMesh) {
          // Each instance as it stands now (the arena gate's two leaves).
          for (let i = 0; i < instanced.count; i++) {
            instanced.getMatrixAt(i, instance);
            add(id, mesh.geometry, instance.premultiply(matrix), colour);
          }
          return;
        }
        add(id, mesh.geometry, matrix, colour);
      });
    },
    record(id, target, keep) {
      slotOf(id);
      return new RecordingBin(target, (key, geometry, colour) => {
        if (key === 'glass') return;
        if (!keep || keep(geometry)) add(id, geometry, undefined, colour);
      });
    },
    build(name) {
      const slots = order.filter((id) => (pieces.get(id)?.length ?? 0) > 0);
      if (slots.length === 0) {
        for (const list of pieces.values()) for (const piece of list) piece.dispose();
        return null;
      }
      const tints = slots.map((id) => shimmerTint(tallies.get(id)!).getHex());
      const geometry = mergeShell(slots.map((id) => pieces.get(id)!), tints);
      for (const list of pieces.values()) for (const piece of list) piece.dispose();
      pieces.clear();
      tallies.clear();
      return createAffordanceSet(name, slots, geometry, tints);
    },
  };
}

/**
 * A `GeometryBin` that fills another and records each piece as it goes.
 * Every method the builders call delegates; the recording copies the piece
 * before the target bin prepares (and may consume) it. The piece's paint comes
 * along, so the shimmer can take its colour from what the builder asked for —
 * the bin bakes it into vertex colours we would otherwise never see.
 */
class RecordingBin extends GeometryBin {
  constructor(
    private readonly target: GeometryBin,
    private readonly onPiece: (key: string, geometry: BufferGeometry, colour: TriangleColor) => void,
  ) {
    super();
  }

  override add(key: string, geometry: BufferGeometry, paint: Paint): void {
    this.onPiece(key, geometry, paintColor(paint));
    this.target.add(key, geometry, paint);
  }

  override addRGBA(key: string, geometry: BufferGeometry, paint: PaintRGBA): void {
    this.onPiece(key, geometry, paintRGBAColor(paint));
    this.target.addRGBA(key, geometry, paint);
  }

  override has(key: string): boolean {
    return this.target.has(key);
  }

  override take(key: string): BufferGeometry | null {
    return this.target.take(key);
  }

  override dispose(): void {
    // The target belongs to its builder, which disposes it.
  }
}

// ---------------------------------------------------------------------------
// Each station's own colour
// ---------------------------------------------------------------------------

/** Linear working-space rgb, plus how opaque the piece is there. */
interface ColorSample {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * What one triangle of a piece is painted in: its three vertex indices and its
 * centre (in the geometry's own space, which is what a `PaintFn` was written
 * against) in, `out` filled, false when there is no colour to tally.
 */
type TriangleColor = (
  i0: number,
  i1: number,
  i2: number,
  cx: number,
  cy: number,
  cz: number,
  out: ColorSample,
) => boolean;

/** Quantised colour key to the surface area wearing it. */
type TintTally = Map<number, number>;

/**
 * Steps per channel in a colour key. Quantising in gamma space (not linear)
 * keeps the dark end of the ramp apart, which is where a voxel city lives.
 */
const TINT_STEPS = 20;

const tintCorners = [new Vector3(), new Vector3(), new Vector3()] as const;
const tintEdge = new Vector3();
const tintEdgeB = new Vector3();
const tintSample: ColorSample = { r: 0, g: 0, b: 0, a: 1 };
const tintPick = new Color();
const tintHSL = { h: 0, s: 0, l: 0 };

function tintKey(r: number, g: number, b: number): number {
  const step = (value: number): number => {
    const gamma = Math.sqrt(Math.min(1, Math.max(0, value)));
    return Math.min(TINT_STEPS - 1, Math.round(gamma * (TINT_STEPS - 1)));
  };
  return (step(r) * TINT_STEPS + step(g)) * TINT_STEPS + step(b);
}

function tintFromKey(key: number, into: Color): Color {
  const blue = key % TINT_STEPS;
  const green = Math.floor(key / TINT_STEPS) % TINT_STEPS;
  const red = Math.floor(key / (TINT_STEPS * TINT_STEPS));
  const value = (step: number): number => (step / (TINT_STEPS - 1)) ** 2;
  return into.setRGB(value(red), value(green), value(blue));
}

/**
 * Add one piece's colours to `tally`, by triangle area (in `matrix`'s space, so
 * a big piece counts for more than a small one wearing the same paint).
 */
function tallyColors(geometry: BufferGeometry, matrix: Matrix4 | undefined, colour: TriangleColor, tally: TintTally): void {
  const position = geometry.getAttribute('position');
  if (!position || position.count < 3) return;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const [a, b, c] = tintCorners;
  for (let at = 0; at + 2 < count; at += 3) {
    const i0 = index ? index.getX(at) : at;
    const i1 = index ? index.getX(at + 1) : at + 1;
    const i2 = index ? index.getX(at + 2) : at + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    if (matrix) {
      a.applyMatrix4(matrix);
      b.applyMatrix4(matrix);
      c.applyMatrix4(matrix);
    }
    const area = tintEdge.subVectors(b, a).cross(tintEdgeB.subVectors(c, a)).length() / 2;
    if (!(area > 0) || !Number.isFinite(area)) continue;
    if (!colour(i0, i1, i2, cx, cy, cz, tintSample)) continue;
    const weight = area * tintSample.a;
    if (!(weight > 0)) continue;
    const key = tintKey(tintSample.r, tintSample.g, tintSample.b);
    tally.set(key, (tally.get(key) ?? 0) + weight);
  }
}

/** A builder's paint: a constant, or a function sampled at each triangle's centre. */
function paintColor(paint: Paint): TriangleColor {
  if (typeof paint === 'function') {
    return (_i0, _i1, _i2, x, y, z, out) => {
      const color = paint(x, y, z);
      out.r = color.r;
      out.g = color.g;
      out.b = color.b;
      out.a = 1;
      return true;
    };
  }
  const flat = paint instanceof Color ? paint.clone() : new Color(paint);
  return (_i0, _i1, _i2, _x, _y, _z, out) => {
    out.r = flat.r;
    out.g = flat.g;
    out.b = flat.b;
    out.a = 1;
    return true;
  };
}

/** A gradient light decal's paint: its alpha is how much of it there is. */
function paintRGBAColor(paint: PaintRGBA): TriangleColor {
  return (_i0, _i1, _i2, x, y, z, out) => {
    const [r, g, b, a] = paint(x, y, z);
    out.r = r;
    out.g = g;
    out.b = b;
    out.a = a;
    return true;
  };
}

/** The geometry's own baked vertex colours, averaged over each triangle. */
function vertexColors(geometry: BufferGeometry): TriangleColor | null {
  const attribute = geometry.getAttribute('color');
  if (!attribute) return null;
  const hasAlpha = attribute.itemSize >= 4;
  return (i0, i1, i2, _x, _y, _z, out) => {
    out.r = (attribute.getX(i0) + attribute.getX(i1) + attribute.getX(i2)) / 3;
    out.g = (attribute.getY(i0) + attribute.getY(i1) + attribute.getY(i2)) / 3;
    out.b = (attribute.getZ(i0) + attribute.getZ(i1) + attribute.getZ(i2)) / 3;
    out.a = hasAlpha ? (attribute.getW(i0) + attribute.getW(i1) + attribute.getW(i2)) / 3 : 1;
    return true;
  };
}

/** A mesh's material colour, for a piece carrying no vertex colours of its own. */
function materialColor(material: Material | Material[] | null | undefined): TriangleColor | null {
  const list = Array.isArray(material) ? material : [material];
  const found = list.find((one) => (one as { color?: unknown } | null | undefined)?.color instanceof Color);
  if (!found) return null;
  const flat = (found as unknown as { color: Color }).color.clone();
  return (_i0, _i1, _i2, _x, _y, _z, out) => {
    out.r = flat.r;
    out.g = flat.g;
    out.b = flat.b;
    out.a = 1;
    return true;
  };
}

/**
 * The colour one station shimmers in: the colour it is most covered by that
 * also catches the eye — a gold trim beats the dark desk behind it, a neon
 * strip beats the black floor around it — lifted to a fixed lightness so every
 * station reads at the same strength, and nudged warm when the station has no
 * colour of its own to borrow (bare stone, white plaster, a black counter).
 *
 * Build time only, once per station.
 */
export function shimmerTint(tally: ReadonlyMap<number, number>, into = new Color()): Color {
  let best = -1;
  let bestScore = 0;
  for (const [key, weight] of tally) {
    tintFromKey(key, tintPick).getHSL(tintHSL, SRGBColorSpace);
    const chroma = 2 * tintHSL.s * Math.min(tintHSL.l, 1 - tintHSL.l);
    // Area, but weighted by how much the colour catches the eye: its
    // colourfulness and how light it is. The small constants are what keeps a
    // big plain surface in the running against a thin bright trim.
    const score = weight * (0.06 + chroma) * (0.15 + tintHSL.l + chroma / 2);
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  if (best < 0) {
    return into.setHSL(SHIMMER_TINT_WARM_HUE, SHIMMER_TINT_MIN_SATURATION, SHIMMER_TINT_LIGHTNESS, SRGBColorSpace);
  }
  tintFromKey(best, tintPick).getHSL(tintHSL, SRGBColorSpace);
  const colourless = 2 * tintHSL.s * Math.min(tintHSL.l, 1 - tintHSL.l) < SHIMMER_TINT_MIN_CHROMA;
  return into.setHSL(
    colourless ? SHIMMER_TINT_WARM_HUE : tintHSL.h,
    colourless
      ? SHIMMER_TINT_MIN_SATURATION
      : Math.min(Math.max(tintHSL.s, SHIMMER_TINT_MIN_SATURATION), SHIMMER_TINT_MAX_SATURATION),
    SHIMMER_TINT_LIGHTNESS,
    SRGBColorSpace,
  );
}

const corner = new Vector3();
const centre = new Vector3();

/**
 * One piece as a shell part: its positions and normals (placed by `matrix`),
 * non-indexed, plus `aGrow`, the sign of each vertex's offset from the
 * piece's centre on each axis. A box grown along `aGrow` stays a closed box
 * (no cracks at its corners, as growing along face normals would leave), and
 * normalised it is a smooth corner normal that brightens the piece's edges.
 */
function shellPiece(source: BufferGeometry, matrix?: Matrix4): BufferGeometry | null {
  const position = source.getAttribute('position');
  if (!position || position.count === 0) return null;
  const flat = source.index ? source.toNonIndexed() : source;
  try {
    const positions = flat.getAttribute('position');
    const normals = flat.getAttribute('normal');
    const count = positions.count;
    const out = new Float32Array(count * 3);
    const outNormal = new Float32Array(count * 3);
    const normalMatrix = matrix ? new Matrix4().copy(matrix).invert().transpose() : null;
    const n = new Vector3();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      corner.fromBufferAttribute(positions, i);
      if (matrix) corner.applyMatrix4(matrix);
      if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y) || !Number.isFinite(corner.z)) return null;
      out[i * 3] = corner.x;
      out[i * 3 + 1] = corner.y;
      out[i * 3 + 2] = corner.z;
      minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      minZ = Math.min(minZ, corner.z); maxZ = Math.max(maxZ, corner.z);
      if (normals) {
        n.fromBufferAttribute(normals, i);
        if (normalMatrix) n.transformDirection(normalMatrix);
      } else {
        n.set(0, 1, 0);
      }
      outNormal[i * 3] = n.x;
      outNormal[i * 3 + 1] = n.y;
      outNormal[i * 3 + 2] = n.z;
    }
    centre.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const tolerance = [maxX - minX, maxY - minY, maxZ - minZ].map((size) => Math.max(1e-5, size * 1e-3));
    const grow = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const offset = out[i * 3 + axis]! - centre.getComponent(axis);
        grow[i * 3 + axis] = Math.abs(offset) <= tolerance[axis]! ? 0 : Math.sign(offset);
      }
    }
    const piece = new BufferGeometry();
    piece.setAttribute('position', new BufferAttribute(out, 3));
    piece.setAttribute('normal', new BufferAttribute(outNormal, 3));
    piece.setAttribute('aGrow', new BufferAttribute(grow, 3));
    return piece;
  } finally {
    if (flat !== source) flat.dispose();
  }
}

/**
 * Every slot's pieces as one geometry, written twice: the surface copy
 * (`aBand` 0) then the band copy (`aBand` 1), each vertex tagged with its
 * slot, its station's shimmer tint and where it sits along the sweep.
 *
 * `aSweep.x` is 0 at the near end of `SHIMMER_SWEEP_AXIS` and 1 at the far
 * one, measured over each *station's* own extent, so one glide crosses a
 * Studio figure and a six-tile desk in the same time. `aSweep.y` is that
 * station's offset into the cycle, so a room's stations never move as one.
 */
function mergeShell(slots: readonly (readonly BufferGeometry[])[], tints: readonly number[]): BufferGeometry {
  let count = 0;
  for (const list of slots) for (const piece of list) count += piece.getAttribute('position').count;
  const total = count * 2;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const grow = new Float32Array(total * 3);
  const slot = new Float32Array(total);
  const band = new Float32Array(total);
  const sweep = new Float32Array(total * 2);
  const tint = new Float32Array(total * 3);
  const axis = SHIMMER_SWEEP_AXIS;
  const extents = slots.map((list) => {
    let min = Infinity;
    let max = -Infinity;
    for (const piece of list) {
      const points = piece.getAttribute('position');
      for (let i = 0; i < points.count; i++) {
        const along = points.getX(i) * axis.x + points.getY(i) * axis.y + points.getZ(i) * axis.z;
        if (along < min) min = along;
        if (along > max) max = along;
      }
    }
    return { min, size: Math.max(max - min, 1e-4) };
  });
  const tintColor = new Color();
  let at = 0;
  for (let copy = 0; copy < 2; copy++) {
    slots.forEach((list, index) => {
      const extent = extents[index]!;
      const phase = shimmerSlotPhase(index);
      tintColor.setHex(tints[index] ?? 0xffffff);
      for (const piece of list) {
        const points = piece.getAttribute('position');
        const n = points.count;
        position.set(points.array as Float32Array, at * 3);
        normal.set(piece.getAttribute('normal').array as Float32Array, at * 3);
        grow.set(piece.getAttribute('aGrow').array as Float32Array, at * 3);
        slot.fill(index, at, at + n);
        band.fill(copy, at, at + n);
        for (let i = 0; i < n; i++) {
          const along = points.getX(i) * axis.x + points.getY(i) * axis.y + points.getZ(i) * axis.z;
          sweep[(at + i) * 2] = (along - extent.min) / extent.size;
          sweep[(at + i) * 2 + 1] = phase;
          tint[(at + i) * 3] = tintColor.r;
          tint[(at + i) * 3 + 1] = tintColor.g;
          tint[(at + i) * 3 + 2] = tintColor.b;
        }
        at += n;
      }
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('aGrow', new BufferAttribute(grow, 3));
  geometry.setAttribute('aSlot', new BufferAttribute(slot, 1));
  geometry.setAttribute('aBand', new BufferAttribute(band, 1));
  geometry.setAttribute('aSweep', new BufferAttribute(sweep, 2));
  geometry.setAttribute('aTint', new BufferAttribute(tint, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // The band grows past the pieces; keep it inside the culling sphere.
  if (geometry.boundingSphere) geometry.boundingSphere.radius += GLOW_WIDTH * Math.SQRT2 * 1.3;
  return geometry;
}

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aGrow;
attribute vec3 aTint;
attribute float aSlot;
attribute float aBand;
attribute vec2 aSweep;
uniform vec2 uSlots[${AFFORDANCE_MAX_SLOTS}];
uniform float uTime;
uniform float uMotion;
varying float vShimmer;
varying float vGlow;
varying float vBand;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vTint;
void main() {
  vec2 slot = uSlots[int(aSlot + 0.5)];
  float glow = slot.y;
  // This station's own offset into the cycle, so a row never moves as one.
  float offset = aSweep.y;
  // The base lift: a slow breathe, so a usable thing is never flat dark.
  float breath = 0.5 - 0.5 * cos((uTime / ${SHIMMER_PERIOD_MS.toFixed(1)} + offset) * 6.28318530718);
  float lift = ${SHIMMER_FLOOR.toFixed(4)} + ${(SHIMMER_PEAK - SHIMMER_FLOOR).toFixed(4)} * breath;
  // The sweep: a soft band gliding along the station from one end to the other.
  // It starts and ends each glide clear of the thing, so there is no snap.
  float head = fract(uTime / ${SHIMMER_SWEEP_PERIOD_MS.toFixed(1)} + offset) * ${(1 + 2 * SHIMMER_SWEEP_WIDTH).toFixed(4)} - ${SHIMMER_SWEEP_WIDTH.toFixed(4)};
  float edge = 1.0 - min(abs(aSweep.x - head) / ${SHIMMER_SWEEP_WIDTH.toFixed(4)}, 1.0);
  float sweep = ${SHIMMER_SWEEP_PEAK.toFixed(4)} * edge * edge * (3.0 - 2.0 * edge);
  // Reduced motion: neither, just a still tint a shade stronger.
  float level = mix(${SHIMMER_STATIC.toFixed(4)}, lift + sweep, uMotion);
  vShimmer = slot.x * (1.0 - glow) * level;
  vGlow = glow;
  vBand = aBand;
  vTint = aTint;
  float along = length(aGrow);
  vec3 dir = along > 0.0 ? aGrow / along : normal;
  // Only the band copy grows, and only as far as the glow has faded in.
  vec3 grown = position + dir * (${GLOW_WIDTH.toFixed(4)} * glow * aBand);
  vec4 mvPosition = modelViewMatrix * vec4(grown, 1.0);
  // The rim reads the corner direction blended into the face normal: flat
  // faces stay flat in the middle and brighten towards their edges.
  vNormal = normalize(normalMatrix * normalize(normal + 1.2 * dir));
  vView = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
varying float vShimmer;
varying float vGlow;
varying float vBand;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vTint;
void main() {
  // The surface copy draws front faces only; the band copy back faces only.
  bool bandCopy = vBand > 0.5;
  if (bandCopy == gl_FrontFacing) discard;
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float rim = pow(1.0 - facing, 2.0);
  float strength;
  vec3 color;
  if (bandCopy) {
    // Back faces past the silhouette: strongest next to the object, fading out.
    // The band is the chosen target's rim, so it is always brand ember.
    strength = vGlow * (0.3 + 0.6 * facing);
    color = uColor;
  } else {
    // A light bias towards the edges, but gentle: the sweep has to read across
    // a flat face, not only round its rim.
    float shimmer = vShimmer * (0.8 + 0.5 * rim);
    float glow = vGlow * (0.03 + 0.5 * rim);
    strength = shimmer + glow;
    // The thing's own colour while it idles, ember once E would use it.
    color = mix(uColor, vTint, shimmer / max(strength, 1e-4));
  }
  #ifdef USE_FOG
    strength *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  if (strength < 0.002) discard;
  gl_FragColor = vec4(color, strength);
  #include <colorspace_fragment>
}
`;

function createAffordanceSet(
  name: string,
  ids: readonly string[],
  geometry: BufferGeometry,
  tints: readonly number[],
): AffordanceSet {
  // x: shimmer weight (usable, eased), y: glow level (eased), per slot.
  const levels = new Float32Array(AFFORDANCE_MAX_SLOTS * 2);
  const material = new ShaderMaterial({
    name: 'affordance-shell',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { uColor: { value: new Color(AFFORDANCE_EMBER) } }]),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  // Shared by reference across every shell, so one write a frame drives them all.
  material.uniforms['uTime'] = sharedTime;
  material.uniforms['uMotion'] = sharedMotion;
  material.uniforms['uSlots'] = { value: levels };
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData['affordance'] = ids;
  mesh.visible = false;

  const index = new Map(ids.map((id, slot) => [id, slot] as const));
  const usable = new Array<boolean>(ids.length).fill(false);
  let focused: string | null = null;
  let disposed = false;

  const refreshVisibility = (): void => {
    let any = false;
    for (let slot = 0; slot < ids.length && !any; slot++) {
      if (levels[slot * 2]! > 0 || levels[slot * 2 + 1]! > 0 || usable[slot]) any = true;
    }
    mesh.visible = any;
  };

  return {
    mesh,
    ids,
    get focused() {
      return focused;
    },
    has(id) {
      return index.has(id);
    },
    shimmerColor(id) {
      const slot = index.get(id);
      return slot === undefined ? 0 : tints[slot]!;
    },
    setUsable(id, value) {
      const slot = index.get(id);
      if (disposed || slot === undefined) return;
      usable[slot] = value === true;
      // Usability shows at once (a counter unlocking is news); only the glow fades.
      levels[slot * 2] = usable[slot] ? 1 : 0;
      if (!usable[slot]) {
        levels[slot * 2 + 1] = 0;
        if (focused === id) focused = null;
      }
      refreshVisibility();
    },
    isUsable(id) {
      const slot = index.get(id);
      return slot !== undefined && usable[slot] === true;
    },
    focus(id) {
      if (disposed) return;
      const slot = id === null ? undefined : index.get(id);
      focused = slot !== undefined && usable[slot] ? id : null;
    },
    glowLevel(id) {
      const slot = index.get(id);
      return slot === undefined ? 0 : levels[slot * 2 + 1]!;
    },
    shimmerLevel(id) {
      const slot = index.get(id);
      return slot === undefined ? 0 : levels[slot * 2]! * (1 - levels[slot * 2 + 1]!);
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      const step = dt / AFFORDANCE_FADE_MS;
      let changed = false;
      for (let slot = 0; slot < ids.length; slot++) {
        const goal = ids[slot] === focused && usable[slot] ? 1 : 0;
        const at = slot * 2 + 1;
        const current = levels[at]!;
        if (current === goal) continue;
        levels[at] = goal > current ? Math.min(goal, current + step) : Math.max(goal, current - step);
        changed = true;
      }
      if (changed) refreshVisibility();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
