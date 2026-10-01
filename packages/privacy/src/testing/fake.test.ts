import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './fake.js';
import { PrivacyError } from '../types.js';
import type { BatchWarning, Intent } from '../operations.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ALICE = '0x0111';
const BOB = '0x0222';
const SIX_STRK = 6_000000000000000000n;
const RELAY_FEE = 1_000000000000000n;
const CEILING = 10_000000000000000000n;

function has(warnings: readonly BatchWarning[], kind: BatchWarning['kind']) {
  return warnings.some((w) => w.kind === kind);
}

function fresh(balance = 100n * 10n ** 18n) {
  return new FakePrivacyOperations({
    balances: { [STRK]: balance },
    registered: [ALICE, BOB],
  });
}

describe('fake construction ownership', () => {
  it('rejects an accessor-backed starting balance without invoking it', () => {
    let getterCalled = false;
    const balances = {} as Record<string, bigint>;
    Object.defineProperty(balances, STRK, {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error('balance getter must not run');
      },
    });

    expect(() => new FakePrivacyOperations({ balances })).toThrow(PrivacyError);
    expect(getterCalled).toBe(false);
  });
});

describe('fake lifecycle configuration', () => {
  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1'],
  ] as const)('rejects an invalid %s simulated latency', (_label, latencyMs) => {
    expect(() => new FakePrivacyOperations({ latencyMs: latencyMs as never }))
      .toThrow(/latency/i);
  });

  it.each([
    ['negative amount', { [STRK]: -1n }],
    ['number amount', { [STRK]: 1 }],
    ['malformed token', { 'not-a-felt': 1n }],
    ['zero token', { '0x0': 1n }],
  ] as const)('rejects a %s before publishing fake funds', (_label, balances) => {
    expect(() => new FakePrivacyOperations({ balances: balances as never }))
      .toThrow(/starting balance/i);
  });

  it.each([
    ['negative maturity', { noteMaturityBlocks: -1 }],
    ['fractional maturity', { noteMaturityBlocks: 1.5 }],
    ['unsafe maturity', { noteMaturityBlocks: Number.MAX_SAFE_INTEGER + 1 }],
    ['zero proof validity', { proofValidityBlocks: 0 }],
    ['fractional proof validity', { proofValidityBlocks: 1.5 }],
  ] as const)('rejects %s in pool config', (_label, poolConfig) => {
    expect(() => new FakePrivacyOperations({ poolConfig }))
      .toThrow(/pool config/i);
  });

  it.each([
    ['malformed', 'not-a-felt'],
    ['zero', '0x0'],
    ['negative', '-1'],
    ['decimal', '273'],
    ['field-prime', `0x${((1n << 251n) + 17n * (1n << 192n) + 1n).toString(16)}`],
  ] as const)('rejects a %s registered recipient as a privacy configuration error', (_label, recipient) => {
    expect(() => new FakePrivacyOperations({ registered: [recipient] }))
      .toThrow(PrivacyError);
  });

  it.each([
    ['non-boolean support', { supportsStrk20: 'yes' }],
    ['non-string version', { walletApiVersion: 103 }],
    ['invalid registration', { registration: 'connected' }],
  ] as const)('rejects %s before publishing capability state', (_label, capability) => {
    expect(() => new FakePrivacyOperations({ capability: capability as never }))
      .toThrow(/capability/i);
  });

  it('allows a null wallet API version for unsupported capability', async () => {
    const ops = new FakePrivacyOperations({
      capability: { supportsStrk20: false, walletApiVersion: null, registration: 'unknown' },
    });
    await expect(ops.capability()).resolves.toMatchObject({
      supportsStrk20: false,
      walletApiVersion: null,
      registration: 'unknown',
    });
  });

  it.each([
    ['negative fee amount', { feeAmount: -1n }],
    ['number fee amount', { feeAmount: 1 }],
    ['malformed fee token', { feeToken: 'not-a-felt' }],
    ['zero fee token', { feeToken: '0x0' }],
  ] as const)('rejects a %s before publishing pool state', (_label, poolConfig) => {
    expect(() => new FakePrivacyOperations({ poolConfig: poolConfig as never }))
      .toThrow(/pool fee/i);
  });
});

