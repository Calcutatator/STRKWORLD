import type { Color, ColorRepresentation } from 'three';
import { GeometryBin, boxGeometry, coneGeometry, prismX, prismZ } from './palette.js';

/**
 * Two landmarks on the far skyline (D-133, 2026-10-03): the things the swing
 * is pointed at.
 *
 * The view south was a grey band of roofs with nothing in it to look at. So
 * the city behind the station gets a skyline the ride can be aimed at: a
 * tapering iron LATTICE TOWER off to one side and a gothic CLOCK TOWER off to
 * the other, framing the station's shed between them from the seat.
 *
 * Both are invented, as everything in the district is: no real place, no
 * name, no lettering, no emblem — a lattice of iron and a tower with four
 * blank dials, which is as far as the resemblance goes.
 *
 * They are built into whichever bin the caller gives, so they cost one draw
 * call between them (the vista flushes that bin as `south-vista:landmarks`),
 * and they carry the vista's own haze through the `paint` it passes in, so
 * they sit in the same air as the city around them.
 */

/** Warm iron, lit by a low sun: the lattice tower's whole structure. */
export const LATTICE_IRON = 0xc2743f;
export const LATTICE_IRON_DARK = 0x9e5630;
/** The clock tower: warm stone, a verdigris roof, and pale gold dials. */
export const CLOCK_STONE = 0xd2ab78;
export const CLOCK_STONE_DARK = 0xb08a5c;
export const CLOCK_ROOF = 0x5f9183;
export const CLOCK_DIAL = 0xf6dda4;

/** Paint for a bin: a colour becomes a per-vertex colour (the vista's haze). */
export type LandmarkPaint = (colour: ColorRepresentation) => (x: number, y: number, z: number) => Color;

export interface LandmarkOptions {
  /** Where the pair stands, in street world units: the swing looks straight down +z. */
  readonly centreX: number;
  /** The ground they stand on. */
  readonly groundY: number;
  /** `'low'` thins the lattice's bracing and the tower's buttresses, for phones. */
  readonly quality?: 'low' | 'high';
}

/** How far either side of the centre each tower stands, and how far back. */
export const LATTICE_OFFSET_X = -30;
export const LATTICE_Z = 168;
/**
 * Tall enough to clear the station's shed from the seat and still be a tower
 * rather than a mast: the shed and the city in front of it hide everything
 * under about 20 units at this range, so the recognisable part — the taper,
 * the two platforms — has to be above that.
 */
export const LATTICE_HEIGHT = 64;
export const CLOCK_OFFSET_X = 27;
export const CLOCK_Z = 158;
export const CLOCK_HEIGHT = 41;

/** Both towers, into `bin` under `name`. */
export function laySouthLandmarks(
  bin: GeometryBin,
  name: string,
  paint: LandmarkPaint,
  options: LandmarkOptions,
): void {
  const low = options.quality === 'low';
  latticeTower(bin, name, paint, options.centreX + LATTICE_OFFSET_X, LATTICE_Z, options.groundY, low);
  clockTower(bin, name, paint, options.centreX + CLOCK_OFFSET_X, CLOCK_Z, options.groundY, low);
}

/**
 * The lattice tower: four splayed legs under two platforms, a tapering shaft
 * and a mast. Its taper is drawn in three straight runs rather than a curve —
 * at this range the silhouette is the whole of it.
 */
