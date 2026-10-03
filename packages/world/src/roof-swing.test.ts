/**
 * D-132: the ride's timeline and the rider's camera. Pure numbers, so this
 * pins the shape of the pendulum rather than any drawing of it: it starts and
 * ends at rest whatever frame it is cut off at, it swings out over the south
 * edge, and reduced motion takes the arcs out without taking the ride out.
 */

import { describe, expect, it } from 'vitest';
import { SWING_RIDE_MS } from '@strkworld/shared';
import {
  SWING_BUILD_MS,
  SWING_CAMERA_PITCH,
  SWING_CAMERA_REDUCED_DISTANCE,
  SWING_CAMERA_REDUCED_PITCH,
  SWING_CAMERA_YAW,
  SWING_MAX_ANGLE,
  SWING_PERIOD_MS,
  SWING_REDUCED_MAX_ANGLE,
  SWING_REDUCED_SWAY_MS,
  SWING_SETTLE_MS,
  swingAngleAt,
  swingCameraShot,
  swingEnvelopeAt,
  swingRideOver,
} from './roof-swing';

/** Every angle across a ride, sampled every 50 ms. */
function samples(reduced = false): number[] {
  const out: number[] = [];
  for (let t = 0; t <= SWING_RIDE_MS; t += 50) out.push(swingAngleAt(t, reduced));
  return out;
}

describe('the pendulum (D-132)', () => {
  it('hangs still at both ends, so the seat is at rest before and after the ride', () => {
    expect(swingAngleAt(0)).toBe(0);
    expect(swingEnvelopeAt(0)).toBe(0);
    expect(swingAngleAt(SWING_RIDE_MS)).toBeCloseTo(0, 6);
    expect(swingEnvelopeAt(SWING_RIDE_MS)).toBeCloseTo(0, 6);
  });

  it('builds, holds its big arcs, then settles back', () => {
    // Small early...
    expect(swingEnvelopeAt(SWING_BUILD_MS / 4)).toBeLessThan(0.3);
    // ...full through the middle...
    expect(swingEnvelopeAt(SWING_BUILD_MS)).toBeCloseTo(1, 3);
    expect(swingEnvelopeAt(SWING_RIDE_MS / 2)).toBeCloseTo(1, 3);
    // ...and settling at the end.
    expect(swingEnvelopeAt(SWING_RIDE_MS - SWING_SETTLE_MS / 4)).toBeLessThan(0.3);
  });

  it('reaches its big arcs out over the south edge, and never past the maximum', () => {
    const all = samples();
    expect(Math.max(...all)).toBeGreaterThan(SWING_MAX_ANGLE * 0.9);
    expect(Math.max(...all)).toBeLessThanOrEqual(SWING_MAX_ANGLE);
    // Positive is out over the edge, so it goes both ways about hanging.
    expect(Math.min(...all)).toBeLessThan(-SWING_MAX_ANGLE * 0.9);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(-SWING_MAX_ANGLE);
  });

  it('swings out before it swings back: the first half-period is over the edge', () => {
    expect(swingAngleAt(SWING_PERIOD_MS / 4)).toBeGreaterThan(0);
    expect(swingAngleAt((3 * SWING_PERIOD_MS) / 4)).toBeLessThan(0);
  });

  it('makes a few big arcs in twenty seconds, not one and not a blur', () => {
    const all = samples();
    let crossings = 0;
    for (let i = 1; i < all.length; i += 1) {
      if (Math.sign(all[i] as number) !== Math.sign(all[i - 1] as number)) crossings += 1;
    }
    // Two zero crossings a period: a handful of arcs, as the lead asked.
    expect(crossings).toBeGreaterThanOrEqual(8);
    expect(crossings).toBeLessThanOrEqual(20);
  });

  it('clamps a time outside the ride rather than running on', () => {
    expect(swingAngleAt(-1000)).toBe(0);
    expect(swingAngleAt(Number.NaN)).toBe(0);
    expect(swingAngleAt(SWING_RIDE_MS * 3)).toBeCloseTo(swingAngleAt(SWING_RIDE_MS), 9);
  });

  it('knows when the timeline has run out', () => {
    expect(swingRideOver(0)).toBe(false);
    expect(swingRideOver(SWING_RIDE_MS - 1)).toBe(false);
    expect(swingRideOver(SWING_RIDE_MS)).toBe(true);
    expect(swingRideOver(Number.NaN)).toBe(false);
  });
});

describe('reduced motion keeps the ride but takes the arcs out (D-132)', () => {
  it('sways gently instead of arcing: an order of magnitude shallower', () => {
    const gentle = samples(true);
    const full = samples();
    expect(Math.max(...gentle.map(Math.abs))).toBeLessThanOrEqual(SWING_REDUCED_MAX_ANGLE);
    expect(Math.max(...gentle.map(Math.abs))).toBeLessThan(Math.max(...full.map(Math.abs)) / 5);
  });

  it('is over well before the ride is, and hangs still for the rest of it', () => {
    expect(swingEnvelopeAt(SWING_REDUCED_SWAY_MS, true)).toBeCloseTo(0, 6);
    expect(swingAngleAt(SWING_RIDE_MS * 0.8, true)).toBeCloseTo(0, 6);
    // The ride is still the server's full twenty seconds: the lock is unchanged.
    expect(SWING_REDUCED_SWAY_MS).toBeLessThan(SWING_RIDE_MS);
  });
});

describe('the rider\'s camera (D-132)', () => {
  it('turns south over the edge, the opposite of the world\'s fixed north-up yaw (D-059)', () => {
    expect(swingCameraShot(0).yaw).toBe(SWING_CAMERA_YAW);
    expect(SWING_CAMERA_YAW).toBeCloseTo(Math.PI, 9);
  });

  it('follows the arc: tipping up as the seat swings out, down as it comes back', () => {
    const out = swingCameraShot(SWING_MAX_ANGLE).pitch;
    const level = swingCameraShot(0).pitch;
    const back = swingCameraShot(-SWING_MAX_ANGLE).pitch;
    expect(level).toBeCloseTo(SWING_CAMERA_PITCH, 9);
    expect(out).toBeLessThan(level);
    expect(back).toBeGreaterThan(level);
  });

  it('sweeps rather than cuts while the motion is full', () => {
    expect(swingCameraShot(0.4).cut).toBe(false);
  });

  it('holds one still south-facing shot under reduced motion, and cuts to it', () => {
    const a = swingCameraShot(0, true);
    const b = swingCameraShot(SWING_MAX_ANGLE, true);
    // The angle is ignored: no sweep, no tilt, nothing that moves.
    expect(a).toEqual(b);
    expect(a.cut).toBe(true);
    expect(a.yaw).toBe(SWING_CAMERA_YAW);
    expect(a.pitch).toBe(SWING_CAMERA_REDUCED_PITCH);
    expect(a.distance).toBe(SWING_CAMERA_REDUCED_DISTANCE);
  });

  it('clamps a wild angle rather than pointing the camera anywhere', () => {
    expect(swingCameraShot(100).pitch).toBe(swingCameraShot(SWING_MAX_ANGLE).pitch);
    expect(swingCameraShot(Number.NaN).pitch).toBe(swingCameraShot(0).pitch);
  });

  it('returns a frozen shot, so no caller can edit the camera out from under the rig', () => {
    expect(Object.isFrozen(swingCameraShot(0))).toBe(true);
  });
});
