/**
 * The lookout swing's ride, as a timeline (D-133). Pure: no three.js, no DOM,
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
 *
 * The rider may also look around while they sit (D-133, 2026-10-03): the
 * left and right keys turn their head, and the camera goes with it. That is
 * the second half of this module — a critically damped spring on one yaw,
 * stepped from held keys or a horizontal drag, with the same no-clock,
 * no-DOM discipline as the pendulum.
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

// -- looking around from the seat --------------------------------------------

/**
 * How far the rider may turn their head either way: about 75°, which is as
 * far as a seated person turns without turning their shoulders too.
 */
export const SWING_LOOK_MAX_YAW = (75 * Math.PI) / 180;
/**
 * The head's spring, in radians per second of natural frequency. Critically
 * damped, so the head never overshoots and never jitters: holding a key eases
 * it out to the limit in about three quarters of a second, and letting go
 * eases it back to centre the same way.
 */
export const SWING_LOOK_FREQUENCY = 5.2;
/** Reduced motion keeps the turn — brisker, so less of the ride is spent moving. */
export const SWING_LOOK_REDUCED_FREQUENCY = 8;
/** How far one screen pixel of horizontal drag turns the head (touch). */
export const SWING_LOOK_DRAG_PER_PIXEL = (0.26 * Math.PI) / 180;
/** With nothing held and nothing dragged, the head's goal falls back to centre. */
export const SWING_LOOK_RETURN_MS = 220;
/** A stalled tab delivers one enormous frame; the head steps at most this much of it. */
const MAX_LOOK_STEP_MS = 50;

/** What the player is doing with the look controls this frame. */
export interface SwingLookInput {
  /** The left key (A or ArrowLeft) is held: turn the head to the rider's left. */
  readonly left?: boolean;
  /** The right key (D or ArrowRight) is held. */
  readonly right?: boolean;
  /** Horizontal drag since the last frame, in screen pixels; right drags look right. */
  readonly dragX?: number;
}

/**
 * The head's state between frames: where it points, how fast it is turning,
 * and where it is heading. Positive yaw is the rider's left (east, with the
 * seat facing south), which is also the figure's own `headYaw`.
 */
export interface SwingLookState {
  readonly yaw: number;
  readonly rate: number;
  readonly target: number;
}

/** Facing straight ahead, still: where every ride starts and ends. */
export const SWING_LOOK_REST: SwingLookState = Object.freeze({ yaw: 0, rate: 0, target: 0 });

function clampLook(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-SWING_LOOK_MAX_YAW, Math.min(SWING_LOOK_MAX_YAW, value));
}

/**
 * Step the head one frame.
 *
 * A held key sets the goal at the limit on that side (both or neither: the
 * centre), a drag nudges it, and with no input at all the goal decays back to
 * centre. The yaw itself only ever reaches the goal through the spring, so
 * nothing here can snap — not a key pressed and released inside one frame,
 * not a flung drag, not a frame that arrives late.
 */
export function stepSwingLook(
  state: SwingLookState,
  input: SwingLookInput | null,
  deltaMs: number,
  reduced = false,
): SwingLookState {
  const seconds = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, MAX_LOOK_STEP_MS) / 1000 : 0;
  const yaw0 = clampLook(state?.yaw ?? 0);
  const rate0 = Number.isFinite(state?.rate) ? (state as SwingLookState).rate : 0;
  const left = input?.left === true;
  const right = input?.right === true;
  const drag = Number.isFinite(input?.dragX) ? (input as SwingLookInput).dragX as number : 0;
  let target = clampLook(state?.target ?? 0);
  if (left !== right) {
    target = left ? SWING_LOOK_MAX_YAW : -SWING_LOOK_MAX_YAW;
  } else if (left && right) {
    // Both ways at once is neither: the head comes back to centre.
    target = 0;
  } else if (drag !== 0) {
    target = clampLook(target - drag * SWING_LOOK_DRAG_PER_PIXEL);
  } else {
    // Nothing held: the goal eases back to centre, and the spring follows it.
    target *= Math.exp(-(seconds * 1000) / SWING_LOOK_RETURN_MS);
    if (Math.abs(target) < 1e-4) target = 0;
  }
  if (seconds === 0) return Object.freeze({ yaw: yaw0, rate: rate0, target });
  const omega = reduced ? SWING_LOOK_REDUCED_FREQUENCY : SWING_LOOK_FREQUENCY;
  // Critically damped, stepped semi-implicitly: stable at any frame length
  // this clamps to, and it never crosses the goal.
  let rate = rate0 + (-2 * omega * rate0 - omega * omega * (yaw0 - target)) * seconds;
  let yaw = yaw0 + rate * seconds;
  if (yaw > SWING_LOOK_MAX_YAW) {
    yaw = SWING_LOOK_MAX_YAW;
    rate = Math.min(0, rate);
  } else if (yaw < -SWING_LOOK_MAX_YAW) {
    yaw = -SWING_LOOK_MAX_YAW;
    rate = Math.max(0, rate);
  }
  if (!Number.isFinite(yaw) || !Number.isFinite(rate)) return SWING_LOOK_REST;
  return Object.freeze({ yaw, rate, target });
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
 * the seat swings out and down as it comes back, turned by however far the
 * rider has turned their head (`headYaw`, positive to their left). Under
 * reduced motion the pendulum is ignored and the shot holds still — but the
 * head still turns, so the view still goes where the rider looks.
 *
 * The two compose rather than fight: the pendulum owns the pitch, the head
 * owns the yaw, and both arrive already smoothed (the arc by its envelope,
 * the head by its spring), so the rig has nothing to catch up with.
 */
export function swingCameraShot(angle: number, reduced = false, headYaw = 0): SwingCameraShot {
  const look = Number.isFinite(headYaw)
    ? Math.max(-SWING_LOOK_MAX_YAW, Math.min(SWING_LOOK_MAX_YAW, headYaw))
    : 0;
  if (reduced) {
    return Object.freeze({
      yaw: SWING_CAMERA_YAW + look,
      pitch: SWING_CAMERA_REDUCED_PITCH,
      distance: SWING_CAMERA_REDUCED_DISTANCE,
      aimHeight: SWING_CAMERA_AIM_HEIGHT,
      cut: true,
    });
  }
  const swing = Number.isFinite(angle) ? Math.max(-SWING_MAX_ANGLE, Math.min(SWING_MAX_ANGLE, angle)) : 0;
  return Object.freeze({
    yaw: SWING_CAMERA_YAW + look,
    pitch: SWING_CAMERA_PITCH - SWING_CAMERA_TILT * swing,
    distance: SWING_CAMERA_DISTANCE,
    aimHeight: SWING_CAMERA_AIM_HEIGHT,
    cut: false,
  });
}
