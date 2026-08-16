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
