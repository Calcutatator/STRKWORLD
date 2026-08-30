import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations, PrivacyError, type PreparedBatch, type PrivacyOperations } from '@strkworld/privacy';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import { createExchangePanel } from './exchange-machine.js';

const [strk, eth, usdc] = EXCHANGE_CATALOG;
const farFuture = 4_102_444_800_000;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
function panel(review = true) {
  return createExchangePanel({
    operations: new FakePrivacyOperations({ balances: { [strk!.token]: 100n * 10n ** 18n }, swapReview: review ? { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: farFuture } : undefined }),
    receipts: createReceiptLedger(), canStartFinancialAction: () => true,
  });
}
async function ready(machine = panel()) {
  await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); return machine;
}

describe('Exchange machine', () => {
  it('publishes an immutable panel API while retaining owned transitions', async () => {
    const machine = panel();
    const originalSetAmount = machine.setAmount;

    expect(Object.isFrozen(machine)).toBe(true);
    expect(Reflect.set(machine, 'setAmount', () => undefined)).toBe(false);
    expect(Reflect.set(machine, 'confirm', async () => undefined)).toBe(false);
    expect(machine.setAmount).toBe(originalSetAmount);
    machine.setAmount('1');
    expect(machine.store.getState().amountText).toBe('1');
  });

  it('exposes a read-only immutable state snapshot to panel consumers', async () => {
    const machine = panel();
    const state = machine.store.getState();

    expect('setState' in machine.store).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Reflect.set(state, 'amountText', 'forged')).toBe(false);
    expect(machine.store.getState().amountText).toBe('');

    await machine.open();
    await machine.refreshBalances();
    machine.setAmount('1');
    await machine.prepare();
    const reviewed = machine.store.getState();
    expect(reviewed.flow.name).toBe('review');
    if (reviewed.flow.name !== 'review') return;
    expect(Object.isFrozen(reviewed.flow.summary)).toBe(true);
    expect(Object.isFrozen(reviewed.flow.summary.disclosures)).toBe(true);
    expect(Reflect.set(reviewed.flow.summary, 'sell', 'forged')).toBe(false);
    expect(Reflect.set(reviewed.flow.summary.disclosures, '0', 'forged')).toBe(false);
  });

  it('does not read balances until the player explicitly asks, then offers positive catalog assets only', async () => {
    const machine = panel(); await machine.open();
    expect(machine.store.getState().balances).toBe('unrequested');
    await machine.refreshBalances();
    expect(machine.store.getState().sellChoices).toEqual([strk]);
    expect(machine.store.getState().buy).toEqual(eth);
  });

  it('uses each asset decimal precision and keeps the buy asset distinct', async () => {
    const machine = await ready(); machine.setBuy(strk!.token);
    expect(machine.store.getState().buy).toEqual(eth);
    machine.setSell(usdc!.token);
    expect(machine.store.getState().sell).toBeNull();
  });

  it.each([
    {
      field: 'amount',
      edit: (machine: ReturnType<typeof createExchangePanel>) => machine.setAmount('2'),
      expected: { amountText: '2', sell: strk, buy: eth },
    },
    {
      field: 'sell asset',
      edit: (machine: ReturnType<typeof createExchangePanel>) => machine.setSell(usdc!.token),
      expected: { amountText: '', sell: usdc, buy: strk },
    },
    {
      field: 'buy asset',
      edit: (machine: ReturnType<typeof createExchangePanel>) => machine.setBuy(usdc!.token),
      expected: { amountText: '1', sell: strk, buy: usdc },
    },
  ])('discards a prepared batch returned after the player edits the $field', async ({ edit, expected }) => {
    const prepareEntered = deferred<void>();
    const prepared = deferred<PreparedBatch>();
    let discarded = 0;
    const operations: PrivacyOperations = {
      ...controlledOperations(Promise.resolve({ transactionHash: '0xnever' })),
      balances: async () => [
        { token: strk!.token, total: 100n * 10n ** 18n, spendable: 100n * 10n ** 18n, maturing: 0n, maturityKnown: true },
        { token: usdc!.token, total: 100_000_000n, spendable: 100_000_000n, maturing: 0n, maturityKnown: true },
      ],
      prepare: async () => { prepareEntered.resolve(); return prepared.promise; },
    };
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1');

    const preparing = machine.prepare();
    await prepareEntered.promise;
    edit(machine);
    const canonical = { kind: 'swap' as const, tokenIn: strk!.token, tokenOut: eth!.token, amountIn: 10n ** 18n, minAmountOut: 1_990000000000000000n };
    prepared.resolve({
      intents: [canonical],
      poolFee: 6n * 10n ** 18n,
      gasEstimate: 2n * 10n ** 15n,
      totalCost: 6_002000000000000000n,
      warnings: [],
      promptCount: 1,
      swapReview: { expectedAmountOut: 2n * 10n ** 18n, minimumAmountOut: canonical.minAmountOut, slippageBps: 50, expiresAt: farFuture },
      confirm: async () => ({ transactionHash: '0xnever' }),
      discard: () => { discarded += 1; },
    });
    await preparing;

    expect(discarded).toBe(1);
    expect(machine.store.getState()).toMatchObject({ ...expected, flow: { name: 'composing' } });
  });

  it('fails closed and discards when a prepared swap has no review', async () => {
    const machine = await ready(panel(false)); await machine.prepare();
    expect(machine.store.getState().flow).toMatchObject({ name: 'failed', recovery: 'prepare-again' });
  });

  it('does not confirm a reviewed batch after the player edits the amount', async () => {
    let confirms = 0;
    const machine = await ready(createExchangePanel({
      operations: controlledOperations(Promise.resolve({ transactionHash: '0xstale' }), undefined, () => { confirms += 1; }),
      receipts: createReceiptLedger(), canStartFinancialAction: () => true,
    }));
    await machine.prepare();

    machine.setAmount('2');
    await machine.confirm();

    expect(confirms).toBe(0);
    expect(machine.store.getState().flow).toMatchObject({ name: 'composing' });
  });

  it('retires a reviewed batch when the player changes the sell asset', async () => {
    let confirms = 0;
    let discards = 0;
    const operations = controlledOperations(
      Promise.resolve({ transactionHash: '0xstale-sell' }),
      undefined,
      () => { confirms += 1; },
      undefined,
      50,
      () => { discards += 1; },
    );
    operations.balances = async () => [
      { token: strk!.token, total: 100n * 10n ** 18n, spendable: 100n * 10n ** 18n, maturing: 0n, maturityKnown: true },
      { token: usdc!.token, total: 100_000_000n, spendable: 100_000_000n, maturing: 0n, maturityKnown: true },
    ];
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();

    machine.setSell(usdc!.token);
    await machine.confirm();

    expect(discards).toBe(1);
    expect(confirms).toBe(0);
    expect(machine.store.getState()).toMatchObject({ sell: usdc, amountText: '', flow: { name: 'composing' } });
  });

  it('retires a reviewed batch when the player changes the buy asset', async () => {
    let confirms = 0;
    let discards = 0;
    const machine = await ready(createExchangePanel({
      operations: controlledOperations(
        Promise.resolve({ transactionHash: '0xstale-buy' }),
        undefined,
        () => { confirms += 1; },
        undefined,
        50,
        () => { discards += 1; },
      ),
      receipts: createReceiptLedger(), canStartFinancialAction: () => true,
    }));
    await machine.prepare();

    machine.setBuy(usdc!.token);
    await machine.confirm();

    expect(discards).toBe(1);
    expect(confirms).toBe(0);
    expect(machine.store.getState()).toMatchObject({ buy: usdc, flow: { name: 'composing' } });
  });

  it('rejects a malformed zero-slippage review at the Shell boundary', async () => {
    const machine = await ready(createExchangePanel({
      operations: controlledOperations(Promise.resolve({ transactionHash: '0xnever' }), undefined, undefined, undefined, 0),
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
    }));

    await machine.prepare();

    expect(machine.store.getState().flow).toMatchObject({ name: 'failed', recovery: 'prepare-again' });
  });

  it('shows canonical protected minimum, UTC expiry, exact fees and the approved exchange disclosure', async () => {
    const machine = await ready(); await machine.prepare();
    const flow = machine.store.getState().flow;
    expect(flow.name).toBe('review');
    if (flow.name !== 'review') return;
    expect(flow.summary.sell).toBe('1 STRK');
    expect(flow.summary.expectedBuy).toBe('2 ETH');
    expect(flow.summary.protectedMinimum).toBe('1.99 ETH');
    expect(flow.summary.expiresAt).toBe('2100-01-01T00:00:00.000Z');
    expect(flow.summary.poolFee).toBe('6 STRK');
    expect(flow.summary.networkCost).toBe('0.002 STRK');
    expect(flow.summary.disclosures).toEqual(['This swap hides who traded, but not the tokens or amounts. The executor and public exchange activity are visible on-chain.']);
  });

  it('records the receipt under exchange and ignores a synchronous second confirmation', async () => {
    const ledger = createReceiptLedger(); const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * 10n ** 18n }, swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: farFuture } });
    const machine = createExchangePanel({ operations, receipts: ledger, canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    await Promise.all([machine.confirm(), machine.confirm()]);
    expect(operations.submitted).toHaveLength(1);
    expect(operations.submitted[0]?.[0]).toMatchObject({ kind: 'swap', minAmountOut: 1_990000000000000000n });
    expect(ledger.pending('exchange')).toHaveLength(1);
    expect(ledger.pending('bank')).toHaveLength(0);
  });

  it('treats expiry as epoch milliseconds and discards an expired review', async () => {
    const machine = createExchangePanel({
      operations: new FakePrivacyOperations({ balances: { [strk!.token]: 100n * 10n ** 18n }, swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 2_000 } }),
      receipts: createReceiptLedger(), canStartFinancialAction: () => true, now: () => 2_000,
    });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    expect(machine.store.getState().flow).toMatchObject({ name: 'failed', recovery: 'prepare-again' });
  });

  it('uses 6- and 8-decimal asset precision without truncating input', async () => {
    const wbtc = EXCHANGE_CATALOG[4]!;
    const operations = new FakePrivacyOperations({ balances: { [usdc!.token]: 2_000_000n, [wbtc.token]: 123_456_789n, [strk!.token]: 100n * 10n ** 18n }, swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: farFuture } });
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setSell(usdc!.token); machine.setAmount('1.000001'); await machine.prepare();
    expect(operations.submitted).toHaveLength(0); expect(machine.store.getState().flow.name).toBe('review');
    machine.cancelPrepared(); machine.setSell(wbtc.token); machine.setAmount('1.23456789'); await machine.prepare();
    expect(machine.store.getState().flow.name).toBe('review');
  });

  it('records a receipt before a close-mid-submit liveness guard and restores it on remount', async () => {
    const result = deferred<{ transactionHash: string }>();
    const ledger = createReceiptLedger();
    const entered = deferred<void>(); const operations = controlledOperations(result.promise, undefined, entered.resolve);
    const machine = createExchangePanel({ operations, receipts: ledger, canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    const confirming = machine.confirm(); await entered.promise; machine.close(); result.resolve({ transactionHash: '0xlate' }); await confirming;
    expect(ledger.pending('exchange')).toHaveLength(1);
    const remount = createExchangePanel({ operations, receipts: ledger, canStartFinancialAction: () => true }); await remount.open();
    expect(remount.store.getState().flow).toEqual({ name: 'submitted', transactionHash: '0xlate' });
  });

  it('does not let a stale rejected confirmation discard a newer signing batch', async () => {
    const first = deferred<{ transactionHash: string }>();
    const second = deferred<{ transactionHash: string }>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    let preparedCount = 0;
    let secondDiscarded = 0;
    const canonical = {
      kind: 'swap' as const,
      tokenIn: strk!.token,
      tokenOut: eth!.token,
      amountIn: 10n ** 18n,
      minAmountOut: 1_990000000000000000n,
    };
    const batch = (
      result: ReturnType<typeof deferred<{ transactionHash: string }>>,
      entered: ReturnType<typeof deferred<void>>,
      discard: () => void,
    ): PreparedBatch => ({
      intents: [canonical],
      poolFee: 6n * 10n ** 18n,
      gasEstimate: 2n * 10n ** 15n,
      totalCost: 6_002000000000000000n,
      warnings: [],
      promptCount: 1,
      swapReview: {
        expectedAmountOut: 2n * 10n ** 18n,
        minimumAmountOut: canonical.minAmountOut,
        slippageBps: 50,
        expiresAt: farFuture,
      },
      confirm: async () => {
        entered.resolve();
        return result.promise;
      },
      discard,
    });
    const firstBatch = batch(first, firstEntered, () => {});
    const secondBatch = batch(second, secondEntered, () => { secondDiscarded += 1; });
    const operations: PrivacyOperations = {
      capability: async () => ({ supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' }),
      poolConfig: async () => ({ feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
      balances: async () => [{ token: strk!.token, total: 100n * 10n ** 18n, spendable: 100n * 10n ** 18n, maturing: 0n, maturityKnown: true }],
      recipientStatus: async () => 'registered',
      prepare: async () => preparedCount++ === 0 ? firstBatch : secondBatch,
    };
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();

    const confirmingFirst = machine.confirm();
    await firstEntered.promise;
    machine.close();
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    const confirmingSecond = machine.confirm();
    await secondEntered.promise;

    first.reject(new PrivacyError('unknown', 'stale failure'));
    await confirmingFirst;
    machine.close();

    expect(secondDiscarded).toBe(0);
    second.resolve({ transactionHash: '0xsecond' });
    await confirmingSecond;
  });

  it('keeps a newer prepared batch releasable after a stale confirmation resolves', async () => {
    const first = deferred<{ transactionHash: string }>();
    const second = deferred<{ transactionHash: string }>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    let preparedCount = 0;
    let secondDiscarded = 0;
    const operations = controlledOperations(first.promise, undefined, firstEntered.resolve);
    const firstBatch = (await operations.prepare([])) as PreparedBatch;
    const secondBatch = { ...firstBatch, confirm: async () => { secondEntered.resolve(); return second.promise; }, discard: () => { secondDiscarded += 1; } } satisfies PreparedBatch;
    operations.prepare = async () => preparedCount++ === 0 ? firstBatch : secondBatch;
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    const confirmingFirst = machine.confirm();
    await firstEntered.promise;
    machine.close();
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    const confirmingSecond = machine.confirm();
    await secondEntered.promise;

    first.resolve({ transactionHash: '0xfirst' });
    await confirmingFirst;
    second.reject(new PrivacyError('unknown', 'new failure'));
    await confirmingSecond;

    expect(secondDiscarded).toBe(1);
  });

  it('discards a newer prepared batch when it never enters wallet handoff', async () => {
    const first = deferred<{ transactionHash: string }>();
    const firstEntered = deferred<void>();
    let secondDiscarded = 0;
    const operations = controlledOperations(first.promise, undefined, firstEntered.resolve);
    const firstBatch = (await operations.prepare([])) as PreparedBatch;
    const secondBatch = {
      ...firstBatch,
      discard: () => { secondDiscarded += 1; },
    } satisfies PreparedBatch;
    let preparedCount = 0;
    operations.prepare = async () => preparedCount++ === 0 ? firstBatch : secondBatch;
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();

    const confirmingFirst = machine.confirm();
    await firstEntered.promise;
    machine.close();
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    machine.close();

    expect(secondDiscarded).toBe(1);
    first.reject(new PrivacyError('unknown', 'stale failure'));
    await confirmingFirst;
  });

  it('promotes a late hashless uncertainty after close and never permits a blind second confirm', async () => {
    const result = deferred<{ transactionHash: string }>(); const errors: string[] = [];
    const entered = deferred<void>(); let confirms = 0;
    const machine = createExchangePanel({ operations: controlledOperations(result.promise, undefined, () => { confirms += 1; entered.resolve(); }), receipts: createReceiptLedger(), canStartFinancialAction: () => true, onError: (error) => errors.push(error.kind) });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    const confirming = machine.confirm(); await entered.promise; machine.close(); result.reject(new PrivacyError('submission-uncertain', 'lost')); await confirming;
    expect(errors).toEqual(['submission-uncertain']);
    await machine.confirm(); expect(machine.store.getState().flow.name).toBe('idle'); expect(confirms).toBe(1);
  });

  it('does not start a fee-classification read after the panel closes', async () => {
    const result = deferred<{ transactionHash: string }>();
    const entered = deferred<void>();
    const base = controlledOperations(result.promise, undefined, entered.resolve);
    let poolReads = 0;
    const operations: PrivacyOperations = {
      ...base,
      poolConfig: (signal) => {
        poolReads += 1;
        return base.poolConfig(signal);
      },
    };
    const machine = createExchangePanel({
      operations,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
    });
    await machine.open();
    await machine.refreshBalances();
    machine.setAmount('1');
    await machine.prepare();

    const confirming = machine.confirm();
    await entered.promise;
    const readsBeforeClose = poolReads;
    machine.close();
    result.reject(new PrivacyError('unknown', 'ceiling'));
    await confirming;

    expect(machine.store.getState().flow.name).toBe('idle');
    expect(poolReads).toBe(readsBeforeClose);
  });

  it('does not submit when the financial gate flips while reading the live fee', async () => {
    const pool = deferred<ReturnType<FakePrivacyOperations['poolConfig']> extends Promise<infer T> ? T : never>(); let allowed = true;
    const operations = controlledOperations(Promise.resolve({ transactionHash: '0xnever' }), pool.promise);
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => allowed });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    const confirming = machine.confirm(); allowed = false; pool.resolve({ feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 }); await confirming;
    expect(machine.store.getState().flow.name).toBe('review');
    expect(machine.store.getState().notice).toContain('Do not retry');
  });

  it('blocks a fee that moved above the reviewed ceiling before submission', async () => {
    const highFee = Promise.resolve({ feeAmount: 7n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 });
    const machine = createExchangePanel({ operations: controlledOperations(Promise.resolve({ transactionHash: '0xnever' }), highFee), receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare(); await machine.confirm();
    expect(machine.store.getState().flow).toMatchObject({ name: 'failed', message: 'The pool fee moved above the total you were shown, so nothing was signed. Prepare it again to see the new figure.' });
  });

  it('classifies a stale fee read when confirm rejects and a second pool read shows movement', async () => {
    const moved = Promise.resolve({ feeAmount: 7n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 });
    const old = Promise.resolve({ feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 });
    const machine = createExchangePanel({ operations: controlledOperations(Promise.reject(new PrivacyError('unknown', 'ceiling')), old, undefined, moved), receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare(); await machine.confirm();
    expect(machine.store.getState().flow).toMatchObject({ name: 'failed', message: 'The pool fee moved above the total you were shown, so nothing was signed. Prepare it again to see the new figure.' });
  });

  it('rejects a review that expires after preparation before wallet handoff', async () => {
    let current = farFuture - 1; let confirms = 0;
    const machine = createExchangePanel({ operations: controlledOperations(Promise.resolve({ transactionHash: '0xnever' }), undefined, () => { confirms += 1; }), receipts: createReceiptLedger(), canStartFinancialAction: () => true, now: () => current });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare(); current = farFuture; await machine.confirm();
    expect(confirms).toBe(0); expect(machine.store.getState().flow).toMatchObject({ name: 'failed', recovery: 'prepare-again' });
  });

  it('rejects a review that expires while reading live pool validity before wallet handoff', async () => {
    let current = farFuture - 1; let confirms = 0; let discards = 0;
    const pool = deferred<ReturnType<FakePrivacyOperations['poolConfig']> extends Promise<infer T> ? T : never>();
    const operations = controlledOperations(Promise.resolve({ transactionHash: '0xnever' }), pool.promise, () => { confirms += 1; }, undefined, 50, () => { discards += 1; });
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true, now: () => current });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();

    const confirming = machine.confirm();
    current = farFuture;
    pool.resolve({ feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 });
    await confirming;

    expect(confirms).toBe(0);
    expect(discards).toBe(1);
    expect(machine.store.getState().flow).toMatchObject({ name: 'failed', recovery: 'prepare-again' });
  });

  it('does not hand off a confirmation that closes before its live pool read settles', async () => {
    let confirms = 0;
    const pool = deferred<ReturnType<FakePrivacyOperations['poolConfig']> extends Promise<infer T> ? T : never>();
    const operations = controlledOperations(Promise.resolve({ transactionHash: '0xnever' }), pool.promise, () => { confirms += 1; });
    const machine = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();

    const confirming = machine.confirm();
    machine.close();
    await machine.open(); await machine.refreshBalances(); machine.setAmount('1'); await machine.prepare();
    pool.resolve({ feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 });
    await confirming;

    expect(confirms).toBe(0);
    expect(machine.store.getState().flow.name).toBe('review');
  });
});

function controlledOperations(confirmResult: Promise<{ transactionHash: string }>, secondPool?: Promise<{ feeAmount: bigint; feeToken: string; proofValidityBlocks: number; noteMaturityBlocks: number }>, onConfirmEntered?: () => void, thirdPool?: Promise<{ feeAmount: bigint; feeToken: string; proofValidityBlocks: number; noteMaturityBlocks: number }>, slippageBps = 50, onDiscard?: () => void): PrivacyOperations {
  let poolCalls = 0;
  const canonical = { kind: 'swap' as const, tokenIn: strk!.token, tokenOut: eth!.token, amountIn: 10n ** 18n, minAmountOut: 1_990000000000000000n };
  const batch: PreparedBatch = { intents: [canonical], poolFee: 6n * 10n ** 18n, gasEstimate: 2n * 10n ** 15n, totalCost: 6_002000000000000000n, warnings: [], promptCount: 1, swapReview: { expectedAmountOut: 2n * 10n ** 18n, minimumAmountOut: canonical.minAmountOut, slippageBps, expiresAt: farFuture }, confirm: async () => { onConfirmEntered?.(); return confirmResult; }, discard() { onDiscard?.(); } };
  return {
    capability: async () => ({ supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' }),
    poolConfig: async () => { ++poolCalls; if (poolCalls === 1) return { feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 }; if (poolCalls === 2 && secondPool) return secondPool; if (poolCalls > 2 && thirdPool) return thirdPool; return { feeAmount: 6n * 10n ** 18n, feeToken: strk!.token, proofValidityBlocks: 450, noteMaturityBlocks: 10 }; },
    balances: async () => [{ token: strk!.token, total: 100n * 10n ** 18n, spendable: 100n * 10n ** 18n, maturing: 0n, maturityKnown: true }],
    recipientStatus: async () => 'registered', prepare: async () => batch,
  };
}