describe('the fee comes out of the balance being spent', () => {
  it('rejects a spend that cannot also cover the pool fee', async () => {
    // Exactly enough for the transfer, nothing left for the 6 STRK fee.
    const ops = new FakePrivacyOperations({ balances: { [STRK]: 10n ** 18n }, registered: [BOB] });
    await expect(
      ops.prepare([{ kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB }]),
    ).rejects.toThrow(PrivacyError);
  });

  it('warns when confirming would strand the player below a future fee', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: SIX_STRK + SIX_STRK + 10n ** 18n + RELAY_FEE },
      registered: [BOB],
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n + SIX_STRK, recipient: BOB },
    ]);
    expect(has(batch.warnings, 'leaves-below-fee')).toBe(true);
  });

  it('charges a different operation token and the STRK pool fee independently', async () => {
    const usdc = '0x1234';
    const ops = new FakePrivacyOperations({
      balances: { [usdc]: 5n, [STRK]: 6n },
      registered: [BOB],
      poolConfig: { feeAmount: 6n },
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: usdc, amount: 5n, recipient: BOB },
    ]);

    await expect(batch.confirm({ feeCeiling: 6n })).resolves.toBeDefined();
    await expect(ops.balances([usdc, STRK])).resolves.toEqual([
      expect.objectContaining({ token: usdc, spendable: 0n }),
      expect.objectContaining({ token: STRK, spendable: 0n }),
    ]);
  });
});

describe('the gas estimate follows the route (D-082, D-084)', () => {
  // Nothing is relayed: every route, the swap included, is wallet-submitted,
  // and the wallet prices its own network fee.
  it('reports no relay estimate for a wallet-submitted spend, whatever the batch shape (D-082)', async () => {
    const ops = fresh();
    const one = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    const five = await ops.prepare(
      Array.from({ length: 5 }, () => ({
        kind: 'transfer' as const,
        token: STRK,
        amount: 10n ** 18n,
        recipient: BOB,
      })),
    );

    // The wallet adds and prices its own network fee, so the seam reports none.
    expect(one.gasEstimate).toBe(0n);
    expect(five.gasEstimate).toBe(0n);
    expect(one.totalCost).toBe(SIX_STRK);
    expect(five.totalCost).toBe(SIX_STRK);
  });

  it('charges no relay/gas for a shield-only batch', async () => {
    const ops = fresh(0n);
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 10n ** 18n }]);
    expect(batch.gasEstimate).toBe(0n);
  });

  it('reports no relay estimate for a swap, which the wallet submits through a shadow account (D-084)', async () => {
    const usdc = '0x1234';
    const ops = new FakePrivacyOperations({
      balances: { [usdc]: 10n * 10n ** 18n, [STRK]: 100n * 10n ** 18n },
    });
    const swap = await ops.prepare([
      { kind: 'swap', tokenIn: usdc, tokenOut: STRK, amountIn: 10n ** 18n, minAmountOut: 1n },
    ]);
    expect(swap.gasEstimate).toBe(0n);
    expect(swap.totalCost).toBe(SIX_STRK);
  });

  it('refuses a swap from a wallet without shadow accounts, as the adapter does (D-084)', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      capability: { supportsShadowAccounts: false },
    });
    await expect(ops.prepare([
      { kind: 'swap', tokenIn: STRK, tokenOut: '0x1234', amountIn: 10n ** 18n, minAmountOut: 1n },
    ])).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
  });

  it('needs the acknowledgement to confirm a swap reviewed as unchecked, as the adapter does (D-084)', async () => {
    const usdc = '0x1234';
    const make = () => new FakePrivacyOperations({
      balances: { [usdc]: 10n * 10n ** 18n, [STRK]: 100n * 10n ** 18n },
      swapReview: { expectedAmountOut: 10_000n, slippageBps: 100, expiresAt: 1_000, priceCheck: { status: 'unchecked', boundBps: 300 } },
    });
    const intent = { kind: 'swap', tokenIn: usdc, tokenOut: STRK, amountIn: 10n ** 18n, minAmountOut: 1n } as const;
    const refused = await make().prepare([intent]);
    expect(refused.swapReview?.priceCheck).toEqual({ status: 'unchecked', boundBps: 300 });
    await expect(refused.confirm({ feeCeiling: SIX_STRK })).rejects.toThrow(/no independent price check/);
    const acknowledged = await make().prepare([intent]);
    await expect(acknowledged.confirm({ feeCeiling: SIX_STRK, acknowledgeUncheckedPrice: true })).resolves.toMatchObject({ transactionHash: expect.any(String) });
  });

  it('quotes the next swap from what setSwapQuote says, as a re-quote would (D-084)', async () => {
    const usdc = '0x1234';
    const ops = new FakePrivacyOperations({
      balances: { [usdc]: 10n * 10n ** 18n, [STRK]: 100n * 10n ** 18n },
      swapReview: { expectedAmountOut: 10_000n, slippageBps: 100, expiresAt: 1_000 },
    });
    const intent = { kind: 'swap', tokenIn: usdc, tokenOut: STRK, amountIn: 10n ** 18n, minAmountOut: 1n } as const;
    expect((await ops.prepare([intent])).swapReview).toMatchObject({ minimumAmountOut: 9_900n, expiresAt: 1_000 });
    ops.setSwapQuote({ swapReview: { expectedAmountOut: 9_000n, slippageBps: 100, expiresAt: 5_000 } });
    expect((await ops.prepare([intent])).swapReview).toMatchObject({ minimumAmountOut: 8_910n, expiresAt: 5_000 });
    expect(() => ops.setSwapQuote({ swapReview: { expectedAmountOut: 0n, slippageBps: 100, expiresAt: 5_000 } }))
      .toThrow(/swap review/i);
  });

  it("floors the swap at the player's own slippage when the intent carries one, as the adapter does (D-090)", async () => {
    const usdc = '0x1234';
    const ops = new FakePrivacyOperations({
      balances: { [usdc]: 10n * 10n ** 18n, [STRK]: 100n * 10n ** 18n },
      swapReview: { expectedAmountOut: 10_000n, slippageBps: 100, expiresAt: 1_000 },
    });
    const intent = { kind: 'swap', tokenIn: usdc, tokenOut: STRK, amountIn: 10n ** 18n, minAmountOut: 1n, slippageBps: 30 } as const;
    expect((await ops.prepare([intent])).swapReview).toMatchObject({ slippageBps: 30, minimumAmountOut: 9_970n });
    await expect(ops.prepare([{ ...intent, slippageBps: 301 }])).rejects.toThrow(/slippage is outside/);
  });
});

