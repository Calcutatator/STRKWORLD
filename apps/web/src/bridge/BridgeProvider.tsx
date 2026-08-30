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
  available(): boolean;
  /** Begin optional runtime acquisition. BridgePanel is the only production caller. */
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
  /** Recovery runtime loader; remains dormant until BridgePanel mounts. */
  loadRuntime?: BridgeRuntimeLoader;
  demo?: boolean;
  build?: BuildContext;
  fallback?: ReactNode;
  children: ReactNode;
}

const unavailable: BridgeRuntime = {
  service: null,
  loadSources: async () => [],
  readAccount: () => null,
  planner: null,
  account: null,
  available: () => false,
  load: () => {},
};

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

function createRuntime({
  service,
  loadSources,
  readAccount,
  planner,
  now,
  account,
}: Pick<BridgeProviderProps, 'service' | 'loadSources' | 'readAccount' | 'planner' | 'now' | 'account'>): BridgeRuntime {
  if (!service) return unavailable;
  return {
    service,
    loadSources: loadSources ?? (async () => []),
    readAccount: readAccount ?? (() => account ?? null),
    planner: planner ?? null,
    now,
    account: account ?? null,
    available: () => Boolean(account && planner),
    load: () => {},
  };
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
    source: BridgeRuntimeSource;
  } | null>(null);
  const loadOwner = useRef<{
    loader: BridgeRuntimeLoader | undefined;
    generation: number;
    pending: boolean;
  }>({ loader: loadRuntime, generation: 1, pending: false });

  // Props are authoritative during render. Do not initialize this owner in an
  // effect: React mounts child effects before parent effects, and BridgePanel
  // is the child that legitimately starts the first load.
  if (loadOwner.current.loader !== loadRuntime) {
    loadOwner.current = {
      loader: loadRuntime,
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
    const currentRuntime = loadedRuntime && loadedRuntime.loader === loadRuntime ? loadedRuntime.source : null;
    if (!loadRuntime || service || currentRuntime || demoRejected || loadOwner.current.pending) return;
    const generation = loadOwner.current.generation;
    loadOwner.current.pending = true;
    void Promise.resolve().then(() => loadRuntime()).then((runtime) => {
      if (runtime && generation === loadOwner.current.generation) {
        setLoadedRuntime({ loader: loadRuntime, source: runtime });
      }
    }).catch(() => {
      // Optional Bridge recovery is isolated from wallet/app admission. A
      // missing chunk or restricted storage leaves only this route unavailable.
    }).finally(() => {
      if (generation === loadOwner.current.generation) loadOwner.current.pending = false;
    });
  }, [loadRuntime, service, loadedRuntime, demoRejected]);

  const currentRuntime = loadedRuntime && loadedRuntime.loader === loadRuntime ? loadedRuntime.source : null;
  const resolvedService = service ?? currentRuntime?.service;
  const resolvedSources = loadSources ?? currentRuntime?.loadSources;
  const directRuntime = useMemo(
    () => resolvedService && !demoRejected
      ? createRuntime({ service: resolvedService, loadSources: resolvedSources, readAccount, planner, now, account })
      : null,
    [resolvedService, resolvedSources, readAccount, planner, now, account, demoRejected],
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
      if (!cancelled && generation.isCurrent(token)) setResolved(runtime);
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
  const dormantRuntime = useMemo<BridgeRuntime>(() => ({ ...unavailable, load }), [load]);
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
