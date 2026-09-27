import { describe, expect, it } from 'vitest';
import type { QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { LocalBridgeStore, type BridgeRecord, type BridgeStatus } from '@strkworld/bridge';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { ARRIVAL_DISMISSED_KEY, createArrivalNudge, readSettledArrival } from './arrival-nudge.js';

const ACCOUNT = '0x123';
const SETTLED: BridgeStatus = {
  leg: 'settled',
  settlementTxHash: '0xsettled',
  strkReceived: 18_500_000_000_000_000_000n,
  message: 'STRK arrived.',
  pollingStopped: true,
};

function signedQuote(depositAddress: string): QuoteResponse {
  return {
    correlationId: 'corr',
    timestamp: '2026-08-18T00:00:00.000Z',
    signature: 'sig',
    quoteRequest: { recipient: ACCOUNT, deadline: '2030-08-18T00:30:00.000Z', slippageTolerance: 100 },
    quote: { depositAddress, amountIn: '1000000', amountOut: '20000000000000000000', minAmountOut: '19000000000000000000', deadline: '2030-08-18T00:30:00.000Z' },
  } as unknown as QuoteResponse;
}

function record(status: BridgeStatus = SETTLED, depositAddress = '0xdeposit-one', createdAt = 1_000): BridgeRecord {
  return {
    v: 1,
    createdAt,
    updatedAt: createdAt + 1,
    source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
    amountIn: 1_000_000n,
    starknetRecipient: ACCOUNT,
    refundAddress: '0x1111111111111111111111111111111111111111',
    signedQuote: signedQuote(depositAddress),
    status,
  };
}

/** One browser's localStorage, shared by the Bridge's own store and the nudge. */
function page() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(`set:${key}`);
      values.set(key, value);
    },
    removeItem: (key) => {
      writes.push(`remove:${key}`);
      values.delete(key);
    },
  };
  const bridge = new LocalBridgeStore(storage);
  return { values, writes, storage, bridge, viewer: createViewerStorage(() => storage) };
}

