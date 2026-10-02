import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Leaderboard phase 1: a placement is shown only in the stand's panel, on the
 * player's device. It never reaches the avatar, the HUD, presence, the lobby
 * or the shared bus (D-011: showing it on an avatar would tie that avatar to a
 * receipt timeline). Checked on the source, so a later change that wires a
 * placement anywhere else fails here.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function sources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** What a placement looks like in code: the check, its result, its record, its storage key. */
const PLACEMENT = /checkPlacement|PlacementCheck|PlacementRecord|PlacementView|topPercent|strkworld:placement|plaza\/placement|PlacementPanel/;

describe('a placement stays in the stand\'s panel', () => {
  it.each([
    ['the lobby', 'packages/lobby/src'],
    ['the shared bus and schema', 'packages/shared/src'],
    ['the World (avatars, the HUD prompt, the plaza)', 'packages/world/src'],
    ['presence', 'apps/web/src/presence'],
    ['the HUD', 'apps/web/src/hud'],
    ['the bus', 'apps/web/src/bus'],
  ])('never reaches %s', (_label, dir) => {
    const offenders = sources(dir).filter(({ text }) => PLACEMENT.test(text)).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('is read and written by the stand\'s panel alone in the Shell', () => {
    const readers = sources('apps/web/src')
      .filter(({ path }) => !path.endsWith('plaza/placement.ts'))
      .filter(({ text }) => /from '(?:\.\.?\/)+(?:plaza\/)?placement\.js'/.test(text))
      .map(({ path }) => path);
    expect(readers).toEqual(['apps/web/src/panels/plaza/PlacementPanel.tsx']);
  });

  it('adds no lobby message or shared event for it', () => {
    const shared = readFileSync(join(ROOT, 'packages/shared/src/index.ts'), 'utf8');
    expect(shared).not.toMatch(/leaderboard|placement:|receipt/i);
  });
});
