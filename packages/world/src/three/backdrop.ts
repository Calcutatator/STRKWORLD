import type { Color, ColorRepresentation } from 'three';
import { STREET_ORIGIN_X } from '@strkworld/shared';
import { westRoadColumn, type DistrictMap } from '../map/street.js';
import {
  PALETTE,
  aoPaint,
  boxGeometry,
  clamp01,
  coneGeometry,
  cylinderGeometry,
  faceQuad,
  flatQuad,
  hash01,
  jitterColor,
  mixColor,
  pick,
  shade,
  sphereGeometry,
  valueNoise,
  type Face,
  type GeometryBin,
} from './palette.js';

/**
 * The town and country around the district (D-059): everything a camera sees
 * past the map's edges before the fog.
 *
 * The town carries on behind the protocol street in the near rows' own
 * architecture and pastels, on a grid of streets aligned with the district's.
 * First come the two near rows, as they always were; then a street and a row
 * of mid-rise blocks, with a park and a square; then low houses with gardens,
 * fewer the further out they stand; then fields, hedgerows, tree lines and
 * gentle hills before the fog. West past the barrier, east past the square and
 * south past the groves the houses thin into the same green. Nothing stands on
 * a map tile and nothing rises above the near rows, so the Exchange tower stays
 * the district's one tall building.
 *
 * The town is laid out from the street, not from the map's edge: when the
 * football pitch square widened the map west (D-078), everything the street
 * sees kept its place beside the street (`STREET_ORIGIN_X`), and the town and
 * the near rows run on west behind the square. The road that the square
 * interrupts runs on west past it, closed by the barrier, with the houses that
 * lined it, and the country past the map's edges stays relative to them.
 *
 * The rooftop camera looks steeply down from 36 up, where the fog never
 * reaches, so the ground runs on past its whole frame, a wide window's included
 * (street-builder.test.ts pins it). Buildings go into the street's 'far' and
 * 'far-lit' bins, the ground into its ground bins and the trees into its
 * groves, so none of it costs a draw call. Every choice is a seeded hash.
 */

/**
 * How far the ground runs past the map's north, west and east edges: past the
 * rooftop frame of a 32:9 window, and past the fog seen from the tallest
 * sandbox stack, whose frame reaches furthest.
 */
export const HINTERLAND = 120;

/** How far street-builder's own detailed ground runs past the map's west, east and south edges. */
export const OUTSKIRT = 40;

/** Where the backdrop's ground starts to the north; the hedge's lawn runs from here to the map. */
export const CITY_FRONT = -3;

// ---------------------------------------------------------------------------
// Layout: one plan the ground, the buildings and the trees all read
// ---------------------------------------------------------------------------

/** Far streets sit on whole tiles like the district's: a 2-wide carriageway between 1-wide pavements. */
const WALK = 1;
const LANE = 2;
const STREET = 2 * WALK + LANE;

/** The east-west streets behind the near rows, by their south edges. */
const STREET_SOUTH = [-15, -27, -39] as const;

/** The mid-rise row, between the first street's north pavement and the second street. */
const MID_SOUTH = STREET_SOUTH[0] - STREET;
const MID_NORTH = STREET_SOUTH[1];
/** Its blocks stand this deep from their street faces; back gardens fill the rest. */
const MID_FRONTAGE = 6;

/** North-south streets: one every `PITCH` along x, the first on the gap between the west lot (the Bridge, D-110) and the Exchange. */
const PITCH = 18;
const CROSS_ORIGIN = STREET_ORIGIN_X + 9;
/** They run from the first street to the last. */
const CORRIDOR_SOUTH = STREET_SOUTH[0];
const CORRIDOR_NORTH = STREET_SOUTH[2] - STREET;
/** Their carriageways join those of the streets they meet, so these rows of pavement give way to road. */
const CROSS_LANE_SOUTH = STREET_SOUTH[0] - WALK;
const CROSS_LANE_NORTH = STREET_SOUTH[2] - STREET + WALK;

/**
 * How far past the map the street grid reaches, and the mid-rise town within
 * it. The grid's last row of houses backs onto the country at `GRID_NORTH`.
 */
const GRID_REACH = 45;
const TOWN_REACH = 23;
const GRID_NORTH = -51;

/** Houses thin from every lot to none between these distances from the map. */
const HOUSES_FULL = 26;
const HOUSES_NONE = 52;

/** Hedgerows stop, and tree lines a little sooner, where every camera's fog is whole. */
const HEDGE_REACH = 75;
const TREE_LINE_REACH = 62;

/**
 * Ground codes: a surface times `TONE`, plus a tone within it that merges only
 * with its like (a field's parcel, a lawn's patch, a pavement's flags).
 */
const ROAD = 1;
const PAVEMENT = 2;
const YARD = 3;
const LAWN = 4;
const FIELD = 5;
const TONE = 1_000_000;

export type Surface = 'road' | 'pavement' | 'yard' | 'lawn' | 'field';
const SURFACES: readonly Surface[] = ['road', 'pavement', 'yard', 'lawn', 'field'];

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

/** The street grid's extent, and which of its blocks are the mid-rise town. */
interface Grid {
  readonly x0: number;
  readonly x1: number;
  readonly kFirst: number;
  readonly kLast: number;
  readonly townFirst: number;
  readonly townLast: number;
}

/** Block `b` lies between cross streets `b` and `b + 1`. */
const blockWest = (b: number): number => CROSS_ORIGIN + PITCH * b + STREET;
const blockEast = (b: number): number => CROSS_ORIGIN + PITCH * (b + 1);