describe('Bridge arrival nudge (D-021)', () => {
  it('waits while the saved Bridge record has settled STRK', () => {
    const browser = page();
    browser.bridge.save(record());
    const nudge = createArrivalNudge({ storage: browser.viewer });

    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(true);
  });

  it('stays quiet before settlement, for an empty arrival and with no record', () => {
    const before: BridgeStatus[] = [
      { leg: 'quoted', message: 'quoted', pollingStopped: false },
      { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false },
      { leg: 'deposit-detected', depositTxHash: '0xorigin', message: 'detected', pollingStopped: false },
      { leg: 'solver-settling', depositTxHash: '0xorigin', message: 'settling', pollingStopped: true },
      { leg: 'failed', message: 'failed', pollingStopped: true },
      { leg: 'expired', message: 'expired', pollingStopped: true },
      { ...SETTLED, strkReceived: 0n },
    ];
    for (const status of before) {
      const browser = page();
      browser.bridge.save(record(status));
      const nudge = createArrivalNudge({ storage: browser.viewer });
      nudge.refresh();
      expect(nudge.store.getState().waiting, status.leg).toBe(false);
    }
    const empty = createArrivalNudge({ storage: page().viewer });
    empty.refresh();
    expect(empty.store.getState().waiting).toBe(false);
  });

  it('persists across a closed tab and ends when the record is discarded at the Bridge', () => {
    const browser = page();
    browser.bridge.save(record());
    createArrivalNudge({ storage: browser.viewer }).refresh();

    // A new page load: nothing in memory, only the Bridge's own record.
    const returning = createArrivalNudge({ storage: browser.viewer });
    returning.refresh();
    expect(returning.store.getState().waiting).toBe(true);

    browser.bridge.clear();
    returning.refresh();
    expect(returning.store.getState().waiting).toBe(false);
  });

  it('ends for one arrival when dismissed, and comes back for the next arrival', () => {
    const browser = page();
    browser.bridge.save(record());
    const nudge = createArrivalNudge({ storage: browser.viewer });
    nudge.refresh();

    nudge.dismiss();
    expect(nudge.store.getState().waiting).toBe(false);
    const reloaded = createArrivalNudge({ storage: browser.viewer });
    reloaded.refresh();
    expect(reloaded.store.getState().waiting).toBe(false);

    browser.bridge.clear();
    browser.bridge.save(record(SETTLED, '0xdeposit-two', 5_000));
    reloaded.refresh();
    expect(reloaded.store.getState().waiting).toBe(true);
  });

  it('stores an opaque fingerprint, never Bridge evidence, and drops it with the record', () => {
    const browser = page();
    browser.bridge.save(record());
    const nudge = createArrivalNudge({ storage: browser.viewer });
    nudge.refresh();
    nudge.dismiss();

    const saved = browser.values.get(ARRIVAL_DISMISSED_KEY);
    expect(saved).toMatch(/^[0-9a-f]{8}$/);
    for (const evidence of ['0xdeposit-one', '1000', ACCOUNT, '18500000000000000000', 'sig', 'corr']) {
      expect(saved).not.toContain(evidence);
    }

    browser.bridge.clear();
    nudge.refresh();
    expect(browser.values.has(ARRIVAL_DISMISSED_KEY)).toBe(false);
  });

  it('never writes the Bridge record — an invalid record is left for the Bridge to judge', () => {
    const browser = page();
    browser.bridge.save(record());
    const [recordKey] = [...browser.values.keys()];
    browser.writes.length = 0;

    const nudge = createArrivalNudge({ storage: browser.viewer });
    nudge.refresh();
    nudge.dismiss();
    nudge.refresh();
    expect(browser.writes).toEqual([`set:${ARRIVAL_DISMISSED_KEY}`]);

    // LocalBridgeStore.load() clears a record it cannot parse. Read through
    // the nudge, it must not: that is the Bridge's call, not the HUD's.
    browser.values.set(recordKey!, '{"not":"a record"}');
    browser.writes.length = 0;
    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(false);
    expect(browser.values.get(recordKey!)).toBe('{"not":"a record"}');
    expect(browser.writes.filter((write) => write.endsWith(recordKey!))).toEqual([]);
  });

  it('writes nothing while it only reads', () => {
    const browser = page();
    browser.bridge.save(record());
    browser.writes.length = 0;
    const nudge = createArrivalNudge({ storage: browser.viewer });
    for (let index = 0; index < 3; index += 1) nudge.refresh();
    expect(browser.writes).toEqual([]);
  });

  it('follows the signed recipient when a wallet session binds an account (D-043)', () => {
    const browser = page();
    browser.bridge.save(record());
    let account: string | null | undefined = '0x0000123';
    const nudge = createArrivalNudge({ storage: browser.viewer, account: () => account });

    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(true);
    account = '0x456';
    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(false);
    account = null;
    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(false);
    // The demo composition has no wallet session to bind.
    account = undefined;
    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(true);
    // A mismatch hides the nudge but never discards a dismissal or the record.
    expect(browser.values.size).toBe(1);
  });

  it('survives storage that refuses every access', () => {
    const nudge = createArrivalNudge({
      storage: createViewerStorage(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    });
    expect(() => {
      nudge.refresh();
      nudge.dismiss();
    }).not.toThrow();
    expect(nudge.store.getState().waiting).toBe(false);
    expect(readSettledArrival(createViewerStorage(() => undefined))).toBeNull();
  });

  it('keeps a dismissal the browser refused to store for this page only', () => {
    const browser = page();
    browser.bridge.save(record());
    const refusing = createViewerStorage(() => ({
      getItem: (key) => browser.storage.getItem(key),
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: (key) => browser.storage.removeItem(key),
    }));
    const nudge = createArrivalNudge({ storage: refusing });
    nudge.refresh();
    nudge.dismiss();
    nudge.refresh();
    expect(nudge.store.getState().waiting).toBe(false);

    const nextVisit = createArrivalNudge({ storage: refusing });
    nextVisit.refresh();
    expect(nextVisit.store.getState().waiting).toBe(true);
  });
});
