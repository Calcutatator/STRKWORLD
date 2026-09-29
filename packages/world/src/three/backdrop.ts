import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { Color, ColorRepresentation } from 'three';
import type { DistrictMap } from '../map/street.js';
import {
  PALETTE,
  aoPaint,
  boxGeometry,
  coneGeometry,
  cylinderGeometry,
  faceQuad,
  hash01,
  jitterColor,
  mixColor,
  pick,
  prismX,
  shade,
  sphereGeometry,
  type Face,
  type GeometryBin,
} from './palette.js';

/**
 * The city and country around the district (D-059): everything a camera sees
 * past the map's edges before the fog.
 *
 * Nothing here stands on a map tile. To the north the city runs on in rows
 * that rise toward the back, over paved blocks and streets; west, where the
 * road runs on past its barrier, and east of the sandbox square there are
 * low-rise streets and hill parks; south, beyond the groves, a line of
 * cottages. The rooftop camera looks steeply down from 36 up, where the fog
 * never reaches, so this has to fill its whole frame, the frame of a wide
 * window included (street-builder.test.ts pins it). From the street the far
 * rows stand behind the first two and fade toward the horizon haze, so the
 * protocol buildings keep the eye. It all goes into the street's existing
 * merged bins ('far' and 'far-lit' for volumes, the ground's bins for the
 * floor), so it costs no draw calls, and every choice is a seeded hash.
 */

/**
 * How far the ground runs past the map's north, west and east edges: past
 * the rooftop frame of a 32:9 window, and past the fog seen from the tallest
 * sandbox stack, whose frame reaches furthest.
 */
export const HINTERLAND = 120;

/** Where the city's paving starts, just behind the tree line along the north hedge. */
export const CITY_FRONT = -2.9;

/** How far the city runs past the map's west and east edges. */
const CITY_WEST = 66;
const CITY_EAST = 84;

/** A row of backdrop blocks: the z of their street faces, and the ranges each block's depth and height are drawn from. */
interface BackdropRow {
  readonly zFront: number;
  readonly depth: readonly [number, number];
  readonly height: readonly [number, number];
}

/** The two rows the street sees between and above the buildings. */
const NEAR_ROWS: readonly BackdropRow[] = Object.freeze([
  Object.freeze({ zFront: -3.2, depth: [2.5, 4.2], height: [3.2, 7.5] } as const),
  Object.freeze({ zFront: -9.5, depth: [3, 5], height: [6, 12] } as const),
]);

type WindowStyle = 'grid' | 'bands' | 'lit';

interface FarRow extends BackdropRow {
  /**
   * How far the row's colours fade toward the horizon haze. Aerial
   * perspective baked in, so the rows recede from the roof too, where the fog
   * does not reach.
   */
  readonly haze: number;
  /**
   * Every window on a dark band per floor, or only the lit ones. The last
   * rows lie beyond the rooftop frame and deep in the street's fog, so they
   * keep only what shows through it.
   */
  readonly windows: WindowStyle;
}

/** The city behind the near rows, rising toward the back. */
const FAR_ROWS: readonly FarRow[] = Object.freeze([
  { zFront: -17, depth: [3.5, 5.5], height: [8, 15], haze: 0.08, windows: 'bands' },
  { zFront: -24.5, depth: [4, 6.5], height: [10, 19], haze: 0.16, windows: 'bands' },
  { zFront: -33, depth: [4.5, 7.5], height: [13, 24], haze: 0.24, windows: 'lit' },
  { zFront: -43, depth: [5, 8.5], height: [16, 29], haze: 0.32, windows: 'lit' },
] as const);

/**
 * North-south streets through the far rows, one every `CROSS_PITCH` along x,
 * each `2 * CROSS_HALF` wide. The first near rows keep their old unbroken run.
 */
const CROSS_PITCH = 27;
const CROSS_ORIGIN = 11;
const CROSS_HALF = 1.1;

