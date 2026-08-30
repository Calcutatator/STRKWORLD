import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { WalletSession, WalletSessionSnapshot } from '@strkworld/privacy';

export interface WalletSessionRuntime {
  readonly session: WalletSession;
  readonly snapshot: WalletSessionSnapshot;
  connect(key: string): Promise<void>;
  refreshDiscovery(): void;
  disconnect(): Promise<void>;
}

const WalletSessionContext = createContext<WalletSessionRuntime | null>(null);

export function WalletSessionProvider({
  session,
  children,
}: {
  session: WalletSession;
  children: ReactNode;
}) {
  const subscribe = useMemo(
    () => (listener: () => void) => session.subscribe(listener),
    [session],
  );
  const getSnapshot = useMemo(() => () => session.getSnapshot(), [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const value = useMemo<WalletSessionRuntime>(() => Object.freeze({
    session,
    snapshot,
    async connect(key: string) {
      await session.connect(key);
    },
    refreshDiscovery: () => session.refreshDiscovery(),
    disconnect: () => session.disconnect(),
  }), [session, snapshot]);
  return <WalletSessionContext.Provider value={value}>{children}</WalletSessionContext.Provider>;
}

export function useWalletSessionOptional(): WalletSessionRuntime | null {
  return useContext(WalletSessionContext);
}
