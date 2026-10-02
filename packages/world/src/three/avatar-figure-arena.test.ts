import { afterAll, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { ARENA_SWING_MS } from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS } from '../avatar-state.js';
import {
  ARENA_SWING_RECOVER_MS,
  ARENA_SWING_STRIKE_MS,
  ARENA_SWING_WINDUP_MS,
  attackPoseAt,
  createSeatTracker,
  createSwingClock,
  isArenaSeatAt,
  ARENA_SEAT_IDLE_MS,
} from '../arena-swing.js';
import { arenaTileCentre } from '@strkworld/shared';
import { createAvatarFigure, disposeAvatarFigureCache } from './avatar-figure.js';
import type { AvatarFigure, AvatarMotion } from './types.js';
import { arenaPoses, findAvatarClipping, formatClipping, summarizeClipping } from '../../tools/avatar-clipping.js';

const CHECK_TIMEOUT_MS = 120_000;
const IDLE: AvatarMotion = Object.freeze({ moving: false, sprinting: false });
const GUARD: AvatarMotion = Object.freeze({ moving: false, sprinting: false, guard: true });

function node(figure: AvatarFigure, name: string): Object3D {
  const found = figure.object.getObjectByName(name);
  if (!found) throw new Error(`figure has no ${name}`);
  return found;
}

function settle(figure: AvatarFigure, motion: AvatarMotion, frames = 40): void {
  for (let i = 0; i < frames; i += 1) figure.update(25, motion);
}

afterAll(() => {
  disposeAvatarFigureCache();
});

describe('the swing timeline (arena-swing.ts)', () => {
  it('runs 100 ms wind-up, 120 ms strike and 130 ms recover: 350 ms in all', () => {
    expect(ARENA_SWING_WINDUP_MS + ARENA_SWING_STRIKE_MS + ARENA_SWING_RECOVER_MS).toBe(ARENA_SWING_MS);
    expect(ARENA_SWING_RECOVER_MS).toBe(130);
    expect(attackPoseAt(-1)).toBeNull();
    expect(attackPoseAt(0)).toEqual({ stage: 'windup', progress: 0 });
    expect(attackPoseAt(50)).toEqual({ stage: 'windup', progress: 0.5 });
    expect(attackPoseAt(100)).toEqual({ stage: 'strike', progress: 0 });
    expect(attackPoseAt(160)).toEqual({ stage: 'strike', progress: 0.5 });
    expect(attackPoseAt(220)).toEqual({ stage: 'recover', progress: 0 });
    expect(attackPoseAt(349)?.stage).toBe('recover');
    expect(attackPoseAt(350)).toBeNull();
    expect(attackPoseAt(Number.NaN)).toBeNull();
  });

  it('a swing clock steps through the stages once, and a restart begins at the wind-up', () => {
    const clock = createSwingClock();
    expect(clock.step(16)).toBeNull();
    clock.start();
    const stages: string[] = [];
    for (let t = 0; t < 30 && (t === 0 || clock.active); t += 1) {
      const pose = clock.step(25);
      if (pose && stages.at(-1) !== pose.stage) stages.push(pose.stage);
    }
    expect(stages).toEqual(['windup', 'strike', 'recover']);
    expect(clock.active).toBe(false);
    clock.start();
    clock.step(200);
    clock.start();
    expect(clock.step(0)?.stage).toBe('windup');
  });

  it('seats a figure after 1.5 s still on a tier, and stands it at the first step', () => {
    const tier = arenaTileCentre({ x: 20, y: 29 });
    const sand = arenaTileCentre({ x: 10, y: 16 });
    expect(isArenaSeatAt(tier.x, tier.y)).toBe(true);
    expect(isArenaSeatAt(sand.x, sand.y)).toBe(false);
    const seat = createSeatTracker();
    expect(seat.step(ARENA_SEAT_IDLE_MS - 1, false, true)).toBe(false);
    expect(seat.step(1, false, true)).toBe(true);
    expect(seat.step(16, true, true)).toBe(false);
    expect(seat.step(ARENA_SEAT_IDLE_MS, false, false)).toBe(false);
  });
});

