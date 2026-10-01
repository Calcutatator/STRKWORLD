import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps, ReactElement } from 'react';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { SessionNoticeLayer } from '../../privacy/SessionNoticeLayer.js';
import { createSubmissionUncertainty } from '../../privacy/submission-uncertainty.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { COPY } from '../../copy.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import { ExchangePanel } from './ExchangePanel.js';
import { createExchangePanel } from './exchange-machine.js';

const [strk] = EXCHANGE_CATALOG;

// Keep the red regression on the component's public composition seam before
// the production prop is added to its declared props.
const ExchangePanelWithRegister = ExchangePanel as unknown as (props: ComponentProps<typeof ExchangePanel> & {
  register: readonly RouteGrade[];
}) => ReactElement;

async function reviewed() {
  const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * 10n ** 18n }, swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 4_102_444_800_000 } });
  const panel = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
  await panel.open(); await panel.refreshBalances(); panel.setAmount('1'); await panel.prepare();
  return { operations, panel };
}

describe('ExchangePanel review render', () => {
  it('uses the supplied route authority for the Exchange door', () => {
    const disabled: readonly RouteGrade[] = PRIVACY_REGISTER.map((entry) => entry.route === 'exchange.swap'
      ? { ...entry, disclosure: null, approvedBy: null, approvedOn: null, rationale: null }
      : entry);
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <ExchangePanelWithRegister register={disabled} onClose={() => {}} />
      </PrivacyProvider>,
    );
    expect(markup).toContain('data-lock-reason="unapproved-route"');
    expect(markup).not.toContain('Show my balance');
  });

  it('shows the avatar attention cue while a requested private balance waits on the wallet', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [strk!.token]: 100n * 10n ** 18n },
      latencyMs: 2,
    });
    const panel = createExchangePanel({
      operations,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
    });
    await panel.open();

    const loading = panel.refreshBalances();
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={operations}>
        <ExchangePanel panel={panel} onClose={() => {}} />
      </PrivacyProvider>,
    );
    expect(markup).toContain('data-wallet-attention="balance"');
    expect(markup).toMatch(/<img[^>]+avatar-walker\/walk\.png/);
    await loading;

    const loaded = renderToStaticMarkup(
      <PrivacyProvider operations={operations}>
        <ExchangePanel panel={panel} onClose={() => {}} />
      </PrivacyProvider>,
    );
    expect(loaded).not.toContain('data-wallet-attention');
  });

  it('puts canonical review figures and the D-024 disclosure inside ConfirmGate', async () => {
    const { operations, panel } = await reviewed();
    const markup = renderToStaticMarkup(<PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>);
    const gate = markup.slice(markup.indexOf('class="confirm-gate"'));
    for (const value of ['1 STRK', '2 ETH', '1.99 ETH', '0.50%', '2100-01-01T00:00:00.000Z', '6 STRK', '0 STRK', 'This swap hides who traded, but not the tokens or amounts. The executor and public exchange activity are visible on-chain.']) expect(gate).toContain(value);
    expect(gate).toContain('class="confirm"');
  });

  it('shows the rate, the oracle value of each side and the price check inside ConfirmGate (D-084)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [strk!.token]: 100n * 10n ** 18n },
      swapReview: {
        expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 4_102_444_800_000,
        priceCheck: { status: 'checked', boundBps: 300, shortfallBps: 120, sellUsd: 123_456_789_000n, expectedBuyUsd: 121_975_000_000n },
      },
    });
    const panel = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await panel.open(); await panel.refreshBalances(); panel.setAmount('1'); await panel.prepare();
    const markup = renderToStaticMarkup(<PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>);
    const gate = markup.slice(markup.indexOf('class="confirm-gate"'));
    for (const value of ['1 STRK ≈ 2 ETH', '≈ $1,234.57', '≈ $1,219.75', "1.20% below Pragma&#x27;s oracle price, within the 3% allowed."]) expect(gate).toContain(value);
    expect(gate).not.toContain('type="checkbox"');
  });

  it('asks for an explicit acknowledgement when nothing independent prices the pair (D-084)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [strk!.token]: 100n * 10n ** 18n },
      swapReview: {
        expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 4_102_444_800_000,
        priceCheck: { status: 'unchecked', boundBps: 300, sellUsd: 4_310_000n },
      },
    });
    const panel = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await panel.open(); await panel.refreshBalances(); panel.setAmount('1'); await panel.prepare();
    const markup = renderToStaticMarkup(<PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>);
    const gate = markup.slice(markup.indexOf('class="confirm-gate"'));
    expect(gate).toContain('data-status="unchecked"');
    expect(gate).toContain('type="checkbox"');
    expect(gate).toContain(COPY.exchange.acknowledgeUnchecked);
    expect(gate).toContain('≈ $0.04');

    // Confirming without the tick sends nothing and says why.
    await panel.confirm();
    expect(operations.submitted).toEqual([]);
    expect(panel.store.getState()).toMatchObject({ flow: { name: 'review' }, notice: COPY.exchange.acknowledgeFirst });
    panel.acknowledgeUncheckedPrice(true);
    await panel.confirm();
    expect(panel.store.getState().flow).toMatchObject({ name: 'submitted' });
    expect(operations.submitted).toHaveLength(1);
  });

  it('resets the acknowledgement with every new review', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [strk!.token]: 100n * 10n ** 18n },
      swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 4_102_444_800_000, priceCheck: { status: 'unchecked', boundBps: 300 } },
    });
    const panel = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true, quoteSpacingMs: 0 });
    await panel.open(); await panel.refreshBalances(); panel.setAmount('1'); await panel.prepare();
    panel.acknowledgeUncheckedPrice(true);
    expect(panel.store.getState().priceAcknowledged).toBe(true);
    panel.setAmount('2'); await panel.prepare();
    expect(panel.store.getState().priceAcknowledged).toBe(false);
  });

  it('removes the review confirmation behind unacknowledged submission uncertainty', async () => {
    const { operations, panel } = await reviewed(); const uncertainty = createSubmissionUncertainty(); uncertainty.retain();
    const markup = renderToStaticMarkup(<PrivacyProvider operations={operations} submissionUncertainty={uncertainty}><ExchangePanel panel={panel} onClose={() => {}} /><SessionNoticeLayer /></PrivacyProvider>);
    expect(markup).not.toContain('class="confirm-gate"');
    expect(markup).toContain('We could not confirm whether this private action was submitted.');
  });

  it('keeps a settled receipt visible behind unrelated submission uncertainty', async () => {
    const { operations, panel } = await reviewed();
    await panel.confirm();
    const flow = panel.store.getState().flow;
    expect(flow.name).toBe('submitted');
    if (flow.name !== 'submitted') return;
    const uncertainty = createSubmissionUncertainty();
    uncertainty.retain();

    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={operations} submissionUncertainty={uncertainty}>
        <ExchangePanel panel={panel} onClose={() => {}} />
        <SessionNoticeLayer />
      </PrivacyProvider>,
    );

    expect(markup).toContain('Sent.');
    expect(markup).toContain(flow.transactionHash);
    expect(markup).toContain('Back to the counter');
    expect(markup).toContain('We could not confirm whether this private action was submitted.');
  });

  it('gives protected minimum, slippage, pool fee, network cost and quote expiry an accessible disclosure', async () => {
    const { operations, panel } = await reviewed();
    const markup = renderToStaticMarkup(<PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>);
    const gate = markup.slice(markup.indexOf('class="confirm-gate"'));
    for (const definition of [
      COPY.glossary.protectedMinimum,
      COPY.glossary.poolFee,
      COPY.glossary.networkCost,
      COPY.glossary.quoteExpiry,
    ]) {
      expect(gate).toContain(definition);
    }
    // Slippage says plainly that it is fixed, and at what value (D-042).
    expect(gate).toContain(COPY.glossary.slippageFixedAt);
    expect(gate).toContain('0.50%');
    expect(gate).toContain(COPY.glossary.slippageReason);
    // Native <details>/<summary>: keyboard-reachable and screen-reader exposed, not hover-only.
    expect((gate.match(/<details class="glossary-term">/g) ?? [])).toHaveLength(5);
  });

  it('tells the player a restored receipt settled while the room was shut, not that it was just sent', async () => {
    const ledger = createReceiptLedger();
    ledger.record({ building: 'exchange', transactionHash: '0xrestored-swap', intents: [] });
    const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * 10n ** 18n } });
    const panel = createExchangePanel({ operations, receipts: ledger, canStartFinancialAction: () => true });
    await panel.open();

    const markup = renderToStaticMarkup(<PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>);
    expect(markup).toContain(COPY.flow.receiptWaiting);
    expect(markup).not.toContain('Sent.');
  });
});
