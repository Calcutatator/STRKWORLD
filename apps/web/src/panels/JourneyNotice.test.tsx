// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { LocalBridgeStore, type BridgeRecord } from '@strkworld/bridge';
import { FakePrivacyOperations, type Address, type Intent } from '@strkworld/privacy';
import type { WorldEvents } from '@strkworld/shared';
import { ArrivalNudgeProvider } from '../bridge/ArrivalNudgeProvider.js';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { parseTokenAmount } from '../format.js';
import { PrivacyProvider, usePrivacy } from '../privacy/PrivacyProvider.js';
import type { ReceiptLedger } from '../receipts/receipt-ledger.js';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { BankPanel } from './bank/BankPanel.js';
import { createBankPanel } from './bank/bank-machine.js';
import { EXCHANGE_CATALOG } from './exchange/catalog.js';
import { ReceiptNextStep } from './JourneyNotice.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ETH = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'ETH')!.token;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

function render(element: ReactElement): HTMLElement {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const owner = root!;
  act(() => owner.render(element));
  return container;
}

/** A deposit the Bridge saw settle: STRK landed publicly for the demo account. */
function settledBridgeRecord(): BridgeRecord {
  return {
    v: 1,
    createdAt: 1_000,
    updatedAt: 1_001,
    source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
    amountIn: 1_000_000n,
    starknetRecipient: '0x123',
    refundAddress: '0x1111111111111111111111111111111111111111',
    signedQuote: {
      correlationId: 'corr',
      timestamp: '2026-08-18T00:00:00.000Z',
      signature: 'sig',
      quoteRequest: { recipient: '0x123', deadline: '2030-08-18T00:30:00.000Z', slippageTolerance: 100 },
      quote: { depositAddress: '0xdeposit', deadline: '2030-08-18T00:30:00.000Z' },
    } as unknown as QuoteResponse,
    status: { leg: 'settled', settlementTxHash: '0xsettled', strkReceived: 5n * 10n ** 18n, message: 'STRK arrived.', pollingStopped: true },
  };
}

/**
 * The provider's own ledger, so a driven machine records where the window's
 * notice reads — exactly as an owned machine does.
 */
function withLedger(operations: FakePrivacyOperations, children: ReactNode = null): {
  ledger: () => ReceiptLedger;
  tree: (next: ReactNode) => ReactElement;
} {
  let held: ReceiptLedger | null = null;
  function Capture() {
    held = usePrivacy().receipts;
    return null;
  }
  const tree = (next: ReactNode) => (
    <PrivacyProvider operations={operations}>
      <Capture />
      {next}
    </PrivacyProvider>
  );
  render(tree(children));
  return {
    ledger: () => {
      if (!held) throw new Error('no ledger');
      return held;
    },
    tree,
  };
}

