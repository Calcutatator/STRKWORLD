import { describe, expect, it } from 'vitest';
import {
  JUMP_AIR_MS,
  JUMP_CLEARANCE,
  JUMP_COOLDOWN_MS,
  JUMP_HEIGHT,
  JUMP_HOLD_FRACTION,
  JUMP_LAND_MS,
  JUMP_TOTAL_MS,
  JUMP_RISE_FRACTION,
  REDUCED_JUMP_HEIGHT,
  createJumpState,
  inClimbWindow,
  inPassWindow,
  jumpAirPhase,
  jumpArc,
  jumpLift,
  jumpPose,
  jumpShadowScale,
} from './jump.js';
import {
  CLIMB_FROM_PHASE,
  CLIMB_LATENCY_MS,
  CLIMB_WINDOW_MS,
  JUMP_AIR_MS as SHARED_JUMP_AIR_MS,
  JUMP_PASS_FROM_PHASE,
  JUMP_PASS_UNTIL_PHASE,
  JUMP_PASS_WINDOW_MS,
  SANDBOX_BLOCK_HEIGHT,
  SANDBOX_STEP_HEIGHT,
} from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS } from './avatar-state.js';

/** The cosmetic jump's numbers and state machine (D-097). */

describe('the jump arc', () => {
  it('is about a block high, derived from the block height, with a small margin (D-097, amended)', () => {
    const blockTop = SANDBOX_STEP_HEIGHT * SANDBOX_BLOCK_HEIGHT;
    expect(JUMP_HEIGHT).toBe(blockTop + JUMP_CLEARANCE);
    expect(JUMP_HEIGHT).toBeGreaterThanOrEqual(blockTop + 0.05);
    expect(JUMP_HEIGHT).toBeLessThanOrEqual(blockTop * 1.3);
    expect(jumpLift(JUMP_AIR_MS / 2)).toBeGreaterThan(blockTop);
    expect(REDUCED_JUMP_HEIGHT).toBeLessThan(JUMP_HEIGHT);
    expect(REDUCED_JUMP_HEIGHT).toBeGreaterThan(0);
  });

  it('is longer, 750-850 ms in the air, shared with the lobby', () => {
    expect(JUMP_AIR_MS).toBeGreaterThanOrEqual(750);
    expect(JUMP_AIR_MS).toBeLessThanOrEqual(850);
    expect(JUMP_AIR_MS).toBe(SHARED_JUMP_AIR_MS);
    expect(JUMP_TOTAL_MS).toBe(JUMP_AIR_MS + JUMP_LAND_MS);
    expect(JUMP_COOLDOWN_MS).toBeGreaterThanOrEqual(JUMP_LAND_MS);
  });

  it('eases out on the way up, hangs at the top, and eases in on the way down', () => {
    const fallFrom = JUMP_RISE_FRACTION + JUMP_HOLD_FRACTION;
    expect(JUMP_HOLD_FRACTION).toBeGreaterThan(0);
    expect(JUMP_HOLD_FRACTION).toBeLessThanOrEqual(0.2);
    // Symmetric, so the peak is halfway.
    expect(JUMP_RISE_FRACTION).toBeCloseTo(1 - fallFrom, 10);
    // The hold: flat at the peak.
    for (const p of [JUMP_RISE_FRACTION, 0.5, fallFrom]) expect(jumpArc(p)).toBeCloseTo(1, 10);
    // Ease-out rise: each equal slice of time climbs less than the one before.
    const steps = 10;
    let lastGain = Number.POSITIVE_INFINITY;
    for (let i = 0; i < steps; i += 1) {
      const gain = jumpArc(((i + 1) / steps) * JUMP_RISE_FRACTION) - jumpArc((i / steps) * JUMP_RISE_FRACTION);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThan(lastGain);
      lastGain = gain;
    }
    // Ease-in fall: each equal slice drops more than the one before.
    let lastDrop = 0;
    for (let i = 0; i < steps; i += 1) {
      const a = fallFrom + (i / steps) * (1 - fallFrom);
      const b = fallFrom + ((i + 1) / steps) * (1 - fallFrom);
      const drop = jumpArc(a) - jumpArc(b);
      expect(drop).toBeGreaterThan(lastDrop);
      lastDrop = drop;
    }
    // It lingers: over a fifth more of the air is spent within 10% of the
    // peak than a plain parabola of the same air time spends there.
    const samples = 1000;
    let high = 0;
    let parabolaHigh = 0;
    for (let i = 0; i < samples; i += 1) {
      const p = (i + 0.5) / samples;
      if (jumpArc(p) >= 0.9) high += 1;
      if (4 * p * (1 - p) >= 0.9) parabolaHigh += 1;
    }
    expect(high).toBeGreaterThan(parabolaHigh * 1.2);
    for (const bad of [Number.NaN, -0.1, 0, 1, 1.5]) expect(jumpArc(bad)).toBe(0);
  });

  it('leaves the ground at take-off, peaks halfway and lands exactly', () => {
    expect(jumpLift(0)).toBe(0);
    expect(jumpLift(JUMP_AIR_MS / 2)).toBeCloseTo(JUMP_HEIGHT, 10);
    expect(jumpLift(JUMP_AIR_MS)).toBe(0);
    expect(jumpLift(JUMP_AIR_MS + 50)).toBe(0);
    expect(jumpLift(JUMP_AIR_MS / 4)).toBeCloseTo(jumpLift((3 * JUMP_AIR_MS) / 4), 10);
    expect(jumpLift(JUMP_AIR_MS / 2, REDUCED_JUMP_HEIGHT)).toBeCloseTo(REDUCED_JUMP_HEIGHT, 10);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(jumpLift(bad)).toBe(0);
    // Rises to the hold, never below the ground.
    let previous = 0;
    for (let ms = 10; ms < JUMP_RISE_FRACTION * JUMP_AIR_MS; ms += 10) {
      const lift = jumpLift(ms);
      expect(lift).toBeGreaterThan(previous);
      previous = lift;
    }
  });

  it('stretches on take-off, tucks at the top and squashes on landing', () => {
    const takeoff = jumpPose(10)!;
    const top = jumpPose(JUMP_AIR_MS / 2)!;
    const landing = jumpPose(JUMP_AIR_MS + JUMP_LAND_MS / 2)!;
    expect(takeoff.stretch).toBeGreaterThan(1);
    expect(top.stretch).toBe(1);
    expect(top.tuck).toBeCloseTo(1, 5);
    expect(landing.stretch).toBeLessThan(1);
    expect(landing.tuck).toBe(0);
    expect(jumpPose(JUMP_TOTAL_MS)).toBeNull();
    expect(jumpPose(-1)).toBeNull();
  });

  it('keeps the body its shape under reduced motion, but still tucks', () => {
    for (const ms of [10, JUMP_AIR_MS / 2, JUMP_AIR_MS + JUMP_LAND_MS / 2]) {
      expect(jumpPose(ms, false)!.stretch).toBe(1);
    }
    expect(jumpPose(JUMP_AIR_MS / 2, false)!.tuck).toBeCloseTo(1, 5);
  });

  it('shrinks the shadow as the avatar rises', () => {
    expect(jumpShadowScale(0)).toBe(1);
    expect(jumpShadowScale(JUMP_HEIGHT / 2)).toBeLessThan(1);
    expect(jumpShadowScale(JUMP_HEIGHT)).toBeLessThan(jumpShadowScale(JUMP_HEIGHT / 2));
    expect(jumpShadowScale(JUMP_HEIGHT)).toBeGreaterThan(0.4);
  });
});

