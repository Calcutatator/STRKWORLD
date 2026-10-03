import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  type BufferAttribute,
  type Color,
  type ColorRepresentation,
} from 'three';
import {
  GeometryBin,
  PALETTE,
  ResourceBag,
  boxGeometry,
  clamp01,
  coneGeometry,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  mixColor,
  pick,
  sphereGeometry,
  standardMaterial,
  unlitMaterial,
  valueNoise,
  type Point2,
} from './palette.js';
import { SKY_HORIZON } from './sky.js';

/**
 * The sky island (D-132): the rock the whole World stands on.
 *
 * Everything the player can see — the protocol street, the plaza, the pitch,
 * the sandbox, the arena pit, the backdrop town and country to the north and
 * the river, station and city to the south — sits on the flat grassy top of
 * one floating rock, high in a warm cloud sea. Off the rim there is no ground
 * at all: jagged cliffs taper to a point underneath, the river pours off both
 * flanks as a waterfall, and past that there is only sky, cloud and a few
 * small islets.
 *
 * It is scenery and nothing else. Nothing here is walkable, nothing collides,
 * nothing stands on a map tile, and the playable map, the buildings and the
 * interiors are untouched: the rock is laid out around them.
 *
 * Built once, merged into five meshes (three on a phone), and animated by
 * writing into buffers that already exist, so a frame allocates nothing. Like
 * the south vista (D-124) it opts out of the engine's fog and bakes its own
 * haze: the fog's range moves with the player's elevation and tops out at 64
 * from the street, which would erase a rim 170 away from every camera.
 */

// ---------------------------------------------------------------------------
// The rim: one shape the rock, the backdrop and the vista all read
// ---------------------------------------------------------------------------

/**
 * Where the rock's axis stands, in street world coordinates.
 *
 * The playable map runs x 0 to 111, z 0 to 33 (D-134), so the centre sits under the
 * street's middle and a little south of it: far enough south to carry the
 * river, the station and the city across it (D-124), far enough north that the
 * backdrop's fields and hills still have ground under them.
 */
export const ROCK_CENTRE: Readonly<{ x: number; z: number }> = Object.freeze({ x: 55, z: 45 });

/**
 * The rim's mean radius. The playable map is 111 across, so the rock is about
 * 3.3 times the playable area wide — the lead's "about 3x", rounded up to
 * where the rooftop camera's fog still lands on ground in every direction
 * (street-builder.test.ts fires 1,536 rays at that).
 */
export const ROCK_RADIUS = 182;

/** How far the cliffs fall from the grass to the point underneath. */
export const ROCK_DEPTH = 96;

/** How much the rim wanders either side of the mean, as a share of it. */
const RIM_WAVE = 0.05;

/**
 * The rim's radius on a bearing. Three harmonics, no randomness: every caller
 * — the cliffs, the backdrop's clip, the vista's water — gets the same shape
 * from the same number, and the rock is built identically on every machine.
 */
export function rockRadiusAt(angle: number): number {
  const wave =
    0.52 * Math.sin(3 * angle + 0.7) + 0.31 * Math.sin(5 * angle + 2.1) + 0.17 * Math.sin(7 * angle + 4.3);
  return ROCK_RADIUS * (1 + RIM_WAVE * wave);
}

/** The rim's radius on the bearing of a point; `Infinity`-safe at the centre. */
export function rockRimAt(x: number, z: number): number {
  const dx = x - ROCK_CENTRE.x;
  const dz = z - ROCK_CENTRE.z;
  return dx === 0 && dz === 0 ? rockRadiusAt(0) : rockRadiusAt(Math.atan2(dz, dx));
}

/**
 * Whether a point is on the rock's top, `margin` in from the rim. Everything
 * the world draws has to answer true here, and nothing may be laid outside it.
 */
export function onRockTop(x: number, z: number, margin = 0): boolean {
  const dx = x - ROCK_CENTRE.x;
  const dz = z - ROCK_CENTRE.z;
  return Math.hypot(dx, dz) <= rockRimAt(x, z) - margin;
}

/**
 * The rim's x either side of the axis at a given z, `margin` in; null where
 * the rock does not reach that z at all.
 *
 * The rim is not a circle, so this is solved rather than evaluated: start from
 * the mean circle and re-read the radius on the bearing found, which settles
 * in a handful of passes because the wave is gentle.
 */
