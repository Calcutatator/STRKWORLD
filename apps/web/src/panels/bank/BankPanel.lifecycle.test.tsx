// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type Address } from '@strkworld/privacy';
import type { ShellEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { parseTokenAmount } from '../../format.js';
import { BankPanel } from './BankPanel.js';
import { createBankPanel } from './bank-machine.js';

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('BankPanel HUD lifecycle', () => {
  it('clears the ambient pending indicator when unmounted during confirmation', async () => {
    const seam = new FakePrivacyOperations({
      balances: { [STRK]: parseTokenAmount('100')! },
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
          return { transactionHash: '0xhud-lifecycle' };
        },
      };
    };
    const panel = createBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const shell = createEventBus<ShellEvents>();
    const pending: number[] = [];
    shell.on('hud:pending', ({ count }) => pending.push(count));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider operations={seam} shellBus={shell}>
          <BankPanel panel={panel} onClose={() => {}} />
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
