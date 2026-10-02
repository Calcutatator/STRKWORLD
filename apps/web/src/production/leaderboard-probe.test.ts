import { afterEach, describe, expect, it } from 'vitest';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { parseLeaderboard, parseRoutePolicy, placementStandFrom, withLeaderboardProbe } from './config.js';
import {
  LEADERBOARD_PROBE_KEY,
  detectLeaderboardProbe,
  readLeaderboardProbe,
  resetLeaderboardProbe,
} from './leaderboard-probe.js';

/**
 * Probe mode (D-122, amended 2026-10-02): the lead can try receipts and the
 * placement stand on mainnet in their own tab, with the build flag set for
 * the whole deploy, without switching either on for anyone else. The flag
 * counts only with `?lb=1`; without it the build reads as if the flag were
 * unset.
 */

const LEDGER = '0x01517eeedc0d7a352e841a87a55312e2e19d28e6d09247822b28d044541766f8';
const LEADERBOARD = { VITE_STRK20_LEADERBOARD_ENABLED: 'true', VITE_STRK20_LEADERBOARD_LEDGER: LEDGER };
const PRODUCTION = {
  PROD: true,
  VITE_STRK20_SHIELD_ENABLED: 'true',
  VITE_STRK20_SHIELD_MAX_INTENTS: '1',
  VITE_STRK20_SHIELD_ALLOWED_TOKENS: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
};

function memoryStorage(): { storage: ReturnType<typeof createViewerStorage>; map: Map<string, string> } {
  const map = new Map<string, string>();
  const backing: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
  return { storage: createViewerStorage(() => backing), map };
}

afterEach(() => {
  resetLeaderboardProbe();
  delete (globalThis as { location?: unknown }).location;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

describe('the tab\'s opt-in', () => {
  it('turns on with ?lb=1 and stays on for the tab', () => {
    const { storage, map } = memoryStorage();
    expect(readLeaderboardProbe('', storage)).toBe(false);
    expect(readLeaderboardProbe('?lb=1', storage)).toBe(true);
    expect([...map.keys()]).toEqual([LEADERBOARD_PROBE_KEY]);
    // A page of the city with no parameter of its own, and a reload.
    expect(readLeaderboardProbe('', storage)).toBe(true);
    expect(readLeaderboardProbe('?debug=1', storage)).toBe(true);
  });

  it('turns off with ?lb=0, and reads anything else as off', () => {
    const { storage, map } = memoryStorage();
    readLeaderboardProbe('?lb=1', storage);
    expect(readLeaderboardProbe('?lb=0', storage)).toBe(false);
    expect([...map.keys()]).toEqual([]);
    for (const search of ['?lb=', '?lb=true', '?lb=2', '?lbb=1', '']) {
      expect(readLeaderboardProbe(search, storage), search).toBe(false);
    }
  });

  it('never throws on a browser that refuses storage: it is simply off', () => {
    const throwing = createViewerStorage(() => {
      throw new Error('blocked');
    });
    expect(readLeaderboardProbe('?lb=1', throwing)).toBe(true);
    expect(readLeaderboardProbe('', throwing)).toBe(false);
    expect(readLeaderboardProbe(undefined, throwing)).toBe(false);
  });

  it('answers once per page load, from the page\'s own URL and session storage', () => {
    const { map } = memoryStorage();
    Object.assign(globalThis, {
      location: { search: '?lb=1' },
      sessionStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
        removeItem: (key: string) => { map.delete(key); },
      },
    });
    expect(detectLeaderboardProbe()).toBe(true);
    // The answer is the tab's, not re-derived per render: a URL rewritten
    // afterwards (as the debug switch rewrites its own) changes nothing.
    (globalThis as { location: { search: string } }).location.search = '';
    expect(detectLeaderboardProbe()).toBe(true);
    resetLeaderboardProbe();
    // And the remembered opt-in still answers once the parameter is gone.
    expect(detectLeaderboardProbe()).toBe(true);
    map.clear();
    resetLeaderboardProbe();
    expect(detectLeaderboardProbe()).toBe(false);
  });

  it('is off with no page at all', () => {
    expect(detectLeaderboardProbe()).toBe(false);
  });
});

describe('what a build without the opt-in reads as', () => {
  it('hides the leaderboard flag, and touches nothing else', () => {
    const environment = { ...PRODUCTION, ...LEADERBOARD };
    const probed = withLeaderboardProbe(environment, false);
    expect(probed.VITE_STRK20_LEADERBOARD_ENABLED).toBeUndefined();
    expect(probed.VITE_STRK20_LEADERBOARD_LEDGER).toBe(LEDGER);
    expect(withLeaderboardProbe(environment, true)).toBe(environment);
    expect(withLeaderboardProbe(undefined, false)).toBeUndefined();
    expect(withLeaderboardProbe(PRODUCTION, false)).toBe(PRODUCTION);
    // Every other variable survives, so the probe can never close a route.
    expect(parseRoutePolicy(probed).enabledRoutes).toEqual(['shield']);
  });

  it('carries no receipt and stands no stand without the opt-in', () => {
    const production = { ...PRODUCTION, ...LEADERBOARD };
    const demo = { DEV: true, ...LEADERBOARD };
    for (const environment of [production, demo]) {
      const off = withLeaderboardProbe(environment, false);
      expect(parseLeaderboard(off)).toBeNull();
      expect(Object.keys(parseRoutePolicy(off))).not.toContain('leaderboard');
      expect(placementStandFrom(off)).toBe(false);

      const on = withLeaderboardProbe(environment, true);
      expect(placementStandFrom(on)).toBe(true);
    }
    // `parseLeaderboard` normalises the felt, so the policy drops its leading zero.
    expect(parseRoutePolicy(withLeaderboardProbe(production, true)).leaderboard)
      .toEqual({ ledger: `0x${BigInt(LEDGER).toString(16)}` });
  });

  it('is off for a probing tab when the build flag is unset: both are needed', () => {
    const noFlag = { ...PRODUCTION, VITE_STRK20_LEADERBOARD_LEDGER: LEDGER };
    expect(placementStandFrom(withLeaderboardProbe(noFlag, true))).toBe(false);
    expect(Object.keys(parseRoutePolicy(withLeaderboardProbe(noFlag, true)))).not.toContain('leaderboard');
  });
});
