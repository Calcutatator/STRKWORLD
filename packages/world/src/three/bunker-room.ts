import { Box3, Color, Group, Matrix4, Mesh, type BufferGeometry } from 'three';
import type { FixedRoomFixture, FixedRoomLevelMap, FixedRoomStationDefinition } from '../fixed-room.js';
import {
  GeometryBin,
  NETCAFE,
  NETCAFE_GAME_SIGN,
  NETCAFE_GAME_TEXT,
  NETCAFE_RECEPTION_SIGN,
  NETCAFE_RECEPTION_TEXT,
  NETCAFE_SIGN,
  NETCAFE_SIGN_TEXT,
  ResourceBag,
  beamGeometry,
  boxGeometry,
  clamp01,
  coneGeometry,
  cylinderGeometry,
  faceBox,
  faceDisc,
  faceQuad,
  faceToWorld,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  mixHex,
  shade,
  unlitMaterial,
  type Face,
  type Paint,
  type RoomTheme,
} from './palette.js';
import type { LabelFactory, TextLabel } from './types.js';

/**
 * The hidden room's furniture and dressing (D-107): a Tokyo net cafe, still
 * modern in its fittings and left years ago. Partitioned PC booths with their
 * chairs, monitors (some on, some dark, some cracked) and keyboards; the
 * reception desk with snack shelves and the drinks fridge; waist-high manga
 * shelves; and the out-of-order lift by the stair, the one thing that looks
 * new. Over it the abandonment: dust and stains on the carpet, a fallen
 * ceiling tile and one hanging by a wire, cables sagging from the trays,
 * chairs knocked over, posters peeling, one tube that will not stay lit.
 *
 * Everything stands on fixture or station tiles; over the walkable floor
 * there is only what lies flat (under 0.15) or hangs above head height (over
 * 1.9), the room rule (D-059). Booths and shelves draw on the floor's own
 * meshes (D-105's props: no draw call each), the wall dressing on the walls'
 * own; the flickering tube is the one thing with materials of its own. No
 * words but generic ones (ネットカフェ, ゲーム, 受付 24H and the lift's sign),
 * and none names the place.
 */

/** Which side of a booth is open to the floor; its desk stands against the other. */
type Open = 's' | 'n' | 'w' | 'e';

interface Frame {
  /** World (x, z) of a point `a` across the booth (0 left, facing the desk) and `d` deep (0 at the desk side). */
  point(a: number, d: number): readonly [number, number];
  box(a0: number, y0: number, d0: number, a1: number, y1: number, d1: number): BufferGeometry;
  /** A quad facing the open side at depth `d`. */
  quad(a0: number, y0: number, a1: number, y1: number, d: number): BufferGeometry;
  /** A box standing out of the face at depth `d`, `w0`-`w1` towards the open side. */
  faceBox(a0: number, y0: number, a1: number, y1: number, d: number, w0: number, w1: number): BufferGeometry;
  /** Yaw that turns a chair (its seat facing -Z) to face the desk. */
  readonly yaw: number;
}

function frameFor(x: number, y: number, open: Open): Frame {
  const point = (a: number, d: number): readonly [number, number] => {
    switch (open) {
      case 's':
        return [x + a, y + d];
      case 'n':
        return [x + 1 - a, y + 1 - d];
      case 'w':
        return [x + 1 - d, y + a];
      case 'e':
        return [x + d, y + 1 - a];
    }
  };
  const faceAt = (d: number): Face => {
    const [px, pz] = point(0, d);
    switch (open) {
      case 's':
        return { normal: 'z+', plane: pz };
      case 'n':
        return { normal: 'z-', plane: pz };
      case 'w':
        return { normal: 'x-', plane: px };
      case 'e':
        return { normal: 'x+', plane: px };
    }
  };
  const along = (a: number, d: number): number => {
    const [px, pz] = point(a, d);
    return open === 's' || open === 'n' ? px : pz;
  };
  const yaw = open === 's' ? 0 : open === 'n' ? Math.PI : open === 'w' ? -Math.PI / 2 : Math.PI / 2;
  return {
    point,
    yaw,
    box(a0, y0, d0, a1, y1, d1) {
      const [x0, z0] = point(a0, d0);
      const [x1, z1] = point(a1, d1);
      return boxGeometry(x0, y0, z0, x1, y1, z1);
    },
    quad(a0, y0, a1, y1, d) {
      const u0 = along(a0, d);
      const u1 = along(a1, d);
      return faceQuad(faceAt(d), Math.min(u0, u1), y0, Math.max(u0, u1), y1, 0);
    },
    faceBox(a0, y0, a1, y1, d, w0, w1) {
      const u0 = along(a0, d);
      const u1 = along(a1, d);
      return faceBox(faceAt(d), Math.min(u0, u1), y0, w0, Math.max(u0, u1), y1, w1);
    },
  };
}

/** The open side of a booth cell: the first floor tile beside it, south first so screens face the camera. */
function openSide(map: FixedRoomLevelMap, x: number, y: number): Open {
  const floor = (tx: number, ty: number): boolean => map.tiles[ty]?.[tx] === 'floor';
  if (floor(x, y + 1)) return 's';
  if (floor(x, y - 1)) return 'n';
  if (floor(x - 1, y)) return 'w';
  if (floor(x + 1, y)) return 'e';
  return 's';
}

// ---------------------------------------------------------------------------
// Chairs
// ---------------------------------------------------------------------------

const FABRICS = [0x2b2f36, 0x5a2430, 0x23344f, 0x2f3a2c] as const;

/** An office chair's parts in its own frame: on the floor at the origin, its seat facing -Z. */
function chairParts(fabric: number): [BufferGeometry, Paint][] {
  return [
    [boxGeometry(-0.21, 0.03, -0.03, 0.21, 0.065, 0.03), NETCAFE.plastic],
    [boxGeometry(-0.03, 0.03, -0.21, 0.03, 0.065, 0.21), NETCAFE.plastic],
    [cylinderGeometry(0, 0.065, 0, 0.028, 0.028, 0.36, 6), NETCAFE.steelDark],
    [boxGeometry(-0.2, 0.42, -0.19, 0.2, 0.5, 0.18), fabric],
    [boxGeometry(-0.18, 0.5, 0.15, 0.18, 0.98, 0.21), fabric],
    [boxGeometry(-0.2, 0.52, -0.12, -0.17, 0.62, 0.1), NETCAFE.plastic],
    [boxGeometry(0.17, 0.52, -0.12, 0.2, 0.62, 0.1), NETCAFE.plastic],
  ];
}

const chairMatrix = new Matrix4();
const chairStep = new Matrix4();

/** An upright chair at (x, z), turned by `yaw`. */
function chair(bin: GeometryBin, x: number, z: number, yaw: number, fabric: number): void {
  chairMatrix.makeRotationY(yaw).setPosition(x, 0, z);
  for (const [geometry, paint] of chairParts(fabric)) bin.add('floor', geometry.applyMatrix4(chairMatrix), paint);
}

/** A chair knocked over: on its side, its back on the floor, turned by `yaw`, its lowest point on the floor. */
function toppledChairAt(bin: GeometryBin, x: number, z: number, yaw: number, fabric: number): void {
  const parts = chairParts(fabric);
  chairMatrix.makeRotationZ(Math.PI / 2);
  chairStep.makeRotationX(-0.35);
  chairMatrix.premultiply(chairStep);
  chairStep.makeRotationY(yaw);
  chairMatrix.premultiply(chairStep);
  const bounds = new Box3();
  for (const [geometry] of parts) {
    geometry.applyMatrix4(chairMatrix);
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox!);
  }
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  for (const [geometry, paint] of parts) bin.add('floor', geometry.translate(x - cx, -bounds.min.y + 0.005, z - cz), paint);
}

// ---------------------------------------------------------------------------
// Booths
// ---------------------------------------------------------------------------

type Screen = 'on' | 'off' | 'cracked';