describe('the jump state machine', () => {
  it('takes off when ready, holds until landing, then cools down', () => {
    const jump = createJumpState();
    expect(jump.phase).toBe('ready');
    expect(jump.tryStart()).toBe(true);
    expect(jump.phase).toBe('airborne');
    jump.advance(JUMP_AIR_MS - 1);
    expect(jump.phase).toBe('airborne');
    jump.advance(1);
    expect(jump.phase).toBe('cooldown');
    jump.advance(JUMP_COOLDOWN_MS - 1);
    expect(jump.phase).toBe('cooldown');
    jump.advance(1);
    expect(jump.phase).toBe('ready');
    expect(jump.elapsed).toBe(0);
  });

  it('has no double jump and no jump in the cooldown', () => {
    const jump = createJumpState();
    expect(jump.tryStart()).toBe(true);
    jump.advance(JUMP_AIR_MS / 2);
    expect(jump.tryStart()).toBe(false);
    expect(jump.elapsed).toBe(JUMP_AIR_MS / 2);
    jump.advance(JUMP_AIR_MS / 2 + 10);
    expect(jump.phase).toBe('cooldown');
    expect(jump.tryStart()).toBe(false);
    jump.advance(JUMP_COOLDOWN_MS);
    expect(jump.tryStart()).toBe(true);
  });

  it('ignores junk frame times and resets to ready', () => {
    const jump = createJumpState();
    jump.tryStart();
    for (const bad of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) jump.advance(bad);
    expect(jump.elapsed).toBe(0);
    expect(jump.phase).toBe('airborne');
    jump.reset();
    expect(jump.phase).toBe('ready');
  });
});

