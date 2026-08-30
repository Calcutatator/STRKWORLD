import { describe, expect, it, vi } from 'vitest';
import { createHost } from './host.js';

/**
 * These tests encode the React 19 StrictMode double-mount trap.
 *
 * The failure they guard against is not hypothetical: Phaser's own official
 * React template produces two Game instances, two WebGL contexts and two
 * canvases under StrictMode, and never recovers in a backgrounded tab.
 *
 * A manual deferral queue stands in for setTimeout so the ordering is exact
 * rather than timing-dependent — a flaky test here would be worse than none,
 * because it would be muted.
 */
function harness() {
  const queue: Array<() => void> = [];
  let started = 0;
  let stopped = 0;

  const host = createHost<{ id: number }, string>({
    start: () => ({ id: ++started }),
    stop: () => {
      stopped++;
    },
    defer: (fn) => {
      queue.push(fn);
      return queue.length - 1;
    },
    cancel: (handle) => {
      queue[handle as number] = () => {};
    },
  });

  return {
    host,
    flush: () => {
      const pending = queue.splice(0, queue.length);
      for (const fn of pending) fn();
    },
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe('StrictMode double-mount', () => {
  it('creates exactly one instance across mount → unmount → remount', () => {
    // This is what React 19 StrictMode does synchronously, in one tick.
    const h = harness();
    h.host.acquire('#host'); // mount
    h.host.release(); // unmount
    h.host.acquire('#host'); // remount, same tick
    h.flush();

    expect(h.started).toBe(1);
    expect(h.stopped).toBe(0);
    expect(h.host.current).not.toBeNull();
  });

  it('returns the same instance to the remount, not a replacement', () => {
    const h = harness();
    const first = h.host.acquire('#host');
    h.host.release();
    const second = h.host.acquire('#host');
    h.flush();
    expect(second).toBe(first);
  });

  it('retargets a retained instance when the remount has a different owner', () => {
    const queue: Array<() => void> = [];
    const retarget = vi.fn((instance: { parent: string }, parent: string) => {
      instance.parent = parent;
    });
    const host = createHost<{ parent: string }, string>({
      start: (parent) => ({ parent }),
      retarget,
      stop: vi.fn(),
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
      cancel: (handle) => {
        queue[handle as number] = () => {};
      },
    });

    const first = host.acquire('old-wallet-tree');
    host.release();
    const second = host.acquire('new-wallet-tree');
    for (const fn of queue.splice(0, queue.length)) fn();

    expect(second).toBe(first);
    expect(second.parent).toBe('new-wallet-tree');
    expect(retarget).toHaveBeenCalledOnce();
    expect(retarget).toHaveBeenCalledWith(first, 'new-wallet-tree', 'old-wallet-tree');
  });
});

describe('teardown', () => {
  it('destroys once the last holder releases and the deferral runs', () => {
    const h = harness();
    h.host.acquire('#host');
    h.host.release();
    expect(h.stopped).toBe(0); // not yet — still deferred
    h.flush();
    expect(h.stopped).toBe(1);
    expect(h.host.current).toBeNull();
  });

  it('does not destroy while another holder remains', () => {
    const h = harness();
    h.host.acquire('#host');
    h.host.acquire('#host');
    h.host.release();
    h.flush();
    expect(h.stopped).toBe(0);
    expect(h.host.refCount).toBe(1);
  });

  it('starts a fresh instance after a completed teardown', () => {
    const h = harness();
    h.host.acquire('#host');
    h.host.release();
    h.flush();
    h.host.acquire('#host');
    expect(h.started).toBe(2);
  });

  it('clears failed teardown ownership before surfacing the stop error', () => {
    const queue: Array<() => void> = [];
    const stopped: Array<{ id: number }> = [];
    let attempts = 0;
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: ++attempts }),
      stop: (instance) => {
        stopped.push(instance);
        if (instance.id === 1) throw new Error('destroy failed');
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
      cancel: (handle) => {
        queue[handle as number] = () => {};
      },
    });

    host.acquire('#host');
    host.release();
    const [flush] = queue.splice(0, 1);
    if (flush === undefined) throw new Error('missing deferred teardown');
    expect(() => flush()).toThrow('destroy failed');
    expect(host.current).toBeNull();
    expect(host.refCount).toBe(0);

    expect(host.acquire('#host')).toEqual({ id: 2 });
    host.release();
    const [retryFlush] = queue.splice(0, 1);
    if (retryFlush === undefined) throw new Error('missing retry teardown');
    retryFlush();
    expect(stopped).toEqual([{ id: 1 }, { id: 2 }]);
    expect(host.current).toBeNull();
  });

  it('survives release being called more times than acquire', () => {
    const h = harness();
    h.host.acquire('#host');
    h.host.release();
    h.host.release();
    h.host.release();
    h.flush();
    expect(h.host.refCount).toBe(0);
    expect(h.stopped).toBe(1); // stopped once, not three times
  });
});