/** A flat patch of the city's floor, in world x and z. */
export interface FloorPatch {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly surface: 'street' | 'paving';
}

/** The backdrop city's footprint and its floor. */
export interface CityPlan {
  readonly x0: number;
  readonly x1: number;
  /** The north edge of its last row's paving. */
  readonly back: number;
  readonly floor: readonly FloorPatch[];
}

/**
 * Paving under each row, from its street face to just behind its deepest
 * block, and a street between one row and the next; north-south streets cut
 * the far rows' paving.
 */
export function cityPlan(width: number): CityPlan {
  const x0 = -CITY_WEST;
  const x1 = width + CITY_EAST;
  const rows: readonly BackdropRow[] = [...NEAR_ROWS, ...FAR_ROWS];
  const floor: FloorPatch[] = [];
  let near = CITY_FRONT;
  let back = CITY_FRONT;
  rows.forEach((row, i) => {
    back = row.zFront - row.depth[1] - 0.15;
    const crossed = i >= NEAR_ROWS.length;
    let from = x0;
    for (const street of crossed ? crossStreets(x0, x1) : []) {
      floor.push({ x0: from, z0: back, x1: street.x0, z1: near, surface: 'paving' });
      floor.push({ x0: street.x0, z0: back, x1: street.x1, z1: near, surface: 'street' });
      from = street.x1;
    }
    floor.push({ x0: from, z0: back, x1, z1: near, surface: 'paving' });
    const next = rows[i + 1];
    if (!next) return;
    near = next.zFront + 0.15;
    floor.push({ x0, z0: near, x1, z1: back, surface: 'street' });
  });
  return { x0, x1, back, floor };
}

function crossStreets(x0: number, x1: number): { x0: number; x1: number }[] {
  const streets: { x0: number; x1: number }[] = [];
  const first = Math.ceil((x0 + CROSS_HALF - CROSS_ORIGIN) / CROSS_PITCH);
  for (let k = first; CROSS_ORIGIN + k * CROSS_PITCH + CROSS_HALF <= x1; k++) {
    const centre = CROSS_ORIGIN + k * CROSS_PITCH;
    streets.push({ x0: centre - CROSS_HALF, x1: centre + CROSS_HALF });
  }
  return streets;
}

// ---------------------------------------------------------------------------
// Hills
// ---------------------------------------------------------------------------

/** A low dome of land: a hemisphere of `radius`, squashed to `scaleY`. */
interface Hill {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly scaleY: number;
}

/**
 * The hills around the district. To the north two small ones are parks the
 * far rows run round, and three larger ones rise just behind the city's last
 * row; they stood where the city now does. The west one sits north of the
 * road, which it used to bury where the road runs on past the barrier.
 */
function hillSpots(width: number, height: number): readonly Hill[] {
  const W = width;
  const H = height;
  const spots: ReadonlyArray<readonly [number, number, number, number]> = [
    [-26, -25, 9, 0.34],
    [-4, -74, 20, 0.3],
    [34, -30, 7.5, 0.4],
    [56, -74, 20, 0.3],
    [W + 30, -72, 18, 0.3],
    [-46, -4, 12, 0.3],
    [-38, 38, 14, 0.28],
    [W + 40, 4, 14, 0.32],
    [W + 38, 36, 13, 0.3],
    [8, H + 36, 16, 0.25],
    [40, H + 40, 18, 0.25],
  ];
  return spots.map(([x, z, radius, scaleY]) => ({ x, z, radius, scaleY }));
}

/** The smooth dome's height at (x, z); the faceted mesh stands a little lower. */
function hillHeightAt(hills: readonly Hill[], x: number, z: number): number {
  let top = 0;
  for (const hill of hills) {
    const d2 = ((x - hill.x) ** 2 + (z - hill.z) ** 2) / hill.radius ** 2;
    if (d2 < 1) top = Math.max(top, hill.radius * hill.scaleY * Math.sqrt(1 - d2));
  }
  return top;
}