describe('deterministic prepared swap review', () => {
  it.each([
    ['nonpositive expected output', { expectedAmountOut: 0n, expiresAt: 2_000, slippageBps: 333 }],
    ['invalid slippage', { expectedAmountOut: 101n, expiresAt: 2_000, slippageBps: 10_001 }],
    ['invalid expiry', { expectedAmountOut: 101n, expiresAt: 0, slippageBps: 333 }],
  ] as const)('rejects %s atomically at fake construction', (_label, swapReview) => {
    expect(() => new FakePrivacyOperations({ swapReview }))
      .toThrow(/swap review/i);
  });

  it('owns configured swap review inputs before caller mutation', async () => {
    const review = { expectedAmountOut: 101n, expiresAt: 2_000, slippageBps: 333 };
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n, ['0x1234']: 100n * 10n ** 18n },
      swapReview: review,
    });

    review.expectedAmountOut = 1_000n;
    review.slippageBps = 9_000;
    review.expiresAt = 9_999;

    const batch = await ops.prepare([
      { kind: 'swap', tokenIn: '0x1234', tokenOut: STRK, amountIn: 20n, minAmountOut: 1n },
    ]);
    expect(batch.swapReview).toEqual({
      expectedAmountOut: 101n,
      minimumAmountOut: 98n,
      slippageBps: 333,
      expiresAt: 2_000,
      priceCheck: { status: 'checked', boundBps: 300, shortfallBps: 0, sellUsd: 0n, expectedBuyUsd: 0n },
    });
  });

  it('uses only explicit review inputs and derives minimum output from the intent', async () => {
    const make = async () => {
      const ops = new FakePrivacyOperations({
        balances: { [STRK]: 100n * 10n ** 18n, ['0x1234']: 100n * 10n ** 18n },
        swapReview: { expectedAmountOut: 101n, expiresAt: 2_000, slippageBps: 333 },
      });
      const batch = await ops.prepare([
        { kind: 'swap', tokenIn: '0x1234', tokenOut: STRK, amountIn: 20n, minAmountOut: 1n },
      ]);
      return { review: batch.swapReview, intent: batch.intents[0] };
    };

    await expect(make()).resolves.toEqual({
      review: {
        expectedAmountOut: 101n,
        minimumAmountOut: 98n,
        slippageBps: 333,
        expiresAt: 2_000,
        priceCheck: { status: 'checked', boundBps: 300, shortfallBps: 0, sellUsd: 0n, expectedBuyUsd: 0n },
      },
      intent: {
        kind: 'swap', tokenIn: '0x1234', tokenOut: STRK, amountIn: 20n, minAmountOut: 98n,
      },
    });
    await expect(make()).resolves.toEqual(await make());
  });

  it('does not invent review data when no explicit swap review is configured', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n, ['0x1234']: 100n * 10n ** 18n },
    });
    const batch = await ops.prepare([
      { kind: 'swap', tokenIn: '0x1234', tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ]);
    expect(batch.swapReview).toBeUndefined();
  });
});

