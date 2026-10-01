import { afterEach, describe, expect, it, vi } from 'vitest';
import { BORROW_TOKENS as PINNED_BORROW_TOKENS, BorrowRefusedError, DEMO_BORROW_STAND_IN, FakePrivacyOperations, type FakeConfig, type PrivacyOperations, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { attachDebugTap, type DebugTap, type VaultDebugStep } from '../../debug/debug-tap.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import type { ShellFailure } from '../../privacy/errors.js';
import { BORROW_TOKENS } from '../../production/config.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createVaultPanel } from '../vault/vault-machine.js';
import { borrowPairChoices, borrowTokenChoices, createBorrowPanel, loanFor, refusalOf, takesEverything } from './borrow-machine.js';

/**
 * The Borrow counter's machine (D-083), against the deterministic fake:
 * what opens without a prompt, what reaches the seam, what a refusal says,
 * and what the probe log is told.
 */

const [STRK, ETH, USDC, USDT, WBTC] = BORROW_TOKENS as [string, string, string, string, string];
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const POOL_FEE = 6n * E18;
const DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'vault.borrow')!.disclosure!;

afterEach(() => {
  attachDebugTap(null);
});

function fake(borrow?: FakeConfig['borrow'], balances: Record<string, bigint> = { [STRK]: 50_000n * E18, [USDC]: 500n * USDC_ONE }) {
  return new FakePrivacyOperations({ balances, poolConfig: { noteMaturityBlocks: 0 }, ...(borrow ? { borrow } : {}) });
}

function machine(operations: PrivacyOperations, canStart: () => boolean = () => true) {
  const receipts = createReceiptLedger();
  const failures: ShellFailure[] = [];
  const panel = createBorrowPanel({ operations, receipts, canStartFinancialAction: canStart, onError: (failure) => failures.push(failure) });
  return { panel, receipts, failures };
}

function probe(): VaultDebugStep[] {
  const steps: VaultDebugStep[] = [];
  const tap: DebugTap = {
    failure: () => undefined,
    connectState: () => undefined,
    walletSession: () => undefined,
    visit: () => undefined,
    bank: () => undefined,
    sandboxBurst: () => undefined,
    gate: () => undefined,
    vault: (step) => steps.push(step as VaultDebugStep),
  };
  attachDebugTap(tap);
  return steps;
}

function borrowPolicy(tokens: string[]): WalletRoutePolicy {
  return { maxIntents: 1, maxRelayFee: 0n, enabledRoutes: ['borrow'], allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], borrow: tokens } };
}