/** Whether a footprint would stand on a hill, rather than at its foot. */
function onHill(hills: readonly Hill[], x0: number, z0: number, x1: number, z1: number): boolean {
  const xm = (x0 + x1) / 2;
  const zm = (z0 + z1) / 2;
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [xm, zm]] as const) {
    if (hillHeightAt(hills, x, z) > 0.6) return true;
  }
  return false;
}

export function hills(map: DistrictMap, bin: GeometryBin): void {
  hillSpots(map.width, map.height).forEach(({ x, z, radius, scaleY }, i) => {
    bin.add(
      'far',
      sphereGeometry(x, 0, z, radius, { widthSegments: 9, heightSegments: 4, hemisphere: true, scaleY }),
      jitterColor(pick(PALETTE.hills, hash01(i, 1, 91)), hash01(i, 2, 91), 0.04),
    );
  });
}

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

/** Fade a colour toward the horizon haze; zero leaves it exactly as it was. */
function hazed(colour: ColorRepresentation, haze: number): ColorRepresentation {
  return haze > 0 ? mixColor(colour, PALETTE.backdropHaze, haze) : colour;
}

interface BlockSpec {
  readonly x: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
  /** The street face, facing +Z. */
  readonly zFront: number;
  readonly colour: ColorRepresentation;
  readonly seed: number;
  /** Hash channel of the block's own choices; its windows use the next two. */
  readonly channel: number;
  readonly windows: WindowStyle;
  readonly haze: number;
}

/**
 * One city block: a body darkened toward the ground, a cornice, a water tower
 * or plant room, and windows on its street face. `grid` is the near rows'
 * look, and with their hash channel it reproduces them exactly.
 */
function cityBlock(bin: GeometryBin, block: BlockSpec): void {
  const { x, w, d, h, colour, seed, channel } = block;
  const zb = block.zFront;
  const za = zb - d;
  bin.add('far', boxGeometry(x, 0, za, x + w, h, zb), aoPaint(colour, 0.08));
  bin.add('far', boxGeometry(x - 0.05, h, za - 0.05, x + w + 0.05, h + 0.18, zb + 0.05), shade(colour, -0.12));
  let roof = h + 0.18;
  if (block.windows !== 'grid' && h > 14 && hash01(seed, 9, channel) < 0.35) {
    // A setback crown on the tall ones, for a broken skyline.
    const top = roof + h * (0.12 + hash01(seed, 10, channel) * 0.2);
    const [ta, tb] = [x + w * 0.18, x + w * 0.82];
    const [tza, tzb] = [za + d * 0.2, zb - d * 0.25];
    bin.add('far', boxGeometry(ta, roof, tza, tb, top, tzb), aoPaint(shade(colour, 0.03), 0.05, top));
    bin.add('far', boxGeometry(ta - 0.05, top, tza - 0.05, tb + 0.05, top + 0.16, tzb + 0.05), shade(colour, -0.12));
    roof = top + 0.16;
  }
  if (hash01(seed, 5, channel) < 0.4) {
    const tx = x + w * (0.3 + hash01(seed, 7, channel) * 0.4);
    const tz = za + d * 0.4;
    bin.add('far', cylinderGeometry(tx, roof, tz, 0.45, 0.45, 0.9, 8), hazed(0x9a7d62, block.haze));
    bin.add('far', coneGeometry(tx, roof + 0.9, tz, 0.55, 0.45, 8), hazed(0x6f5a48, block.haze));
  } else if (hash01(seed, 8, channel) < 0.6) {
    bin.add('far', boxGeometry(x + w * 0.2, roof, za + 0.4, x + w * 0.45, roof + 0.52, za + 1.2), shade(colour, -0.06));
  }
  const face: Face = { normal: 'z+', plane: zb };
  const cols = Math.max(1, Math.floor((w - 0.6) / 0.85));
  const floors = Math.max(1, Math.floor((h - 1.2) / 1.05));
  const dark = hazed(PALETTE.backdropWindowDark, block.haze);
  const share = block.windows === 'lit' ? 0.22 : 0.32;
  // A lit window on a band stands proud of it, so the two never fight for depth.
  const litOut = block.windows === 'bands' ? 0.03 : 0.01;
  for (let r = 0; r < floors; r++) {
    const v = 0.9 + r * 1.05;
    if (block.windows === 'bands') bin.add('far', faceQuad(face, x + 0.3, v, x + w - 0.3, v + 0.55, 0.01), dark);
    for (let c = 0; c < cols; c++) {
      const u = x + 0.3 + (c + 0.5) * ((w - 0.6) / cols);
      if (hash01(seed, r * 31 + c, channel + 2) < share) {
        const colour: Color = jitterColor(PALETTE.backdropWindow, hash01(seed, r * 31 + c, channel + 3), 0.06);
        bin.add('far-lit', faceQuad(face, u - 0.2, v, u + 0.2, v + 0.55, litOut), colour);
      } else if (block.windows === 'grid') {
        bin.add('far', faceQuad(face, u - 0.2, v, u + 0.2, v + 0.55, 0.01), dark);
      }
    }
  }
}

