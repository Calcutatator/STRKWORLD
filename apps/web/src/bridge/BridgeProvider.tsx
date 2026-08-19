import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
}

export interface BridgeProviderProps {
  service?: BridgeServicePort | BridgeService;
  loadSources?: BridgeSourceLoader;
  /** Account reader, deliberately structural so no wallet identity is named. */
  readAccount?: BridgeAccountReader;
  planner?: PublicShieldPlanner | null;
  now?: () => number;
  account?: Address | null;
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
};

const BridgeContext = createContext<BridgeRuntime>(unavailable);

export interface BridgeRuntimeGenerationGuard {
  next(): number;
  invalidate(token: number): void;
  isCurrent(token: number): boolean;
}

/** Small testable gate for optional runtime work that outlives a prop change. */
export function createBridgeRuntimeGenerationGuard(): BridgeRuntimeGenerationGuard {
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
  };
}

export function useBridge(): BridgeRuntime {
  return useContext(BridgeContext);
}

/**
 * Bridge composition is explicit like PrivacyProvider. Demo code is lazy and
 * refused in production; a real runtime without a planner remains locked.
 */
export function BridgeProvider({
  service,
  loadSources,
  readAccount,
  planner = null,
  account = null,
  demo = false,
  build,
  fallback = null,
  children,
  now,
}: BridgeProviderProps) {
  const demoRejected = demo && (build ?? detectBuildContext()).production;

  const directRuntime = useMemo(
    () => service && !demoRejected
      ? createRuntime({ service, loadSources, readAccount, planner, now, account })
      : null,
    [service, loadSources, readAccount, planner, now, account, demoRejected],
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
  const runtime = directRuntime ?? (demo && !demoRejected ? resolved : null) ?? unavailable;
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
