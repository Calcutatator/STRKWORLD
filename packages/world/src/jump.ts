/**
 * The jump on Space (D-097), engine-agnostic.
 *
 * The jump never changes the avatar's speed or direction: horizontal movement
 * carries on through it unchanged, so a walking jump covers 4 tiles of ground
 * and a sprinting one 6. What it changes is what the ground-level world does
 * to the jumper:
 *
 * - D-106: from `CLIMB_FROM_PHASE` of its air time until it lands it may step
 *   up onto a surface one block higher, once (`JumpState.canClimb`).
 * - D-128: between `JUMP_PASS_FROM_PHASE` and `JUMP_PASS_UNTIL_PHASE` the feet
 *   are above knee height, and the football is not a body the jumper meets
 *   (`JumpState.clearsBodies`), so a running jump carries them over the ball
 *   without dribbling it.
 *
 * Both windows are judged on the jump's normalised phase, never its height, so
 * reduced motion's lower hop climbs and clears exactly the same things. The
 * session owns the state machine (one jump at a time, a short cooldown); the
 * presenter and the remote layer own the arc and the pose, from the same
 * numbers here.
 */

import {
  CLIMB_FROM_PHASE,
  JUMP_AIR_MS as SHARED_JUMP_AIR_MS,
  JUMP_PASS_FROM_PHASE,
  JUMP_PASS_UNTIL_PHASE,
  SANDBOX_BLOCK_HEIGHT,
  SANDBOX_STEP_HEIGHT,
} from '@strkworld/shared';

/** Time in the air, ms (D-097, amended: 800). Shared, so the lobby's windows follow it. */
export const JUMP_AIR_MS = SHARED_JUMP_AIR_MS;
/**
 * How far the feet clear the top of a climbable stack at the apex, world
 * units. Feet sit at the figure's root for every build (the body scales about
 * them, and the tuck only lifts them), so this margin holds for small,
 * standard and large alike.
 */
export const JUMP_CLEARANCE = 0.15;
/**
 * Peak height of the feet above the ground, world units (one unit is a tile):
 * one climbable step of blocks plus `JUMP_CLEARANCE`, derived from the block
 * height rather than written down, so the jump always clears the block it
 * climbs. 1.15 with one-unit blocks.
 */
export const JUMP_HEIGHT = SANDBOX_STEP_HEIGHT * SANDBOX_BLOCK_HEIGHT + JUMP_CLEARANCE;
/**
 * Peak height when the player asked for less motion (`prefers-reduced-motion`):
 * a small hop. It still climbs, since the climb is judged on the jump's phase.
 */
export const REDUCED_JUMP_HEIGHT = 0.3;
/** After landing, the knees take the weight for this long (the landing squash). */
export const JUMP_LAND_MS = 110;
/** After landing, the next jump waits this long. At least `JUMP_LAND_MS`. */
export const JUMP_COOLDOWN_MS = 150;
/** Whole presentation of one jump: air plus landing. */
export const JUMP_TOTAL_MS = JUMP_AIR_MS + JUMP_LAND_MS;

/**
 * The arc's shape, as fractions of the air time: an ease-out rise, a hold at
 * the top (the hang), then a mirrored ease-in fall. Symmetric, so the peak is
 * the middle of the hold, halfway through the air.
 */
export const JUMP_RISE_FRACTION = 0.43;
export const JUMP_HOLD_FRACTION = 0.14;

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
  /**
   * D-128: whether the feet are clear of anything standing on the ground
   * right now — airborne and inside the pass window — so the football is not
   * a body this jumper meets.
   */
  readonly clearsBodies: boolean;
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
    get clearsBodies() {
      return phase === 'airborne' && inPassWindow(elapsed, airMs);
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
 * rounded up onto it. The full jump's feet are already above the block top
 * when the window opens (`jumpArc(CLIMB_FROM_PHASE)` is about 0.97 of 1.15).
 */
export function inClimbWindow(elapsedMs: number, airMs = JUMP_AIR_MS): boolean {
  const phase = jumpAirPhase(elapsedMs, airMs);
  return phase >= CLIMB_FROM_PHASE && phase < 1;
}

/**
 * D-128: whether a jump `elapsedMs` after take-off has its feet clear of
 * anything standing on the ground: from `JUMP_PASS_FROM_PHASE` of its air
 * time to `JUMP_PASS_UNTIL_PHASE`, the mirror of it on the fall. Phase based
 * like `inClimbWindow`, so reduced motion's 0.3-unit hop passes over the same
 * ball as the full 1.15-unit arc.
 */
export function inPassWindow(elapsedMs: number, airMs = JUMP_AIR_MS): boolean {
  const phase = jumpAirPhase(elapsedMs, airMs);
  return phase >= JUMP_PASS_FROM_PHASE && phase <= JUMP_PASS_UNTIL_PHASE;
}

/**
 * The arc's shape at `progress` (0 at take-off, 1 on landing), 0..1 of the
 * peak: a quadratic ease-out over `JUMP_RISE_FRACTION` (fast off the ground,
 * slowing into the top), flat at 1 for `JUMP_HOLD_FRACTION`, then the mirror
 * image down. Smooth everywhere: the rise and the fall meet the hold with no
 * vertical speed. 0 outside the air.
 */
export function jumpArc(progress: number): number {
  if (!(progress > 0) || !(progress < 1)) return 0;
  const fallFrom = JUMP_RISE_FRACTION + JUMP_HOLD_FRACTION;
  if (progress < JUMP_RISE_FRACTION) {
    const u = 1 - progress / JUMP_RISE_FRACTION;
    return 1 - u * u;
  }
  if (progress <= fallFrom) return 1;
  const u = (progress - fallFrom) / (1 - fallFrom);
  return 1 - u * u;
}

/**
 * Height of the feet above the ground `elapsedMs` after take-off: `jumpArc`
 * scaled to `height`, peaking halfway, 0 before take-off and after landing.
 */
export function jumpLift(elapsedMs: number, height = JUMP_HEIGHT): number {
  if (!(elapsedMs > 0) || elapsedMs >= JUMP_AIR_MS || !Number.isFinite(elapsedMs)) return 0;
  return height * jumpArc(elapsedMs / JUMP_AIR_MS);
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
  // The tuck follows the arc, so it is held through the hang at the top.
  const tuck = jumpArc(progress);
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