function streetGrid(width: number): Grid {
  const kFirst = Math.ceil((-GRID_REACH - CROSS_ORIGIN) / PITCH);
  const kLast = Math.floor((width + GRID_REACH - CROSS_ORIGIN - STREET) / PITCH);
  return {
    x0: CROSS_ORIGIN + PITCH * kFirst,
    x1: CROSS_ORIGIN + PITCH * kLast + STREET,
    kFirst,
    kLast,
    townFirst: Math.ceil((-TOWN_REACH - CROSS_ORIGIN - STREET) / PITCH),
    townLast: Math.floor((width + TOWN_REACH - CROSS_ORIGIN) / PITCH) - 1,
  };
}

/** Every third town block is open ground: a park, and the next such one a square. */
function openSpace(b: number): 'park' | 'square' | null {
  if (b % 3 !== 0) return null;
  return Math.floor(b / 3) % 2 === 0 ? 'park' : 'square';
}

interface Layout {
  readonly width: number;
  readonly height: number;
  readonly grid: Grid;
  /** The near rows stand on a yard from the town's west edge to here. */
  readonly yardEast: number;
  /** Field parcels: column edges along x, and each column's edges along z. */
  readonly columns: readonly number[];
  readonly parcels: readonly (readonly number[])[];
  /** The street's surface where it runs off each map edge, by map row (0 where it does not). */
  readonly westRoad: readonly number[];
  readonly eastRoad: readonly number[];
}

/** Distance from a point to the map. */
function mapReach(width: number, height: number, x: number, z: number): number {
  return Math.hypot(Math.max(0, -x, x - width), Math.max(0, -z, z - height));
}

function crossLane(g: Grid, x: number): boolean {
  const k = Math.floor((x - CROSS_ORIGIN) / PITCH);
  const o = x - (CROSS_ORIGIN + PITCH * k);
  return k >= g.kFirst && k <= g.kLast && o >= WALK && o < WALK + LANE;
}

const lawnPatch = (x: number, z: number): number =>
  LAWN * TONE + (Math.floor(x / 6) + 100) * 100 + Math.floor(z / 6) + 50;
const flags = (v: number): number => Math.floor(v / 4) + 500;

function parcelAt(l: Layout, x: number, z: number): number {
  let i = 0;
  while (i + 2 < l.columns.length && x >= l.columns[i + 1]!) i++;
  const edges = l.parcels[i]!;
  let j = 0;
  while (j + 2 < edges.length && z >= edges[j + 1]!) j++;
  return i * 100 + j;
}

/** The ground code at (x, z); 0 where street-builder lays the ground itself, or beyond it all. */
function groundCode(l: Layout, x: number, z: number): number {
  const W = l.width;
  const H = l.height;
  if (x < -HINTERLAND || x >= W + HINTERLAND || z < -HINTERLAND || z >= H + OUTSKIRT) return 0;
  if (z >= CITY_FRONT && x >= -OUTSKIRT && x < W + OUTSKIRT) return 0;
  const g = l.grid;
  if (z < CITY_FRONT && z >= GRID_NORTH && x >= g.x0 && x < g.x1) return gridCode(l, x, z);
  if (z >= 0 && z < H) {
    const road = (x < 0 ? l.westRoad : l.eastRoad)[Math.floor(z)] ?? 0;
    if (road === ROAD) return ROAD * TONE;
    if (road === PAVEMENT) return PAVEMENT * TONE + flags(x);
  }
  return FIELD * TONE + parcelAt(l, x, z);
}

function gridCode(l: Layout, x: number, z: number): number {
  const g = l.grid;
  for (const south of STREET_SOUTH) {
    const north = south - STREET;
    if (z < north || z >= south) continue;
    const o = z - north;
    if (o >= WALK && o < WALK + LANE) return ROAD * TONE;
    if (crossLane(g, x) && z >= CROSS_LANE_NORTH && z < CROSS_LANE_SOUTH) return ROAD * TONE;
    return PAVEMENT * TONE + flags(x);
  }
  if (z >= CORRIDOR_NORTH && z < CORRIDOR_SOUTH) {
    const k = Math.floor((x - CROSS_ORIGIN) / PITCH);
    const o = x - (CROSS_ORIGIN + PITCH * k);
    if (k >= g.kFirst && k <= g.kLast && o < STREET) {
      return o >= WALK && o < WALK + LANE ? ROAD * TONE : PAVEMENT * TONE + flags(z);
    }
  }
  if (z >= CORRIDOR_SOUTH) return x >= blockWest(g.townFirst) && x < l.yardEast ? YARD * TONE : lawnPatch(x, z);
  if (z >= MID_NORTH) {
    const b = Math.floor((x - CROSS_ORIGIN - STREET) / PITCH);
    if (b < g.townFirst || b > g.townLast) return lawnPatch(x, z);
    const open = openSpace(b);
    if (open === 'square') return YARD * TONE;
    if (open === 'park') {
      // A lawn crossed by two paths.
      const cx = (blockWest(b) + blockEast(b)) / 2;
      const cz = (MID_NORTH + MID_SOUTH) / 2;
      return Math.abs(x - cx) < 1 || Math.abs(z - cz) < 1 ? YARD * TONE : lawnPatch(x, z);
    }
    return z >= MID_SOUTH - MID_FRONTAGE ? YARD * TONE : lawnPatch(x, z);
  }
  return lawnPatch(x, z);
}

/** The backdrop's surface at a point: null where the street's own ground lies, or past the backdrop. */
export function backdropSurface(map: DistrictMap, x: number, z: number): Surface | null {
  const code = groundCode(planFor(map).layout, x, z);
  return code === 0 ? null : SURFACES[Math.floor(code / TONE) - 1] ?? null;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface NearBlock {
  readonly row: BackdropRow;
  readonly x: number;
  readonly w: number;
  readonly seed: number;
  readonly channel: number;
}

/** A backdrop building: every one is a near-row block, from mid-rise down to a one-storey house. */
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
  /** On the roof: the near rows' water tank, or a house's chimney stack. */
  readonly kit: 'tank' | 'chimney';
}

/** A tree the street's groves add: where it stands, the ground height there, and its look's seed. */
export interface BackdropTree {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly seed: number;
}

