// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type PrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import { ExchangePanel } from './ExchangePanel.js';

/**
 * The panel kit's proof of use: the Exchange's amount field shows the pool
 * balance of the asset being sold, and its Max leaves the 6 STRK pool fee
 * behind when STRK is sold.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const [strk, , usdc] = EXCHANGE_CATALOG;
const ONE = 10n ** 18n;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(operations: PrivacyOperations): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PrivacyProvider operations={operations}><ExchangePanel onClose={() => {}} /></PrivacyProvider>);
  });
  await settle();
  const show = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === COPY.balance.refresh)!;
  await act(async () => show.click());
  await settle();
}

const amount = () => container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
const max = () => container!.querySelector<HTMLButtonElement>(`button[aria-label="${COPY.kit.maxLabel}"]`)!;

describe('the Exchange amount field', () => {
  it('shows the pool balance of the asset being sold, and Max leaves the pool fee behind', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE + 1n, [usdc!.token]: 25_000_000n } }));
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Pool balance: 100 STRK');
    expect(container!.textContent).not.toContain(COPY.balance.feeReserved);

    await act(async () => max().click());
    expect(amount().value).toBe('94.000000000000000001');
    expect(container!.textContent).toContain(COPY.balance.feeReserved);
    // The 50% button is opt-in, and the Exchange does not opt in.
    expect(container!.querySelector(`button[aria-label="${COPY.kit.halfLabel}"]`)).toBeNull();
  });

  it('fills in the whole balance of an asset that does not pay the fee', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE, [usdc!.token]: 25_000_000n } }));
    const sell = [...container!.querySelectorAll('label')].find((label) => label.firstChild?.textContent === COPY.exchange.sell)!.querySelector('select')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(sell, usdc!.token);
      sell.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Pool balance: 25 USDC');
    await act(async () => max().click());
    expect(amount().value).toBe('25');
    expect(container!.textContent).not.toContain(COPY.balance.feeReserved);
  });

  it('offers no Max when the wallet reports only an aggregate balance (D-022)', async () => {
    const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE } });
    const read = operations.balances.bind(operations);
    operations.balances = async (...args) => (await read(...args)).map((entry) => ({ ...entry, spendable: 0n, maturing: 0n, maturityKnown: false }));
    await open(operations);
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Pool balance: 100 STRK');
    expect(max().disabled).toBe(true);
  });

  it('flags an amount over the pool balance in the field', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 10n * ONE } }));
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(amount(), '11');
      amount().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(amount().getAttribute('aria-invalid')).toBe('true');
    expect(container!.querySelector('.ui-amount-message')!.textContent).toBe(COPY.kit.exceedsBalance);
  });
});
