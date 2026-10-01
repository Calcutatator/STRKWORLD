import { afterAll, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { AVATAR_SPRITE_KEYS } from '../src/avatar-state.js';
import { createAvatarFigure, disposeAvatarFigureCache } from '../src/three/avatar-figure.js';
import {
  CLIP_TOLERANCE,
  clippingInFigure,
  figurePoses,
  findAvatarClipping,
  formatClipping,
  summarizeClipping,
} from './avatar-clipping.js';

const CHECK_TIMEOUT_MS = 120_000;

function pivot(root: Object3D, name: string): Object3D {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`figure has no ${name}`);
  return found;
}

afterAll(() => {
  disposeAvatarFigureCache();
});

describe('avatar clipping (tools/avatar-clipping.ts)', () => {
  it('poses every look at rest, through two gaits, and a whole stride of each', () => {
    const names = figurePoses().map((pose) => pose.name);
    expect(names.filter((name) => name.startsWith('idle'))).toHaveLength(4);
    expect(names.filter((name) => name.startsWith('walk'))).toHaveLength(16);
    expect(names.filter((name) => name.startsWith('sprint'))).toHaveLength(16);
    // One pixel at the street camera on a 1080-pixel view.
    expect(CLIP_TOLERANCE).toBeCloseTo(12 / 1080, 3);
  });

  it.each(AVATAR_SPRITE_KEYS)(
    '%s: nothing passes through anything, standing, walking or sprinting',
    (key) => {
      const findings = summarizeClipping(findAvatarClipping(key));
      expect(findings.map(formatClipping)).toEqual([]);
    },
    CHECK_TIMEOUT_MS,
  );

  it('finds an arm swung in through the body', () => {
    const figure = createAvatarFigure('avatar-1');
    try {
      expect(clippingInFigure(figure.object, 'avatar-1', 'rest')).toEqual([]);
      // Swing the left arm in across the chest.
      pivot(figure.object, 'avatar-arm-left-pivot').rotation.z = -0.9;
      const findings = clippingInFigure(figure.object, 'avatar-1', 'arm in');
      expect(findings.some((f) => f.inside.startsWith('avatar-arm-left') || f.surface.startsWith('avatar-arm-left'))).toBe(true);
      expect(Math.max(...findings.map((f) => f.depth))).toBeGreaterThan(CLIP_TOLERANCE);
    } finally {
      figure.dispose();
    }
  });

  it('finds a thigh swung out through the front of the hips, which its socket only lets out below', () => {
    const figure = createAvatarFigure('avatar-1');
    try {
      const leg = pivot(figure.object, 'avatar-leg-left-pivot');
      // Raise the pivot to the hip line, as it was before the fix, and swing hard.
      leg.position.y = 0;
      leg.rotation.x = -1.1;
      const findings = clippingInFigure(figure.object, 'avatar-1', 'high kick');
      expect(findings.some((f) => f.surface === 'avatar-torso:hips' && f.inside === 'avatar-leg-left:leg')).toBe(true);
    } finally {
      figure.dispose();
    }
  });

  it('finds a head sunk into the chest', () => {
    const figure = createAvatarFigure('avatar-2');
    try {
      pivot(figure.object, 'avatar-head-pivot').position.y -= 0.12;
      const findings = clippingInFigure(figure.object, 'avatar-2', 'sunk');
      expect(findings.some((f) => f.inside.startsWith('avatar-head') || f.surface.startsWith('avatar-head'))).toBe(true);
    } finally {
      figure.dispose();
    }
  });
});
