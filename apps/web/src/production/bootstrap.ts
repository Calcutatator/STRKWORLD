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
  hot?.dispose(dispose);

  void load().then(
    (session) => {
      if (retired) {
        destroyQuietly(session);
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
        if (!retired) failure();
      }
    },
    () => {
      if (!retired) failure();
    },
  );

  return dispose;
}

function destroyQuietly(session: WalletSession | null): void {
  if (!session) return;
  try {
    session.destroy();
  } catch {
    // HMR/disposal must not surface a stale wallet teardown failure.
  }
}