interface Rect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

interface GroundRect extends Rect {
  readonly code: number;
}

/**
 * A run of tile edges along one axis, at a line `at` across it: a kerb, or a
 * hedgerow. `side` is what the finder reported, such as +1 when the pavement
 * (or the field) lies toward +z (or +x) and -1 the other way.
 */
interface Edge {
  readonly axis: 'x' | 'z';
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly side: number;
}

interface Hedge extends Rect {
  readonly h: number;
  readonly seed: number;
}

/** A low dome of land: a hemisphere of `radius`, squashed to `scaleY`. */
interface Hill {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly scaleY: number;
}

interface Plan {
  readonly layout: Layout;
  readonly near: readonly NearBlock[];
  readonly ground: readonly GroundRect[];
  readonly kerbs: readonly Edge[];
  readonly dashes: readonly Rect[];
  readonly hedges: readonly Hedge[];
  readonly buildings: readonly BlockSpec[];
  readonly trees: readonly BackdropTree[];
  readonly hills: readonly Hill[];
}

/** One plan per map: the ground, the buildings and the trees are built from it in turn. */
const plans = new WeakMap<DistrictMap, Plan>();

function planFor(map: DistrictMap): Plan {
  let plan = plans.get(map);
  if (!plan) {
    plan = makePlan(map);
    plans.set(map, plan);
  }
  return plan;
}

function makePlan(map: DistrictMap): Plan {
  const W = map.width;
  const H = map.height;
  const grid = streetGrid(W);
  const near = nearBlocks(W, blockWest(grid.townFirst));
  const layout: Layout = {
    width: W,
    height: H,
    grid,
    yardEast: Math.ceil(near.east) + 1,
    ...fieldParcels(W, H),
    // The road runs on west past the map's edge, or past the pitch square (D-078).
    westRoad: roadRows(map, westRoadColumn(map)),
    eastRoad: roadRows(map, W - 1),
  };
  const cells = raster(layout);
  const hills = hillSpots(W, H);
  const trees: BackdropTree[] = [];
  const seeds = { next: 20_000 };
  const buildings = [...midRise(grid), ...houses(map, layout, hills, trees, seeds)];
  const hedges = hedgerows(layout, cells, trees, seeds);
  streetTrees(map, grid, trees, seeds);
  openSpaceTrees(grid, trees, seeds);
  hillTrees(W, H, hills, trees, seeds);
  return {
    layout,
    near: near.blocks,
    ground: mergeCells(cells),
    kerbs: kerbEdges(cells),
    dashes: centreLines(grid),
    hedges,
    buildings,
    trees,
    hills,
  };
}

/** The near rows' blocks: their original run, then on west to the town's edge in the same style. */
function nearBlocks(width: number, west: number): { blocks: NearBlock[]; east: number } {
  const blocks: NearBlock[] = [];
  const starts: number[] = [];
  let east = -Infinity;
  let seed = 1;
  for (const row of NEAR_ROWS) {
    // Their original run starts where it always did beside the street (D-078).
    const start = STREET_ORIGIN_X - 18 + hash01(seed, 0, 41) * 2;
    starts.push(start);
    let x = start;
    while (x < width + 18) {
      const w = 2.6 + hash01(seed, 1, 41) * 3.6;
      blocks.push({ row, x, w, seed, channel: 41 });
      east = Math.max(east, x + w);
      x += w + 0.5 + hash01(seed, 6, 41) * 1.6;
      seed++;
    }
  }
  NEAR_ROWS.forEach((row, i) => {
    const channel = 141 + i * 10;
    let x = starts[i]!;
    for (let s = 1; ; s++) {
      x -= 0.5 + hash01(s, 6, channel) * 1.6;
      const w = 2.6 + hash01(s, 1, channel) * 3.6;
      if (x - w < west) break;
      blocks.push({ row, x: x - w, w, seed: s, channel });
      x -= w;
    }
  });
  return { blocks, east };
}

/** Fields in parcels of 14 to 23 by 10 to 17, on whole tiles. */
function fieldParcels(width: number, height: number): Pick<Layout, 'columns' | 'parcels'> {
  const columns = [-HINTERLAND];
  for (let i = 0; columns[i]! < width + HINTERLAND; i++) {
    columns.push(Math.min(width + HINTERLAND, columns[i]! + 14 + Math.floor(hash01(i, 0, 801) * 10)));
  }
  const parcels = columns.slice(0, -1).map((_, i) => {
    const edges = [-HINTERLAND];
    for (let j = 0; edges[j]! < height + OUTSKIRT; j++) {
      edges.push(Math.min(height + OUTSKIRT, edges[j]! + 10 + Math.floor(hash01(i, j, 802) * 8)));
    }
    return edges;
  });
  return { columns, parcels };
}

/** The street's surface where it runs off one map edge, by row, read from the tiles like its barrier. */
function roadRows(map: DistrictMap, edgeX: number): number[] {
  return map.tiles.map((row) => (edgeX < 0 ? 0 : row[edgeX] === 'road' ? ROAD : row[edgeX] === 'pavement' ? PAVEMENT : 0));
}

// ---------------------------------------------------------------------------
// Ground: one code per tile, merged into rectangles; kerbs and centre lines
// ---------------------------------------------------------------------------

interface Cells {
  readonly x0: number;
  readonly z0: number;
  readonly cols: number;
  readonly rows: number;
  readonly codes: Int32Array;
}

function raster(l: Layout): Cells {
  const x0 = -HINTERLAND;
  const z0 = -HINTERLAND;
  const cols = l.width + 2 * HINTERLAND;
  const rows = HINTERLAND + l.height + OUTSKIRT;
  const codes = new Int32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) codes[r * cols + c] = groundCode(l, x0 + c + 0.5, z0 + r + 0.5);
  }
  return { x0, z0, cols, rows, codes };
}

