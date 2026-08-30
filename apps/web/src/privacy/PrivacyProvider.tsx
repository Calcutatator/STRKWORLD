import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  PrivacyOperations,
  WalletSession,
  WalletSessionSnapshot,
} from '@strkworld/privacy';
import type { EventBus, ShellEvents } from '@strkworld/shared';
import { createConnectFlow, toWalletStatus, type ConnectFlow, type ConnectState } from '../connect/connect-machine.js';
import { COPY } from '../copy.js';
import { createReceiptLedger, type ReceiptLedger } from '../receipts/receipt-ledger.js';
import { detectBuildContext, type BuildContext } from './build-context.js';
import { useStore } from '../store/use-store.js';
import {
  createSubmissionUncertainty,
  type SubmissionUncertainty,
} from './submission-uncertainty.js';
import { toFailure } from './errors.js';
import { loadDemoOperations } from './demo-loader.js';

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
  /**
   * Receipts, held here rather than in a panel.
   *
   * The world decides when a panel unmounts, so a hash kept in panel state is
   * lost exactly when it matters most — a transaction that settled while the
   * room was closing. This outlives every panel below it.
   */
  receipts: ReceiptLedger;
  /** D-034's one-bit, in-memory browser-session retention. */
  submissionUncertainty: SubmissionUncertainty;
  /** Routes operation failures to account state and session-level notices. */
  noteOperationError(error: unknown): void;
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
  /** Optional production account/network owner; never present in demo mode. */
  walletSession?: WalletSession;
  /** Capability verdict already established by the production wallet gate. */
  initialConnectState?: ConnectState;
  /**
   * Use the deterministic fake. Never true in a production build; this is for
   * local development, demos and stories.
   */
  demo?: boolean;
  shellBus?: EventBus<ShellEvents> | null;
  /** Rendered while the demo seam loads. */
  fallback?: ReactNode;
  /**
   * Build context. Defaults to detection, which fails closed when it cannot
   * tell. A host that knows its own build may state it; it can only ever make
   * the demo check match reality, since reaching the fake still requires `demo`.
   */
  build?: BuildContext;
  /** Injectable only so retention and rendering can be driven without a DOM. */
  submissionUncertainty?: SubmissionUncertainty;
  children: ReactNode;
}

type ResolvedOperations = {
  value: PrivacyOperations;
  source: 'explicit' | 'demo';
};