/** What a booth's monitor shows, decided once per cell: about half still on. */
export function boothScreen(x: number, y: number): Screen {
  const roll = hash01(x, y, 907);
  return roll < 0.52 ? 'on' : roll < 0.8 ? 'off' : 'cracked';
}

const SCREEN_GLOWS = [0x3a7bff, 0x8a4dff, 0x2fd6c4, 0xff7a4a, 0x46c2ff] as const;

/**
 * One PC booth per tile: laminate partitions either side (and a taller one
 * behind a booth backed by another row), a desk against the back with its
 * monitor and keyboard, an office chair (one in five pushed back crooked or
 * gone), and, when its monitor is on, the screen's light on the floor in
 * front. Partitions stay low (1.2) so a player in the next corridor is seen.
 */
function pcBooths(bin: GeometryBin, fixture: FixedRoomFixture, map: FixedRoomLevelMap): void {
  for (let y = fixture.y; y < fixture.y + fixture.height; y++) {
    for (let x = fixture.x; x < fixture.x + fixture.width; x++) pcBooth(bin, map, x, y);
  }
}

function pcBooth(bin: GeometryBin, map: FixedRoomLevelMap, x: number, y: number): void {
  const open = openSide(map, x, y);
  const f = frameFor(x, y, open);
  const seed = hash01(x, y, 911);
  const P = 1.2;
  // Partitions, a half each side: the booth beside adds the other half.
  for (const [a0, a1] of [[0, 0.03], [0.97, 1]] as const) {
    bin.add('floor', f.box(a0, 0, 0.0, a1, P, 0.96), (_x, h) => shade(NETCAFE.partition, -0.08 * (1 - clamp01(h / P))));
    bin.add('floor', f.box(a0 - 0.004, P, 0.0, a1 + 0.004, P + 0.03, 0.96), NETCAFE.partitionTrim);
    bin.add('floor', f.box(a0 - 0.004, 0, 0.93, a1 + 0.004, P + 0.03, 0.97), NETCAFE.partitionTrim);
  }
  // Backed by another row (not a wall): a taller divider, frosted at the top.
  const [bx, bz] = f.point(0.5, -0.5);
  const behind = map.tiles[Math.floor(bz)]?.[Math.floor(bx)];
  if (behind !== 'wall') {
    bin.add('floor', f.box(0, 0, 0, 1, 1.0, 0.03), NETCAFE.partition);
    bin.add('floor', f.box(0, 1.0, 0, 1, 1.36, 0.02), shade(NETCAFE.laminate, 0.06));
    bin.add('floor', f.box(0, 1.36, -0.002, 1, 1.39, 0.025), NETCAFE.partitionTrim);
  }
  // A booth number plate on the partition's front edge: a dark tag with a lit dot.
  bin.add('floor', f.box(0.035, 1.02, 0.9, 0.12, 1.12, 0.93), NETCAFE.plastic);
  // The desk, its modesty panel and the keyboard tray.
  bin.add('floor', f.box(0.04, 0.7, 0.03, 0.96, 0.74, 0.44), NETCAFE.desk);
  bin.add('floor', f.box(0.06, 0.08, 0.03, 0.94, 0.7, 0.06), shade(NETCAFE.desk, -0.12));
  // Dust on the desk: a paler skin over its top.
  bin.add('floor', f.box(0.06, 0.74, 0.05, 0.94, 0.742, 0.42), mixHex(NETCAFE.desk, NETCAFE.dust, 0.35));
  // The monitor on its stand.
  bin.add('floor', f.box(0.44, 0.742, 0.08, 0.56, 0.76, 0.18), NETCAFE.plastic);
  bin.add('floor', f.box(0.48, 0.76, 0.1, 0.52, 0.86, 0.13), NETCAFE.plastic);
  bin.add('floor', f.box(0.2, 0.84, 0.1, 0.8, 1.18, 0.15), NETCAFE.plastic);
  const screen = boothScreen(x, y);
  const glow = SCREEN_GLOWS[Math.floor(seed * SCREEN_GLOWS.length) % SCREEN_GLOWS.length]!;
  const front = 0.152;
  if (screen === 'off') {
    bin.add('floor', f.quad(0.23, 0.87, 0.77, 1.15, front), 0x0b0e11);
  } else {
    const lit = screen === 'on' ? glow : shade(glow, -0.25);
    bin.add('glow', f.quad(0.23, 0.87, 0.77, 1.15, front), (_x, h) => new Color(lit).lerp(new Color(0x0a0d1a), clamp01((h - 0.87) / 0.28) * 0.55));
    // A game still running: a horizon, a figure and its health bar.
    bin.add('glow', f.faceBox(0.25, 0.94, 0.75, 0.948, front, 0.001, 0.003), shade(lit, 0.2));
    bin.add('glow', f.faceBox(0.42 + seed * 0.1, 0.948, 0.47 + seed * 0.1, 1.0, front, 0.001, 0.004), 0xfff3d6);
    bin.add('glow', f.faceBox(0.26, 1.11, 0.26 + 0.2 * (0.3 + seed), 1.125, front, 0.001, 0.004), 0x6cff8a);
    if (screen === 'cracked') {
      // A star of cracks from one impact.
      const [ia, iv] = [0.35 + seed * 0.3, 0.96 + seed * 0.12];
      for (let k = 0; k < 5; k++) {
        const angle = k * 1.3 + seed * 2;
        const [ea, ev] = [ia + Math.cos(angle) * 0.22, iv + Math.sin(angle) * 0.12];
        const [ax, az] = f.point(Math.min(0.77, Math.max(0.23, ia)), front + 0.005);
        const [ex, ez] = f.point(Math.min(0.77, Math.max(0.23, ea)), front + 0.005);
        bin.add('glow', beamGeometry([ax, iv, az], [ex, Math.min(1.15, Math.max(0.87, ev)), ez], 0.006, 0.004), 0xe8f4ff);
      }
    }
    // Its light on the floor in front of the booth.
    const c = new Color(lit);
    const strength = screen === 'on' ? 0.3 : 0.12;
    const [p0x, p0z] = f.point(0.08, 1.0);
    const [p1x, p1z] = f.point(0.92, 1.75);
    const [edgeX, edgeZ] = f.point(0.5, 1.0);
    bin.addRGBA('light', flatQuad(p0x, p0z, p1x, p1z, 0.013), (px, _py, pz) => {
      const reach = open === 's' || open === 'n' ? Math.abs(pz - edgeZ) : Math.abs(px - edgeX);
      return [c.r, c.g, c.b, strength * (1 - clamp01(reach / 0.75)) ** 1.4];
    });
  }
  // The keyboard, with a lit edge where the booth still has power.
  bin.add('floor', f.box(0.28, 0.742, 0.24, 0.72, 0.765, 0.34), 0x1d2024);
  if (screen === 'on') bin.add('glow', f.box(0.28, 0.742, 0.338, 0.72, 0.75, 0.343), shade(glow, 0.1));
  // The chair, mostly where it was left; a few pushed crooked, one in seven gone.
  if (seed < 0.86) {
    const [cx, cz] = f.point(0.5, 0.66);
    const crooked = seed > 0.68 ? (seed - 0.77) * 2.4 : (seed - 0.4) * 0.3;
    chair(bin, cx, cz, f.yaw + crooked, FABRICS[Math.floor(seed * 37) % FABRICS.length]!);
  }
}

// ---------------------------------------------------------------------------
// Reception, shelves, fridge
// ---------------------------------------------------------------------------

const SNACKS = [0xe8463a, 0xf2b630, 0x3aa65a, 0x3f7ee8, 0xf07ab8, 0xffffff, 0x8a5cd6, 0xff8b3d] as const;

/**
 * The check-in desk, facing the lobby: laminate front with a pink light strip
 * (part of it dead), a dead terminal turned to the staff side, a desk bell,
 * a stack of manga and an empty acrylic stand. No till, no prices (D-024).
 */
