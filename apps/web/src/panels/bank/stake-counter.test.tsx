import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  FakePrivacyOperations,
  type Intent,
  type PrivacyOperations,
} from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { formatStrkExact, formatTokenAmountExact, parseTokenAmount } from '../../format.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { createReceiptLedger, type ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { parseRoutePolicy, XSTRK_TOKEN } from '../../production/config.js';
import { resolveStation, stationSnapshot } from '../../visits/station-registry.js';
import { VisitLayerView } from '../../visits/VisitLayer.js';
import { BankPanel } from './BankPanel.js';
import {
  createBankPanel,
  reviewedStake,
  STAKE_TOKEN_OUT,
  type BankMode,
  type BankPanel as BankMachine,
} from './bank-machine.js';

/**
 * The Bank's Endur staking counter (D-063, D-064), end to end against the
 * deterministic demo seam: compose from the pool balance, review STRK in and
 * xSTRK out, confirm through the shared ConfirmGate with no disclosure, and
 * come back to a receipt. The rendered click-through, with its next step, is
 * `StakeCounter.flow.test.tsx`.
 */

const STRK = ENDUR_XSTRK_ASSET;
const ONE = 10n ** 18n;
const POOL_FEE = 6n * ONE;
/** The fake's relay estimate for one stake: two units of 1e15 (see fake.ts). */
const STAKE_GAS = 2_000000000000000n;
const strk = (whole: string) => parseTokenAmount(whole)!;
const escaped = (text: string) => text.replaceAll("'", '&#x27;');

function stakeCounter(
  operations: PrivacyOperations = createDemoOperations({ funded: true }),
  receipts: ReceiptLedger = createReceiptLedger(),
): BankMachine {
  return createBankPanel({
    operations,
    receipts,
    allowedModes: ['stake'],
    initialMode: 'stake',
    maxIntents: 1,
    canStartFinancialAction: () => true,
  });
}

function menuBank(operations: PrivacyOperations, receipts = createReceiptLedger()): BankMachine {
  return createBankPanel({ operations, receipts, canStartFinancialAction: () => true });
}

function render(
  panel: BankMachine,
  operations: PrivacyOperations,
  experience: 'menu' | 'station',
  modes?: readonly BankMode[],
): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={operations}>
      <BankPanel
        panel={panel}
        experience={experience}
        allowedModes={modes}
        initialMode={modes?.[0]}
        onClose={() => {}}
      />
    </PrivacyProvider>,
  );
}

function reviewSummary(panel: BankMachine) {
  const flow = panel.store.getState().flow;
  if (flow.name !== 'review') throw new Error(`expected review, got ${flow.name}`);
  return flow.summary;
}

const stakeIntent = (amountIn: bigint): Intent => ({ kind: 'stake', tokenIn: STRK, tokenOut: ENDUR_XSTRK, amountIn });

describe('the staking counter composes only the pinned pair', () => {
  it('names Endur xSTRK out, the same value the seam and the production policy pin', () => {
    expect(BigInt(STAKE_TOKEN_OUT)).toBe(BigInt(ENDUR_XSTRK));
    expect(STAKE_TOKEN_OUT).toBe(XSTRK_TOKEN);
  });

  it('reviews a batch as a stake only when it is exactly one stake', () => {
    const transfer: Intent = { kind: 'transfer', token: STRK, amount: 1n, recipient: '0x0456' };
    expect(reviewedStake([stakeIntent(1n)])).toEqual(stakeIntent(1n));
    expect(reviewedStake([])).toBeNull();
    expect(reviewedStake([transfer])).toBeNull();
    expect(reviewedStake([stakeIntent(1n), stakeIntent(2n)])).toBeNull();
  });
});

