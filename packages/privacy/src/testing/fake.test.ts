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
      balances: { [usdc]: 5n, [STRK]: 6n + RELAY_FEE },
      registered: [BOB],
      poolConfig: { feeAmount: 6n },
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: usdc, amount: 5n, recipient: BOB },
    ]);

    await expect(batch.confirm({ feeCeiling: 6n + RELAY_FEE })).resolves.toBeDefined();
    await expect(ops.balances([usdc, STRK])).resolves.toEqual([
      expect.objectContaining({ token: usdc, spendable: 0n }),
      expect.objectContaining({ token: STRK, spendable: 0n }),
    ]);
  });
});

describe('the gas estimate varies with the batch shape', () => {
  // Anti-regression for the "green by construction" trap. The estimate used to
  // be a constant (`hasSpend ? 1e15 : 0`), so prepare(1) and prepare(5) were
  // indistinguishable and no test could catch a reserve or MAX taken from one
  // batch shape and then spent on another. If this ever goes back to a constant
  // these assertions fail.
  it('scales the gas estimate with the number of spend actions', async () => {
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

    expect(one.gasEstimate).toBe(RELAY_FEE);
    expect(five.gasEstimate).toBe(RELAY_FEE * 5n);
    expect(five.gasEstimate).not.toBe(one.gasEstimate);
    // The shape-dependent estimate is carried through to totalCost, not dropped.
    expect(one.totalCost).toBe(SIX_STRK + RELAY_FEE);
    expect(five.totalCost).toBe(SIX_STRK + RELAY_FEE * 5n);
  });

  it('charges no relay/gas for a shield-only batch', async () => {
    const ops = fresh(0n);
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 10n ** 18n }]);
    expect(batch.gasEstimate).toBe(0n);
  });

  it('weights a private swap heavier than a single transfer', async () => {
    const usdc = '0x1234';
    const ops = new FakePrivacyOperations({
      balances: { [usdc]: 10n * 10n ** 18n, [STRK]: 100n * 10n ** 18n },
    });
    const swap = await ops.prepare([
      { kind: 'swap', tokenIn: usdc, tokenOut: STRK, amountIn: 10n ** 18n, minAmountOut: 1n },
    ]);
    expect(swap.gasEstimate).toBe(RELAY_FEE * 2n);
  });
});

describe('deterministic prepared swap review', () => {
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
    expect(batch.totalCost).toBe(SIX_STRK + RELAY_FEE);
    await expect(batch.confirm({ feeCeiling: SIX_STRK })).rejects.toThrow(/ceiling/i);

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
});

describe('recipients must be registered', () => {
  it('blocks an unregistered recipient before proof generation', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: '0x0999' },
    ])).rejects.toMatchObject({ kind: 'not-registered' });
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
});

describe('fault injection', () => {
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

describe('balance query ownership', () => {
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
        spendable: 100n * 10n ** 18n - 10n ** 18n - SIX_STRK - RELAY_FEE,
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
