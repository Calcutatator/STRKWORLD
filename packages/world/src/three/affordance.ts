import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type InstancedMesh,
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
 * - **Shimmer.** While the thing is usable, its surfaces glow ember a few
 *   percent, pulsing slowly (`SHIMMER_PERIOD_MS`), so it can be found from
 *   across the room. With reduced motion it is a still, faint tint.
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
 * The clock is shared: every shell reads one `uTime` uniform object, advanced
 * once a frame by the presenter (`advanceAffordanceClock`).
 */

/** Brand Ember (docs/brand/README.md): the colour of everything that says "use me". */
export const AFFORDANCE_EMBER = 0xf56a16;
/** The edge glow fades in and out over this long. */
export const AFFORDANCE_FADE_MS = 200;
/** One slow breath of the distant shimmer. */
export const SHIMMER_PERIOD_MS = 2500;
/** The shimmer's peak, as additive ember over the surface: a few percent. */
export const SHIMMER_PEAK = 0.09;
/** The shimmer's trough: it never quite goes out, so it reads as a property of the thing. */
export const SHIMMER_FLOOR = 0.03;
/** With reduced motion: a still tint between the two. */
export const SHIMMER_STATIC = 0.05;
/** How far the glow's band grows past the silhouette, world units (a tile is 1). */
export const GLOW_WIDTH = 0.06;
/** Slots per shell: one per station in an area. */
export const AFFORDANCE_MAX_SLOTS = 32;

/** The one clock every shell reads, in ms, wrapped to whole shimmer periods. */
const sharedTime = { value: 0 };
/** 1 while the shimmer pulses; 0 under reduced motion, which holds it still. */
const sharedMotion = { value: 1 };

/** Advance the shared shimmer clock; the presenter calls this once a frame. */
export function advanceAffordanceClock(deltaMs: number, reducedMotion: boolean): void {
  const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  // Wrapping at whole periods keeps the float precise in a tab left open all day.
  sharedTime.value = (sharedTime.value + dt) % (SHIMMER_PERIOD_MS * 64);
  sharedMotion.value = reducedMotion ? 0 : 1;
}

/** The shared clock and motion flag, read by tests. */
export function affordanceClock(): { readonly time: number; readonly motion: number } {
  return { time: sharedTime.value, motion: sharedMotion.value };
}

/** The shimmer's strength at `timeMs`, exactly as the shader computes it. */
export function shimmerStrength(timeMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return SHIMMER_STATIC;
  const phase = 0.5 - 0.5 * Math.cos((timeMs / SHIMMER_PERIOD_MS) * Math.PI * 2);
  return SHIMMER_FLOOR + (SHIMMER_PEAK - SHIMMER_FLOOR) * phase;
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
  const slotOf = (id: string): BufferGeometry[] => {
    let list = pieces.get(id);
    if (!list) {
      if (order.length >= AFFORDANCE_MAX_SLOTS) throw new Error(`An affordance shell holds at most ${AFFORDANCE_MAX_SLOTS} things`);
      list = [];
      pieces.set(id, list);
      order.push(id);
    }
    return list;
  };
  const add = (id: string, geometry: BufferGeometry, matrix?: Matrix4): void => {
    const piece = shellPiece(geometry, matrix);
    if (piece) slotOf(id).push(piece);
  };
  return {
    get size() {
      return order.length;
    },
    declare(id) {
      slotOf(id);
    },
    add,
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
        const instanced = mesh as unknown as InstancedMesh;
        if (instanced.isInstancedMesh) {
          // Each instance as it stands now (the arena gate's two leaves).
          for (let i = 0; i < instanced.count; i++) {
            instanced.getMatrixAt(i, instance);
            add(id, mesh.geometry, instance.premultiply(matrix));
          }
          return;
        }
        add(id, mesh.geometry, matrix);
      });
    },
    record(id, target, keep) {
      slotOf(id);
      return new RecordingBin(target, (key, geometry) => {
        if (key === 'glass') return;
        if (!keep || keep(geometry)) add(id, geometry);
      });
    },
    build(name) {
      const slots = order.filter((id) => (pieces.get(id)?.length ?? 0) > 0);
      if (slots.length === 0) {
        for (const list of pieces.values()) for (const piece of list) piece.dispose();
        return null;
      }
      const geometry = mergeShell(slots.map((id) => pieces.get(id)!));
      for (const list of pieces.values()) for (const piece of list) piece.dispose();
      pieces.clear();
      return createAffordanceSet(name, slots, geometry);
    },
  };
}

