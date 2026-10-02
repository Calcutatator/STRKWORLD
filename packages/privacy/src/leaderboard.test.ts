import { describe, expect, it } from 'vitest';
import { hash, type STRK20_ACTION } from 'starknet';
import {
  LEADERBOARD_DAPP_NAME,
  ownHistogram,
  placementFrom,
  receiptInvokeAction,
  shadowCommitment,
  withLedgerTick,
  withReceipt,
  type LeaderboardHistogram,
} from './leaderboard.js';
import { shadowAccountAddress } from './vault.js';

const LEDGER = '0x123abc';
const PARTIAL = '0x5eed';

const histogram = (buckets: Array<[count: number, players: number]>): LeaderboardHistogram => ({
  season: 's1',
  total: buckets.reduce((sum, [, players]) => sum + players, 0),
  buckets: buckets.map(([count, players]) => ({ count, players })),
});

describe('the season and its receipts', () => {
  it('names a season-scoped Cairo short string', () => {
    expect(LEADERBOARD_DAPP_NAME).toBe('strkworld-lb-s1');
    expect(LEADERBOARD_DAPP_NAME.length).toBeLessThanOrEqual(31);
  });

  it('derives C = h(p, n), the same value that salts the shadow account', () => {
    const c = shadowCommitment(PARTIAL, 3n);
    expect(BigInt(c)).toBe(BigInt(hash.computePoseidonHashOnElements([PARTIAL, '0x3'])));
    const fromC = hash.calculateContractAddressFromHash(
      c,
      '0x00123e6bc1c14ae9934e933d3f64916a6116dd6b036a922b2b1f0815e0d1d300',
      [],
      '0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7',
    );
    expect(BigInt(fromC)).toBe(BigInt(shadowAccountAddress(PARTIAL, '0x3')));
  });

  it('builds the receipt: one shadow invoke at the nonce, ticking C_n on the ledger, collecting nothing', () => {
    expect(receiptInvokeAction({ ledger: '0x00000123abc', partialCommitment: PARTIAL, nonce: 4n })).toEqual({
      type: 'shadow_account_invoke',
      dapp_name: 'strkworld-lb-s1',
      nonce: '0x4',
      calls: [{ contractAddress: LEDGER, entrypoint: 'tick', calldata: [shadowCommitment(PARTIAL, 4n)] }],
      collect_policy: { type: 'exact', amount: '0x0' },
    });
  });

  it('refuses a bad ledger or nonce', () => {
    expect(() => receiptInvokeAction({ ledger: '0x0', partialCommitment: PARTIAL, nonce: 0n })).toThrow('Invalid ledger address.');
    expect(() => receiptInvokeAction({ ledger: LEDGER, partialCommitment: PARTIAL, nonce: -1n })).toThrow('Invalid receipt nonce.');
    expect(() => receiptInvokeAction({ ledger: LEDGER, partialCommitment: PARTIAL, nonce: 1024n })).toThrow('Invalid receipt nonce.');
  });

  it('puts the receipt last, and never beside another invoke (one external invoke per transaction)', () => {
    const receipt = receiptInvokeAction({ ledger: LEDGER, partialCommitment: PARTIAL, nonce: 0n });
    const send: STRK20_ACTION = { type: 'transfer', token: '0x1', amount: '0x5', recipient: '0x2' };
    expect(withReceipt([send], receipt)).toEqual([send, receipt]);
    const invoke: STRK20_ACTION = { type: 'invoke', contract: '0x9', calldata: [] };
    expect(() => withReceipt([invoke], receipt)).toThrow(/already invokes/);
    expect(() => withReceipt([receipt], receipt)).toThrow(/already invokes/);
  });

  it('appends the tick after the feature shadow\'s own calls and leaves every other action alone', () => {
    const built: STRK20_ACTION[] = [
      { type: 'withdraw', token: '0x1', amount: '0x5', recipient: '0x77' },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [{ contractAddress: '0x1', entrypoint: 'approve', calldata: ['0x2', '0x5', '0x0'] }],
        collect_policy: { type: 'exact', amount: '0x0' },
      },
    ];
    const snapshot = structuredClone(built);
    const ticked = withLedgerTick(built, LEDGER, '0x0abc');
    expect(ticked[0]).toBe(built[0]);
    expect(ticked[1]).toEqual({
      ...built[1],
      calls: [
        { contractAddress: '0x1', entrypoint: 'approve', calldata: ['0x2', '0x5', '0x0'] },
        { contractAddress: LEDGER, entrypoint: 'tick', calldata: ['0xabc'] },
      ],
    });
    // The input is untouched.
    expect(built).toEqual(snapshot);
    expect(() => withLedgerTick([built[0]!], LEDGER, '0xabc')).toThrow(/exactly one/);
    expect(() => withLedgerTick([...built, built[1]!], LEDGER, '0xabc')).toThrow(/exactly one/);
  });
});

