import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BridgeService } from '@strkworld/bridge';
import type { Address, PublicShieldPlanner } from '@strkworld/privacy';
import { detectBuildContext, type BuildContext } from '../privacy/build-context.js';
import type { BridgeAccountReader, BridgeServicePort, BridgeSourceLoader } from './bridge-machine.js';

export interface BridgeRuntime {
  service: BridgeServicePort | BridgeService | null;
  loadSources: BridgeSourceLoader;
  readAccount: BridgeAccountReader;
  planner: PublicShieldPlanner | null;
  now?: () => number;
  /** Synchronous capability snapshot; null means no currently bound account. */
  account: Address | null;
  /**
   * True while the optional recovery runtime is still on its way: a loader
   * exists, it has not failed, and no service has arrived yet. The DEPOSIT
   * window tells the player it is still starting up instead of claiming that
   * saved recovery is unavailable in this browser.
   */
  loading?: boolean;
  available(): boolean;
  /**
   * Begin optional runtime acquisition. Production calls it when the player
   * enters the Bridge building (`VisitLayer`) and when BridgePanel mounts;
   * nothing else does. A call while a load is pending, or after one landed,
   * starts nothing new.
   */
  load(): void;
}

export interface BridgeRuntimeSource {
  service: BridgeServicePort | BridgeService;
  loadSources: BridgeSourceLoader;
}

export type BridgeRuntimeLoader = () => Promise<BridgeRuntimeSource | null>;

export interface BridgeProviderProps {
  service?: BridgeServicePort | BridgeService;
  loadSources?: BridgeSourceLoader;
  /** Account reader, deliberately structural so no wallet identity is named. */
  readAccount?: BridgeAccountReader;
  planner?: PublicShieldPlanner | null;
  now?: () => number;
  account?: Address | null;
  /** Recovery runtime loader; remains dormant until the player enters the Bridge or BridgePanel mounts. */
  loadRuntime?: BridgeRuntimeLoader;
  demo?: boolean;
  build?: BuildContext;
  fallback?: ReactNode;
  children: ReactNode;
}

const unavailable: BridgeRuntime = Object.freeze({
  service: null,
  loadSources: async () => [],
  readAccount: () => null,
  planner: null,
  account: null,
  available: () => false,
  load: () => {},
});

/** Keep provider-owned capability snapshots read-only at the React seam. */
function freezeRuntime(runtime: BridgeRuntime): BridgeRuntime {
  return Object.freeze(runtime);
}

const BridgeContext = createContext<BridgeRuntime>(unavailable);

interface BridgeRuntimeGenerationGuard {
  next(): number;
  invalidate(token: number): void;
  isCurrent(token: number): boolean;
}

/** Cancels optional demo work that outlives its owning provider effect. */
function createBridgeRuntimeGenerationGuard(): BridgeRuntimeGenerationGuard {
  let generation = 0;
  return {
    next: () => ++generation,
    invalidate: (token) => {
      if (token === generation) generation += 1;
    },
    isCurrent: (token) => token === generation,
  };
}

/**
 * The runtime for what the host has actually given this provider.
 *
 * The service is optional and arrives last: production fetches the recovery
 * chunk only when the player reaches the Bridge, and a browser with Web
 * Storage blocked or full never gets one at all (`production-runtime.ts`).
 * The account and the planner are not optional in that way — production
 * supplies both from boot — so they are published whether or not the service
 * has landed. `station-registry.ts` locks the DEPOSIT counter on exactly
 * those two (D-061), and a counter locked for a reason nobody can see is
 * indistinguishable from a broken one: since D-123 it shows no shimmer, no
 * key chip, and swallows E. The window behind it says what it has
 * (`BridgePanel`), which is the one surface that can.
 */
function createRuntime({
  service,
  loadSources,
  readAccount,
  planner,
  now,
  account,
  loading,
  load,
}: Pick<BridgeProviderProps, 'service' | 'loadSources' | 'readAccount' | 'planner' | 'now' | 'account'>
  & { loading: boolean; load: () => void }): BridgeRuntime {
  return freezeRuntime({
    service: service ?? null,
    loadSources: loadSources ?? (async () => []),
    readAccount: readAccount ?? (() => account ?? null),
    planner: planner ?? null,
    now,
    account: account ?? null,
    loading,
    available: () => Boolean(account && planner),
    // Still live: the window and Bridge entry both ask for the optional
    // runtime, and a runtime built before it landed must not silence them.
    load,
  });
}

export function useBridge(): BridgeRuntime {
  return useContext(BridgeContext);
}

/**
 * Bridge composition is explicit like PrivacyProvider. Demo code is lazy and
 * refused in production. A real runtime without a planner exposes saved-record
 * recovery while keeping new deposits and shield continuation locked.
 */
