import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PrivacyOperations } from '@strkworld/privacy';
import type { EventBus, ShellEvents } from '@strkworld/shared';
import { createConnectFlow, toWalletStatus, type ConnectFlow, type ConnectState } from '../connect/connect-machine.js';
import { useStore } from '../store/use-store.js';

/**
 * Wallet and financial state for the whole shell.
 *
 * React owns this state and pushes presentation data into the world; the world
 * never reads back (D-010). The only thing the world learns from here is the
 * coarse `wallet:status`, which drives door copy and carries nothing financial.
 *
 * **There is no default seam.** An earlier version fell back to the
 * deterministic fake when no `operations` prop was passed, which meant a
 * mis-wired production build would have shown a working Bank with 250 invented
 * STRK in it — money-shaped fiction, in a product whose entire claim is that it
 * moves real funds. The fake now requires `demo` to be set explicitly, and is
 * refused outright in a production build.
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

export interface PrivacyProviderProps {
  /** The financial seam. Required unless `demo` is explicitly set. */
  operations?: PrivacyOperations;
  /**
   * Use the deterministic fake. Never true in a production build; this is for
   * local development, demos and stories.
   */
  demo?: boolean;
  shellBus?: EventBus<ShellEvents> | null;
  /** Rendered while the demo seam loads. */
  fallback?: ReactNode;
  children: ReactNode;
}

function isProductionBuild(): boolean {
  // Typed access rather than `import.meta.env.PROD`: the repository tsconfig
  // does not pull in Vite's client types, and the shell should not need them
  // for one flag.
  return (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true;
}

export function PrivacyProvider({
  operations,
  demo = false,
  shellBus = null,
  fallback = null,
  children,
}: PrivacyProviderProps) {
  if (!operations) {
    if (!demo) {
      throw new Error(
        '<PrivacyProvider> needs an `operations` prop. Pass a PrivacyOperations ' +
          'implementation, or set `demo` to use the deterministic fake — there is ' +
          'no silent fallback, because a fake balance in a real build is money-shaped fiction.',
      );
    }
    if (isProductionBuild()) {
      throw new Error(
        '<PrivacyProvider demo> reached a production build. The deterministic fake ' +
          'must never ship: it reports balances nobody holds.',
      );
    }
  }

  const [resolved, setResolved] = useState<PrivacyOperations | null>(operations ?? null);

  useEffect(() => {
    if (operations) {
      setResolved(operations);
      return;
    }
    let cancelled = false;
    // Dynamic import: `@strkworld/privacy` re-exports the wallet adapter, which
    // pulls `starknet`. Loading it eagerly would put roughly 900 kB of chain
    // code in the entry chunk of a shell that must be able to render a connect
    // screen without it.
    void import('./demo-operations.js').then(({ createDemoOperations }) => {
      if (!cancelled) setResolved(createDemoOperations());
    });
    return () => {
      cancelled = true;
    };
  }, [operations]);

  if (!resolved) return <>{fallback}</>;

  return (
    <PrivacyRuntime operations={resolved} shellBus={shellBus}>
      {children}
    </PrivacyRuntime>
  );
}

function PrivacyRuntime({
  operations,
  shellBus,
  children,
}: {
  operations: PrivacyOperations;
  shellBus: EventBus<ShellEvents> | null;
  children: ReactNode;
}) {
  const connect = useMemo(() => createConnectFlow(operations), [operations]);
  const connectState = useStore(connect.store);

  useEffect(() => {
    shellBus?.emit('wallet:status', { status: toWalletStatus(connectState) });
  }, [shellBus, connectState]);

  const value = useMemo<ShellPrivacy>(
    () => ({ operations, connect, connectState, shellBus }),
    [operations, connect, connectState, shellBus],
  );

  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}
