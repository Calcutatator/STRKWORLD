export type WorldRelease = () => void;

interface WorldLeaseState {
  key: unknown;
  leaseCount: number;
  release: WorldRelease | null;
  released: boolean;
  acquisition: Promise<WorldRelease> | null;
  retired: Promise<void>;
  retire(): void;
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
    try {
      state.release();
    } finally {
      state.retire();
    }
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
        state.retire();
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
    let retire!: () => void;
    const state: WorldLeaseState = {
      key,
      leaseCount: 0,
      release: null,
      released: false,
      acquisition: null,
      retired: new Promise<void>((resolve) => {
        retire = resolve;
      }),
      retire,
    };
    current = state;
    begin(state, acquire);
    return state;
  };

  const replace = (
    previous: WorldLeaseState,
    acquire: () => Promise<WorldRelease>,
    key: unknown,
  ): WorldLeaseState => {
    let retire!: () => void;
    const state: WorldLeaseState = {
      key,
      leaseCount: 0,
      release: null,
      released: false,
      acquisition: null,
      retired: new Promise<void>((resolve) => {
        retire = resolve;
      }),
      retire,
    };
    current = state;
    // The previous state owns the singleton world until its last lease releases
    // it (or its acquisition rejects). Waiting for retirement prevents a new
    // configuration from racing or inheriting the old event buses.
    const pending = pendingAcquisition();
    observe(state, pending.promise);
    void previous.retired.then(() => invoke(pending, acquire));
    return state;
  };

  return Object.freeze({
    acquire(acquire: () => Promise<WorldRelease>, key?: unknown): () => void {
      const state = current === null
        ? start(acquire, key)
        : current.key === key
          ? current
          : replace(current, acquire, key);
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
