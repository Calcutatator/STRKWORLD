export type WorldRelease = () => void;

interface WorldLeaseState {
  key: unknown;
  leaseCount: number;
  release: WorldRelease | null;
  released: boolean;
  acquisition: Promise<WorldRelease> | null;
}

/**
 * Own the single-flight acquisition shared by all overlapping React effects.
 * Each caller still receives its own idempotent cleanup, but only the final
 * cleanup releases the shared world.
 *
 * The manager is a factory so tests can isolate their world state. Production
 * uses the module-owned singleton below.
 */
export function createWorldLeaseManager() {
  let current: WorldLeaseState | null = null;

  const releaseIfUnused = (state: WorldLeaseState): void => {
    if (state.leaseCount !== 0 || !state.release || state.released) return;
    state.released = true;
    if (current === state) current = null;
    state.release();
  };

  const observe = (state: WorldLeaseState, acquisition: Promise<WorldRelease>): void => {
    state.acquisition = acquisition;
    void acquisition.then(
      (worldRelease) => {
        state.release = worldRelease;
        releaseIfUnused(state);
      },
      () => {
        if (current === state) current = null;
      },
    );
  };

  const pendingAcquisition = () => {
    let resolve!: (release: WorldRelease) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<WorldRelease>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    return { promise, resolve, reject };
  };

  const invoke = (
    pending: ReturnType<typeof pendingAcquisition>,
    acquire: () => Promise<WorldRelease>,
  ): void => {
    try {
      void Promise.resolve(acquire()).then(pending.resolve, pending.reject);
    } catch (error) {
      pending.reject(error);
    }
  };

  const begin = (state: WorldLeaseState, acquire: () => Promise<WorldRelease>): void => {
    const pending = pendingAcquisition();
    observe(state, pending.promise);
    invoke(pending, acquire);
  };

  const start = (acquire: () => Promise<WorldRelease>, key: unknown): WorldLeaseState => {
    const state: WorldLeaseState = {
      key,
      leaseCount: 0,
      release: null,
      released: false,
      acquisition: null,
    };
    current = state;
    begin(state, acquire);
    return state;
  };

  const replacePending = (
    previous: WorldLeaseState,
    acquire: () => Promise<WorldRelease>,
    key: unknown,
  ): WorldLeaseState => {
    const state: WorldLeaseState = {
      key,
      leaseCount: 0,
      release: null,
      released: false,
      acquisition: null,
    };
    current = state;
    // The previous acquisition owns the lazy import boundary. Waiting for it
    // prevents two Phaser worlds from racing through the singleton host, while
    // the old state's rejection remains handled by its own continuation.
    const pending = pendingAcquisition();
    observe(state, pending.promise);
    void previous.acquisition!.then(
      () => invoke(pending, acquire),
      () => invoke(pending, acquire),
    );
    return state;
  };

  return Object.freeze({
    acquire(acquire: () => Promise<WorldRelease>, key?: unknown): () => void {
      const state = current === null
        ? start(acquire, key)
        : current.key === key || current.release !== null
          ? current
          : replacePending(current, acquire, key);
      state.leaseCount++;
      let cleaned = false;

      return () => {
        if (cleaned) return;
        cleaned = true;
        state.leaseCount--;
        releaseIfUnused(state);
      };
    },
  });
}

export const worldLeaseManager = createWorldLeaseManager();
