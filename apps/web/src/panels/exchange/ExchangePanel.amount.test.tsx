// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type PrivacyOperations, type SwapPriceCheck } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import { ExchangePanel } from './ExchangePanel.js';
import { createExchangePanel, type ExchangePanel as ExchangeMachine } from './exchange-machine.js';

/**
 * The Exchange's swap view (D-089), driven through the screen: Sell with its
 * pool balance, 50% and Max; the flip; Buy filled from the live quote; the
 * rate line and its invert; the four rows; the slippage cog; and the button's
 * words. The review and its confirm are `ExchangePanel.test.tsx`'s.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const [strk, eth, usdc] = EXCHANGE_CATALOG;
const ONE = 10n ** 18n;
const FAR = 4_102_444_800_000;

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
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A counter that quotes live at once, so the screen shows the Buy side without a real wait. */
function machine(operations: PrivacyOperations, options: { slippageCeilingBps?: number } = {}): ExchangeMachine {
  return createExchangePanel({
    operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true,
    quoteSpacingMs: 0, liveQuoteDelayMs: 0, ...options,
  });
}

async function open(operations: PrivacyOperations, panel = machine(operations)): Promise<ExchangeMachine> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await panel.open();
  await act(async () => {
    root!.render(<PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>);
  });
  await settle();
  await click(button(COPY.balance.refresh));
  return panel;
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

function select(label: string): HTMLSelectElement {
  const found = [...container!.querySelectorAll('label')].find((candidate) => candidate.textContent === label)!;
  return container!.querySelector<HTMLSelectElement>(`select[id="${found.htmlFor}"]`)!;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function choose(control: HTMLSelectElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(control, value);
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

const amount = () => container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
const bought = () => container!.querySelector<HTMLInputElement>('input[name="buy-amount"]')!;
const submit = () => container!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const rows = () => Object.fromEntries([...container!.querySelectorAll('.ui-detail')].map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]));

describe('the Exchange swap: the Sell side', () => {
  it('shows the pool balance of the asset being sold, and Max leaves the pool fee behind', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE + 1n, [usdc!.token]: 25_000_000n } }));
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Pool balance: 100 STRK');
    expect(container!.textContent).not.toContain(COPY.balance.feeReserved);

    await click(button(COPY.kit.maxLabel));
    expect(amount().value).toBe('94.000000000000000001');
    expect(container!.textContent).toContain(COPY.balance.feeReserved);
  });

  it('fills in half of what Max would with 50%', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 106n * ONE } }));
    await click(button(COPY.kit.halfLabel));
    expect(amount().value).toBe('50');
  });

  it('fills in the whole balance of an asset that does not pay the fee', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE, [usdc!.token]: 25_000_000n } }));
    await choose(select(COPY.exchange.sellToken), usdc!.token);
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Pool balance: 25 USDC');
    await click(button(COPY.kit.maxLabel));
    expect(amount().value).toBe('25');
    expect(container!.textContent).not.toContain(COPY.balance.feeReserved);
  });

  it('offers Max from the per-token total when the wallet reports no spendable split (D-089, amending D-022)', async () => {
    const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE } });
    const read = operations.balances.bind(operations);
    operations.balances = async (...args) => (await read(...args)).map((entry) => ({ ...entry, spendable: 0n, maturing: 0n, maturityKnown: false }));
    await open(operations);
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Pool balance: 100 STRK');
    await click(button(COPY.kit.maxLabel));
    expect(amount().value).toBe('94');
  });

  it('turns Max off when the fee token is all there is and leaves too little for the fee', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 6n * ONE } }));
    expect(button(COPY.kit.maxLabel).disabled).toBe(true);
    expect(button(COPY.kit.halfLabel).disabled).toBe(true);
  });

  it('flags an amount over the pool balance in the field and on the button', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 10n * ONE } }));
    expect(submit().textContent).toBe(COPY.kit.enterAmount);
    expect(submit().disabled).toBe(true);
    await type(amount(), '11');
    expect(amount().getAttribute('aria-invalid')).toBe('true');
    expect(container!.querySelector('.ui-amount-message')!.textContent).toBe(COPY.kit.exceedsBalance);
    expect(submit().textContent).toBe('Insufficient STRK');
    expect(submit().disabled).toBe(true);
  });
});