export function rockSpanAtZ(z: number, margin = 0): readonly [number, number] | null {
  const dz = z - ROCK_CENTRE.z;
  const side = (sign: number): number | null => {
    let dx = sign * Math.sqrt(Math.max(0, ROCK_RADIUS ** 2 - dz ** 2));
    for (let i = 0; i < 8; i++) {
      const r = rockRadiusAt(Math.atan2(dz, dx)) - margin;
      const next = r ** 2 - dz ** 2;
      if (next <= 0) return null;
      dx = sign * Math.sqrt(next);
    }
    return ROCK_CENTRE.x + dx;
  };
  const west = side(-1);
  const east = side(1);
  return west === null || east === null || east - west < 1e-3 ? null : [west, east];
}

// ---------------------------------------------------------------------------
// The waterfall's band
// ---------------------------------------------------------------------------

/**
 * Where the river meets the rim and pours off, and the height it leaves at.
 *
 * These mirror `SOUTH_SHORE_Z`, `FAR_QUAY_Z` and the water's surface in
 * south-vista.ts, deliberately as values of their own rather than an import:
 * this module is the one the vista reads its rim from, and a cycle between the
 * two would be worse than a pinned pair. sky-island.test.ts pins them equal.
 */
export const FALL_Z0 = 58;
export const FALL_Z1 = 110;
export const FALL_TOP_Y = -1.15;

/** How far the sheet falls before the mist takes it. */
const FALL_DROP = 52;

// ---------------------------------------------------------------------------
// Haze: the rock carries its own, because the engine's fog cannot reach it
// ---------------------------------------------------------------------------

/** Where the cameras are: the playable map's middle, near enough for all three. */
const VIEW_ANCHOR = Object.freeze({ x: 55, z: 20 });

const HAZE_FROM = 70;
const HAZE_TO = 215;
/**
 * Never more than half. The rim and the falls are the whole point of the
 * change, so they stay readable from the street; it is the engine's fog, not
 * this, that dissolves the backdrop town in front of them.
 */
const HAZE_MAX = 0.42;
const HAZE_COLOUR = mixColor(SKY_HORIZON, 0xf0dcc2, 0.35);

function islandHaze(x: number, z: number): number {
  const d = Math.hypot(x - VIEW_ANCHOR.x, z - VIEW_ANCHOR.z);
  return clamp01((d - HAZE_FROM) / (HAZE_TO - HAZE_FROM)) ** 0.9 * HAZE_MAX;
}

/** Paint for a bin: every vertex hazed by how far out it stands. */
const air =
  (colour: ColorRepresentation, strength = 1) =>
    (x: number, _y: number, z: number): Color =>
      mixColor(colour, HAZE_COLOUR, islandHaze(x, z) * strength);

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const ROCK = Object.freeze({
  /** The cliff, from the sunlit band under the lip down into its own shadow. */
  faceLight: 0x9c907c,
  face: 0x867a67,
  faceDark: 0x6c6252,
  faceDeep: 0x544b3f,
  tip: 0x463f36,
  /** Greenery clinging to the upper cliff, as in the reference. */
  moss: 0x5d8a46,
  mossDark: 0x4a7139,
  /** The rim belt: boulders, drystone and shrubs between the fields and the drop. */
  boulder: 0x9d9486,
  boulderDark: 0x857c6e,
  shrub: 0x497740,
  shrubLight: 0x5c8c48,
  /**
   * The cloud sea, at golden hour: lit tops, warm shaded flanks — and, since
   * D-133 (2026-10-03), some actual colour in them. They were three shades of
   * white, which under the engine's tone mapping is what a grey sky looks
   * like; a low sun puts gold on the tops and rose in the shadows, and from
   * the swing the far banks are half the frame.
   */
  cloud: 0xfff3dc,
  cloudWarm: 0xffd9a8,
  cloudShade: 0xeec8b8,
  /** What the undersides of the far banks pick up from the sun on the horizon. */
  cloudGlow: 0xf7a978,
  /** The falling water, from the lip's river colour down into spray. */
  waterLip: 0x7f9aa6,
  waterFall: 0xaecad3,
  foam: 0xf4fbfb,
  mist: 0xfff8ee,
});

// ---------------------------------------------------------------------------
// The module's shape
// ---------------------------------------------------------------------------

export interface SkyIslandOptions {
  /** `'low'` drops the islets and the mist and coarsens the rest, for phones. */
  readonly quality?: 'low' | 'high';
  /** Sampled once at build: the waterfall holds still. */
  readonly reducedMotion?: boolean;
}

export interface SkyIsland {
  readonly group: Group;
  /** Total elapsed milliseconds, as the street's animators are given. */
  update(elapsedMs: number): void;
  dispose(): void;
}

/**
 * Build the island. It stands in street world coordinates, so a caller adds
 * `group` straight to the street scene with no transform of its own.
 */
