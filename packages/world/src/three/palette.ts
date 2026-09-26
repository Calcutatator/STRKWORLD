import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NormalBlending,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { ColorRepresentation, Material, Object3D, Texture } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingId } from '@strkworld/shared';
import type { Occluder, OccluderBounds } from './types.js';

/**
 * Colours, material specs and the small low-poly kit shared by the 3D
 * environment builders — street, fixed rooms and the Avatar Studio (D-059).
 *
 * Everything here is presentation. One palette keeps a building's facade, its
 * sign and its interior reading as one place; one kit means every builder
 * merges geometry per material, fades occluders and disposes GPU resources the
 * same way, which is what keeps the street under its draw-call budget.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Golden-hour street colours. Slightly desaturated: the key light is warm. */
export const PALETTE = Object.freeze({
  grassWarm: 0x86ad55,
  grassCool: 0x5f9150,
  asphalt: 0x51525c,
  paint: 0xf4f0e4,
  paintCentre: 0xf2cf6b,
  sidewalk: 0xc4bdb1,
  sidewalkAlt: 0xbab3a7,
  kerb: 0xa39c91,
  tactile: 0xd8b24a,
  pathStone: 0xd6c9ab,
  apron: 0xb1aa9e,
  hedge: 0x3f7a3f,
  hedgeLight: 0x4f8b47,
  trunk: 0x6e4b33,
  canopies: Object.freeze([0x4f8f41, 0x5f9d46, 0x6ea94c, 0x86a843, 0xd08b3e]),
  pines: Object.freeze([0x3e7449, 0x4a8150, 0x3a6b47]),
  flowers: Object.freeze([0xf48fb1, 0xffd166, 0xfffaf0, 0xb39ddb, 0xff8a65]),
  leaf: 0x4c7d3a,
  tuft: 0x5b8c42,
  hills: Object.freeze([0x7fa85a, 0x8cb363, 0x6f9c55, 0x93b56c]),
  lampPost: 0x2e3338,
  lampGlow: 0xffd28a,
  barrierRed: 0xd0503f,
  barrierWhite: 0xf5f1e8,
  fairyLight: 0xfff0b8,
  backdrop: Object.freeze([0xd8c7ae, 0xc9b596, 0xb9c3c9, 0xd3bfc9, 0xc4ccb4, 0xe0d2bc]),
  backdropRoof: 0x8e7f70,
  backdropWindow: 0xffd59a,
  backdropWindowDark: 0x5b6470,
});

/** A facade sign's board size and CSS colours. */
export interface SignStyle {
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
}

export type BuildingStyle = 'bank' | 'exchange' | 'post-office' | 'bridge' | 'vault' | 'generic';

/** Everything a street facade needs to look like its building. */
export interface BuildingTheme {
  readonly style: BuildingStyle;
  /** Height of the main mass; roofs, domes and trusses rise above it. */
  readonly height: number;
  readonly wall: number;
  readonly wallAlt: number;
  readonly trim: number;
  readonly accent: number;
  readonly roof: number;
  readonly door: number;
  readonly windowLit: number;
  readonly windowGlow: number;
  readonly windowDark: number;
  /** Sconces, emblems and other small emissive details. */
  readonly glow: number;
  /** Blinking roof lights. */
  readonly beacon: number;
  /** Share of windows that are lit, 0..1. */
  readonly litRatio: number;
  /** Door portal glow; the Vault's is a dim locked red. */
  readonly portal: number;
  readonly sign: SignStyle;
}