function reception(bin: GeometryBin, r: FixedRoomFixture): void {
  const x0 = r.x + 0.04;
  const x1 = r.x + r.width - 0.04;
  const z0 = r.y + 0.2;
  const z1 = r.y + 0.92;
  const top = 1.02;
  const face: Face = { normal: 'z+', plane: z1 };
  bin.add('floor', boxGeometry(x0, 0, z0, x1, top - 0.04, z1), (_x, h) => shade(NETCAFE.laminate, -0.12 * (1 - clamp01(h / top))));
  bin.add('floor', boxGeometry(x0 - 0.04, top - 0.04, z0 - 0.04, x1 + 0.04, top, z1 + 0.06), shade(NETCAFE.desk, 0.05));
  bin.add('floor', faceBox(face, x0, 0, 0, x1, 0.08, 0.02), NETCAFE.plastic);
  // The light strip under the lip, dead in two places.
  const pieces: [number, number][] = [[0, 0.32], [0.38, 0.55], [0.71, 1]];
  for (const [a, b] of pieces) {
    bin.add('glow', faceBox(face, x0 + (x1 - x0) * a, top - 0.13, 0.02, x0 + (x1 - x0) * b - 0.01, top - 0.11, 0.035), NETCAFE.pink);
  }
  // Panels on the front, one hanging loose at its corner.
  for (let k = 0; k < 4; k++) {
    const u0 = x0 + 0.1 + k * ((x1 - x0 - 0.2) / 4);
    const u1 = u0 + (x1 - x0 - 0.2) / 4 - 0.06;
    bin.add('floor', faceBox(face, u0, 0.22, 0, u1, 0.78, k === 2 ? 0.035 : 0.012), shade(NETCAFE.laminate, k === 2 ? -0.1 : 0.03));
  }
  // On the desk: the terminal (staff side), the bell, manga, an empty stand.
  const tx = x0 + 0.7;
  bin.add('floor', boxGeometry(tx - 0.25, top, z0 + 0.12, tx + 0.25, top + 0.36, z0 + 0.18), NETCAFE.plastic);
  bin.add('floor', boxGeometry(tx - 0.05, top, z0 + 0.18, tx + 0.05, top + 0.08, z0 + 0.28), NETCAFE.plastic);
  bin.add('floor', cylinderGeometry(x1 - 0.5, top, z1 - 0.2, 0.06, 0.07, 0.035, 10), 0x2a2a2a);
  bin.add('floor', cylinderGeometry(x1 - 0.5, top + 0.035, z1 - 0.2, 0.012, 0.05, 0.05, 10), 0xd8b64a);
  for (let k = 0; k < 5; k++) {
    bin.add('floor', boxGeometry(x0 + 1.6 - k * 0.006, top + k * 0.03, z1 - 0.35, x0 + 1.78 + k * 0.004, top + k * 0.03 + 0.028, z1 - 0.1), SNACKS[(k * 3) % SNACKS.length]!);
  }
  bin.add('floor', boxGeometry(x1 - 1.0, top, z1 - 0.18, x1 - 0.8, top + 0.26, z1 - 0.16), 0xd9e7ee);
  // A cat figure on the desk's corner, waving a paw: the stair's cat, in plastic.
  const kx = x0 + 0.2;
  const kz = z1 - 0.2;
  bin.add('floor', boxGeometry(kx - 0.06, top, kz - 0.05, kx + 0.06, top + 0.12, kz + 0.05), 0xf6f1e6);
  bin.add('floor', boxGeometry(kx - 0.055, top + 0.12, kz - 0.045, kx + 0.055, top + 0.21, kz + 0.05), 0xf6f1e6);
  bin.add('floor', coneGeometry(kx - 0.035, top + 0.2, kz, 0.02, 0.04, 4), 0xd8843a);
  bin.add('floor', coneGeometry(kx + 0.035, top + 0.2, kz, 0.02, 0.04, 4), 0x2b2622);
  bin.add('floor', boxGeometry(kx + 0.06, top + 0.1, kz - 0.01, kx + 0.085, top + 0.2, kz + 0.015), 0xf6f1e6);
}

/** Shelves of snacks behind the desk, against the booths' backs, half sold out and some packets down. */
function snackShelf(bin: GeometryBin, r: FixedRoomFixture): void {
  const x0 = r.x + 0.04;
  const x1 = r.x + r.width - 0.04;
  const z0 = r.y + 0.04;
  const z1 = r.y + 0.42;
  const H = 1.3;
  const face: Face = { normal: 'z+', plane: z1 };
  bin.add('floor', boxGeometry(x0, 0, z0, x1, H, z0 + 0.04), shade(NETCAFE.wallLower, 0.05));
  for (const x of [x0, x0 + (x1 - x0) / 2 - 0.02, x1 - 0.04]) bin.add('floor', boxGeometry(x, 0, z0, x + 0.04, H, z1), NETCAFE.steelDark);
  const levels = [0.12, 0.42, 0.72, 1.02];
  levels.forEach((v, level) => {
    bin.add('floor', boxGeometry(x0, v - 0.025, z0, x1, v, z1), NETCAFE.steel);
    bin.add('floor', faceBox(face, x0, v - 0.05, 0, x1, v, 0.012), 0xfafafa);
    let u = x0 + 0.06;
    let k = 0;
    while (u < x1 - 0.12) {
      const roll = hash01(Math.round(u * 50), level, 919 + r.x);
      const w = 0.08 + roll * 0.08;
      if (roll > 0.42) {
        const h = 0.12 + hash01(k, level, 921) * 0.12;
        bin.add('floor', boxGeometry(u, v, z0 + 0.08, u + w - 0.01, v + h, z1 - 0.04), SNACKS[(k + level * 3) % SNACKS.length]!);
      }
      u += w;
      k += 1;
    }
  });
  bin.add('floor', boxGeometry(x0 - 0.02, H, z0 - 0.02, x1 + 0.02, H + 0.04, z1 + 0.02), NETCAFE.plastic);
  // Packets on the staff floor between the shelves and the desk.
  for (let k = 0; k < 6; k++) {
    const px = x0 + 0.3 + hash01(k, r.x, 923) * (x1 - x0 - 0.6);
    const pz = r.y + 0.55 + hash01(k, r.y, 925) * 0.3;
    bin.add('floor', boxGeometry(px - 0.07, 0.005, pz - 0.05, px + 0.07, 0.045, pz + 0.05), SNACKS[k % SNACKS.length]!);
  }
}

/** The drinks fridge at the desk's end, facing the lobby: still humming, its light still on. */
function drinksFridge(bin: GeometryBin, r: FixedRoomFixture): void {
  const x0 = r.x + 0.08;
  const x1 = r.x + r.width - 0.08;
  const z0 = r.y + 0.14;
  const z1 = r.y + 0.84;
  const H = 1.86;
  const face: Face = { normal: 'z+', plane: z1 };
  bin.add('floor', boxGeometry(x0, 0, z0, x1, H, z1), (_x, h) => shade(0xe6e8ea, -0.08 * (1 - clamp01(h / H))));
  bin.add('floor', faceBox(face, x0 + 0.04, 0.04, 0, x1 - 0.04, 0.16, 0.01), NETCAFE.plastic);
  bin.add('glow', faceBox(face, x0 + 0.04, H - 0.2, 0.0, x1 - 0.04, H - 0.06, 0.012), NETCAFE.cyan);
  // The glass door's frame and the lit inside.
  bin.add('floor', faceBox(face, x0 + 0.04, 0.2, 0, x1 - 0.04, H - 0.24, 0.02), NETCAFE.plastic);
  bin.add('glow', faceQuad(face, x0 + 0.08, 0.24, x1 - 0.08, H - 0.28, 0.021), 0xd8f6ff);
  const shelves = [0.42, 0.74, 1.06, 1.38];
  shelves.forEach((v, level) => {
    bin.add('glow', faceBox(face, x0 + 0.08, v - 0.012, 0.022, x1 - 0.08, v, 0.024), 0xa9c4cc);
    for (let k = 0; k < 5; k++) {
      if (hash01(k, level, 931) < 0.3) continue;
      const u = x0 + 0.12 + k * 0.12;
      const colour = SNACKS[(k * 2 + level) % SNACKS.length]!;
      bin.add('glow', faceBox(face, u, v, 0.024, u + 0.07, v + 0.22, 0.03), shade(colour, -0.05));
    }
  });
  bin.add('floor', faceBox(face, x1 - 0.12, 0.7, 0.02, x1 - 0.09, 1.3, 0.06), NETCAFE.steel);
  // Its cold light on the lobby floor.
  const c = new Color(0xd8f6ff);
  bin.addRGBA('light', flatQuad(x0 - 0.15, r.y + 1, x1 + 0.15, r.y + 1.85, 0.013), (_x, _y, z) => [
    c.r,
    c.g,
    c.b,
    0.22 * (1 - clamp01((z - r.y - 1) / 0.85)),
  ]);
}