/** Where one near row's original run of blocks starts and ends. */
interface RowSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The city continuing to the north: simple blocks with lit windows, softened
 * by fog. The two near rows keep their original run (the street's view of
 * them is unchanged) and run on past both ends; behind them the far rows.
 */
export function backdropCity(map: DistrictMap, bin: GeometryBin): void {
  const W = map.width;
  const hills = hillSpots(W, map.height);
  const spans: RowSpan[] = [];
  let seed = 1;
  for (const row of NEAR_ROWS) {
    const start = -18 + hash01(seed, 0, 41) * 2;
    let x = start;
    while (x < W + 18) {
      const w = 2.6 + hash01(seed, 1, 41) * 3.6;
      nearBlock(bin, row, x, w, seed, 41);
      x += w + 0.5 + hash01(seed, 6, 41) * 1.6;
      seed++;
    }
    spans.push({ start, end: x });
  }
  const { x0, x1 } = cityPlan(W);
  NEAR_ROWS.forEach((row, i) => extendNearRow(bin, row, spans[i]!, x0, x1, hills, 141 + i * 10));
  FAR_ROWS.forEach((row, i) => farRow(bin, row, x0, x1, hills, 241 + i * 10));
  suburbs(map, bin, hills);
}

function nearBlock(bin: GeometryBin, row: BackdropRow, x: number, w: number, seed: number, channel: number): void {
  cityBlock(bin, {
    x,
    w,
    d: row.depth[0] + hash01(seed, 2, channel) * (row.depth[1] - row.depth[0]),
    h: row.height[0] + hash01(seed, 3, channel) * (row.height[1] - row.height[0]),
    zFront: row.zFront,
    colour: pick(PALETTE.backdrop, hash01(seed, 4, channel)),
    seed,
    channel,
    windows: 'grid',
    haze: 0,
  });
}

/** A near row on past its original run, west to the city's edge and east to its other one. */
function extendNearRow(
  bin: GeometryBin,
  row: BackdropRow,
  span: RowSpan,
  x0: number,
  x1: number,
  hills: readonly Hill[],
  channel: number,
): void {
  const fits = (a: number, b: number): boolean => !onHill(hills, a, row.zFront - row.depth[1], b, row.zFront);
  let seed = 1;
  let x = span.start;
  for (;;) {
    x -= 0.5 + hash01(seed, 6, channel) * 1.6;
    const w = 2.6 + hash01(seed, 1, channel) * 3.6;
    if (x - w < x0) break;
    if (fits(x - w, x)) nearBlock(bin, row, x - w, w, seed, channel);
    x -= w;
    seed++;
  }
  x = span.end;
  while (x < x1) {
    const w = 2.6 + hash01(seed, 1, channel) * 3.6;
    if (x + w > x1) break;
    if (fits(x, x + w)) nearBlock(bin, row, x, w, seed, channel);
    x += w + 0.5 + hash01(seed, 6, channel) * 1.6;
    seed++;
  }
}