export const BUILDING_THEMES: Readonly<Record<BuildingId, BuildingTheme>> = Object.freeze({
  bank: Object.freeze({
    style: 'bank',
    height: 4.4,
    wall: 0xeadfc4,
    wallAlt: 0xd6c8a8,
    trim: 0xf6efdd,
    accent: 0xd4a53c,
    roof: 0xcdbf9f,
    door: 0x6e4a2c,
    windowLit: 0xffe2a8,
    windowGlow: 0xffc46b,
    windowDark: 0x3d4a5a,
    glow: 0xffcf6e,
    beacon: 0xffcf6e,
    litRatio: 0.75,
    portal: 0xffc766,
    sign: Object.freeze({
      width: 2.1,
      height: 0.8,
      background: '#f8f0dc',
      foreground: '#5b3a14',
      accent: '#c9982f',
    }),
  }),
  exchange: Object.freeze({
    style: 'exchange',
    height: 5.6,
    wall: 0x2e8288,
    wallAlt: 0x324049,
    trim: 0xdbe6e8,
    accent: 0x3fd1c1,
    roof: 0x5d6b72,
    door: 0x1c3d42,
    windowLit: 0xa3e9df,
    windowGlow: 0x3cb8aa,
    windowDark: 0x236f76,
    glow: 0x6ff5e2,
    beacon: 0xff4d3d,
    litRatio: 0.45,
    portal: 0x7cf2e0,
    sign: Object.freeze({
      width: 2.9,
      height: 0.78,
      background: '#0f2c31',
      foreground: '#86f7e8',
      accent: '#3fd1c1',
    }),
  }),
  'post-office': Object.freeze({
    style: 'post-office',
    height: 3.7,
    wall: 0xb4553e,
    wallAlt: 0x974432,
    trim: 0xf3ead6,
    accent: 0x2f5fa3,
    roof: 0x4b5b77,
    door: 0x2f5fa3,
    windowLit: 0xffe0a0,
    windowGlow: 0xffb95c,
    windowDark: 0x34414f,
    glow: 0xffd08a,
    beacon: 0xffd08a,
    litRatio: 0.6,
    portal: 0xffc070,
    sign: Object.freeze({
      width: 2.4,
      height: 0.66,
      background: '#2f5fa3',
      foreground: '#fff7e6',
      accent: '#e8553d',
    }),
  }),
  bridge: Object.freeze({
    style: 'bridge',
    height: 4.2,
    // Lighter than it "should" be: under a high warm sun, vertical faces get
    // well under half the key light and ACES crushes low albedo to navy.
    wall: 0x86a0b6,
    wallAlt: 0x7089a0,
    trim: 0x3f4d5b,
    accent: 0xe3a33a,
    roof: 0x6b7b8a,
    door: 0x52667a,
    windowLit: 0xffe6b0,
    windowGlow: 0xffc36b,
    windowDark: 0x2d3945,
    glow: 0xffc15a,
    beacon: 0xffa726,
    litRatio: 0.55,
    portal: 0xffc877,
    sign: Object.freeze({
      width: 2.7,
      height: 0.72,
      background: '#26313c',
      foreground: '#ffd27a',
      accent: '#e3a33a',
    }),
  }),
  vault: Object.freeze({
    style: 'vault',
    height: 3.9,
    // Charcoal that still shows its stonework in the warm light.
    wall: 0x61656e,
    wallAlt: 0x51555d,
    trim: 0x6d727b,
    accent: 0x8a7248,
    roof: 0x4a4d54,
    door: 0x34373d,
    windowLit: 0x5a4636,
    windowGlow: 0x6b2a20,
    windowDark: 0x1c1f24,
    glow: 0x9b2e22,
    beacon: 0x9b2e22,
    litRatio: 0,
    portal: 0x8a1f18,
    sign: Object.freeze({
      width: 2.4,
      height: 0.66,
      background: '#1d1e22',
      foreground: '#9b9da5',
      accent: '#5a2020',
    }),
  }),
});

/** For solid footprints the map does not attribute to a known building. */
export const GENERIC_BUILDING_THEME: BuildingTheme = Object.freeze({
  style: 'generic',
  height: 4,
  wall: 0xd9c9ae,
  wallAlt: 0xbfae93,
  trim: 0xf1e8d6,
  accent: 0x8a6f4d,
  roof: 0x8e7f70,
  door: 0x6b4f36,
  windowLit: 0xffe2a8,
  windowGlow: 0xffc46b,
  windowDark: 0x3d4a5a,
  glow: 0xffd08a,
  beacon: 0xffd08a,
  litRatio: 0.5,
  portal: 0xffc766,
  sign: Object.freeze({
    width: 2.4,
    height: 0.7,
    background: '#f4ecd8',
    foreground: '#3b2a14',
    accent: '#8a6f4d',
  }),
});

export function buildingTheme(building: BuildingId | null): BuildingTheme {
  return building ? BUILDING_THEMES[building] ?? GENERIC_BUILDING_THEME : GENERIC_BUILDING_THEME;
}

export type RoomDecorStyle = 'bank' | 'exchange' | 'post-office' | 'bridge' | 'plain';

/** Interior palette for one fixed room. */
export interface RoomTheme {
  readonly decor: RoomDecorStyle;
  readonly floorA: number;
  readonly floorB: number;
  readonly floorAccent: number;
  readonly wall: number;
  readonly wallLower: number;
  readonly wallTop: number;
  readonly trim: number;
  readonly skirting: number;
  readonly cut: number;
  readonly kioskBase: number;
  readonly kioskTop: number;
  readonly exitGlow: number;
  /** Station label colours (CSS). */
  readonly labelForeground: string;
  readonly labelBackground: string;
}