/** Waist-high manga shelves along the lobby, rows of spines, gaps where volumes went missing. */
function mangaShelf(bin: GeometryBin, r: FixedRoomFixture): void {
  const x0 = r.x + 0.04;
  const x1 = r.x + r.width - 0.04;
  const z0 = r.y + 0.22;
  const z1 = r.y + 0.8;
  const H = 1.14;
  const face: Face = { normal: 'z+', plane: z1 };
  bin.add('floor', boxGeometry(x0, 0, z0, x1, H, z0 + 0.04), shade(NETCAFE.desk, -0.2));
  bin.add('floor', boxGeometry(x0 - 0.02, H, z0 - 0.02, x1 + 0.02, H + 0.04, z1 + 0.02), NETCAFE.desk);
  for (let x = x0; x < x1 - 0.01; x += (x1 - x0) / 5) bin.add('floor', boxGeometry(x, 0, z0, x + 0.04, H, z1), NETCAFE.desk);
  bin.add('floor', boxGeometry(x1 - 0.04, 0, z0, x1, H, z1), NETCAFE.desk);
  const levels = [0.06, 0.42, 0.78];
  levels.forEach((v, level) => {
    bin.add('floor', boxGeometry(x0, v - 0.03, z0, x1, v, z1), NETCAFE.desk);
    let u = x0 + 0.06;
    let k = 0;
    while (u < x1 - 0.06) {
      const roll = hash01(Math.round(u * 80), level, 941 + r.x);
      const w = 0.035 + roll * 0.025;
      if (roll > 0.12 || k % 9 !== 4) {
        const h = 0.24 + hash01(k, level, 943) * 0.06;
        const colour = SNACKS[Math.floor(hash01(k, level, 945) * SNACKS.length)]!;
        bin.add('floor', faceBox(face, u, v, -0.5, u + w - 0.004, v + h, -0.02), shade(colour, -0.15 + roll * 0.2));
      } else {
        u += 0.12;
      }
      u += w;
      k += 1;
    }
  });
  // Volumes left lying on top.
  for (let k = 0; k < 3; k++) {
    const px = x0 + 0.5 + k * 1.3;
    bin.add('floor', boxGeometry(px, H + 0.04, z0 + 0.1, px + 0.3, H + 0.07, z0 + 0.32), SNACKS[(k * 3 + 1) % SNACKS.length]!);
  }
}

/**
 * What was put away behind the lift and never collected: cartons stacked
 * unevenly, a stack of chairs, an arcade cabinet gone dark, a rolled rug.
 */
function storage(bin: GeometryBin, r: FixedRoomFixture): void {
  const x0 = r.x === 1 ? 0.6 : r.x + 0.05;
  const x1 = r.x + r.width - 0.06;
  const z0 = r.y === 1 ? 0.6 : r.y + 0.05;
  const z1 = r.y + r.height - 0.06;
  const carton = 0xb88c58;
  // Cartons, in two leaning piles against the north wall.
  const piles: [number, number, number][] = [[x0 + 0.05, z0 + 0.05, 4], [x0 + 0.62, z0 + 0.1, 3]];
  for (const [px, pz, count] of piles) {
    for (let k = 0; k < count; k++) {
      const jitter = (hash01(k, Math.round(px * 10), 961) - 0.5) * 0.08;
      const w = 0.5 - k * 0.03;
      bin.add('floor', boxGeometry(px + jitter, k * 0.34, pz + jitter, px + w + jitter, k * 0.34 + 0.33, pz + 0.48), shade(carton, (hash01(k, 3, 963) - 0.5) * 0.12));
      bin.add('floor', boxGeometry(px + jitter + w * 0.45, k * 0.34 + 0.33, pz + jitter, px + jitter + w * 0.55, k * 0.34 + 0.334, pz + 0.48), 0xd9cfa3);
    }
  }
  // A stack of chairs, seats on seats.
  for (let k = 0; k < 4; k++) {
    bin.add('floor', boxGeometry(x1 - 0.5, 0.42 + k * 0.1, z0 + 0.15, x1 - 0.1, 0.48 + k * 0.1, z0 + 0.55), FABRICS[k % FABRICS.length]!);
  }
  bin.add('floor', boxGeometry(x1 - 0.48, 0, z0 + 0.32, x1 - 0.42, 0.42, z0 + 0.38), NETCAFE.steelDark);
  bin.add('floor', boxGeometry(x1 - 0.18, 0, z0 + 0.32, x1 - 0.12, 0.42, z0 + 0.38), NETCAFE.steelDark);
  // An arcade cabinet facing the spine, dark: its marquee unlit, its screen black.
  const ax0 = x1 - 0.7;
  const az0 = z1 - 1.1;
  const az1 = z1 - 0.3;
  bin.add('floor', boxGeometry(ax0, 0, az0, x1 - 0.05, 1.62, az1), 0x1d1b26);
  bin.add('floor', boxGeometry(x1 - 0.06, 0.95, az0 + 0.06, x1 - 0.02, 1.32, az1 - 0.06), 0x090a0d);
  bin.add('floor', boxGeometry(x1 - 0.06, 1.38, az0 + 0.04, x1 - 0.02, 1.56, az1 - 0.04), shade(NETCAFE.pink, -0.55));
  bin.add('floor', boxGeometry(x1 - 0.2, 0.86, az0 + 0.04, x1 + 0.0, 0.92, az1 - 0.04), 0x2a2733);
  // A rolled rug on the floor along the cartons.
  bin.add('floor', cylinderGeometry(0, 0, 0, 0.12, 0.12, 1.1, 8).rotateX(Math.PI / 2).translate(x0 + 0.3, 0.12, z1 - 0.65), 0x7a3b48);
}

function toppledChair(bin: GeometryBin, r: FixedRoomFixture): void {
  const seed = hash01(r.x, r.y, 951);
  toppledChairAt(bin, r.x + 0.5, r.y + 0.5, 0.7 + seed * 2.2, FABRICS[Math.floor(seed * 13) % FABRICS.length]!);
  // A dropped headset beside it.
  bin.add('floor', boxGeometry(r.x + 0.18, 0.005, r.y + 0.2, r.x + 0.32, 0.04, r.y + 0.3), 0x1d2024);
}

/** The net cafe's props (D-105's free-standing furniture, D-107's kinds), on the floor's own meshes. */
export function netcafeProp(fixture: FixedRoomFixture, map: FixedRoomLevelMap, floor: GeometryBin): boolean {
  switch (fixture.prop) {
    case 'pc-booth':
      pcBooths(floor, fixture, map);
      return true;
    case 'reception':
      reception(floor, fixture);
      return true;
    case 'snack-shelf':
      snackShelf(floor, fixture);
      return true;
    case 'drinks-fridge':
      drinksFridge(floor, fixture);
      return true;
    case 'manga-shelf':
      mangaShelf(floor, fixture);
      return true;
    case 'toppled-chair':
      toppledChair(floor, fixture);
      return true;
    case 'storage':
      storage(floor, fixture);
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The lift
// ---------------------------------------------------------------------------

/** What the lift hands back to the room: its status light, its paper sign, and where its line floats. */
export interface ElevatorBay {
  readonly status: readonly BufferGeometry[];
  readonly sign: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly roll: number };
  readonly prompt: { readonly x: number; readonly y: number; readonly z: number };
}

/** A 3-by-5 pixel font for the floor indicator: only what a basement lift needs. */
const PIXELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  B: ['110', '101', '110', '101', '110'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['110', '001', '010', '100', '111'],
  '3': ['110', '001', '010', '001', '110'],
  '4': ['101', '101', '111', '001', '001'],
});

