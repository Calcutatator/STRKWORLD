import { describe, expect, it } from 'vitest';
import {
  SANDBOX_AREA,
  SANDBOX_MAX_HEIGHT,
  type SandboxColumn,
} from '@strkworld/shared';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';
import { createStreetMap, isSolidAt, TILE_SIZE, worldToTile } from './map/street.js';
import {
  FLAT_SANDBOX,
  bodyNearSandbox,
  createSandboxHeights,
  levelUnderBody,
  moveOnHeightmap,
  sandboxAim,
  withinReach,
} from './sandbox.js';
import { moveWithCollisionSubsteps } from './street-movement.js';

const MAP = createStreetMap();
const HALF = AVATAR_BODY_SIZE / 2;
const centre = (tileX: number, tileY: number) => ({
  x: tileX * TILE_SIZE + TILE_SIZE / 2,
  y: tileY * TILE_SIZE + TILE_SIZE / 2,
});
const stack = (x: number, y: number, height: number, colour = 0): SandboxColumn => ({
  x,
  y,
  colours: Array.from({ length: height }, () => colour),
});
const street = {
  tileSize: TILE_SIZE,
  collisionHalfSize: HALF,
  toTile: worldToTile,
  isSolidAt: (x: number, y: number) => isSolidAt(MAP, x, y),
};
/** Walk east for `ms` at walking speed from `from`. */
const walkEast = (heights: ReturnType<typeof createSandboxHeights>, from: { x: number; y: number }, ms: number) =>
  moveOnHeightmap({ ...street, heights, position: from, velocity: { x: 160, y: 0 }, delta: ms });

const X = SANDBOX_AREA.x + 4;
const Y = 14;

describe('sandbox heights', () => {
  it('reads stack heights and top colours, and nothing outside stacks', () => {
    const heights = createSandboxHeights([{ x: X, y: Y, colours: [3, 1, 6] }]);
    expect(heights.heightAt(X, Y)).toBe(3);
    expect(heights.topColourAt(X, Y)).toBe(6);
    expect(heights.heightAt(X + 1, Y)).toBe(0);
    expect(heights.topColourAt(X + 1, Y)).toBeNull();
  });

  it('stands a body on the tallest stack it overlaps, and not on one it merely touches', () => {
    const heights = createSandboxHeights([stack(X, Y, 2), stack(X + 1, Y, 5)]);
    expect(levelUnderBody(heights, centre(X, Y), HALF, TILE_SIZE)).toBe(2);
    // Body centred on the boundary overlaps both columns.
    expect(levelUnderBody(heights, { x: (X + 1) * TILE_SIZE, y: centre(X, Y).y }, HALF, TILE_SIZE)).toBe(5);
    // Right edge exactly on the boundary: touching is not standing.
    const touching = { x: (X + 1) * TILE_SIZE - HALF, y: centre(X, Y).y };
    expect(levelUnderBody(heights, touching, HALF, TILE_SIZE)).toBe(2);
  });

  it('ignores stacks outside the sandbox and non-finite positions', () => {
    const outside = createSandboxHeights([stack(SANDBOX_AREA.x - 2, Y, 4)]);
    expect(levelUnderBody(outside, centre(SANDBOX_AREA.x - 2, Y), HALF, TILE_SIZE)).toBe(0);
    expect(levelUnderBody(FLAT_SANDBOX, { x: Number.NaN, y: 0 }, HALF, TILE_SIZE)).toBe(0);
  });

  it('knows when a body is near the sandbox', () => {
    expect(bodyNearSandbox(centre(SANDBOX_AREA.x - 1, Y), HALF, TILE_SIZE)).toBe(true);
    expect(bodyNearSandbox(centre(SANDBOX_AREA.x - 3, Y), HALF, TILE_SIZE)).toBe(false);
  });
});