/** One far row across the city: wider blocks, cut by the cross streets, parting round the hills. */
function farRow(bin: GeometryBin, row: FarRow, x0: number, x1: number, hills: readonly Hill[], channel: number): void {
  const streets = crossStreets(x0, x1);
  let seed = 1;
  let x = x0 + hash01(seed, 0, channel) * 2;
  while (x < x1) {
    const s = seed++;
    const w = 3 + hash01(s, 1, channel) * 4;
    if (x + w > x1) break;
    const street = streets.find((candidate) => x < candidate.x1 + 0.3 && x + w > candidate.x0 - 0.3);
    if (street) {
      x = street.x1 + 0.3 + hash01(s, 0, channel) * 0.6;
      continue;
    }
    const d = row.depth[0] + hash01(s, 2, channel) * (row.depth[1] - row.depth[0]);
    if (!onHill(hills, x, row.zFront - d, x + w, row.zFront)) {
      cityBlock(bin, {
        x,
        w,
        d,
        h: row.height[0] + hash01(s, 3, channel) * (row.height[1] - row.height[0]),
        zFront: row.zFront,
        colour: hazed(pick(PALETTE.backdrop, hash01(s, 4, channel)), row.haze),
        seed: s,
        channel,
        windows: row.windows,
        haze: row.haze,
      });
    }
    x += w + 0.5 + hash01(s, 6, channel) * 1.4;
  }
}

// ---------------------------------------------------------------------------
// Low-rise streets: west along the road, east of the square, south
// ---------------------------------------------------------------------------

/** A row of houses: the z of their street faces, which way those face, and ranges for depth and height. */
interface HouseRow {
  readonly zFront: number;
  readonly facing: 'z+' | 'z-';
  readonly depth: readonly [number, number];
  readonly height: readonly [number, number];
  /** Where the row starts, nearest the map. */
  readonly from: number;
}

/** The road's rows where it runs off the map's west edge, read from the tiles like the barrier's. */
function westRoad(map: DistrictMap): { top: number; bottom: number } | null {
  let top = -1;
  let bottom = -1;
  map.tiles.forEach((row, y) => {
    const kind = row[0];
    if (kind !== 'road' && kind !== 'pavement') return;
    if (top < 0) top = y;
    bottom = y + 1;
  });
  return top < 0 ? null : { top, bottom };
}

function suburbs(map: DistrictMap, bin: GeometryBin, hills: readonly Hill[]): void {
  const W = map.width;
  const H = map.height;
  const road = westRoad(map);
  // West, past the barrier and the groves: two rows of houses either side of
  // the road as it runs on, back gardens between.
  // The back rows start further out, so the street's own view west (from its
  // closed end) keeps the groves it had and the houses stay beyond them.
  const west: HouseRow[] = road
    ? [
        { zFront: road.top - 0.7, facing: 'z+', depth: [3.2, 4.6], height: [2.6, 5.8], from: -14.5 },
        { zFront: road.top - 7.6, facing: 'z+', depth: [3, 4.2], height: [2.6, 5], from: -18 },
        { zFront: road.bottom + 0.7, facing: 'z-', depth: [3.2, 4.6], height: [2.6, 5.8], from: -14.5 },
        { zFront: road.bottom + 7.6, facing: 'z-', depth: [3, 4.2], height: [2.6, 5], from: -16 },
      ]
    : [];
  west.forEach((row, i) => houseRow(bin, row, -CITY_WEST, hills, 351 + i * 10));
  // East of the square, past its groves: a quieter grid of low blocks.
  const east: HouseRow[] = [5.8, 13.2, 20.6, 28].map((zFront) => ({
    zFront,
    facing: 'z+',
    depth: [3, 4.6],
    height: [3, 7.5],
    from: W + 14.5,
  }));
  east.forEach((row, i) => houseRow(bin, row, W + CITY_EAST, hills, 451 + i * 10));
  // South, beyond the groves: a lane of cottages facing the district.
  houseRow(bin, { zFront: H + 21.5, facing: 'z-', depth: [3, 4], height: [2.4, 4.2], from: -22 }, W + 22, hills, 551);
}