describe('shielded funds are not immediately spendable', () => {
  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects a %s block advance without moving chain state', (_label, blocks) => {
    const ops = fresh();

    expect(() => ops.advanceBlocks(blocks)).toThrow(/block advance/i);
    expect(ops.currentBlock).toBe(0);
  });

  it('holds a deposit as maturing until enough blocks pass', async () => {
    const ops = fresh(0n);
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 50n * 10n ** 18n }]);
    await batch.confirm({ feeCeiling: CEILING });

    let [strk] = await ops.balances([STRK]);
    expect(strk!.spendable).toBe(0n);
    expect(strk!.maturing).toBe(50n * 10n ** 18n);

    ops.advanceBlocks(9);
    [strk] = await ops.balances([STRK]);
    expect(strk!.spendable).toBe(0n);

    ops.advanceBlocks(1); // 10 blocks — matured
    [strk] = await ops.balances([STRK]);
    expect(strk!.spendable).toBe(50n * 10n ** 18n);
    expect(strk!.maturing).toBe(0n);
  });

  it('warns that funds are still maturing', async () => {
    const ops = fresh();
    await (await ops.prepare([{ kind: 'shield', token: STRK, amount: 1n }])).confirm({
      feeCeiling: CEILING,
    });
    const next = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(has(next.warnings, 'funds-maturing')).toBe(true);
  });

  it('counts only the fee token in the maturing warning, never base units of another token (D-072)', async () => {
    const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
    const ops = fresh();
    await (await ops.prepare([{ kind: 'shield', token: USDC, amount: 5_000000n }])).confirm({ feeCeiling: CEILING });
    const onlyUsdc = await ops.prepare([{ kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB }]);
    expect(has(onlyUsdc.warnings, 'funds-maturing')).toBe(false);
    onlyUsdc.discard();

    await (await ops.prepare([{ kind: 'shield', token: STRK, amount: 7n }])).confirm({ feeCeiling: CEILING });
    const both = await ops.prepare([{ kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB }]);
    expect(both.warnings.find((warning) => warning.kind === 'funds-maturing')).toMatchObject({ maturingAmount: 7n });
  });
});

describe('a shield is never bundled with what it funds', () => {
  it('rejects the mixed batch so the shell sequences two explicit operations', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'shield', token: STRK, amount: 10n * 10n ** 18n },
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ])).rejects.toMatchObject({ kind: 'privacy-leak' });
  });

  it('matches production by rejecting mixed private route kinds', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
      { kind: 'unshield', token: STRK, amount: 10n ** 18n, recipient: ALICE },
    ])).rejects.toThrow(/one approved route/i);
  });

  it('models the shipped wallet source as one batched shield action', async () => {
    const ops = fresh();
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 10n ** 18n }]);
    expect(batch.promptCount).toBe(1);
  });

  it('needs one prompt for a batch of private-side actions', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: ALICE },
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(batch.promptCount).toBe(1);
  });
});