describe('the staking counter, end to end in demo', () => {
  it('stakes STRK from the pool balance and lands xSTRK in the pool, with no disclosure at the gate', async () => {
    const operations = createDemoOperations({ funded: true });
    const receipts = createReceiptLedger();
    const panel = stakeCounter(operations, receipts);
    await panel.open();

    // Registered, approved and waived (D-064): the door opens with no header disclosure.
    expect(panel.store.getState()).toMatchObject({
      mode: 'stake',
      routeId: 'bank.stake',
      door: { open: true, reason: null },
      disclosure: null,
      flow: { name: 'composing' },
    });

    // The balance is read only on request, exactly as for every Bank control.
    expect(panel.store.getState().balance).toEqual({ status: 'unrequested' });
    await panel.refreshBalance();
    expect(panel.store.getState().balance).toMatchObject({ status: 'loaded', total: 250n * ONE, spendable: 250n * ONE });

    panel.setAmount('5');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toEqual([stakeIntent(strk('5'))]);

    await panel.prepare();
    const summary = reviewSummary(panel);
    expect(summary.intents).toEqual([stakeIntent(strk('5'))]);
    expect(summary.poolFee).toBe(POOL_FEE);
    expect(summary.gasEstimate).toBe(STAKE_GAS);
    expect(summary.totalCost).toBe(POOL_FEE + STAKE_GAS);
    expect(summary.feeCeiling).toBe(POOL_FEE + STAKE_GAS);
    // D-064: nothing to disclose, and the gate is not told to demand anything.
    expect(summary.disclosures).toEqual([]);
    expect(summary.requiresDisclosure).toBe(false);
    expect(summary.warnings.some((warning) => warning.kind === 'public-leg')).toBe(false);

    await panel.confirm();
    const settled = panel.store.getState();
    expect(settled.flow).toEqual({ name: 'submitted', transactionHash: '0xfake0001' });
    expect(settled.batch).toEqual([]);
    expect(settled.balance).toEqual({ status: 'unrequested' });
    expect(settled.notice).toEqual({ tone: 'info', text: COPY.balance.changed });
    expect(receipts.pending('bank')).toEqual([
      { building: 'bank', transactionHash: '0xfake0001', intents: [stakeIntent(strk('5'))] },
    ]);
    expect(operations.submitted).toEqual([[stakeIntent(strk('5'))]]);

    // STRK left the pool balance with the whole private fee; xSTRK landed as a
    // new pool note at the fake's fixed DEMO rate (4 per 5). The demo seam's
    // notes mature at once (D-072), so it is spendable straight away. The fake's
    // default window, with the output maturing first, is `fake-stake.test.ts`.
    const [strkAfter, xstrkAfter] = await operations.balances([STRK, ENDUR_XSTRK]);
    expect(strkAfter?.total).toBe(250n * ONE - strk('5') - POOL_FEE - STAKE_GAS);
    expect(xstrkAfter).toMatchObject({ spendable: 4n * ONE, maturing: 0n });

    panel.acknowledge();
    expect(panel.store.getState().flow).toEqual({ name: 'composing' });
    expect(receipts.pending('bank')).toEqual([]);
  });

  it('reuses the Bank balance, maturity and Max machinery for a stake', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * ONE } });
    // Ten STRK still maturing: counted in the total, never offered as spendable.
    await (await operations.prepare([{ kind: 'shield', token: STRK, amount: 10n * ONE }])).confirm({ feeCeiling: POOL_FEE });
    const panel = stakeCounter(operations);
    await panel.open();
    await panel.refreshBalance();
    expect(panel.store.getState().balance).toMatchObject({
      status: 'loaded',
      total: 110n * ONE,
      spendable: 100n * ONE,
      maturing: 10n * ONE,
      maturityKnown: true,
    });

    // No stake of this shape has been costed yet, so there is no maximum to state.
    expect(panel.maxSpendable()).toBeNull();
    panel.applyMax();
    expect(panel.store.getState().notice).toEqual({ tone: 'info', text: COPY.balance.costUnknown });

    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    panel.cancelPrepared();
    panel.clearBatch();

    // Evidence for the stake shape now exists: the maximum leaves both private
    // fees behind and never reaches into the maturing notes.
    const max = 100n * ONE - POOL_FEE - STAKE_GAS;
    expect(panel.maxSpendable()).toBe(max);
    panel.applyMax();
    expect(panel.store.getState().amountText).toBe(formatTokenAmountExact(max));
    await panel.addToBatch();
    await panel.prepare();
    expect(reviewSummary(panel).intents).toEqual([stakeIntent(max)]);
  });

  it('settles one stake at a time, even in Menu Mode', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * ONE }, registered: ['0x0456'] });
    const panel = menuBank(operations);
    await panel.open();
    panel.setMode('stake');
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setAmount('2');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toEqual([stakeIntent(strk('1'))]);
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.stakeAlone });

    // Nor beside another route queued from another tab.
    panel.clearBatch();
    panel.setMode('transfer');
    panel.setRecipient('0x0456');
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setMode('stake');
    panel.setAmount('1');
    await panel.addToBatch();
    expect(panel.store.getState().batch.map((intent) => intent.kind)).toEqual(['transfer']);
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.stakeAlone });
  });
});

