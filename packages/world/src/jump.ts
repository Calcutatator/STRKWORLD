/**
 * The cosmetic jump on Space (D-097), engine-agnostic.
 *
 * The jump never moves the avatar across the ground: horizontal movement
 * carries on through it unchanged. Since D-106 it does one thing for
 * movement: from `CLIMB_FROM_PHASE` of its air time until it lands, it may
 * step up onto a surface one block higher, once (`JumpState.canClimb`).
 * Walking alone never steps up. The session owns the state machine (one jump
 * at a time, a short cooldown); the presenter and the remote layer own the
 * arc and the pose, from the same numbers here.
 */

import { CLIMB_FROM_PHASE } from '@strkworld/shared';

/** Time in the air, ms. */
export const JUMP_AIR_MS = 500;
/** Peak height of the arc above the feet, world units (one unit is a tile). */
export const JUMP_HEIGHT = 0.6;
/** Peak height when the player asked for less motion (`prefers-reduced-motion`). */
export const REDUCED_JUMP_HEIGHT = 0.3;
/** After landing, the knees take the weight for this long (the landing squash). */
export const JUMP_LAND_MS = 110;
/** After landing, the next jump waits this long. At least `JUMP_LAND_MS`. */
export const JUMP_COOLDOWN_MS = 150;
/** Whole presentation of one jump: air plus landing. */
export const JUMP_TOTAL_MS = JUMP_AIR_MS + JUMP_LAND_MS;

/** How stretched the body is on take-off, and how squashed on landing. */
const STRETCH = 0.12;
const SQUASH = 0.14;
/** Fraction of the air time the take-off stretch eases out over. */
const STRETCH_FRACTION = 0.35;

export type JumpPhase = 'ready' | 'airborne' | 'cooldown';

export interface JumpState {
  readonly phase: JumpPhase;
  /** Time since take-off, ms; 0 while ready. */
  readonly elapsed: number;
  /**
   * D-106: whether this jump may step up onto a surface one block higher
   * right now: airborne, inside the climb window, and not yet climbed.
   */
  readonly canClimb: boolean;
  /** Take off if ready. Returns whether a jump started: no double jump, no jump in cooldown. */
  tryStart(): boolean;
  /** D-106: this jump has stepped up (or been refused one); no second climb until the next jump. */
  climbed(): void;
  /** Advance by one frame. */
  advance(deltaMs: number): void;
  /** Back to ready at once: a teleport, a room change, teardown. */
  reset(): void;
}

/** The session's jump: airborne for `JUMP_AIR_MS`, then cooling down for `JUMP_COOLDOWN_MS`. */
export function createJumpState(airMs = JUMP_AIR_MS): JumpState {
  let phase: JumpPhase = 'ready';
  let elapsed = 0;
  let climbUsed = false;
  return {
    get phase() {
      return phase;
    },
    get elapsed() {
      return elapsed;
    },
    get canClimb() {
      return phase === 'airborne' && !climbUsed && inClimbWindow(elapsed, airMs);
    },
    tryStart() {
      if (phase !== 'ready') return false;
      phase = 'airborne';
      elapsed = 0;
      climbUsed = false;
      return true;
    },
    climbed() {
      if (phase === 'airborne') climbUsed = true;
    },
    advance(deltaMs) {
      if (phase === 'ready' || !(deltaMs > 0) || !Number.isFinite(deltaMs)) return;
      elapsed += deltaMs;
      if (elapsed >= airMs + JUMP_COOLDOWN_MS) {
        phase = 'ready';
        elapsed = 0;
      } else if (elapsed >= airMs) {
        phase = 'cooldown';
      }
    },
    reset() {
      phase = 'ready';
      elapsed = 0;
      climbUsed = false;
    },
  };
}

/**
 * D-106: how far through its air time a jump is, 0 at take-off and 1 on
 * landing. Normalised, so every jump, high or low, long or short, is judged on
 * the same scale. NaN for a meaningless input.
 */
export function jumpAirPhase(elapsedMs: number, airMs = JUMP_AIR_MS): number {
  if (!Number.isFinite(elapsedMs) || !(airMs > 0) || !Number.isFinite(airMs)) return Number.NaN;
  return elapsedMs / airMs;
}

/**
 * D-106: whether a jump `elapsedMs` after take-off may step up a block: from
 * `CLIMB_FROM_PHASE` of its air time (just before the peak) until it lands.
 * The jump's height is never read, so a smaller hop (reduced motion's 0.3
 * units, or any future shorter jump) clears the same block: the landing is
 * rounded up onto it.
 */
export function inClimbWindow(elapsedMs: number, airMs = JUMP_AIR_MS): boolean {
  const phase = jumpAirPhase(elapsedMs, airMs);
  return phase >= CLIMB_FROM_PHASE && phase < 1;
}

/**
 * Height of the feet above the ground `elapsedMs` after take-off: a
 * parabola peaking at `height` halfway, 0 before take-off and after landing.
 */
export function jumpLift(elapsedMs: number, height = JUMP_HEIGHT): number {
  if (!(elapsedMs > 0) || elapsedMs >= JUMP_AIR_MS || !Number.isFinite(elapsedMs)) return 0;
  const t = elapsedMs / JUMP_AIR_MS;
  return 4 * height * t * (1 - t);
}

/** What a figure does with a jump this frame. */
export interface JumpPose {
  /** 0..1 through the air; 1 while landing. */
  readonly progress: number;
  /** Vertical body scale: above 1 stretched, below 1 squashed. */
  readonly stretch: number;
  /** 0..1: how far the legs tuck and the arms rise. */
  readonly tuck: number;
}

export const NO_JUMP_POSE: JumpPose = Object.freeze({ progress: 0, stretch: 1, tuck: 0 });

/**
 * The pose `elapsedMs` after take-off, or null once the jump is over. A
 * stretch on take-off, a tuck at the top, a squash on landing. With
 * `squash` false (reduced motion), the body keeps its shape and only tucks.
 */
export function jumpPose(elapsedMs: number, squash = true): JumpPose | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= JUMP_TOTAL_MS) return null;
  if (elapsedMs >= JUMP_AIR_MS) {
    const t = (elapsedMs - JUMP_AIR_MS) / JUMP_LAND_MS;
    // Down fast, back up: sin over half a period.
    const amount = Math.sin(Math.PI * t);
    return { progress: 1, stretch: squash ? 1 - SQUASH * amount : 1, tuck: 0 };
  }
  const progress = elapsedMs / JUMP_AIR_MS;
  const rise = Math.max(0, 1 - progress / STRETCH_FRACTION);
  const tuck = Math.sin(Math.PI * progress);
  return { progress, stretch: squash ? 1 + STRETCH * rise : 1, tuck };
}

/**
 * The contact shadow under a jumping avatar: full size on the ground,
 * shrinking towards `minScale` at the top of the arc. Returns its scale.
 */
export function jumpShadowScale(lift: number, height = JUMP_HEIGHT, minScale = 0.55): number {
  if (!(lift > 0) || !(height > 0)) return 1;
  const t = Math.min(1, lift / height);
  return 1 - (1 - minScale) * t;
}
