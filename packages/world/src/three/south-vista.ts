import {
  BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Color,
  type ColorRepresentation,
  type Material,
} from 'three';
import { SANDBOX_AREA, STREET_ORIGIN_X } from '@strkworld/shared';
import {
  GeometryBin,
  PALETTE,
  ResourceBag,
  boxGeometry,
  clamp01,
  coneGeometry,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  mixColor,
  pick,
  prismX,
  prismZ,
  shade,
  standardMaterial,
  type Point2,
} from './palette.js';
import { SKY_HORIZON } from './sky.js';
import { onRockTop, rockSpanAtZ } from './sky-island.js';

/**
 * The south vista (D-124): the water the district stands on, and the city
 * across it.
 *
 * The game camera always looks north (D-059), so everything south of the map
 * was hinterland nobody could ever see. The Exchange tower's roof changed
 * that: a rider on its swing turns and looks out over the south edge, and what
 * they see has to be worth the ride. So the south edge is a waterfront now — a
 * wide river across the whole view, a long low station with an arched glass
 * train shed on the far bank, and a gabled city behind it fading into haze.
 *
 * It is scenery and nothing else. Nothing here is walkable, nothing collides,
 * nothing is interactive, and no part of it stands on a map tile: the whole
 * group sits at `SOUTH_SHORE_Z` and beyond, which is past the backdrop's own
 * southern ground (backdrop.ts stops its fields, hedges and hills there).
 *
 * Built once, merged into six meshes, and animated by writing into buffers
 * that already exist, so a frame allocates nothing.
 */

// ---------------------------------------------------------------------------
// Where it sits, in street world coordinates (+X east, +Z south, +Y up)
// ---------------------------------------------------------------------------

/**
 * The street map's south edge. `createStreetMap().height`, pinned by
 * south-vista.test.ts: this module takes no map, because the roof branch
 * mounts it with nothing but `createSouthVista()`.
 */
export const MAP_SOUTH_EDGE = 28;

/**
 * The near bank: the water's edge on the district's side, and the line the
 * backdrop's own ground, hedges, trees and hills stop at (backdrop.ts).
 *
 * Far enough south that the lawn, the gladiator pit's bowl and the row of
 * houses the backdrop puts behind them all keep their ground; close enough
 * that from the Exchange roof the water runs off the bottom of the frame, as
 * it does from a lookout over a harbour.
 */
export const SOUTH_SHORE_Z = 58;

/**
 * The far bank's quay wall, where the water ends. Exported because the sky
 * island hangs the river's waterfalls off the rim between here and the near
 * shore (D-132), and sky-island.test.ts pins the pair equal.
 */
export const FAR_QUAY_Z = 110;
/** The far bank's ground, a step above the water. */
const FAR_BANK_Y = 1;
/** The water's surface, below the district's lawn; the falls leave at it. */
export const WATER_Y = -1.15;

/** The station's waterside face, and the back of its train shed. */
const STATION_FRONT_Z = 113;
const STATION_BACK_Z = 141;
/** The shed's span, centred on the Exchange tower so the swing looks straight at it. */
const STATION_CENTRE_X = STREET_ORIGIN_X + 15.5;
const STATION_HALF_X = 72;
/**
 * Where the train shed's arch springs from, and how far it rises. Long and
 * low: a shed of this kind reads as a horizontal, and from the roof it has to
 * sit under the city rather than in front of it.
 */
const SHED_SPRING_Y = 4.3;
const SHED_RISE = 6.6;

/** The city behind the station, from its first row to the last the haze keeps. */
const CITY_Z0 = 145;
const CITY_Z1 = 200;

/**
 * How wide the water would run if the world had no edge. The rock does
 * (D-132), so every row is cut to the rim at its own z and the river pours off
 * both flanks; this pair is only the bound the solver starts from, and the
 * cap on the city, which stops a setback short of the drop.
 */
const VISTA_X0 = -185;
const VISTA_X1 = SANDBOX_AREA.x + SANDBOX_AREA.width + 185;

/** How far in from the rim the far bank's buildings stop, leaving grass at the edge. */
const CITY_SETBACK = 12;

/**
 * How wide the city runs at most. Narrower than the water: it stands far
 * enough back that a smaller span still fills the frame corner to corner, and
 * every row costs houses.
 */
const CITY_X0 = -160;
const CITY_X1 = SANDBOX_AREA.x + SANDBOX_AREA.width + 158;

/**
 * The water's edges at a z: the rock's rim, where the river goes over. Falls
 * back to the nominal span only if the rim somehow does not reach, which it
 * always does across the river's band.
 */
function waterSpan(z: number): readonly [number, number] {
  const rim = rockSpanAtZ(z);
  return rim ? [Math.max(VISTA_X0, rim[0]), Math.min(VISTA_X1, rim[1])] : [VISTA_X0, VISTA_X1];
}