export function BridgeProvider({
  service,
  loadSources,
  readAccount,
  planner = null,
  account = null,
  loadRuntime,
  demo = false,
  build,
  fallback = null,
  children,
  now,
}: BridgeProviderProps) {
  const demoRejected = demo && (build ?? detectBuildContext()).production;

  const [loadedRuntime, setLoadedRuntime] = useState<{
    loader: BridgeRuntimeLoader;
    generation: number;
    source: BridgeRuntimeSource;
  } | null>(null);
  /**
   * The loader that answered with nothing, or threw: there is no optional
   * runtime to wait for any more, so the window stops saying it is starting
   * up and says what is actually unavailable.
   */
  const [failedLoader, setFailedLoader] = useState<{ loader: BridgeRuntimeLoader } | null>(null);
  const loadOwner = useRef<{
    loader: BridgeRuntimeLoader | undefined;
    service: BridgeProviderProps['service'];
    generation: number;
    pending: boolean;
  }>({ loader: loadRuntime, service, generation: 1, pending: false });

  // Props are authoritative during render. Do not initialize this owner in an
  // effect: React mounts child effects before parent effects, and a child —
  // VisitLayer on Bridge entry, or BridgePanel — legitimately starts the first
  // load.
  if (loadOwner.current.loader !== loadRuntime || loadOwner.current.service !== service) {
    loadOwner.current = {
      loader: loadRuntime,
      service,
      generation: loadOwner.current.generation + 1,
      pending: false,
    };
  }

  useEffect(() => {
    const generation = loadOwner.current.generation;
    return () => {
      if (loadOwner.current.generation !== generation) return;
      loadOwner.current.generation += 1;
      loadOwner.current.pending = false;
    };
  }, [loadRuntime]);

  const load = useCallback(() => {
    const currentRuntime = loadedRuntime
      && loadedRuntime.loader === loadRuntime
      && loadedRuntime.generation === loadOwner.current.generation
      ? loadedRuntime.source
      : null;
    if (!loadRuntime || service || currentRuntime || demoRejected || loadOwner.current.pending) return;
    const generation = loadOwner.current.generation;
    loadOwner.current.pending = true;
    void Promise.resolve().then(() => loadRuntime()).then((runtime) => {
      if (generation !== loadOwner.current.generation) return;
      if (runtime) setLoadedRuntime({ loader: loadRuntime, generation, source: runtime });
      // A loader that answers with nothing has given its answer: this browser
      // has no usable recovery store (`production-runtime.ts`), or no chunk.
      else setFailedLoader({ loader: loadRuntime });
    }).catch(() => {
      // Optional Bridge recovery is isolated from wallet/app admission. A
      // missing chunk or restricted storage leaves only this route unavailable.
      if (generation === loadOwner.current.generation) setFailedLoader({ loader: loadRuntime });
    }).finally(() => {
      if (generation === loadOwner.current.generation) loadOwner.current.pending = false;
    });
  }, [loadRuntime, service, loadedRuntime, demoRejected]);

  const currentRuntime = loadedRuntime
    && loadedRuntime.loader === loadRuntime
    && loadedRuntime.generation === loadOwner.current.generation
    ? loadedRuntime.source
    : null;
  const resolvedService = service ?? currentRuntime?.service;
  const resolvedSources = loadSources ?? currentRuntime?.loadSources;
  // Still fetching the optional runtime: a loader that has neither answered
  // nor failed, with no service of our own.
  const loading = Boolean(loadRuntime) && !resolvedService && !demoRejected && failedLoader?.loader !== loadRuntime;
  const directRuntime = useMemo(
    () => (resolvedService || ((account || planner) && !demo)) && !demoRejected
      ? createRuntime({ service: resolvedService, loadSources: resolvedSources, readAccount, planner, now, account, loading, load })
      : null,
    [resolvedService, resolvedSources, readAccount, planner, now, account, demo, demoRejected, loading, load],
  );
  const [resolved, setResolved] = useState<BridgeRuntime | null>(null);
  const generation = useMemo(createBridgeRuntimeGenerationGuard, []);

  useEffect(() => {
    const token = generation.next();
    let cancelled = false;
    setResolved(null);
    if (!demo || service || demoRejected) {
      return () => {
        cancelled = true;
        generation.invalidate(token);
      };
    }
    void import('./demo-runtime.js').then(async ({ createDemoBridgeRuntime }) => {
      const runtime = await createDemoBridgeRuntime();
      if (!cancelled && generation.isCurrent(token)) setResolved(freezeRuntime(runtime));
    }).catch(() => {
      // A failed optional demo import leaves the bridge unavailable. Do not
      // resurrect a runtime from an earlier provider configuration.
    });
    return () => {
      cancelled = true;
      generation.invalidate(token);
    };
  }, [demo, service, demoRejected, generation]);

  // Direct runtimes are derived from the current props during render. This
  // makes a live -> absent/rejected transition immediately unavailable, even
  // before React flushes the effect that cancels an in-flight demo import.
  const dormantRuntime = useMemo<BridgeRuntime>(
    () => freezeRuntime({ ...unavailable, loading, load }),
    [loading, load],
  );
  const runtime = directRuntime ?? (demo && !demoRejected ? resolved : null) ?? dormantRuntime;
  if (demoRejected) {
    throw new Error('<BridgeProvider demo> reached a production build. Demo bridge funding is disabled.');
  }
  // Keep the shell mounted while the bridge chunk loads. The unavailable
  // runtime makes its station locked and its Menu panel honest; it never
  // fabricates a balance or starts a provider call.
  return <BridgeContext.Provider value={runtime}>
    {directRuntime || resolved ? children : (fallback ?? children)}
  </BridgeContext.Provider>;
}

/** Convenience account reader for hosts that already hold the account value. */
export function fixedBridgeAccount(address: Address | null): BridgeAccountReader {
  return () => address;
}