function pixelText(bin: GeometryBin, key: string, face: Face, text: string, u: number, v: number, px: number, colour: Paint): number {
  for (const char of text) {
    const rows = PIXELS[char];
    if (rows) {
      rows.forEach((row, r) => {
        [...row].forEach((bit, c) => {
          if (bit !== '1') return;
          const u0 = u + c * px;
          const v0 = v + (4 - r) * px;
          bin.add(key, faceBox(face, u0, v0, 0, u0 + px * 0.86, v0 + px * 0.86, 0.004), colour);
        });
      });
    }
    u += px * 4;
  }
  return u;
}

/**
 * The out-of-order lift, right by the stair: a clean shaft in fresh grey
 * paint against the old walls, brushed-steel doors in a steel surround, the
 * floor indicator over them (1 and four basements, B1 lit, a down arrow),
 * the call button on the right jamb with a service tag hanging from it, and
 * the hand-written paper taped across the seam (the station's label). In
 * front, on the station's own tile: two cones, a striped bar between them
 * and a red toolbox. The protective film is still on one door. It looks a
 * week from working; its id is held for the floors to come (D-107).
 */
export function elevatorBay(station: FixedRoomStationDefinition, map: FixedRoomLevelMap, bin: GeometryBin): ElevatorBay {
  const x0 = station.x;
  const x1 = station.x + station.width;
  const cx = (x0 + x1) / 2;
  const front = station.y + 0.32;
  const status: BufferGeometry[] = [];
  // The shaft: the fixtures behind the doors, back to the walls, in new paint.
  const shaft = map.fixtures.filter((fixture) => fixture.prop === undefined && fixture.y + fixture.height === station.y && fixture.x < x1 && fixture.x + fixture.width > x0);
  const top = shaft.reduce((min, fixture) => Math.min(min, fixture.y), station.y);
  const wx0 = x0 === 1 ? 0.55 : x0;
  const fresh = 0xd3d6d8;
  bin.add('body', boxGeometry(wx0, 0, top === 1 ? 0.55 : top, x1, 2.2, front), (_x, h) => shade(fresh, -0.1 * (1 - clamp01(h / 2.2))));
  bin.add('body', boxGeometry(wx0, 2.2, top === 1 ? 0.55 : top, x1 + 0.02, 2.26, front + 0.02), 0x9ea3a7);
  // Up there, where the camera looks down: the machine room's hatch and a yellow-black edge.
  bin.add('body', boxGeometry(wx0 + 0.3, 2.26, (top === 1 ? 0.55 : top) + 0.4, x1 - 0.3, 2.34, (top === 1 ? 0.55 : top) + 1.4), 0x7c8287);
  for (let k = 0; k < 8; k++) {
    const a = wx0 + k * ((x1 - wx0) / 8);
    bin.add('body', boxGeometry(a, 2.26, front - 0.12, a + (x1 - wx0) / 8, 2.28, front), k % 2 === 0 ? 0xf2c230 : 0x1f1f1f);
  }
  const face: Face = { normal: 'z+', plane: front };
  // The steel surround and the brushed doors, each leaf in fine vertical strips.
  bin.add('body', faceBox(face, x0 + 0.08, 0, 0, x1 - 0.08, 2.08, 0.05), NETCAFE.steel);
  const d0 = x0 + 0.32;
  const d1 = x1 - 0.32;
  const seam = cx;
  for (const [a, b] of [[d0, seam - 0.006], [seam + 0.006, d1]] as const) {
    const strips = 9;
    for (let k = 0; k < strips; k++) {
      const u0 = a + ((b - a) * k) / strips;
      const u1 = a + ((b - a) * (k + 1)) / strips;
      bin.add('body', faceBox(face, u0, 0.03, 0.05, u1, 1.86, 0.075), shade(NETCAFE.steel, (hash01(k, Math.round(a * 10), 961) - 0.5) * 0.06 + 0.04));
    }
  }
  bin.add('body', faceBox(face, seam - 0.006, 0.03, 0.05, seam + 0.006, 1.86, 0.06), 0x2c3034);
  bin.add('body', faceBox(face, d0 - 0.04, 1.86, 0.05, d1 + 0.04, 1.9, 0.08), NETCAFE.steelDark);
  // Protective film still on the right leaf, its corner curling.
  bin.add('body', faceBox(face, seam + 0.08, 0.12, 0.075, d1 - 0.05, 0.9, 0.078), 0xb9d6e4);
  bin.add('body', flatPolygon([[d1 - 0.05, 0], [d1 - 0.22, 0], [d1 - 0.05, 0.16]], 0).rotateX(Math.PI / 2).translate(0, 0.9 + 0.16 - 0.002, front + 0.11), 0xcfe5f0);
  // The floor indicator: 1 B1 B2 B3 B4 in amber pixels, B1 lit (the state's light), a down arrow.
  const ind: Face = { normal: 'z+', plane: front + 0.05 };
  bin.add('body', faceBox(ind, d0 + 0.05, 1.93, 0, d1 - 0.05, 2.06, 0.02), 0x0f1114);
  const px = 0.014;
  let u = d0 + 0.11;
  const floors = ['1', 'B1', 'B2', 'B3', 'B4'];
  const lit = new GeometryBin();
  try {
    for (const label of floors) {
      if (label === 'B1') {
        u = pixelText(lit, 'status', { normal: 'z+', plane: front + 0.072 }, label, u, 1.96, px, 0xffffff);
      } else {
        u = pixelText(bin, 'unlit', { normal: 'z+', plane: front + 0.072 }, label, u, 1.96, px, shade(NETCAFE.amber, -0.42));
      }
      u += px * 2.4;
    }
    const geometry = lit.take('status');
    if (geometry) status.push(geometry);
  } finally {
    lit.dispose();
  }
  const ax = d0 + 0.07;
  bin.add('unlit', flatPolygon([[ax - 0.03, 0], [ax + 0.03, 0], [ax, 0.045]], 0).rotateX(Math.PI / 2).translate(0, 2.035, front + 0.076), shade(NETCAFE.amber, -0.3));
  // The call panel on the right jamb: the button is the state's light, a service tag on a string under it.
  const jamb = d1 + 0.12;
  bin.add('body', faceBox(face, jamb - 0.07, 0.92, 0.05, jamb + 0.07, 1.26, 0.07), NETCAFE.steelDark);
  status.push(faceDisc(face, jamb, 1.12, 0.07, 0.03, 0.015, 12));
  bin.add('unlit', faceBox(face, jamb - 0.004, 1.12, 0.085, jamb + 0.004, 1.12 + 0.002, 0.09), 0xffffff);
  bin.add('body', beamGeometry(faceToWorld(face, jamb, 1.08, 0.09), faceToWorld(face, jamb + 0.03, 0.98, 0.1), 0.004), 0xe9e3d0);
  bin.add('body', faceBox(face, jamb - 0.01, 0.84, 0.095, jamb + 0.075, 0.98, 0.1), 0xf2c94c);
  bin.add('body', faceBox(face, jamb + 0.005, 0.95, 0.1, jamb + 0.06, 0.957, 0.102), 0x3a3a3a);
  bin.add('body', faceBox(face, jamb + 0.005, 0.91, 0.1, jamb + 0.05, 0.917, 0.102), 0x3a3a3a);
  bin.add('body', faceBox(face, jamb + 0.005, 0.87, 0.1, jamb + 0.064, 0.877, 0.102), 0xc8352a);
  // Tape at the paper's corners (the paper itself is the station's label).
  const signZ = front + 0.082;
  for (const [du, dv] of [[-0.3, 0.2], [0.3, 0.2], [-0.3, -0.2], [0.3, -0.2]] as const) {
    bin.add('body', boxGeometry(cx + du - 0.05, 1.3 + dv - 0.018, signZ, cx + du + 0.05, 1.3 + dv + 0.018, signZ + 0.006), 0xf3e9b8);
  }
  // On the station's own tile, in front: cones, a striped bar, a toolbox.
  const cz = station.y + station.height - 0.22;
  for (const x of [x0 + 0.24, x1 - 0.24]) {
    bin.add('body', boxGeometry(x - 0.13, 0, cz - 0.13, x + 0.13, 0.03, cz + 0.13), 0x2a2a2a);
    bin.add('body', coneGeometry(x, 0.03, cz, 0.1, 0.42, 10), 0xff6a1a);
    bin.add('body', cylinderGeometry(x, 0.2, cz, 0.058, 0.07, 0.07, 10), 0xf5f5f5);
  }
  for (let k = 0; k < 8; k++) {
    const a = x0 + 0.3 + k * ((x1 - x0 - 0.6) / 8);
    bin.add('body', boxGeometry(a, 0.3, cz - 0.02, a + (x1 - x0 - 0.6) / 8, 0.36, cz + 0.02), k % 2 === 0 ? 0xf2c230 : 0x1f1f1f);
  }
  const tx = x0 + 0.62;
  const tz = station.y + 0.5;
  bin.add('body', boxGeometry(tx - 0.2, 0, tz - 0.08, tx + 0.2, 0.18, tz + 0.08), 0xc8352a);
  bin.add('body', boxGeometry(tx - 0.21, 0.18, tz - 0.085, tx + 0.21, 0.2, tz + 0.085), 0x9e2a20);
  bin.add('body', boxGeometry(tx - 0.08, 0.2, tz - 0.012, tx + 0.08, 0.25, tz + 0.012), 0x2a2a2a);
  bin.add('body', boxGeometry(tx + 0.24, 0, tz - 0.04, tx + 0.44, 0.03, tz + 0.02), 0xa6a9ad);
  return {
    status,
    sign: { x: cx, y: 1.3, z: signZ + 0.004, yaw: 0, roll: -0.05 },
    prompt: { x: cx, y: 2.42, z: station.y + 0.6 },
  };
}