/** Runs of like tiles along x, grown down through the rows that repeat them exactly. */
function mergeCells(cells: Cells): GroundRect[] {
  const { x0, z0, cols, rows, codes } = cells;
  const rects: { x0: number; z0: number; x1: number; z1: number; code: number }[] = [];
  let open = new Map<string, (typeof rects)[number]>();
  for (let r = 0; r < rows; r++) {
    const next = new Map<string, (typeof rects)[number]>();
    for (let c = 0; c < cols; ) {
      const code = codes[r * cols + c]!;
      let e = c + 1;
      while (e < cols && codes[r * cols + e] === code) e++;
      if (code !== 0) {
        const key = `${c}:${e}:${code}`;
        const grown = open.get(key);
        if (grown) {
          grown.z1 += 1;
          next.set(key, grown);
        } else {
          const rect = { x0: x0 + c, z0: z0 + r, x1: x0 + e, z1: z0 + r + 1, code };
          rects.push(rect);
          next.set(key, rect);
        }
      }
      c = e;
    }
    open = next;
  }
  return rects;
}

/**
 * Runs along one axis where `test` finds an edge between neighbouring tiles.
 * `test(a, b)` sees the tile before the edge and the one after, and returns
 * the run's side (+1 or -1), or 0 for no edge.
 */
function edgeRuns(cells: Cells, axis: 'x' | 'z', test: (a: number, b: number) => number): Edge[] {
  const { x0, z0, cols, rows, codes } = cells;
  const edges: Edge[] = [];
  const lines = axis === 'x' ? rows : cols;
  const length = axis === 'x' ? cols : rows;
  const cell = (line: number, i: number): number =>
    axis === 'x' ? codes[line * cols + i]! : codes[i * cols + line]!;
  for (let line = 1; line < lines; line++) {
    let side = 0;
    let from = 0;
    for (let i = 0; i <= length; i++) {
      const s = i < length ? test(cell(line - 1, i), cell(line, i)) : 0;
      if (s === side) continue;
      if (side !== 0) {
        const at = (axis === 'x' ? z0 : x0) + line;
        const base = axis === 'x' ? x0 : z0;
        edges.push({ axis, at, from: base + from, to: base + i, side });
      }
      side = s;
      from = i;
    }
  }
  return edges;
}

const kindOf = (code: number): number => Math.floor(code / TONE);

/** Kerbs wherever a pavement meets anything else of the backdrop's. */
function kerbEdges(cells: Cells): Edge[] {
  const test = (a: number, b: number): number => {
    const [ka, kb] = [kindOf(a), kindOf(b)];
    if (ka === 0 || kb === 0 || (ka === PAVEMENT) === (kb === PAVEMENT)) return 0;
    return kb === PAVEMENT ? 1 : -1;
  };
  return [...edgeRuns(cells, 'x', test), ...edgeRuns(cells, 'z', test)];
}

/** Dashed centre lines, broken at the junctions, in the main road's centre-line paint. */
function centreLines(g: Grid): Rect[] {
  const dashes: Rect[] = [];
  const nearCross = (a: number, b: number): boolean => {
    for (let k = g.kFirst; k <= g.kLast; k++) {
      const c = CROSS_ORIGIN + PITCH * k;
      if (b > c - 0.4 && a < c + STREET + 0.4) return true;
    }
    return false;
  };
  for (const south of STREET_SOUTH) {
    const zc = south - WALK - LANE / 2;
    for (let x = g.x0 + 1; x + 1 <= g.x1 - 1; x += 2) {
      if (!nearCross(x, x + 1)) dashes.push({ x0: x, z0: zc - 0.05, x1: x + 1, z1: zc + 0.05 });
    }
  }
  for (let k = g.kFirst; k <= g.kLast; k++) {
    const xc = CROSS_ORIGIN + PITCH * k + WALK + LANE / 2;
    for (let z = CORRIDOR_NORTH + 1; z + 1 <= CORRIDOR_SOUTH - 1; z += 2) {
      if (STREET_SOUTH.some((south) => z < south + 0.4 && z + 1 > south - STREET - 0.4)) continue;
      dashes.push({ x0: xc - 0.05, z0: z, x1: xc + 0.05, z1: z + 1 });
    }
  }
  return dashes;
}

/** An edge-finder's report for a hedge between two parcels, which sits on the line. */
const BETWEEN_FIELDS = 2;