describe('journey notices in building windows', () => {
  it('suggests the next step at the top of the Bank receipt after a shield, and clears on acknowledge', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: parseTokenAmount('100')! } });
    const harness = withLedger(operations);
    const panel = createBankPanel({ operations, receipts: harness.ledger(), canStartFinancialAction: () => true });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    let view = render(harness.tree(<BankPanel panel={panel} onClose={() => {}} />));
    // At the commit point only the batch's own disclosures belong on screen.
    expect(panel.store.getState().flow.name).toBe('review');
    expect(view.querySelector('.journey-next')).toBeNull();

    await act(async () => {
      await panel.confirm();
    });
    expect(panel.store.getState().flow.name).toBe('submitted');
    view = render(harness.tree(<BankPanel panel={panel} onClose={() => {}} />));
    const notice = view.querySelector('.journey-next');
    expect(notice?.textContent).toBe(COPY.next.afterShield);
    expect(notice?.getAttribute('role')).toBe('status');
    expect(view.querySelector('.panel-body')?.firstElementChild).toBe(notice);
    expect(view.querySelector('.flow-done')).not.toBeNull();

    act(() => panel.acknowledge());
    expect(view.querySelector('.journey-next')).toBeNull();
  });

  it('keeps the Bridge nudge through a shield: only the player ends it (D-043)', async () => {
    const values = new Map<string, string>();
    const page: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    new LocalBridgeStore(page).save(settledBridgeRecord());
    const savedBefore = new Map(values);
    const viewer = createViewerStorage(() => page);
    const world = createEventBus<WorldEvents>();
    const operations = new FakePrivacyOperations({ balances: { [STRK]: parseTokenAmount('100')! } });
    const harness = withLedger(operations);
    const panel = createBankPanel({ operations, receipts: harness.ledger(), canStartFinancialAction: () => true });
    await panel.open();
    const bankWindow = (): ReactElement => harness.tree(
      <ArrivalNudgeProvider world={world} storage={viewer}>
        <BankPanel panel={panel} onClose={() => {}} />
      </ArrivalNudgeProvider>,
    );

    let view = render(bankWindow());
    expect(view.querySelector('.journey-arrival p')?.textContent).toBe(COPY.next.bridgeArrivalHere);
    expect(view.querySelector('.panel-body')?.firstElementChild?.classList.contains('journey-arrival')).toBe(true);

    panel.setAmount('1');
    await act(async () => {
      await panel.addToBatch();
      await panel.prepare();
    });
    expect(view.querySelector('.journey-arrival')).toBeNull();
    await act(async () => {
      await panel.confirm();
    });
    view = render(bankWindow());
    expect(view.querySelector('.journey-next')?.textContent).toBe(COPY.next.afterShield);
    expect(view.querySelector('.journey-arrival')).toBeNull();

    // Back at the counter the reminder returns: nothing links this shield to
    // the bridged STRK, so nothing may retire the nudge on its behalf.
    act(() => panel.acknowledge());
    expect(view.querySelector('.journey-arrival p')?.textContent).toBe(COPY.next.bridgeArrivalHere);
    // The shield wrote nothing to this browser: the Bridge record is exactly
    // as it was, and no new key links the two.
    expect(values).toEqual(savedBefore);

    act(() => {
      view.querySelector('.journey-arrival button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.querySelector('.journey-arrival')).toBeNull();
  });

  it('keeps the Bridge nudge out of the staking counter, which has no shield to offer', async () => {
    const values = new Map<string, string>();
    const page: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    new LocalBridgeStore(page).save(settledBridgeRecord());
    const viewer = createViewerStorage(() => page);
    const world = createEventBus<WorldEvents>();
    const operations = new FakePrivacyOperations({ balances: { [STRK]: parseTokenAmount('100')! } });
    const harness = withLedger(operations);
    const counter = (modes: readonly ('shield' | 'stake')[]): ReactElement => {
      const panel = createBankPanel({
        operations,
        receipts: harness.ledger(),
        allowedModes: modes,
        initialMode: modes[0],
        canStartFinancialAction: () => true,
      });
      void panel.open();
      return harness.tree(
        <ArrivalNudgeProvider world={world} storage={viewer}>
          <BankPanel panel={panel} experience="station" mode={modes[0]} onClose={() => {}} />
        </ArrivalNudgeProvider>,
      );
    };

    // "Shield it here" belongs where shielding is; the staking station has none.
    let view = render(counter(['stake']));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.querySelector('.journey-arrival')).toBeNull();

    view = render(counter(['shield']));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.querySelector('.journey-arrival p')?.textContent).toBe(COPY.next.bridgeArrivalHere);
  });

  it('wraps up a Post Office transfer and sends an Exchange STRK purchase on', () => {
    const operations = new FakePrivacyOperations();
    const harness = withLedger(operations);
    const transfer: Intent = { kind: 'transfer', token: STRK, amount: 1n, recipient: '0x0456' };
    const boughtStrk: Intent = { kind: 'swap', tokenIn: ETH, tokenOut: STRK, amountIn: 1n, minAmountOut: 1n };
    const boughtEth: Intent = { kind: 'swap', tokenIn: STRK, tokenOut: ETH, amountIn: 1n, minAmountOut: 1n };
    act(() => {
      harness.ledger().record({ building: 'post-office', transactionHash: '0x1', intents: [transfer] });
      harness.ledger().record({ building: 'exchange', transactionHash: '0x2', intents: [boughtStrk] });
      harness.ledger().record({ building: 'exchange', transactionHash: '0x3', intents: [boughtEth] });
    });

    const view = render(harness.tree(
      <>
        <div data-receipt="transfer"><ReceiptNextStep building="post-office" transactionHash="0x1" /></div>
        <div data-receipt="strk"><ReceiptNextStep building="exchange" transactionHash="0x2" /></div>
        <div data-receipt="eth"><ReceiptNextStep building="exchange" transactionHash="0x3" /></div>
        <div data-receipt="elsewhere"><ReceiptNextStep building="bank" transactionHash="0x1" /></div>
        <div data-receipt="none"><ReceiptNextStep building="exchange" transactionHash={null} /></div>
      </>,
    ));
    expect(view.querySelector('[data-receipt="transfer"]')?.textContent).toBe(COPY.next.afterTransfer);
    expect(view.querySelector('[data-receipt="strk"]')?.textContent).toBe(COPY.next.afterSwap);
    expect(view.querySelector('[data-receipt="eth"]')?.textContent).toBe('');
    // A receipt belongs to the building that produced it.
    expect(view.querySelector('[data-receipt="elsewhere"]')?.textContent).toBe('');
    expect(view.querySelector('[data-receipt="none"]')?.textContent).toBe('');

    // Acknowledging the receipt retires its prompt with it.
    act(() => harness.ledger().acknowledge('0x2'));
    expect(view.querySelector('[data-receipt="strk"]')?.textContent).toBe('');
  });
});