// ---------------------------------------------------------------------------
// The room: walls, ceiling remnants, floor, the stair up, the tube
// ---------------------------------------------------------------------------

export interface NetcafeContext {
  readonly theme: RoomTheme;
  readonly map: FixedRoomLevelMap;
  readonly floor: GeometryBin;
  readonly walls: {
    readonly north: { readonly face: Face; readonly bins: GeometryBin; readonly group: Group };
    readonly west: { readonly face: Face; readonly bins: GeometryBin; readonly group: Group };
    readonly east: { readonly face: Face; readonly bins: GeometryBin; readonly group: Group };
  };
  readonly res: ResourceBag;
  readonly group: Group;
  readonly animators: Array<(elapsedMs: number) => void>;
  readonly labels: LabelFactory;
  readonly textLabels: TextLabel[];
  /** Whether the player asked for less motion: the tube then holds steady. */
  readonly reducedMotion: () => boolean;
}

export function netcafeDecor(ctx: NetcafeContext): void {
  neonSigns(ctx);
  posters(ctx);
  cableTrays(ctx);
  grime(ctx);
  flickeringTube(ctx);
}

function neonSigns(ctx: NetcafeContext): void {
  const { walls, labels, textLabels, floor } = ctx;
  const north = walls.north;
  const nf = north.face;
  const signs: [string, typeof NETCAFE_SIGN, number, number, number][] = [
    [NETCAFE_SIGN_TEXT, NETCAFE_SIGN, 6.5, 1.74, NETCAFE.pink],
    [NETCAFE_GAME_TEXT, NETCAFE_GAME_SIGN, 12.2, 1.74, NETCAFE.cyan],
  ];
  for (const [text, style, u, v, colour] of signs) {
    const sign = labels.sign(text, style);
    textLabels.push(sign);
    sign.object.position.set(...faceToWorld(nf, u, v, 0.05));
    sign.object.userData['area'] = 'netcafe-sign';
    north.group.add(sign.object);
    // The tube's glow on the wall round the board, and its brackets.
    const c = new Color(colour);
    floor.addRGBA('light', faceQuad(nf, u - style.width / 2 - 0.5, v - 0.55, u + style.width / 2 + 0.5, v + 0.45, 0.03), (x, y) => {
      const dx = Math.max(0, Math.abs(x - u) - style.width / 2) / 0.5;
      const dy = Math.abs(y - v) / 0.5;
      return [c.r, c.g, c.b, 0.3 * (1 - clamp01(Math.hypot(dx, dy)))];
    });
    for (const du of [-style.width / 2 + 0.12, style.width / 2 - 0.12]) {
      north.bins.add('body', faceBox(nf, u + du - 0.02, v - 0.02, 0, u + du + 0.02, v + 0.02, 0.05), NETCAFE.steelDark);
    }
  }
  // 受付 24H on top of the snack shelves, facing the lobby over the desk.
  const shelf = ctx.map.fixtures.find((fixture) => fixture.prop === 'snack-shelf');
  if (shelf) {
    const sign = labels.sign(NETCAFE_RECEPTION_TEXT, NETCAFE_RECEPTION_SIGN);
    textLabels.push(sign);
    const sx = shelf.x + shelf.width / 2 - 0.6;
    sign.object.position.set(sx, 1.58, shelf.y + 0.3);
    sign.object.userData['area'] = 'netcafe-sign';
    ctx.group.add(sign.object);
    floor.add('floor', boxGeometry(sx - 0.03, 1.34, shelf.y + 0.24, sx + 0.03, 1.4, shelf.y + 0.28), NETCAFE.steelDark);
  }
}

/** A peeling poster: a flat game-art print (shapes, never words), one corner folded down. */
function poster(bins: GeometryBin, face: Face, u0: number, v0: number, w: number, h: number, seed: number): void {
  const palettes = [
    [0x1b2a6b, 0xff4f8b, 0xffd166, 0x63e6ff],
    [0x2b1036, 0x9a5cff, 0x3ff0ff, 0xfff2b3],
    [0x0f3b3a, 0x3fffb0, 0xff7a4a, 0xffffff],
  ] as const;
  const [bg, a, b, c] = palettes[Math.floor(seed * palettes.length) % palettes.length]!;
  const fade = 0.25;
  const u1 = u0 + w;
  const v1 = v0 + h;
  bins.add('body', faceBox(face, u0, v0, 0, u1, v1, 0.006), mixHex(bg, 0xd8d2c4, fade));
  // A sun, a figure, a band: shapes only.
  bins.add('body', faceDisc(face, u0 + w * 0.62, v0 + h * 0.68, 0.006, w * 0.22, 0.004, 14), mixHex(a, 0xd8d2c4, fade));
  bins.add('body', faceBox(face, u0 + w * 0.22, v0 + h * 0.22, 0.006, u0 + w * 0.42, v0 + h * 0.58, 0.01), mixHex(b, 0xd8d2c4, fade));
  bins.add('body', faceBox(face, u0 + w * 0.26, v0 + h * 0.58, 0.006, u0 + w * 0.38, v0 + h * 0.68, 0.01), mixHex(b, 0xd8d2c4, fade));
  bins.add('body', faceBox(face, u0 + w * 0.08, v0 + h * 0.08, 0.006, u1 - w * 0.08, v0 + h * 0.16, 0.009), mixHex(c, 0xd8d2c4, fade));
  // The top corner peeled and folded over, showing the paper's pale back.
  const corner = Math.min(w, h) * 0.32;
  const peel = flatPolygon([[0, 0], [corner, 0], [0, corner]], 0);
  const pts = peel.getAttribute('position');
  const right = seed > 0.5;
  for (let i = 0; i < pts.count; i++) {
    const pu = pts.getX(i);
    const pv = pts.getZ(i);
    const [x, y, z] = faceToWorld(face, right ? u1 - pv : u0 + pv, v1 - pu, 0.012 + (pu + pv) * 0.25);
    pts.setXYZ(i, x, y, z);
  }
  peel.computeVertexNormals();
  bins.add('body', peel, 0xe9e3d3);
  // Tape where it still holds.
  bins.add('body', faceBox(face, right ? u0 + 0.02 : u1 - 0.08, v1 - 0.03, 0.006, right ? u0 + 0.08 : u1 - 0.02, v1 + 0.01, 0.01), 0xd9cfa3);
}