describe('the Borrow counter (D-083)', () => {
  it('pins the same five tokens as the privacy package, in order', () => {
    expect(BORROW_TOKENS).toEqual(PINNED_BORROW_TOKENS);
    expect(borrowTokenChoices(null).map((entry) => entry.symbol)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC']);
    expect(borrowTokenChoices(borrowPolicy([USDC, STRK, '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8'])).map((entry) => entry.symbol))
      .toEqual(['USDC', 'STRK']);
  });

  it('opens on a version query and Vesu\'s pool alone: no loans read, no wallet prompt', async () => {
    const operations = fake();
    const loans = vi.spyOn(operations, 'borrowPositions');
    const market = vi.spyOn(operations, 'borrowMarket');
    const { panel } = machine(operations);
    await panel.open();
    const state = panel.store.getState();
    expect(state.capability).toEqual({ status: 'supported' });
    expect(state.door.open).toBe(true);
    expect(state.disclosure).toBe(DISCLOSURE);
    expect(state.market.status).toBe('loaded');
    expect(state.loans).toEqual({ status: 'unrequested' });
    expect(state.mode).toBe('borrow');
    // The first pair Vesu offers, collateral-major.
    expect(state.pair).toEqual({ collateral: STRK, debt: ETH });
    expect(loans).not.toHaveBeenCalled();
    expect(market).toHaveBeenCalledTimes(1);
  });

  it('opens a loan: the review states the health after and the approved disclosure, and the receipt is the counter\'s own', async () => {
    const operations = fake();
    const steps = probe();
    const { panel, receipts, failures } = machine(operations);
    await panel.open();
    panel.setPair(STRK, USDC);
    panel.setCollateralAmount('10000');
    panel.setAmount('100');
    await panel.prepare();
    const review = panel.store.getState().flow;
    expect(review.name).toBe('review');
    if (review.name !== 'review') return;
    expect(review.summary.action).toEqual({ kind: 'borrow', collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE });
    expect(review.summary.after).toMatchObject({ status: 'priced', band: 'safe' });
    expect(review.summary.disclosures).toEqual([DISCLOSURE]);
    expect(review.summary.requiresDisclosure).toBe(true);
    expect(review.summary.feeCeiling).toBe(POOL_FEE);
    await panel.confirm();
    const done = panel.store.getState();
    expect(done.flow).toMatchObject({ name: 'submitted', outcome: 'succeeded' });
    expect(done.notice?.text).toBe(COPY.borrow.loans.changed);
    expect(done.loans).toEqual({ status: 'unrequested' });
    expect(operations.borrowSubmitted).toHaveLength(1);
    expect(receipts.pending('vault')).toEqual([expect.objectContaining({ building: 'vault', counter: 'borrow' })]);
    expect(failures).toEqual([]);
    // Codes only: kinds and stages, never an amount, a token or an address.
    expect(steps.filter((step) => step.step === 'prepare')).toEqual([{ step: 'prepare', kind: 'borrow', all: false }]);
    expect(steps.filter((step) => step.step === 'confirm').map((step) => (step as { stage: string }).stage).at(-1)).toBe('submitted');
    expect(JSON.stringify(steps, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toMatch(/0x0[0-9a-f]{20,}|10000/);
  });

  it('says why it refuses a loan past the max LTV, reports nothing, and asks the wallet nothing', async () => {
    const operations = fake();
    const { panel, failures } = machine(operations);
    await panel.open();
    panel.setPair(STRK, USDC);
    panel.setCollateralAmount('1000');
    panel.setAmount('100');
    await panel.prepare();
    const state = panel.store.getState();
    expect(state.flow).toEqual({ name: 'composing' });
    expect(state.notice).toEqual({ tone: 'error', text: COPY.borrow.refusals['above-max-ltv'] });
    expect(failures).toEqual([]);
    expect(operations.borrowSubmitted).toEqual([]);
  });

  it('refuses an amount it cannot read before preparing anything', async () => {
    const operations = fake();
    const prepare = vi.spyOn(operations, 'prepareBorrow');
    const { panel } = machine(operations);
    await panel.open();
    panel.setAmount('abc');
    await panel.prepare();
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.badAmount });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('reads the loans on request, with their health and the public stand-in, and offers them to repay', async () => {
    const operations = fake({ positions: [{ collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE }] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    const state = panel.store.getState();
    expect(state.loans.status).toBe('loaded');
    if (state.loans.status !== 'loaded') return;
    expect(state.loans.standIn).toBe(DEMO_BORROW_STAND_IN);
    expect(state.loans.positions).toHaveLength(1);
    expect(loanFor(state, { collateral: STRK, debt: USDC })?.health.status).toBe('priced');
    panel.setMode('repay');
    expect(panel.store.getState().pair).toEqual({ collateral: STRK, debt: USDC });
    expect(borrowPairChoices(panel.store.getState())).toEqual([{ collateral: STRK, debt: USDC }]);
  });

  it('repays everything with its buffer, and the review says Vesu fixes the amount', async () => {
    const operations = fake({ positions: [{ collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE }] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    panel.setMode('repay');
    panel.setAll(true);
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toEqual({ kind: 'repay', collateral: STRK, debt: USDC, amount: 100n * USDC_ONE + 100_002n, all: true, buffer: 100_002n });
    expect(flow.name === 'review' && flow.summary.after.status).toBe('no-debt');
    await panel.confirm();
    expect(operations.borrowSubmitted.at(-1)).toMatchObject({ kind: 'repay', all: true });
  });

  it('blocks a collateral withdrawal past the max LTV before the wallet is asked', async () => {
    const operations = fake({ positions: [{ collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE }] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    panel.setMode('withdraw-collateral');
    panel.setAmount('9000');
    await panel.prepare();
    expect(panel.store.getState().notice?.text).toBe(COPY.borrow.refusals['above-max-ltv']);
    expect(operations.borrowSubmitted).toEqual([]);
  });

  it('shows no figure for a loan whose price feed is stale, and refuses to change it', async () => {
    const operations = fake({ stalePrices: [USDC], positions: [{ collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE }] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    const state = panel.store.getState();
    expect(loanFor(state, { collateral: STRK, debt: USDC })?.health).toMatchObject({ status: 'stale-price', band: 'unknown', healthFactor: null });
    panel.setMode('repay');
    panel.setAll(true);
    await panel.prepare();
    expect(panel.store.getState().notice?.text).toBe(COPY.borrow.refusals['stale-price']);
  });

  it('offers only loans with debt to repay, and only loans with collateral to withdraw', async () => {
    const operations = fake({ positions: [
      { collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, debtAmount: 0n },
      { collateral: ETH, debt: USDT, collateralAmount: E18, debtAmount: 100n * USDC_ONE },
    ] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    expect(borrowPairChoices(panel.store.getState(), 'repay')).toEqual([{ collateral: ETH, debt: USDT }]);
    expect(borrowPairChoices(panel.store.getState(), 'withdraw-collateral')).toHaveLength(2);
    expect(borrowPairChoices(panel.store.getState(), 'add-collateral')).toHaveLength(2);
  });

  it('tells a wallet without shadow accounts so, and reads nothing', async () => {
    const operations = new FakePrivacyOperations({ capability: { supportsShadowAccounts: false } });
    const market = vi.spyOn(operations, 'borrowMarket');
    const { panel } = machine(operations);
    await panel.open();
    expect(panel.store.getState().capability).toEqual({ status: 'unsupported' });
    expect(market).not.toHaveBeenCalled();
  });

  it('keeps its door locked when this build has not switched borrowing on', () => {
    const register = PRIVACY_REGISTER.filter((entry) => entry.route !== 'vault.borrow');
    const panel = createBorrowPanel({ operations: fake(), receipts: createReceiptLedger(), canStartFinancialAction: () => true, register });
    expect(panel.store.getState().door.open).toBe(false);
  });

  it('restores only its own receipt, and the Vault only its own', async () => {
    const receipts = createReceiptLedger();
    receipts.record({ building: 'vault', counter: 'borrow', transactionHash: '0xb0', intents: [] });
    const borrow = createBorrowPanel({ operations: fake(), receipts, canStartFinancialAction: () => true });
    await borrow.open();
    expect(borrow.store.getState().flow).toMatchObject({ name: 'submitted', transactionHash: '0xb0', restored: true });
    const vault = createVaultPanel({ operations: fake(), receipts, canStartFinancialAction: () => true });
    await vault.open();
    expect(vault.store.getState().flow).toEqual({ name: 'composing' });
  });

  it('reads a refusal only from the error\'s own refusal property, and only a known one', () => {
    expect(refusalOf({ refusal: 'debt-cap' })).toBe('debt-cap');
    expect(refusalOf({ refusal: 'toString' })).toBeNull();
    expect(refusalOf(Object.create({ refusal: 'debt-cap' }))).toBeNull();
    expect(refusalOf(new Error('x'))).toBeNull();
  });

  it('does not start while a submission is uncertain', async () => {
    const operations = fake();
    const prepare = vi.spyOn(operations, 'prepareBorrow');
    const { panel } = machine(operations, () => false);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    expect(panel.store.getState().notice?.text).toBe(COPY.errors['submission-uncertain']);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('says a review went stale at confirm, offers a fresh one, and reports nothing (review fix)', async () => {
    const operations = fake();
    const real = operations.prepareBorrow.bind(operations);
    vi.spyOn(operations, 'prepareBorrow').mockImplementation(async (request, options) => {
      const batch = await real(request, options);
      return { ...batch, confirm: async () => { throw new BorrowRefusedError('review-expired', 'expired'); } };
    });
    const { panel, failures, receipts } = machine(operations);
    await panel.open();
    panel.setPair(STRK, USDC);
    panel.setCollateralAmount('10000');
    panel.setAmount('100');
    await panel.prepare();
    await panel.confirm();
    expect(panel.store.getState().flow).toEqual({
      name: 'failed',
      kind: 'unknown',
      message: COPY.borrow.refusals['review-expired'],
      recovery: 'prepare-again',
    });
    expect(failures).toEqual([]);
    expect(receipts.pending('vault')).toEqual([]);
    panel.cancelPrepared();
    await panel.prepare();
    expect(panel.store.getState().flow.name).toBe('review');
  });

  it('refuses a borrow that would land too close to liquidation, saying what to do (review fix)', async () => {
    const { panel } = machine(fake());
    await panel.open();
    panel.setPair(STRK, USDC);
    // 10,000 demo STRK at $0.04 at 0.68 lends at most $272; $265 leaves a health of about 1.03.
    panel.setCollateralAmount('10000');
    panel.setAmount('265');
    await panel.prepare();
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.borrow.refusals['too-close-to-liquidation'] });
    expect(COPY.borrow.refusals['too-close-to-liquidation']).toMatch(/Borrow less or add more collateral/);
  });

  it('keeps WBTC pairs in its list', async () => {
    const { panel } = machine(fake());
    await panel.open();
    expect(borrowPairChoices(panel.store.getState()).some((pair) => pair.collateral === WBTC)).toBe(true);
  });
});

describe('the Borrow form\'s Max (D-089)', () => {
  it('repays everything when the amount is the debt as read, and a part otherwise', async () => {
    const operations = fake({ positions: [{ collateral: STRK, debt: USDC, collateralAmount: 2_000n * E18, debtAmount: 20n * USDC_ONE }] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    panel.setMode('repay');
    const state = panel.store.getState();
    expect(takesEverything(state, state.pair, 20n * USDC_ONE)).toBe(true);
    expect(takesEverything(state, state.pair, 19n * USDC_ONE)).toBe(false);

    panel.setAmount('20');
    await panel.prepare();
    let flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toMatchObject({ kind: 'repay', all: true });

    panel.cancelPrepared();
    panel.setAmount('5');
    await panel.prepare();
    flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toMatchObject({ kind: 'repay', all: false, amount: 5n * USDC_ONE });
  });

  it('withdraws everything only from a loan that owes nothing', async () => {
    const operations = fake({ positions: [
      { collateral: STRK, debt: USDC, collateralAmount: 2_000n * E18, debtAmount: 0n },
      { collateral: STRK, debt: USDT, collateralAmount: 3_000n * E18, debtAmount: 10n * USDC_ONE },
    ] });
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshLoans();
    panel.setMode('withdraw-collateral');
    panel.setPair(STRK, USDC);
    let state = panel.store.getState();
    expect(takesEverything(state, state.pair, 2_000n * E18)).toBe(true);
    panel.setAmount('2000');
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toMatchObject({ kind: 'withdraw-collateral', all: true });

    panel.cancelPrepared();
    panel.setPair(STRK, USDT);
    state = panel.store.getState();
    expect(takesEverything(state, state.pair, 3_000n * E18)).toBe(false);
  });
});