export const ROOM_THEMES: Readonly<Partial<Record<BuildingId, RoomTheme>>> = Object.freeze({
  bank: Object.freeze({
    decor: 'bank',
    floorA: 0xf1e9d8,
    floorB: 0xd8cdb8,
    floorAccent: 0xcfa043,
    wall: 0xeee3cb,
    wallLower: 0xd6c6a3,
    wallTop: 0x8f7a55,
    trim: 0xd4a53c,
    skirting: 0x8f7a55,
    cut: 0x5e4f38,
    kioskBase: 0xe6dcc6,
    kioskTop: 0x9e7a3c,
    exitGlow: 0xffc46b,
    labelForeground: '#fff6e0',
    labelBackground: 'rgba(60,42,18,0.84)',
  }),
  exchange: Object.freeze({
    decor: 'exchange',
    floorA: 0x1d4f55,
    floorB: 0x225a60,
    floorAccent: 0x3fd1c1,
    wall: 0x2c3f47,
    wallLower: 0x22323a,
    wallTop: 0x16222a,
    trim: 0x3fd1c1,
    skirting: 0x16222a,
    cut: 0x101a20,
    kioskBase: 0x2d3f48,
    kioskTop: 0x9fb4bb,
    exitGlow: 0x7cf2e0,
    labelForeground: '#dffcf7',
    labelBackground: 'rgba(10,32,36,0.86)',
  }),
  'post-office': Object.freeze({
    decor: 'post-office',
    floorA: 0xb65a45,
    floorB: 0xe9dcc3,
    floorAccent: 0x2f5fa3,
    wall: 0xf1e6cf,
    wallLower: 0x2f5fa3,
    wallTop: 0x7b3528,
    trim: 0xc8513c,
    skirting: 0x243f6e,
    cut: 0x5a2a20,
    kioskBase: 0x8a5a3a,
    kioskTop: 0xc49a6c,
    exitGlow: 0xffc070,
    labelForeground: '#fff7e6',
    labelBackground: 'rgba(28,48,92,0.86)',
  }),
  bridge: Object.freeze({
    decor: 'bridge',
    floorA: 0x66737f,
    floorB: 0x5b6773,
    floorAccent: 0xe3a33a,
    wall: 0x55687a,
    wallLower: 0x46586a,
    wallTop: 0x2d3945,
    trim: 0xe3a33a,
    skirting: 0x2d3945,
    cut: 0x1f2831,
    kioskBase: 0x3e4c5a,
    kioskTop: 0x8795a3,
    exitGlow: 0xffc877,
    labelForeground: '#ffe9bd',
    labelBackground: 'rgba(24,31,39,0.86)',
  }),
});

export const DEFAULT_ROOM_THEME: RoomTheme = Object.freeze({
  decor: 'plain',
  floorA: 0x6a6272,
  floorB: 0x5f5867,
  floorAccent: 0xd6b36a,
  wall: 0x6f6878,
  wallLower: 0x5c5664,
  wallTop: 0x39343b,
  trim: 0xd6b36a,
  skirting: 0x39343b,
  cut: 0x241f27,
  kioskBase: 0x5c5664,
  kioskTop: 0x9d93a8,
  exitGlow: 0xffd08a,
  labelForeground: '#fff6e0',
  labelBackground: 'rgba(28,22,32,0.84)',
});

export function roomTheme(building: BuildingId): RoomTheme {
  return ROOM_THEMES[building] ?? DEFAULT_ROOM_THEME;
}

/** Station render states. Colours echo the 2D room layer's station fills. */
export interface StationLook {
  readonly color: number;
  readonly emissive: number;
  readonly emissiveIntensity: number;
  readonly halo: number;
  readonly haloOpacity: number;
  readonly edgeOpacity: number;
}

