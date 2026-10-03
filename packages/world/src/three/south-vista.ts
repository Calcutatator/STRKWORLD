import { Group } from 'three';
import { GeometryBin, ResourceBag, boxGeometry, flatQuad, flushBin, shade, standardMaterial } from './palette.js';

/**
 * ⚠ PLACEHOLDER — DELETE THIS FILE ON MERGE, take `origin/main`'s.
 *
 * The river, the station and the skyline south of the map, which the roof's
 * lookout swing looks out over (D-131). This branch was cut before the real
 * module existed, so this stand-in was written only so the branch compiled
 * and rendered something plausible behind the ride.
 *
 * **The real module has since landed on `origin/main` as D-124**, exporting
 * exactly the `createSouthVista` / `SouthVista` signature below. **The
 * integrator takes `origin/main`'s version of this file wholesale** — there
 * is nothing here worth keeping, and the mount in `presenter.ts` needs no
 * change, because the seam is identical.
 *
 * What it draws, in one merged mesh: a flat blue water plane past the map's
 * southern outskirts, and one long silhouette with a stepped arched roof on
 * its far bank. No detail, no quality tiers, no animation.
 */

/** Where the water starts and ends, in world units south of the map's origin. */
const WATER_NEAR = 70;
const WATER_FAR = 132;
/** How far the vista runs east and west of the map. */
const WATER_WEST = -80;
const WATER_EAST = 200;
/** The long arched hall on the far bank: its near edge, length, depth and height. */
const HALL_Z = 134;
const HALL_WIDTH = 74;
const HALL_DEPTH = 13;
const HALL_HEIGHT = 7.5;

const WATER = 0x5a7f9c;
const HALL = 0x6c7482;
const BANK = 0x76806d;

const VISTA = 'vista';

export interface SouthVistaOptions {
  readonly quality?: 'low' | 'high';
  readonly reducedMotion?: boolean;
}

export interface SouthVista {
  readonly group: Group;
  update(elapsedMs: number): void;
  dispose(): void;
}

export function createSouthVista(options: SouthVistaOptions = {}): SouthVista {
  // The real module reads these; the placeholder draws the same thing either way.
  void options;
  const group = new Group();
  group.name = 'south-vista';
  const res = new ResourceBag();
  const bin = new GeometryBin();
  try {
    bin.add(VISTA, flatQuad(WATER_WEST, WATER_NEAR, WATER_EAST, WATER_FAR, 0.02), WATER);
    // The far bank, and the long hall standing on it as one silhouette: a
    // low block under a stepped arch, so the skyline is not a flat box.
    bin.add(VISTA, flatQuad(WATER_WEST, WATER_FAR, WATER_EAST, WATER_FAR + 40, 1.21), shade(BANK, -0.04));
    bin.add(VISTA, boxGeometry(WATER_WEST, 0, WATER_FAR, WATER_EAST, 1.2, WATER_FAR + 40), BANK);
    const centre = (WATER_WEST + WATER_EAST) / 2;
    const x0 = centre - HALL_WIDTH / 2;
    const x1 = centre + HALL_WIDTH / 2;
    bin.add(VISTA, boxGeometry(x0, 1.2, HALL_Z, x1, 1.2 + HALL_HEIGHT * 0.55, HALL_Z + HALL_DEPTH), HALL);
    for (let step = 1; step <= 4; step += 1) {
      const inset = (HALL_DEPTH / 2) * (step / 5);
      const low = 1.2 + HALL_HEIGHT * (0.55 + 0.45 * ((step - 1) / 4));
      const high = 1.2 + HALL_HEIGHT * (0.55 + 0.45 * (step / 4));
      bin.add(VISTA, boxGeometry(x0, low, HALL_Z + inset, x1, high, HALL_Z + HALL_DEPTH - inset), shade(HALL, 0.03 * step));
    }
    flushBin(bin, VISTA, res.material(standardMaterial({ roughness: 0.92 })), res, group, {
      name: 'south-vista:placeholder',
      cast: false,
      receive: false,
    });
  } catch (error) {
    bin.dispose();
    res.dispose();
    throw error;
  }
  bin.dispose();

  let disposed = false;
  return {
    group,
    update(): void {
      // The placeholder does not animate; the real vista will.
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
      res.dispose();
    },
  };
}
