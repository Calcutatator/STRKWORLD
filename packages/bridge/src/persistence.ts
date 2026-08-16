import type { BridgeRecord } from './types.js';

export interface BridgeStore {
  load(): BridgeRecord | null;
  save(record: BridgeRecord): void;
  clear(): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'strkworld.bridge.inbound.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function encode(record: BridgeRecord): string {
  return JSON.stringify(record, (_key, value: unknown) =>
    typeof value === 'bigint' ? { $strkworldBigInt: value.toString() } : value,
  );
}

function decode(raw: string, now: number): BridgeRecord | null {
  try {
    const value = JSON.parse(raw, (_key, entry: unknown) => {
      if (
        entry &&
        typeof entry === 'object' &&
        '$strkworldBigInt' in entry &&
        typeof (entry as { $strkworldBigInt?: unknown }).$strkworldBigInt === 'string'
      ) {
        return BigInt((entry as { $strkworldBigInt: string }).$strkworldBigInt);
      }
      return entry;
    }) as BridgeRecord;
    if (value.v !== 1 || !value.signedQuote?.signature || !value.signedQuote.quote?.depositAddress) {
      return null;
    }
    if (!Number.isFinite(value.createdAt) || now - value.createdAt > MAX_AGE_MS) return null;
    if (typeof value.amountIn !== 'bigint') return null;
    return value;
  } catch {
    return null;
  }
}

export class LocalBridgeStore implements BridgeStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly now: () => number = Date.now,
  ) {}

  load(): BridgeRecord | null {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = decode(raw, this.now());
    if (!record) this.clear();
    return record;
  }

  save(record: BridgeRecord): void {
    this.storage.setItem(STORAGE_KEY, encode(record));
  }

  clear(): void {
    this.storage.removeItem(STORAGE_KEY);
  }
}

export class MemoryBridgeStore implements BridgeStore {
  private value: string | null = null;

  load(): BridgeRecord | null {
    return this.value ? decode(this.value, Date.now()) : null;
  }

  save(record: BridgeRecord): void {
    this.value = encode(record);
  }

  clear(): void {
    this.value = null;
  }

  serialize(record: BridgeRecord): string {
    return encode(record);
  }

  deserialize(raw: string): BridgeRecord | null {
    return decode(raw, Date.now());
  }
}