export const STATION_LOOKS = Object.freeze({
  available: Object.freeze({
    color: 0xb07b41,
    emissive: 0xffa640,
    emissiveIntensity: 0.65,
    halo: 0xffcf73,
    haloOpacity: 0.2,
    edgeOpacity: 0.55,
  }),
  highlighted: Object.freeze({
    color: 0xe2b45d,
    emissive: 0xffd66b,
    emissiveIntensity: 1.9,
    halo: 0xffe08a,
    haloOpacity: 0.48,
    edgeOpacity: 0.95,
  }),
  locked: Object.freeze({
    color: 0x665f67,
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: 0x8f8896,
    haloOpacity: 0.06,
    edgeOpacity: 0.2,
  }),
  lockedHighlighted: Object.freeze({
    color: 0x736b74,
    emissive: 0x2a2530,
    emissiveIntensity: 0.4,
    halo: 0xa9a2b0,
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
} satisfies Record<string, StationLook>);

/** Avatar Studio accents; floor and wall tones come from `avatarStudioTileColour`. */
export const STUDIO_THEME = Object.freeze({
  wallLower: 0x2e2a31,
  wallTop: 0x241f27,
  trim: 0x8a7fa0,
  skirting: 0x241f27,
  cut: 0x19161b,
  pad: 0x6a6278,
  padRim: 0xc4b2ec,
  highlight: 0xffd66b,
  portal: 0xffe0a0,
  mirror: 0xdfe8ff,
  rug: 0x6c4f7a,
  rugBorder: 0xb89ad0,
  rack: 0x2a262d,
  garments: Object.freeze([0xe57373, 0x64b5f6, 0xffd54f, 0x81c784, 0xba68c8, 0xf4f0e6]),
  spot: 0xfff1cf,
  signBackground: '#241f27',
  signForeground: '#f1e6ff',
  signAccent: '#c4b2ec',
});

// ---------------------------------------------------------------------------
// Deterministic noise and colour helpers
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Integer hash in [0, 1). Decor placement must not change between loads. */
export function hash01(a: number, b = 0, c = 0): number {
  let h =
    (Math.imul(a | 0, 0x9e3779b1) ^
      Math.imul(b | 0, 0x85ebca77) ^
      Math.imul(c | 0, 0xc2b2ae3d) ^
      0x2545f491) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1], for meadow-scale colour patches. */
export function valueNoise(x: number, z: number, seed = 0): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

const scratchHsl = { h: 0, s: 0, l: 0 };

/** Offset lightness (and saturation) in sRGB, where the eye judges it. */
export function shade(color: ColorRepresentation, lightness: number, saturation = 0): Color {
  const out = new Color(color);
  out.getHSL(scratchHsl, SRGBColorSpace);
  out.setHSL(
    scratchHsl.h,
    clamp01(scratchHsl.s + saturation),
    clamp01(scratchHsl.l + lightness),
    SRGBColorSpace,
  );
  return out;
}

/** `seed` in [0, 1) maps to a lightness offset of +-amount. */
export function jitterColor(color: ColorRepresentation, seed: number, amount = 0.04): Color {
  return shade(color, (seed - 0.5) * 2 * amount);
}

export function mixColor(a: ColorRepresentation, b: ColorRepresentation, t: number): Color {
  return new Color(a).lerp(new Color(b), clamp01(t));
}

/**
 * Darken towards the ground: cheap ambient occlusion baked into vertex
 * colour, so walls sit on the floor instead of floating on it.
 */
export function aoPaint(color: ColorRepresentation, strength = 0.07, reach = 1.4): (x: number, y: number, z: number) => Color {
  return (_x, y) => shade(color, -strength * (1 - clamp01(y / reach)));
}

/** Contiguous [start, end) runs of indices in [from, to) where `test` holds. */
export function runsWhere(test: (index: number) => boolean, from: number, to: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = from; i <= to; i++) {
    const inside = i < to && test(i);
    if (inside && start < 0) start = i;
    if (!inside && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

export function pick<T>(values: readonly T[], seed: number): T {
  const index = Math.min(values.length - 1, Math.floor(clamp01(seed) * values.length));
  return values[index]!;
}

// ---------------------------------------------------------------------------
// Resource ownership
// ---------------------------------------------------------------------------

/**
 * Owns every GPU resource a builder creates, so `dispose()` is one idempotent
 * call and nothing is released twice.
 */
export class ResourceBag {
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly textures = new Set<Texture>();
  private readonly others = new Set<{ dispose(): void }>();
  private released = false;

  get disposed(): boolean {
    return this.released;
  }

  geometry<T extends BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  material<T extends Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  texture<T extends Texture>(texture: T): T {
    this.textures.add(texture);
    return texture;
  }

  /** Anything else with a `dispose()`, such as an InstancedMesh's buffers. */
  disposable<T extends { dispose(): void }>(value: T): T {
    this.others.add(value);
    return value;
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    for (const value of this.others) value.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.others.clear();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
  }
}

// ---------------------------------------------------------------------------
// Geometry bins: merge static geometry per material
// ---------------------------------------------------------------------------

export type PaintFn = (x: number, y: number, z: number) => Color;
export type Paint = ColorRepresentation | PaintFn;
export type PaintRGBA = (x: number, y: number, z: number) => readonly [number, number, number, number];

/**
 * Collects world-space pieces per material key and merges each key into one
 * geometry with baked vertex colours. One key becomes one draw call, which is
 * how a whole building with hundreds of parts costs four.
 */
export class GeometryBin {
  private readonly parts = new Map<string, BufferGeometry[]>();
  private readonly itemSizes = new Map<string, number>();

  add(key: string, geometry: BufferGeometry, paint: Paint): void {
    const prepared = prepareGeometry(geometry);
    const position = prepared.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    if (typeof paint === 'function') {
      for (let i = 0; i < position.count; i++) {
        const color = paint(position.getX(i), position.getY(i), position.getZ(i));
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    } else {
      const color = paint instanceof Color ? paint : new Color(paint);
      for (let i = 0; i < position.count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    }
    prepared.setAttribute('color', new BufferAttribute(colors, 3));
    this.push(key, prepared, 3);
  }

  /** Linear RGB plus alpha per vertex, for gradient light decals. */
  addRGBA(key: string, geometry: BufferGeometry, paint: PaintRGBA): void {
    const prepared = prepareGeometry(geometry);
    const position = prepared.getAttribute('position');
    const colors = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i++) {
      const [r, g, b, a] = paint(position.getX(i), position.getY(i), position.getZ(i));
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    prepared.setAttribute('color', new BufferAttribute(colors, 4));
    this.push(key, prepared, 4);
  }

  has(key: string): boolean {
    return (this.parts.get(key)?.length ?? 0) > 0;
  }

  /** Merge and remove one key. The caller owns (and must track) the result. */
  take(key: string): BufferGeometry | null {
    const parts = this.parts.get(key);
    this.parts.delete(key);
    this.itemSizes.delete(key);
    if (!parts || parts.length === 0) return null;
    if (parts.length === 1) {
      const only = parts[0]!;
      only.computeBoundingBox();
      only.computeBoundingSphere();
      return only;
    }
    const merged = mergeGeometries(parts, false) as BufferGeometry | null;
    for (const part of parts) part.dispose();
    if (!merged) throw new Error(`Could not merge the "${key}" geometry bin`);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  /** Release anything not yet taken (construction failed part-way). */
  dispose(): void {
    for (const parts of this.parts.values()) for (const part of parts) part.dispose();
    this.parts.clear();
    this.itemSizes.clear();
  }

  private push(key: string, geometry: BufferGeometry, itemSize: number): void {
    const known = this.itemSizes.get(key);
    if (known !== undefined && known !== itemSize) {
      geometry.dispose();
      throw new Error(`Geometry bin "${key}" mixes RGB and RGBA paint`);
    }
    this.itemSizes.set(key, itemSize);
    const list = this.parts.get(key);
    if (list) list.push(geometry);
    else this.parts.set(key, [geometry]);
  }
}

/** Non-indexed, position + normal only: the shape every bin part shares. */
function prepareGeometry(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  }
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  flat.morphAttributes = {};
  flat.clearGroups();
  return flat;
}

export interface MeshOptions {
  readonly name: string;
  readonly cast?: boolean;
  readonly receive?: boolean;
  readonly renderOrder?: number;
}

export function makeMesh(geometry: BufferGeometry, material: Material, options: MeshOptions): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = options.name;
  mesh.castShadow = options.cast ?? false;
  mesh.receiveShadow = options.receive ?? false;
  if (options.renderOrder !== undefined) mesh.renderOrder = options.renderOrder;
  return mesh;
}

/** Take one bin key into a tracked mesh under `parent`; null when the key is empty. */
export function flushBin(
  bin: GeometryBin,
  key: string,
  material: Material,
  res: ResourceBag,
  parent: Object3D,
  options: MeshOptions,
): Mesh | null {
  const geometry = bin.take(key);
  if (!geometry) return null;
  res.geometry(geometry);
  const mesh = makeMesh(geometry, material, options);
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Primitives (world space, ready for a bin)
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];
export type Point2 = readonly [number, number];

/** Axis-aligned box from two corners. */
export function boxGeometry(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): BufferGeometry {
  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  const minZ = Math.min(z0, z1);
  const w = Math.max(1e-4, Math.abs(x1 - x0));
  const h = Math.max(1e-4, Math.abs(y1 - y0));
  const d = Math.max(1e-4, Math.abs(z1 - z0));
  return new BoxGeometry(w, h, d).translate(minX + w / 2, minY + h / 2, minZ + d / 2);
}

export function cylinderGeometry(
  x: number,
  y0: number,
  z: number,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments = 8,
): BufferGeometry {
  return new CylinderGeometry(radiusTop, radiusBottom, height, segments).translate(
    x,
    y0 + height / 2,
    z,
  );
}

export function coneGeometry(
  x: number,
  y0: number,
  z: number,
  radius: number,
  height: number,
  segments = 8,
): BufferGeometry {
  return new ConeGeometry(radius, height, segments).translate(x, y0 + height / 2, z);
}

/** A (possibly squashed) sphere or upper hemisphere. */
export function sphereGeometry(
  x: number,
  y: number,
  z: number,
  radius: number,
  options: { widthSegments?: number; heightSegments?: number; hemisphere?: boolean; scaleY?: number } = {},
): BufferGeometry {
  const geometry = new SphereGeometry(
    radius,
    options.widthSegments ?? 8,
    options.heightSegments ?? 5,
    0,
    Math.PI * 2,
    0,
    options.hemisphere ? Math.PI / 2 : Math.PI,
  );
  if (options.scaleY !== undefined) geometry.scale(1, options.scaleY, 1);
  return geometry.translate(x, y, z);
}

/** Horizontal quad facing +Y. */
export function flatQuad(x0: number, z0: number, x1: number, z1: number, y: number): BufferGeometry {
  const ax = Math.min(x0, x1);
  const bx = Math.max(x0, x1);
  const az = Math.min(z0, z1);
  const bz = Math.max(z0, z1);
  const positions = [ax, y, az, ax, y, bz, bx, y, bz, ax, y, az, bx, y, bz, bx, y, az];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geometry;
}

/** Convex horizontal polygon (x, z) facing +Y. */
export function flatPolygon(points: readonly Point2[], y: number): BufferGeometry {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  // Up-facing triangles wind clockwise in (x, z): reverse a positive-area loop.
  const loop = area > 0 ? [...points].reverse() : [...points];
  const positions: number[] = [];
  const first = loop[0]!;
  for (let i = 1; i + 1 < loop.length; i++) {
    const b = loop[i]!;
    const c = loop[i + 1]!;
    positions.push(first[0], y, first[1], b[0], y, b[1], c[0], y, c[1]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Extrude a convex polygon in the XY plane between z0 and z1. */
export function prismZ(points: readonly Point2[], z0: number, z1: number): BufferGeometry {
  const back = Math.min(z0, z1);
  const front = Math.max(z0, z1);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const loop = area < 0 ? [...points].reverse() : [...points];
  const positions: number[] = [];
  const push = (p: Point2, z: number): void => {
    positions.push(p[0], p[1], z);
  };
  const first = loop[0]!;
  for (let i = 1; i + 1 < loop.length; i++) {
    const b = loop[i]!;
    const c = loop[i + 1]!;
    push(first, front);
    push(b, front);
    push(c, front);
    push(first, back);
    push(c, back);
    push(b, back);
  }
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    push(a, front);
    push(a, back);
    push(b, back);
    push(a, front);
    push(b, back);
    push(b, front);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Extrude a convex polygon given in (z, y) between x0 and x1 (gable roofs). */
export function prismX(points: readonly Point2[], x0: number, x1: number): BufferGeometry {
  // Local x becomes world z and local z becomes world -x after the rotation.
  return prismZ(points, -Math.max(x0, x1), -Math.min(x0, x1)).rotateY(-Math.PI / 2);
}

const scratchA = new Vector3();
const scratchB = new Vector3();
const scratchUp = new Vector3();
const scratchMatrix = new Matrix4();

/** A square-section beam from `a` to `b` (truss members, chains, arches). */
export function beamGeometry(a: Vec3, b: Vec3, thickness: number, depth = thickness): BufferGeometry {
  scratchA.set(a[0], a[1], a[2]);
  scratchB.set(b[0], b[1], b[2]);
  const length = Math.max(1e-4, scratchA.distanceTo(scratchB));
  const geometry = new BoxGeometry(thickness, depth, length);
  const vertical = Math.abs(b[1] - a[1]) > 0.999 * length;
  scratchUp.set(vertical ? 1 : 0, vertical ? 0 : 1, 0);
  scratchMatrix.lookAt(scratchA, scratchB, scratchUp);
  scratchMatrix.setPosition(
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  );
  return geometry.applyMatrix4(scratchMatrix);
}

/**
 * A wall surface: `plane` is where the face sits and `normal` which way it
 * looks. Face coordinates are (u along the wall, v up, w out of the wall),
 * so one decor routine can dress a north, east or west wall.
 */
export type FaceNormal = 'x+' | 'x-' | 'z+' | 'z-';

export interface Face {
  readonly normal: FaceNormal;
  readonly plane: number;
}

export function faceToWorld(face: Face, u: number, v: number, w: number): Vec3 {
  switch (face.normal) {
    case 'z+':
      return [u, v, face.plane + w];
    case 'z-':
      return [u, v, face.plane - w];
    case 'x+':
      return [face.plane + w, v, u];
    case 'x-':
      return [face.plane - w, v, u];
  }
}

export function faceBox(
  face: Face,
  u0: number,
  v0: number,
  w0: number,
  u1: number,
  v1: number,
  w1: number,
): BufferGeometry {
  const a = faceToWorld(face, u0, v0, w0);
  const b = faceToWorld(face, u1, v1, w1);
  return boxGeometry(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** A flat rectangle lying on a face, `w` out from the plane. */
export function faceQuad(
  face: Face,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  w: number,
): BufferGeometry {
  const geometry = new PlaneGeometry(Math.max(1e-4, Math.abs(u1 - u0)), Math.max(1e-4, Math.abs(v1 - v0)));
  orientToFace(geometry, face.normal, 'z');
  const [x, y, z] = faceToWorld(face, (u0 + u1) / 2, (v0 + v1) / 2, w);
  return geometry.translate(x, y, z);
}

/** A disc (short cylinder) standing out of a face. */
export function faceDisc(
  face: Face,
  u: number,
  v: number,
  w0: number,
  radius: number,
  depth: number,
  segments = 12,
): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, depth, segments);
  orientToFace(geometry, face.normal, 'y');
  const [x, y, z] = faceToWorld(face, u, v, w0 + depth / 2);
  return geometry.translate(x, y, z);
}

/** A torus (or arc of one) lying flat against a face. */
export function faceTorus(
  face: Face,
  u: number,
  v: number,
  w: number,
  radius: number,
  tube: number,
  options: { radialSegments?: number; tubularSegments?: number; arc?: number; rotation?: number } = {},
): BufferGeometry {
  const geometry = new TorusGeometry(
    radius,
    tube,
    options.radialSegments ?? 4,
    options.tubularSegments ?? 12,
    options.arc ?? Math.PI * 2,
  );
  if (options.rotation) geometry.rotateZ(options.rotation);
  orientToFace(geometry, face.normal, 'z');
  const [x, y, z] = faceToWorld(face, u, v, w);
  return geometry.translate(x, y, z);
}

/** A horizontal pipe running along a face's u axis. */
export function facePipe(
  face: Face,
  u0: number,
  u1: number,
  v: number,
  w: number,
  radius: number,
  segments = 6,
): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, Math.max(1e-4, Math.abs(u1 - u0)), segments);
  if (face.normal === 'z+' || face.normal === 'z-') geometry.rotateZ(Math.PI / 2);
  else geometry.rotateX(Math.PI / 2);
  const [x, y, z] = faceToWorld(face, (u0 + u1) / 2, v, w);
  return geometry.translate(x, y, z);
}

/** Point a geometry's local +Z (or +Y) axis along a face normal. */
function orientToFace(geometry: BufferGeometry, normal: FaceNormal, axis: 'y' | 'z'): void {
  if (axis === 'y') geometry.rotateX(Math.PI / 2);
  switch (normal) {
    case 'z+':
      return;
    case 'z-':
      geometry.rotateY(Math.PI);
      return;
    case 'x+':
      geometry.rotateY(Math.PI / 2);
      return;
    case 'x-':
      geometry.rotateY(-Math.PI / 2);
      return;
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface StandardSpec {
  readonly color?: ColorRepresentation;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly emissive?: ColorRepresentation;
  readonly emissiveIntensity?: number;
  readonly vertexColors?: boolean;
}

/** The house material: flat-shaded, matte, vertex coloured by default. */
export function standardMaterial(spec: StandardSpec = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: spec.color ?? 0xffffff,
    roughness: spec.roughness ?? 0.86,
    metalness: spec.metalness ?? 0,
    flatShading: true,
    vertexColors: spec.vertexColors ?? true,
    emissive: spec.emissive ?? 0x000000,
    emissiveIntensity: spec.emissiveIntensity ?? 1,
  });
}

export interface UnlitSpec {
  readonly color?: ColorRepresentation;
  readonly opacity?: number;
  readonly additive?: boolean;
  readonly transparent?: boolean;
  readonly vertexColors?: boolean;
  readonly doubleSide?: boolean;
}

/**
 * Self-lit surfaces: screens, fairy lights, halos, light spills. Not tone
 * mapped, so a glow reads as a glow under the ACES curve.
 */
export function unlitMaterial(spec: UnlitSpec = {}): MeshBasicMaterial {
  const opacity = spec.opacity ?? 1;
  const transparent = spec.transparent === true || spec.additive === true || opacity < 1;
  return new MeshBasicMaterial({
    color: spec.color ?? 0xffffff,
    vertexColors: spec.vertexColors ?? true,
    transparent,
    opacity,
    depthWrite: !transparent,
    blending: spec.additive ? AdditiveBlending : NormalBlending,
    toneMapped: false,
    side: spec.doubleSide ? DoubleSide : FrontSide,
  });
}

// ---------------------------------------------------------------------------
// Occluder fading
// ---------------------------------------------------------------------------

/**
 * Fade a fixed set of materials together. The originals are captured once, so
 * returning to 1 restores `transparent` and `depthWrite` exactly; while faded,
 * depth writes are off so the ghosted building cannot hide what is behind it.
 * Changing `transparent` changes the shader program, hence `needsUpdate`.
 */
export function createOpacityFader(materials: readonly Material[]): (opacity: number) => void {
  const entries = [...new Set(materials)].map((material) => ({
    material,
    opacity: material.opacity,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    visible: material.visible,
  }));
  let current = 1;
  return (requested: number): void => {
    const next = Number.isFinite(requested) ? clamp01(requested) : 1;
    if (next === current) return;
    const wasFaded = current < 1;
    const faded = next < 1;
    current = next;
    for (const entry of entries) {
      entry.material.opacity = entry.opacity * next;
      entry.material.visible = entry.visible && next > 0.001;
      if (faded !== wasFaded) {
        entry.material.transparent = faded ? true : entry.transparent;
        entry.material.depthWrite = faded ? false : entry.depthWrite;
        entry.material.needsUpdate = true;
      }
    }
  };
}

export function occluderFor(bounds: OccluderBounds, materials: readonly Material[]): Occluder {
  return Object.freeze({
    bounds: Object.freeze({ ...bounds }),
    setOpacity: createOpacityFader(materials),
  });
}

// ---------------------------------------------------------------------------
// LED ticker strip (a DataTexture: no canvas, so node-safe)
// ---------------------------------------------------------------------------

/**
 * Pixel glyphs, five rows tall, row-major from the top; a glyph's width is
 * its length / 5 (letters are 3 wide, the arrows 5 so they read as arrows).
 */
const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  D: '110101101101110',
  E: '111100110100111',
  F: '111100110100100',
  G: '011100101101011',
  H: '101101111101101',
  I: '111010010010111',
  J: '001001001101010',
  K: '101101110101101',
  L: '100100100100111',
  M: '101111111101101',
  N: '110101101101101',
  O: '010101101101010',
  P: '110101110100100',
  Q: '010101101110011',
  R: '110101110101101',
  S: '011100010001110',
  T: '111010010010010',
  U: '101101101101111',
  V: '101101101101010',
  W: '101101111111101',
  X: '101101010101101',
  Y: '101101010010010',
  Z: '111001010100111',
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '110001010100111',
  '3': '110001010001110',
  '4': '101101111001001',
  '5': '111100110001110',
  '6': '011100111101111',
  '7': '111001010010010',
  '8': '111101111101111',
  '9': '111101111001110',
  '.': '000000000000010',
  '-': '000000111000000',
  '+': '000010111010000',
  '/': '001001010100100',
  '▲': '0000000100011101111100000',
  '▼': '0000011111011100010000000',
  '?': '110001010000010',
});

export interface TickerSegment {
  readonly text: string;
  readonly color: number;
}

export interface TickerStrip {
  readonly texture: DataTexture;
  /** Pixel size; the strip repeats horizontally. */
  readonly width: number;
  readonly height: number;
}

export const EXCHANGE_TICKER: readonly TickerSegment[] = Object.freeze([
  { text: 'SWAP', color: 0x7cf2e0 },
  { text: ' STRK', color: 0xffc861 },
  { text: '▲', color: 0x5ee07a },
  { text: '  ETH', color: 0xffc861 },
  { text: '▼', color: 0xff6b5b },
  { text: '  USDC', color: 0xffc861 },
  { text: '▲', color: 0x5ee07a },
  { text: '  WBTC', color: 0xffc861 },
  { text: '▲', color: 0x5ee07a },
  { text: '   ', color: 0 },
]);

/** An LED text strip; scroll it with `texture.offset.x`. */
export function createTickerStrip(
  segments: readonly TickerSegment[],
  background = 0x0b1215,
): TickerStrip {
  const glyph = (char: string): string => GLYPHS[char.toUpperCase()] ?? GLYPHS['?']!;
  let width = 2;
  for (const segment of segments) {
    for (const char of segment.text) width += char === ' ' ? 2 : glyph(char).length / 5 + 1;
  }
  width = Math.max(8, width + 2);
  const height = 7;
  const data = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, hex: number): void => {
    const i = (y * width + x) * 4;
    data[i] = (hex >> 16) & 0xff;
    data[i + 1] = (hex >> 8) & 0xff;
    data[i + 2] = hex & 0xff;
    data[i + 3] = 0xff;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, background);
  let cursor = 2;
  for (const segment of segments) {
    for (const char of segment.text) {
      if (char === ' ') {
        cursor += 2;
        continue;
      }
      const bits = glyph(char);
      const glyphWidth = bits.length / 5;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < glyphWidth; col++) {
          // Texture row 0 is the bottom; glyph row 0 is the top.
          if (bits[row * glyphWidth + col] === '1') put(cursor + col, height - 2 - row, segment.color);
        }
      }
      cursor += glyphWidth + 1;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = RepeatWrapping;
  texture.needsUpdate = true;
  return { texture, width, height };
}