/** Hedgerows between parcels, and where the fields meet the town, the road or the street's own ground. */
function hedgerows(l: Layout, cells: Cells, trees: BackdropTree[], seeds: { next: number }): Hedge[] {
  const side = (vertical: boolean) => (a: number, b: number): number => {
    const [ka, kb] = [kindOf(a), kindOf(b)];
    if (ka === FIELD && kb === FIELD) return a === b ? 0 : BETWEEN_FIELDS;
    const other = ka === FIELD ? kb : kb === FIELD ? ka : -1;
    const edge = other === LAWN || other === YARD || other === PAVEMENT || (vertical && other === 0);
    // The side the field lies on, so the hedge grows on it.
    return edge ? (kb === FIELD ? 1 : -1) : 0;
  };
  const runs = [...edgeRuns(cells, 'x', side(false)), ...edgeRuns(cells, 'z', side(true))];
  const hedges: Hedge[] = [];
  for (const run of runs) {
    const mid = (run.from + run.to) / 2;
    const [mx, mz] = run.axis === 'x' ? [mid, run.at] : [run.at, mid];
    const reach = mapReach(l.width, l.height, mx, mz);
    const key = Math.round(run.at * 7 + run.from * 3);
    if (reach > HEDGE_REACH || hash01(key, 0, 851) > 0.72) continue;
    // Between two fields a hedge sits on the line; against anything else, on the field's side.
    const offset = run.side === BETWEEN_FIELDS ? 0 : run.side * 0.35;
    const lineAt = run.at + offset;
    let a = run.from + 0.3;
    for (let n = 0; a < run.to - 0.3; n++) {
      const b = Math.min(run.to - 0.3, a + 7 + hash01(key, n + 1, 852) * 6);
      if (b - a > 1) {
        const rect =
          run.axis === 'x'
            ? { x0: a, z0: lineAt - 0.25, x1: b, z1: lineAt + 0.25 }
            : { x0: lineAt - 0.25, z0: a, x1: lineAt + 0.25, z1: b };
        hedges.push({ ...rect, h: 0.75 + hash01(key, n, 853) * 0.3, seed: key * 31 + n });
      }
      a = b + 1.2;
    }
    if (reach > TREE_LINE_REACH || hash01(key, 1, 851) > 0.3) continue;
    // A tree line along it.
    for (let t = run.from + 2 + hash01(key, 2, 851) * 3; t < run.to - 1; t += 4.5 + hash01(key, Math.round(t), 854) * 2) {
      const shift = lineAt + (hash01(key, Math.round(t), 855) < 0.5 ? -0.9 : 0.9);
      const [x, z] = run.axis === 'x' ? [t, shift] : [shift, t];
      if (kindOf(groundCode(l, x, z)) !== FIELD) continue;
      trees.push({ x, y: 0, z, seed: seeds.next++ });
    }
  }
  return hedges;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/** The near rows' pastels, in an order where each sits beside its nearest. */
const TOWN_TONES: readonly number[] = [5, 0, 1, 3, 2, 4].map((i) => PALETTE.backdrop[i]!);

/** A block's tone: drifts slowly across the grid, so neighbouring blocks stay close. */
function blockTone(bx: number, bz: number): number {
  return valueNoise(bx * 0.43 + 5.3, bz * 0.61 + 1.7, 23) * TOWN_TONES.length;
}

/** One building's colour in a block of that tone: one of its two nearest pastels, lightly varied. */
function townColour(tone: number, seed: number): Color {
  const n = TOWN_TONES.length;
  const i = Math.floor(tone);
  const index = hash01(seed, 0, 811) < tone - i ? i + 1 : i;
  return jitterColor(TOWN_TONES[((index % n) + n) % n]!, hash01(seed, 1, 811), 0.03);
}

/** The mid-rise row: near-row blocks shoulder to shoulder along each town block's street face. */
function midRise(g: Grid): BlockSpec[] {
  const blocks: BlockSpec[] = [];
  for (let b = g.townFirst; b <= g.townLast; b++) {
    if (openSpace(b)) continue;
    const tone = blockTone(b, 1);
    const east = blockEast(b) - 0.3;
    let x = blockWest(b) + 0.3 + hash01(b, 0, 821) * 0.5;
    for (let s = 1; x < east - 2.6; s++) {
      const seed = (b + 50) * 100 + s;
      // The last building takes what is left of the frontage, so the block reads whole.
      let w = 2.6 + hash01(seed, 1, 831) * 3.6;
      if (east - (x + w) < 2.6) w = east - x;
      const tall = hash01(seed, 9, 831) < 0.12;
      blocks.push({
        x,
        w,
        d: 4 + hash01(seed, 2, 831) * 2,
        h: tall ? 9 + hash01(seed, 3, 831) * 2.5 : 4.5 + hash01(seed, 3, 831) * 4.5,
        zFront: MID_SOUTH,
        colour: townColour(tone, seed),
        seed,
        channel: 831,
        kit: 'tank',
      });
      x += w + 0.4 + hash01(seed, 6, 831) * 0.9;
    }
  }
  return blocks;
}

/** A row of lots, each maybe a house with a garden; `back` rows are placed by their north faces. */
interface LotRow {
  readonly z: number;
  readonly back?: boolean;
  readonly from: number;
  readonly to: number;
  /** Split exactly into this many lots (a street block), rather than walked in lots of 5.6 to 7.2. */
  readonly lots?: number;
  readonly tone: number;
}

function houses(map: DistrictMap, l: Layout, hills: readonly Hill[], trees: BackdropTree[], seeds: { next: number }): BlockSpec[] {
  const W = map.width;
  const H = map.height;
  const g = l.grid;
  const rows: LotRow[] = [];
  const setback = 1.2;
  // The grid's suburbs: behind the mid-rise row, and its blocks beyond the town.
  for (let b = g.kFirst; b < g.kLast; b++) {
    const lot = { from: blockWest(b) + 0.4, to: blockEast(b) - 0.4, lots: 2 };
    if (b < g.townFirst || b > g.townLast) rows.push({ ...lot, z: MID_SOUTH - setback, tone: blockTone(b, 1) });
    rows.push({ ...lot, z: STREET_SOUTH[1] - STREET - setback, tone: blockTone(b, 2) });
    rows.push({ ...lot, z: STREET_SOUTH[2] - STREET - setback, tone: blockTone(b, 3) });
  }
  // Beside the near rows, past the yard at each end.
  const yardWest = blockWest(g.townFirst);
  for (const z of [-3.6, -10]) {
    rows.push({ z, from: yardWest - 0.4, to: g.x0 + 0.4, tone: blockTone(-4, z) });
    rows.push({ z, from: l.yardEast + 0.4, to: g.x1 - 0.4, tone: blockTone(9, z) });
  }
  // West, either side of the road past its barrier and groves.
  const road = westBand(l);
  if (road) {
    rows.push({ z: road.top - 0.8, from: -14.5, to: -OUTSKIRT + 0.5, tone: blockTone(-2, 5) });
    rows.push({ z: road.top - 7.2, from: -18, to: -OUTSKIRT + 0.5, tone: blockTone(-3, 6) });
    rows.push({ z: road.bottom + 0.8, back: true, from: -14.5, to: -OUTSKIRT + 0.5, tone: blockTone(-2, 7) });
    rows.push({ z: road.bottom + 7.4, back: true, from: -16, to: -OUTSKIRT + 0.5, tone: blockTone(-3, 8) });
  }
  // East of the square, past its groves.
  [5.8, 13.2, 20.6, 28].forEach((z, i) => rows.push({ z, from: W + 14.5, to: W + OUTSKIRT - 0.5, tone: blockTone(7, 9 + i) }));
  // South, beyond the groves.
  rows.push({ z: H + 21.5, back: true, from: -22, to: W + 22, tone: blockTone(2, 14) });

  const built: BlockSpec[] = [];
  rows.forEach((row, i) => {
    const channel = 1001 + i * 20;
    const step = Math.sign(row.to - row.from);
    const span = Math.abs(row.to - row.from);
    let x = row.from;
    for (let s = 1; ; s++) {
      const lotW = row.lots ? span / row.lots : 5.6 + hash01(s, 0, channel) * 1.6;
      if (row.lots ? s > row.lots : lotW > Math.abs(row.to - x)) break;
      const [a, b] = step > 0 ? [x, x + lotW] : [x - lotW, x];
      x += step * lotW;
      const d = 3 + hash01(s, 4, channel) * 1.2;
      const zFront = row.back ? row.z + d : row.z;
      const reach = mapReach(W, H, (a + b) / 2, zFront - d / 2);
      const share = clamp01((HOUSES_NONE - reach) / (HOUSES_NONE - HOUSES_FULL));
      const w = Math.min(lotW - 1.4, 3 + hash01(s, 2, channel) * 1.6);
      const hx = a + 0.7 + hash01(s, 3, channel) * (lotW - 1.4 - w);
      if (hash01(s, 1, channel) < share && !onHill(hills, hx, zFront - d, hx + w, zFront)) {
        built.push({
          x: hx,
          w,
          d,
          h: 2.6 + hash01(s, 5, channel) * 1.8,
          zFront,
          colour: townColour(row.tone, channel * 7 + s),
          seed: s,
          channel: channel + 10,
          kit: 'chimney',
        });
        // A garden tree behind the house.
        if (hash01(s, 6, channel) < 0.45) {
          trees.push({ x: hx + w * (0.2 + hash01(s, 7, channel) * 0.6), y: 0, z: zFront - d - 1.3, seed: seeds.next++ });
        }
      } else if (hash01(s, 8, channel) < 0.45 && hillHeightAt(hills, (a + b) / 2, zFront - 2) < 0.3) {
        // An empty lot: a garden with a tree in it.
        trees.push({ x: a + lotW * (0.3 + hash01(s, 9, channel) * 0.4), y: 0, z: zFront - 1.6, seed: seeds.next++ });
      }
    }
  });
  return built;
}

/** The map rows the street's west end covers, road and pavements. */
function westBand(l: Layout): { top: number; bottom: number } | null {
  const rows = l.westRoad.flatMap((code, y) => (code ? [y] : []));
  return rows.length > 0 ? { top: rows[0]!, bottom: rows[rows.length - 1]! + 1 } : null;
}

/**
 * A backdrop building, in the near rows' style: a body darkened toward the
 * ground, a cornice, a water tank (on a house, a chimney stack) or a plant
 * room, and a grid of windows on its street face, some of them lit. The near
 * rows' own blocks come out exactly as they always did.
 */
function cityBlock(bin: GeometryBin, block: BlockSpec): void {
  const { x, w, d, h, colour, seed, channel } = block;
  const zb = block.zFront;
  const za = zb - d;
  bin.add('far', boxGeometry(x, 0, za, x + w, h, zb), aoPaint(colour, 0.08));
  bin.add('far', boxGeometry(x - 0.05, h, za - 0.05, x + w + 0.05, h + 0.18, zb + 0.05), shade(colour, -0.12));
  const roof = h + 0.18;
  if (hash01(seed, 5, channel) < 0.4) {
    const tx = x + w * (0.3 + hash01(seed, 7, channel) * 0.4);
    const tz = za + d * 0.4;
    if (block.kit === 'tank') {
      bin.add('far', cylinderGeometry(tx, roof, tz, 0.45, 0.45, 0.9, 8), 0x9a7d62);
      bin.add('far', coneGeometry(tx, roof + 0.9, tz, 0.55, 0.45, 8), 0x6f5a48);
    } else {
      bin.add('far', boxGeometry(tx - 0.18, roof, tz - 0.18, tx + 0.18, roof + 0.7, tz + 0.18), shade(colour, -0.2));
      bin.add('far', boxGeometry(tx - 0.22, roof + 0.7, tz - 0.22, tx + 0.22, roof + 0.8, tz + 0.22), 0x6f5a48);
    }
  } else if (hash01(seed, 8, channel) < 0.6) {
    bin.add('far', boxGeometry(x + w * 0.2, roof, za + 0.4, x + w * 0.45, roof + 0.52, za + 1.2), shade(colour, -0.06));
  }
  const face: Face = { normal: 'z+', plane: zb };
  const cols = Math.max(1, Math.floor((w - 0.6) / 0.85));
  const floors = Math.max(1, Math.floor((h - 1.2) / 1.05));
  for (let r = 0; r < floors; r++) {
    for (let c = 0; c < cols; c++) {
      const u = x + 0.3 + (c + 0.5) * ((w - 0.6) / cols);
      const v = 0.9 + r * 1.05;
      const lit = hash01(seed, r * 31 + c, channel + 2) < 0.32;
      bin.add(
        lit ? 'far-lit' : 'far',
        faceQuad(face, u - 0.2, v, u + 0.2, v + 0.55, 0.01),
        lit ? jitterColor(PALETTE.backdropWindow, hash01(seed, r * 31 + c, channel + 3), 0.06) : PALETTE.backdropWindowDark,
      );
    }
  }
}

function nearBlock(bin: GeometryBin, block: NearBlock): void {
  const { row, x, w, seed, channel } = block;
  cityBlock(bin, {
    x,
    w,
    d: row.depth[0] + hash01(seed, 2, channel) * (row.depth[1] - row.depth[0]),
    h: row.height[0] + hash01(seed, 3, channel) * (row.height[1] - row.height[0]),
    zFront: row.zFront,
    colour: pick(PALETTE.backdrop, hash01(seed, 4, channel)),
    seed,
    channel,
    kit: 'tank',
  });
}

/** The square's fountain: a stone basin and its water, round a pillar. */
function fountain(bin: GeometryBin, g: Grid): void {
  for (let b = g.townFirst; b <= g.townLast; b++) {
    if (openSpace(b) !== 'square') continue;
    const cx = (blockWest(b) + blockEast(b)) / 2;
    const cz = (MID_NORTH + MID_SOUTH) / 2;
    bin.add('far', cylinderGeometry(cx, 0, cz, 1.25, 1.35, 0.42, 12), PALETTE.pathStone);
    bin.add('far', cylinderGeometry(cx, 0.42, cz, 1.05, 1.05, 0.02, 12), shade(PALETTE.backdrop[2]!, 0.04, 0.08));
    bin.add('far', cylinderGeometry(cx, 0, cz, 0.18, 0.22, 1.1, 8), shade(PALETTE.pathStone, -0.04));
  }
}

/**
 * The town and country's buildings, fountain and hedgerows. The two near rows
 * keep their original run (the street's view of them is unchanged), and run on
 * west to the town's edge.
 */
export function backdropCity(map: DistrictMap, bin: GeometryBin): void {
  const plan = planFor(map);
  for (const block of plan.near) nearBlock(bin, block);
  for (const block of plan.buildings) cityBlock(bin, block);
  fountain(bin, plan.layout.grid);
  for (const hedge of plan.hedges) {
    const colour = jitterColor(hash01(hedge.seed, 0, 861) < 0.5 ? PALETTE.hedge : PALETTE.hedgeLight, hash01(hedge.seed, 1, 861), 0.03);
    bin.add('far', boxGeometry(hedge.x0, 0, hedge.z0, hedge.x1, hedge.h, hedge.z1), colour);
  }
}

// ---------------------------------------------------------------------------
// Hills
// ---------------------------------------------------------------------------

/** Gentle hills out in the fields: behind the town, west and east past the houses, and south. */
function hillSpots(width: number, height: number): readonly Hill[] {
  const W = width;
  const H = height;
  // Behind the town and south of the groves, placed along the street (D-078);
  // west and east, past the houses at the map's own edges.
  const X = STREET_ORIGIN_X;
  const spots: ReadonlyArray<readonly [number, number, number, number]> = [
    [X - 4, -74, 20, 0.26],
    [X + 56, -76, 22, 0.24],
    [W + 30, -72, 18, 0.26],
    [-68, -18, 13, 0.28],
    [-38, 38, 14, 0.28],
    [W + 60, 6, 14, 0.28],
    [W + 38, 36, 13, 0.3],
    [X + 8, H + 36, 16, 0.25],
    [X + 40, H + 40, 18, 0.25],
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
  planFor(map).hills.forEach(({ x, z, radius, scaleY }, i) => {
    bin.add(
      'far',
      sphereGeometry(x, 0, z, radius, { widthSegments: 9, heightSegments: 4, hemisphere: true, scaleY }),
      jitterColor(pick(PALETTE.hills, hash01(i, 1, 91)), hash01(i, 2, 91), 0.04),
    );
  });
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/** How street-builder lays its own ground, so the backdrop's matches it. */
export interface GroundStyle {
  readonly pavementHeight: number;
  readonly kerbHeight: number;
  readonly kerbWidth: number;
  /** The district's lawn colour at a point. */
  readonly lawn: (x: number, z: number, seed: number) => Color;
}

/** A parcel's crop: mostly pasture greens, some hay, some darker grazing. */
function fieldColour(parcel: number): Color {
  const crop = hash01(parcel, 0, 841);
  const base =
    crop < 0.16
      ? mixColor(PALETTE.grassWarm, PALETTE.pathStone, 0.42)
      : crop < 0.28
        ? shade(PALETTE.grassCool, -0.04)
        : mixColor(PALETTE.grassCool, PALETTE.grassWarm, hash01(parcel, 1, 841));
  return jitterColor(base, hash01(parcel, 2, 841), 0.025);
}

/**
 * The backdrop's ground, into the street's ground bins: the town's streets,
 * pavements and kerbs in the main road's colours with its centre-line paint,
 * yards, gardens and parks in the district's lawn, and the fields beyond. The
 * road runs on west through them as the street does.
 */
export function layHinterland(map: DistrictMap, bin: GeometryBin, style: GroundStyle): void {
  const plan = planFor(map);
  for (const rect of plan.ground) {
    const kind = kindOf(rect.code);
    const tone = rect.code % TONE;
    const seed = hash01(Math.round(rect.x0), Math.round(rect.z0), 19);
    const { x0, z0, x1, z1 } = rect;
    if (kind === ROAD) bin.add('road', flatQuad(x0, z0, x1, z1, 0), jitterColor(PALETTE.asphalt, seed, 0.012));
    else if (kind === PAVEMENT) {
      const flag = tone % 2 === 0 ? PALETTE.sidewalk : PALETTE.sidewalkAlt;
      bin.add('sidewalk', flatQuad(x0, z0, x1, z1, style.pavementHeight), jitterColor(flag, seed, 0.02));
    } else if (kind === YARD) bin.add('sidewalk', flatQuad(x0, z0, x1, z1, 0), jitterColor(PALETTE.apron, seed, 0.02));
    else if (kind === LAWN) bin.add('grass', flatQuad(x0, z0, x1, z1, 0), style.lawn((x0 + x1) / 2, (z0 + z1) / 2, seed));
    else bin.add('grass', flatQuad(x0, z0, x1, z1, 0), fieldColour(tone));
  }
  const k = style.kerbWidth;
  for (const edge of plan.kerbs) {
    const [a, b] = edge.side > 0 ? [edge.at, edge.at + k] : [edge.at - k, edge.at];
    const kerb =
      edge.axis === 'x'
        ? boxGeometry(edge.from, 0, a, edge.to, style.kerbHeight, b)
        : boxGeometry(a, 0, edge.from, b, style.kerbHeight, edge.to);
    bin.add('sidewalk', kerb, PALETTE.kerb);
  }
  // In the road's own bin: this far off, paint's sheen does not show, and the
  // street's markings stay the protocol street's own.
  for (const dash of plan.dashes) bin.add('road', flatQuad(dash.x0, dash.z0, dash.x1, dash.z1, 0.012), PALETTE.paintCentre);
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Street trees along the far streets' pavements, and down the road where it runs on west. */
function streetTrees(map: DistrictMap, g: Grid, trees: BackdropTree[], seeds: { next: number }): void {
  const inCross = (x: number): boolean => {
    const k = Math.floor((x - CROSS_ORIGIN) / PITCH);
    const o = x - (CROSS_ORIGIN + PITCH * k);
    return k >= g.kFirst && k <= g.kLast && o > -0.8 && o < STREET + 0.8;
  };
  STREET_SOUTH.forEach((south, i) => {
    // Both pavements of the first street, the north one of the others.
    const lines = i === 0 ? [south - 0.5, south - STREET + 0.5] : [south - STREET + 0.5];
    for (const z of lines) {
      for (let x = g.x0 + 2; x < g.x1 - 1; x += 6) {
        const seed = seeds.next++;
        const tx = x + (hash01(seed, 0, 871) - 0.5) * 1.2;
        if (inCross(tx) || hash01(seed, 1, 871) > 0.72) continue;
        trees.push({ x: tx, y: 0, z, seed });
      }
    }
  });
  for (let k = g.kFirst; k <= g.kLast; k++) {
    const x = CROSS_ORIGIN + PITCH * k + STREET - 0.5;
    for (let z = CORRIDOR_NORTH + 3; z < CORRIDOR_SOUTH - 1; z += 6) {
      const seed = seeds.next++;
      if (STREET_SOUTH.some((south) => z > south - STREET - 0.8 && z < south + 0.8)) continue;
      if (hash01(seed, 1, 872) > 0.6) continue;
      trees.push({ x, y: 0, z, seed });
    }
  }
  const column = westRoadColumn(map);
  const road = column < 0 ? [] : map.tiles.flatMap((row, y) => (row[column] === 'road' || row[column] === 'pavement' ? [y] : []));
  if (road.length === 0) return;
  // Past the lamps, down both pavements of the road running on west.
  for (const z of [road[0]! + 0.5, road[road.length - 1]! + 0.5]) {
    for (const x of [-26, -32, -38]) {
      const seed = seeds.next++;
      if (hash01(seed, 1, 873) < 0.85) trees.push({ x: x + (hash01(seed, 0, 873) - 0.5), y: 0, z, seed });
    }
  }
}

/** The park's trees round its paths, and the square's round its fountain. */
function openSpaceTrees(g: Grid, trees: BackdropTree[], seeds: { next: number }): void {
  const cz = (MID_NORTH + MID_SOUTH) / 2;
  for (let b = g.townFirst; b <= g.townLast; b++) {
    const open = openSpace(b);
    if (!open) {
      // A tree in most blocks' back gardens.
      const seed = seeds.next++;
      const x = blockWest(b) + 2 + hash01(seed, 0, 881) * (blockEast(b) - blockWest(b) - 4);
      if (hash01(seed, 1, 881) < 0.7) trees.push({ x, y: 0, z: MID_NORTH + 1, seed });
      continue;
    }
    const cx = (blockWest(b) + blockEast(b)) / 2;
    const spots: readonly (readonly [number, number])[] =
      open === 'park'
        ? [[-4.6, -2.3], [-2.2, -2.8], [2.4, -2.2], [4.8, -2.6], [-4.4, 2.4], [-2, 2.8], [2.2, 2.3], [4.6, 2.7]]
        : [[-4.8, -2.4], [4.8, -2.4], [-4.8, 2.4], [4.8, 2.4]];
    for (const [dx, dz] of spots) {
      const seed = seeds.next++;
      trees.push({ x: cx + dx + (hash01(seed, 0, 882) - 0.5) * 0.6, y: 0, z: cz + dz + (hash01(seed, 1, 882) - 0.5) * 0.4, seed });
    }
  }
}

/** A few trees on the hills a camera makes out: those out west and east past the houses. */
function hillTrees(width: number, height: number, hills: readonly Hill[], trees: BackdropTree[], seeds: { next: number }): void {
  for (const hill of hills) {
    if (hill.z > height || hill.z < -40 || mapReach(width, height, hill.x, hill.z) > HEDGE_REACH) continue;
    for (let k = 0; k < 8; k++) {
      const seed = seeds.next++;
      if (hash01(seed, 0, 891) < 0.3) continue;
      const angle = (k / 8) * Math.PI * 2 + hash01(seed, 1, 891) * 0.5;
      const reach = hill.radius * (0.25 + hash01(seed, 2, 891) * 0.5);
      const x = hill.x + Math.cos(angle) * reach;
      const z = hill.z + Math.sin(angle) * reach;
      // Below the smooth dome, so a trunk never floats over a facet.
      trees.push({ x, y: hillHeightAt([hill], x, z) * 0.8, z, seed });
    }
  }
}

/**
 * The trees the backdrop adds to the street's groves: along its streets, in
 * its park, square and gardens, in lines along its hedgerows and on its hills.
 */
export function backdropTrees(map: DistrictMap): readonly BackdropTree[] {
  return planFor(map).trees;
}
