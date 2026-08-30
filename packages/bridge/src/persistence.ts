import type { BridgeLeg, BridgeRecord, BridgeStatus } from './types.js';

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
export const MAX_RESUME_RECORD_BYTES = 256_000;
export const MAX_DEPOSIT_ADDRESS_LENGTH = 256;
const MAX_PERSISTED_AMOUNT = (1n << 256n) - 1n;
const BRIDGE_LEGS: readonly BridgeLeg[] = [
  'quoted',
  'awaiting-deposit',
  'deposit-detected',
  'solver-settling',
  'settled',
  'failed',
  'expired',
];
const BRIDGE_STATUS_FIELDS = [
  'leg',
  'depositTxHash',
  'settlementTxHash',
  'strkReceived',
  'message',
  'pollingStopped',
] as const;
const BRIDGE_RECORD_FIELDS = [
  'v',
  'createdAt',
  'updatedAt',
  'source',
  'amountIn',
  'starknetRecipient',
  'refundAddress',
  'signedQuote',
  'status',
] as const;

export function serializeBridgeRecord(record: BridgeRecord): string {
  return JSON.stringify(record, (_key, value: unknown) =>
    typeof value === 'bigint' ? { $strkworldBigInt: value.toString() } : value,
  );
}

export function deserializeBridgeRecord(raw: string): BridgeRecord | null {
  if (typeof raw !== 'string') return null;
  if (
    raw.length > MAX_RESUME_RECORD_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_RESUME_RECORD_BYTES
  ) return null;
  try {
    const value = JSON.parse(raw, (_key, entry: unknown) => {
      if (
        entry &&
        typeof entry === 'object' &&
        Object.prototype.hasOwnProperty.call(entry, '$strkworldBigInt') &&
        typeof (entry as { $strkworldBigInt?: unknown }).$strkworldBigInt === 'string'
      ) {
        return BigInt((entry as { $strkworldBigInt: string }).$strkworldBigInt);
      }
      return entry;
    }) as BridgeRecord;
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !BRIDGE_RECORD_FIELDS.includes(key as typeof BRIDGE_RECORD_FIELDS[number]))
    ) return null;
    if (
      !hasOwnDataProperty(value, 'v') ||
      !hasOwnDataProperty(value, 'signedQuote') ||
      !hasOwnDataProperty(value, 'createdAt') ||
      !hasOwnDataProperty(value, 'updatedAt') ||
      !hasOwnDataProperty(value, 'amountIn') ||
      !hasOwnDataProperty(value, 'source') ||
      !hasOwnDataProperty(value, 'starknetRecipient') ||
      !hasOwnDataProperty(value, 'refundAddress') ||
      !hasOwnDataProperty(value, 'status') ||
      value.v !== 1 ||
      !value.signedQuote?.signature ||
      !isUsableDepositAddress(value.signedQuote.quote?.depositAddress)
    ) {
      return null;
    }
    if (!isPersistedTimestamp(value.createdAt) || !isPersistedTimestamp(value.updatedAt)) return null;
    if (typeof value.amountIn !== 'bigint') return null;
    if (!isBridgeStatus(value.status)) return null;
    return value;
  } catch {
    return null;
  }
}

export function isUsableDepositAddress(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DEPOSIT_ADDRESS_LENGTH &&
    !/\s/.test(value);
}

function isBridgeStatus(value: unknown): value is BridgeStatus {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !BRIDGE_STATUS_FIELDS.includes(key as typeof BRIDGE_STATUS_FIELDS[number]))) {
    return false;
  }
  if (
    !BRIDGE_LEGS.includes(value.leg as BridgeLeg) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    typeof value.pollingStopped !== 'boolean'
  ) return false;
  if (
    value.leg !== 'settled' &&
    (Object.prototype.hasOwnProperty.call(value, 'settlementTxHash') ||
      Object.prototype.hasOwnProperty.call(value, 'strkReceived'))
  ) return false;
  if (
    (value.leg === 'quoted' || value.leg === 'awaiting-deposit') &&
    Object.prototype.hasOwnProperty.call(value, 'depositTxHash')
  ) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'depositTxHash') &&
    !isBoundedHash(value.depositTxHash)
  ) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'settlementTxHash') &&
    !isBoundedHash(value.settlementTxHash)
  ) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'strkReceived') &&
    (typeof value.strkReceived !== 'bigint' ||
      value.strkReceived < 0n ||
      value.strkReceived > MAX_PERSISTED_AMOUNT)
  ) return false;
  return true;
}

function isBoundedHash(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

function isPersistedTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasOwnDataProperty(value: object, key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && 'value' in descriptor);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class LocalBridgeStore implements BridgeStore {
  constructor(private readonly storage: StorageLike) {}

  load(): BridgeRecord | null {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = deserializeBridgeRecord(raw);
    if (!record) this.clear();
    return record;
  }

  save(record: BridgeRecord): void {
    this.storage.setItem(STORAGE_KEY, serializeBridgeRecord(record));
  }

  clear(): void {
    this.storage.removeItem(STORAGE_KEY);
  }
}

export class MemoryBridgeStore implements BridgeStore {
  private value: string | null = null;

  load(): BridgeRecord | null {
    return this.value ? deserializeBridgeRecord(this.value) : null;
  }

  save(record: BridgeRecord): void {
    this.value = serializeBridgeRecord(record);
  }

  clear(): void {
    this.value = null;
  }

  serialize(record: BridgeRecord): string {
    return serializeBridgeRecord(record);
  }

  deserialize(raw: string): BridgeRecord | null {
    return deserializeBridgeRecord(raw);
  }
}
