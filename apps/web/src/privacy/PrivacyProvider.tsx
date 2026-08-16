import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { PrivacyOperations } from '@strkworld/privacy';
import type { EventBus, ShellEvents } from '@strkworld/shared';
import { createConnectFlow, toWalletStatus, type ConnectFlow, type ConnectState } from '../connect/connect-machine.js';
import { useStore } from '../store/use-store.js';
import { createDemoOperations } from './demo-operations.js';

/**
 * Wallet and financial state for the whole shell.
 *
 * React owns this state and pushes presentation data into the world; the world
 * never reads back (D-010). The only thing the world learns from here is the
 * coarse `wallet:status`, which drives door copy and carries nothing financial.
 */

export interface ShellPrivacy {
  operations: PrivacyOperations;
  connect: ConnectFlow;
  connectState: ConnectState;
  /** Optional channel into the world for HUD pushes. */
  shellBus: EventBus<ShellEvents> | null;
}

const PrivacyContext = createContext<ShellPrivacy | null>(null);

export function usePrivacy(): ShellPrivacy {
  const value = useContext(PrivacyContext);
  if (!value) throw new Error('usePrivacy must be used inside a <PrivacyProvider>');
  return value;
}

export function PrivacyProvider({
  operations,
  shellBus = null,
  children,
}: {
  /** Defaults to the deterministic fake — see `demo-operations.ts`. */
  operations?: PrivacyOperations;
  shellBus?: EventBus<ShellEvents> | null;
  children: ReactNode;
}) {
  const resolved = useMemo(() => operations ?? createDemoOperations(), [operations]);
  const connect = useMemo(() => createConnectFlow(resolved), [resolved]);
  const connectState = useStore(connect.store);

  useEffect(() => {
    shellBus?.emit('wallet:status', { status: toWalletStatus(connectState) });
  }, [shellBus, connectState]);

  const value = useMemo<ShellPrivacy>(
    () => ({ operations: resolved, connect, connectState, shellBus }),
    [resolved, connect, connectState, shellBus],
  );

  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}
