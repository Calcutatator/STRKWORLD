import { describe, expect, it, vi } from 'vitest';
import { createWorldLeaseManager } from './world-acquisition.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorldHost acquisition lifecycle', () => {
  it('publishes an immutable lease API while retaining owned acquisition', () => {
    const manager = createWorldLeaseManager();
    const originalAcquire = manager.acquire;

    expect(Object.isFrozen(manager)).toBe(true);
    expect(Reflect.set(manager, 'acquire', () => () => undefined)).toBe(false);
    expect(manager.acquire).toBe(originalAcquire);
    const cleanup = manager.acquire(() => Promise.resolve(() => undefined));
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('single-flights overlapping leases and keeps one world alive', async () => {
    const gate = deferred<() => void>();
    let live = 0;
    let peakLive = 0;
    const release = vi.fn(() => {
      live--;
    });
    const acquire = vi.fn(() =>
      gate.promise.then(() => {
        live++;
        peakLive = Math.max(peakLive, live);
        return release;
      }),
    );
    const manager = createWorldLeaseManager();
    const leaseKey = {};

    // React StrictMode can clean the first effect before its replacement has
    // acquired a lease. The pending acquisition must remain reusable across
    // that zero-live-lease window.
    const firstCleanup = manager.acquire(acquire, leaseKey);
    firstCleanup();
    expect(release).not.toHaveBeenCalled();
    const secondCleanup = manager.acquire(acquire, leaseKey);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(live).toBe(0);

    gate.resolve(release);
    await flushPromises();

    expect(live).toBe(1);
    expect(peakLive).toBe(1);
    expect(release).not.toHaveBeenCalled();

    secondCleanup();
    expect(live).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for a stale pending acquisition before starting changed config', async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const calls: string[] = [];
    const manager = createWorldLeaseManager();
    const firstCleanup = manager.acquire(() => {
      calls.push('first');
      return first.promise;
    }, 'first');

    firstCleanup();
    const secondCleanup = manager.acquire(() => {
      calls.push('second');
      return second.promise;
    }, 'second');

    expect(calls).toEqual(['first']);
    first.resolve(() => calls.push('released-first'));
    await flushPromises();

    expect(calls).toEqual(['first', 'released-first', 'second']);
    second.resolve(() => calls.push('released-second'));
    await flushPromises();
    secondCleanup();
    expect(calls).toEqual(['first', 'released-first', 'second', 'released-second']);
  });

  it('replaces a live world after its old config releases ownership', async () => {
    const calls: string[] = [];
    const manager = createWorldLeaseManager();
    const firstCleanup = manager.acquire(async () => {
      calls.push('start-first');
      return () => calls.push('release-first');
    }, 'first');

    await flushPromises();
    const secondCleanup = manager.acquire(async () => {
      calls.push('start-second');
      return () => calls.push('release-second');
    }, 'second');

    expect(calls).toEqual(['start-first']);
    firstCleanup();
    await flushPromises();
    expect(calls).toEqual(['start-first', 'release-first', 'start-second']);

    secondCleanup();
    expect(calls).toEqual([
      'start-first',
      'release-first',
      'start-second',
      'release-second',
    ]);
  });

  it('starts the replacement after stale rejection and handles early cleanup', async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const calls: string[] = [];
    const manager = createWorldLeaseManager();
    const firstCleanup = manager.acquire(() => {
      calls.push('first');
      return first.promise;
    }, 'first');

    firstCleanup();
    const secondCleanup = manager.acquire(() => {
      calls.push('second');
      return second.promise;
    }, 'second');
    secondCleanup();

    first.reject(new Error('stale import failed'));
    await flushPromises();
    expect(calls).toEqual(['first', 'second']);

    const releaseSecond = vi.fn();
    second.resolve(releaseSecond);
    await flushPromises();
    expect(releaseSecond).toHaveBeenCalledTimes(1);

    const thirdRelease = vi.fn();
    const thirdCleanup = manager.acquire(() => Promise.resolve(thirdRelease), 'third');
    await flushPromises();
    thirdCleanup();
    expect(thirdRelease).toHaveBeenCalledTimes(1);
  });

  it('serializes multiple changed configs before the first acquisition settles', async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const third = deferred<() => void>();
    const calls: string[] = [];
    let live = 0;
    let peakLive = 0;
    const manager = createWorldLeaseManager();
    const acquire = (name: string, gate: Deferred<() => void>) => () => {
      calls.push(`start-${name}`);
      return gate.promise.then(() => {
        live++;
        peakLive = Math.max(peakLive, live);
        calls.push(`live-${name}`);
        return () => {
          live--;
          calls.push(`release-${name}`);
        };
      });
    };

    const firstCleanup = manager.acquire(acquire('first', first), 'first');
    firstCleanup();
    const secondCleanup = manager.acquire(acquire('second', second), 'second');
    secondCleanup();
    const thirdCleanup = manager.acquire(acquire('third', third), 'third');

    expect(calls).toEqual(['start-first']);
    first.resolve(() => undefined);
    await flushPromises();
    expect(calls).toEqual(['start-first', 'live-first', 'release-first', 'start-second']);

    second.resolve(() => undefined);
    await flushPromises();
    expect(calls).toEqual([
      'start-first', 'live-first', 'release-first',
      'start-second', 'live-second', 'release-second', 'start-third',
    ]);

    third.resolve(() => undefined);
    await flushPromises();
    expect(live).toBe(1);
    expect(peakLive).toBe(1);
    thirdCleanup();
    expect(live).toBe(0);
    expect(calls.at(-1)).toBe('release-third');
  });

  it('releases once when every pending lease cleans up before resolution', async () => {
    const gate = deferred<() => void>();
    let live = 0;
    const release = vi.fn(() => {
      live--;
    });
    const acquire = vi.fn(() =>
      gate.promise.then(() => {
        live++;
        return release;
      }),
    );
    const manager = createWorldLeaseManager();

    const firstCleanup = manager.acquire(acquire);
    const secondCleanup = manager.acquire(acquire);
    firstCleanup();
    secondCleanup();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(live).toBe(0);

    gate.resolve(release);
    await flushPromises();

    expect(live).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    firstCleanup();
    secondCleanup();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a normally acquired world exactly once', async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => Promise.resolve(release));
    const manager = createWorldLeaseManager();

    const cleanup = manager.acquire(acquire);
    await flushPromises();
    cleanup();
    cleanup();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('resets after rejection and consumes the rejected promise', async () => {
    const failure = deferred<() => void>();
    const release = vi.fn();
    const acquire = vi
      .fn<() => Promise<() => void>>()
      .mockReturnValueOnce(failure.promise)
      .mockReturnValueOnce(Promise.resolve(release));
    const manager = createWorldLeaseManager();

    const failedCleanup = manager.acquire(acquire);
    failedCleanup();
    failure.reject(new Error('lazy world failed'));
    await flushPromises();

    const cleanup = manager.acquire(acquire);
    expect(acquire).toHaveBeenCalledTimes(2);
    await flushPromises();
    cleanup();

    expect(release).toHaveBeenCalledTimes(1);
  });
});
