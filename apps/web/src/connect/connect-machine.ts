import type { PrivacyOperations, WalletCapability } from '@strkworld/privacy';
import type { WalletStatus } from '@strkworld/shared';
import { createStore, type Store } from '../store/store.js';
import { toFailure } from '../privacy/errors.js';

/**
 * The connect flow, as a state machine over capability detection.
 *
 * Two of these states are **rooms, not errors**. A player whose wallet cannot
 * do STRK20, and a player the pool has never seen, are both in a legible
 * situation with a next step — they are not experiencing a failure, and a
 * toast that disappears in four seconds is the wrong shape for either.
 *
 * Capability comes from `PrivacyOperations.capability()`, which is a version
 * query. It is never inferred from a balance read: on Ready 5.33.8 a balance
 * read raises an explicit "Share private balances" approval, so probing with
 * one would prompt the player for data the app has no reason to hold yet.
 *
 * Nothing here branches on wallet identity, which is what keeps a web wallet
 * or an embedded wallet working later with no rewrite (SPEC §5 rule 2).
 */

export type ConnectState =
  | { name: 'disconnected' }
  | { name: 'detecting' }
  | {
      name: 'connected';
      capability: WalletCapability;
      /**
       * False when the wallet reported `registration: 'unknown'`. There is no
       * probe that cannot prompt, so the shell proceeds and lets the first real
       * operation resolve it — a 118 escalates into the `not-registered` room.
       */
      registrationConfirmed: boolean;
    }
  | { name: 'unsupported-wallet'; walletApiVersion: string | null }
  | { name: 'not-registered' }
  | { name: 'unreachable' };

export interface ConnectFlow {
  readonly store: Store<ConnectState>;
  /** Run capability detection. Concurrent calls share one in-flight query. */
  connect(signal?: AbortSignal): Promise<ConnectState>;
  /** The "I have registered" affordance. Same query, different button. */
  recheck(signal?: AbortSignal): Promise<ConnectState>;
  disconnect(): void;
  /**
   * Escalate an operation failure into a room, if it is one.
   *
   * Only 118 and 162 change the room: they are facts about the account and the
   * wallet, not about the action that happened to hit them. Everything else
   * stays local to the panel that caused it, because a dropped connection
   * during a balance read should not evict the player from the whole shell.
   */
  noteOperationError(error: unknown): ConnectState;
  status(): WalletStatus;
}

export function createConnectFlow(operations: PrivacyOperations): ConnectFlow {
  const store = createStore<ConnectState>({ name: 'disconnected' });
  let generation = 0;
  let inFlight: { generation: number; promise: Promise<ConnectState> } | null = null;

  async function detect(signal?: AbortSignal): Promise<ConnectState> {
    if (inFlight) return inFlight.promise;
    const attemptGeneration = ++generation;
    store.setState({ name: 'detecting' });

    const promise = (async (): Promise<ConnectState> => {
      try {
        const capability = await operations.capability(signal);
        const next = classify(capability);
        if (generation === attemptGeneration) {
          store.setState(next);
        }
        return next;
      } catch (error) {
        const next = fromError(error);
        if (generation === attemptGeneration) {
          store.setState(next);
        }
        return next;
      } finally {
        if (generation === attemptGeneration) {
          inFlight = null;
        }
      }
    })();
    inFlight = { generation: attemptGeneration, promise };

    return promise;
  }

  return {
    store,
    connect: detect,
    recheck: detect,

    disconnect(): void {
      generation += 1;
      inFlight = null;
      store.setState({ name: 'disconnected' });
    },

    noteOperationError(error: unknown): ConnectState {
      const { kind } = toFailure(error);
      if (kind === 'not-registered') {
        store.setState({ name: 'not-registered' });
      } else if (kind === 'unsupported-wallet') {
        store.setState({ name: 'unsupported-wallet', walletApiVersion: versionOf(store.getState()) });
      }
      return store.getState();
    },

    status(): WalletStatus {
      return toWalletStatus(store.getState());
    },
  };
}

function classify(capability: WalletCapability): ConnectState {
  if (!capability.supportsStrk20) {
    return { name: 'unsupported-wallet', walletApiVersion: capability.walletApiVersion };
  }
  if (capability.registration === 'unregistered') {
    return { name: 'not-registered' };
  }
  return {
    name: 'connected',
    capability,
    registrationConfirmed: capability.registration === 'registered',
  };
}

function fromError(error: unknown): ConnectState {
  switch (toFailure(error).kind) {
    case 'unsupported-wallet':
      return { name: 'unsupported-wallet', walletApiVersion: null };
    case 'not-registered':
      return { name: 'not-registered' };
    // A declined connection is not a failure state — the player is simply not
    // connected, and the connect room is where they should land.
    case 'user-rejected':
      return { name: 'disconnected' };
    default:
      return { name: 'unreachable' };
  }
}

function versionOf(state: ConnectState): string | null {
  return state.name === 'connected' ? state.capability.walletApiVersion : null;
}

/** The world only needs the coarse status, and never learns anything financial. */
export function toWalletStatus(state: ConnectState): WalletStatus {
  switch (state.name) {
    case 'detecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'unsupported-wallet':
      return 'unsupported';
    case 'not-registered':
      return 'unregistered';
    case 'disconnected':
    case 'unreachable':
      return 'disconnected';
  }
}