describe('failed acquisition', () => {
  it('restores the lease state so a failed start can be retried and cleaned up', () => {
    const queue: Array<() => void> = [];
    let attempts = 0;
    let stopped = 0;
    const host = createHost<{ id: number }, string>({
      start: () => {
        attempts++;
        if (attempts === 1) throw new Error('start failed');
        return { id: attempts };
      },
      stop: () => {
        stopped++;
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
      cancel: (handle) => {
        queue[handle as number] = () => {};
      },
    });

    expect(() => host.acquire('#host')).toThrow('start failed');
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
    expect(queue).toHaveLength(0);

    const instance = host.acquire('#host');
    expect(instance).toEqual({ id: 2 });
    expect(attempts).toBe(2);

    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(stopped).toBe(1);
    expect(host.current).toBeNull();
  });
});

describe('construction reentrancy', () => {
  it('rejects a nested acquire and restores a failed outer acquisition', () => {
    let attempts = 0;
    let nestedError: unknown;
    let acquireAgain = () => {};
    const host = createHost<{ id: number }, string>({
      start: () => {
        attempts++;
        if (attempts === 1) {
          try {
            acquireAgain();
          } catch (error) {
            nestedError = error;
          }
          throw new Error('outer start failed');
        }
        return { id: attempts };
      },
      stop: vi.fn(),
    });
    acquireAgain = () => {
      host.acquire('#nested');
    };

    expect(() => host.acquire('#host')).toThrow('outer start failed');
    expect(nestedError).toStrictEqual(
      new Error('Host lifecycle cannot be changed while start is running'),
    );
    expect(attempts).toBe(1);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });

  it('rejects a nested release without orphaning a successful start', () => {
    const queue: Array<() => void> = [];
    const stop = vi.fn();
    let nestedError: unknown;
    let releaseDuringStart = () => {};
    const host = createHost<{ id: number }, string>({
      start: () => {
        try {
          releaseDuringStart();
        } catch (error) {
          nestedError = error;
        }
        return { id: 1 };
      },
      stop,
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
    });
    releaseDuringStart = () => {
      host.release();
    };

    const instance = host.acquire('#host');
    expect(nestedError).toStrictEqual(
      new Error('Host lifecycle cannot be changed while start is running'),
    );
    expect(host.refCount).toBe(1);
    expect(host.current).toBe(instance);

    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(stop).toHaveBeenCalledOnce();
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });
});

describe('teardown reentrancy', () => {
  it('rejects a caught nested acquire without orphaning the stopped instance', () => {
    const queue: Array<() => void> = [];
    const stopped: Array<{ id: number }> = [];
    let attempts = 0;
    let nestedError: unknown;
    let acquireDuringStop = () => {};
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: ++attempts }),
      stop: (instance) => {
        stopped.push(instance);
        if (instance.id !== 1) return;
        try {
          acquireDuringStop();
        } catch (error) {
          nestedError = error;
        }
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
    });
    acquireDuringStop = () => {
      host.acquire('#nested');
    };

    host.acquire('#host');
    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(nestedError).toStrictEqual(
      new Error('Host lifecycle cannot be changed while stop is running'),
    );
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();

    expect(host.acquire('#host')).toEqual({ id: 2 });
    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(stopped).toEqual([{ id: 1 }, { id: 2 }]);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });

  it('surfaces an uncaught nested acquire after restoring teardown state', () => {
    const queue: Array<() => void> = [];
    let attempts = 0;
    let stopped = 0;
    let acquireDuringStop = () => {};
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: ++attempts }),
      stop: (instance) => {
        stopped++;
        if (instance.id === 1) acquireDuringStop();
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
    });
    acquireDuringStop = () => {
      host.acquire('#nested');
    };

    host.acquire('#host');
    host.release();
    const [flush] = queue.splice(0, 1);
    if (flush === undefined) throw new Error('missing deferred teardown');
    expect(() => flush()).toThrow('Host lifecycle cannot be changed while stop is running');
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();

    expect(host.acquire('#host')).toEqual({ id: 2 });
    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(stopped).toBe(2);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });

  it('rejects a nested release before it mutates refs or queues teardown', () => {
    const queue: Array<() => void> = [];
    let attempts = 0;
    let stopped = 0;
    let nestedError: unknown;
    let releaseDuringStop = () => {};
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: ++attempts }),
      stop: (instance) => {
        stopped++;
        if (instance.id !== 1) return;
        try {
          releaseDuringStop();
        } catch (error) {
          nestedError = error;
        }
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
    });
    releaseDuringStop = () => {
      host.release();
    };

    host.acquire('#host');
    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(nestedError).toStrictEqual(
      new Error('Host lifecycle cannot be changed while stop is running'),
    );
    expect(queue).toHaveLength(0);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();

    expect(host.acquire('#host')).toEqual({ id: 2 });
    host.release();
    for (const fn of queue.splice(0, queue.length)) fn();
    expect(stopped).toBe(2);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });
});

