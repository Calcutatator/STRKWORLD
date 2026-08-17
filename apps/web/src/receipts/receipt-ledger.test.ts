import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '@strkworld/privacy';
import { createReceiptLedger } from './receipt-ledger.js';

const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const intents: readonly Intent[] = [{ kind: 'shield', token: TOKEN, amount: 1n }];

describe('receipt ledger', () => {
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
