/**
 * Per-viewer conveniences kept in this browser's `localStorage`.
 *
 * Every access is guarded, because every access can fail: storage is absent
 * during server rendering, Node 25 exposes a `localStorage` object with no
 * methods, privacy modes and sandboxed frames throw on the getter itself, and a
 * full quota throws on write. None of that may break a surface that uses it. A
 * failed read answers "not set"; a failed write keeps the choice only for as
 * long as the component holding it stays mounted.
 *
 * This is for presentation preferences only — the guide's dismissal, the HUD
 * balance toggle and an opaque Bridge-arrival fingerprint
 * (`bridge/arrival-nudge.ts`). No address, amount, hash or timestamp goes
 * through it, and nothing here is ever sent anywhere.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ViewerStorage {
  /** The stored value, or null when it is unset or cannot be read. Never throws. */
  read(key: string): string | null;
  /** False when the browser refused the write. Never throws. */
  write(key: string, value: string): boolean;
  /** False when the browser refused the removal. Never throws. */
  remove(key: string): boolean;
}

export function createViewerStorage(
  resolve: () => StorageLike | null | undefined,
): ViewerStorage {
  const guarded = <T>(fallback: T, use: (storage: StorageLike) => T): T => {
    try {
      const storage = resolve();
      return storage ? use(storage) : fallback;
    } catch {
      return fallback;
    }
  };

  return Object.freeze({
    read: (key: string): string | null =>
      guarded<string | null>(null, (storage) => {
        const value = storage.getItem(key);
        return typeof value === 'string' ? value : null;
      }),
    write: (key: string, value: string): boolean =>
      guarded(false, (storage) => {
        storage.setItem(key, value);
        return true;
      }),
    remove: (key: string): boolean =>
      guarded(false, (storage) => {
        storage.removeItem(key);
        return true;
      }),
  });
}

/** The page's own storage, resolved on every access: the getter itself can throw. */
export const browserViewerStorage: ViewerStorage = createViewerStorage(
  () => globalThis.localStorage,
);