describe('async teardown', () => {
  it('holds lifecycle ownership until async stop succeeds, then starts fresh', async () => {
    const queue: Array<() => void | Promise<void>> = [];
    let attempts = 0;
    let stopped = 0;
    let resolveStop: (() => void) | undefined;
    const stopDone = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: ++attempts }),
      stop: (instance) => {
        stopped++;
        if (instance.id === 1) return stopDone;
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
    });

    const first = host.acquire('#host');
    host.release();
    const flush = queue.shift();
    if (flush === undefined) throw new Error('missing deferred teardown');
    const teardown = flush();
    expect(teardown).toBeInstanceOf(Promise);
    expect(host.current).toBe(first);
    expect(host.refCount).toBe(0);
    expect(() => host.acquire('#nested')).toThrow(
      'Host lifecycle cannot be changed while stop is running',
    );
    expect(() => host.release()).toThrow(
      'Host lifecycle cannot be changed while stop is running',
    );
    expect(host.refCount).toBe(0);

    if (resolveStop === undefined) throw new Error('missing stop resolver');
    resolveStop();
    await teardown;
    expect(host.current).toBeNull();

    expect(host.acquire('#host')).toEqual({ id: 2 });
    host.release();
    const retryFlush = queue.shift();
    if (retryFlush === undefined) throw new Error('missing retry teardown');
    retryFlush();
    expect(stopped).toBe(2);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });

  it('surfaces async stop failure, restores ownership, and starts fresh', async () => {
    const queue: Array<() => void | Promise<void>> = [];
    let attempts = 0;
    let stopped = 0;
    let rejectStop: ((error: Error) => void) | undefined;
    const stopDone = new Promise<void>((_resolve, reject) => {
      rejectStop = reject;
    });
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: ++attempts }),
      stop: (instance) => {
        stopped++;
        if (instance.id === 1) return stopDone;
      },
      defer: (fn) => {
        queue.push(fn);
        return queue.length - 1;
      },
    });

    const first = host.acquire('#host');
    host.release();
    const flush = queue.shift();
    if (flush === undefined) throw new Error('missing deferred teardown');
    const teardown = flush();
    expect(teardown).toBeInstanceOf(Promise);
    expect(host.current).toBe(first);
    expect(() => host.acquire('#nested')).toThrow(
      'Host lifecycle cannot be changed while stop is running',
    );
    expect(() => host.release()).toThrow(
      'Host lifecycle cannot be changed while stop is running',
    );
    expect(host.refCount).toBe(0);

    if (rejectStop === undefined) throw new Error('missing stop rejecter');
    rejectStop(new Error('async destroy failed'));
    await expect(teardown).rejects.toThrow('async destroy failed');
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();

    expect(host.acquire('#host')).toEqual({ id: 2 });
    host.release();
    const retryFlush = queue.shift();
    if (retryFlush === undefined) throw new Error('missing retry teardown');
    retryFlush();
    expect(stopped).toBe(2);
    expect(host.refCount).toBe(0);
    expect(host.current).toBeNull();
  });
});

describe('rapid churn', () => {
  it('holds one instance through repeated same-tick remounts', () => {
    // HMR and StrictMode can both produce bursts of this shape.
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.host.acquire('#host');
      h.host.release();
    }
    h.host.acquire('#host');
    h.flush();
    expect(h.started).toBe(1);
    expect(h.stopped).toBe(0);
  });

  it('never leaves an orphan when teardown and acquire interleave', () => {
    const h = harness();
    h.host.acquire('#host');
    h.host.release();
    h.host.acquire('#host'); // cancels the queued teardown
    h.flush(); // the cancelled teardown must be a no-op
    expect(h.host.current).not.toBeNull();
    expect(h.stopped).toBe(0);
    expect(h.started).toBe(1);
  });

  it('rolls back a failed remount when deferred teardown cancellation throws', () => {
    let pending: (() => void) | undefined;
    let stopped = 0;
    const cancelError = new Error('teardown cancellation failed');
    const host = createHost<{ id: number }, string>({
      start: () => ({ id: 1 }),
      stop: () => { stopped += 1; },
      defer: (fn) => {
        pending = fn;
        return 'pending';
      },
      cancel: () => { throw cancelError; },
    });

    const first = host.acquire('#host');
    host.release();

    expect(() => host.acquire('#host')).toThrow(cancelError);
    expect(host.current).toBe(first);
    expect(host.refCount).toBe(0);
    pending?.();
    expect(stopped).toBe(1);
    expect(host.current).toBeNull();
  });
});

describe('the guard against the naive implementation', () => {
  it('a create-on-acquire/destroy-on-release host would fail this', () => {
    // Demonstrates the bug the ref counting exists to prevent, so the reason
    // for this module survives someone deciding it looks over-engineered.
    let games = 0;
    const naive = {
      acquire: () => ++games,
      release: () => {
        /* Phaser defers to the next rAF, which never comes in a hidden tab */
      },
    };
    naive.acquire();
    naive.release();
    naive.acquire();
    expect(games).toBe(2); // two WebGL contexts — the thing we are avoiding

    const h = harness();
    h.host.acquire('#host');
    h.host.release();
    h.host.acquire('#host');
    expect(h.started).toBe(1); // one
  });
});