/**
 * A `GeometryBin` that fills another and records each piece as it goes.
 * Every method the builders call delegates; the recording copies the piece
 * before the target bin prepares (and may consume) it.
 */
class RecordingBin extends GeometryBin {
  constructor(
    private readonly target: GeometryBin,
    private readonly onPiece: (key: string, geometry: BufferGeometry) => void,
  ) {
    super();
  }

  override add(key: string, geometry: BufferGeometry, paint: Paint): void {
    this.onPiece(key, geometry);
    this.target.add(key, geometry, paint);
  }

  override addRGBA(key: string, geometry: BufferGeometry, paint: PaintRGBA): void {
    this.onPiece(key, geometry);
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
 * slot.
 */
function mergeShell(slots: readonly (readonly BufferGeometry[])[]): BufferGeometry {
  let count = 0;
  for (const list of slots) for (const piece of list) count += piece.getAttribute('position').count;
  const total = count * 2;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const grow = new Float32Array(total * 3);
  const slot = new Float32Array(total);
  const band = new Float32Array(total);
  let at = 0;
  for (let copy = 0; copy < 2; copy++) {
    slots.forEach((list, index) => {
      for (const piece of list) {
        const n = piece.getAttribute('position').count;
        position.set(piece.getAttribute('position').array as Float32Array, at * 3);
        normal.set(piece.getAttribute('normal').array as Float32Array, at * 3);
        grow.set(piece.getAttribute('aGrow').array as Float32Array, at * 3);
        slot.fill(index, at, at + n);
        band.fill(copy, at, at + n);
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
attribute float aSlot;
attribute float aBand;
uniform vec2 uSlots[${AFFORDANCE_MAX_SLOTS}];
uniform float uTime;
uniform float uMotion;
varying float vShimmer;
varying float vGlow;
varying float vBand;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec2 slot = uSlots[int(aSlot + 0.5)];
  float glow = slot.y;
  float phase = 0.5 - 0.5 * cos(uTime / ${SHIMMER_PERIOD_MS.toFixed(1)} * 6.28318530718);
  float pulse = mix(${SHIMMER_STATIC.toFixed(4)}, ${SHIMMER_FLOOR.toFixed(4)} + ${(SHIMMER_PEAK - SHIMMER_FLOOR).toFixed(4)} * phase, uMotion);
  vShimmer = slot.x * (1.0 - glow) * pulse;
  vGlow = glow;
  vBand = aBand;
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
void main() {
  // The surface copy draws front faces only; the band copy back faces only.
  bool bandCopy = vBand > 0.5;
  if (bandCopy == gl_FrontFacing) discard;
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float rim = pow(1.0 - facing, 2.0);
  float strength;
  if (bandCopy) {
    // Back faces past the silhouette: strongest next to the object, fading out.
    strength = vGlow * (0.3 + 0.6 * facing);
  } else {
    strength = vShimmer * (0.6 + 0.9 * rim) + vGlow * (0.03 + 0.5 * rim);
  }
  #ifdef USE_FOG
    strength *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  if (strength < 0.002) discard;
  gl_FragColor = vec4(uColor, strength);
  #include <colorspace_fragment>
}
`;

function createAffordanceSet(name: string, ids: readonly string[], geometry: BufferGeometry): AffordanceSet {
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