function latticeTower(
  bin: GeometryBin,
  name: string,
  paint: LandmarkPaint,
  x: number,
  z: number,
  groundY: number,
  low: boolean,
): void {
  const iron = paint(LATTICE_IRON);
  const ironDark = paint(LATTICE_IRON_DARK);
  const H = LATTICE_HEIGHT;
  /** Half the tower's width at a height: wide at the feet, a mast at the top. */
  const half = (y: number): number => {
    const t = Math.min(1, Math.max(0, y / H));
    if (t < 0.24) return 10 - t * 25;
    if (t < 0.58) return 4 - (t - 0.24) * 5.3;
    return Math.max(0.7, 2.2 - (t - 0.58) * 3.1);
  };
  /**
   * One corner post between two heights. It leans in both directions at
   * once, so it is stepped rather than extruded: a short run of boxes
   * following the taper, which reads as a leaning iron post at this range.
   */
  const leg = (y0: number, y1: number, sx: number, sz: number, thick: number): void => {
    const steps = low ? 2 : 4;
    for (let i = 0; i < steps; i += 1) {
      const a = y0 + ((y1 - y0) * i) / steps;
      const b = y0 + ((y1 - y0) * (i + 1)) / steps;
      const w = half((a + b) / 2);
      bin.add(
        name,
        boxGeometry(
          x + sx * w - thick, groundY + a, z + sz * w - thick,
          x + sx * w + thick, groundY + b, z + sz * w + thick,
        ),
        iron,
      );
    }
  };
  const levels = low ? [0, 0.22, 0.56, 1] : [0, 0.1, 0.22, 0.38, 0.56, 0.74, 1];
  for (let i = 0; i + 1 < levels.length; i += 1) {
    const y0 = levels[i]! * H;
    const y1 = levels[i + 1]! * H;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) leg(y0, y1, sx, sz, i < 2 ? 0.75 : 0.45);
    }
    // One band of bracing a stage, which is what reads as lattice from here.
    if (!low || i % 2 === 0) {
      const mid = (y0 + y1) / 2;
      const w = half(mid);
      bin.add(name, boxGeometry(x - w, groundY + mid - 0.18, z - w, x + w, groundY + mid + 0.18, z - w + 0.36), ironDark);
      bin.add(name, boxGeometry(x - w, groundY + mid - 0.18, z + w - 0.36, x + w, groundY + mid + 0.18, z + w), ironDark);
      bin.add(name, boxGeometry(x - w, groundY + mid - 0.18, z - w, x - w + 0.36, groundY + mid + 0.18, z + w), ironDark);
      bin.add(name, boxGeometry(x + w - 0.36, groundY + mid - 0.18, z - w, x + w, groundY + mid + 0.18, z + w), ironDark);
    }
  }
  // The great arch between the feet, the thing that says *this* tower: a
  // span under the first platform with a canted strut down to each leg.
  {
    const foot = half(0);
    const springY = 0.085 * H;
    const crownY = 0.125 * H;
    for (const sx of [-1, 1]) {
      // The span across this face, between the two legs on it.
      bin.add(
        name,
        boxGeometry(x + sx * foot - 0.5, groundY + crownY, z - foot, x + sx * foot + 0.5, groundY + crownY + 0.9, z + foot),
        ironDark,
      );
      for (const sz of [-1, 1]) {
        // A strut from the leg up to the span: a convex quad in (z, y).
        bin.add(
          name,
          prismX(
            [
              [z + sz * foot, groundY + springY],
              [z + sz * foot * 0.35, groundY + crownY],
              [z + sz * foot * 0.35, groundY + crownY + 0.5],
              [z + sz * foot, groundY + springY + 1.1],
            ],
            x + sx * foot - 0.4,
            x + sx * foot + 0.4,
          ),
          ironDark,
        );
      }
    }
  }
  // The two platforms, and the mast on top.
  for (const t of [0.22, 0.56]) {
    const w = half(t * H) + 0.9;
    bin.add(name, boxGeometry(x - w, groundY + t * H, z - w, x + w, groundY + t * H + 1.1, z + w), ironDark);
  }
  bin.add(name, boxGeometry(x - 0.75, groundY + H, z - 0.75, x + 0.75, groundY + H + 1.4, z + 0.75), ironDark);
  bin.add(name, boxGeometry(x - 0.18, groundY + H + 1.4, z - 0.18, x + 0.18, groundY + H + 5.2, z + 0.18), iron);
}

/**
 * The clock tower: a stone shaft with corner buttresses, a belfry with four
 * blank dials under it, and a steep roof with a finial.
 */
