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
}

describe('WorldHost acquisition lifecycle', () => {
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

    // React StrictMode can clean the first effect before its replacement has
    // acquired a lease. The pending acquisition must remain reusable across
    // that zero-live-lease window.
    const firstCleanup = manager.acquire(acquire);
    firstCleanup();
    expect(release).not.toHaveBeenCalled();
    const secondCleanup = manager.acquire(acquire);

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