describe('the staking counter on screen', () => {
  it('opens the staking station in the Endur look, with the where-from, where-to and unstaking lines', () => {
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={createDemoOperations({ funded: true })}>
        <VisitLayerView
          state={{ name: 'visiting', building: 'bank', surface: { name: 'station', station: 'bank:staking' } }}
          connected
          onOpenMenu={() => {}}
          onRequestExit={() => {}}
          onCloseSurface={() => {}}
          onDismissLocked={() => {}}
        />
      </PrivacyProvider>,
    );

    expect(markup).toContain('data-experience="station"');
    expect(markup).toMatch(/<section class="panel"[^>]*data-building="bank"[^>]*data-brand="endur"/);
    expect(markup).toContain(COPY.stake.eyebrow);
    expect(markup).toContain(COPY.stake.intro);
    expect(markup).toContain(escaped(COPY.stake.unstaking));
    expect(markup).toContain(COPY.stake.oneAtATime);
    expect(markup).toContain(COPY.gameMode.reviewAction);
    expect(markup).toMatch(/<button[^>]*role="tab"[^>]*>Stake<\/button>/);
    // A stake-only counter: no other grade shares the station (D-030).
    expect(markup).not.toContain('>Shield<');
    expect(markup).not.toContain('>Unshield<');
    expect(markup).not.toContain(COPY.bank.transfer);
    expect(markup).not.toContain(COPY.batch.add);
    expect(markup).not.toContain(COPY.batch.empty);
    // D-064: no disclosure anywhere on the counter.
    expect(markup).not.toContain('data-testid="disclosure"');
    expect(markup).not.toContain('commit-disclosures');
  });

  it('reviews STRK in exactly and names xSTRK out without inventing a figure', async () => {
    const operations = createDemoOperations({ funded: true });
    const panel = stakeCounter(operations);
    await panel.open();
    panel.setAmount('5');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, operations, 'station', ['stake']);
    expect(markup).toMatch(/data-brand="endur"/);
    expect(markup).toContain(`<dt>${COPY.stake.youStake}</dt><dd>${formatStrkExact(strk('5'))}</dd>`);
    expect(markup).toContain(COPY.stake.youReceive);
    expect(markup).toContain(escaped(COPY.glossary.xstrk));
    // Named, never numbered: the seam's prepared batch carries no xSTRK amount.
    expect(markup).toContain('<dd><span class="stake-token">xSTRK</span></dd>');
    expect(markup).toContain(escaped(COPY.stake.amountAtExecution));
    // The fake's demo rate (4 per 5) must never surface as a quote.
    expect(markup).not.toMatch(/\d[\d.]*\s*xSTRK/);
    // The exit constraint is said again at the moment of commitment.
    const gate = markup.slice(markup.indexOf('class="panel-review"'));
    expect(gate).toContain(escaped(COPY.stake.unstaking));
    // The shared gate, enabled with nothing to disclose.
    const confirm = markup.match(/<button[^>]*class="confirm"[^>]*>/)?.[0];
    expect(confirm).toBeDefined();
    expect(confirm).not.toContain('disabled');
    expect(markup).not.toContain('commit-disclosures');
    expect(markup).not.toContain(COPY.notices.disclosureMissing);
    expect(markup).toContain(formatStrkExact(POOL_FEE));
  });

  it('keeps the stake figures and the Endur look on screen while the wallet works', async () => {
    const operations = createDemoOperations({ funded: true });
    const panel = stakeCounter(operations);
    await panel.open();
    panel.setAmount('5');
    await panel.addToBatch();
    await panel.prepare();

    const submitting = panel.confirm();
    const markup = render(panel, operations, 'station', ['stake']);
    expect(panel.store.getState().flow.name).toBe('submitting');
    expect(markup).toContain('data-brand="endur"');
    expect(markup).toContain(COPY.flow.handingOver);
    expect(markup).toContain(COPY.flow.closingWillNotCancel);
    expect(markup).toContain(`<dd>${formatStrkExact(strk('5'))}</dd>`);
    expect(markup.match(/<button[^>]*class="confirm"[^>]*>/)?.[0]).toContain('disabled');
    await submitting;
  });

  it('adds a Stake tab to Bank Menu Mode, and only the stake view wears Endur', async () => {
    const operations = createDemoOperations({ funded: true });
    const panel = menuBank(operations);
    await panel.open();

    const shieldView = render(panel, operations, 'menu');
    expect(shieldView).toMatch(/<button[^>]*role="tab"[^>]*>Stake<\/button>/);
    expect(shieldView).not.toContain('data-brand=');

    panel.setMode('stake');
    const stakeView = render(panel, operations, 'menu');
    expect(stakeView).toContain('data-brand="endur"');
    expect(stakeView).toContain(COPY.stake.intro);
    expect(stakeView).toContain(COPY.stake.oneAtATime);
    // One stake at a time: no visit vocabulary that promises a shared fee.
    expect(stakeView).not.toContain(COPY.batch.add);
    expect(stakeView).not.toContain(COPY.batch.why);
    expect(stakeView).not.toContain(COPY.batch.empty);
  });

  it('lets the look follow the batch at the commit point, like the disclosures do', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * ONE }, registered: ['0x0456'] });
    const stakeQueued = menuBank(operations);
    await stakeQueued.open();
    stakeQueued.setMode('stake');
    stakeQueued.setAmount('1');
    await stakeQueued.addToBatch();
    stakeQueued.setMode('shield');
    await stakeQueued.prepare();
    const stakeReview = render(stakeQueued, operations, 'menu');
    expect(stakeReview).toContain('data-brand="endur"');
    expect(stakeReview).toContain(COPY.stake.youStake);

    const transferQueued = menuBank(operations);
    await transferQueued.open();
    transferQueued.setMode('transfer');
    transferQueued.setRecipient('0x0456');
    transferQueued.setAmount('1');
    await transferQueued.addToBatch();
    transferQueued.setMode('stake');
    await transferQueued.prepare();
    const transferReview = render(transferQueued, operations, 'menu');
    expect(transferReview).not.toContain('data-brand=');
    expect(transferReview).not.toContain(COPY.stake.youStake);
  });
});

