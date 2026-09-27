import { describe, expect, it } from 'vitest';
import { createViewerStorage, type StorageLike } from './viewer-storage.js';

function memory(): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe('viewer storage', () => {
  it('reads, writes and removes through the page storage', () => {
    const page = memory();
    const storage = createViewerStorage(() => page);

    expect(storage.read('strkworld.test')).toBeNull();
    expect(storage.write('strkworld.test', '1')).toBe(true);
    expect(storage.read('strkworld.test')).toBe('1');
    expect(storage.remove('strkworld.test')).toBe(true);
    expect(page.values.size).toBe(0);
  });

  it('answers "not set" and refuses quietly when there is no storage at all', () => {
    for (const absent of [undefined, null]) {
      const storage = createViewerStorage(() => absent);
      expect(storage.read('strkworld.test')).toBeNull();
      expect(storage.write('strkworld.test', '1')).toBe(false);
      expect(storage.remove('strkworld.test')).toBe(false);
    }
  });

  it('survives a storage getter that throws, as privacy modes and sandboxed frames do', () => {
    const storage = createViewerStorage(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(() => storage.read('strkworld.test')).not.toThrow();
    expect(storage.read('strkworld.test')).toBeNull();
    expect(storage.write('strkworld.test', '1')).toBe(false);
    expect(storage.remove('strkworld.test')).toBe(false);
  });

  it('survives methods that throw: a blocked read, a full quota, a refused removal', () => {
    const storage = createViewerStorage(() => ({
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('refused');
      },
    }));
    expect(storage.read('strkworld.test')).toBeNull();
    expect(storage.write('strkworld.test', '1')).toBe(false);
    expect(storage.remove('strkworld.test')).toBe(false);
  });

  it('survives the method-less localStorage object Node 25 exposes', () => {
    const storage = createViewerStorage(() => ({}) as StorageLike);
    expect(storage.read('strkworld.test')).toBeNull();
    expect(storage.write('strkworld.test', '1')).toBe(false);
  });

  it('never hands back a value that is not a string', () => {
    const storage = createViewerStorage(() => ({
      getItem: () => ({ toString: () => '1' }) as unknown as string,
      setItem: () => {},
      removeItem: () => {},
    }));
    expect(storage.read('strkworld.test')).toBeNull();
  });
});
