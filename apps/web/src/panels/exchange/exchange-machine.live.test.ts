import { describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, PrivacyError, type PreparedBatch } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import {
  LIVE_QUOTE_BUDGET, LIVE_QUOTE_DELAY_MS, QUOTE_SPACING_MS, canFlip, createExchangePanel, parseSlippage,
} from './exchange-machine.js';

/**
 * D-089: the Exchange's live quote and slippage cog. The Buy side is filled
 * while the player types, never faster than the counter's spacing and budget
 * allow; a Review press takes the live quote as is, and the slippage the
 * player chose is the one the swap is quoted and floored at.
 */

const [strk, eth] = EXCHANGE_CATALOG;
const ONE = 10n ** 18n;
const FAR = 4_102_444_800_000;

function harness(options: {
  balances?: Record<string, bigint>;
  expiresAt?: number;
  spacing?: number;
  slippageCeilingBps?: number;
  allowed?: () => boolean;
} = {}) {
  let current = 1_000;
  const waits: Array<{ ms: number; release: () => void }> = [];
  const operations = new FakePrivacyOperations({
    balances: options.balances ?? { [strk!.token]: 100n * ONE },
    swapReview: { expectedAmountOut: 2n * ONE, slippageBps: 50, expiresAt: options.expiresAt ?? FAR },
  });
  const real = operations.prepare.bind(operations);
  const prepare = vi.spyOn(operations, 'prepare');
  const machine = createExchangePanel({
    operations, receipts: createReceiptLedger(), canStartFinancialAction: options.allowed ?? (() => true),
    now: () => current,
    quoteSpacingMs: options.spacing ?? QUOTE_SPACING_MS,
    liveQuoteDelayMs: LIVE_QUOTE_DELAY_MS,
    ...(options.slippageCeilingBps !== undefined ? { slippageCeilingBps: options.slippageCeilingBps } : {}),
    sleep: (ms) => new Promise<void>((resolve) => { waits.push({ ms, release: resolve }); }),
  });
  /** Let the fake's and the machine's promise chains run. */
  const flush = async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    machine, operations, prepare, real, waits, flush,
    advance(ms: number) { current += ms; },
    /** Release every short wait (the typing delay and the spacing), never the quote's expiry. */
    async release() {
      const short = waits.filter((wait) => wait.ms <= QUOTE_SPACING_MS);
      waits.splice(0, waits.length, ...waits.filter((wait) => wait.ms > QUOTE_SPACING_MS));
      short.forEach((wait) => wait.release());
      await flush();
    },
    async open() {
      await machine.open();
      await machine.refreshBalances();
    },
  };
}