/** Houses from the row's start toward `to` (either direction), skipping the hills. */
function houseRow(bin: GeometryBin, row: HouseRow, to: number, hills: readonly Hill[], channel: number): void {
  const step = Math.sign(to - row.from);
  let seed = 1;
  let x = row.from;
  for (;;) {
    const w = 3 + hash01(seed, 1, channel) * 2.6;
    const d = row.depth[0] + hash01(seed, 2, channel) * (row.depth[1] - row.depth[0]);
    const xa = step > 0 ? x : x - w;
    const xb = xa + w;
    if (step > 0 ? xb > to : xa < to) break;
    const [za, zb] = row.facing === 'z+' ? [row.zFront - d, row.zFront] : [row.zFront, row.zFront + d];
    if (!onHill(hills, xa, za, xb, zb)) house(bin, row, xa, w, za, zb, seed, channel);
    x += step * (w + 0.8 + hash01(seed, 6, channel) * 1.4);
    seed++;
  }
}

/** Roof tones for houses: the backdrop's weathered roof, some warmed toward terracotta. */
function roofTone(seed: number): Color {
  const warm = hash01(seed, 0, 601) < 0.45;
  const base = warm ? mixColor(PALETTE.backdropRoof, PALETTE.barrierRed, 0.35) : mixColor(PALETTE.backdropRoof, PALETTE.backdropWindowDark, 0.3);
  return jitterColor(shade(base, 0.05), hash01(seed, 1, 601), 0.04);
}

