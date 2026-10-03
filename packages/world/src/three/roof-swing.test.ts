/**
 * D-133: the A-frame and its seat, as geometry. The steel merges into the
 * building's own bins (so it costs no draw call of its own); only the seat
 * is a separate object, because it has to move. What is pinned here is that
 * it hangs south of the deck out over the edge, that it swings like a
 * pendulum about one fixed pivot, and that it disposes cleanly.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, type Object3D } from 'three';
import { SWING_FRAME_TILES, SWING_SEAT_TILE } from '@strkworld/shared';
import { GeometryBin, ResourceBag } from './palette.js';
import {
  SWING_HANG,
  SWING_PIVOT_HEIGHT,
  SWING_PIVOT_REACH,
  SWING_RED,
  SWING_STEEL,
  SWING_EYE_AHEAD,
  SWING_EYE_HEIGHT,
  buildRoofSwing,
  swingFrameCentreGap,
  type RoofSwingView,
} from './roof-swing.js';
import { cameraOffset } from './camera-rig.js';
import {
  SWING_CAMERA_DISTANCE,
  SWING_CAMERA_REDUCED_DISTANCE,
  SWING_LOOK_MAX_YAW,
  SWING_MAX_ANGLE,
  SWING_REDUCED_MAX_ANGLE,
  swingCameraShot,
} from '../roof-swing.js';

/** The roof grid's origin in world units, and the deck's heights. */
const ORIGIN = { originX: 10, originZ: 20, deckY: 40, ledgeY: 40.3 };

function build(): { swing: RoofSwingView; bin: GeometryBin; res: ResourceBag } {
  const bin = new GeometryBin();
  const res = new ResourceBag();
  const swing = buildRoofSwing(bin, res, ORIGIN);
  return { swing, bin, res };
}

/** Every mesh under an object, the object itself included. */
function meshes(object: Object3D): Mesh[] {
  const out: Mesh[] = [];
  object.traverse((child) => {
    if ((child as Mesh).isMesh) out.push(child as Mesh);
  });
  return out;
}

const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('the lookout swing\'s A-frame (D-133)', () => {
  it('hangs its pivot south of the deck\'s south edge, out over the void', () => {
    const { swing } = build();
    const southEdge = ORIGIN.originZ + SWING_SEAT_TILE.y;
    // +z is south, so a pivot past the edge is cantilevered over it.
    expect(swing.pivot.z).toBeCloseTo(southEdge + SWING_PIVOT_REACH, 6);
    expect(swing.pivot.z).toBeGreaterThan(southEdge);
    expect(swing.pivot.y).toBeCloseTo(ORIGIN.deckY + SWING_PIVOT_HEIGHT, 6);
  });

  it('centres on the frame\'s footprint, as the shared seam gives it', () => {
    const { swing } = build();
    expect(swing.pivot.x).toBeCloseTo(
      ORIGIN.originX + SWING_FRAME_TILES.x + SWING_FRAME_TILES.width / 2,
      6,
    );
  });

  it('merges its steel into the building\'s own body bin, so the frame costs no draw call', () => {
    const { swing, bin } = build();
    // The A-frame went into the key the tower's walls already use...
    expect(bin.take('body')).not.toBeNull();
    // ...and the swinging seat is the one object of its own, because it moves.
    expect(meshes(swing.object)).toHaveLength(1);
  });

  it('paints black steel and a signal-red seat, as the reference does', () => {
    expect(SWING_STEEL).toBe(0x16181c);
    expect(SWING_RED).toBe(0xcf2230);
  });
});

describe('the pendulum, as geometry (D-133)', () => {
  it('hangs the rider straight below the pivot at rest', () => {
    const { swing } = build();
    const rest = swing.riderAt(0);
    expect(rest.x).toBeCloseTo(swing.pivot.x, 6);
    expect(rest.z).toBeCloseTo(swing.pivot.z, 6);
    expect(rest.y).toBeLessThan(swing.pivot.y);
  });

  it('swings the rider south, out over the edge, on a positive angle', () => {
    const { swing } = build();
    const out = swing.riderAt(0.9);
    expect(out.z).toBeGreaterThan(swing.pivot.z);
    // And back over the deck on a negative one.
    expect(swing.riderAt(-0.9).z).toBeLessThan(swing.pivot.z);
  });

  it('rises as it swings either way, as a pendulum does', () => {
    const { swing } = build();
    const rest = swing.riderAt(0).y;
    expect(swing.riderAt(0.9).y).toBeGreaterThan(rest);
    expect(swing.riderAt(-0.9).y).toBeGreaterThan(rest);
  });

  it('keeps the rider a fixed distance from the pivot: one arc, not a stretch', () => {
    const { swing } = build();
    const radius = distance(swing.pivot, swing.riderAt(0));
    for (const angle of [-0.95, -0.4, 0, 0.4, 0.95]) {
      expect(distance(swing.pivot, swing.riderAt(angle))).toBeCloseTo(radius, 6);
    }
  });

  it('never moves the rider sideways: the swing is in one plane', () => {
    const { swing } = build();
    for (const angle of [-0.95, 0.5, 0.95]) {
      expect(swing.riderAt(angle).x).toBeCloseTo(swing.pivot.x, 6);
    }
  });

  it('turns the seat about the pivot when the angle is set', () => {
    const { swing } = build();
    swing.setAngle(0);
    const rest = swing.object.rotation.x;
    swing.setAngle(0.8);
    expect(swing.object.rotation.x).not.toBeCloseTo(rest, 3);
    // The same angle always gives the same pose: no accumulation.
    swing.setAngle(0);
    expect(swing.object.rotation.x).toBeCloseTo(rest, 9);
  });

  it('ignores an angle that is not a finite number rather than losing the seat', () => {
    const { swing } = build();
    swing.setAngle(0.5);
    expect(() => swing.setAngle(Number.NaN)).not.toThrow();
    expect(Number.isFinite(swing.object.rotation.x)).toBe(true);
    expect(Number.isFinite(swing.riderAt(Number.NaN).y)).toBe(true);
  });

  it('hangs the seat the hanger\'s length below the pivot', () => {
    const { swing } = build();
    expect(swing.pivot.y - swing.riderAt(0).y).toBeGreaterThan(SWING_HANG * 0.5);
  });

  it('disposes without throwing, and twice is harmless', () => {
    const { swing } = build();
    expect(() => swing.dispose()).not.toThrow();
    expect(() => swing.dispose()).not.toThrow();
  });
});