/** The far bank's ground at an x: from the quay out to the rim. */
function bankSpan(x: number): number | null {
  // Walk south from the quay until the rim is crossed; the bank is a wedge of
  // the disc, so a coarse bisection on z is exact enough for a slab's back edge.
  if (!onRockTop(x, FAR_QUAY_Z)) return null;
  let lo = FAR_QUAY_Z;
  let hi = FAR_QUAY_Z + 260;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (onRockTop(x, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Haze. Distance alone decides it, not the engine's fog: the fog's range
 * moves with the player's elevation (world-engine.ts) and would erase the far
 * bank from the one viewpoint the vista exists for. These materials opt out of
 * fog and carry their own, baked per vertex, so the vista reads the same from
 * the deck, from the swing's top and from its bottom.
 */
const HAZE_FROM = 92;
const HAZE_TO = 222;
/** Never quite the sky: the far city stays a band, as it does over real water. */
const HAZE_MAX = 0.9;
/**
 * The sky's own horizon (D-113's Horizon, shared with the title screen), cooled
 * a third of the way towards grey. Taken from the sky rather than restated, so
 * the two cannot drift; off it rather than equal to it, so the far city keeps a
 * silhouette instead of dissolving into the dome behind it.
 */
const HAZE_COLOUR = mixColor(SKY_HORIZON, 0xccd2d8, 0.34);

/** Ground-level air is thicker; it lifts the base of a far building before its top. */
const HAZE_GROUND_LIFT = 0.16;
const HAZE_GROUND_REACH = 16;

function haze(z: number, y: number): number {
  const along = clamp01((z - HAZE_FROM) / (HAZE_TO - HAZE_FROM));
  const low = HAZE_GROUND_LIFT * clamp01(1 - y / HAZE_GROUND_REACH);
  return Math.min(HAZE_MAX, along ** 0.82 * HAZE_MAX + low * along);
}

/** A colour as the air leaves it at (z, y). */
function hazed(colour: ColorRepresentation, z: number, y: number): Color {
  return mixColor(colour, HAZE_COLOUR, haze(z, y));
}

/** Paint for a bin: every vertex hazed by where it stands. */
const air =
  (colour: ColorRepresentation) =>
    (_x: number, y: number, z: number): Color =>
      hazed(colour, z, y);

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const VISTA = Object.freeze({
  /** The river, from the near bank's shadow out to the glare. */
  waterNear: 0x5a7380,
  waterFar: 0x8098a3,
  glare: 0xc3ced0,
  /** Quays, piers and the station's stone. */
  quay: 0x9a9286,
  quayDark: 0x7b746a,
  /** The far bank's own ground, greyer than a street apron so it reads as dockside. */
  bankGround: 0x948d82,
  pier: 0x8a7a63,
  pile: 0x5f5244,
  /** The train shed: standing-seam metal, its ribs a shade lighter. */
  shedMetal: 0x878d93,
  shedRib: 0x9ba1a7,
  shedBand: 0x666c73,
  /** Its glazing, and the arched gable ends. */
  glass: 0xc3d5dd,
  glassWarm: 0xdcd6c4,
  /** The station's brick front and the towers over the shed. */
  brick: 0xa8765c,
  brickDark: 0x8b6049,
  slate: 0x5b6169,
  /** The city behind: the backdrop town's pastels, and the moderns' cooler greys. */
  modern: Object.freeze([0x9fa8ae, 0xb0b2ad, 0x97a2a8, 0xa9a69c]),
  spire: 0x7d7467,
  /**
   * What the air does to the town's pastels before the haze even starts. The
   * backdrop's palette is the near rows' palette, and at this range its pinks
   * and greens read as confetti; washed towards a warm grey the city becomes
   * the one thing it should be, a textured band.
   */
  cityWash: 0xa39d93,
  /** Hulls. */
  hull: Object.freeze([0x3f4a52, 0x56423a, 0x45504a]),
  deck: 0xb9b2a4,
  foam: 0xeef2f0,
});

/** A town pastel as the far bank wears it: washed towards warm grey. */
function townStone(seed: number, channel: number): Color {
  const pastel = pick(PALETTE.backdrop, hash01(seed, 5, channel));
  return jitterColor(mixColor(pastel, VISTA.cityWash, 0.46), hash01(seed, 6, channel), 0.035);
}

// ---------------------------------------------------------------------------
// The module's shape
// ---------------------------------------------------------------------------

export interface SouthVistaOptions {
  /** `'low'` drops the boats and thins the city, for phones. */
  readonly quality?: 'low' | 'high';
  /** Sampled once at build: the water holds its glitter and the boats stand still. */
  readonly reducedMotion?: boolean;
}

export interface SouthVista {
  readonly group: Group;
  /** Total elapsed milliseconds, as the street's animators are given. */
  update(elapsedMs: number): void;
  dispose(): void;
}

/**
 * Build the vista. It stands in street world coordinates, so a caller adds
 * `group` straight to the street scene (or to any scene using those
 * coordinates) with no transform of its own.
 */
export function createSouthVista(options?: SouthVistaOptions): SouthVista {
  const low = options?.quality === 'low';
  const still = options?.reducedMotion === true;
  const res = new ResourceBag();
  const group = new Group();
  group.name = 'south-vista';

  let water: Ripples | null = null;
  let ferries: Ferries | null = null;

  const bin = new GeometryBin();
  try {
    layWater(bin, low);
    layBanks(bin, low);
    layStation(bin, low);
    layCity(bin, low);
    if (!low) layFerryHull(bin);

    // One material per bin. All four opt out of the engine's fog: the vista
    // carries its own haze, baked above.
    const land = res.material(standardMaterial({ roughness: 0.94 }));
    const river = res.material(standardMaterial({ roughness: 0.42 }));
    // The glazing is lit from within as much as from without, so it still
    // reads as glass on the shed's shaded north face.
    const glazing = res.material(
      standardMaterial({ roughness: 0.3, emissive: VISTA.glass, emissiveIntensity: 0.22 }),
    );
    for (const material of [land, river, glazing]) material.fog = false;

    const surface = flushBin(bin, 'water', river, res, group, { name: 'south-vista:water' });
    flushBin(bin, 'banks', land, res, group, { name: 'south-vista:banks' });
    flushBin(bin, 'station', land, res, group, { name: 'south-vista:station' });
    flushBin(bin, 'glass', glazing, res, group, { name: 'south-vista:glass' });
    flushBin(bin, 'city', land, res, group, { name: 'south-vista:city' });
    if (surface) water = ripples(surface.geometry, still);

    if (!low) {
      const hull = bin.take('ferry');
      if (hull) ferries = mountFerries(res, group, hull, land, still);
    }
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
      const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
      water?.(t);
      ferries?.(t);
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
// The river
// ---------------------------------------------------------------------------

/** The water's still colour at a point: darker inshore, with the sun's glare across the middle. */
function waterColour(x: number, z: number): Color {
  const across = clamp01((z - SOUTH_SHORE_Z) / (FAR_QUAY_Z - SOUTH_SHORE_Z));
  const base = mixColor(VISTA.waterNear, VISTA.waterFar, across ** 0.7);
  // A broad band of glare where the low sun lies on the water, broken up so it
  // never reads as a painted stripe.
  const band = Math.exp(-(((across - 0.6) / 0.42) ** 2));
  const broken = 0.5 + 0.5 * hash01(Math.round(x / 7), Math.round(z / 5), 311);
  return hazed(mixColor(base, VISTA.glare, band * broken * 0.3), z, 0);
}

/**
 * The water: one grid of flat cells, finer inshore where the eye is, coarser
 * out towards the far quay. Its colours are the only thing that moves.
 */
function layWater(bin: GeometryBin, low: boolean): void {
  const step = low ? 16 : 10;
  // Rows thicken with distance, so the near water keeps its sparkle without
  // paying for cells nobody can tell apart out by the quay.
  const rows: number[] = [SOUTH_SHORE_Z];
  for (let z = SOUTH_SHORE_Z, k = 0; z < FAR_QUAY_Z; k++) {
    z = Math.min(FAR_QUAY_Z, z + (low ? 5 : 2.4) + k * 0.55);
    rows.push(z);
  }
  for (let r = 0; r + 1 < rows.length; r++) {
    const z0 = rows[r]!;
    const z1 = rows[r + 1]!;
    // The row runs rim to rim: the river is as wide as the rock here, and goes
    // over the edge at both ends (sky-island.ts hangs the falls off them).
    const [west, east] = waterSpan((z0 + z1) / 2);
    for (let x = west; x < east; x += step) {
      const x1 = Math.min(east, x + step);
      bin.add('water', flatQuad(x, z0, x1, z1, WATER_Y), (vx, _vy, vz) => waterColour(vx, vz));
    }
  }
}

/** Writes the glitter into the water's colour buffer; `null` under reduced motion. */
type Ripples = (elapsedMs: number) => void;

/**
 * The glitter.
 *
 * Every vertex keeps its still colour, an amplitude and a phase, worked out
 * once. A frame is then one sine and three multiplies per vertex into buffers
 * that already exist — no allocation, and nothing to garbage-collect.
 */
function ripples(geometry: BufferGeometry, still: boolean): Ripples | null {
  const colour = geometry.getAttribute('color') as BufferAttribute;
  const position = geometry.getAttribute('position') as BufferAttribute;
  const count = colour.count;
  if (still) return null;
  const base = new Float32Array(colour.array as Float32Array);
  const amplitude = new Float32Array(count);
  const phase = new Float32Array(count);
  const rate = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const near = clamp01((FAR_QUAY_Z - z) / (FAR_QUAY_Z - SOUTH_SHORE_Z));
    // Chop reads inshore and flattens out towards the far bank, where the eye
    // cannot resolve it anyway.
    amplitude[i] = 0.05 + 0.13 * near * hash01(Math.round(x * 3), Math.round(z * 3), 312);
    phase[i] = hash01(Math.round(x * 5), Math.round(z * 7), 313) * Math.PI * 2 + x * 0.21 + z * 0.13;
    rate[i] = 0.0009 + 0.0011 * hash01(Math.round(x), Math.round(z), 314);
  }
  const values = colour.array as Float32Array;
  return (elapsedMs: number): void => {
    for (let i = 0; i < count; i++) {
      const gain = 1 + amplitude[i]! * Math.sin(phase[i]! + elapsedMs * rate[i]!);
      values[i * 3] = base[i * 3]! * gain;
      values[i * 3 + 1] = base[i * 3 + 1]! * gain;
      values[i * 3 + 2] = base[i * 3 + 2]! * gain;
    }
    colour.needsUpdate = true;
  };
}

// ---------------------------------------------------------------------------
// Both banks: the near edge, the far quay, its piers and what is moored there
// ---------------------------------------------------------------------------

function layBanks(bin: GeometryBin, low: boolean): void {
  // The district's own edge. A paved quay rather than a lawn running into the
  // water: a swing hanging out over the drop wants stone under it, and from
  // the roof this strip is the frame's bottom edge.
  const [nearWest, nearEast] = waterSpan(SOUTH_SHORE_Z - 2);
  bin.add('banks', flatQuad(nearWest, SOUTH_SHORE_Z - 4.2, nearEast, SOUTH_SHORE_Z, 0.04), (_x, _y, z) => hazed(PALETTE.apron, z, 0));
  bin.add(
    'banks',
    boxGeometry(nearWest, WATER_Y - 0.6, SOUTH_SHORE_Z - 0.75, nearEast, 0.3, SOUTH_SHORE_Z),
    air(VISTA.quay),
  );
  // Mooring posts along it, a reason for the edge to read as a quay.
  for (let x = STATION_CENTRE_X - 90; x < STATION_CENTRE_X + 96; x += 9) {
    const px = x + hash01(Math.round(x), 0, 321) * 3;
    bin.add('banks', boxGeometry(px - 0.22, 0.3, SOUTH_SHORE_Z - 0.5, px + 0.22, 0.86, SOUTH_SHORE_Z - 0.08), air(VISTA.quayDark));
  }

  // The far bank itself: the ground under the station and the city, a step
  // above the water, and the quay wall that holds it back. It is cut into
  // columns because its back edge is now the rock's rim, not a straight line:
  // past the city the bank runs on as grass and ends at the drop (D-132).
  const column = low ? 12 : 7;
  const [farWest, farEast] = waterSpan(FAR_QUAY_Z - 0.5);
  for (let x = farWest; x < farEast; x += column) {
    const x1 = Math.min(farEast, x + column);
    // The nearest of the column's three rim readings, so neither corner of
    // the slab overhangs where the rim wanders in between them.
    const reaches = [bankSpan(x), bankSpan((x + x1) / 2), bankSpan(x1)];
    if (reaches.some((reach) => reach === null)) continue;
    const back = Math.min(...(reaches as number[])) - 0.6;
    if (back <= FAR_QUAY_Z + 0.5) continue;
    bin.add('banks', boxGeometry(x, WATER_Y - 0.4, FAR_QUAY_Z, x1, FAR_BANK_Y - 0.06, back), air(VISTA.quayDark));
    bin.add('banks', flatQuad(x, FAR_QUAY_Z, x1, back, FAR_BANK_Y), (vx, _vy, vz) => {
      // Dockside by the water, meadow out at the rim, as the near bank is.
      const green = clamp01((vz - (CITY_Z0 - 8)) / 52);
      return hazed(mixColor(VISTA.bankGround, PALETTE.grassCool, green), vz, FAR_BANK_Y);
    });
  }
  // The quay's coping, proud of the wall it caps.
  bin.add('banks', boxGeometry(farWest, -0.1, FAR_QUAY_Z - 0.5, farEast, FAR_BANK_Y + 0.22, FAR_QUAY_Z + 0.4), air(VISTA.quay));

  // Finger piers and two ferry stages along the quay, out into the water. Low
  // and pale: at this range they read as a fringe along the bank, and anything
  // heavier competes with the shed behind them.
  const piers = low ? 5 : 10;
  for (let i = 0; i < piers; i++) {
    const seed = i * 7 + 1;
    const x = STATION_CENTRE_X - 80 + (i * 164) / piers + hash01(seed, 0, 322) * 6;
    const stage = i === 3 || i === 7;
    const w = stage ? 8 : 2.4 + hash01(seed, 1, 322) * 1.6;
    const z0 = FAR_QUAY_Z - (stage ? 9 : 4 + hash01(seed, 2, 322) * 4);
    bin.add('banks', boxGeometry(x, 0.1, z0, x + w, 0.44, FAR_QUAY_Z), air(VISTA.pier));
    for (let p = z0 + 0.6; p < FAR_QUAY_Z; p += 3.2) {
      for (const px of [x + 0.4, x + w - 0.4]) {
        bin.add('banks', boxGeometry(px - 0.16, WATER_Y - 0.3, p - 0.16, px + 0.16, 0.62, p + 0.16), air(VISTA.pile));
      }
    }
    if (stage) {
      // A small shelter where the ferries come alongside.
      bin.add('banks', boxGeometry(x + 1.8, 0.44, z0 + 1.6, x + w - 1.8, 2.2, z0 + 4.4), air(VISTA.quay));
      bin.add(
        'banks',
        prismZ([[x + 1.3, 2.2], [x + w / 2, 2.9], [x + w - 1.3, 2.2]], z0 + 1.3, z0 + 4.7),
        air(VISTA.slate),
      );
    }
  }

  if (low) return;

  // Barges moored along the far quay, flank on, and a couple inshore. Static:
  // only the ferries move.
  const berths: ReadonlyArray<readonly [number, number, number]> = [
    [STATION_CENTRE_X - 76, FAR_QUAY_Z - 2.6, 13],
    [STATION_CENTRE_X - 48, FAR_QUAY_Z - 2.4, 9],
    [STATION_CENTRE_X + 22, FAR_QUAY_Z - 2.8, 15],
    [STATION_CENTRE_X + 52, FAR_QUAY_Z - 2.5, 10],
    [STATION_CENTRE_X + 80, FAR_QUAY_Z - 2.6, 12],
    [STATION_CENTRE_X - 22, SOUTH_SHORE_Z + 2.6, 8],
  ];
  berths.forEach(([x, z, length], i) => {
    barge(bin, x, z, length, i);
  });
}

/** A moored barge, flank on to the quay: a low hull, a deck and a wheelhouse aft. */
function barge(bin: GeometryBin, x: number, z: number, length: number, seed: number): void {
  const beam = 2.5 + hash01(seed, 0, 331) * 0.8;
  const hull = pick(VISTA.hull, hash01(seed, 1, 331));
  const z0 = z - beam / 2;
  const z1 = z + beam / 2;
  // A hull with raked ends, so it is not a floating brick.
  bin.add(
    'banks',
    prismX([[z0 + 0.5, WATER_Y - 0.55], [z1 - 0.5, WATER_Y - 0.55], [z1, 0.35], [z0, 0.35]], x, x + length),
    air(hull),
  );
  bin.add('banks', prismX([[z0, 0.35], [z1, 0.35], [z1 - 0.6, -0.5], [z0 + 0.6, -0.5]], x - 1.4, x), air(hull));
  bin.add('banks', flatQuad(x + 0.4, z0 + 0.3, x + length - 0.4, z1 - 0.3, 0.3), air(VISTA.deck));
  bin.add('banks', boxGeometry(x + length - 3.4, 0.35, z0 + 0.4, x + length - 0.9, 1.75, z1 - 0.4), air(shade(hull, 0.3)));
  bin.add('banks', boxGeometry(x + length - 3.6, 1.75, z0 + 0.25, x + length - 0.7, 1.95, z1 - 0.25), air(VISTA.slate));
}

// ---------------------------------------------------------------------------
// The far bank's hero: the station and its arched train shed
// ---------------------------------------------------------------------------

/**
 * Points along a shallow circular arch, in the (z, y) plane `prismX` extrudes.
 * `inset` pulls them in towards the arc's centre, for the shell's soffit.
 */
function archPoints(
  zCentre: number,
  spring: number,
  halfSpan: number,
  rise: number,
  segments: number,
  inset = 0,
): Point2[] {
  const radius = (halfSpan ** 2 + rise ** 2) / (2 * rise);
  const centreY = spring + rise - radius;
  const limit = Math.asin(Math.min(1, halfSpan / radius));
  const r = radius - inset;
  const points: Point2[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = -limit + (2 * limit * i) / segments;
    points.push([zCentre + Math.sin(angle) * r, centreY + Math.cos(angle) * r]);
  }
  return points;
}

function layStation(bin: GeometryBin, low: boolean): void {
  const xa = STATION_CENTRE_X - STATION_HALF_X;
  const xb = STATION_CENTRE_X + STATION_HALF_X;
  const zc = (STATION_FRONT_Z + STATION_BACK_Z) / 2;
  const halfSpan = (STATION_BACK_Z - STATION_FRONT_Z) / 2;
  const segments = low ? 8 : 14;

  // The concourse the shed stands on: brick, with a platform apron in front of
  // it at quay level and a long canopy over that.
  bin.add('station', boxGeometry(xa, FAR_BANK_Y, STATION_FRONT_Z, xb, SHED_SPRING_Y, STATION_BACK_Z), air(VISTA.brick));
  bin.add('station', boxGeometry(xa - 0.4, SHED_SPRING_Y - 0.5, STATION_FRONT_Z - 0.35, xb + 0.4, SHED_SPRING_Y, STATION_BACK_Z), air(VISTA.brickDark));
  // Arcaded ground floor along the waterside, so the base does not read blank.
  for (let x = xa + 1.4; x < xb - 2.4; x += 3.1) {
    bin.add('station', boxGeometry(x, FAR_BANK_Y + 0.5, STATION_FRONT_Z - 0.42, x + 1.9, SHED_SPRING_Y - 1.1, STATION_FRONT_Z - 0.3), air(VISTA.slate));
  }
  // The platform apron and its canopy, between the station and the quay.
  bin.add('station', boxGeometry(xa, FAR_BANK_Y, FAR_QUAY_Z + 0.4, xb, FAR_BANK_Y + 0.3, STATION_FRONT_Z), air(VISTA.quay));
  bin.add(
    'station',
    prismX([[FAR_QUAY_Z + 1, 2.9], [STATION_FRONT_Z, 3.5], [STATION_FRONT_Z, 3.9], [FAR_QUAY_Z + 1, 3.3]], xa + 2, xb - 2),
    air(VISTA.slate),
  );
  for (let x = xa + 3; x < xb - 3; x += 6.5) {
    bin.add('station', boxGeometry(x - 0.16, FAR_BANK_Y + 0.3, FAR_QUAY_Z + 1.3, x + 0.16, 3, FAR_QUAY_Z + 1.62), air(VISTA.quayDark));
  }

  // The train shed. A shell, not a solid: each segment of the arch is its own
  // convex slab between the outer curve and the soffit under it.
  const outer = archPoints(zc, SHED_SPRING_Y, halfSpan, SHED_RISE, segments);
  const inner = archPoints(zc, SHED_SPRING_Y, halfSpan, SHED_RISE, segments, 0.55);
  // Which segments are glazed: a strip either side of the crown, as a shed of
  // this kind is roofed — metal over the platforms, daylight down the middle.
  const glazedAt = (i: number): boolean => {
    const t = Math.abs(i - (segments - 1) / 2) / (segments / 2);
    return t > 0.18 && t < 0.52;
  };
  for (let i = 0; i < segments; i++) {
    const quad: Point2[] = [outer[i]!, outer[i + 1]!, inner[i + 1]!, inner[i]!];
    const glazed = glazedAt(i);
    bin.add(
      glazed ? 'glass' : 'station',
      prismX(quad, xa, xb),
      glazed ? air(VISTA.glass) : air(i === Math.floor(segments / 2) ? VISTA.shedBand : VISTA.shedMetal),
    );
  }
  // A blank signage band across the waterside slope, where a station of this
  // kind carries its name. No lettering: the district names nothing it is not.
  const bandLow = outer[Math.max(0, Math.round(segments * 0.12))]!;
  const bandHigh = outer[Math.max(1, Math.round(segments * 0.3))]!;
  bin.add(
    'station',
    prismX(
      [
        [bandLow[0] - 0.25, bandLow[1] + 0.2],
        [bandHigh[0] - 0.25, bandHigh[1] + 0.2],
        [bandHigh[0] + 0.05, bandHigh[1] + 0.45],
        [bandLow[0] + 0.05, bandLow[1] + 0.45],
      ],
      xa + 6,
      xb - 6,
    ),
    air(VISTA.shedBand),
  );

  // Transverse ribs, standing just proud of the shell: enough to say steel at
  // this range without striping the roof.
  const ribs = low ? 8 : 18;
  const proud = archPoints(zc, SHED_SPRING_Y, halfSpan, SHED_RISE, segments, -0.14);
  for (let r = 0; r <= ribs; r++) {
    const x = xa + ((xb - xa) * r) / ribs;
    for (let i = 0; i < segments; i++) {
      const quad: Point2[] = [proud[i]!, proud[i + 1]!, inner[i + 1]!, inner[i]!];
      bin.add('station', prismX(quad, x - 0.16, x + 0.16), air(VISTA.shedRib));
    }
  }

  // The arched gable ends: the glazed screen that closes the vault, in a steel
  // frame. The west one faces the Exchange's swing almost square on.
  for (const [end, dir] of [[xa, -1], [xb, 1]] as const) {
    const screen = archPoints(zc, SHED_SPRING_Y, halfSpan - 0.3, SHED_RISE - 0.5, segments);
    for (let i = 0; i < segments; i++) {
      const quad: Point2[] = [
        [screen[i]![0], SHED_SPRING_Y],
        [screen[i + 1]![0], SHED_SPRING_Y],
        [screen[i + 1]![0], screen[i + 1]![1]],
        [screen[i]![0], screen[i]![1]],
      ];
      bin.add('glass', prismX(quad, end, end + dir * 0.3), air(VISTA.glassWarm));
      // A mullion up each division.
      bin.add(
        'station',
        boxGeometry(end + dir * 0.3, SHED_SPRING_Y, screen[i]![0] - 0.14, end + dir * 0.46, screen[i]![1], screen[i]![0] + 0.14),
        air(VISTA.shedRib),
      );
    }
    for (let i = 0; i < segments; i++) {
      const quad: Point2[] = [outer[i]!, outer[i + 1]!, inner[i + 1]!, inner[i]!];
      bin.add('station', prismX(quad, end + dir * 0.46, end + dir * 0.8), air(VISTA.shedRib));
    }
  }

  // Behind the shed, the station's own building: two towers rising clear of
  // the vault, which is all the water sees of it.
  for (const [x, height] of [[STATION_CENTRE_X - 27, 17.5], [STATION_CENTRE_X + 25, 15.5]] as const) {
    const w = 4.6;
    bin.add('station', boxGeometry(x - w / 2, FAR_BANK_Y, STATION_BACK_Z - 5, x + w / 2, height, STATION_BACK_Z + 1.6), air(VISTA.brick));
    bin.add('station', boxGeometry(x - w / 2 - 0.3, height, STATION_BACK_Z - 5.3, x + w / 2 + 0.3, height + 0.5, STATION_BACK_Z + 1.9), air(VISTA.brickDark));
    bin.add('station', coneGeometry(x, height + 0.5, STATION_BACK_Z - 1.7, w * 0.62, 4.4, 4), air(VISTA.slate));
    // A pale dial where a station clock would go: no hands, no emblem, no
    // lettering. The district names nothing it is not.
    bin.add('station', boxGeometry(x - 0.95, height - 4.1, STATION_BACK_Z - 5.2, x + 0.95, height - 2.2, STATION_BACK_Z - 5.04), air(VISTA.glassWarm));
  }
}

// ---------------------------------------------------------------------------
// The city behind, fading into haze
// ---------------------------------------------------------------------------

/** The rows of gabled houses, by their waterward faces, and how tall each row runs. */
const CITY_ROWS: ReadonlyArray<readonly [number, number, number]> = [
  [CITY_Z0, 4.5, 8.5],
  [CITY_Z0 + 12, 5, 9.5],
  [CITY_Z0 + 25, 4.5, 9],
  [CITY_Z0 + 38, 4, 8],
  [CITY_Z1 - 7, 4, 7.5],
];

/**
 * Whether a footprint stands clear of the rock's rim, with the setback every
 * building on the far bank keeps from the drop (D-132). Checked at the corners:
 * a house is small next to a rim 180 across.
 */
function onBank(x0: number, z0: number, x1: number, z1: number): boolean {
  return (
    onRockTop(x0, z0, CITY_SETBACK) &&
    onRockTop(x1, z0, CITY_SETBACK) &&
    onRockTop(x0, z1, CITY_SETBACK) &&
    onRockTop(x1, z1, CITY_SETBACK)
  );
}

function layCity(bin: GeometryBin, low: boolean): void {
  waterfront(bin);
  const rows = low ? CITY_ROWS.filter((_, i) => i % 2 === 0) : CITY_ROWS;
  rows.forEach((row, r) => {
    const [zFront, hLow, hHigh] = row;
    const depth = 5 + hash01(r, 0, 341) * 2;
    const channel = 350 + r * 7;
    // The far rows need more width to fill the same frame, and can be thinner
    // on the ground: the haze and the rows in front hide most of them.
    const skip = 0.1 + r * 0.07;
    let x = CITY_X0;
    for (let s = 1; x < CITY_X1; s++) {
      const w = 2.2 + hash01(s, 1, channel) * 2.3 + r * 0.35;
      if (hash01(s, 2, channel) >= skip && onBank(x, zFront, x + w, zFront + depth)) {
        canalHouse(bin, x, w, depth, zFront, hLow + hash01(s, 3, channel) * (hHigh - hLow), s, channel);
      }
      x += w + 0.25 + hash01(s, 4, channel) * 0.5;
    }
  });

  // Spires, standing clear of the roofs the way a city's towers do.
  const spires: ReadonlyArray<readonly [number, number, number]> = [
    [STATION_CENTRE_X - 84, CITY_Z0 + 20, 20],
    [STATION_CENTRE_X - 32, CITY_Z0 + 9, 16.5],
    [STATION_CENTRE_X + 31, CITY_Z0 + 16, 21],
    [STATION_CENTRE_X + 88, CITY_Z0 + 11, 17],
    [STATION_CENTRE_X + 132, CITY_Z0 + 33, 18],
  ];
  for (const [x, z, height] of low ? spires.filter((_, i) => i % 2 === 0) : spires) {
    const w = 2.9;
    if (!onBank(x - w, z - w, x + w, z + w)) continue;
    bin.add('city', boxGeometry(x - w / 2, FAR_BANK_Y, z - w / 2, x + w / 2, height, z + w / 2), air(VISTA.spire));
    bin.add('city', boxGeometry(x - w / 2 - 0.3, height, z - w / 2 - 0.3, x + w / 2 + 0.3, height + 0.45, z + w / 2 + 0.3), air(VISTA.slate));
    bin.add('city', coneGeometry(x, height + 0.45, z, w * 0.72, 6 + hash01(Math.round(x), Math.round(z), 362) * 3, 4), air(VISTA.slate));
  }

  // A handful of modern blocks, flat topped and cooler, the way a historic
  // skyline carries its late arrivals.
  const blocks: ReadonlyArray<readonly [number, number, number, number]> = [
    [STATION_CENTRE_X - 118, CITY_Z0 + 26, 11, 13],
    [STATION_CENTRE_X - 57, CITY_Z0 + 40, 9.5, 15.5],
    [STATION_CENTRE_X + 6, CITY_Z0 + 52, 12, 12.5],
    [STATION_CENTRE_X + 62, CITY_Z0 + 31, 10, 17],
    [STATION_CENTRE_X + 108, CITY_Z0 + 45, 13, 14],
    [STATION_CENTRE_X + 158, CITY_Z0 + 24, 11, 12],
  ];
  blocks.forEach(([x, z, w, height], i) => {
    if (!onBank(x, z, x + w, z + 7.75)) return;
    const colour = pick(VISTA.modern, hash01(i, 0, 361));
    bin.add('city', boxGeometry(x, FAR_BANK_Y, z, x + w, height, z + 7.5), air(colour));
    bin.add('city', boxGeometry(x - 0.25, height, z - 0.25, x + w + 0.25, height + 0.4, z + 7.75), air(shade(colour, -0.1)));
    // Floor bands, so a flat slab still reads as a building through the haze.
    for (let y = 2.2; y < height - 0.8; y += 2.2) {
      bin.add('city', boxGeometry(x - 0.1, y, z - 0.12, x + w + 0.1, y + 0.3, z), air(shade(colour, -0.14)));
    }
  });
}

/**
 * The quayside either side of the station: dock sheds, warehouses and the odd
 * taller block, right on the bank.
 *
 * Without it the far bank reads as a bare apron between the water and the
 * first row of houses — which from the roof is a pale band straight across the
 * frame, the one thing the reference view does not have.
 */
function waterfront(bin: GeometryBin): void {
  const xa = STATION_CENTRE_X - STATION_HALF_X - 4;
  const xb = STATION_CENTRE_X + STATION_HALF_X + 4;
  let x = VISTA_X0 + 16;
  for (let s = 1; x < VISTA_X1 - 16; s++) {
    const w = 5 + hash01(s, 0, 371) * 7;
    // The station owns its own frontage.
    if (x + w < xa || x > xb) {
      const depth = 8 + hash01(s, 1, 371) * 9;
      const height = 4 + hash01(s, 2, 371) * 6.5;
      const zFront = FAR_QUAY_Z + 1.6 + hash01(s, 3, 371) * 3;
      if (!onBank(x, zFront, x + w, zFront + depth)) {
        x += w + 1 + hash01(s, 7, 371) * 2.5;
        continue;
      }
      const colour = townStone(s * 13 + 4, 371);
      bin.add('city', boxGeometry(x, FAR_BANK_Y, zFront, x + w, height, zFront + depth), air(colour));
      // A long ridged roof: a dock shed reads by its roof more than its walls.
      bin.add(
        'city',
        prismZ([[x - 0.2, height], [x + w / 2, height + 1.1 + hash01(s, 6, 371)], [x + w + 0.2, height]], zFront - 0.2, zFront + depth + 0.2),
        air(shade(colour, -0.24, 0.04)),
      );
    }
    x += w + 1 + hash01(s, 7, 371) * 2.5;
  }
}

/** One canal house: a narrow body and a gable, stepped, pointed or a plain cornice. */
function canalHouse(
  bin: GeometryBin,
  x: number,
  w: number,
  depth: number,
  zFront: number,
  height: number,
  seed: number,
  channel: number,
): void {
  const colour = townStone(seed, channel);
  const zBack = zFront + depth;
  bin.add('city', boxGeometry(x, FAR_BANK_Y, zFront, x + w, height, zBack), air(colour));
  const roof = shade(colour, -0.22, 0.04);
  const kind = hash01(seed, 7, channel);
  if (kind < 0.34) {
    // A stepped gable on the waterward face, over a pitched roof behind it.
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      const inset = (w / 2) * ((i + 1) / (steps + 1));
      bin.add('city', boxGeometry(x + inset, height + i * 0.6, zFront, x + w - inset, height + (i + 1) * 0.6, zFront + 0.45), air(colour));
    }
    bin.add('city', prismX([[zFront, height], [zBack, height], [(zFront + zBack) / 2, height + 1.5]], x, x + w), air(roof));
  } else if (kind < 0.78) {
    // A pointed gable facing the water, the ridge running back.
    bin.add('city', prismZ([[x, height], [x + w / 2, height + 1.5 + hash01(seed, 8, channel)], [x + w, height]], zFront, zBack), air(roof));
  } else {
    // A cornice and a shallow hipped roof.
    bin.add('city', boxGeometry(x - 0.18, height, zFront - 0.18, x + w + 0.18, height + 0.3, zBack + 0.18), air(roof));
    bin.add('city', prismX([[zFront, height + 0.3], [zBack, height + 0.3], [(zFront + zBack) / 2, height + 1.2]], x + 0.2, x + w - 0.2), air(shade(roof, -0.05)));
  }
}

// ---------------------------------------------------------------------------
// The ferries: one instanced hull, two of them, moving very slowly
// ---------------------------------------------------------------------------

/** How a ferry runs: a leg it shuttles along, and how long one leg takes. */
interface Crossing {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly periodMs: number;
  readonly offset: number;
}

const CROSSINGS: readonly Crossing[] = Object.freeze([
  // Across the river, from the far bank's ferry stage to the district's side.
  Object.freeze({ x0: STATION_CENTRE_X + 4, z0: FAR_QUAY_Z - 9, x1: STATION_CENTRE_X - 8, z1: SOUTH_SHORE_Z + 5, periodMs: 74_000, offset: 0.28 }),
  // And one running the length of the water, passing in front of the station.
  Object.freeze({ x0: STATION_CENTRE_X - 110, z0: 88, x1: STATION_CENTRE_X + 118, z1: 81, periodMs: 196_000, offset: 0.62 }),
]);

type Ferries = (elapsedMs: number) => void;

/** A ferry's hull, built once at the origin, pointing along +X. */
function layFerryHull(bin: GeometryBin): void {
  const L = 7.4;
  const B = 2.6;
  const hull = VISTA.hull[0]!;
  // The hull, raked at the bow, with a transom aft.
  bin.add(
    'ferry',
    prismX([[-B / 2 + 0.35, -0.75], [B / 2 - 0.35, -0.75], [B / 2, 0.42], [-B / 2, 0.42]], -L / 2, L / 2 - 1.3),
    hull,
  );
  bin.add('ferry', prismX([[-B / 2, 0.42], [B / 2, 0.42], [B / 2 - 0.5, -0.5], [-B / 2 + 0.5, -0.5]], L / 2 - 1.3, L / 2), hull);
  bin.add('ferry', flatQuad(-L / 2 + 0.3, -B / 2 + 0.25, L / 2 - 0.6, B / 2 - 0.25, 0.4), VISTA.deck);
  // Superstructure and a short funnel.
  bin.add('ferry', boxGeometry(-L / 2 + 1.1, 0.42, -B / 2 + 0.3, L / 2 - 2.4, 1.8, B / 2 - 0.3), VISTA.deck);
  bin.add('ferry', boxGeometry(-L / 2 + 1.3, 1.8, -B / 2 + 0.15, L / 2 - 2.6, 2.0, B / 2 - 0.15), VISTA.slate);
  bin.add('ferry', boxGeometry(-0.9, 2.0, -0.45, 0.5, 2.9, 0.45), VISTA.hull[1]!);
  // The bow wave, which travels with her.
  bin.add('ferry', prismX([[-B / 2 - 0.5, -0.1], [B / 2 + 0.5, -0.1], [B / 2 - 0.2, 0.22], [-B / 2 + 0.2, 0.22]], L / 2 - 0.6, L / 2 + 1.5), VISTA.foam);
}

/**
 * Mount the ferries as one instanced mesh. The haze is baked from where each
 * one sails rather than per vertex, which is near enough on a hull this size
 * and keeps a frame to two matrix writes.
 */
function mountFerries(
  res: ResourceBag,
  parent: Group,
  hull: BufferGeometry,
  material: Material,
  still: boolean,
): Ferries | null {
  res.geometry(hull);
  const mesh = new InstancedMesh(hull, material, CROSSINGS.length);
  mesh.name = 'south-vista:ferries';
  res.disposable(mesh);
  // One sphere over the whole river, so the street's north-facing camera culls
  // the pair in one test instead of re-measuring them every frame.
  mesh.boundingSphere = new Sphere(
    new Vector3(STATION_CENTRE_X, 0, (SOUTH_SHORE_Z + FAR_QUAY_Z) / 2),
    120,
  );
  parent.add(mesh);

  const matrix = new Matrix4();
  const place = (elapsedMs: number): void => {
    for (let i = 0; i < CROSSINGS.length; i++) {
      const leg = CROSSINGS[i]!;
      // A triangle wave: out, then back, with no turn-round to animate.
      const cycle = ((elapsedMs / leg.periodMs + leg.offset) % 2 + 2) % 2;
      const t = cycle < 1 ? cycle : 2 - cycle;
      const x = leg.x0 + (leg.x1 - leg.x0) * t;
      const z = leg.z0 + (leg.z1 - leg.z0) * t;
      const way = cycle < 1 ? 1 : -1;
      const yaw = Math.atan2((leg.x1 - leg.x0) * way, (leg.z1 - leg.z0) * way);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      // Translation times a yaw, written straight out: `Matrix4.set` allocates
      // nothing, and neither does `setMatrixAt`.
      matrix.set(c, 0, s, x, 0, 1, 0, WATER_Y + 0.5, -s, 0, c, z, 0, 0, 0, 1);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  place(0);
  return still ? null : place;
}