export function createSkyIsland(options?: SkyIslandOptions): SkyIsland {
  const low = options?.quality === 'low';
  const still = options?.reducedMotion === true;
  const res = new ResourceBag();
  const group = new Group();
  group.name = 'sky-island';

  let falling: Falling | null = null;

  const bin = new GeometryBin();
  try {
    layRimBelt(bin, low);
    layCliffs(bin, low);
    layClouds(bin, low);
    if (!low) layIslets(bin);
    layFalls(bin, low);
    if (!low) layMist(bin);

    // Three materials, five meshes. All of them opt out of the engine's fog:
    // the island carries its own haze, baked above.
    const stone = res.material(standardMaterial({ roughness: 0.95 }));
    // The sheet is seen from the district's side and from outside the rock
    // alike, so it is drawn both ways; it is also lit from within, as falling
    // water is, or it reads as a grey wall on the cliff's shaded flank.
    const water = res.material(standardMaterial({ roughness: 0.3, emissive: ROCK.foam, emissiveIntensity: 0.12 }));
    water.side = DoubleSide;
    // The spray's own softness is baked per vertex, not set on the material:
    // the street's occluder fade walks every material it can see and a shared
    // one at half opacity would read as a building ghosted open.
    // The cloud sea carries its own shading (see `cloudFace`), so it is drawn
    // unlit; the scene's sun and hemisphere are for things made of matter.
    const vapour = res.material(unlitMaterial());
    const spray = res.material(unlitMaterial({ transparent: true, doubleSide: true }));
    for (const material of [stone, water, vapour, spray]) material.fog = false;

    flushBin(bin, 'rock', stone, res, group, { name: 'sky-island:rock' });
    flushBin(bin, 'cloud', vapour, res, group, { name: 'sky-island:clouds' });
    if (!low) flushBin(bin, 'islet', stone, res, group, { name: 'sky-island:islets' });
    const sheet = flushBin(bin, 'fall', water, res, group, { name: 'sky-island:falls' });
    if (!low) flushBin(bin, 'mist', spray, res, group, { name: 'sky-island:mist', renderOrder: 2 });
    if (sheet) falling = cascade(sheet.geometry, still);
  } catch (error) {
    res.dispose();
    group.clear();
    throw error;
  } finally {
    bin.dispose();
  }

  let disposed = false;
  return {
    group,
    update(elapsedMs) {
      if (disposed || still) return;
      falling?.(Number.isFinite(elapsedMs) ? elapsedMs : 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
      res.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// The top: the grass belt between the city's last field and the rim
// ---------------------------------------------------------------------------

/**
 * How far out the rest of the world lays its own ground: the backdrop's
 * hinterland box (backdrop.ts) to the north, west and east, and the vista's
 * shore to the south. Inside this the island lays nothing, so the belt is only
 * the ring the fields never reach.
 */
const LAID_X0 = -120;
const LAID_X1 = 231;
const LAID_Z0 = -120;

/** The belt's grass sits a touch under the district's, so nothing z-fights. */
const TOP_Y = -0.08;

/** The grass belt's colour: the backdrop's hills, drifting, greyer out at the rim. */
function beltColour(x: number, z: number): Color {
  const tone = valueNoise(x * 0.035 + 3.1, z * 0.035 + 7.7, 601);
  const base = mixColor(pick(PALETTE.hills, tone), PALETTE.grassCool, tone * 0.5);
  const out = clamp01((Math.hypot(x - ROCK_CENTRE.x, z - ROCK_CENTRE.z) - ROCK_RADIUS * 0.82) / (ROCK_RADIUS * 0.2));
  return jitterColor(mixColor(base, PALETTE.apron, out * 0.3), hash01(Math.round(x), Math.round(z), 602), 0.03);
}

function layRimBelt(bin: GeometryBin, low: boolean): void {
  const cell = low ? 9 : 6;
  const x0 = Math.floor((ROCK_CENTRE.x - ROCK_RADIUS * 1.06) / cell) * cell;
  const x1 = ROCK_CENTRE.x + ROCK_RADIUS * 1.06;
  const z0 = Math.floor((ROCK_CENTRE.z - ROCK_RADIUS * 1.06) / cell) * cell;
  // Everything from the shore south is the vista's ground, laid out to the rim
  // by south-vista.ts; the belt is the north three-quarters of the ring.
  for (let z = z0; z < FALL_Z0; z += cell) {
    const za = z;
    const zb = Math.min(FALL_Z0, z + cell);
    for (let x = x0; x < x1; x += cell) {
      const xb = x + cell;
      // Only the ring: inside the box the fields, the town and the street have
      // their own ground, and a second grass under it is grass nobody pays for.
      if (x >= LAID_X0 && xb <= LAID_X1 && za >= LAID_Z0) continue;
      if (!onRockTop((x + xb) / 2, (za + zb) / 2, 1)) continue;
      bin.add('rock', flatQuad(x, za, xb, zb, TOP_Y), (vx, _vy, vz) => mixColor(beltColour(vx, vz), HAZE_COLOUR, islandHaze(vx, vz)));
    }
  }
  rimEdge(bin, low);
}

/**
 * The rim itself: a low grassy kerb all the way round so the top never ends in
 * a bare line, with boulders and shrubs along it. The reference islands all
 * carry this fringe, and from the street it is the only part of the rock the
 * eye resolves.
 */
function rimEdge(bin: GeometryBin, low: boolean): void {
  const segments = low ? 72 : 144;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const ra = rockRadiusAt(a);
    const rb = rockRadiusAt(b);
    const inner: Point2[] = [
      [ROCK_CENTRE.x + Math.cos(a) * (ra - 2.4), ROCK_CENTRE.z + Math.sin(a) * (ra - 2.4)],
      [ROCK_CENTRE.x + Math.cos(b) * (rb - 2.4), ROCK_CENTRE.z + Math.sin(b) * (rb - 2.4)],
      [ROCK_CENTRE.x + Math.cos(b) * rb, ROCK_CENTRE.z + Math.sin(b) * rb],
      [ROCK_CENTRE.x + Math.cos(a) * ra, ROCK_CENTRE.z + Math.sin(a) * ra],
    ];
    const mz = (inner[0]![1] + inner[2]![1]) / 2;
    // The river owns its own lip; no grass kerb across a waterfall.
    if (mz > FALL_Z0 - 2 && mz < FALL_Z1 + 2) continue;
    const seed = i * 13 + 1;
    const grass = jitterColor(mixColor(PALETTE.grassCool, PALETTE.hills[2]!, hash01(seed, 0, 611)), hash01(seed, 1, 611), 0.04);
    bin.add('rock', flatPolygon(inner, TOP_Y + 0.12), (x, _y, z) => mixColor(grass, HAZE_COLOUR, islandHaze(x, z)));
    if (low) continue;
    const roll = hash01(seed, 2, 611);
    const mx = (inner[0]![0] + inner[2]![0]) / 2;
    if (roll < 0.34) {
      const r = 0.8 + hash01(seed, 3, 611) * 1.5;
      bin.add(
        'rock',
        sphereGeometry(mx, TOP_Y - r * 0.25, mz, r, { widthSegments: 6, heightSegments: 3, scaleY: 0.8 }),
        air(jitterColor(hash01(seed, 4, 611) < 0.5 ? ROCK.boulder : ROCK.boulderDark, hash01(seed, 5, 611), 0.04)),
      );
    } else if (roll < 0.6) {
      const r = 1 + hash01(seed, 6, 611) * 1.3;
      bin.add(
        'rock',
        sphereGeometry(mx, TOP_Y + 0.1, mz, r, { widthSegments: 6, heightSegments: 3, hemisphere: true, scaleY: 1.1 }),
        air(jitterColor(hash01(seed, 7, 611) < 0.5 ? ROCK.shrub : ROCK.shrubLight, hash01(seed, 8, 611), 0.05)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The cliffs: a ragged skirt narrowing to a point underneath
// ---------------------------------------------------------------------------

/**
 * The profile the skirt follows, as (share of the drop, share of the radius).
 * Wide and near-vertical just under the lip, then in hard — the flat-topped,
 * sharply pointed silhouette of floatrock-1.
 */
const SKIRT: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0, 1],
  [0.07, 0.985],
  [0.19, 0.9],
  [0.34, 0.74],
  [0.52, 0.54],
  [0.72, 0.32],
  [0.88, 0.15],
  [1, 0],
]);

/** A spoke's own wobble at a level, so the skirt is faceted rather than turned. */
function spokeJitter(spoke: number, level: number): number {
  return 0.92 + hash01(spoke, level, 621) * 0.16;
}

/**
 * The cliff's colour at a share `t` of the drop.
 *
 * The lower a facet is the more it faces straight down, where the only light
 * in the scene is the hemisphere's ground term — which would leave the whole
 * underside near black. A real island over a cloud sea is lit from below by it,
 * so the paint carries that bounce itself: a warm lift that grows with depth,
 * baked into the vertex colour rather than added as a light nobody else needs.
 */
function cliffColour(t: number, spoke: number, level: number): Color {
  const band =
    t < 0.06
      ? ROCK.faceLight
      : t < 0.22
        ? ROCK.face
        : t < 0.5
          ? ROCK.faceDark
          : t < 0.8
            ? ROCK.faceDeep
            : ROCK.tip;
  const bounce = jitterColor(mixColor(band, ROCK.cloudWarm, t * 0.22), hash01(spoke, level, 622), 0.05);
  return bounce.multiplyScalar(1 + t * 5.5);
}

function layCliffs(bin: GeometryBin, low: boolean): void {
  const spokes = low ? 48 : 96;
  const apex = { x: ROCK_CENTRE.x, y: -ROCK_DEPTH, z: ROCK_CENTRE.z };
  const at = (spoke: number, level: number): readonly [number, number, number] => {
    const angle = (spoke / spokes) * Math.PI * 2;
    const [drop, share] = SKIRT[level]!;
    if (share === 0) return [apex.x, apex.y, apex.z];
    const r = rockRadiusAt(angle) * share * (level === 0 ? 1 : spokeJitter(spoke, level));
    return [ROCK_CENTRE.x + Math.cos(angle) * r, TOP_Y - drop * ROCK_DEPTH, ROCK_CENTRE.z + Math.sin(angle) * r];
  };
  const face = (a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number], paint: Color): void => {
    bin.add('rock', triangle(a, b, c), paint);
  };
  for (let s = 0; s < spokes; s++) {
    const next = (s + 1) % spokes;
    for (let l = 0; l + 1 < SKIRT.length; l++) {
      const t = SKIRT[l]![0];
      const colour = cliffColour(t, s, l);
      const hazed = mixColor(colour, HAZE_COLOUR, islandHaze(at(s, l)[0], at(s, l)[2]));
      const p00 = at(s, l);
      const p10 = at(next, l);
      const p01 = at(s, l + 1);
      const p11 = at(next, l + 1);
      // Wound so the normal points away from the axis: these are the outside
      // of the rock, and nothing is ever behind them.
      face(p00, p11, p01, hazed);
      if (SKIRT[l + 1]![1] > 0) face(p00, p10, p11, hazed);
    }
    if (low) continue;
    // Greenery spilling over the lip, and a stalactite here and there.
    const seed = s * 7 + 3;
    if (hash01(seed, 0, 631) < 0.42) {
      const l = 1;
      const p = at(s, l);
      const q = at((s + 1) % spokes, l);
      bin.add(
        'rock',
        triangle(at(s, 0), at((s + 1) % spokes, 0), [(p[0] + q[0]) / 2, p[1] - 2 - hash01(seed, 1, 631) * 5, (p[2] + q[2]) / 2]),
        air(jitterColor(hash01(seed, 2, 631) < 0.5 ? ROCK.moss : ROCK.mossDark, hash01(seed, 3, 631), 0.05)),
      );
    }
    if (hash01(seed, 4, 631) < 0.3) {
      const l = 2 + Math.floor(hash01(seed, 5, 631) * 3);
      const p = at(s, l);
      bin.add(
        'rock',
        coneGeometry(p[0], p[1] - (5 + hash01(seed, 6, 631) * 13), p[2], 0.8 + hash01(seed, 7, 631) * 1.4, 5 + hash01(seed, 6, 631) * 13, 4),
        air(jitterColor(ROCK.faceDeep, hash01(seed, 8, 631), 0.05)),
      );
    }
  }
}

/**
 * One triangle in world space, positions only: the bin computes its normal and
 * bakes the paint. The skirt and the falling sheet are triangle soup, not
 * boxes, so this is the primitive they are made of.
 */
function triangle(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]], 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------
// Off the rock: a sea of cloud, and a few islets in it
// ---------------------------------------------------------------------------

/**
 * How far the cloud sea runs. Everything here has to stay inside the engine's
 * far plane from a camera anywhere on the street, or a bank would clip; the
 * plane was pushed out to 360 for exactly this (world-engine.ts). Past this the
 * sky dome's own cloud colour carries on (sky.ts).
 */
const CLOUD_REACH = 300;

/**
 * A cloud's paint.
 *
 * The clouds are the one part of the island that is not lit by the scene. A
 * white box under this sun keeps its top and loses its flanks to the
 * hemisphere's brown ground term, which reads as wet sand rather than cloud;
 * so they carry their own shading instead — bright on top, warm underneath,
 * graded down each lump, which is how the reference paints a cloud sea at
 * golden hour. `up` runs -0.5 at a lump's underside to +0.5 at its top.
 */
function cloudFace(x: number, z: number, up: number, strength: number): Color {
  const lit = clamp01(up + 0.5) ** 0.8;
  const base = mixColor(ROCK.cloudShade, ROCK.cloud, lit);
  const warm = clamp01((Math.hypot(x - ROCK_CENTRE.x, z - ROCK_CENTRE.z) - 120) / 180);
  // D-133 (2026-10-03): the far banks catch the low sun on their tops and
  // hold its colour underneath, so the horizon is a sunset rather than weather.
  const golden = mixColor(mixColor(base, ROCK.cloudWarm, warm * 0.6), ROCK.cloudGlow, warm * (1 - lit) * 0.55);
  return mixColor(golden, HAZE_COLOUR, Math.min(0.7, islandHaze(x, z) * strength));
}

/**
 * The cloud sea: three bands, none of them a plane.
 *
 * A ring of tall banks out past the rim and above it, which is what tells
 * every camera at ground level that the World is high up; a skirt of puffs
 * just under the rim, read against the cliff; and a thin floor far below, so a
 * look over the edge finds cloud rather than nothing.
 */
function layClouds(bin: GeometryBin, low: boolean): void {
  const bank = (count: number, radius: (t: number, seed: number) => number, height: (t: number, seed: number) => number, size: (seed: number) => number, strength: number): void => {
    for (let i = 0; i < count; i++) {
      const seed = i * 11 + 5;
      const t = hash01(seed, 9, 640);
      const angle = (i / count) * Math.PI * 2 + hash01(seed, 0, 641) * 0.4;
      const r = radius(t, seed);
      puff(bin, 'cloud', ROCK_CENTRE.x + Math.cos(angle) * r, height(t, seed), ROCK_CENTRE.z + Math.sin(angle) * r, size(seed), seed, low, strength);
    }
  };
  // Beyond the rim, rising past the top: the horizon from the street and from
  // the Exchange roof. Heavily hazed, so where the far plane cuts one off it
  // is already the colour of the sky behind it.
  bank(low ? 16 : 44, (_t, seed) => CLOUD_REACH * (0.62 + hash01(seed, 1, 642) * 0.42), (t, seed) => -26 + t * 72 + hash01(seed, 7, 642) * 16, (seed) => 12 + hash01(seed, 3, 642) * 16, 1.3);
  // Under the rim, against the cliff.
  bank(low ? 14 : 40, (t) => ROCK_RADIUS * (0.45 + t * 0.55), (t, seed) => -26 - t * 52 - hash01(seed, 2, 643) * 20, (seed) => 7 + hash01(seed, 3, 643) * 9, 1);
  // D-133 (2026-10-03): a high band, far out and well above the rim. From
  // the swing it sits a sixth of the way up the sky, which is the half of
  // the frame the river and the city do not fill — and the half that read as
  // empty weather before there was anything in it.
  bank(low ? 5 : 11, (_t, seed) => CLOUD_REACH * (0.78 + hash01(seed, 4, 645) * 0.3), (t, seed) => 86 + t * 56 + hash01(seed, 8, 645) * 22, (seed) => 20 + hash01(seed, 3, 645) * 18, 1.1);
  // The floor, far below and thin.
  bank(low ? 10 : 30, (t, seed) => ROCK_RADIUS * (0.12 + t * 1.5) * (0.55 + hash01(seed, 5, 644) * 0.6), (_t, seed) => -112 - hash01(seed, 6, 644) * 34, (seed) => 15 + hash01(seed, 3, 644) * 18, 1.2);
}

/**
 * A voxel cloud, in the title screen's idiom (title-backdrop.ts): a long low
 * heap of flat-shaded boxes, half of them sitting on one base line and the
 * rest riding on top. That stacking is what makes a pile of boxes read as a
 * cloud rather than as crates.
 */
function puff(
  bin: GeometryBin,
  key: string,
  x: number,
  y: number,
  z: number,
  size: number,
  seed: number,
  low: boolean,
  strength: number,
): void {
  const lumps = low ? 5 : 9;
  const u = size * 0.3;
  for (let n = 0; n < lumps; n++) {
    const w = (1.4 + hash01(seed, n * 4, 651) * 1.6) * u;
    const h = (0.9 + hash01(seed, n * 4 + 1, 651) * 0.9) * u;
    const cx = x + (hash01(seed, n * 4 + 2, 652) - 0.5) * 4.5 * u;
    const cz = z + (hash01(seed, n * 4 + 3, 653) - 0.5) * 1.5 * u;
    const cy = y + h / 2 + (n < lumps / 2 ? 0 : hash01(seed, n, 654) * 0.8 * u);
    bin.add(
      key,
      boxGeometry(cx - w / 2, cy - h / 2, cz - w * 0.4, cx + w / 2, cy + h / 2, cz + w * 0.4),
      (vx, vy, vz) => cloudFace(vx, vz, (vy - cy) / h, strength),
    );
  }
}

/** Small rocks adrift beyond the rim, as in floatrock-3: the sky has neighbours. */
function layIslets(bin: GeometryBin): void {
  // Bearing in turns, distance from the axis, height. None of them stands off
  // the river's flanks, where they would hang in front of a waterfall: the
  // falls leave the rim between about 0.00 and 0.06 turns, and 0.44 and 0.49.
  const spots: ReadonlyArray<readonly [number, number, number]> = [
    [0.16, 243, -28],
    [0.29, 221, -56],
    [0.37, 258, -12],
    [0.62, 232, -44],
    [0.78, 249, -20],
    [0.92, 215, -62],
  ];
  spots.forEach(([turn, distance, y], i) => {
    const angle = turn * Math.PI * 2;
    const x = ROCK_CENTRE.x + Math.cos(angle) * distance;
    const z = ROCK_CENTRE.z + Math.sin(angle) * distance;
    const r = 7 + hash01(i, 0, 661) * 9;
    const depth = r * (1.2 + hash01(i, 1, 661) * 1.1);
    const top: Point2[] = [];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const rr = r * (0.82 + hash01(i, k + 2, 662) * 0.3);
      top.push([x + Math.cos(a) * rr, z + Math.sin(a) * rr]);
    }
    bin.add('islet', flatPolygon(top, y), air(jitterColor(PALETTE.hills[1]!, hash01(i, 3, 663), 0.04), 0.8));
    for (let k = 0; k < 7; k++) {
      const a = top[k]!;
      const b = top[(k + 1) % 7]!;
      bin.add(
        'islet',
        triangle(
          [a[0], y, a[1]],
          [b[0], y, b[1]],
          [x, y - depth, z],
        ),
        air(jitterColor(k % 2 === 0 ? ROCK.face : ROCK.faceDark, hash01(i, k, 664), 0.05), 0.8),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The waterfall: the river, off both flanks
// ---------------------------------------------------------------------------

/** One side of the fall, and the rows the sheet is cut into along the rim. */
function fallRows(low: boolean): Array<{ x: number; z0: number; z1: number; side: number }> {
  const step = low ? 10 : 5;
  const rows: Array<{ x: number; z0: number; z1: number; side: number }> = [];
  for (let z = FALL_Z0; z < FALL_Z1; z += step) {
    const z1 = Math.min(FALL_Z1, z + step);
    const span = rockSpanAtZ((z + z1) / 2);
    if (!span) continue;
    rows.push({ x: span[0], z0: z, z1, side: -1 });
    rows.push({ x: span[1], z0: z, z1, side: 1 });
  }
  return rows;
}

/**
 * How wide a row of the sheet is at a share `t` of its drop. Just over one at
 * the lip, so the rows meet and the water goes over as one; narrowing hard
 * below, so the curtain frays into separate ribbons and ends in spray rather
 * than in a straight line across the sky.
 */
const fallSpread = (t: number): number => 1.06 - 0.86 * t ** 1.6;

/**
 * The sheet's colour at a share `t` of the drop: the river's own green-grey at
 * the lip, breaking to foam as it falls. Lifted well past one, because it
 * hangs on the cliff's shaded flank where nothing else is lit either.
 */
function fallColour(t: number): Color {
  const base = t < 0.18 ? mixColor(ROCK.waterLip, ROCK.waterFall, t / 0.18) : mixColor(ROCK.waterFall, ROCK.foam, clamp01((t - 0.18) / 0.6));
  return base.multiplyScalar(1.6 + t * 2.4);
}

/** How far one ribbon falls; each its own, so the curtain has no flat bottom. */
const fallDrop = (seed: number): number => FALL_DROP * (0.72 + hash01(seed, 2, 672) * 0.4);

function layFalls(bin: GeometryBin, low: boolean): void {
  const steps = low ? 5 : 9;
  for (const row of fallRows(low)) {
    const seed = Math.round(row.z0 * 3 + row.side * 7);
    // The lip: the water tips over the edge rather than ending in a line.
    bin.add(
      'fall',
      triangle(
        [row.x, FALL_TOP_Y, row.z0],
        [row.x, FALL_TOP_Y, row.z1],
        [row.x + row.side * 1.6, FALL_TOP_Y - 1.8, row.z1],
      ),
      air(ROCK.waterLip, 0.6),
    );
    bin.add(
      'fall',
      triangle(
        [row.x, FALL_TOP_Y, row.z0],
        [row.x + row.side * 1.6, FALL_TOP_Y - 1.8, row.z1],
        [row.x + row.side * 1.6, FALL_TOP_Y - 1.8, row.z0],
      ),
      air(ROCK.waterLip, 0.6),
    );
    // Each ribbon falls its own distance, so the curtain has no flat bottom.
    const drop = fallDrop(seed);
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const y0 = FALL_TOP_Y - 1.8 - t0 * drop;
      const y1 = FALL_TOP_Y - 1.8 - t1 * drop;
      const w0 = fallSpread(t0);
      const w1 = fallSpread(t1);
      const mid = (row.z0 + row.z1) / 2;
      const a0 = mid - (mid - row.z0) * w0;
      const b0 = mid + (row.z1 - mid) * w0;
      const a1 = mid - (mid - row.z0) * w1;
      const b1 = mid + (row.z1 - mid) * w1;
      const x0 = row.x + row.side * (1.6 + t0 * 2.6 + hash01(seed, s, 671) * 0.8);
      const x1 = row.x + row.side * (1.6 + t1 * 2.6 + hash01(seed, s + 1, 671) * 0.8);
      const paint = air(fallColour((t0 + t1) / 2), 0.55);
      bin.add('fall', triangle([x0, y0, a0], [x0, y0, b0], [x1, y1, b1]), paint);
      bin.add('fall', triangle([x0, y0, a0], [x1, y1, b1], [x1, y1, a1]), paint);
    }
  }
}

/**
 * The spray: pale puffs at the lip and where the sheet frays out below, their
 * softness carried per vertex so the one shared material stays fully opaque.
 */
function layMist(bin: GeometryBin): void {
  for (const row of fallRows(false)) {
    const seed = Math.round(row.z0 * 5 + row.side * 11);
    const mid = (row.z0 + row.z1) / 2;
    if (hash01(seed, 0, 681) < 0.45) {
      mistPuff(bin, row.x + row.side * 3, FALL_TOP_Y - 4, mid, 4 + hash01(seed, 1, 681) * 3, seed, 0.38);
    }
    const drop = fallDrop(Math.round(row.z0 * 3 + row.side * 7));
    mistPuff(bin, row.x + row.side * 5, FALL_TOP_Y - drop + 3, mid, 6 + hash01(seed, 3, 681) * 5, seed + 2, 0.4);
    mistPuff(bin, row.x + row.side * 6.5, FALL_TOP_Y - drop - 5, mid, 9 + hash01(seed, 2, 681) * 7, seed + 1, 0.5);
  }
}

/** One cluster of spray: thinner the further from its centre, and thinner still out in the haze. */
function mistPuff(bin: GeometryBin, x: number, y: number, z: number, size: number, seed: number, alpha: number): void {
  for (let n = 0; n < 3; n++) {
    const w = size * (0.5 + hash01(seed, n * 3, 682) * 0.6);
    const h = size * (0.3 + hash01(seed, n * 3 + 1, 682) * 0.4);
    const cx = x + (hash01(seed, n * 3 + 2, 683) - 0.5) * size;
    const cz = z + (hash01(seed, n, 684) - 0.5) * size * 0.9;
    const cy = y + (hash01(seed, n, 685) - 0.5) * size * 0.5;
    const fade = alpha * (0.6 + hash01(seed, n, 686) * 0.4);
    bin.addRGBA(
      'mist',
      boxGeometry(cx - w / 2, cy - h / 2, cz - w * 0.4, cx + w / 2, cy + h / 2, cz + w * 0.4),
      (vx, _vy, vz) => {
        const tint = mixColor(ROCK.mist, HAZE_COLOUR, islandHaze(vx, vz) * 0.7);
        return [tint.r, tint.g, tint.b, fade];
      },
    );
  }
}

/** Writes the fall's streaks into its colour buffer; `null` under reduced motion. */
type Falling = (elapsedMs: number) => void;

/**
 * The fall's motion.
 *
 * Every vertex keeps its still colour, an amplitude and a phase set by how far
 * down the sheet it sits, worked out once. A frame is then one sine and three
 * multiplies per vertex into buffers that already exist — no allocation, and
 * streaks that travel downward because the phase runs with depth.
 */
function cascade(geometry: BufferGeometry, still: boolean): Falling | null {
  if (still) return null;
  const colour = geometry.getAttribute('color') as BufferAttribute;
  const position = geometry.getAttribute('position') as BufferAttribute;
  const count = colour.count;
  const base = new Float32Array(colour.array as Float32Array);
  const amplitude = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const y = position.getY(i);
    const z = position.getZ(i);
    const t = clamp01((FALL_TOP_Y - y) / FALL_DROP);
    amplitude[i] = 0.06 + 0.16 * t;
    phase[i] = y * 0.55 + hash01(Math.round(z * 3), Math.round(y * 3), 691) * Math.PI * 2;
  }
  const values = colour.array as Float32Array;
  const rate = 0.0042;
  return (elapsedMs: number): void => {
    for (let i = 0; i < count; i++) {
      const gain = 1 + amplitude[i]! * Math.sin(phase[i]! + elapsedMs * rate);
      values[i * 3] = base[i * 3]! * gain;
      values[i * 3 + 1] = base[i * 3 + 1]! * gain;
      values[i * 3 + 2] = base[i * 3 + 2]! * gain;
    }
    colour.needsUpdate = true;
  };
}