describe('the fee can move between prepare and confirm', () => {
  it.each([
    ['negative bigint', -1n],
    ['number', 1],
    ['string', '1'],
  ] as const)('rejects an invalid %s pool fee without changing confirmation cost', async (_label, fee) => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);

    expect(() => ops.setPoolFee(fee as never)).toThrow(/pool fee/i);
    await expect(batch.confirm({ feeCeiling: batch.totalCost })).resolves.toBeDefined();
    const [balance] = await ops.balances([STRK]);
    expect(balance?.spendable).toBe(100n * 10n ** 18n - 10n ** 18n - batch.totalCost);
  });

  it.each([
    ['negative bigint', -1n],
    ['number', 10],
    ['string', '10'],
  ] as const)('rejects an invalid %s fee ceiling before consuming confirmation state', async (_label, feeCeiling) => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    ops.injectFault({ kind: 'unreachable', on: 'confirm' });

    await expect(batch.confirm({ feeCeiling: feeCeiling as never })).rejects.toMatchObject({
      kind: 'unknown',
    });
    await expect(batch.confirm({ feeCeiling: CEILING })).rejects.toMatchObject({
      kind: 'unreachable',
    });
    expect(ops.submitted).toHaveLength(0);
  });

  it('guards and charges the whole private fee quoted in totalCost', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(batch.totalCost).toBe(SIX_STRK);
    await expect(batch.confirm({ feeCeiling: SIX_STRK - 1n })).rejects.toThrow(/ceiling/i);

    const retry = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    await retry.confirm({ feeCeiling: retry.totalCost });
    const [balance] = await ops.balances([STRK]);
    expect(balance?.spendable).toBe(100n * 10n ** 18n - 10n ** 18n - retry.totalCost);
  });

  it('refuses to sign when the fee breaches the ceiling', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(batch.poolFee).toBe(SIX_STRK);

    ops.setPoolFee(20n * 10n ** 18n); // governance moved it

    await expect(batch.confirm({ feeCeiling: CEILING })).rejects.toThrow(/above the ceiling/);
    expect(ops.submitted).toHaveLength(0);
  });

  it('allows exactly one confirmation attempt', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);

    await batch.confirm({ feeCeiling: CEILING });
    await expect(batch.confirm({ feeCeiling: CEILING })).rejects.toThrow(/already confirmed/i);
    expect(ops.submitted).toHaveLength(1);
  });

  it('does not let a throwing progress observer interrupt the simulated submission', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);

    await expect(batch.confirm({
      feeCeiling: CEILING,
      onProgress: () => { throw new Error('render observer failed'); },
    })).resolves.toBeDefined();
    expect(ops.submitted).toHaveLength(1);
  });

  it('publishes immutable simulated progress snapshots', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    const progress: Array<{ stage: string; message: string }> = [];

    await batch.confirm({
      feeCeiling: CEILING,
      onProgress(update) { progress.push(update); },
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(progress[0]!, 'message', 'forged')).toBe(false);
  });

  it('does not settle a batch discarded while fake confirmation is pending', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      registered: [BOB],
      latencyMs: 1,
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);

    const confirming = batch.confirm({ feeCeiling: CEILING });
    batch.discard();

    await expect(confirming).rejects.toMatchObject({ kind: 'unknown' });
    expect(ops.submitted).toEqual([]);
    await expect(ops.balances([STRK])).resolves.toEqual([
      expect.objectContaining({ spendable: 100n * 10n ** 18n }),
    ]);
  });
});

