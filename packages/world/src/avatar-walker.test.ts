import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_SPRITE } from './avatar-state.js';
import {
  AVATAR_WALKER,
  AVATAR_WALKER_CELL,
  AVATAR_WALKER_DENSITY,
  AVATAR_WALKER_FRAMES,
  AVATAR_WALKER_SPRITE,
} from './avatar-walker.js';
import * as world from './index.js';

describe('the avatar walker projection (D-058)', () => {
  it('is the default figure: a standing cell, then one stride of walking', () => {
    expect(AVATAR_WALKER_SPRITE).toBe(DEFAULT_AVATAR_SPRITE);
    expect(AVATAR_WALKER).toEqual({
      url: expect.stringMatching(/\/assets\/avatar-walker\/walk\.png$/),
      cellSize: AVATAR_WALKER_CELL,
      cells: AVATAR_WALKER_FRAMES + 1,
      walkFrames: AVATAR_WALKER_FRAMES,
      // One stride at the figure's 1.6 strides a second.
      strideMs: 625,
    });
    expect(Object.isFrozen(AVATAR_WALKER)).toBe(true);
  });

  it('points at a PNG strip of that many square cells, drawn at 2x', () => {
    const file = readFileSync(new URL(AVATAR_WALKER.url));
    expect(file.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([file.readUInt32BE(16), file.readUInt32BE(20)]).toEqual([
      AVATAR_WALKER.cells * AVATAR_WALKER.cellSize * AVATAR_WALKER_DENSITY,
      AVATAR_WALKER.cellSize * AVATAR_WALKER_DENSITY,
    ]);
  });

  it('is what the World hands the Shell, in place of the retired 2D sheet catalog', () => {
    expect(world.AVATAR_WALKER).toBe(AVATAR_WALKER);
    expect('resolveAvatarSheet' in world).toBe(false);
  });

  it('imports nothing that draws, so three.js stays out of the Shell entry chunk', () => {
    for (const module of ['./avatar-walker.ts', './avatar-state.ts']) {
      const source = readFileSync(new URL(module, import.meta.url), 'utf8');
      const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)]
        .map((match) => match[1]);
      expect(specifiers.every((specifier) => specifier === '@strkworld/shared' || specifier === './avatar-state.js'))
        .toBe(true);
    }
  });
});
