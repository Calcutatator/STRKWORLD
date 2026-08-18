import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PrivacyOperations } from '@strkworld/privacy';
import type { EventBus, ShellEvents } from '@strkworld/shared';
import { createConnectFlow, toWalletStatus, type ConnectFlow, type ConnectState } from '../connect/connect-machine.js';
import { createReceiptLedger, type ReceiptLedger } from '../receipts/receipt-ledger.js';
import { detectBuildContext, type BuildContext } from './build-context.js';
import { useStore } from '../store/use-store.js';
import {
  createSubmissionUncertainty,
  type SubmissionUncertainty,
} from './submission-uncertainty.js';
import { toFailure } from './errors.js';

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

export function PrivacyProvider({
  operations,
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
    <PrivacyRuntime
      operations={resolved}
      shellBus={shellBus}
      injectedSubmissionUncertainty={submissionUncertainty}
    >
      {children}
    </PrivacyRuntime>
  );
}

function PrivacyRuntime({
  operations,
  shellBus,
  injectedSubmissionUncertainty,
  children,
}: {
  operations: PrivacyOperations;
  shellBus: EventBus<ShellEvents> | null;
  injectedSubmissionUncertainty?: SubmissionUncertainty;
  children: ReactNode;
}) {
  const connect = useMemo(() => createConnectFlow(operations), [operations]);
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

  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}
