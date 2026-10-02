import { hash, shortString } from 'starknet';

/**
 * Leaderboard phase 1: the next receipt nonce, remembered on this device so a
 * normal shield, unshield or send never has to send the season commitment `p`
 * anywhere to find it. The backend's shadow scan is the fallback only when the
 * device has no record (a new device, cleared storage, another browser).
 *
 * The key is `strkworld:lb-nonce:<season>:<h>`, `h` a Poseidon hash of a
 * domain tag, the season and `p`: per account and season, and never `p`
 * itself. The value is a small integer. Every access is guarded: storage that
 * is absent, blocked or full reads as "no record" and writes nothing.
 */
export interface ReceiptNonceStore {
  /** The next nonce this device recorded for the key, or null. Never throws. */
  read(key: string): bigint | null;
  /** Remember the next nonce. Never throws. */
  write(key: string, next: bigint): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'strkworld:lb-nonce:';
const MAX_NONCE = 1_024n;

/** The storage key for a season and a partial commitment: hashed, never the commitment. */
export function receiptNonceKey(season: string, partialCommitment: string): string {
  const h = hash.computePoseidonHashOnElements([
    shortString.encodeShortString('strkworld-lb-nonce'),
    shortString.encodeShortString(season),
    partialCommitment,
  ]);
  return `${PREFIX}${season}:${BigInt(h).toString(16)}`;
}

/** A store over `localStorage` (or the given storage), fully guarded. */
export function createReceiptNonceStore(resolve: () => StorageLike | null | undefined = defaultStorage): ReceiptNonceStore {
  return {
    read(key) {
      try {
        const raw = resolve()?.getItem(key) ?? null;
        if (raw === null || !/^\d{1,5}$/.test(raw)) return null;
        const value = BigInt(raw);
        return value <= MAX_NONCE ? value : null;
      } catch {
        return null;
      }
    },
    write(key, next) {
      try {
        if (next < 0n || next > MAX_NONCE) return;
        resolve()?.setItem(key, next.toString());
      } catch {
        // A refused write keeps nothing; the next action falls back to the scan.
      }
    },
  };
}

function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}