/** D-106: a jump near or past its peak may step up one block, once. */
describe('the climb window', () => {
  it('opens at 35-40% of the air time and closes on landing', () => {
    expect(CLIMB_FROM_PHASE).toBeGreaterThanOrEqual(0.35);
    expect(CLIMB_FROM_PHASE).toBeLessThanOrEqual(0.4);
    const opens = CLIMB_FROM_PHASE * JUMP_AIR_MS;
    expect(inClimbWindow(0)).toBe(false);
    expect(inClimbWindow(opens - 1)).toBe(false);
    expect(inClimbWindow(opens)).toBe(true);
    expect(inClimbWindow(JUMP_AIR_MS / 2)).toBe(true);
    expect(inClimbWindow(JUMP_AIR_MS - 1)).toBe(true);
    expect(inClimbWindow(JUMP_AIR_MS)).toBe(false);
    expect(inClimbWindow(Number.NaN)).toBe(false);
    expect(inClimbWindow(100, 0)).toBe(false);
    expect(jumpAirPhase(JUMP_AIR_MS / 2)).toBe(0.5);
  });

  it('allows the climb at 40% of the air time and refuses it before 35%', () => {
    const before = createJumpState();
    before.tryStart();
    before.advance(Math.ceil(CLIMB_FROM_PHASE * JUMP_AIR_MS) - 1);
    expect(jumpAirPhase(before.elapsed)).toBeLessThan(0.35);
    expect(before.canClimb).toBe(false);
    const at40 = createJumpState();
    at40.tryStart();
    at40.advance(0.4 * JUMP_AIR_MS);
    expect(at40.canClimb).toBe(true);
    // Reduced motion lowers the hop, not the air time: the same phases climb.
    expect(jumpLift(0.4 * JUMP_AIR_MS, REDUCED_JUMP_HEIGHT)).toBeGreaterThan(0);
  });

  it('has the full jump\'s feet already above the block top when the window opens', () => {
    const blockTop = SANDBOX_STEP_HEIGHT * SANDBOX_BLOCK_HEIGHT;
    expect(jumpLift(Math.ceil(CLIMB_FROM_PHASE * JUMP_AIR_MS))).toBeGreaterThan(blockTop);
  });

  it('is judged on the normalised phase, so every jump clears a block: each avatar, reduced motion, and smaller or shorter jumps', () => {
    // Every avatar jumps with the same numbers today; reduced motion halves the
    // height. Any future per-character profile, lower or shorter, gets the same
    // window by phase: the rule never reads the height.
    const profiles: Array<{ airMs: number; height: number }> = [];
    for (const _sprite of AVATAR_SPRITE_KEYS) {
      profiles.push({ airMs: JUMP_AIR_MS, height: JUMP_HEIGHT }, { airMs: JUMP_AIR_MS, height: REDUCED_JUMP_HEIGHT });
    }
    for (const airMs of [300, 400, 650, 800]) for (const height of [0.15, 0.3, 0.6, 0.9]) profiles.push({ airMs, height });
    for (const { airMs, height } of profiles) {
      const state = createJumpState(airMs);
      expect(state.tryStart()).toBe(true);
      const opens = Math.ceil(CLIMB_FROM_PHASE * airMs);
      state.advance(opens - 1);
      expect(state.canClimb).toBe(false);
      state.advance(1);
      expect(state.canClimb).toBe(true);
      // Near the peak: at least 90% of this jump's own height, whatever it is.
      expect(jumpLift((opens / airMs) * JUMP_AIR_MS, height)).toBeGreaterThanOrEqual(0.9 * height);
      state.advance(airMs - opens - 1);
      expect(state.canClimb).toBe(true);
      state.advance(1);
      expect(state.phase).toBe('cooldown');
      expect(state.canClimb).toBe(false);
    }
  });

  it('allows one climb per jump, and a fresh one with the next jump', () => {
    const state = createJumpState();
    expect(state.canClimb).toBe(false);
    state.climbed();
    state.tryStart();
    state.advance(JUMP_AIR_MS / 2);
    expect(state.canClimb).toBe(true);
    state.climbed();
    expect(state.canClimb).toBe(false);
    state.advance(JUMP_AIR_MS / 2 + JUMP_COOLDOWN_MS);
    expect(state.phase).toBe('ready');
    state.tryStart();
    state.advance(JUMP_AIR_MS / 2);
    expect(state.canClimb).toBe(true);
    state.reset();
    expect(state.canClimb).toBe(false);
  });

  it('fits inside the lobby window: a climb on the last frame of the air still lands with room for the move floor', () => {
    // The move floor is 50 ms; the rest is jitter between the jump and the move.
    expect(CLIMB_WINDOW_MS).toBe(JUMP_AIR_MS + CLIMB_LATENCY_MS);
    expect(CLIMB_LATENCY_MS).toBeGreaterThanOrEqual(150);
    expect(CLIMB_WINDOW_MS - JUMP_AIR_MS).toBeGreaterThanOrEqual(100);
  });
});

