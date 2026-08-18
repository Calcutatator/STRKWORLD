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

  const [resolved, setResolved] = useState<BridgeRuntime | null>(service && !demoRejected ? {
    service,
    loadSources: loadSources ?? (async () => []),
    readAccount: readAccount ?? (() => null),
    planner: planner ?? null,
    now,
    account,
    available: () => Boolean(account && planner),
  } : null);

  useEffect(() => {
    if (!service || demoRejected) return;
    setResolved({
      service,
      loadSources: loadSources ?? (async () => []),
      readAccount: readAccount ?? (() => account),
      planner: planner ?? null,
      now,
      account,
      available: () => Boolean(account && planner),
    });
  }, [service, loadSources, readAccount, planner, account, now, demoRejected]);

  useEffect(() => {
    if (!demo || service || demoRejected) return;
    let cancelled = false;
    void import('./demo-runtime.js').then(async ({ createDemoBridgeRuntime }) => {
      const runtime = await createDemoBridgeRuntime();
      if (!cancelled) setResolved(runtime);
    });
    return () => { cancelled = true; };
  }, [demo, service, demoRejected]);

  const runtime = useMemo(() => resolved ?? unavailable, [resolved]);
  if (demoRejected) {
    throw new Error('<BridgeProvider demo> reached a production build. Demo bridge funding is disabled.');
  }
  // Keep the shell mounted while the bridge chunk loads. The unavailable
  // runtime makes its station locked and its Menu panel honest; it never
  // fabricates a balance or starts a provider call.
  return <BridgeContext.Provider value={runtime}>{resolved ? children : (fallback ?? children)}</BridgeContext.Provider>;
}

/** Convenience account reader for hosts that already hold the account value. */
export function fixedBridgeAccount(address: Address | null): BridgeAccountReader {
  return () => address;
}
