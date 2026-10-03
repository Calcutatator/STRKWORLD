import { Group, type Object3D } from 'three';
import { SWING_FRAME_TILES, SWING_SEAT_TILE } from '@strkworld/shared';
import {
  GeometryBin,
  ResourceBag,
  beamGeometry,
  boxGeometry,
  flushBin,
  shade,
  standardMaterial,
} from './palette.js';

/**
 * The lookout swing on the Exchange tower's roof deck (D-132).
 *
 * A black steel A-frame standing on the deck's south ledge, its beam
 * cantilevered out past the balustrade, with a red two-seat swing hanging
 * from it over the edge — the ride overlooks the scene **behind** the
 * world's fixed north-facing camera (D-059), so the rider's own camera turns
 * to see it (see `../roof-swing.ts`).
 *
 * The frame is static and goes into the building's own merged bins, so it
 * costs no draw call. The seat swings, so it is one small group of its own
 * with a single merged mesh in it: one extra call for the whole ride, and
 * the object the press-E cues glow (D-123).
 *
 * Everything here is in world units with the roof's own origin passed in, so
 * the builder never has to know where the tower stands.
 */

/** The bin the A-frame's static steel goes into: the building's own body bin. */
const SWING_FRAME = 'body';
/** The seat's own bin, flushed into the swinging group. */
const SEAT = 'seat';

/** Signal red, as the reference swing's seat and hangers. */
export const SWING_RED = 0xcf2230;
/** The A-frame's steel: near-black, faintly blue. */
export const SWING_STEEL = 0x16181c;

/** How far the beam's pivot stands above the deck. */
export const SWING_PIVOT_HEIGHT = 3.05;
/** How far south of the deck's south tile edge the pivot is cantilevered. */
export const SWING_PIVOT_REACH = 1.9;
/** How far the A-frame's feet stand south of the deck's south tile edge. */
export const SWING_FOOT_REACH = 0.8;
/** Hanger length: pivot to the seat's top face. */
export const SWING_HANG = 1.7;
/** How far below the pivot the rider's feet sit. */
export const SWING_RIDER_DROP = 1.78;

export interface RoofSwingOptions {
  /** The roof grid's tile (0, 0) in world units (x east, z south). */
  readonly originX: number;
  readonly originZ: number;
  /** The deck's walking height, in world units. */
  readonly deckY: number;
  /** The ledge ring's top, where the A-frame's feet stand. */
  readonly ledgeY: number;
}

/** A point in world units. */
export interface SwingPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RoofSwingView {
  /** The swinging part: the seat, its hangers and the hinge. */
  readonly object: Object3D;
  /** Put the swing at this pendulum angle, radians; positive swings south, out over the edge. */
  setAngle(radians: number): void;
  /** Where the rider's feet go at an angle, in world units. */
  riderAt(radians: number): SwingPoint;
  /** The pivot the whole thing hangs from, in world units. */
  readonly pivot: SwingPoint;
  dispose(): void;
}

/**
 * Add the A-frame to `bins` (merged with the building that owns them) and
 * return the swinging seat as its own group, which the caller parents.
 */
