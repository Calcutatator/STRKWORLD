/**
 * The lookout swing's ride, as a timeline (D-131). Pure: no three.js, no DOM,
 * no clock. The session steps it, the view draws it and the camera follows
 * it, and all three read the same numbers.
 *
 * A ride is `SWING_RIDE_MS` long, the same length the lobby holds the lock
 * for. The pendulum is one sine at a fixed period under an envelope that
 * builds, holds its big arcs and settles back to rest, so the swing starts
 * and ends hanging still whatever frame the ride is cut off at.
 *
 * Positive is **out over the south edge**, away from the deck and behind the
 * north-facing camera (D-059).
 *
 * Reduced motion keeps the ride (the lock is the server's) but takes the
 * arcs out of it: a slow, shallow sway that fades to nothing, and a camera
 * that cuts to a still south-facing view instead of sweeping.
 */

import { SWING_RIDE_MS } from '@strkworld/shared';

/** One full back-and-forth, in ms. */
export const SWING_PERIOD_MS = 2_600;
/** The widest arc, in radians from hanging (about 54°). */
export const SWING_MAX_ANGLE = 0.95;
/** How long the arcs take to build to full, and how long they take to settle back. */
export const SWING_BUILD_MS = 5_000;
export const SWING_SETTLE_MS = 5_000;

/** Reduced motion: a slower, far shallower sway that fades out early. */
export const SWING_REDUCED_PERIOD_MS = 4_200;
export const SWING_REDUCED_MAX_ANGLE = 0.1;
export const SWING_REDUCED_BUILD_MS = 1_200;
/** The sway is over well before the ride is: the rest of it hangs still. */
export const SWING_REDUCED_SWAY_MS = 7_000;

/** Smoothstep on [0, 1]; anything outside is clamped. */
function ease(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function clampElapsed(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.min(elapsedMs, SWING_RIDE_MS);
}

/**
 * The arc's envelope at `elapsedMs`, 0..1: it builds over `SWING_BUILD_MS`,
 * holds, then settles over the last `SWING_SETTLE_MS`. 0 at both ends, so the
 * seat hangs still before the first push and after the last.
 */
export function swingEnvelopeAt(elapsedMs: number, reduced = false): number {
  const t = clampElapsed(elapsedMs);
  if (reduced) {
    const build = ease(t / SWING_REDUCED_BUILD_MS);
    const fade = ease((SWING_REDUCED_SWAY_MS - t) / SWING_REDUCED_BUILD_MS);
    return build * fade;
  }
  return ease(t / SWING_BUILD_MS) * ease((SWING_RIDE_MS - t) / SWING_SETTLE_MS);
}

/**
 * The pendulum's angle at `elapsedMs`, in radians; positive swings out over
 * the south edge. The sine starts at zero, so the ride begins from rest.
 */
export function swingAngleAt(elapsedMs: number, reduced = false): number {
  const t = clampElapsed(elapsedMs);
  const period = reduced ? SWING_REDUCED_PERIOD_MS : SWING_PERIOD_MS;
  const max = reduced ? SWING_REDUCED_MAX_ANGLE : SWING_MAX_ANGLE;
  return swingEnvelopeAt(t, reduced) * max * Math.sin((2 * Math.PI * t) / period);
}

/** Whether the ride's timeline has run out. */
export function swingRideOver(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= SWING_RIDE_MS;
}

// -- the rider's camera ------------------------------------------------------

/** Looking south, over the edge: the opposite of the world's fixed north-up yaw. */
export const SWING_CAMERA_YAW = Math.PI;
/** Shallow enough that the river, the station and the skyline fill the frame. */
export const SWING_CAMERA_PITCH = (15 * Math.PI) / 180;
/** How much of the arc the camera's pitch follows, in radians per radian of swing. */
export const SWING_CAMERA_TILT = 0.26;
export const SWING_CAMERA_DISTANCE = 7;
export const SWING_CAMERA_AIM_HEIGHT = 1.4;
/** Reduced motion holds one still shot: no tilt, a little further back. */
export const SWING_CAMERA_REDUCED_PITCH = (13 * Math.PI) / 180;
export const SWING_CAMERA_REDUCED_DISTANCE = 8;

/** Where the rider's camera stands this frame, for `CameraRig.update`'s shot. */
export interface SwingCameraShot {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly aimHeight: number;
  /** Cut to and from the shot rather than sweeping into it (reduced motion). */
  readonly cut: boolean;
}

/**
 * The rider's shot at a pendulum angle: south over the edge, tipping up as
 * the seat swings out and down as it comes back. Under reduced motion the
 * angle is ignored and the shot never moves.
 */
export function swingCameraShot(angle: number, reduced = false): SwingCameraShot {
  if (reduced) {
    return Object.freeze({
      yaw: SWING_CAMERA_YAW,
      pitch: SWING_CAMERA_REDUCED_PITCH,
      distance: SWING_CAMERA_REDUCED_DISTANCE,
      aimHeight: SWING_CAMERA_AIM_HEIGHT,
      cut: true,
    });
  }
  const swing = Number.isFinite(angle) ? Math.max(-SWING_MAX_ANGLE, Math.min(SWING_MAX_ANGLE, angle)) : 0;
  return Object.freeze({
    yaw: SWING_CAMERA_YAW,
    pitch: SWING_CAMERA_PITCH - SWING_CAMERA_TILT * swing,
    distance: SWING_CAMERA_DISTANCE,
    aimHeight: SWING_CAMERA_AIM_HEIGHT,
    cut: false,
  });
}
