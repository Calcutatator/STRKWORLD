// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type Address } from '@strkworld/privacy';
import type { ShellEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { ExchangePanel } from './ExchangePanel.js';
import { createExchangePanel } from './exchange-machine.js';
import { EXCHANGE_CATALOG } from './catalog.js';

const STRK: Address = EXCHANGE_CATALOG[0]!.token;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ExchangePanel HUD lifecycle', () => {
  it('publishes pending state during confirmation and clears it on unmount', async () => {
    const seam = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      swapReview: { expectedAmountOut: 2n * 10n ** 18n, slippageBps: 50, expiresAt: 4_102_444_800_000 },
    });
    const confirmation = deferred<void>();
    const entered = deferred<void>();
    const originalPrepare = seam.prepare.bind(seam);
    seam.prepare = async (...args) => {
      const batch = await originalPrepare(...args);
      return {
        ...batch,
        confirm: async (options: Parameters<typeof batch.confirm>[0]) => {
          options.onProgress?.({ stage: 'awaiting-approval', message: 'Waiting for wallet approval.' });
          entered.resolve();
          await confirmation.promise;
          return { transactionHash: '0xexchange-hud-lifecycle' };
        },
      };
    };
    const panel = createExchangePanel({
      operations: seam,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
    });
    await panel.open();
    await panel.refreshBalances();
    panel.setAmount('1');
    await panel.prepare();

    const shell = createEventBus<ShellEvents>();
    const pending: number[] = [];
    shell.on('hud:pending', ({ count }) => pending.push(count));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider operations={seam} shellBus={shell}>
          <ExchangePanel panel={panel} onClose={() => {}} />
        </PrivacyProvider>,
      );
    });
    let submission!: Promise<void>;
    await act(async () => {
      submission = panel.confirm().then(() => undefined);
      await entered.promise;
    });
    expect(pending.at(-1)).toBe(1);

    await act(async () => root.unmount());
    expect(pending.at(-1)).toBe(0);

    confirmation.resolve();
    await submission;
    container.remove();
  });
});