export function buildRoofSwing(
  bins: GeometryBin,
  res: ResourceBag,
  options: RoofSwingOptions,
): RoofSwingView {
  const { originX, originZ, deckY, ledgeY } = options;
  // The frame's own footprint, as the shared seam gives it in roof tiles.
  const centreX = originX + SWING_FRAME_TILES.x + SWING_FRAME_TILES.width / 2;
  const southEdge = originZ + SWING_SEAT_TILE.y;
  const footZ = southEdge + SWING_FOOT_REACH;
  const pivotZ = southEdge + SWING_PIVOT_REACH;
  const pivotY = deckY + SWING_PIVOT_HEIGHT;
  const legHalf = SWING_FRAME_TILES.width / 2 - 0.2;

  // Two pairs of splayed legs leaning south, meeting under the beam's ends:
  // the A-frame. Black steel, square section, with a cross-brace each side.
  for (const side of [-1, 1] as const) {
    const footX = centreX + side * legHalf;
    const headX = centreX + side * 0.46;
    bins.add(SWING_FRAME, beamGeometry([footX, ledgeY, footZ], [headX, pivotY, pivotZ], 0.17, 0.17), SWING_STEEL);
    // A foot plate bolted to the ledge.
    bins.add(
      SWING_FRAME,
      boxGeometry(footX - 0.22, ledgeY - 0.02, footZ - 0.22, footX + 0.22, ledgeY + 0.07, footZ + 0.22),
      shade(SWING_STEEL, 0.06),
    );
    // The brace across the splay, a third of the way up.
    const braceT = 0.42;
    const bx = footX + (headX - footX) * braceT;
    const by = ledgeY + (pivotY - ledgeY) * braceT;
    const bz = footZ + (pivotZ - footZ) * braceT;
    bins.add(
      SWING_FRAME,
      beamGeometry([bx, by, bz], [centreX + side * 0.1, by + 0.1, bz], 0.09, 0.09),
      shade(SWING_STEEL, 0.05),
    );
  }
  // The beam the swing hangs from, across the apex, and its two hubs.
  bins.add(SWING_FRAME, beamGeometry([centreX - 0.95, pivotY, pivotZ], [centreX + 0.95, pivotY, pivotZ], 0.2, 0.2), SWING_STEEL);
  for (const side of [-1, 1] as const) {
    const hubX = centreX + side * 0.62;
    bins.add(
      SWING_FRAME,
      beamGeometry([hubX - 0.14, pivotY, pivotZ], [hubX + 0.14, pivotY, pivotZ], 0.27, 0.27),
      shade(SWING_STEEL, 0.12),
    );
  }
  // A back stay from each leg head down onto the ledge, so the frame reads
  // as held against the pull of the swing rather than standing in the air.
  for (const side of [-1, 1] as const) {
    bins.add(
      SWING_FRAME,
      beamGeometry(
        [centreX + side * 0.46, pivotY - 0.2, pivotZ],
        [centreX + side * (legHalf + 0.25), ledgeY, southEdge + 0.12],
        0.1,
        0.1,
      ),
      shade(SWING_STEEL, -0.04),
    );
  }

  // The swinging part, in its own group so one rotation moves all of it.
  const group = new Group();
  group.name = 'roof:swing';
  group.position.set(centreX, pivotY, pivotZ);
  const seat = new GeometryBin();
  try {
    const drop = -SWING_HANG;
    // Two red hanger bars, one each side, with their collars.
    for (const side of [-1, 1] as const) {
      const x = side * 0.62;
      seat.add(SEAT, boxGeometry(x - 0.055, drop, -0.055, x + 0.055, 0.1, 0.055), SWING_RED);
      for (const y of [drop * 0.35, drop * 0.7]) {
        seat.add(SEAT, boxGeometry(x - 0.085, y - 0.05, -0.085, x + 0.085, y + 0.05, 0.085), shade(SWING_RED, -0.1));
      }
    }
    // The cross tube the two seats hang off, just under the hinge.
    seat.add(SEAT, beamGeometry([-0.75, -0.16, 0], [0.75, -0.16, 0], 0.2, 0.2), shade(SWING_RED, 0.08));
    // The bench: two seats side by side on one red frame, a back rail and a
    // foot bar, as the reference's two-seater.
    seat.add(SEAT, boxGeometry(-0.78, drop - 0.12, -0.3, 0.78, drop, 0.3), SWING_RED);
    for (const side of [-1, 1] as const) {
      seat.add(SEAT, boxGeometry(side * 0.04, drop, -0.28, side * 0.72, drop + 0.06, 0.28), shade(SWING_RED, 0.1));
    }
    // The grab rail across the front, on two short stanchions.
    seat.add(SEAT, boxGeometry(-0.8, drop + 0.42, 0.26, 0.8, drop + 0.5, 0.34), shade(SWING_RED, 0.14));
    for (const x of [-0.74, 0.74]) {
      seat.add(SEAT, boxGeometry(x - 0.04, drop, 0.26, x + 0.04, drop + 0.46, 0.34), shade(SWING_RED, -0.05));
    }
    // The foot bar the rider's shoes rest on, swung a little forward.
    seat.add(SEAT, boxGeometry(-0.66, drop - 0.52, 0.18, 0.66, drop - 0.46, 0.3), shade(SWING_RED, -0.12));
    const material = res.material(standardMaterial({ roughness: 0.55, metalness: 0.1 }));
    flushBin(seat, SEAT, material, res, group, { name: 'roof:swing:seat', cast: true, receive: true });
  } finally {
    seat.dispose();
  }

  let disposed = false;
  return {
    object: group,
    pivot: Object.freeze({ x: centreX, y: pivotY, z: pivotZ }),
    setAngle(radians: number): void {
      if (disposed) return;
      // Rotating about +X by -θ carries a hanging point south (+z) for θ > 0.
      group.rotation.x = Number.isFinite(radians) ? -radians : 0;
    },
    riderAt(radians: number): SwingPoint {
      const angle = Number.isFinite(radians) ? radians : 0;
      return Object.freeze({
        x: centreX,
        y: pivotY - SWING_RIDER_DROP * Math.cos(angle),
        z: pivotZ + SWING_RIDER_DROP * Math.sin(angle),
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
    },
  };
}