describe('invalid fake intents', () => {
  it('rejects non-positive amounts before mutating balances', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: -1n, recipient: BOB },
    ])).rejects.toThrow(/positive/i);
    expect(ops.submitted).toHaveLength(0);
  });

  it.each([
    ['decimal token', { kind: 'shield', token: '123', amount: 1n }],
    ['zero token', { kind: 'shield', token: '0x0', amount: 1n }],
    ['field-prime token', {
      kind: 'shield',
      token: `0x${((1n << 251n) + 17n * (1n << 192n) + 1n).toString(16)}`,
      amount: 1n,
    }],
    ['decimal recipient', { kind: 'unshield', token: STRK, amount: 1n, recipient: '273' }],
  ] as const)('rejects a malformed %s before publishing a batch', async (_label, intent) => {
    const ops = fresh();

    await expect(ops.prepare([intent as Intent])).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('recipients must be registered', () => {
  it('blocks an unregistered recipient before proof generation, as the recipient\'s fact (D-074)', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: '0x0999' },
    ])).rejects.toMatchObject({ kind: 'recipient-not-registered' });
    expect(ops.submitted).toHaveLength(0);
  });

  it('reports unregistered addresses from the preflight', async () => {
    const ops = fresh();
    expect(await ops.recipientStatus(BOB)).toBe('registered');
    expect(await ops.recipientStatus('0x0999')).toBe('unregistered');
  });

  it('compares addresses padding-tolerantly', async () => {
    const ops = new FakePrivacyOperations({ registered: ['0x0222'] });
    expect(await ops.recipientStatus('0x222')).toBe('registered');
    expect(await ops.recipientStatus('0x0000222')).toBe('registered');
  });

  it.each([
    ['decimal', '546'],
    ['zero', '0x0'],
    ['negative', '-1'],
    ['field-prime', `0x${((1n << 251n) + 17n * (1n << 192n) + 1n).toString(16)}`],
  ])('rejects a malformed %s recipient like production', async (_label, recipient) => {
    const ops = fresh();

    await expect(ops.recipientStatus(recipient)).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('fault injection', () => {
  it('owns an injected fault before caller mutation can retarget it', async () => {
    const ops = fresh();
    const fault = { kind: 'unreachable' as const, on: 'balances' as const };
    ops.injectFault(fault);

    (fault as { kind: string; on: string }).kind = 'not-registered';
    (fault as { kind: string; on: string }).on = 'prepare';

    await expect(ops.balances()).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: 1n, recipient: BOB },
    ])).resolves.toBeDefined();
  });

  it('raises the requested error kind on the targeted method', async () => {
    const ops = fresh();
    ops.injectFault({ kind: 'not-registered', on: 'prepare' });
    await expect(
      ops.prepare([{ kind: 'transfer', token: STRK, amount: 1n, recipient: BOB }]),
    ).rejects.toMatchObject({ kind: 'not-registered' });
  });

  it('consumes a non-sticky fault after one use', async () => {
    const ops = fresh();
    ops.injectFault({ kind: 'unreachable', on: 'balances' });
    await expect(ops.balances()).rejects.toThrow();
    await expect(ops.balances()).resolves.toBeDefined();
  });

  it('keeps a sticky fault', async () => {
    const ops = fresh();
    ops.injectFault({ kind: 'unsupported-wallet', on: 'capability', sticky: true });
    await expect(ops.capability()).rejects.toThrow();
    await expect(ops.capability()).rejects.toThrow();
  });
});

describe('cancellation', () => {
  it('rejects an aborted call', async () => {
    const ops = fresh();
    const controller = new AbortController();
    controller.abort();
    await expect(ops.balances(undefined, controller.signal)).rejects.toMatchObject({
      kind: 'user-rejected',
    });
  });
});

describe('published capability ownership', () => {
  it('publishes an immutable simulated capability snapshot', async () => {
    const ops = fresh();

    const capability = await ops.capability();

    expect(Object.isFrozen(capability)).toBe(true);
    expect(Reflect.set(capability, 'registration', 'unregistered')).toBe(false);
    expect(capability.registration).toBe('registered');
  });
});

describe('published pool configuration ownership', () => {
  it('publishes an immutable simulated pool snapshot', async () => {
    const ops = fresh();

    const pool = await ops.poolConfig();

    expect(Object.isFrozen(pool)).toBe(true);
    expect(Reflect.set(pool, 'feeAmount', 0n)).toBe(false);
    expect((await ops.poolConfig()).feeAmount).toBe(SIX_STRK);
  });
});

describe('balance query ownership', () => {
  it('publishes immutable simulated balance snapshots', async () => {
    const ops = fresh();

    const balances = await ops.balances([STRK]);

    expect(Object.isFrozen(balances)).toBe(true);
    expect(balances.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(balances[0]!, 'total', 0n)).toBe(false);
  });

  it('snapshots requested tokens before the fake latency boundary', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: 100n, ['0x1234']: 50n },
      latencyMs: 1,
    });
    const requested = [STRK];

    const reading = ops.balances(requested);
    requested[0] = '0x1234';
    requested.push('0x9999');

    await expect(reading).resolves.toEqual([{
      token: STRK,
      spendable: 100n,
      maturing: 0n,
      total: 100n,
      maturityKnown: true,
    }]);
  });
});