function posters(ctx: NetcafeContext): void {
  const { north, west, east } = ctx.walls;
  poster(north.bins, north.face, 3.18, 1.0, 0.6, 0.82, 0.2);
  poster(north.bins, north.face, 9.25, 1.32, 0.48, 0.64, 0.7);
  poster(north.bins, north.face, 14.25, 1.32, 0.5, 0.66, 0.45);
  poster(west.bins, west.face, 7.25, 0.95, 0.55, 0.75, 0.9);
  poster(east.bins, east.face, 2.15, 1.0, 0.55, 0.75, 0.35);
  // A breaker box by the stair, its door hanging open, cables out of it.
  const wf = west.face;
  west.bins.add('body', faceBox(wf, 8.2, 1.2, 0, 8.62, 1.72, 0.1), 0x8f9498);
  west.bins.add('body', faceBox(wf, 8.24, 1.24, 0.1, 8.58, 1.68, 0.11), 0x2a2d30);
  west.bins.add('body', beamGeometry(faceToWorld(wf, 8.62, 1.46, 0.1), faceToWorld(wf, 8.8, 1.46, 0.36), 0.02, 0.44), 0x8f9498);
  for (let k = 0; k < 3; k++) {
    west.bins.add('body', beamGeometry(faceToWorld(wf, 8.3 + k * 0.1, 1.24, 0.08), faceToWorld(wf, 8.28 + k * 0.13, 0.6 - k * 0.12, 0.04 + k * 0.03), 0.018), [0xc8352a, 0x1f1f1f, 0x2f6fc0][k]!);
  }
}

/**
 * Cable trays over the corridors, above head height, with cables sagging in
 * loops off them, one cut end dangling, and a ceiling tile hanging by a
 * wire. Every point over the walkable floor stays above 1.9.
 */
function cableTrays(ctx: NetcafeContext): void {
  const { floor, map } = ctx;
  const W = map.width - 0.55;
  const trays: [number, number, number][] = [
    [3.05, W, 2.42],
    [3.05, 9.0, 5.45],
  ];
  const cableColours = [0x1f1f1f, 0xc8352a, 0x2f6fc0, 0xe8e2d0, 0x3aa65a];
  for (const [t0, t1, tz] of trays) {
    floor.add('floor', boxGeometry(t0, 2.27, tz - 0.14, t1, 2.29, tz + 0.14), NETCAFE.steelDark);
    floor.add('floor', boxGeometry(t0, 2.29, tz - 0.14, t1, 2.36, tz - 0.12), NETCAFE.steelDark);
    floor.add('floor', boxGeometry(t0, 2.29, tz + 0.12, t1, 2.36, tz + 0.14), NETCAFE.steelDark);
    cableColours.forEach((colour, k) => {
      floor.add('floor', boxGeometry(t0, 2.29 + k * 0.008, tz - 0.1 + k * 0.045, t1, 2.31 + k * 0.008, tz - 0.08 + k * 0.045), colour);
    });
    // Loops sagging off the tray between its ends.
    for (let k = 0; k < 3; k++) {
      const a = t0 + 1.2 + k * ((t1 - t0 - 2) / 3) + hash01(k, Math.round(tz), 971) * 0.6;
      const b = a + 0.9 + hash01(k, Math.round(tz), 973) * 0.5;
      const sag = 2.0 + hash01(k, Math.round(tz), 975) * 0.06;
      const colour = cableColours[(k + 1) % cableColours.length]!;
      const steps = 6;
      for (let s = 0; s < steps; s++) {
        const p = s / steps;
        const q = (s + 1) / steps;
        const y = (t: number): number => 2.28 - (2.28 - sag) * 4 * t * (1 - t);
        floor.add('floor', beamGeometry([a + (b - a) * p, y(p), tz + 0.16], [a + (b - a) * q, y(q), tz + 0.16], 0.016), colour);
      }
    }
  }
  // A cut cable hanging out of the first tray, its copper showing.
  const dx = 7.8;
  floor.add('floor', beamGeometry([dx, 2.28, 2.42], [dx + 0.06, 1.96, 2.5], 0.018), 0x1f1f1f);
  floor.add('glow', boxGeometry(dx + 0.05, 1.93, 2.49, dx + 0.07, 1.96, 2.51), 0xd08a3a);
  // A ceiling tile hanging off the first tray by a wire, its stained face to the camera.
  const hx = 11.2;
  floor.add('floor', beamGeometry([hx, 2.28, 2.48], [hx, 2.24, 2.6], 0.006), 0x9a9a9a);
  const tile = flatQuad(-0.3, -0.3, 0.3, 0.3, 0).rotateX(0.95).rotateZ(0.12).translate(hx, 2.2, 2.82);
  floor.add('floor', tile, (x, _y, z) => {
    const stain = Math.hypot(x - hx - 0.08, z - 2.8) < 0.16;
    return new Color(stain ? 0x8a6a3e : 0xcfc6b2);
  });
}

/**
 * Years of nobody: stains and dust on the carpet, a ceiling tile fallen and
 * broken on the floor, paper, cans and a keyboard dropped in the corridor,
 * a cable snaking along the floor. All flat, under 0.15.
 */