describe('the live quote (D-089)', () => {
  it('asks once, after the player stops typing, and the Buy side shows its figures', async () => {
    const { machine, prepare, release, open, waits } = harness();
    await open();
    machine.setAmount('1');
    machine.setAmount('1.5');
    machine.setAmount('2');
    expect(machine.store.getState().live).toEqual({ status: 'quoting' });
    expect(waits.map(({ ms }) => ms)).toEqual([LIVE_QUOTE_DELAY_MS, LIVE_QUOTE_DELAY_MS, LIVE_QUOTE_DELAY_MS]);
    expect(prepare).not.toHaveBeenCalled();

    await release();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0]).toEqual([{ kind: 'swap', tokenIn: strk!.token, tokenOut: eth!.token, amountIn: 2n * ONE, minAmountOut: 1n, slippageBps: 50 }]);
    expect(machine.store.getState().live).toMatchObject({
      status: 'ready',
      expectedAmountOut: 2n * ONE,
      minimumAmountOut: 1_990000000000000000n,
      priceImpactBps: 0,
      stale: false,
      summary: { rate: '1 STRK ≈ 1 ETH', inverseRate: '1 ETH ≈ 1 STRK', protectedMinimum: '1.99 ETH', poolFee: '6 STRK' },
    });
    expect(machine.store.getState().flow.name).toBe('composing');
  });

  it('is taken as is by a Review press: no second request', async () => {
    const { machine, prepare, release, open } = harness();
    await open();
    machine.setAmount('2');
    await release();
    await machine.prepare();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(machine.store.getState().flow).toMatchObject({ name: 'review', summary: { protectedMinimum: '1.99 ETH', slippage: '0.50%' } });
  });

  it('is waited for, not asked twice, when Review is pressed while it is being asked', async () => {
    const { machine, prepare, real, release, open } = harness();
    await open();
    let answer!: (batch: PreparedBatch) => void;
    const held = new Promise<PreparedBatch>((resolve) => { answer = resolve; });
    prepare.mockImplementationOnce(async (intents, signal) => { const batch = await real(intents, signal); return held.then(() => batch); });
    machine.setAmount('2');
    await release();
    expect(prepare).toHaveBeenCalledTimes(1);

    const reviewing = machine.prepare();
    expect(machine.store.getState().flow.name).toBe('preparing');
    answer(undefined as never);
    await reviewing;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(machine.store.getState().flow.name).toBe('review');
  });

  it('discards the quote it holds when the player edits the swap', async () => {
    const { machine, prepare, real, release, open } = harness();
    await open();
    let discarded = 0;
    prepare.mockImplementation(async (intents, signal) => {
      const batch = await real(intents, signal);
      return { ...pick(batch), confirm: (options) => batch.confirm(options), discard: () => { discarded += 1; batch.discard(); } };
    });
    machine.setAmount('2');
    await release();
    expect(machine.store.getState().live.status).toBe('ready');
    machine.setAmount('3');
    expect(discarded).toBe(1);
    expect(machine.store.getState().live).toEqual({ status: 'quoting' });
  });

  it('keeps the 1.5 s spacing between quotes, live or not', async () => {
    const { machine, prepare, release, open, waits, advance } = harness();
    await open();
    machine.setAmount('2');
    await release();
    expect(prepare).toHaveBeenCalledTimes(1);

    advance(300);
    machine.setAmount('3');
    await release();
    // 800 ms of typing delay passed in the test's own clock only once advanced.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(waits.map(({ ms }) => ms)).toContain(1_200);
    advance(1_200);
    await release();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${LIVE_QUOTE_BUDGET.capacity} quotes in a burst, leaving room for Review, and refills`, async () => {
    const { machine, prepare, release, open, advance } = harness({ spacing: 0 });
    await open();
    for (let quote = 1; quote <= LIVE_QUOTE_BUDGET.capacity; quote += 1) {
      machine.setAmount(String(quote));
      await release();
    }
    expect(prepare).toHaveBeenCalledTimes(LIVE_QUOTE_BUDGET.capacity);
    machine.setAmount('50');
    await release();
    expect(prepare).toHaveBeenCalledTimes(LIVE_QUOTE_BUDGET.capacity);
    expect(machine.store.getState().live).toEqual({ status: 'paused' });

    await machine.prepare();
    expect(prepare).toHaveBeenCalledTimes(LIVE_QUOTE_BUDGET.capacity + 1);
    expect(machine.store.getState().flow.name).toBe('review');

    machine.cancelPrepared();
    advance(LIVE_QUOTE_BUDGET.refillMs);
    machine.setAmount('51');
    await release();
    expect(prepare).toHaveBeenCalledTimes(LIVE_QUOTE_BUDGET.capacity + 2);
    expect(machine.store.getState().live.status).toBe('ready');
  });

  it('pauses after a failure, so a refusal is not asked again on every keystroke, until Review', async () => {
    const { machine, prepare, release, open, waits } = harness();
    await open();
    prepare.mockRejectedValueOnce(new PrivacyError('user-rejected', 'declined'));
    machine.setAmount('2');
    await release();
    expect(machine.store.getState().live).toEqual({ status: 'failed', message: COPY.errors['user-rejected'] });

    machine.setAmount('3');
    expect(machine.store.getState().live).toEqual({ status: 'paused' });
    expect(waits).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);

    // The Review press waits out the spacing, then asks.
    const reviewing = machine.prepare();
    await release();
    await reviewing;
    expect(prepare).toHaveBeenCalledTimes(2);
    machine.cancelPrepared();
    expect(machine.store.getState().live).toEqual({ status: 'quoting' });
  });

  it('dims a quote that ran out, and a Review press asks again', async () => {
    const { machine, prepare, release, open, waits, advance } = harness({ expiresAt: 5_000 });
    await open();
    machine.setAmount('2');
    await release();
    const expiry = waits.find(({ ms }) => ms === 4_000)!;
    advance(4_000);
    expiry.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(machine.store.getState().live).toMatchObject({ status: 'ready', stale: true });

    await machine.prepare();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('asks nothing for an amount above the pool balance, a bad slippage, or before balances are read', async () => {
    const { machine, prepare, open, waits } = harness();
    machine.setAmount('2');
    expect(waits).toEqual([]);
    // Once the balance is read, the amount already typed is quoted.
    await open();
    expect(waits).toHaveLength(1);
    machine.setAmount('101');
    expect(machine.store.getState().live).toEqual({ status: 'idle' });
    machine.setAmount('2');
    machine.setSlippage('0');
    expect(machine.store.getState().live).toEqual({ status: 'idle' });
    expect(waits).toHaveLength(2);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('the live quote and an unaccounted submission (D-089)', () => {
  it('asks nothing while an earlier submission is unaccounted for, as Review is gated', async () => {
    let allowed = false;
    const { machine, waits, open } = harness({ allowed: () => allowed });
    await open();
    machine.setAmount('2');
    expect(machine.store.getState().live).toEqual({ status: 'idle' });
    expect(waits).toEqual([]);
    allowed = true;
    machine.setAmount('3');
    expect(machine.store.getState().live).toEqual({ status: 'quoting' });
  });
});

describe('the slippage cog (D-089)', () => {
  it('starts at 0.5%, or the build ceiling if lower', () => {
    expect(harness().machine.store.getState()).toMatchObject({ slippageText: '0.5', slippageCeilingBps: 300 });
    expect(harness({ slippageCeilingBps: 30 }).machine.store.getState()).toMatchObject({ slippageText: '0.3', slippageCeilingBps: 30 });
    expect(harness({ slippageCeilingBps: 900 }).machine.store.getState().slippageCeilingBps).toBe(300);
  });

  it('quotes and floors the swap at the slippage the player chose', async () => {
    const { machine, prepare, release, open } = harness();
    await open();
    machine.setSlippage('1');
    machine.setAmount('2');
    await release();
    expect(prepare.mock.calls[0]![0][0]).toMatchObject({ slippageBps: 100 });
    await machine.prepare();
    expect(machine.store.getState().flow).toMatchObject({ name: 'review', summary: { slippage: '1.00%', protectedMinimum: '1.98 ETH' } });
  });

  it('a slippage change asks again: the floor depends on it', async () => {
    const { machine, prepare, release, open } = harness();
    await open();
    machine.setAmount('2');
    await release();
    machine.setSlippage('0.1');
    await release(); // the typing delay
    await release(); // the rest of the 1.5 s spacing
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(machine.store.getState().live).toMatchObject({ status: 'ready', minimumAmountOut: 1_998000000000000000n });
  });

  it('refuses a Review press with a slippage over the ceiling, and asks nothing', async () => {
    const { machine, prepare, open } = harness({ slippageCeilingBps: 50 });
    await open();
    machine.setAmount('2');
    machine.setSlippage('1');
    await machine.prepare();
    expect(prepare).not.toHaveBeenCalled();
    expect(machine.store.getState()).toMatchObject({ notice: COPY.exchange.slippageFix, flow: { name: 'composing' } });
  });

  it.each([
    ['0.5', { status: 'ok', bps: 50 }],
    ['0.05', { status: 'ok', bps: 5 }],
    [' 3 ', { status: 'ok', bps: 300 }],
    ['0.5%', { status: 'ok', bps: 50 }],
    ['.5', { status: 'ok', bps: 50 }],
    ['3.01', { status: 'over', ceilingBps: 300 }],
    ['0', { status: 'zero' }],
    ['0.00', { status: 'zero' }],
    ['', { status: 'empty' }],
    ['abc', { status: 'invalid' }],
    ['1.234', { status: 'invalid' }],
    ['-1', { status: 'invalid' }],
    ['1e2', { status: 'invalid' }],
  ] as const)('reads %j as %j', (text, expected) => {
    expect(parseSlippage(text, 300)).toEqual(expected);
  });
});

describe('the flip arrow (D-089)', () => {
  it('swaps the sides and carries the live output into the Sell field', async () => {
    const { machine, release, open } = harness({ balances: { [strk!.token]: 100n * ONE, [eth!.token]: 5n * ONE } });
    await open();
    machine.setAmount('1');
    await release();
    expect(canFlip(machine.store.getState())).toBe(true);
    machine.flip();
    expect(machine.store.getState()).toMatchObject({ sell: eth, buy: strk, amountText: '2' });
  });

  it('does nothing when the pool holds none of the asset being bought', async () => {
    const { machine, open } = harness();
    await open();
    machine.setAmount('1');
    expect(canFlip(machine.store.getState())).toBe(false);
    machine.flip();
    expect(machine.store.getState()).toMatchObject({ sell: strk, buy: eth, amountText: '1' });
  });
});

function pick(batch: PreparedBatch): Omit<PreparedBatch, 'confirm' | 'discard'> {
  return {
    intents: batch.intents, poolFee: batch.poolFee, gasEstimate: batch.gasEstimate, totalCost: batch.totalCost,
    warnings: batch.warnings, promptCount: batch.promptCount,
    ...(batch.swapReview ? { swapReview: batch.swapReview } : {}),
  };
}
