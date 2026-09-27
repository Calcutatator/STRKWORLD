import { describe, expect, it } from 'vitest';
import { SANDBOX_AREA, SANDBOX_MAX_BLOCKS, SANDBOX_MAX_HEIGHT } from '@strkworld/shared';
import {
  EMPTY_SANDBOX_SNAPSHOT,
  isSandboxTile,
  normalizeSandboxSnapshot,
  normalizeSandboxTile,
} from './sandbox-channel.js';

const X = SANDBOX_AREA.x;

describe('sandbox channel input', () => {
  it('bounds tiles to the sandbox square', () => {
    expect(isSandboxTile(X, 0)).toBe(true);
    expect(isSandboxTile(X + SANDBOX_AREA.width - 1, SANDBOX_AREA.height - 1)).toBe(true);
    expect(isSandboxTile(X - 1, 0)).toBe(false);
    expect(isSandboxTile(X + SANDBOX_AREA.width, 0)).toBe(false);
    expect(isSandboxTile(X + 0.5, 0)).toBe(false);
  });

  it('keeps valid columns and carried colour, frozen', () => {
    const snapshot = normalizeSandboxSnapshot({
      columns: [{ x: X, y: 1, colours: [0, 7] }],
      carrying: 3,
    });
    expect(snapshot).toEqual({ columns: [{ x: X, y: 1, colours: [0, 7] }], carrying: 3 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.columns)).toBe(true);
    expect(Object.isFrozen(snapshot.columns[0]?.colours)).toBe(true);
  });

  it('drops malformed columns instead of repairing them', () => {
    const snapshot = normalizeSandboxSnapshot({
      columns: [
        { x: X - 1, y: 1, colours: [1] },
        { x: X, y: 2, colours: [] },
        { x: X, y: 3, colours: [1, 8] },
        { x: X, y: 4, colours: [1.5] },
        { x: X, y: 5, colours: Array.from({ length: SANDBOX_MAX_HEIGHT + 1 }, () => 0) },
        { x: X, y: 6, colours: [2] },
        { x: X, y: 6, colours: [4] },
        null,
        'column',
      ],
      carrying: 99,
    });
    expect(snapshot.columns).toEqual([{ x: X, y: 6, colours: [2] }]);
    expect(snapshot.carrying).toBeNull();
  });

  it('never accepts more than the block cap', () => {
    const tall = (y: number) => ({ x: X, y, colours: Array.from({ length: 200 }, () => 1) });
    const snapshot = normalizeSandboxSnapshot({ columns: [0, 1, 2, 3, 4, 5].map(tall), carrying: null });
    const total = snapshot.columns.reduce((sum, column) => sum + column.colours.length, 0);
    expect(total).toBeLessThanOrEqual(SANDBOX_MAX_BLOCKS);
  });

  it('survives hostile getters and non-objects', () => {
    const hostile = Object.defineProperty({}, 'columns', {
      get() {
        throw new Error('boom');
      },
    });
    expect(normalizeSandboxSnapshot(hostile)).toBe(EMPTY_SANDBOX_SNAPSHOT);
    expect(normalizeSandboxSnapshot(undefined)).toBe(EMPTY_SANDBOX_SNAPSHOT);
    expect(normalizeSandboxTile({ x: X, y: 0 })).toEqual({ x: X, y: 0 });
    expect(normalizeSandboxTile({ x: 1, y: 0 })).toBeNull();
    expect(normalizeSandboxTile(null)).toBeNull();
  });
});
