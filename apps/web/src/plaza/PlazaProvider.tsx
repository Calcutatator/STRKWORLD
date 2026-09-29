import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { ownPlazaNearbyPayload } from '../bus/world-event-payload.js';
import { detectBuildContext, type BuildContext } from '../privacy/build-context.js';
import { detectRoutePolicy } from '../production/config.js';
import { useStore } from '../store/use-store.js';
import { createPoolStatsPoller, type PoolStatsPoller, type PoolStatsView } from './pool-stats-poller.js';
import { plazaStatsEvent, plazaTokens, type PlazaToken, type PoolStatsSnapshot, type PoolStatsSource } from './pool-stats.js';
import { createShellStreak, type ShellStreak } from './shell-game.js';

/**
 * The Shell's half of the Privacy Plaza (D-076), composed like the degen
 * list: production supplies the backend source, the demo loads its sample
 * figures lazily and is refused outright in a production build, and with
 * neither the monument shows "…".
 *
 * It owns one poller, which reads while the World says the plaza is in view
 * or a monument window is open, and hands the World its figures; and the
 * shell game's streak, which lives in memory for as long as the city does.
 */

interface PlazaContextValue {
  readonly poller: PoolStatsPoller;
  readonly tokens: readonly PlazaToken[];
  readonly streak: ShellStreak;
}

const PlazaContext = createContext<PlazaContextValue | null>(null);

/** The demo figures sit behind a dynamic import, so they never join the entry chunk. */
const DEMO_POOL_STATS: PoolStatsSource = Object.freeze({
  demo: true,
  async load(signal?: AbortSignal): Promise<PoolStatsSnapshot> {
    const { DEMO_POOL_STATS_SOURCE } = await import('./demo-pool-stats.js');
    return DEMO_POOL_STATS_SOURCE.load(signal);
  },
});

export function PlazaProvider({
  world,
  shell,
  source,
  demo = false,
  build,
  policy = detectRoutePolicy(),
  children,
}: {
  world: Pick<EventBus<WorldEvents>, 'on'>;
  shell: Pick<EventBus<ShellEvents>, 'emit'>;
  /** The production figures, from the same-origin backend. */
  source?: PoolStatsSource;
  /** Use the demo figures. Never true in a production build. */
  demo?: boolean;
  build?: BuildContext;
  /** Which tokens the held figures cover: this build's shield allowlist. */
  policy?: WalletRoutePolicy | null;
  children: ReactNode;
}) {
  const demoRejected = !source && demo && (build ?? detectBuildContext()).production;
  if (demoRejected) {
    throw new Error('<PlazaProvider demo> reached a production build. The demo pool stats must never ship.');
  }
  const effective = source ?? (demo ? DEMO_POOL_STATS : null);
  const listed = plazaTokens(policy);
  // Keyed by the tokens, not the policy object, which may be parsed afresh
  // on every render: the same list keeps the same poller.
  const tokens = useMemo(() => listed, [listed.map((token) => token.token).join(',')]);
  const poller = useMemo(
    () => createPoolStatsPoller({
      source: effective,
      publish: (stats) => shell.emit('plaza:stats', plazaStatsEvent(stats, tokens)),
    }),
    [effective, shell, tokens],
  );
  const streak = useMemo(() => createShellStreak(), []);

  useEffect(() => {
    const stop = world.on('plaza:nearby', (payload) => {
      const owned = ownPlazaNearbyPayload(payload);
      if (owned) poller.setNear(owned.near);
    });
    return () => {
      stop();
      poller.release();
    };
  }, [world, poller]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') poller.wake();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [poller]);

  const value = useMemo(() => Object.freeze({ poller, tokens, streak }), [poller, tokens, streak]);
  return <PlazaContext.Provider value={value}>{children}</PlazaContext.Provider>;
}

function usePlaza(): PlazaContextValue {
  const value = useContext(PlazaContext);
  if (!value) throw new Error('The Privacy Plaza windows need a PlazaProvider.');
  return value;
}

/**
 * The pool figures for a window that shows them. While it is mounted it
 * counts as someone looking, so the figures stay fresh.
 */
export function usePoolStatsWindow(): { readonly view: PoolStatsView; readonly tokens: readonly PlazaToken[] } {
  const { poller, tokens } = usePlaza();
  const view = useStore(poller.store);
  useEffect(() => poller.open(), [poller]);
  return { view, tokens };
}

/** The shell game's streak for this page. */
export function useShellStreak(): ShellStreak {
  return usePlaza().streak;
}
