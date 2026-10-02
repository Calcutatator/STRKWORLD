import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { ENTRY_PASS_PREFIX, createEntryPassMemory, sha256Hex } from './entry-pass.js';

const ACCOUNT = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';

function memoryStorage(): StorageLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

function expectedKey(account: string): string {
  const normalised = `0x${BigInt(account).toString(16)}`;
  return `${ENTRY_PASS_PREFIX}${createHash('sha256').update(`strkworld:entry-pass:v1:${normalised}`).digest('hex')}`;
}

describe('the entry pass (D-072)', () => {
  it('remembers a pass for this account under a hash, never the address, a balance or an amount', async () => {
    const raw = memoryStorage();
    const pass = createEntryPassMemory({ account: ACCOUNT, storage: createViewerStorage(() => raw) })!;

    await expect(pass.recall()).resolves.toBe(false);
    await pass.remember();
    await expect(pass.recall()).resolves.toBe(true);

    expect([...raw.entries]).toEqual([[expectedKey(ACCOUNT), 'passed']]);
    const stored = JSON.stringify([...raw.entries]).toLowerCase();
    expect(stored).not.toContain(ACCOUNT.slice(2).toLowerCase());
    expect(stored).not.toContain(BigInt(ACCOUNT).toString(16));
  });

  it('keys one account the same way whatever its padding or case', async () => {
    const raw = memoryStorage();
    const storage = createViewerStorage(() => raw);
    await createEntryPassMemory({ account: '0x00abc', storage })!.remember();
    await expect(createEntryPassMemory({ account: '0xABC', storage })!.recall()).resolves.toBe(true);
  });

  it('checks another account again', async () => {
    const raw = memoryStorage();
    const storage = createViewerStorage(() => raw);
    await createEntryPassMemory({ account: '0xabc', storage })!.remember();
    await expect(createEntryPassMemory({ account: '0xdef', storage })!.recall()).resolves.toBe(false);
  });

  it('D-120: forgets the pass on sign-out, leaving every other account\'s', async () => {
    const raw = memoryStorage();
    const storage = createViewerStorage(() => raw);
    await createEntryPassMemory({ account: '0xdef', storage })!.remember();
    const pass = createEntryPassMemory({ account: ACCOUNT, storage })!;
    await pass.remember();
    await pass.forget();
    await expect(pass.recall()).resolves.toBe(false);
    await expect(createEntryPassMemory({ account: '0xdef', storage })!.recall()).resolves.toBe(true);

    const throwing = createViewerStorage(() => { throw new Error('sessionStorage blocked'); });
    await expect(createEntryPassMemory({ account: ACCOUNT, storage: throwing })!.forget()).resolves.toBeUndefined();
  });

  it('has nothing to key without an account', () => {
    for (const account of [null, '', 'player', '0x0', '0xnot-hex']) {
      expect(createEntryPassMemory({ account })).toBeNull();
    }
  });

  it('checks again whenever storage or hashing fails, and never throws', async () => {
    const throwing = createViewerStorage(() => { throw new Error('sessionStorage blocked'); });
    const blocked = createEntryPassMemory({ account: ACCOUNT, storage: throwing })!;
    await expect(blocked.remember()).resolves.toBeUndefined();
    await expect(blocked.recall()).resolves.toBe(false);

    const raw = memoryStorage();
    const noCrypto = createEntryPassMemory({ account: ACCOUNT, storage: createViewerStorage(() => raw), digest: async () => null })!;
    await noCrypto.remember();
    await expect(noCrypto.recall()).resolves.toBe(false);
    expect(raw.entries.size).toBe(0);

    const badDigest = createEntryPassMemory({ account: ACCOUNT, storage: createViewerStorage(() => raw), digest: async () => 'ADDRESS' })!;
    await badDigest.remember();
    expect(raw.entries.size).toBe(0);

    const rejecting = createEntryPassMemory({ account: ACCOUNT, storage: createViewerStorage(() => raw), digest: () => Promise.reject(new Error('no subtle')) })!;
    await expect(rejecting.recall()).resolves.toBe(false);
  });

  it('reads nothing but its own constant as a pass', async () => {
    const raw = memoryStorage();
    raw.entries.set(expectedKey(ACCOUNT), 'true');
    await expect(createEntryPassMemory({ account: ACCOUNT, storage: createViewerStorage(() => raw) })!.recall()).resolves.toBe(false);
  });

  it('hashes with SHA-256 through the platform crypto', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(createHash('sha256').update('abc').digest('hex'));
  });
});
