import { afterAll, describe, expect, it } from 'vitest';
import { Box3, Vector3, type Object3D } from 'three';
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
import { ARENA_SURFACE, ARENA_THRONE_ARM, ARENA_THRONE_SEAT } from './arena-room.js';
import {
  BLOCK_SHIELD_ARM_ANGLE,
  avatarSeatedContact,
  createAvatarFigure,
  disposeAvatarFigureCache,
} from './avatar-figure.js';
import type { AvatarFigure, AvatarMotion } from './types.js';
import { CLIP_TOLERANCE, arenaPoses, findAvatarClipping, formatClipping, summarizeClipping } from '../../tools/avatar-clipping.js';
import { findSeatFindings, formatSeatFinding, seatTypes } from '../../tools/avatar-seat.js';

const CHECK_TIMEOUT_MS = 120_000;
const IDLE: AvatarMotion = Object.freeze({ moving: false, sprinting: false });
const GUARD: AvatarMotion = Object.freeze({ moving: false, sprinting: false, guard: true });
const BLOCK: AvatarMotion = Object.freeze({ moving: false, sprinting: false, guard: true, blocking: true });
const SEATED: AvatarMotion = Object.freeze({ moving: false, sprinting: false, seated: true });

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

  /*
   * D-128, amended 2026-10-03: the block's own pose.
   *
   * The shield arm is raised and never turned in, and it stops low enough
   * that nothing it carries comes up over the face. "The face is visible" is
   * checked as geometry, not by eye: nothing on the shield arm may stand in
   * front of the eyes — in front of them along +Z, which is the way the
   * figure faces and the way the camera looks (D-059) — within the eyes' own
   * footprint. That is exactly what the lead saw go wrong.
   */
  describe('the block (D-128, amended 2026-10-03)', () => {
    it('raises the shield arm to a guard, and a shield arm stops lower still', () => {
      expect(BLOCK_SHIELD_ARM_ANGLE).toBeCloseTo(-0.45, 3);
      expect(BLOCK_SHIELD_ARM_ANGLE).toBeGreaterThan(-1.45);
      const plain = createAvatarFigure('avatar-11');
      const shielded = createAvatarFigure('avatar-12');
      try {
        settle(plain, BLOCK, 160);
        settle(shielded, BLOCK, 160);
        const plainArm = node(plain, 'avatar-arm-left-pivot').rotation;
        const shieldArm = node(shielded, 'avatar-arm-left-pivot').rotation;
        // Raised, but nothing like the horizontal -1.45 it used to reach.
        expect(plainArm.x).toBeCloseTo(-0.7, 2);
        expect(shieldArm.x).toBeCloseTo(BLOCK_SHIELD_ARM_ANGLE, 2);
        // And never turned in across the body: the stance's spread is kept.
        const resting = createAvatarFigure('avatar-11');
        try {
          settle(resting, GUARD, 160);
          expect(plainArm.z).toBeCloseTo(node(resting, 'avatar-arm-left-pivot').rotation.z, 3);
        } finally {
          resting.dispose();
        }
      } finally {
        plain.dispose();
        shielded.dispose();
      }
    });

    it.each(AVATAR_SPRITE_KEYS)('%s: the shield arm never stands in front of the face', (key) => {
      const figure = createAvatarFigure(key);
      try {
        settle(figure, BLOCK, 160);
        figure.object.updateMatrixWorld(true);
        const eyes = new Box3().setFromObject(node(figure, 'avatar-eyes'), true);
        const arm = new Box3().setFromObject(node(figure, 'avatar-arm-left-pivot'), true);
        const overlapsEyes = arm.max.x > eyes.min.x && arm.min.x < eyes.max.x
          && arm.max.y > eyes.min.y && arm.min.y < eyes.max.y;
        // Either the arm is nowhere near the eyes' footprint, or it is behind
        // them — never between them and the camera.
        expect(overlapsEyes && arm.max.z > eyes.min.z).toBe(false);
      } finally {
        figure.dispose();
      }
    });

    it.each(AVATAR_SPRITE_KEYS)(
      '%s: the block is clipping-free, standing and walking',
      (key) => {
        const poses = arenaPoses().filter((pose) => pose.name.startsWith('block'));
        expect(poses.length).toBeGreaterThan(4);
        expect(summarizeClipping(findAvatarClipping(key, poses)).map(formatClipping)).toEqual([]);
      },
      CHECK_TIMEOUT_MS,
    );
  });

  /*
   * D-128, amended 2026-10-03: a champion the ring seats sits *on* the throne,
   * not inside it. The rise is D-127's seat system — one `SeatPlace` on the
   * motion, the figure lifting itself until its weight-bearing parts meet the
   * seat top — so the throne is checked by the same audit as the benches
   * (tools/avatar-seat.ts) and there is no second height to drift from.
   */
  describe('sitting on the emperor\'s throne', () => {
    const throne = (): ReturnType<typeof seatTypes>[number] => {
      const found = seatTypes().find((seat) => seat.name === 'arena throne');
      if (!found) throw new Error('the arena has lost its throne');
      return found;
    };

    it('is the throne\'s own declared seat, above the podium the box stands on', () => {
      expect(throne().place).toBe(ARENA_THRONE_SEAT);
      expect(ARENA_THRONE_SEAT.surface).toBeGreaterThan(0);
      // A seat on the box's floor, not a second storey: the podium is what its
      // sitter's feet stand on, and the pad is a chair's height above it.
      expect(ARENA_THRONE_SEAT.surface).toBeLessThan(ARENA_SURFACE.podium * 0.6);
    });

    it.each(AVATAR_SPRITE_KEYS)(
      '%s: rests on the pad with nothing through the throne, whatever the build',
      (key) => {
        expect(findSeatFindings(key, throne()).map(formatSeatFinding)).toEqual([]);
        // The rise is the look's own: its backside's distance from its feet.
        expect(avatarSeatedContact(key)).toBeLessThan(0);
      },
      CHECK_TIMEOUT_MS,
    );

    it('catches the champion the old throne stood inside', () => {
      // Told nothing about the seat, the figure takes the pose on the box's
      // own floor — a whole chair's height below the pad it should be on,
      // which is the champion the lead saw standing in the furniture.
      const rest = findSeatFindings('avatar-12', throne(), null)
        .find((finding) => finding.check === 'rest');
      expect(rest?.depth).toBeLessThan(-0.3);
      expect(formatSeatFinding(rest!)).toContain('below the seat top');
    });

    it('judges the arms on width, so a chair with arms is checked too', () => {
      // The arms are the one seat solid that does not run across its sitter.
      // Pulled in to where a broad build's thighs are, they are a finding;
      // that is what their declared inner edge is holding off.
      const [pad, back] = throne().solids;
      const narrow = [-1, 1].map((side) => ({
        minY: ARENA_THRONE_SEAT.surface,
        maxY: ARENA_THRONE_SEAT.surface + ARENA_THRONE_ARM.rise,
        minZ: -0.28,
        maxZ: ARENA_THRONE_SEAT.front,
        minX: side < 0 ? -0.3 : 0.1,
        maxX: side < 0 ? -0.1 : 0.3,
      }));
      const findings = findSeatFindings('avatar-12', {
        ...throne(),
        solids: [pad!, back!, ...narrow],
      });
      expect(findings.map((finding) => finding.check)).toContain('through');
      // And the throne as drawn is clear of the same build's legs.
      expect(ARENA_THRONE_ARM.inner).toBeGreaterThan(0.299 + CLIP_TOLERANCE);
    });
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