describe('the bank:staking station', () => {
  it('is its own stake-only station in demo, beside shielding', () => {
    const resolved = resolveStation('bank', 'bank:staking');
    expect(resolved).toMatchObject({
      status: 'available',
      definition: {
        station: 'bank:staking',
        building: 'bank',
        label: 'STAKE',
        routes: ['bank.stake'],
        modes: ['stake'],
        initialMode: 'stake',
        view: 'bank',
      },
    });
    expect(stationSnapshot('bank')).toEqual([
      { station: 'bank:shielding', label: 'SHIELD / UNSHIELD', status: 'available' },
      { station: 'bank:staking', label: 'STAKE', status: 'available' },
    ]);
  });

  it('is locked as not switched on under the production default policy', () => {
    const productionDefault = parseRoutePolicy({});
    expect(productionDefault.enabledRoutes).not.toContain('stake');

    expect(resolveStation('bank', 'bank:staking', PRIVACY_REGISTER, {}, productionDefault)).toEqual({
      status: 'locked',
      definition: expect.objectContaining({ station: 'bank:staking' }),
      door: { open: false, reason: 'not-enabled', message: COPY.locked.notEnabled.stake },
    });
    expect(stationSnapshot('bank', PRIVACY_REGISTER, {}, productionDefault)).toContainEqual(
      { station: 'bank:staking', label: 'STAKE', status: 'locked' },
    );
  });

  it('opens only when the build switches staking on, and enabling it enables nothing else', () => {
    const stakeOnly = parseRoutePolicy({
      VITE_STRK20_STAKE_ENABLED: 'true',
      VITE_STRK20_STAKE_MAX_RELAY_FEE: '5',
      VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK},${ENDUR_XSTRK}`,
    });
    expect(resolveStation('bank', 'bank:staking', PRIVACY_REGISTER, {}, stakeOnly).status).toBe('available');
    expect(resolveStation('bank', 'bank:shielding', PRIVACY_REGISTER, {}, stakeOnly)).toMatchObject({
      status: 'locked',
      door: { reason: 'not-enabled' },
    });
  });
});