describe('avatar figure: the arena poses (D-114)', () => {
  it('the swing draws the weapon arm back on the wind-up and drives it forward on the strike', () => {
    const figure = createAvatarFigure('avatar-10');
    try {
      settle(figure, GUARD);
      const arm = node(figure, 'avatar-arm-right-pivot');
      const hips = node(figure, 'avatar-hips');
      const upper = node(figure, 'avatar-upper-body');
      const guardArm = arm.rotation.x;
      // A negative x turn is forward (towards +Z, the figure's front).
      expect(guardArm).toBeLessThan(0);
      figure.update(16, { ...GUARD, attack: { stage: 'windup', progress: 1 } });
      const drawn = arm.rotation.x;
      expect(drawn).toBeGreaterThan(guardArm);
      expect(upper.rotation.y).toBeLessThan(0);
      expect(hips.position.z).toBe(0);
      figure.update(16, { ...GUARD, attack: { stage: 'strike', progress: 1 } });
      expect(arm.rotation.x).toBeLessThan(guardArm);
      expect(upper.rotation.y).toBeGreaterThan(0);
      expect(hips.position.z).toBeGreaterThan(0);
      figure.update(16, { ...GUARD, attack: { stage: 'recover', progress: 1 } });
      expect(arm.rotation.x).toBeCloseTo(guardArm, 2);
      expect(hips.position.z).toBeCloseTo(0, 5);
      // Once over, the stance is back.
      figure.update(16, GUARD);
      expect(arm.rotation.x).toBeCloseTo(guardArm, 2);
    } finally {
      figure.dispose();
    }
  });

  it('a cosy look punches: the bare arm swings the same way', () => {
    const figure = createAvatarFigure('avatar-1');
    try {
      settle(figure, GUARD);
      const arm = node(figure, 'avatar-arm-right-pivot');
      figure.update(16, { ...GUARD, attack: { stage: 'strike', progress: 1 } });
      expect(arm.rotation.x).toBeLessThan(-1);
    } finally {
      figure.dispose();
    }
  });

  it('the battle stance sets the feet apart and raises the weapon; without it the figure stands as before', () => {
    const plain = createAvatarFigure('avatar-12');
    const guarded = createAvatarFigure('avatar-12');
    try {
      settle(plain, IDLE);
      settle(guarded, GUARD);
      expect(node(plain, 'avatar-leg-left-pivot').rotation.z).toBe(0);
      expect(node(guarded, 'avatar-leg-left-pivot').rotation.z).toBeGreaterThan(0.1);
      expect(node(guarded, 'avatar-leg-right-pivot').rotation.z).toBeLessThan(-0.1);
      expect(node(guarded, 'avatar-arm-right-pivot').rotation.x).toBeLessThan(node(plain, 'avatar-arm-right-pivot').rotation.x);
      // The stance eases out again.
      settle(guarded, IDLE);
      expect(node(guarded, 'avatar-leg-left-pivot').rotation.z).toBe(0);
    } finally {
      plain.dispose();
      guarded.dispose();
    }
  });

  it('seated lowers the body and brings the legs forward, but never on the move', () => {
    const figure = createAvatarFigure('avatar-2');
    try {
      settle(figure, IDLE);
      const hips = node(figure, 'avatar-hips');
      const standing = hips.position.y;
      settle(figure, { moving: false, sprinting: false, seated: true });
      expect(hips.position.y).toBeLessThan(standing - 0.1);
      expect(node(figure, 'avatar-leg-left-pivot').rotation.x).toBeLessThan(-0.6);
      settle(figure, { moving: true, sprinting: false, seated: true });
      expect(node(figure, 'avatar-leg-left-pivot').rotation.x).toBeGreaterThan(-0.6);
    } finally {
      figure.dispose();
    }
  });

  it('ignores a malformed attack pose', () => {
    const figure = createAvatarFigure('avatar-9');
    try {
      settle(figure, GUARD);
      const before = node(figure, 'avatar-arm-right-pivot').rotation.x;
      figure.update(16, { ...GUARD, attack: { stage: 'flail' as never, progress: 1 } });
      expect(node(figure, 'avatar-arm-right-pivot').rotation.x).toBeCloseTo(before, 3);
    } finally {
      figure.dispose();
    }
  });

  it.each(AVATAR_SPRITE_KEYS)(
    '%s: nothing passes through anything in the stance, any stage of the swing, or seated',
    (key) => {
      const findings = summarizeClipping(findAvatarClipping(key, arenaPoses()));
      expect(findings.map(formatClipping)).toEqual([]);
    },
    CHECK_TIMEOUT_MS,
  );
});
