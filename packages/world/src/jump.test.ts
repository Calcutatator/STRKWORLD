import { describe, expect, it } from 'vitest';
import {
  JUMP_AIR_MS,
  JUMP_COOLDOWN_MS,
  JUMP_HEIGHT,
  JUMP_LAND_MS,
  JUMP_TOTAL_MS,
  REDUCED_JUMP_HEIGHT,
  createJumpState,
  jumpLift,
  jumpPose,
  jumpShadowScale,
} from './jump.js';

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
