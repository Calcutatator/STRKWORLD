import { describe, expect, it } from 'vitest';
import {
  JUMP_AIR_MS,
  JUMP_COOLDOWN_MS,
  JUMP_HEIGHT,
  JUMP_LAND_MS,
  JUMP_TOTAL_MS,
  REDUCED_JUMP_HEIGHT,
  createJumpState,
  inClimbWindow,
  jumpAirPhase,
  jumpLift,
  jumpPose,
  jumpShadowScale,
} from './jump.js';
import { CLIMB_FROM_PHASE, CLIMB_WINDOW_MS } from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS } from './avatar-state.js';

/** The cosmetic jump's numbers and state machine (D-097). */

describe('the jump arc', () => {
  it('is a short snappy hop: 0.5-0.7 units high, 450-550 ms in the air', () => {
    expect(JUMP_HEIGHT).toBeGreaterThanOrEqual(0.5);
    expect(JUMP_HEIGHT).toBeLessThanOrEqual(0.7);
    expect(JUMP_AIR_MS).toBeGreaterThanOrEqual(450);
    expect(JUMP_AIR_MS).toBeLessThanOrEqual(550);
    expect(REDUCED_JUMP_HEIGHT).toBeLessThan(JUMP_HEIGHT);
    expect(JUMP_COOLDOWN_MS).toBeGreaterThanOrEqual(JUMP_LAND_MS);
  });

  it('leaves the ground at take-off, peaks halfway and lands exactly', () => {
    expect(jumpLift(0)).toBe(0);
    expect(jumpLift(JUMP_AIR_MS / 2)).toBeCloseTo(JUMP_HEIGHT, 10);
    expect(jumpLift(JUMP_AIR_MS)).toBe(0);
    expect(jumpLift(JUMP_AIR_MS + 50)).toBe(0);
    expect(jumpLift(JUMP_AIR_MS / 4)).toBeCloseTo(jumpLift((3 * JUMP_AIR_MS) / 4), 10);
    expect(jumpLift(JUMP_AIR_MS / 2, REDUCED_JUMP_HEIGHT)).toBeCloseTo(REDUCED_JUMP_HEIGHT, 10);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(jumpLift(bad)).toBe(0);
    // Rises then falls, never below the ground.
    let previous = 0;
    for (let ms = 10; ms < JUMP_AIR_MS / 2; ms += 10) {
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
    expect(jumpAirPhase(250)).toBe(0.5);
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
    expect(CLIMB_WINDOW_MS - JUMP_AIR_MS).toBeGreaterThanOrEqual(100);
  });
});