describe('the Exchange swap: the live quote', () => {
  const quoted = (priceCheck?: SwapPriceCheck) => new FakePrivacyOperations({
    balances: { [strk!.token]: 100n * ONE, [eth!.token]: 5n * ONE },
    swapReview: { expectedAmountOut: 2n * ONE, slippageBps: 50, expiresAt: FAR, ...(priceCheck ? { priceCheck } : {}) },
  });

  it('fills the read-only Buy side, the USD values, the rate and the four rows, then Review takes that quote', async () => {
    const operations = quoted({ status: 'checked', boundBps: 300, shortfallBps: 42, sellUsd: 4_310_000_00n, expectedBuyUsd: 4_291_900_00n });
    const prepare = vi.spyOn(operations, 'prepare');
    await open(operations);
    expect(bought().readOnly).toBe(true);
    expect(bought().value).toBe('');

    await type(amount(), '1');
    expect(bought().value).toBe('2');
    expect([...container!.querySelectorAll('.ui-amount-usd')].map((line) => line.textContent)).toEqual(['≈ $4.31', '≈ $4.29']);
    expect(container!.querySelector('.exchange-rate')!.textContent).toContain('1 STRK ≈ 2 ETH');
    expect(rows()).toEqual({
      [COPY.exchange.receiveAtLeast]: '1.99 ETH',
      [COPY.exchange.priceImpact]: '0.42%',
      [COPY.bank.poolFee]: '6 STRK',
      [COPY.exchange.route]: COPY.exchange.routeAvnu,
    });
    expect(submit().textContent).toBe(COPY.exchange.review);

    await click(button(COPY.kit.invert));
    expect(container!.querySelector('.exchange-rate')!.textContent).toContain('1 ETH ≈ 0.5 STRK');

    await click(submit());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('.confirm-gate')!.textContent).toContain('1.99 ETH');
  });

  it('says when Pragma prices too little for a price impact, and notes who chooses the fee token for a non-STRK sell', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [strk!.token]: 100n * ONE, [usdc!.token]: 25_000_000n },
      swapReview: { expectedAmountOut: 2n * ONE, slippageBps: 50, expiresAt: FAR, priceCheck: { status: 'unchecked', boundBps: 300 } },
    });
    await open(operations);
    await choose(select(COPY.exchange.sellToken), usdc!.token);
    await type(amount(), '1');
    expect(rows()[COPY.exchange.priceImpact]).toBe(COPY.exchange.priceImpactUnknown);
    expect(rows()[COPY.bank.poolFee]).toBe(`6 STRK${COPY.exchange.poolFeeToken}`);
  });

  it('warns about a price impact above 3%', async () => {
    await open(quoted({ status: 'checked', boundBps: 1_000, shortfallBps: 450 }));
    await type(amount(), '1');
    const impact = [...container!.querySelectorAll('.ui-detail')].find((row) => row.querySelector('dt')!.textContent === COPY.exchange.priceImpact)!;
    expect(impact.getAttribute('data-tone')).toBe('warning');
    expect(impact.textContent).toContain(COPY.exchange.priceImpactHigh);
  });

  it('flips the sides with the arrow, carrying the quoted output into Sell', async () => {
    await open(quoted());
    await type(amount(), '1');
    await click(button(COPY.kit.flip));
    expect(select(COPY.exchange.sellToken).value).toBe(eth!.token);
    expect(select(COPY.exchange.buyToken).value).toBe(strk!.token);
    expect(amount().value).toBe('2');
  });

  it('turns the arrow off when the pool holds none of the asset being bought', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE } }));
    expect(button(COPY.kit.flip).disabled).toBe(true);
  });
});

describe('the Exchange swap: the slippage cog', () => {
  const cog = () => button(`${COPY.kit.settings}: ${COPY.exchange.slippageTitle}`);
  const custom = () => container!.querySelector<HTMLInputElement>('.ui-settings-custom input')!;

  it('keeps slippage behind the cog: 0.1%, 0.5% (chosen) and 1%, and a custom value', async () => {
    await open(new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE } }));
    expect(container!.querySelector('.ui-settings-popover')).toBeNull();
    await click(cog());
    const presets = [...container!.querySelectorAll('.ui-settings-presets > button')];
    expect(presets.map((preset) => [preset.textContent, preset.getAttribute('aria-pressed')])).toEqual([['0.1%', 'false'], ['0.5%', 'true'], ['1%', 'false']]);
    expect(container!.textContent).toContain(COPY.exchange.slippageHint);
    expect(custom()).not.toBeNull();
  });

  it('warns above 1%, refuses above 3% on the button, and carries the choice to the swap', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [strk!.token]: 100n * ONE },
      swapReview: { expectedAmountOut: 2n * ONE, slippageBps: 50, expiresAt: FAR },
    });
    const prepare = vi.spyOn(operations, 'prepare');
    await open(operations);
    await type(amount(), '1');
    await click(cog());

    await type(custom(), '1.5');
    expect(custom().value).toBe('1.5');
    expect(container!.querySelector('.ui-settings-warning')!.textContent).toBe(COPY.exchange.slippageHigh);

    await type(custom(), '3.5');
    expect(container!.querySelector('.ui-settings-warning')!.textContent).toBe('Enter a value up to 3%.');
    expect(submit().textContent).toBe(COPY.exchange.slippageFix);
    expect(submit().disabled).toBe(true);

    await click([...container!.querySelectorAll<HTMLButtonElement>('.ui-settings-presets > button')].find((preset) => preset.textContent === '1%')!);
    expect(prepare.mock.calls.at(-1)![0][0]).toMatchObject({ slippageBps: 100 });
    expect(rows()[COPY.exchange.receiveAtLeast]).toBe('1.98 ETH');
  });

  it('offers nothing above the build ceiling', async () => {
    const operations = new FakePrivacyOperations({ balances: { [strk!.token]: 100n * ONE } });
    await open(operations, machine(operations, { slippageCeilingBps: 50 }));
    await click(cog());
    expect([...container!.querySelectorAll('.ui-settings-presets > button')].map((preset) => preset.textContent)).toEqual(['0.1%', '0.5%']);
  });
});