describe('placement from the anonymous histogram', () => {
  it('ranks by players with strictly more receipts, ties sharing a rank', () => {
    const h = histogram([[1, 100], [3, 50], [5, 10], [9, 2]]);
    expect(placementFrom(h, 9, true)).toEqual({ rank: 1, total: 162, topPercent: 1 });
    expect(placementFrom(h, 5, true)).toEqual({ rank: 3, total: 162, topPercent: 2 });
    expect(placementFrom(h, 3, true)).toEqual({ rank: 13, total: 162, topPercent: 9 });
    expect(placementFrom(h, 1, true)).toEqual({ rank: 63, total: 162, topPercent: 39 });
  });

  it('gives the lead\'s example: 15 receipts, rank 37 of 310, top 12%', () => {
    const h = histogram([[1, 113], [2, 64], [3, 33], [5, 30], [8, 13], [12, 12], [15, 9], [19, 22], [27, 9], [41, 4], [66, 1]]);
    expect(placementFrom(h, 15, true)).toEqual({ rank: 37, total: 310, topPercent: 12 });
  });

  it('counts the viewer once more when their own entry is not in the histogram', () => {
    const h = histogram([[2, 3]]);
    expect(placementFrom(h, 4, false)).toEqual({ rank: 1, total: 4, topPercent: 25 });
    expect(placementFrom(histogram([]), 1, false)).toEqual({ rank: 1, total: 1, topPercent: 100 });
  });

  it('places nobody with zero receipts, and nobody in an empty histogram they are not in', () => {
    expect(placementFrom(histogram([[1, 5]]), 0, true)).toBeNull();
    expect(placementFrom(histogram([]), 3, true)).toBeNull();
  });

  it('never says worse than top 100% or better than top 1%', () => {
    expect(placementFrom(histogram([[1, 1000], [2, 1]]), 2, true)!.topPercent).toBe(1);
    expect(placementFrom(histogram([[1, 1], [2, 1]]), 1, true)!.topPercent).toBe(100);
  });
});

describe('reading a histogram strictly', () => {
  it('admits counts only, summing to the total', () => {
    expect(ownHistogram({ season: 's1', total: 3, buckets: [{ count: 1, players: 2 }, { count: 4, players: 1 }] }))
      .toEqual({ season: 's1', total: 3, buckets: [{ count: 1, players: 2 }, { count: 4, players: 1 }] });
  });

  it.each([
    ['a total that does not add up', { season: 's1', total: 4, buckets: [{ count: 1, players: 2 }] }],
    ['a zero count', { season: 's1', total: 2, buckets: [{ count: 0, players: 2 }] }],
    ['a fractional player count', { season: 's1', total: 1.5, buckets: [{ count: 1, players: 1.5 }] }],
    ['a missing season', { total: 0, buckets: [] }],
    ['not an object', 'histogram'],
    ['an accessor', Object.defineProperty({ season: 's1', buckets: [] }, 'total', { get: () => 0 })],
  ])('refuses %s', (_label, value) => {
    expect(ownHistogram(value)).toBeNull();
  });
});
