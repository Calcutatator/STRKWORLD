import { Group, type ColorRepresentation, type Object3D } from 'three';
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
import type { SeatPlace } from './types.js';
import { cameraOffset } from './camera-rig.js';

/**
 * The lookout swing on the Exchange tower's roof deck (D-133).
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

/**
 * The seat, in the swinging group's own frame: x across, **y measured from
 * the board's top face** (the plane a rider's hips rest on, `SWING_HANG`
 * below the pivot), z south-positive with the hanging axis at z = 0.
 *
 * These are the numbers the geometry below is built from *and* the numbers
 * the offline fit check measures the sixteen looks against
 * (`tools/swing-fit.ts`), so the two can never describe different seats.
 */
export const SWING_SEAT = Object.freeze({
  /** Half the bench's width: wide enough for two, and to clear the widest shoulders. */
  halfWidth: 0.72,
  /** Where the hanger bars come down, each side. */
  hangerX: 0.76,
  /**
   * The board, and why it is a bench rather than a plank.
   *
   * A seated figure here sits the way D-127's seat system poses one: its legs
   * are one rigid box each from hip to sole, so they cannot bend at the knee,
   * and a sit a one-piece leg can hold is **thighs level along the seat**.
   * Measured across the sixteen, that lays the legs from 0.10 behind the
   * hanging axis to 0.32 in front of it and puts the hip band on top of them,
   * so the board has to carry all of that or the rider is sitting on air.
   * (It used to be a 0.48 plank for a pose whose legs hung off the front; that
   * pose is gone, and so is the plank.)
   */
  boardBack: -0.34,
  boardFront: 0.4,
  boardThickness: 0.09,
  /**
   * The backrest bar, on a post at each back corner: close enough behind the
   * rider's back to be what they lean on, and low enough that a cloak hangs
   * over it rather than being speared by it.
   */
  backrestBack: -0.46,
  backrestFront: -0.38,
  backrestLow: 0.2,
  backrestHigh: 0.44,
  /** How far either side of the middle the two backrests stop: the seats' division. */
  backrestGap: 0.09,
  /**
   * The grab rail: a bar across the front at the height a seated hand falls
   * to, clear of the longest legs lying on the board. With the legs out along
   * the seat this is the lap bar of a chairlift rather than a rail under the
   * knees, which is the only place a hand can reach that the legs are not.
   */
  railBack: 0.42,
  railFront: 0.5,
  railLow: 0.2,
  railHigh: 0.3,
});

/**
 * The swing's board as a seat, in the one form every seat in the World uses
 * (D-127, adopted here 2026-10-03).
 *
 * `surface` is **0**: the rider's figure is placed with its own ground plane on
 * the board's top face, and the figure raises itself onto the board from
 * there, because `avatarSeatedContact()` is negative for every look — a
 * seated figure's weight-bearing underside hangs a little below the plane its
 * feet otherwise stand on, and by how much is the look's own business.
 *
 * This replaces the drop this branch measured for itself. One seat system now
 * seats the plaza bench, the arena tiers, the throne and the swing, and the
 * sixteen looks' spread is handled once, in the figure, instead of twice.
 */
export const ROOF_SWING_SEAT: SeatPlace = Object.freeze({
  surface: 0,
  front: SWING_SEAT.boardFront,
});

/**
 * How far below the pivot the rider's figure is placed: the board's top face,
 * which with `ROOF_SWING_SEAT.surface` of 0 is where the rider's own ground
 * plane goes. Every look gets the same drop and lands on the board.
 */
export const SWING_RIDER_DROP = SWING_HANG + ROOF_SWING_SEAT.surface;

/**
 * Where the rider's eye is, in the seat's own frame (D-133, amended
 * 2026-10-03): `y` above the board's top face, `z` south of the hanging axis.
 *
 * It is the ride's camera. Head height, and forward of where a head sits, so
 * the lens looks out over the rail rather than through the rider — and
 * because it lives in the *seat's* frame it leans and travels with the
 * pendulum, which is what keeps the sway in the shot.
 *
 * `SWING_EYE_AHEAD` is what it is for a measured reason. The A-frame straddles
 * the deck, so when the swing is back at its northmost the rider is **inside**
 * the frame's footprint, and a head turned hard over then looks straight into
 * a splayed leg. At 0.18 — a real head's place — that leg crosses the middle
 * of the frame; from 0.5 forward it never comes nearer the centre than half
 * the way out, which is the edge framing the lead allowed. 0.52, with the
 * margin (`roof-swing.test.ts` samples the whole arc against the whole look).
 *
 * The height is a compromise across sixteen looks whose seated heads top out
 * anywhere from 1.0 to 1.7 above the board; the rider's own figure is hidden
 * from this camera when the lens is inside it (`presenter.ts`), so the
 * compromise costs a view of their own hair rather than a clipped face.
 */