/** The wall-coloured triangle closing a gable's end, facing out along x. */
function gableEnd(x: number, za: number, zb: number, h: number, top: number, outward: -1 | 1): BufferGeometry {
  const zm = (za + zb) / 2;
  const a = [x, h, za];
  const b = [x, h, zb];
  const c = [x, top, zm];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(outward < 0 ? [...a, ...b, ...c] : [...a, ...c, ...b], 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A house: walls, a gable (ridge along x) or a flat roof, windows and a door on its street face. */
function house(
  bin: GeometryBin,
  row: HouseRow,
  x: number,
  w: number,
  za: number,
  zb: number,
  seed: number,
  channel: number,
): void {
  const h = row.height[0] + hash01(seed, 3, channel) * (row.height[1] - row.height[0]);
  const wall = jitterColor(pick(PALETTE.backdrop, hash01(seed, 4, channel)), hash01(seed, 5, channel), 0.03);
  bin.add('far', boxGeometry(x, 0, za, x + w, h, zb), aoPaint(wall, 0.08));
  if (hash01(seed, 7, channel) < 0.68) {
    const zm = (za + zb) / 2;
    const rise = 0.9 + hash01(seed, 8, channel) * 0.7;
    const roof = roofTone(seed * 7 + channel);
    bin.add('far', prismX([[za - 0.18, h], [zb + 0.18, h], [zm, h + rise]], x, x + w), roof);
    // Its ends in the walls' colour, just proud of the roof's own end caps.
    bin.add('far', gableEnd(x - 0.02, za, zb, h, h + rise, -1), wall);
    bin.add('far', gableEnd(x + w + 0.02, za, zb, h, h + rise, 1), wall);
    if (hash01(seed, 9, channel) < 0.4) {
      const cx = x + w * (0.2 + hash01(seed, 10, channel) * 0.6);
      bin.add('far', boxGeometry(cx - 0.2, h + rise * 0.3, zm - 0.2, cx + 0.2, h + rise + 0.35, zm + 0.2), shade(wall, -0.18));
    }
  } else {
    bin.add('far', boxGeometry(x - 0.04, h, za - 0.04, x + w + 0.04, h + 0.16, zb + 0.04), shade(wall, -0.12));
  }
  const face: Face = row.facing === 'z+' ? { normal: 'z+', plane: zb } : { normal: 'z-', plane: za };
  const cols = Math.max(1, Math.floor((w - 0.4) / 1.1));
  const storeys = Math.max(1, Math.floor((h - 0.5) / 1.35));
  const door = Math.floor(hash01(seed, 11, channel) * cols);
  for (let s = 0; s < storeys; s++) {
    for (let c = 0; c < cols; c++) {
      const u = x + 0.2 + (c + 0.5) * ((w - 0.4) / cols);
      if (s === 0 && c === door) {
        bin.add('far', faceQuad(face, u - 0.24, 0, u + 0.24, 1.05, 0.01), shade(wall, -0.32));
        continue;
      }
      const v = 0.85 + s * 1.35;
      const lit = hash01(seed, s * 17 + c, channel + 2) < 0.3;
      bin.add(
        lit ? 'far-lit' : 'far',
        faceQuad(face, u - 0.21, v, u + 0.21, v + 0.6, 0.01),
        lit ? jitterColor(PALETTE.backdropWindow, hash01(seed, s * 17 + c, channel + 3), 0.06) : PALETTE.backdropWindowDark,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** A tree the street's groves add: where it stands, the ground height there, and its look's seed. */
export interface BackdropTree {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly seed: number;
}

/**
 * Parks: trees on the hills the city runs round, and in the low-rise
 * streets' back gardens. Only on the hills a camera makes out: those behind
 * the city stand deep in the fog, and those south of the map behind every
 * frame.
 */
export function backdropTrees(map: DistrictMap): BackdropTree[] {
  const W = map.width;
  const hills = hillSpots(W, map.height);
  const { back } = cityPlan(W);
  const trees: BackdropTree[] = [];
  let seed = 10_000;
  for (const hill of hills) {
    if (hill.z > map.height || hill.z < back) continue;
    for (let k = 0; k < 9; k++) {
      seed++;
      if (hash01(seed, 0, 701) < 0.3) continue;
      const angle = (k / 9) * Math.PI * 2 + hash01(seed, 1, 701) * 0.5;
      const reach = hill.radius * (0.25 + hash01(seed, 2, 701) * 0.5);
      const x = hill.x + Math.cos(angle) * reach;
      const z = hill.z + Math.sin(angle) * reach;
      // Below the smooth dome, so a trunk never floats over a facet.
      trees.push({ x, y: hillHeightAt([hill], x, z) * 0.8, z, seed });
    }
  }
  const road = westRoad(map);
  // Down the middle of each strip of back gardens: [z, from x, to x].
  const gardens: Array<readonly [number, number, number]> = [
    ...(road ? ([[road.top - 6.4, -CITY_WEST, -15], [road.bottom + 6.5, -CITY_WEST, -15]] as const) : []),
    ...[7.2, 14.6, 22, 29.6].map((z) => [z, W + 15, W + CITY_EAST] as const),
  ];
  for (const [z, from, to] of gardens) {
    for (let x = from; x < to; x += 5.5) {
      seed++;
      if (hash01(seed, 0, 702) < 0.5) continue;
      const tx = x + hash01(seed, 1, 702) * 3;
      const tz = z + (hash01(seed, 2, 702) - 0.5) * 0.8;
      if (hillHeightAt(hills, tx, tz) > 0.3) continue;
      trees.push({ x: tx, y: 0, z: tz, seed });
    }
  }
  return trees;
}