describe('the pass window: when the feet are clear of the ball (D-130)', () => {
  it('opens above knee height and closes at its mirror on the fall', () => {
    expect(inPassWindow(JUMP_PASS_FROM_PHASE * JUMP_AIR_MS - 1)).toBe(false);
    expect(inPassWindow(JUMP_PASS_FROM_PHASE * JUMP_AIR_MS)).toBe(true);
    expect(inPassWindow(JUMP_AIR_MS / 2)).toBe(true);
    expect(inPassWindow(JUMP_PASS_UNTIL_PHASE * JUMP_AIR_MS)).toBe(true);
    expect(inPassWindow(JUMP_PASS_UNTIL_PHASE * JUMP_AIR_MS + 1)).toBe(false);
    // Symmetric about the apex, so the pass lasts as long on the way down.
    expect(JUMP_PASS_UNTIL_PHASE).toBeCloseTo(1 - JUMP_PASS_FROM_PHASE, 10);
  });

  it('opens where the full arc is past the knee and short of the waist', () => {
    const lift = JUMP_HEIGHT * jumpArc(JUMP_PASS_FROM_PHASE);
    expect(lift).toBeGreaterThan(0.3);
    expect(lift).toBeLessThan(0.6);
    // And at the apex the feet are a whole block up, as D-097 derives it.
    expect(jumpLift(JUMP_AIR_MS / 2)).toBeCloseTo(JUMP_HEIGHT, 10);
  });

  it('never reads the height, so reduced motion\'s lower hop passes over the same ball', () => {
    // The hop is lower throughout and still inside the window at the same phases.
    expect(REDUCED_JUMP_HEIGHT).toBeLessThan(JUMP_HEIGHT);
    for (const phase of [JUMP_PASS_FROM_PHASE, 0.3, 0.5, 0.7, JUMP_PASS_UNTIL_PHASE]) {
      expect(inPassWindow(phase * JUMP_AIR_MS)).toBe(true);
      expect(jumpLift(phase * JUMP_AIR_MS, REDUCED_JUMP_HEIGHT)).toBeGreaterThan(0);
    }
  });

  it('refuses meaningless input and anything outside the air', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, JUMP_AIR_MS, JUMP_AIR_MS + 1]) {
      expect(inPassWindow(value)).toBe(false);
    }
    expect(inPassWindow(100, 0)).toBe(false);
  });

  it('is what the state machine reports, for this jump only', () => {
    const state = createJumpState();
    expect(state.clearsBodies).toBe(false);
    state.tryStart();
    expect(state.clearsBodies).toBe(false);
    state.advance(JUMP_PASS_FROM_PHASE * JUMP_AIR_MS);
    expect(state.clearsBodies).toBe(true);
    // A climb spends the climb, never the pass: still over the ball after it.
    state.climbed();
    expect(state.canClimb).toBe(false);
    expect(state.clearsBodies).toBe(true);
    state.advance(JUMP_AIR_MS);
    expect(state.phase).toBe('cooldown');
    expect(state.clearsBodies).toBe(false);
    state.reset();
    expect(state.clearsBodies).toBe(false);
  });

  it('fits inside the lobby window, with room for the move floor and jitter', () => {
    expect(JUMP_PASS_WINDOW_MS).toBe(JUMP_AIR_MS * JUMP_PASS_UNTIL_PHASE + CLIMB_LATENCY_MS);
    // The last frame of the pass, plus the latency the climb window allows.
    expect(JUMP_PASS_WINDOW_MS).toBeGreaterThan(JUMP_PASS_UNTIL_PHASE * JUMP_AIR_MS);
    // Shorter than the climb window: the pass closes before the jump lands.
    expect(JUMP_PASS_WINDOW_MS).toBeLessThan(CLIMB_WINDOW_MS);
  });
});
