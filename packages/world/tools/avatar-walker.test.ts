import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AVATAR_WALKER, AVATAR_WALKER_DENSITY } from '../src/avatar-walker.js';
import {
  AVATAR_WALKER_FILE,
  WALKER_CELL_PX,
  decodePng,
  encodePng,
  maxChannelDifference,
  renderAvatarWalker,
  stripCell,
  type WalkerStrip,
} from './avatar-walker.js';

const REGENERATE = 'npm run render:walker --workspace=@strkworld/world';
const RENDER_TIMEOUT_MS = 120_000;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const strip = (png: { width: number; height: number; rgba: Uint8Array }): WalkerStrip => ({
  ...png,
  cells: png.width / png.height,
});

describe('the avatar walker strip (tools/avatar-walker.ts)', () => {
  const file = readFileSync(AVATAR_WALKER_FILE);
  const committed = decodePng(file);
  let fresh: WalkerStrip;

  beforeAll(() => {
    fresh = renderAvatarWalker();
  }, RENDER_TIMEOUT_MS);

  it('is the file AVATAR_WALKER points at, laid out as it says', () => {
    expect(AVATAR_WALKER.url).toBe(AVATAR_WALKER_FILE.href);
    expect(WALKER_CELL_PX).toBe(AVATAR_WALKER.cellSize * AVATAR_WALKER_DENSITY);
    expect([committed.width, committed.height]).toEqual([AVATAR_WALKER.cells * WALKER_CELL_PX, WALKER_CELL_PX]);
    expect([fresh.width, fresh.height, fresh.cells]).toEqual([committed.width, committed.height, AVATAR_WALKER.cells]);
  });

  it(`shows the current figure: a fresh render gives the committed pixels (else run ${REGENERATE})`, () => {
    // Pixels, not file bytes: another zlib may compress the same pixels differently.
    // A last-bit float difference between Node builds may nudge a channel by one.
    const difference = maxChannelDifference(fresh.rgba, committed.rgba);
    let changed = 0;
    for (let i = 0; i < fresh.rgba.length; i += 1) {
      if (fresh.rgba[i] !== committed.rgba[i]) changed += 1;
    }
    expect(difference, `a channel moved by ${difference}; run ${REGENERATE}`).toBeLessThanOrEqual(1);
    expect(changed, `${changed} bytes changed; run ${REGENERATE}`).toBeLessThan(fresh.rgba.length / 1000);
  });

  it('renders the same pixels every time: the same model gives the same hash', () => {
    const again = renderAvatarWalker();
    expect(sha256(again.rgba)).toBe(sha256(fresh.rgba));
    // Encoding is deterministic too, and lossless.
    expect(sha256(encodePng(again.width, again.height, again.rgba))).toBe(
      sha256(encodePng(fresh.width, fresh.height, fresh.rgba)),
    );
    expect(sha256(decodePng(encodePng(fresh.width, fresh.height, fresh.rgba)).rgba)).toBe(sha256(fresh.rgba));
  }, RENDER_TIMEOUT_MS);

  it('stands in the first cell, then walks: a new pose every step, each foot forward once', () => {
    const cells = Array.from({ length: AVATAR_WALKER.cells }, (_, index) => stripCell(strip(committed), index));
    const [standing, ...walking] = cells;
    for (const pose of walking) expect(maxChannelDifference(standing!, pose)).toBeGreaterThan(64);
    // The figure swings its limbs on sin(phase): each step shows a new pose,
    // and the loop's last cell leads back into its first.
    walking.forEach((pose, index) => {
      expect(maxChannelDifference(pose, walking[(index + 1) % walking.length]!)).toBeGreaterThan(16);
    });
    // A quarter stride in, one foot leads; three quarters in, the other does.
    const quarter = AVATAR_WALKER.walkFrames / 4;
    expect(maxChannelDifference(walking[quarter]!, walking[3 * quarter]!)).toBeGreaterThan(64);
  });

  it('draws only the figure and a soft contact shadow, on a transparent ground', () => {
    const report = Array.from({ length: AVATAR_WALKER.cells }, (_, index) => {
      const cell = stripCell(strip(committed), index);
      const found = { edgePixels: 0, strayColour: 0, opaque: 0, soft: 0, shadowBelowFeet: false };
      let lowestOpaqueRow = -1;
      let lowestSoftRow = -1;
      for (let y = 0; y < WALKER_CELL_PX; y += 1) {
        for (let x = 0; x < WALKER_CELL_PX; x += 1) {
          const at = (y * WALKER_CELL_PX + x) * 4;
          const alpha = cell[at + 3]!;
          const edge = x === 0 || y === 0 || x === WALKER_CELL_PX - 1 || y === WALKER_CELL_PX - 1;
          if (edge && alpha !== 0) found.edgePixels += 1;
          if (alpha === 0) {
            // Clean transparency compresses best and hides no stray colour.
            if (cell[at]! + cell[at + 1]! + cell[at + 2]! !== 0) found.strayColour += 1;
          } else if (alpha === 255) {
            found.opaque += 1;
            lowestOpaqueRow = y;
          } else {
            found.soft += 1;
            lowestSoftRow = y;
          }
        }
      }
      found.shadowBelowFeet = lowestSoftRow > lowestOpaqueRow;
      return {
        ...found,
        opaque: found.opaque > 2000,
        soft: found.soft > 500,
      };
    });
    expect(report).toEqual(Array.from({ length: AVATAR_WALKER.cells }, () => ({
      edgePixels: 0,
      strayColour: 0,
      opaque: true,
      soft: true,
      shadowBelowFeet: true,
    })));
  });

  it('stays a small file for the Shell to load', () => {
    expect(file.length).toBeLessThan(64 * 1024);
  });
});