function grime(ctx: NetcafeContext): void {
  const { floor, map } = ctx;
  const walkable = (x: number, y: number): boolean => map.tiles[y]?.[x] === 'floor';
  for (let y = 1; y < map.height - 1; y++) {
    for (let x = 1; x < map.width - 1; x++) {
      if (!walkable(x, y)) continue;
      const roll = hash01(x, y, 981);
      if (roll < 0.16) {
        // A water stain: two overlapping blotches.
        const sx = x + 0.2 + hash01(x, y, 982) * 0.4;
        const sz = y + 0.2 + hash01(x, y, 983) * 0.4;
        const r = 0.18 + hash01(x, y, 984) * 0.18;
        floor.add('floor', flatPolygon(blob(sx, sz, r, x * 7 + y), 0.004), mixHex(NETCAFE.carpet, NETCAFE.stain, 0.45));
        floor.add('floor', flatPolygon(blob(sx + r * 0.5, sz + r * 0.3, r * 0.6, x * 5 + y * 3), 0.005), mixHex(NETCAFE.carpet, 0x4a3a2a, 0.35));
      } else if (roll < 0.5) {
        // Dust drifted against nothing in particular.
        for (let k = 0; k < 4; k++) {
          const px = x + 0.1 + hash01(x, y, 985 + k) * 0.8;
          const pz = y + 0.1 + hash01(x, y, 989 + k) * 0.8;
          floor.add('floor', flatQuad(px, pz, px + 0.05, pz + 0.04, 0.004), NETCAFE.dust);
        }
      } else if (roll < 0.62) {
        // A sheet of paper.
        const px = x + 0.3 + hash01(x, y, 993) * 0.4;
        const pz = y + 0.3 + hash01(x, y, 994) * 0.4;
        const a = hash01(x, y, 995) * Math.PI;
        const square: readonly (readonly [number, number])[] = [[-0.11, -0.08], [0.11, -0.08], [0.11, 0.08], [-0.11, 0.08]];
        const corners: [number, number][] = square.map(([u, v]) => [
          px + u * Math.cos(a) - v * Math.sin(a),
          pz + u * Math.sin(a) + v * Math.cos(a),
        ]);
        floor.add('floor', flatPolygon(corners, 0.006), 0xe8e4da);
      }
    }
  }
  // A fallen ceiling tile in the big area, in pieces, and its dust.
  floor.add('floor', boxGeometry(10.15, 0, 3.15, 10.7, 0.03, 3.6), 0xc9bfa9);
  floor.add('floor', boxGeometry(10.75, 0, 3.3, 11.0, 0.025, 3.55), 0xc2b8a2);
  floor.add('floor', flatPolygon(blob(10.6, 3.5, 0.45, 77), 0.003), 0x8d877b);
  floor.add('floor', flatPolygon(blob(10.35, 3.32, 0.1, 78), 0.032), 0x8a6a3e);
  // Cans, on their sides.
  for (const [x, z, a] of [[6.4, 5.5, 0.3], [9.6, 8.4, 1.9], [12.7, 2.6, 2.6]] as const) {
    floor.add('floor', cylinderGeometry(0, 0, 0, 0.033, 0.033, 0.12, 8).rotateZ(Math.PI / 2).rotateY(a).translate(x, 0.034, z), 0xc8352a);
  }
  // A keyboard dropped in the second corridor, and a cable snaking along the spine.
  floor.add('floor', flatPolygon([[5.2, 5.3], [5.62, 5.42], [5.58, 5.56], [5.16, 5.44]], 0.02), 0x1d2024);
  floor.add('floor', boxGeometry(5.17, 0, 5.32, 5.6, 0.02, 5.55), 0x1d2024);
  let px = 3.3;
  let pz = 1.4;
  for (let k = 0; k < 9; k++) {
    const nx = 3.5 + Math.sin(k * 1.4) * 0.22;
    const nz = pz + 0.75;
    floor.add('floor', beamGeometry([px, 0.012, pz], [nx, 0.012, nz], 0.022, 0.016), 0x1f1f1f);
    px = nx;
    pz = nz;
  }
}

/** An irregular blob, convex enough for `flatPolygon`, around (x, z). */
function blob(x: number, z: number, r: number, seed: number): [number, number][] {
  const points: [number, number][] = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const rr = r * (0.82 + hash01(seed, k, 997) * 0.18);
    points.push([x + Math.cos(a) * rr, z + Math.sin(a) * rr]);
  }
  return points;
}

/**
 * One fluorescent tube over the first corridor that will not stay lit: it
 * stutters, catches and dims on an irregular cycle. With reduced motion it
 * holds a steady, dim light. Its tube and its light pool are its own two
 * materials, the room's only animated light of its own.
 */
function flickeringTube(ctx: NetcafeContext): void {
  const { res, group, animators, floor } = ctx;
  const x0 = 5.6;
  const x1 = 7.0;
  const z = 2.42;
  floor.add('floor', boxGeometry(x0 - 0.04, 2.13, z - 0.07, x1 + 0.04, 2.27, z + 0.07), 0xd9dcde);
  const bins = new GeometryBin();
  try {
    bins.add('tube', boxGeometry(x0, 2.1, z - 0.03, x1, 2.13, z + 0.03), 0xffffff);
    const tubeMaterial = res.material(unlitMaterial({ color: 0xf0f6ff, vertexColors: false }));
    const tube = flushBin(bins, 'tube', tubeMaterial, res, group, { name: `${group.name}:tube` });
    const pool = new Color(0xdfe9ff);
    bins.addRGBA('pool', flatQuad(x0 - 1.2, z - 0.42, x1 + 1.2, z + 0.58, 0.014), (x, _y, pz) => {
      const dx = Math.max(0, Math.max(x0 - x, x - x1)) / 1.2;
      const dz = Math.abs(pz - z) / 0.6;
      return [pool.r, pool.g, pool.b, 0.5 * (1 - clamp01(Math.hypot(dx, dz))) ** 1.1];
    });
    const poolMaterial = res.material(unlitMaterial({ additive: true }));
    const light = flushBin(bins, 'pool', poolMaterial, res, group, { name: `${group.name}:tube-light`, renderOrder: 2 });
    if (tube instanceof Mesh) tube.userData['flicker'] = true;
    if (light instanceof Mesh) light.userData['flicker'] = true;
    animators.push((elapsed) => {
      const level = ctx.reducedMotion() ? 0.6 : tubeLevel(elapsed);
      tubeMaterial.color.setRGB(0.25 + 0.75 * level, 0.27 + 0.73 * level, 0.3 + 0.7 * level);
      poolMaterial.opacity = level;
    });
  } finally {
    bins.dispose();
  }
}

/**
 * How lit the tube is at `elapsedMs`: a five-second cycle, lit most of it,
 * stuttering at its start, a soft dip in its middle. Never faster than a few
 * changes a second, and never a full-screen strobe: it is one tube.
 */
export function tubeLevel(elapsedMs: number): number {
  const cycle = 5200;
  const t = ((elapsedMs % cycle) + cycle) % cycle;
  if (t < 260) return 0.15;
  if (t < 420) return 0.9;
  if (t < 640) return 0.2;
  if (t < 3000) return 1;
  if (t < 3400) return 0.55;
  return 1;
}

/**
 * The stair back up to the alley: its first steps rising south past the low
 * wall, kept under the south wall's height like everything the camera looks
 * over (the room rule), with the street's warm light coming down it.
 */
export function netcafeStairs(map: FixedRoomLevelMap, floor: GeometryBin, south: GeometryBin): void {
  const exit = map.exit;
  if (!exit) return;
  const x0 = exit.x;
  const x1 = exit.x + exit.width;
  const z0 = exit.y + 1;
  const steps = 4;
  const run = 0.25;
  const rise = 0.13;
  for (let i = 0; i < steps; i++) {
    const za = z0 + i * run;
    floor.add('floor', boxGeometry(x0 + 0.04, -0.02, za, x1 - 0.04, rise * (i + 1), za + run), shade(0x77716b, -0.05 + i * 0.02));
    floor.add('floor', boxGeometry(x0 + 0.05, rise * (i + 1), za, x1 - 0.05, rise * (i + 1) + 0.012, za + 0.04), 0x9c8a3e);
  }
  const top = z0 + steps * run;
  for (const [a, b] of [[x0 - 0.45, x0], [x1, x1 + 0.45]] as const) {
    south.add('body', boxGeometry(a, 0, z0, b, 0.5, top), (_x: number, y: number) => shade(0x55514d, -0.1 * (1 - clamp01(y / 0.5))));
  }
  // The street's warm light coming down the steps.
  const warm = new Color(0xffc98a);
  const glow = (_x: number, _y: number, z: number): readonly [number, number, number, number] => [
    warm.r,
    warm.g,
    warm.b,
    0.32 * clamp01((z - z0 + 0.5) / (top - z0 + 0.5)),
  ];
  floor.addRGBA('light', flatQuad(x0 + 0.06, z0 - 0.5, x1 - 0.06, z0, 0.02), glow);
  const slope = flatQuad(x0 + 0.06, z0, x1 - 0.06, top, 0);
  const pos = slope.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setY(i, 0.02 + clamp01((pos.getZ(i) - z0) / (top - z0)) * (rise * steps));
  floor.addRGBA('light', slope, glow);
  // The landing's mat at the stair's foot, worn through.
  floor.add('floor', flatQuad(x0 + 0.1, exit.y - 0.95, x1 - 0.1, exit.y - 0.15, 0.005), 0x3a302a);
  floor.add('floor', flatPolygon(blob((x0 + x1) / 2, exit.y - 0.55, 0.22, 991), 0.007), shade(NETCAFE.carpetAlt, -0.04));
}
