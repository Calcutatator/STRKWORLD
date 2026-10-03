/**
 * D-133: the ride's timeline and the rider's camera. Pure numbers, so this
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
  SWING_LOOK_MAX_YAW,
  SWING_LOOK_REST,
  SWING_SETTLE_MS,
  stepSwingLook,
  swingAngleAt,
  swingCameraShot,
  swingEnvelopeAt,
  swingRideOver,
  type SwingLookInput,
  type SwingLookState,
} from './roof-swing';

/** Every angle across a ride, sampled every 50 ms. */
function samples(reduced = false): number[] {
  const out: number[] = [];
  for (let t = 0; t <= SWING_RIDE_MS; t += 50) out.push(swingAngleAt(t, reduced));
  return out;
}

describe('the pendulum (D-133)', () => {
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

describe('reduced motion keeps the ride but takes the arcs out (D-133)', () => {
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

describe('the rider\'s camera (D-133)', () => {
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

describe('looking around from the seat (D-133, 2026-10-03)', () => {
  /** Run the spring for `ms` with one input, 16 ms at a time. */
  const hold = (
    input: SwingLookInput | null,
    ms: number,
    from: SwingLookState = SWING_LOOK_REST,
    reduced = false,
  ): { state: SwingLookState; yaws: number[] } => {
    let state = from;
    const yaws: number[] = [state.yaw];
    for (let t = 0; t < ms; t += 16) {
      state = stepSwingLook(state, input, 16, reduced);
      yaws.push(state.yaw);
    }
    return { state, yaws };
  };

  it('turns the head towards the key that is held, and no further than the limit', () => {
    const left = hold({ left: true }, 4_000);
    expect(left.state.yaw).toBeCloseTo(SWING_LOOK_MAX_YAW, 3);
    expect(Math.max(...left.yaws)).toBeLessThanOrEqual(SWING_LOOK_MAX_YAW);
    const right = hold({ right: true }, 4_000);
    expect(right.state.yaw).toBeCloseTo(-SWING_LOOK_MAX_YAW, 3);
    expect(Math.min(...right.yaws)).toBeGreaterThanOrEqual(-SWING_LOOK_MAX_YAW);
    // About 75 degrees either way: a seated turn, not an owl's.
    expect((SWING_LOOK_MAX_YAW * 180) / Math.PI).toBeCloseTo(75, 6);
  });

  it('moves smoothly: no step is a jump, and it never overshoots', () => {
    const { yaws } = hold({ left: true }, 3_000);
    let worst = 0;
    for (let i = 1; i < yaws.length; i += 1) worst = Math.max(worst, Math.abs(yaws[i]! - yaws[i - 1]!));
    // A frame turns the head by a fraction of a degree, not a snap to the limit.
    expect(worst).toBeLessThan(SWING_LOOK_MAX_YAW / 8);
    // Critically damped: it approaches the limit from below and stays there.
    expect(Math.max(...yaws)).toBeLessThanOrEqual(SWING_LOOK_MAX_YAW + 1e-9);
    for (let i = 1; i < yaws.length; i += 1) expect(yaws[i]).toBeGreaterThanOrEqual(yaws[i - 1]! - 1e-9);
  });

  it('eases back to centre when the key is let go, without snapping', () => {
    const turned = hold({ left: true }, 3_000).state;
    const back = hold(null, 3_000, turned);
    expect(back.state.yaw).toBeCloseTo(0, 2);
    expect(back.yaws[1]!).toBeLessThan(turned.yaw);
    expect(Math.abs(back.yaws[1]! - turned.yaw)).toBeLessThan(SWING_LOOK_MAX_YAW / 8);
    // It comes back the whole way, not to some lesser rest.
    expect(Math.abs(back.state.target)).toBeLessThan(1e-3);
  });

  it('both keys at once is neither: the head comes back to the middle', () => {
    const turned = hold({ left: true }, 3_000).state;
    const both = hold({ left: true, right: true }, 2_000, turned);
    expect(both.state.yaw).toBeCloseTo(0, 2);
  });

  it('turns with a horizontal drag too, and a drag right looks right', () => {
    const dragged = hold({ dragX: 6 }, 1_000);
    expect(dragged.state.yaw).toBeLessThan(0);
    expect(dragged.state.yaw).toBeGreaterThanOrEqual(-SWING_LOOK_MAX_YAW);
    const other = hold({ dragX: -6 }, 1_000);
    expect(other.state.yaw).toBeGreaterThan(0);
    // A drag that would spin the head round is clamped like a held key.
    const wild = hold({ dragX: 400 }, 1_000);
    expect(wild.state.yaw).toBeGreaterThanOrEqual(-SWING_LOOK_MAX_YAW);
  });

  it('is brisker under reduced motion, and still smooth', () => {
    const full = hold({ left: true }, 400).state.yaw;
    const reduced = hold({ left: true }, 400, SWING_LOOK_REST, true).state.yaw;
    expect(reduced).toBeGreaterThan(full);
    expect(reduced).toBeLessThanOrEqual(SWING_LOOK_MAX_YAW);
  });

  it('survives a stalled tab, a NaN frame and a nonsense state', () => {
    expect(stepSwingLook(SWING_LOOK_REST, { left: true }, Number.NaN).yaw).toBe(0);
    expect(stepSwingLook(SWING_LOOK_REST, { left: true }, -5).yaw).toBe(0);
    // One enormous frame is clamped, so a stall cannot fling the head.
    const stalled = stepSwingLook(SWING_LOOK_REST, { left: true }, 10_000);
    expect(Math.abs(stalled.yaw)).toBeLessThanOrEqual(SWING_LOOK_MAX_YAW);
    const nonsense = stepSwingLook(
      { yaw: Number.NaN, rate: Number.NaN, target: Number.NaN } as SwingLookState,
      null,
      16,
    );
    expect(Number.isFinite(nonsense.yaw)).toBe(true);
    expect(Object.isFrozen(nonsense)).toBe(true);
  });

  it('carries the head into the rider\'s camera, and nothing else of the shot', () => {
    const ahead = swingCameraShot(0.3, false, 0);
    const left = swingCameraShot(0.3, false, SWING_LOOK_MAX_YAW);
    const right = swingCameraShot(0.3, false, -SWING_LOOK_MAX_YAW);
    expect(left.yaw - ahead.yaw).toBeCloseTo(SWING_LOOK_MAX_YAW, 9);
    expect(right.yaw - ahead.yaw).toBeCloseTo(-SWING_LOOK_MAX_YAW, 9);
    // The pendulum still owns the pitch, and the shot is still the same shot.
    expect(left.pitch).toBe(ahead.pitch);
    expect(left.distance).toBe(ahead.distance);
    expect(left.aimHeight).toBe(ahead.aimHeight);
    // Reduced motion holds its still shot, but the head still turns it.
    expect(swingCameraShot(0.3, true, SWING_LOOK_MAX_YAW).yaw - swingCameraShot(0.3, true, 0).yaw)
      .toBeCloseTo(SWING_LOOK_MAX_YAW, 9);
    // And a wild yaw is clamped rather than pointing the camera anywhere.
    expect(swingCameraShot(0, false, 99).yaw).toBe(swingCameraShot(0, false, SWING_LOOK_MAX_YAW).yaw);
    expect(swingCameraShot(0, false, Number.NaN).yaw).toBe(SWING_CAMERA_YAW);
  });
});
