import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type FakeDemoSwapRates } from './fake.js';
import type { Intent } from '../operations.js';

/**
 * Demo-mode degen swaps (D-067). The fake quotes a swap between two tokens
 * that carry an explicit DEMO rate, deterministically and by exact bigint
 * arithmetic. The rates here are fixtures, asserted so the demo stays
 * reproducible, never because they resemble any market price.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const LORDS = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
const DOG = '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4';
const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const ONE_STRK = 10n ** 18n;
const CEILING = 10n * ONE_STRK;

const RATES: FakeDemoSwapRates = {
  perStrk: {
    [STRK]: ONE_STRK,
    [LORDS]: 10n * 10n ** 18n, // 1 STRK counts as 10 LORDS in the demo
    [DOG]: 1_000n * 10n ** 5n, // 1 STRK counts as 1,000 DOG (5 decimals)
  },
  slippageBps: 50,
  expiresAt: 4_102_444_800_000,
};

function swap(tokenIn: string, tokenOut: string, amountIn: bigint, minAmountOut = 1n): Intent {
  return { kind: 'swap', tokenIn, tokenOut, amountIn, minAmountOut };
}

function fake(overrides: Partial<ConstructorParameters<typeof FakePrivacyOperations>[0]> = {}) {
  return new FakePrivacyOperations({
    balances: { [STRK]: 250n * ONE_STRK, [LORDS]: 50n * 10n ** 18n },
    demoSwapRates: RATES,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deterministic demo degen quotes', () => {
  it('quotes a rated pair from the explicit rates with AVNU\'s protected minimum', async () => {
    const batch = await fake().prepare([swap(STRK, LORDS, 10n * ONE_STRK)]);
    // 10 STRK × 10 LORDS/STRK = 100 LORDS; minimum = 100 − floor(100 × 50 / 10,000) LORDS.
    expect(batch.swapReview).toEqual({
      expectedAmountOut: 100n * 10n ** 18n,
      minimumAmountOut: 99_500000000000000000n,
      slippageBps: 50,
      expiresAt: 4_102_444_800_000,
      priceCheck: { status: 'checked', boundBps: 300, shortfallBps: 0, sellUsd: 0n, expectedBuyUsd: 0n },
    });
    expect(batch.intents).toEqual([swap(STRK, LORDS, 10n * ONE_STRK, 99_500000000000000000n)]);
  });

  it('floors across decimals in either direction, rated token to rated token', async () => {
    const toDog = await fake().prepare([swap(STRK, DOG, ONE_STRK)]);
    expect(toDog.swapReview).toMatchObject({ expectedAmountOut: 100_000_000n, minimumAmountOut: 99_500_000n });
    const lordsToDog = await fake().prepare([swap(LORDS, DOG, 3n * 10n ** 18n)]);
    // 3 LORDS = 0.3 STRK = 300 DOG.
    expect(lordsToDog.swapReview).toMatchObject({ expectedAmountOut: 30_000_000n });
    const back = await fake().prepare([swap(LORDS, STRK, 25n)]);
    // 25 base units of LORDS is 2.5 base units of STRK, floored to 2.
    expect(back.swapReview).toMatchObject({ expectedAmountOut: 2n, minimumAmountOut: 2n });
  });

  it('refuses a rated swap whose output rounds to nothing, rather than inventing one', async () => {
    await expect(fake({ swapReview: undefined }).prepare([swap(LORDS, DOG, 1n)]))
      .rejects.toMatchObject({ kind: 'unknown', message: 'The demo quote rounds to nothing for this amount.' });
  });

  it('gives byte-identical figures for the same inputs, and never reads the clock', async () => {
    const now = vi.spyOn(Date, 'now');
    const run = async () => {
      const operations = fake();
      const batch = await operations.prepare([swap(STRK, LORDS, 5n * ONE_STRK)]);
      const receipt = await batch.confirm({ feeCeiling: CEILING });
      return { review: batch.swapReview, intents: batch.intents, receipt, submitted: operations.submitted };
    };
    expect(await run()).toEqual(await run());
    expect(now).not.toHaveBeenCalled();
  });

  it('settles the protected minimum as a maturing note, like any swap', async () => {
    const operations = fake();
    const batch = await operations.prepare([swap(STRK, LORDS, 10n * ONE_STRK)]);
    await batch.confirm({ feeCeiling: CEILING });
    const [strk, lords] = await operations.balances([STRK, LORDS]);
    expect(strk!.spendable).toBe(250n * ONE_STRK - 10n * ONE_STRK - batch.totalCost);
    expect(lords).toMatchObject({ spendable: 50n * 10n ** 18n, maturing: 99_500000000000000000n });
  });

  it('refuses a requested floor above the protected minimum', async () => {
    await expect(fake().prepare([swap(STRK, LORDS, 10n * ONE_STRK, 99_500000000000000001n)]))
      .rejects.toMatchObject({ kind: 'unknown' });
  });

  it('leaves every other swap to the fixed review, or to no review at all', async () => {
    const fixed = { expectedAmountOut: 2n * ONE_STRK, slippageBps: 50, expiresAt: 4_102_444_800_000 };
    const withFixed = await fake({ swapReview: fixed }).prepare([swap(STRK, ETH, ONE_STRK)]);
    expect(withFixed.swapReview).toMatchObject({ expectedAmountOut: 2n * ONE_STRK });
    const rated = await fake({ swapReview: fixed }).prepare([swap(STRK, LORDS, ONE_STRK)]);
    expect(rated.swapReview).toMatchObject({ expectedAmountOut: 10n * 10n ** 18n });
    const none = await fake().prepare([swap(STRK, ETH, ONE_STRK)]);
    expect(none.swapReview).toBeUndefined();
  });

  it('owns the rates at construction', async () => {
    const perStrk: Record<string, bigint> = { [STRK]: ONE_STRK, [LORDS]: 10n * 10n ** 18n };
    const operations = fake({ demoSwapRates: { ...RATES, perStrk } });
    perStrk[LORDS] = 1n;
    const batch = await operations.prepare([swap(STRK, LORDS, ONE_STRK)]);
    expect(batch.swapReview?.expectedAmountOut).toBe(10n * 10n ** 18n);
  });

  it.each([
    ['an empty table', { ...RATES, perStrk: {} }],
    ['a zero rate', { ...RATES, perStrk: { [STRK]: ONE_STRK, [LORDS]: 0n } }],
    ['a negative rate', { ...RATES, perStrk: { [LORDS]: -1n } }],
    ['a number rate', { ...RATES, perStrk: { [LORDS]: 10 as unknown as bigint } }],
    ['an oversized rate', { ...RATES, perStrk: { [LORDS]: 1n << 128n } }],
    ['a malformed token', { ...RATES, perStrk: { 'not-a-token': ONE_STRK } }],
    ['a zero token', { ...RATES, perStrk: { '0x0': ONE_STRK } }],
    ['one token listed twice', { ...RATES, perStrk: { '0x0124': ONE_STRK, '0x124': 2n * ONE_STRK } }],
    ['no slippage', { ...RATES, slippageBps: 0 }],
    ['slippage over 100%', { ...RATES, slippageBps: 10_001 }],
    ['fractional slippage', { ...RATES, slippageBps: 1.5 }],
    ['no expiry', { ...RATES, expiresAt: 0 }],
    ['a fractional expiry', { ...RATES, expiresAt: 1.5 }],
  ] as const)('rejects %s atomically at construction', (_label, demoSwapRates) => {
    expect(() => fake({ demoSwapRates: demoSwapRates as FakeDemoSwapRates })).toThrow('The demo swap rates are invalid.');
  });

  it('never runs an accessor on the rates', () => {
    const read = vi.fn(() => ONE_STRK);
    const perStrk = {};
    Object.defineProperty(perStrk, LORDS, { get: read, enumerable: true });
    expect(() => fake({ demoSwapRates: { ...RATES, perStrk } })).toThrow('The demo swap rates are invalid.');
    expect(read).not.toHaveBeenCalled();
  });
});
