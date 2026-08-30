import type { WalletSession } from '@strkworld/privacy';

export interface ProductionWalletBootstrap {
  load: () => Promise<WalletSession>;
  render: (session: WalletSession) => void;
  failure: () => void;
  hot?: { dispose(callback: () => void): void };
}

/** Own the asynchronous production session until its entrypoint is retired. */
export function startProductionWalletBootstrap({
  load,
  render,
  failure,
  hot,
}: ProductionWalletBootstrap): () => void {
  let retired = false;
  let owned: WalletSession | null = null;

  const dispose = (): void => {
    if (retired) return;
    retired = true;
    const session = owned;
    owned = null;
    destroyQuietly(session);
  };
  try {
    hot?.dispose(dispose);
  } catch {
    dispose();
    reportFailure(failure);
    return dispose;
  }

  let loading: Promise<WalletSession>;
  try {
    loading = Promise.resolve(load());
  } catch {
    dispose();
    reportFailure(failure);
    return dispose;
  }

  void loading.then(
    (session) => {
      if (retired) {
        destroyQuietly(session);
        return;
      }
      if (!admitWalletSession(session)) {
        if (!retired) reportFailure(failure);
        return;
      }
      owned = session;
      if (retired) {
        destroyQuietly(session);
        return;
      }
      try {
        render(session);
      } catch {
        if (owned === session) {
          owned = null;
          destroyQuietly(session);
        }
        if (!retired) reportFailure(failure);
      }
    },
    () => {
      if (!retired) reportFailure(failure);
    },
  );

  return dispose;
}

function isWalletSession(value: unknown): value is WalletSession {
  if (!value || typeof value !== 'object') return false;
  try {
    const operations = Object.getOwnPropertyDescriptor(value, 'operations');
    if (!operations || !('value' in operations) || !operations.value || typeof operations.value !== 'object') {
      return false;
    }
    if (![
      'capability',
      'poolConfig',
      'balances',
      'recipientStatus',
      'prepare',
    ].every((key) => hasOwnDataMethod(operations.value, key))) {
      return false;
    }
    return [
      'getSnapshot',
      'subscribe',
      'connect',
      'refreshDiscovery',
      'readAccount',
      'disconnect',
      'destroy',
    ].every((key) => hasOwnDataMethod(value, key));
  } catch {
    return false;
  }
}

function admitWalletSession(value: unknown): value is WalletSession {
  if (!isWalletSession(value)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'operations');
    if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object') {
      return false;
    }
    Object.freeze(descriptor.value);
    Object.freeze(value);
    return isWalletSession(value);
  } catch {
    return false;
  }
}

function hasOwnDataMethod(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && 'value' in descriptor && typeof descriptor.value === 'function');
}

function destroyQuietly(session: unknown): void {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(session, 'destroy');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return;
    descriptor.value.call(session);
  } catch {
    // HMR/disposal must not surface a stale wallet teardown failure.
  }
}

function reportFailure(failure: () => void): void {
  try {
    failure();
  } catch {
    // A detached bootstrap cannot surface a second startup failure as an
    // unhandled rejection after the original load/render error.
  }
}