export const SWING_EYE_HEIGHT = 1.18;
export const SWING_EYE_AHEAD = 0.52;

/**
 * How near the middle of the ride's frame the A-frame's steel comes, as a
 * fraction of half the frame's width: 0 is dead centre, 1 is the edge, and
 * anything at or past 1 is off screen altogether (D-133, amended 2026-10-03).
 *
 * This is the lead's actual complaint, measured: in the first cut of the ride
 * the camera stood seven units behind the seat, so the black upright ran
 * straight down the middle of every frame. The near-eye shot puts the whole
 * frame behind the lens instead, and this is what proves it — for sampled
 * swing angles and head yaws, not just the one that was rendered.
 *
 * `parts` are the A-frame's world-space boxes (`RoofSwingView.frameParts`),
 * `eye` the lens (`eyeAt`), and `yaw`/`pitch` the shot's own angles, read the
 * same way `cameraOffset` reads them. Returns `Infinity` when no steel is in
 * front of the lens at all, which is the usual answer.
 */
export function swingFrameCentreGap(
  parts: readonly SwingSeatPart[],
  eye: SwingPoint,
  yaw: number,
  pitch: number,
  fovDegrees: number,
  aspect: number,
): number {
  // The lens basis: forward is the negative of the rig's own camera offset,
  // right is forward turned a quarter turn in the ground plane.
  const back = cameraOffset(yaw, pitch, 1);
  const forward = { x: -back.x, y: -back.y, z: -back.z };
  const flat = Math.hypot(forward.x, forward.z) || 1;
  const right = { x: forward.z / flat, y: 0, z: -forward.x / flat };
  // Up completes the basis: right × forward.
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  const halfHeight = Math.tan((fovDegrees * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  /** A point in lens space: depth along the view, and offsets across and up it. */
  const look = (x: number, y: number, z: number): { depth: number; across: number; rise: number } => {
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dz = z - eye.z;
    return {
      depth: dx * forward.x + dy * forward.y + dz * forward.z,
      across: dx * right.x + dy * right.y + dz * right.z,
      rise: dx * up.x + dy * up.y + dz * up.z,
    };
  };
  const NEAR = 1e-3;
  let gap = Infinity;
  for (const part of parts) {
    const corners: Array<{ depth: number; across: number; rise: number }> = [];
    for (const x of [part.min[0], part.max[0]]) {
      for (const y of [part.min[1], part.max[1]]) {
        for (const z of [part.min[2], part.max[2]]) corners.push(look(x, y, z));
      }
    }
    // Only what is in front of the lens can be in the frame. A box with
    // corners on both sides is clipped at the near plane along each of its
    // twelve edges, so a beam passing beside the lens is not mistaken for one
    // across it.
    const seen = corners.filter((corner) => corner.depth > NEAR);
    if (seen.length === 0) continue;
    const points = [...seen];
    if (seen.length < corners.length) {
      for (let a = 0; a < corners.length; a += 1) {
        for (let b = a + 1; b < corners.length; b += 1) {
          const from = corners[a]!;
          const to = corners[b]!;
          if (from.depth > NEAR === to.depth > NEAR) continue;
          const t = (NEAR - from.depth) / (to.depth - from.depth);
          points.push({
            depth: NEAR,
            across: from.across + (to.across - from.across) * t,
            rise: from.rise + (to.rise - from.rise) * t,
          });
        }
      }
    }
    // Steel above or below the frame is not in it, however wide it is.
    const rises = points.map((point) => point.rise / (point.depth * halfHeight));
    if (Math.min(...rises) > 1 || Math.max(...rises) < -1) continue;
    let lowest = Infinity;
    for (const point of points) lowest = Math.min(lowest, Math.abs(point.across) / (point.depth * halfWidth));
    // A box with steel on both sides of the centre line covers it, whatever
    // its corners measure on their own.
    const left = points.some((point) => point.across < 0);
    const rightward = points.some((point) => point.across > 0);
    gap = Math.min(gap, left && rightward ? 0 : lowest);
  }
  return gap;
}

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

/**
 * One box of the seat, in the swinging group's frame (y from the board's top
 * face). The builder emits these and the fit check reads them, so a rider
 * can never be checked against a seat that is not the one on the roof.
 */
export interface SwingSeatPart {
  readonly name: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface RoofSwingView {
  /** The swinging part: the seat, its hangers and the hinge. */
  readonly object: Object3D;
  /** Put the swing at this pendulum angle, radians; positive swings south, out over the edge. */
  setAngle(radians: number): void;
  /**
   * Where the rider's figure stands at an angle, in world units: the point
   * its own origin goes to. `drop` is how far below the pivot that is, which
   * for a rider is `SWING_RIDER_DROP` — the board's top face — because the
   * figure raises itself onto the seat from there (`ROOF_SWING_SEAT`).
   */
  riderAt(radians: number, drop?: number): SwingPoint;
  /**
   * Where the rider's eye is at an angle, in world units: the ride's own
   * camera. It hangs in the seat's frame, so it leans and travels with the
   * pendulum (`SWING_EYE_HEIGHT`, `SWING_EYE_AHEAD`).
   */
  eyeAt(radians: number): SwingPoint;
  /** The pivot the whole thing hangs from, in world units. */
  readonly pivot: SwingPoint;
  /** The seat's boxes, for the offline fit check. */
  readonly seatParts: readonly SwingSeatPart[];
  /** The A-frame's boxes, in world units: what a rider must never reach. */
  readonly frameParts: readonly SwingSeatPart[];
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
  const parts: SwingSeatPart[] = [];
  const frameParts: SwingSeatPart[] = [];
  /**
   * The world-space boxes a frame member occupies, for the fit check. A
   * leaning beam is recorded as a short run of boxes along its length rather
   * than as one box round the whole diagonal, which would swallow most of
   * the air beside it and fail riders who never go near the steel.
   */
  const framePart = (
    name: string,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    half: number,
    segments = 12,
  ): void => {
    for (let i = 0; i < segments; i += 1) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const at = (t: number, axis: number): number => a[axis]! + (b[axis]! - a[axis]!) * t;
      frameParts.push({
        name,
        min: [
          Math.min(at(t0, 0), at(t1, 0)) - half,
          Math.min(at(t0, 1), at(t1, 1)) - half,
          Math.min(at(t0, 2), at(t1, 2)) - half,
        ],
        max: [
          Math.max(at(t0, 0), at(t1, 0)) + half,
          Math.max(at(t0, 1), at(t1, 1)) + half,
          Math.max(at(t0, 2), at(t1, 2)) + half,
        ],
      });
    }
  };

  // Two pairs of splayed legs leaning south, meeting under the beam's ends:
  // the A-frame. Black steel, square section, with a cross-brace each side.
  for (const side of [-1, 1] as const) {
    const footX = centreX + side * legHalf;
    const headX = centreX + side * 0.46;
    bins.add(SWING_FRAME, beamGeometry([footX, ledgeY, footZ], [headX, pivotY, pivotZ], 0.17, 0.17), SWING_STEEL);
    framePart('leg', [footX, ledgeY, footZ], [headX, pivotY, pivotZ], 0.085);
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
    framePart('brace', [bx, by, bz], [centreX + side * 0.1, by + 0.1, bz], 0.045, 4);
  }
  // The beam the swing hangs from, across the apex, and a hub over each
  // hanger — the bench is as wide as two riders, so the beam is too.
  const beamHalf = SWING_SEAT.hangerX + 0.17;
  bins.add(SWING_FRAME, beamGeometry([centreX - beamHalf, pivotY, pivotZ], [centreX + beamHalf, pivotY, pivotZ], 0.2, 0.2), SWING_STEEL);
  framePart('beam', [centreX - beamHalf, pivotY, pivotZ], [centreX + beamHalf, pivotY, pivotZ], 0.1, 1);
  for (const side of [-1, 1] as const) {
    const hubX = centreX + side * SWING_SEAT.hangerX;
    bins.add(
      SWING_FRAME,
      beamGeometry([hubX - 0.14, pivotY, pivotZ], [hubX + 0.14, pivotY, pivotZ], 0.27, 0.27),
      shade(SWING_STEEL, 0.12),
    );
    framePart('hub', [hubX - 0.14, pivotY, pivotZ], [hubX + 0.14, pivotY, pivotZ], 0.135, 1);
  }
  // A back stay from each leg head down onto the ledge, so the frame reads
  // as held against the pull of the swing rather than standing in the air.
  for (const side of [-1, 1] as const) {
    const from: readonly [number, number, number] = [centreX + side * 0.46, pivotY - 0.2, pivotZ];
    const to: readonly [number, number, number] = [centreX + side * (legHalf + 0.25), ledgeY, southEdge + 0.12];
    bins.add(SWING_FRAME, beamGeometry(from, to, 0.1, 0.1), shade(SWING_STEEL, -0.04));
    framePart('stay', from, to, 0.05);
  }

  // The swinging part, in its own group so one rotation moves all of it.
  const group = new Group();
  group.name = 'roof:swing';
  group.position.set(centreX, pivotY, pivotZ);
  const seat = new GeometryBin();
  try {
    const drop = -SWING_HANG;
    const S = SWING_SEAT;
    // Every part of the seat, as the fit check reads it: a name and a box in
    // the group's frame, with y measured down from the pivot.
    const part = (
      name: string,
      x0: number, y0: number, z0: number,
      x1: number, y1: number, z1: number,
      colour: ColorRepresentation,
    ): void => {
      seat.add(SEAT, boxGeometry(x0, drop + y0, z0, x1, drop + y1, z1), colour);
      parts.push({ name, min: [x0, y0, z0], max: [x1, y1, z1] });
    };
    // Two red hanger bars, one each side, with their collars. Set wide enough
    // that the broadest shoulders on the bench never meet them.
    for (const side of [-1, 1] as const) {
      const x = side * S.hangerX;
      part('hanger', x - 0.055, 0, -0.055, x + 0.055, SWING_HANG + 0.1, 0.055, SWING_RED);
      for (const y of [SWING_HANG * 0.35, SWING_HANG * 0.7]) {
        seat.add(SEAT, boxGeometry(x - 0.085, drop + y - 0.05, -0.085, x + 0.085, drop + y + 0.05, 0.085), shade(SWING_RED, -0.1));
      }
    }
    // The cross tube the bench hangs off, just under the hinge.
    seat.add(SEAT, beamGeometry([-S.hangerX - 0.1, -0.16, 0], [S.hangerX + 0.1, -0.16, 0], 0.2, 0.2), shade(SWING_RED, 0.08));
    // The bench: one board wide enough for two, with a cushion over it.
    part('board', -S.halfWidth, -S.boardThickness, S.boardBack, S.halfWidth, 0, S.boardFront, SWING_RED);
    for (const side of [-1, 1] as const) {
      seat.add(
        SEAT,
        boxGeometry(side * 0.03, drop, S.boardBack + 0.02, side * (S.halfWidth - 0.06), drop + 0.06, S.boardFront - 0.02),
        shade(SWING_RED, 0.1),
      );
    }
    // A backrest bar over each seat, on a post at each back corner. Two, not
    // one: the gap down the middle is the division between the two seats,
    // and it is also where a tail curls up behind a rider sitting centrally.
    for (const side of [-1, 1] as const) {
      const inner = side * S.backrestGap;
      const outer = side * S.halfWidth;
      part(
        'backrest',
        Math.min(inner, outer), S.backrestLow, S.backrestBack,
        Math.max(inner, outer), S.backrestHigh, S.backrestFront,
        shade(SWING_RED, 0.14),
      );
      const x = side * (S.halfWidth - 0.06);
      part('post', x - 0.04, 0, S.backrestBack, x + 0.04, S.backrestHigh, S.backrestFront, shade(SWING_RED, -0.05));
    }
    // The grab rail across the front, at the height a seated hand falls to,
    // on two stanchions standing off the board's front corners.
    part('rail', -S.halfWidth, S.railLow, S.railBack, S.halfWidth, S.railHigh, S.railFront, shade(SWING_RED, 0.14));
    for (const side of [-1, 1] as const) {
      const x = side * (S.halfWidth - 0.06);
      part('stanchion', x - 0.04, -S.boardThickness, S.railBack, x + 0.04, S.railLow, S.railFront, shade(SWING_RED, -0.05));
    }
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
    seatParts: Object.freeze(parts),
    frameParts: Object.freeze(frameParts),
    riderAt(radians: number, drop = SWING_RIDER_DROP): SwingPoint {
      const angle = Number.isFinite(radians) ? radians : 0;
      const reach = Number.isFinite(drop) ? drop : SWING_RIDER_DROP;
      return Object.freeze({
        x: centreX,
        y: pivotY - reach * Math.cos(angle),
        z: pivotZ + reach * Math.sin(angle),
      });
    },
    eyeAt(radians: number): SwingPoint {
      const angle = Number.isFinite(radians) ? radians : 0;
      // The eye in the seat's frame, carried round the pivot with it: the
      // group turns about +X by -angle, so (y, z) goes to
      // (y cos a + z sin a, -y sin a + z cos a).
      const y = SWING_EYE_HEIGHT - SWING_HANG;
      const z = SWING_EYE_AHEAD;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return Object.freeze({
        x: centreX,
        y: pivotY + y * cos + z * sin,
        z: pivotZ - y * sin + z * cos,
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

