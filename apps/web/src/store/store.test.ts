import { describe, expect, it, vi } from 'vitest';
import { createStore } from './store.js';

describe('createStore', () => {
  it('keeps a replacement subscription when an older unsubscribe settles later', () => {
    const store = createStore(0);
    const listener = vi.fn();
    const staleStop = store.subscribe(listener);
    store.subscribe(listener);

    staleStop();
    staleStop();
    store.setState(1);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(1);
  });

  it('does not deliver an old transition to a replacement of the same listener', () => {
    const store = createStore(0);
    const seen: string[] = [];
    const second = vi.fn((state: number) => seen.push(`second:${state}`));
    let stopSecond!: () => void;
    const first = vi.fn((state: number) => {
      seen.push(`first:${state}`);
      if (state === 1) {
        stopSecond();
        store.subscribe(second);
      }
    });
    store.subscribe(first);
    stopSecond = store.subscribe(second);

    store.setState(1);

    expect(seen).toEqual(['first:1']);
    store.setState(2);
    expect(seen).toEqual(['first:1', 'first:2', 'second:2']);
  });

  it('delivers reentrant transitions in order with their captured state', () => {
    const store = createStore(0);
    const seen: string[] = [];
    store.subscribe((state) => {
      seen.push(`first:${state}`);
      if (state === 1) store.setState(2);
    });
    store.subscribe((state) => seen.push(`second:${state}`));

    store.setState(1);

    expect(seen).toEqual(['first:1', 'second:1', 'first:2', 'second:2']);
    expect(store.getState()).toBe(2);
  });

  it('does not deliver a queued transition to a listener added after it was set', () => {
    const store = createStore(0);
    const late = vi.fn();
    store.subscribe((state) => {
      if (state === 1) {
        store.setState(2);
        store.subscribe(late);
      }
    });

    store.setState(1);

    expect(late).not.toHaveBeenCalled();
    store.setState(3);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith(3);
  });

  it('uses Object.is to suppress only equivalent states', () => {
    const store = createStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState(0);
    store.setState(-0);
    store.setState(Number.NaN);
    store.setState(Number.NaN);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(Object.is(listener.mock.calls[0]?.[0], -0)).toBe(true);
    expect(Number.isNaN(listener.mock.calls[1]?.[0])).toBe(true);
  });

  it('isolates a throwing subscriber from the transition and later subscribers', () => {
    const store = createStore('before');
    const error = new Error('subscriber failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();
    store.subscribe(() => {
      throw error;
    });
    store.subscribe(later);

    try {
      store.setState('after');

      expect(store.getState()).toBe('after');
      expect(later).toHaveBeenCalledOnce();
      expect(later).toHaveBeenCalledWith('after');
      expect(consoleError).toHaveBeenCalledWith('store: subscriber threw', error);
    } finally {
      consoleError.mockRestore();
    }
  });
});