export function PrivacyProvider({
  operations,
  walletSession,
  initialConnectState,
  demo = false,
  shellBus = null,
  fallback = null,
  build,
  submissionUncertainty,
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
    if ((build ?? detectBuildContext()).production) {
      throw new Error(
        '<PrivacyProvider demo> reached a production build. The deterministic fake ' +
          'must never ship: it reports balances nobody holds.',
      );
    }
  }

  const [resolved, setResolved] = useState<ResolvedOperations | null>(
    operations ? { value: operations, source: 'explicit' } : null,
  );
  const [demoLoadFailed, setDemoLoadFailed] = useState(false);
  const [demoLoadAttempt, setDemoLoadAttempt] = useState(0);

  useEffect(() => {
    if (operations) {
      setResolved({ value: operations, source: 'explicit' });
      setDemoLoadFailed(false);
      return;
    }
    let cancelled = false;
    setDemoLoadFailed(false);
    // Dynamic import: `@strkworld/privacy` re-exports the wallet adapter, which
    // pulls `starknet`. Loading it eagerly would put roughly 900 kB of chain
    // code in the entry chunk of a shell that must be able to render a connect
    // screen without it.
    void loadDemoOperations().then((demoOperations) => {
      if (!cancelled) setResolved({ value: demoOperations, source: 'demo' });
    }).catch(() => {
      // A missing optional demo chunk must not become an unhandled rejection or
      // leave the shell looking as though it is still loading forever.
      if (!cancelled) setDemoLoadFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [operations, demoLoadAttempt]);

  // An explicit seam is authoritative during render. This also prevents a
  // prior lazy-demo failure from masking a newly supplied production seam.
  const effectiveOperations = operations ?? (
    demo
      ? (resolved?.source === 'demo' ? resolved.value : null)
      : resolved?.value
  );
  if (demoLoadFailed && !operations) {
    return (
      <section className="shell-crashed" role="alert">
        <p>{COPY.demo.loadFailed}</p>
        <button type="button" onClick={() => setDemoLoadAttempt((attempt) => attempt + 1)}>
          {COPY.demo.retry}
        </button>
      </section>
    );
  }
  if (!effectiveOperations) return <>{fallback}</>;

  return (
    <PrivacyRuntime
      operations={effectiveOperations}
      walletSession={walletSession}
      initialConnectState={initialConnectState}
      shellBus={shellBus}
      injectedSubmissionUncertainty={submissionUncertainty}
    >
      {children}
    </PrivacyRuntime>
  );
}

function PrivacyRuntime({
  operations,
  walletSession,
  initialConnectState,
  shellBus,
  injectedSubmissionUncertainty,
  children,
}: {
  operations: PrivacyOperations;
  walletSession?: WalletSession;
  initialConnectState?: ConnectState;
  shellBus: EventBus<ShellEvents> | null;
  injectedSubmissionUncertainty?: SubmissionUncertainty;
  children: ReactNode;
}) {
  const connect = useMemo(
    () => createConnectFlow(operations, initialConnectState),
    [operations, initialConnectState],
  );
  const connectState = useStore(connect.store);
  // Deliberately not keyed to `operations`: a receipt is evidence about the
  // chain, and it must not be discarded because the shell swapped seams.
  const receipts = useMemo(() => createReceiptLedger(), []);
  // One in-memory flag for the provider's lifetime. It intentionally has no
  // cross-reload persistence and carries no financial/request context.
  const submissionUncertainty = useMemo(
    () => injectedSubmissionUncertainty ?? createSubmissionUncertainty(),
    [injectedSubmissionUncertainty],
  );

  const noteOperationError = useCallback(
    (error: unknown): void => {
      const failure = toFailure(error);
      if (failure.kind === 'submission-uncertain') submissionUncertainty.retain();
      connect.noteOperationError(failure);
    },
    [connect, submissionUncertainty],
  );

  useEffect(() => {
    shellBus?.emit('wallet:status', { status: toWalletStatus(connectState) });
  }, [shellBus, connectState]);

  const value = useMemo<ShellPrivacy>(
    () => ({
      operations,
      connect,
      connectState,
      receipts,
      submissionUncertainty,
      noteOperationError,
      shellBus,
    }),
    [
      operations,
      connect,
      connectState,
      receipts,
      submissionUncertainty,
      noteOperationError,
      shellBus,
    ],
  );

  return <PrivacyContext.Provider value={value}>
    {walletSession ? <WalletSessionConnectSync session={walletSession} connect={connect} /> : null}
    {children}
  </PrivacyContext.Provider>;
}

function WalletSessionConnectSync({
  session,
  connect,
}: {
  session: WalletSession;
  connect: ConnectFlow;
}) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const previous = useRef(snapshot);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (snapshot.phase === 'connected') {
        const state = connect.store.getState();
        if (state.name !== 'connected' && state.name !== 'not-registered') {
          void connect.connect();
        }
        previous.current = snapshot;
        return;
      }
    }
    const prior = previous.current;
    switch (walletSessionConnectAction(prior, snapshot)) {
      case 'disconnect':
        connect.disconnect();
        break;
      case 'recheck':
        connect.disconnect();
        void connect.connect();
        break;
      case 'none':
        break;
    }
    previous.current = snapshot;
  }, [snapshot, connect]);
  return null;
}

export type WalletSessionConnectAction = 'none' | 'disconnect' | 'recheck';

/**
 * Translate wallet-session authority changes into the coarser Connect flow.
 * Kept pure so the production effect's account/network ownership is directly
 * regression-tested without pretending server rendering runs React effects.
 */
export function walletSessionConnectAction(
  previous: WalletSessionSnapshot,
  current: WalletSessionSnapshot,
): WalletSessionConnectAction {
  if (current.phase !== 'connected') return 'disconnect';
  if (
    previous.phase !== 'connected' ||
    previous.generation !== current.generation ||
    previous.account !== current.account
  ) {
    return 'recheck';
  }
  return 'none';
}