describe('walking on stacks', () => {
  it('moves exactly like the tile mover when there are no blocks', () => {
    for (const [from, velocity, delta] of [
      [centre(40, 14), { x: 160, y: 0 }, 16],
      [centre(52, 13), { x: 113, y: -113 }, 100],
      [centre(60, 1), { x: -240, y: -80 }, 1000],
      [centre(24, 12), { x: 0, y: -160 }, 900],
    ] as const) {
      const plain = moveWithCollisionSubsteps({ ...street, position: from, velocity, delta });
      const onBlocks = moveOnHeightmap({ ...street, heights: FLAT_SANDBOX, position: from, velocity, delta });
      expect(onBlocks).toEqual(plain);
    }
  });

  it('steps up onto a stack one block higher', () => {
    const heights = createSandboxHeights([stack(X + 1, Y, 1)]);
    // One tile at walking speed: 32 px in 200 ms lands on the stack's centre.
    const end = walkEast(heights, centre(X, Y), 200);
    expect(Math.floor(end.x / TILE_SIZE)).toBe(X + 1);
    expect(levelUnderBody(heights, end, HALF, TILE_SIZE)).toBe(1);
  });

  it('treats a stack two blocks higher as a wall', () => {
    const heights = createSandboxHeights([stack(X + 1, Y, 2)]);
    const end = walkEast(heights, centre(X, Y), 1000);
    expect(end.x + HALF).toBeLessThanOrEqual((X + 1) * TILE_SIZE);
    expect(levelUnderBody(heights, end, HALF, TILE_SIZE)).toBe(0);
  });

  it('climbs a staircase one step at a time but never skips a step', () => {
    const stairs = createSandboxHeights([stack(X + 1, Y, 1), stack(X + 2, Y, 2), stack(X + 3, Y, 3)]);
    // Three tiles in 600 ms: stop on the top step rather than walking off it.
    const top = walkEast(stairs, centre(X, Y), 600);
    expect(Math.floor(top.x / TILE_SIZE)).toBe(X + 3);
    expect(levelUnderBody(stairs, top, HALF, TILE_SIZE)).toBe(3);
    const gap = createSandboxHeights([stack(X + 1, Y, 1), stack(X + 2, Y, 3)]);
    const stuck = walkEast(gap, centre(X, Y), 2000);
    expect(levelUnderBody(gap, stuck, HALF, TILE_SIZE)).toBe(1);
    expect(stuck.x + HALF).toBeLessThanOrEqual((X + 2) * TILE_SIZE);
  });

  it('steps down any height', () => {
    const heights = createSandboxHeights([stack(X, Y, 9)]);
    const end = walkEast(heights, centre(X, Y), 600);
    expect(levelUnderBody(heights, end, HALF, TILE_SIZE)).toBe(0);
  });

  it('keeps the street collision: the sandbox edge of the map is still solid', () => {
    const east = SANDBOX_AREA.x + SANDBOX_AREA.width - 1;
    const end = walkEast(FLAT_SANDBOX, centre(east, Y), 1000);
    expect(end.x + HALF).toBeLessThanOrEqual((east + 1) * TILE_SIZE);
  });
});

describe('aiming the block key', () => {
  const aim = (options: {
    heights?: ReturnType<typeof createSandboxHeights>;
    at?: { x: number; y: number };
    facing?: 'up' | 'down' | 'left' | 'right';
    carrying?: number | null;
  }) => sandboxAim({
    heights: options.heights ?? FLAT_SANDBOX,
    position: options.at ?? centre(X, Y),
    facing: options.facing ?? 'right',
    carrying: options.carrying ?? null,
    halfSize: HALF,
    tileSize: TILE_SIZE,
  });

  it('targets the faced neighbour inside the sandbox, and nothing outside it', () => {
    expect(aim({ facing: 'up', carrying: 1 })?.tile).toEqual({ x: X, y: Y - 1 });
    expect(aim({ facing: 'left', carrying: 1 })?.tile).toEqual({ x: X - 1, y: Y });
    expect(aim({ at: centre(SANDBOX_AREA.x, Y), facing: 'left', carrying: 1 })).toBeNull();
    expect(aim({ at: centre(SANDBOX_AREA.x - 3, Y), carrying: 1 })).toBeNull();
  });

  it('picks with empty hands only when a block is within reach', () => {
    // Bare floor with empty hands: nothing to aim at.
    expect(aim({})).toBeNull();
    const one = createSandboxHeights([stack(X + 1, Y, 1)]);
    expect(aim({ heights: one })).toMatchObject({ mode: 'pick', valid: true, level: 1 });
    const tall = createSandboxHeights([stack(X + 1, Y, 3)]);
    expect(aim({ heights: tall })).toMatchObject({ mode: 'pick', valid: false });
  });

  it('places when carrying, up to two blocks above the feet', () => {
    expect(aim({ carrying: 2 })).toMatchObject({ mode: 'place', valid: true, level: 0 });
    const two = createSandboxHeights([stack(X + 1, Y, 2)]);
    expect(aim({ heights: two, carrying: 2 })).toMatchObject({ mode: 'place', valid: false });
    const one = createSandboxHeights([stack(X + 1, Y, 1)]);
    expect(aim({ heights: one, carrying: 2 })).toMatchObject({ mode: 'place', valid: true, level: 1 });
  });

  it('cannot reach far below the feet or past the ceiling', () => {
    // Standing on a five-block tower: the bare ground beside it is out of reach.
    const tower = createSandboxHeights([stack(X, Y, 5)]);
    expect(aim({ heights: tower })).toBeNull();
    expect(aim({ heights: tower, carrying: 1 })).toMatchObject({ valid: false });
    const low = createSandboxHeights([stack(X, Y, 5), stack(X + 1, Y, 1)]);
    expect(aim({ heights: low })).toMatchObject({ mode: 'pick', valid: false });
    const ceiling = createSandboxHeights([stack(X, Y, SANDBOX_MAX_HEIGHT - 1), stack(X + 1, Y, SANDBOX_MAX_HEIGHT)]);
    expect(aim({ heights: ceiling, carrying: 1 })).toMatchObject({ valid: false });
  });

  it('shares the authority reach band', () => {
    expect(withinReach(3, 2)).toBe(true);
    expect(withinReach(3, 1)).toBe(false);
    expect(withinReach(3, 5)).toBe(true);
    expect(withinReach(3, 6)).toBe(false);
  });
});
