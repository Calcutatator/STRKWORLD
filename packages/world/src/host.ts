/**
 * Ref-counted lifecycle for a single long-lived instance.
 *
 * This exists because Phaser's own React template is broken under React 19
 * StrictMode. `Game.destroy()` only sets `pendingDestroy` and defers real
 * teardown to the next `step()`, which needs requestAnimationFrame. StrictMode
 * re-runs effects synchronously in the same tick, so a naive
 * create-on-mount/destroy-on-unmount produces **two** games, two WebGL contexts
 * and two canvases. It self-heals on frame one in a foreground tab and **never
 * heals in a hidden tab**, because rAF does not fire there — a stuck WebGL
 * context in a PWA that backgrounds on mobile.
 *
 * The fix is to stop letting React own the lifecycle. React acquires and
 * releases; this module decides. A release schedules teardown on a macrotask,
 * so a synchronous StrictMode remount cancels it before anything is destroyed.
 *
 * Deliberately generic and Phaser-free so the logic that actually breaks can be
 * unit-tested in CI without a browser, a canvas or a WebGL context.
 */

export interface HostOptions<T, P> {
  /**
   * Create the instance. Called only when the ref count rises from zero.
   * Calling `acquire` or `release` while this runs is rejected.
   */
  start: (parent: P) => T;
  /**
   * Destroy it. Called only after the ref count has stayed at zero.
   * Calling `acquire` or `release` while this runs is rejected.
   */
  stop: (instance: T) => void | Promise<void>;
  /**
   * Rebind a retained instance when a synchronous remount supplies a different
   * owner. Omit when the instance is independent of its start parent.
   */
  retarget?: (instance: T, parent: P, previousParent: P) => void;
  /**
   * Defer teardown so a synchronous remount can cancel it. Injectable for
   * tests; defaults to a macrotask, which is what makes the StrictMode
   * double-invoke harmless. The deferrer owns any returned promise and must
   * surface its rejection.
   */
  defer?: (fn: () => void | Promise<void>) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface Host<T, P> {
  acquire: (parent: P) => T;
  release: () => void;
  /** The live instance, or null. For assertions and debugging. */
  readonly current: T | null;
  /** How many holders think they have it. For assertions. */
  readonly refCount: number;
}

export function createHost<T, P>(options: HostOptions<T, P>): Host<T, P> {
  const lifecycleDuringStartError = 'Host lifecycle cannot be changed while start is running';
  const lifecycleDuringStopError = 'Host lifecycle cannot be changed while stop is running';
  const defer =
    options.defer ??
    ((fn: () => void | Promise<void>) =>
      setTimeout(() => {
        const result = fn();
        if (result === undefined) return;
        void result.catch((error: unknown) => {
          queueMicrotask(() => {
            throw error;
          });
        });
      }, 0));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as never));

  let instance: T | null = null;
  let activeParent: P | null = null;
  let hasActiveParent = false;
  let refs = 0;
  let pending: unknown = null;
  let starting = false;
  let stopping = false;

  function acquire(parent: P): T {
    if (starting) throw new Error(lifecycleDuringStartError);
    if (stopping) throw new Error(lifecycleDuringStopError);
    const previousRefs = refs;
    const previousPending = pending;
    if (
      instance !== null &&
      hasActiveParent &&
      !Object.is(activeParent, parent) &&
      options.retarget
    ) {
      options.retarget(instance, parent, activeParent as P);
      activeParent = parent;
    }
    refs++;
    // A remount arriving before the deferred teardown ran: keep what we have.
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    if (instance === null) {
      starting = true;
      try {
        instance = options.start(parent);
        activeParent = parent;
        hasActiveParent = true;
      } catch (error) {
        refs = previousRefs;
        pending = previousPending;
        throw error;
      } finally {
        starting = false;
      }
    }
    return instance;
  }

  function release(): void {
    if (starting) throw new Error(lifecycleDuringStartError);
    if (stopping) throw new Error(lifecycleDuringStopError);
    refs = Math.max(0, refs - 1);
    if (refs > 0 || pending !== null || instance === null) return;
    pending = defer(() => {
      pending = null;
      // Re-check: a holder may have acquired while the teardown was queued.
      if (refs > 0 || instance === null) return;
      const doomed = instance;
      stopping = true;
      const finish = () => {
        instance = null;
        activeParent = null;
        hasActiveParent = false;
        stopping = false;
      };
      try {
        const result = options.stop(doomed);
        if (result !== undefined) return Promise.resolve(result).finally(finish);
      } catch (error) {
        finish();
        throw error;
      }
      finish();
    });
  }

  return {
    acquire,
    release,
    get current() {
      return instance;
    },
    get refCount() {
      return refs;
    },
  };
}