describe('the fake owns its prepared intents too', () => {
  /**
   * The double is what the Shell and World lanes build against, so a
   * permissiveness the real implementation does not share is worse than the
   * defect itself: consumer suites go green against behaviour that cannot
   * happen in production. See the matching real-seam cases in
   * `wallet-api/prepared-batch-binding.test.ts`.
   */
  it('records and debits the reviewed amount after the published intent is written to', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);

    expect(Object.isFrozen(batch.intents)).toBe(true);
    expect(Reflect.set(batch.intents[0]!, 'amount', 90n * 10n ** 18n)).toBe(false);
    await batch.confirm({ feeCeiling: CEILING });

    expect(ops.submitted).toEqual([[
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]]);
    await expect(ops.balances([STRK])).resolves.toEqual([
      expect.objectContaining({
        token: STRK,
        spendable: 100n * 10n ** 18n - 10n ** 18n - SIX_STRK,
      }),
    ]);
  });

  it('ignores an intent appended to the caller array after prepare', async () => {
    const ops = fresh();
    const mine: Intent[] = [{ kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB }];
    const batch = await ops.prepare(mine);

    mine.push({ kind: 'unshield', token: STRK, amount: 5n, recipient: BOB });
    await batch.confirm({ feeCeiling: CEILING });

    expect(ops.submitted[0]).toHaveLength(1);
  });

  it('publishes immutable warnings like the production implementation', async () => {
    const ops = fresh(0n);
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 1n }]);

    expect(Object.isFrozen(batch.warnings)).toBe(true);
    expect(Object.isFrozen(batch.warnings[0])).toBe(true);
    expect(Reflect.deleteProperty(batch.warnings, '0')).toBe(false);
    expect(Reflect.set(batch.warnings[0]!, 'detail', 'private')).toBe(false);
    expect(batch.warnings).toEqual([{
      kind: 'public-leg',
      detail: 'Depositing 1 is public: the amount and your address are visible on-chain.',
    }]);
  });

  it('publishes an immutable deterministic swap review like production', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n, ['0x1234']: 100n * 10n ** 18n },
      swapReview: { expectedAmountOut: 101n, expiresAt: 2_000, slippageBps: 333 },
    });
    const batch = await ops.prepare([
      { kind: 'swap', tokenIn: '0x1234', tokenOut: STRK, amountIn: 20n, minAmountOut: 1n },
    ]);

    expect(Object.isFrozen(batch.swapReview)).toBe(true);
    expect(Reflect.set(batch.swapReview!, 'minimumAmountOut', 1n)).toBe(false);
    expect(batch.swapReview).toEqual({
      expectedAmountOut: 101n,
      minimumAmountOut: 98n,
      slippageBps: 333,
      expiresAt: 2_000,
      priceCheck: { status: 'checked', boundBps: 300, shortfallBps: 0, sellUsd: 0n, expectedBuyUsd: 0n },
    });
  });

  /**
   * Taking the snapshot after the first `await` is not taking it at all.
   *
   * `tick()` is async, so awaiting it yields a microtask even at zero latency,
   * and a caller that mutates its own array between the unawaited `prepare()`
   * call and the settled promise wins that race. The real implementation
   * captures synchronously — `throwIfAborted` does not await — so a double
   * that captures later grants a freedom production does not, which is the
   * whole failure mode this suite exists to prevent.
   */
  it('snapshots synchronously, so a mutation cannot race the pending prepare', async () => {
    const ops = fresh();
    // Held at the narrow variant so the race writes the same object the caller
    // handed to `prepare`, without an `Intent`-union cast to hide behind.
    const shield: Extract<Intent, { kind: 'shield' }> = { kind: 'shield', token: STRK, amount: 1n };
    const mine: Intent[] = [shield];

    const preparing = ops.prepare(mine);
    shield.amount = 90n * 10n ** 18n;
    const batch = await preparing;

    expect(batch.intents).toEqual([{ kind: 'shield', token: STRK, amount: 1n }]);
    expect(batch.warnings).toEqual([{
      kind: 'public-leg',
      detail: 'Depositing 1 is public: the amount and your address are visible on-chain.',
    }]);

    await batch.confirm({ feeCeiling: CEILING });
    expect(ops.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 1n }]]);
  });
});