function clockTower(
  bin: GeometryBin,
  name: string,
  paint: LandmarkPaint,
  x: number,
  z: number,
  groundY: number,
  low: boolean,
): void {
  const stone = paint(CLOCK_STONE);
  const stoneDark = paint(CLOCK_STONE_DARK);
  const roof = paint(CLOCK_ROOF);
  const dial = paint(CLOCK_DIAL);
  const H = CLOCK_HEIGHT;
  const w = 3.4;
  // The shaft, with a string course every few storeys so it is not a slab.
  bin.add(name, boxGeometry(x - w, groundY, z - w, x + w, groundY + H, z + w), stone);
  for (let y = 5; y < H - 4; y += 5.5) {
    bin.add(name, boxGeometry(x - w - 0.3, groundY + y, z - w - 0.3, x + w + 0.3, groundY + y + 0.45, z + w + 0.3), stoneDark);
  }
  // Corner buttresses, stepping back as they rise.
  if (!low) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        bin.add(
          name,
          boxGeometry(
            x + sx * w - (sx > 0 ? 1.1 : -1.1), groundY, z + sz * w - (sz > 0 ? 1.1 : -1.1),
            x + sx * (w + 0.7), groundY + H * 0.72, z + sz * (w + 0.7),
          ),
          stoneDark,
        );
      }
    }
  }
  // Tall lancet openings up the shaft's faces: the shadow is the detail.
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    bin.add(
      name,
      boxGeometry(
        x + dx * w - (dx === 0 ? 0.9 : 0.1), groundY + H * 0.3, z + dz * w - (dz === 0 ? 0.9 : 0.1),
        x + dx * w + (dx === 0 ? 0.9 : 0.1), groundY + H * 0.62, z + dz * w + (dz === 0 ? 0.9 : 0.1),
      ),
      stoneDark,
    );
  }
  // The clock stage: a wider band with a blank dial on each face.
  const stage = H + 0.6;
  bin.add(name, boxGeometry(x - w - 0.5, groundY + stage, z - w - 0.5, x + w + 0.5, groundY + stage + 5.4, z + w + 0.5), stone);
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const face = w + 0.5;
    bin.add(
      name,
      boxGeometry(
        x + dx * face - (dx === 0 ? 1.7 : 0.14), groundY + stage + 1.2, z + dz * face - (dz === 0 ? 1.7 : 0.14),
        x + dx * face + (dx === 0 ? 1.7 : 0.14), groundY + stage + 4.6, z + dz * face + (dz === 0 ? 1.7 : 0.14),
      ),
      dial,
    );
  }
  // The belfry over it, its louvres in shadow.
  const belfry = stage + 5.4;
  bin.add(name, boxGeometry(x - w - 0.2, groundY + belfry, z - w - 0.2, x + w + 0.2, groundY + belfry + 3.6, z + w + 0.2), stone);
  bin.add(name, boxGeometry(x - w + 0.6, groundY + belfry + 0.5, z - w - 0.3, x + w - 0.6, groundY + belfry + 3.1, z - w - 0.1), stoneDark);
  bin.add(name, boxGeometry(x - w + 0.6, groundY + belfry + 0.5, z + w + 0.1, x + w - 0.6, groundY + belfry + 3.1, z + w + 0.3), stoneDark);
  // A steep roof, four pinnacles and a finial.
  const eaves = belfry + 3.6;
  bin.add(name, boxGeometry(x - w - 0.9, groundY + eaves, z - w - 0.9, x + w + 0.9, groundY + eaves + 0.5, z + w + 0.9), stoneDark);
  bin.add(name, coneGeometry(x, groundY + eaves + 0.5, z, w + 0.6, 7.5, 4), roof);
  bin.add(name, boxGeometry(x - 0.16, groundY + eaves + 8, z - 0.16, x + 0.16, groundY + eaves + 9.6, z + 0.16), dial);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = x + sx * (w + 0.5);
      const pz = z + sz * (w + 0.5);
      bin.add(name, boxGeometry(px - 0.3, groundY + eaves, pz - 0.3, px + 0.3, groundY + eaves + 1.6, pz + 0.3), stone);
      bin.add(name, coneGeometry(px, groundY + eaves + 1.6, pz, 0.42, 1.8, 4), roof);
    }
  }
  // A low hall along the waterward side, so the tower stands on something.
  if (!low) {
    bin.add(name, boxGeometry(x - 13, groundY, z + 1.5, x - w - 0.8, groundY + 7.5, z + 9.5), stone);
    bin.add(
      name,
      prismZ([[x - 13.4, groundY + 7.5], [x - (13 + w + 0.8) / 2, groundY + 10.2], [x - w - 0.4, groundY + 7.5]], z + 1.2, z + 9.8),
      roof,
    );
  }
}
