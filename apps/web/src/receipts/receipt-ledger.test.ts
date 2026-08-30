import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '@strkworld/privacy';
import { createReceiptLedger, type Receipt } from './receipt-ledger.js';

const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const intents: readonly Intent[] = [{ kind: 'shield', token: TOKEN, amount: 1n }];

describe('receipt ledger', () => {
  it('publishes an immutable ledger API while retaining owned mutations', () => {
    const ledger = createReceiptLedger();
    const originalRecord = ledger.record;

    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Reflect.set(ledger, 'record', () => undefined)).toBe(false);
    expect(Reflect.set(ledger, 'acknowledge', () => undefined)).toBe(false);
    expect(ledger.record).toBe(originalRecord);
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });
    expect(ledger.pending('bank')).toHaveLength(1);
  });

  it('keeps the public receipt store read-only', () => {
    const ledger = createReceiptLedger();

    expect('setState' in ledger.store).toBe(false);
    expect(Object.isFrozen(ledger.store.getState())).toBe(true);
  });

  it('holds a receipt until it is acknowledged', () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });

    expect(ledger.pending('bank')).toHaveLength(1);
    ledger.acknowledge('0xabc');
    expect(ledger.pending('bank')).toHaveLength(0);
  });

  it('keeps buildings separate', () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });
    ledger.record({ building: 'exchange', transactionHash: '0xdef', intents });

    expect(ledger.pending('bank').map((r) => r.transactionHash)).toEqual(['0xabc']);
    expect(ledger.pending('exchange').map((r) => r.transactionHash)).toEqual(['0xdef']);
  });

  it('records one receipt per transaction, however many times it is told', () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });
    expect(ledger.pending('bank')).toHaveLength(1);
  });

  it('uses felt identity for duplicate recording and acknowledgement', () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'bank', transactionHash: '0x000Ab', intents });
    ledger.record({ building: 'bank', transactionHash: '0xab', intents });

    expect(ledger.pending('bank')).toEqual([{
      building: 'bank',
      transactionHash: '0x000Ab',
      intents,
    }]);
    ledger.acknowledge('0x00AB');
    expect(ledger.pending('bank')).toEqual([]);
  });

  it('keeps out-of-field hashes on their exact raw identity', () => {
    const ledger = createReceiptLedger();
    const outOfField = (1n << 251n) + (17n << 192n) + 0xabn;
    const lowercase = `0x${outOfField.toString(16)}`;
    const uppercase = `0x${outOfField.toString(16).toUpperCase()}`;

    ledger.record({ building: 'bank', transactionHash: lowercase, intents });
    ledger.record({ building: 'bank', transactionHash: uppercase, intents });

    expect(ledger.pending('bank')).toHaveLength(2);
    ledger.acknowledge(lowercase);
    expect(ledger.pending('bank')).toEqual([{
      building: 'bank',
      transactionHash: uppercase,
      intents,
    }]);
  });

  it('owns a receipt snapshot after recording it', () => {
    const sourceIntents: Intent[] = [{ kind: 'shield', token: TOKEN, amount: 1n }];
    const source: Receipt = {
      building: 'bank',
      transactionHash: '0xabc',
      intents: sourceIntents,
    };
    const ledger = createReceiptLedger();
    ledger.record(source);

    Reflect.set(source, 'building', 'exchange');
    Reflect.set(source, 'transactionHash', '0xchanged');
    sourceIntents[0] = { kind: 'shield', token: TOKEN, amount: 2n };
    sourceIntents.push({ kind: 'shield', token: TOKEN, amount: 3n });

    expect(ledger.pending('bank')).toEqual([{
      building: 'bank',
      transactionHash: '0xabc',
      intents: [{ kind: 'shield', token: TOKEN, amount: 1n }],
    }]);
    expect(ledger.pending('exchange')).toHaveLength(0);
    ledger.acknowledge('0xabc');
    expect(ledger.pending('bank')).toHaveLength(0);
  });

  it('does not expose mutable held receipts through pending snapshots', () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });

    const pending = ledger.pending('bank');
    const held = pending[0]!;
    expect(Object.isFrozen(ledger.store.getState())).toBe(true);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held.intents)).toBe(true);
    expect(Object.isFrozen(held.intents[0])).toBe(true);
    expect(Reflect.set(held, 'building', 'exchange')).toBe(false);
    expect(Reflect.set(held, 'transactionHash', '0xchanged')).toBe(false);
    expect(Reflect.set(held.intents[0]!, 'amount', 2n)).toBe(false);
    expect(Reflect.set(held.intents, '0', { kind: 'shield', token: TOKEN, amount: 3n })).toBe(false);

    expect(ledger.pending('bank')).toEqual([{
      building: 'bank',
      transactionHash: '0xabc',
      intents: [{ kind: 'shield', token: TOKEN, amount: 1n }],
    }]);
    expect(ledger.pending('exchange')).toHaveLength(0);
    ledger.acknowledge('0xabc');
    expect(ledger.pending('bank')).toHaveLength(0);
  });

  it('keeps receipts oldest first, so nothing jumps the queue', () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'bank', transactionHash: '0x1', intents });
    ledger.record({ building: 'bank', transactionHash: '0x2', intents });
    expect(ledger.pending('bank').map((r) => r.transactionHash)).toEqual(['0x1', '0x2']);
  });

  it('notifies a subscriber when a receipt lands with no panel open', () => {
    const ledger = createReceiptLedger();
    const listener = vi.fn();
    ledger.store.subscribe(listener);
    ledger.record({ building: 'bank', transactionHash: '0xabc', intents });
    expect(listener).toHaveBeenCalledOnce();
  });
});
