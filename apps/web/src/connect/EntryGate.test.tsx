// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { EXCHANGE_CATALOG } from '../panels/exchange/catalog.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { parseRoutePolicy } from '../production/config.js';
import { EntryGate } from './EntryGate.js';
import type { EntryPassMemory } from './entry-pass.js';

/**
 * The entry gate as a player drives it (D-072): every step is a click or a
 * keystroke on the rendered card, against the deterministic fake.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'STRK')!.token;
const ETH = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'ETH')!.token;
const SHIELD_ENV = {
  VITE_STRK20_SHIELD_ENABLED: 'true',
  VITE_STRK20_SHIELD_MAX_INTENTS: '1',
  VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
};
const SHIELD_POLICY = parseRoutePolicy(SHIELD_ENV);
const SHIELD_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!.disclosure!;
const WATCH = { intervalMs: 0, attempts: 2, sleep: async () => undefined } as const;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount({
  operations,
  policy = SHIELD_POLICY,
  account = '0xabc',
  memory,
}: {
  operations: FakePrivacyOperations;
  policy?: WalletRoutePolicy | null;
  account?: string | null;
  memory?: EntryPassMemory | null;
}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <EntryGate operations={operations} account={account} policy={policy} memory={memory} watch={WATCH}>
        <div data-testid="city">the city</div>
      </EntryGate>,
    );
  });
  await settle();
}

function gate(): HTMLElement | null {
  return container!.querySelector('[data-testid="entry-gate"]');
}

function city(): HTMLElement | null {
  return container!.querySelector('[data-testid="city"]');
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function amountInput(): HTMLInputElement {
  return container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
}

describe('the entry gate, driven through the screen (D-072)', () => {
  it('asks once, in the connect card style, and lets a funded player straight in', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 1n } });
    let answer!: (funded: boolean) => void;
    const check = vi.spyOn(operations, 'hasPrivateFunds').mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { answer = resolve; }),
    );
    await mount({ operations });

    const card = gate()!;
    expect(card.classList.contains('room')).toBe(true);
    expect(card.querySelector('h2')?.textContent).toBe('One check before you enter');
    expect(card.textContent).toContain(
      'STRKWORLD is for people with funds in the STRK20 privacy pool. Your wallet will ask to share your private balance.',
    );
    expect(city()).toBeNull();
    expect(check).not.toHaveBeenCalled();

    await click(button('Enter STRKWORLD'));
    // Waiting on the wallet: the D-058 cue asks for the balance approval.
    expect(gate()!.getAttribute('data-gate')).toBe('checking');
    expect(container!.querySelector('[data-wallet-attention="balance"]')).not.toBeNull();
    expect(gate()!.textContent).toContain(COPY.entry.checking);

    await act(async () => { answer(true); });
    await settle();
    expect(city()?.textContent).toBe('the city');
    expect(gate()).toBeNull();
    expect(container!.querySelector('[data-wallet-attention]')).toBeNull();
  });

  it('takes a player with nothing in the pool through a deposit, with the approved disclosure at the commit point', async () => {
    const operations = new FakePrivacyOperations();
    await mount({ operations });
    await click(button('Enter STRKWORLD'));

    expect(gate()!.getAttribute('data-gate')).toBe('deposit');
    expect(gate()!.querySelector('h2')?.textContent).toBe(COPY.entry.depositTitle);
    expect(gate()!.textContent).toContain(COPY.entry.depositBody);
    expect(gate()!.textContent).toContain(COPY.entry.feeNote);
    // One token, so no picker: the amount says which.
    expect(container!.querySelector('select')).toBeNull();
    expect(container!.querySelector('label')?.textContent).toContain('Amount (STRK)');
    // No public balance: the Bank does not read one either.
    expect(gate()!.textContent).not.toMatch(/public balance/i);

    await type(amountInput(), '0.5');
    await click(button(COPY.entry.review));
    expect(gate()!.getAttribute('data-gate')).toBe('review');
    expect(gate()!.querySelector('.batch-list')?.textContent).toBe('Deposit 0.5 STRK');
    expect([...gate()!.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([SHIELD_DISCLOSURE]);
    // No fee figure is promised; the note says part of it pays the fee.
    expect(gate()!.textContent).not.toContain(COPY.bank.poolFee);

    await click(button(COPY.flow.confirm));
    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 5n * 10n ** 17n }]]);
    expect(city()).not.toBeNull();
  });

  it('refuses an amount it cannot read, in place', async () => {
    await mount({ operations: new FakePrivacyOperations() });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '0');
    await click(button(COPY.entry.review));
    expect(gate()!.getAttribute('data-gate')).toBe('deposit');
    expect(gate()!.querySelector('.panel-notice')?.textContent).toBe(COPY.notices.badAmount);
  });

  it('offers a picker when this build admits more than one token', async () => {
    const policy: WalletRoutePolicy = { ...SHIELD_POLICY, allowedTokens: { ...SHIELD_POLICY.allowedTokens, shield: [STRK, ETH] } };
    const operations = new FakePrivacyOperations();
    await mount({ operations, policy });
    await click(button('Enter STRKWORLD'));

    const select = container!.querySelector<HTMLSelectElement>('select[name="token"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['STRK', 'ETH']);
    await choose(select, ETH);
    expect(container!.querySelector('input[name="amount"]')?.closest('label')?.textContent).toContain('Amount (ETH)');

    await type(amountInput(), '0.01');
    await click(button(COPY.entry.review));
    expect(gate()!.querySelector('.batch-list')?.textContent).toBe('Deposit 0.01 ETH');
  });

  it('returns a declined check to the card with its message and a retry', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 1n } });
    operations.injectFault({ kind: 'user-rejected', on: 'balances' });
    await mount({ operations });
    await click(button('Enter STRKWORLD'));

    expect(gate()!.getAttribute('data-gate')).toBe('check-failed');
    expect(gate()!.querySelector('[role="alert"]')?.textContent).toBe(COPY.errors['user-rejected']);
    await click(button(COPY.connect.retry));
    expect(city()).not.toBeNull();
  });

  it('shows the not-registered guidance when the deposit answers 118, and returns to the form', async () => {
    const operations = new FakePrivacyOperations();
    await mount({ operations });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '2');
    await click(button(COPY.entry.review));
    operations.injectFault({ kind: 'not-registered', on: 'confirm' });
    await click(button(COPY.flow.confirm));

    const card = container!.querySelector('[data-testid="not-registered"]')!;
    expect(card.querySelector('h2')?.textContent).toBe(COPY.notRegistered.title);
    expect(card.textContent).toContain(COPY.notRegistered.hint);
    await click(button(COPY.connect.retry));
    expect(gate()!.getAttribute('data-gate')).toBe('deposit');
    expect(amountInput().value).toBe('2');
  });

  it('says so when a deposit reverts, and keeps the form for another try', async () => {
    await mount({ operations: new FakePrivacyOperations({ deposits: 'failed' }) });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '2');
    await click(button(COPY.entry.review));
    await click(button(COPY.flow.confirm));
    expect(gate()!.getAttribute('data-gate')).toBe('deposit-failed');
    expect(gate()!.querySelector('[role="alert"]')?.textContent).toBe(COPY.entry.reverted);
    expect(amountInput().value).toBe('2');
  });

  it('lets the player check a slow deposit again without a second wallet prompt', async () => {
    const operations = new FakePrivacyOperations({ deposits: 'pending' });
    await mount({ operations });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '2');
    await click(button(COPY.entry.review));
    await click(button(COPY.flow.confirm));

    expect(gate()!.getAttribute('data-gate')).toBe('unconfirmed');
    expect(gate()!.textContent).toContain(COPY.entry.unconfirmed);
    expect(gate()!.querySelector('code')?.textContent).toBe('0xfake0001');
    operations.setDepositStatus('0xfake0001', 'landed');
    await click(button(COPY.entry.checkAgain));
    expect(city()).not.toBeNull();
    expect(operations.submitted).toHaveLength(1);
  });

  it('shows the locked door when this build has not switched shield on', async () => {
    await mount({ operations: new FakePrivacyOperations(), policy: parseRoutePolicy({}) });
    await click(button('Enter STRKWORLD'));
    expect(gate()!.querySelector('.room-locked')?.textContent).toBe(COPY.locked.notEnabled.shield);
    expect(container!.querySelector('form')).toBeNull();
  });

  it('lets this tab back in without a check, and another account checks again', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 1n } });
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    await mount({ operations, account: '0xabc' });
    await click(button('Enter STRKWORLD'));
    expect(city()).not.toBeNull();
    // The pass is written after the city shows; let its hash and write finish.
    for (let turn = 0; turn < 20 && sessionStorage.length === 0; turn += 1) await settle();
    expect(sessionStorage.length).toBe(1);
    act(() => root!.unmount());
    root = null;
    container!.remove();

    // A reload of the same account in this tab: straight in.
    await mount({ operations, account: '0x0ABC' });
    expect(city()).not.toBeNull();
    expect(check).toHaveBeenCalledOnce();
    act(() => root!.unmount());
    root = null;
    container!.remove();

    await mount({ operations, account: '0xdef' });
    expect(city()).toBeNull();
    expect(gate()!.getAttribute('data-gate')).toBe('ready');

    // Nothing in session storage names the account.
    const stored = JSON.stringify(Object.entries(sessionStorage));
    expect(stored).not.toContain('abc');
    expect(stored).not.toContain('def');
  });

  it('checks every time without an account (the demo)', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 1n } });
    await mount({ operations, account: null });
    await click(button('Enter STRKWORLD'));
    expect(city()).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