describe('determinism', () => {
  it('produces identical results across runs', async () => {
    const run = async () => {
      const ops = fresh();
      const batch = await ops.prepare([
        { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
      ]);
      const result = await batch.confirm({ feeCeiling: CEILING });
      return { hash: result.transactionHash, balances: await ops.balances([STRK]) };
    };
    expect(await run()).toEqual(await run());
  });
});

describe('the D-072 entry reads', () => {
  const shield = (amount = 5n * 10n ** 18n): Intent => ({ kind: 'shield', token: STRK, amount });

  it('starts fresh with nothing in the pool, and funded when given a balance', async () => {
    await expect(new FakePrivacyOperations().hasPrivateFunds()).resolves.toBe(false);
    await expect(new FakePrivacyOperations({ balances: { [STRK]: 0n } }).hasPrivateFunds()).resolves.toBe(false);
    await expect(new FakePrivacyOperations({ balances: { [STRK]: 1n } }).hasPrivateFunds()).resolves.toBe(true);
  });

  it('counts maturing funds, so a fresh deposit is enough', async () => {
    const fake = new FakePrivacyOperations();
    const batch = await fake.prepare([shield()]);
    await batch.confirm({ feeCeiling: CEILING });
    const [balance] = await fake.balances([STRK]);
    expect(balance).toMatchObject({ spendable: 0n, maturing: 5n * 10n ** 18n });
    await expect(fake.hasPrivateFunds()).resolves.toBe(true);
  });

  it('is one balance read, so a balances fault reaches it', async () => {
    const fake = fresh();
    fake.injectFault({ kind: 'not-registered', on: 'balances' });
    await expect(fake.hasPrivateFunds()).rejects.toMatchObject({ kind: 'not-registered' });
    await expect(fake.hasPrivateFunds()).resolves.toBe(true);
  });

  it('lands each shield it confirms, and says a spend carries no deposit', async () => {
    const fake = fresh();
    const { transactionHash: shielded } = await (await fake.prepare([shield()])).confirm({ feeCeiling: CEILING });
    const { transactionHash: sent } = await (await fake.prepare([
      { kind: 'transfer', token: STRK, amount: 1n, recipient: ALICE },
    ])).confirm({ feeCeiling: CEILING });

    await expect(fake.depositStatus(shielded)).resolves.toBe('landed');
    await expect(fake.depositStatus(sent)).resolves.toBe('failed');
    await expect(fake.depositStatus('0x5eed')).resolves.toBe('pending');
  });

  it('can hold a deposit pending, land it later, or fail it', async () => {
    const fake = new FakePrivacyOperations({ deposits: 'pending' });
    const { transactionHash } = await (await fake.prepare([shield()])).confirm({ feeCeiling: CEILING });
    await expect(fake.depositStatus(transactionHash)).resolves.toBe('pending');
    fake.setDepositStatus(transactionHash, 'landed');
    await expect(fake.depositStatus(transactionHash)).resolves.toBe('landed');
    fake.setDepositStatus(transactionHash, 'failed');
    await expect(fake.depositStatus(transactionHash)).resolves.toBe('failed');

    expect(() => fake.setDepositStatus('0x5eed', 'landed')).toThrow(PrivacyError);
    expect(() => fake.setDepositStatus(transactionHash, 'maybe' as never)).toThrow(PrivacyError);
    expect(() => new FakePrivacyOperations({ deposits: 'maybe' as never })).toThrow(/deposit status/);
  });

  it('raises an injected depositStatus fault once', async () => {
    const fake = fresh();
    fake.injectFault({ kind: 'unreachable', on: 'depositStatus' });
    await expect(fake.depositStatus('0x5eed')).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(fake.depositStatus('0x5eed')).resolves.toBe('pending');
  });

  it('warns once per shield, in intent order, as the Wallet API adapter does', async () => {
    const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
    const batch = await new FakePrivacyOperations().prepare([shield(5n), { kind: 'shield', token: USDC, amount: 7n }]);
    expect(batch.warnings).toEqual([
      { kind: 'public-leg', detail: expect.stringMatching(/^Depositing 5 is public/) },
      { kind: 'public-leg', detail: expect.stringMatching(/^Depositing 7 is public/) },
    ]);
  });

  it('makes a note spendable at once when the maturity window is zero blocks', async () => {
    const fake = new FakePrivacyOperations({ poolConfig: { noteMaturityBlocks: 0 } });
    await (await fake.prepare([shield()])).confirm({ feeCeiling: CEILING });
    const [balance] = await fake.balances([STRK]);
    expect(balance).toMatchObject({ spendable: 5n * 10n ** 18n, maturing: 0n, total: 5n * 10n ** 18n });
  });
});
