import { createViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';

/**
 * Probe mode for the private leaderboard (D-122, amended 2026-10-02).
 *
 * The lead needs to try receipts and the placement stand on mainnet, in their
 * own wallet, without switching them on for everyone the deploy serves. So the
 * build flag is no longer enough by itself: `VITE_STRK20_LEADERBOARD_ENABLED`
 * must be `true` **and** the tab must have been opened with `?lb=1`. Without
 * both, `config.ts` reads the build as if the flag were unset — no
 * `leaderboard` in the route policy, so no receipt rides on any action, no
 * wallet is asked for a season commitment, and the stand stays locked.
 *
 * `?lb=1` is remembered for the tab in `sessionStorage`, so walking the city
 * and reloading keep it on; `?lb=0` forgets it. Every access goes through
 * `createViewerStorage`, which swallows a browser that has no storage, throws
 * on the getter, or refuses a write — a probe switch must never be able to
 * stop the city from opening. The same shape as D-069's `?debug=1`.
 *
 * The backend half (`BACKEND_LEADERBOARD_ENABLED`) is a service-wide switch
 * and not gated here: the tally can be open while only the probing tab
 * checks in.
 */

/** The tab's remembered opt-in. One key, one constant value. */
export const LEADERBOARD_PROBE_KEY = 'strkworld:lb-probe';

/** The page's own `sessionStorage`, resolved on each access: the getter can throw. */
export const probeSessionStorage: ViewerStorage = createViewerStorage(
  () => globalThis.sessionStorage,
);

/**
 * The runtime opt-in. `?lb=1` turns it on and remembers it for this tab,
 * `?lb=0` turns it off and forgets it, and anything else leaves the
 * remembered choice standing. Never throws.
 */
export function readLeaderboardProbe(
  search: string | undefined,
  storage: ViewerStorage = probeSessionStorage,
): boolean {
  let requested: string | null = null;
  try {
    requested = new URLSearchParams(search ?? '').get('lb');
  } catch {
    requested = null;
  }
  if (requested === '1') {
    storage.write(LEADERBOARD_PROBE_KEY, 'on');
    return true;
  }
  if (requested === '0') {
    storage.remove(LEADERBOARD_PROBE_KEY);
    return false;
  }
  return storage.read(LEADERBOARD_PROBE_KEY) === 'on';
}

let resolved: boolean | null = null;

/**
 * Whether this tab is probing, resolved once per page load: the switch is a
 * property of the tab, and the route policy is read from many renders.
 */
export function detectLeaderboardProbe(): boolean {
  if (resolved !== null) return resolved;
  let search: string | undefined;
  try {
    search = globalThis.location?.search;
  } catch {
    search = undefined;
  }
  resolved = readLeaderboardProbe(search);
  return resolved;
}

/** Forget this page load's answer, so the next read looks again. Tests only. */
export function resetLeaderboardProbe(): void {
  resolved = null;
}
