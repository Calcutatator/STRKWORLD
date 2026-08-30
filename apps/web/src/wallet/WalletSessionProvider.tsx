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
  const snapshotReader = useMemo(() => createSnapshotReader(session), [session]);
  const subscribe = useMemo(
    () => (listener: () => void) => session.subscribe(listener),
    [session],
  );
  const getSnapshot = useMemo(() => () => snapshotReader(), [snapshotReader]);
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

const EMPTY_SNAPSHOT: WalletSessionSnapshot = Object.freeze({
  phase: 'selection-required',
  wallets: Object.freeze([]),
  selectedKey: null,
  account: null,
  generation: 0,
});

function createSnapshotReader(session: WalletSession): () => WalletSessionSnapshot {
  let rawSnapshot: unknown = undefined;
  let ownedSnapshot = EMPTY_SNAPSHOT;
  let initialized = false;

  return () => {
    let nextRaw: unknown;
    try {
      nextRaw = session.getSnapshot();
    } catch {
      rawSnapshot = undefined;
      initialized = false;
      ownedSnapshot = EMPTY_SNAPSHOT;
      return ownedSnapshot;
    }
    if (initialized && nextRaw === rawSnapshot) return ownedSnapshot;
    rawSnapshot = nextRaw;
    initialized = true;
    ownedSnapshot = ownSnapshot(nextRaw);
    return ownedSnapshot;
  };
}

function ownSnapshot(value: unknown): WalletSessionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_SNAPSHOT;
  try {
    const phase = ownData(value, 'phase');
    const selectedKey = ownData(value, 'selectedKey');
    const account = ownData(value, 'account');
    const generation = ownData(value, 'generation');
    const wallets = ownWallets(ownData(value, 'wallets'));
    if (
      (phase !== 'selection-required' && phase !== 'connecting' && phase !== 'connected'
        && phase !== 'wrong-network' && phase !== 'failed')
      || (selectedKey !== null && typeof selectedKey !== 'string')
      || (account !== null && typeof account !== 'string')
      || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
      || wallets === null
    ) return EMPTY_SNAPSHOT;
    return Object.freeze({
      phase,
      wallets: Object.freeze(wallets),
      selectedKey,
      account,
      generation,
    });
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function ownWallets(value: unknown): WalletSessionSnapshot['wallets'][number][] | null {
  if (!Array.isArray(value)) return null;
  try {
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
      return null;
    }
    const wallets: WalletSessionSnapshot['wallets'][number][] = [];
    for (let index = 0; index < length.value; index += 1) {
      const wallet = ownData(value, String(index));
      if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) return null;
      const key = ownData(wallet, 'key');
      const name = ownData(wallet, 'name');
      const icon = ownData(wallet, 'icon');
      if (typeof key !== 'string' || typeof name !== 'string' || typeof icon !== 'string') return null;
      wallets.push(Object.freeze({ key, name, icon }));
    }
    return wallets;
  } catch {
    return null;
  }
}

function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function useWalletSessionOptional(): WalletSessionRuntime | null {
  return useContext(WalletSessionContext);
}
