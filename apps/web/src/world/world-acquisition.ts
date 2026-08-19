export type WorldRelease = () => void;

interface WorldLeaseState {
  leaseCount: number;
  release: WorldRelease | null;
  released: boolean;
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

  const start = (acquire: () => Promise<WorldRelease>): WorldLeaseState => {
    const state: WorldLeaseState = {
      leaseCount: 0,
      release: null,
      released: false,
    };
    current = state;

    let acquisition: Promise<WorldRelease>;
    try {
      acquisition = Promise.resolve(acquire());
    } catch (error) {
      acquisition = Promise.reject(error);
    }
    void acquisition.then(
      (worldRelease) => {
        state.release = worldRelease;
        releaseIfUnused(state);
      },
      () => {
        if (current === state) current = null;
      },
    );
    return state;
  };

  return {
    acquire(acquire: () => Promise<WorldRelease>): () => void {
      const state = current ?? start(acquire);
      state.leaseCount++;
      let cleaned = false;

      return () => {
        if (cleaned) return;
        cleaned = true;
        state.leaseCount--;
        releaseIfUnused(state);
      };
    },
  };
}

export const worldLeaseManager = createWorldLeaseManager();
