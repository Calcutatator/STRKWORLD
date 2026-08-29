import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { SessionNoticeLayer } from '../../privacy/SessionNoticeLayer.js';
import { createSubmissionUncertainty } from '../../privacy/submission-uncertainty.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import { ExchangePanel } from './ExchangePanel.js';
import { createExchangePanel } from './exchange-machine.js';

const [strk] = EXCHANGE_CATALOG;

async function reviewed() {
  const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * 10n ** 18n }, swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 4_102_444_800_000 } });
  const panel = createExchangePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
  await panel.open(); await panel.refreshBalances(); panel.setAmount('1'); await panel.prepare();
  return { operations, panel };
}

describe('ExchangePanel review render', () => {
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
    expect(markup).toMatch(/<img[^>]+avatar-1\.png/);
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
    for (const value of ['1 STRK', '2 ETH', '1.99 ETH', '0.50%', '2100-01-01T00:00:00.000Z', '6 STRK', '0.002 STRK', '6.002 STRK', 'This swap hides who traded, but not the tokens or amounts. The executor and public exchange activity are visible on-chain.']) expect(gate).toContain(value);
    expect(gate).toContain('class="confirm"');
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
});
