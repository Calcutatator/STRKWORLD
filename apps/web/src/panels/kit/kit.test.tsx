// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../../copy.js';
import { AmountField, BeforeAfter, DetailRows, FlipButton, InvertibleRate, QuoteTimer, SettingsPopover, TokenSelect, feeReserve, maxAfterReserve } from './index.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ONE = 10n ** 18n;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
  vi.useRealTimers();
});

function render(element: ReactElement): HTMLElement {
  container = document.createElement('div');
  container.className = 'panel';
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === name || candidate.textContent === name);
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

function type(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** An AmountField with its own state, as a panel would hold it. */
function Field(props: Partial<Parameters<typeof AmountField>[0]> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '');
  return <AmountField label="Amount" decimals={18} symbol="STRK" {...props} value={value} onChange={setValue} />;
}

describe('AmountField', () => {
  it('has no Max or 50% unless the panel asks for them', () => {
    const view = render(<Field balance={12n * ONE} />);
    expect(view.querySelectorAll('button')).toHaveLength(0);
    expect(view.querySelector('.ui-amount-balance')!.textContent).toBe(`${COPY.kit.poolBalance}: 12 STRK`);
  });

  it('shows the pool balance, shortened, and no line without one', () => {
    render(<Field balance={12n * ONE + 5n * 10n ** 17n} />);
    expect(container!.textContent).toContain('Pool balance: 12.5 STRK');
    act(() => root!.render(<Field />));
    expect(container!.querySelector('.ui-amount-balance')).toBeNull();
  });

  it('fills in the balance less the 6 STRK pool fee on Max, exactly', () => {
    const spendable = 12n * ONE + 5n * 10n ** 17n + 1n;
    render(<Field balance={spendable} max={() => maxAfterReserve(spendable, feeReserve(STRK, { feeAmount: 6n * ONE, feeToken: STRK }))} />);
    act(() => button(COPY.kit.maxLabel).click());
    expect(container!.querySelector('input')!.value).toBe('6.500000000000000001');
  });

  it('fills in half of the maximum on 50%', () => {
    render(<Field max={() => 13n * ONE} half />);
    act(() => button(COPY.kit.halfLabel).click());
    expect(container!.querySelector('input')!.value).toBe('6.5');
  });

  it('disables Max when there is no honest maximum', () => {
    render(<Field max={() => null} half />);
    expect(button(COPY.kit.maxLabel).disabled).toBe(true);
    expect(button(COPY.kit.halfLabel).disabled).toBe(true);
  });

  it('says what is wrong with an amount, and ties the words to the input', () => {
    render(<Field balance={10n * ONE} minimum={ONE} />);
    const input = container!.querySelector('input')!;
    const message = () => container!.querySelector('.ui-amount-message')!.textContent;

    type(input, '11');
    expect(message()).toBe(COPY.kit.exceedsBalance);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(container!.querySelector('.ui-amount-message')!.id);

    type(input, '0.5');
    expect(message()).toBe('The minimum is 1 STRK.');

    type(input, '1.2.3');
    expect(message()).toBe(COPY.kit.invalidDetail);

    type(input, '2');
    expect(message()).toBe('');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('takes a panel\'s own balance words and message, as a redeem against what is supplied', () => {
    render(<Field balance={10n * ONE} balanceLabel="Supplied" exceedsMessage="More than you have supplied" />);
    expect(container!.querySelector('.ui-amount-balance')!.textContent).toBe('Supplied: 10 STRK');
    type(container!.querySelector('input')!, '11');
    expect(container!.querySelector('.ui-amount-message')!.textContent).toBe('More than you have supplied');
  });

  it('labels the input, keeps the panels\' amount name, and shows a USD line and hint', () => {
    render(<Field usd="≈ $4.20" hint="Leaves the fee behind." />);
    const input = container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
    expect(input.labels?.[0]?.textContent).toBe('Amount');
    expect(input.inputMode).toBe('decimal');
    expect(container!.textContent).toContain('≈ $4.20');
    expect(input.getAttribute('aria-describedby')).toBe(container!.querySelector('.ui-amount-hint')!.id);
  });

  it('shows a read-only figure with no Max and no validation, a skeleton while busy, dimmed when stale', () => {
    render(<AmountField label="Buy" decimals={18} symbol="ETH" value="2" onChange={() => {}} readOnly max={() => ONE} balance={ONE} />);
    const input = container!.querySelector('input')!;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('2');
    expect(container!.querySelectorAll('button')).toHaveLength(0);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    act(() => root!.render(<AmountField label="Buy" decimals={18} symbol="ETH" value="2" onChange={() => {}} readOnly busy />));
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(container!.querySelector('.ui-amount')!.getAttribute('data-busy')).toBe('true');
    act(() => root!.render(<AmountField label="Buy" decimals={18} symbol="ETH" value="2" onChange={() => {}} readOnly stale />));
    expect(input.value).toBe('2');
    expect(container!.querySelector('.ui-amount')!.getAttribute('data-stale')).toBe('true');
  });

  it('takes a token selector in its slot', () => {
    render(<Field token={<TokenSelect label="Token" labelHidden value={STRK} options={[{ token: STRK, symbol: 'STRK', decimals: 18 }]} onChange={() => {}} />} />);
    expect(container!.querySelector('.ui-amount-token select')).not.toBeNull();
  });
});

describe('TokenSelect', () => {
  it('shows each token with its balance and reports the choice', () => {
    const onChange = vi.fn();
    render(<TokenSelect label="Sell" value="" placeholder="Choose asset" onChange={onChange} options={[
      { token: STRK, symbol: 'STRK', decimals: 18, balance: 12n * ONE + 5n * 10n ** 17n },
      { token: '0x1', symbol: 'USDC', decimals: 6, balance: null },
      { token: '0x2', symbol: 'DOG', name: 'Dog', decimals: 5 },
    ]} />);
    const select = container!.querySelector('select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Choose asset', 'STRK · 12.5', 'USDC', 'DOG · Dog']);
    expect(select.labels?.[0]?.textContent).toBe('Sell');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(select, '0x1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('0x1');
  });

  it('keeps a hidden label as the accessible name', () => {
    render(<TokenSelect label="Sell" labelHidden value={STRK} onChange={() => {}} options={[{ token: STRK, symbol: 'STRK', decimals: 18 }]} />);
    expect(container!.querySelector('label')!.className).toBe('ui-visually-hidden');
    expect(container!.querySelector('select')!.labels?.[0]?.textContent).toBe('Sell');
  });
});

describe('SettingsPopover', () => {
  function Slippage({ warning }: { warning?: string }) {
    const [value, setValue] = useState('0.5');
    return <SettingsPopover title="Slippage" value={value} onChange={setValue} custom={{ label: 'Custom slippage', unit: '%' }} warning={warning} presets={[
      { value: '0.1', label: '0.1%' }, { value: '0.5', label: '0.5%' }, { value: '1', label: '1%' },
    ]} />;
  }
  const cog = () => button(`${COPY.kit.settings}: Slippage`);

  it('opens from the cog with the current preset pressed', () => {
    render(<Slippage />);
    expect(cog().getAttribute('aria-expanded')).toBe('false');
    expect(container!.querySelector('.ui-settings-popover')).toBeNull();
    act(() => cog().click());
    expect(cog().getAttribute('aria-expanded')).toBe('true');
    expect(button('0.5%').getAttribute('aria-pressed')).toBe('true');
    act(() => button('1%').click());
    expect(button('1%').getAttribute('aria-pressed')).toBe('true');
    expect(button('0.5%').getAttribute('aria-pressed')).toBe('false');
  });

  it('takes a custom value, which un-presses every preset', () => {
    render(<Slippage />);
    act(() => cog().click());
    const custom = container!.querySelector<HTMLInputElement>('.ui-settings-custom input')!;
    expect(custom.labels?.[0]?.textContent).toBe('Custom slippage');
    type(custom, '2.5');
    expect(custom.value).toBe('2.5');
    expect(container!.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  });

  it('keeps a typed custom value that passes through a preset on the way', () => {
    render(<Slippage />);
    act(() => cog().click());
    const custom = container!.querySelector<HTMLInputElement>('.ui-settings-custom input')!;
    type(custom, '1');
    expect(custom.value).toBe('1');
    expect(button('1%').getAttribute('aria-pressed')).toBe('false');
    type(custom, '1.5');
    expect(custom.value).toBe('1.5');
    act(() => button('0.5%').click());
    expect(custom.value).toBe('');
    expect(button('0.5%').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows its hint under the title', () => {
    render(<SettingsPopover title="Max slippage" value="0.5" onChange={() => {}} presets={[{ value: '0.5', label: '0.5%' }]} hint="Your swap will not go through if the price moves more than this." />);
    act(() => button(`${COPY.kit.settings}: Max slippage`).click());
    expect(container!.querySelector('.ui-settings-hint')!.textContent).toBe('Your swap will not go through if the price moves more than this.');
  });

  it('shows its warning slot', () => {
    render(<Slippage warning="High slippage: you may get a poor price." />);
    act(() => cog().click());
    expect(container!.querySelector('.ui-settings-warning')!.textContent).toBe('High slippage: you may get a poor price.');
  });

  it('closes on Escape, keeps the Escape from the visit layer, and hands focus back', () => {
    render(<Slippage />);
    act(() => cog().click());
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    try {
      act(() => button('1%').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    } finally {
      window.removeEventListener('keydown', windowEscape);
    }
    expect(container!.querySelector('.ui-settings-popover')).toBeNull();
    expect(windowEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(cog());
  });

  it('closes on a press outside, and stays open on one inside', () => {
    render(<Slippage />);
    act(() => cog().click());
    act(() => container!.querySelector('.ui-settings-title')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container!.querySelector('.ui-settings-popover')).not.toBeNull();
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container!.querySelector('.ui-settings-popover')).toBeNull();
  });
});

describe('DetailRows', () => {
  it('renders label and value rows with their tone written out', () => {
    render(<DetailRows label="Swap details" rows={[
      { id: 'min', label: 'Minimum received', value: '1990 DOG', tone: 'emphasis' },
      { id: 'impact', label: 'Price impact', value: '4.2%', tone: 'warning', note: 'High for this pair.' },
      { id: 'fee', label: 'Pool fee', value: '6 STRK' },
    ]} />);
    const rows = [...container!.querySelectorAll('.ui-detail')];
    expect(rows.map((row) => row.querySelector('dt')!.textContent)).toEqual(['Minimum received', 'Price impact', 'Pool fee']);
    expect(rows.map((row) => row.getAttribute('data-tone'))).toEqual(['emphasis', 'warning', null]);
    expect(rows[1]!.querySelector('.ui-detail-note')!.textContent).toBe('High for this pair.');
    expect(container!.querySelector('dl')!.getAttribute('aria-label')).toBe('Swap details');
  });

  it('renders nothing for no rows', () => {
    render(<DetailRows rows={[]} />);
    expect(container!.innerHTML).toBe('');
  });

  it('inverts a rate on request', () => {
    render(<InvertibleRate forward="1 STRK ≈ 0.0431 USDC" inverse="1 USDC ≈ 23.2 STRK" />);
    expect(container!.textContent).toBe('1 STRK ≈ 0.0431 USDC');
    act(() => button(COPY.kit.invert).click());
    expect(container!.textContent).toBe('1 USDC ≈ 23.2 STRK');
    expect(button(COPY.kit.invert).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads before → after aloud as "to"', () => {
    render(<BeforeAfter before="1.8" after="1.4" />);
    expect(container!.querySelector('[aria-hidden="true"]')!.textContent).toBe(' → ');
    expect(container!.querySelector('.ui-visually-hidden')!.textContent).toBe(' to ');
  });
});

describe('FlipButton', () => {
  it('is a named button that flips', () => {
    const onFlip = vi.fn();
    render(<FlipButton onFlip={onFlip} />);
    act(() => button(COPY.kit.flip).click());
    expect(onFlip).toHaveBeenCalledOnce();
  });
});

describe('QuoteTimer', () => {
  it('counts down each second and calls onExpire once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const onExpire = vi.fn();
    render(<QuoteTimer expiresAt={1_003_000} lifetimeMs={30_000} onExpire={onExpire} />);
    const timer = container!.querySelector('[role="timer"]')!;
    expect(timer.textContent).toBe('Quote refreshes in 3s');
    expect(container!.querySelector<HTMLElement>('.ui-quote-timer-bar')!.style.inlineSize).toBe('10%');
    act(() => vi.advanceTimersByTime(1_000));
    expect(timer.textContent).toBe('Quote refreshes in 2s');
    act(() => vi.advanceTimersByTime(2_000));
    expect(timer.textContent).toBe(COPY.kit.refreshing);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('says it is refreshing while a re-quote is in flight', () => {
    render(<QuoteTimer expiresAt={Date.now() + 20_000} refreshing />);
    expect(container!.textContent).toBe(COPY.kit.refreshing);
    expect(container!.querySelector('.ui-quote-timer-track')).toBeNull();
  });
});
