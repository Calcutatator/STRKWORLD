import { looksLikeAddress } from '../format.js';
import { createViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';

/**
 * The entry gate's once-per-session pass (D-072).
 *
 * After an account passes the gate, this tab remembers it in `sessionStorage`
 * so a reload lets the same account straight back in, without a second
 * "Share private balances" prompt. Another account checks again, and a new
 * tab or browser session checks again.
 *
 * The key is a SHA-256 of the normalised account under a fixed label, and the
 * value is a constant. No address, balance or amount is stored, and nothing
 * here is ever sent anywhere. Every step can fail (no storage, no
 * `crypto.subtle` outside a secure context, a full quota); a failure only
 * means the gate checks again.
 */

export interface EntryPassMemory {
  /** Whether this tab already let this account in. Never rejects; false when unsure. */
  recall(): Promise<boolean>;
  /** Remember the pass for this tab. Never rejects; a lost write only means checking again. */
  remember(): Promise<void>;
}

export type Digest = (text: string) => Promise<string | null>;

export const ENTRY_PASS_PREFIX = 'strkworld:entry-pass:';
const ENTRY_PASS_LABEL = 'strkworld:entry-pass:v1:';
const PASSED = 'passed';
const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** This tab's own session storage, resolved on every access: the getter itself can throw. */
const tabStorage: ViewerStorage = createViewerStorage(() => globalThis.sessionStorage);

/**
 * The pass for one account, or null when there is no account to key it by
 * (the demo) or the value is not an address.
 */
export function createEntryPassMemory({
  account,
  storage = tabStorage,
  digest = sha256Hex,
}: {
  account: string | null;
  storage?: ViewerStorage;
  digest?: Digest;
}): EntryPassMemory | null {
  const normalised = normaliseAccount(account);
  if (normalised === null) return null;
  let key: Promise<string | null> | null = null;
  const keyFor = (): Promise<string | null> => {
    key ??= Promise.resolve()
      .then(() => digest(`${ENTRY_PASS_LABEL}${normalised}`))
      .then((hex) => (typeof hex === 'string' && HEX_DIGEST.test(hex) ? `${ENTRY_PASS_PREFIX}${hex}` : null))
      .catch(() => null);
    return key;
  };
  return Object.freeze({
    async recall(): Promise<boolean> {
      try {
        const stored = await keyFor();
        return stored !== null && storage.read(stored) === PASSED;
      } catch {
        return false;
      }
    },
    async remember(): Promise<void> {
      try {
        const stored = await keyFor();
        if (stored !== null) storage.write(stored, PASSED);
      } catch {
        // Checking again next time is the whole cost.
      }
    },
  });
}

/** One spelling per account, whatever the padding or case the wallet used. */
function normaliseAccount(account: string | null): string | null {
  if (typeof account !== 'string' || !looksLikeAddress(account)) return null;
  try {
    const value = BigInt(account.trim());
    return value === 0n ? null : `0x${value.toString(16)}`;
  } catch {
    return null;
  }
}

/** Lowercase hex SHA-256, or null where the browser offers no `crypto.subtle`. */
export async function sha256Hex(text: string): Promise<string | null> {
  let subtle: SubtleCrypto | undefined;
  try {
    subtle = globalThis.crypto?.subtle;
  } catch {
    return null;
  }
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