describe('the ride looks past its own frame (D-133, amended 2026-10-03)', () => {
  /**
   * The lead's reviewer: "the ride's black A-frame upright and the rider's
   * back fill the middle of the frame". They did, because the shot stood
   * seven units behind the seat and looked back at it. The near-eye shot
   * looks *out*, and the rule is that no steel may cross the middle third of
   * the frame at any point of the swing or of the look-around — so this
   * samples both rather than trusting the one angle that was rendered.
   */
  const FOV = 50;
  const ASPECT = 16 / 9;
  /** Half the central third, as a fraction of half the frame's width. */
  const CENTRAL_THIRD = 1 / 3;

  const angles = [-SWING_MAX_ANGLE, -0.6, -0.3, -0.1, 0, 0.1, 0.3, 0.6, SWING_MAX_ANGLE];
  const yaws = [-SWING_LOOK_MAX_YAW, -0.8, -0.4, 0, 0.4, 0.8, SWING_LOOK_MAX_YAW];

  it('keeps the A-frame out of the central third, at every sampled angle and look', () => {
    const { swing, bin, res } = build();
    try {
      const worst: string[] = [];
      for (const angle of angles) {
        for (const yaw of yaws) {
          const shot = swingCameraShot(angle, false, yaw);
          const gap = swingFrameCentreGap(
            swing.frameParts,
            swing.eyeAt(angle),
            shot.yaw,
            shot.pitch,
            FOV,
            ASPECT,
          );
          if (gap < CENTRAL_THIRD) {
            worst.push(`angle ${angle.toFixed(2)} look ${yaw.toFixed(2)}: ${gap.toFixed(3)}`);
          }
        }
      }
      expect(worst).toEqual([]);
    } finally {
      swing.dispose();
      bin.dispose();
      res.dispose();
    }
  });

  it('keeps it out under reduced motion too, where the shot holds still', () => {
    const { swing, bin, res } = build();
    try {
      for (const angle of [-SWING_REDUCED_MAX_ANGLE, 0, SWING_REDUCED_MAX_ANGLE]) {
        for (const yaw of yaws) {
          const shot = swingCameraShot(angle, true, yaw);
          const gap = swingFrameCentreGap(swing.frameParts, swing.eyeAt(angle), shot.yaw, shot.pitch, FOV, ASPECT);
          expect(gap, `angle ${angle} look ${yaw}`).toBeGreaterThanOrEqual(CENTRAL_THIRD);
        }
      }
    } finally {
      swing.dispose();
      bin.dispose();
      res.dispose();
    }
  });

  it('would have failed on the shot it replaced: the check has teeth', () => {
    // The old shot stood seven units back along the same yaw and pitch and
    // looked at the seat. Put the lens there and the A-frame is across the
    // middle — which is the render the reviewer was looking at.
    const { swing, bin, res } = build();
    try {
      const shot = swingCameraShot(0, false, 0);
      const eye = swing.eyeAt(0);
      const back = cameraOffset(shot.yaw, shot.pitch, 7);
      const old = { x: eye.x + back.x, y: eye.y + back.y, z: eye.z + back.z };
      expect(swingFrameCentreGap(swing.frameParts, old, shot.yaw, shot.pitch, FOV, ASPECT)).toBeLessThan(
        CENTRAL_THIRD,
      );
    } finally {
      swing.dispose();
      bin.dispose();
      res.dispose();
    }
  });

  it('puts the lens on the rider, not behind them', () => {
    // The shot's own numbers: nothing between the eye and the view.
    expect(SWING_CAMERA_DISTANCE).toBe(0);
    expect(SWING_CAMERA_REDUCED_DISTANCE).toBe(0);
    expect(swingCameraShot(0, false, 0).distance).toBe(0);
    expect(swingCameraShot(0, true, 0).distance).toBe(0);
  });

  it('hangs the eye in the seat\'s own frame, so the sway is felt', () => {
    const { swing, bin, res } = build();
    try {
      const rest = swing.eyeAt(0);
      // At rest: head height above the board, a little forward of the axis.
      expect(rest.y).toBeCloseTo(swing.pivot.y - SWING_HANG + SWING_EYE_HEIGHT, 6);
      expect(rest.z).toBeCloseTo(swing.pivot.z + SWING_EYE_AHEAD, 6);
      // Swung out, it travels south and rises, as a point on the arc does.
      const out = swing.eyeAt(0.6);
      expect(out.z).toBeGreaterThan(rest.z);
      expect(out.y).toBeGreaterThan(rest.y);
      // And it keeps its distance from the pivot: one arc, not a stretch.
      expect(distance(out, swing.pivot)).toBeCloseTo(distance(rest, swing.pivot), 6);
      // Never sideways: the swing is in one plane.
      expect(out.x).toBeCloseTo(rest.x, 9);
      expect(swing.eyeAt(Number.NaN)).toEqual(rest);
    } finally {
      swing.dispose();
      bin.dispose();
      res.dispose();
    }
  });
});
