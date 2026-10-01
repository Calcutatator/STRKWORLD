// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, PrivacyError, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { EXCHANGE_CATALOG } from '../panels/exchange/catalog.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { parseRoutePolicy } from '../production/config.js';
import { EntryGate } from './EntryGate.js';
import type { EntryGateOptions } from './entry-gate.js';
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
  watch = WATCH,
}: {
  operations: FakePrivacyOperations;
  policy?: WalletRoutePolicy | null;
  account?: string | null;
  memory?: EntryPassMemory | null;
  watch?: EntryGateOptions['watch'];
}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <EntryGate operations={operations} account={account} policy={policy} memory={memory} watch={watch}>
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
    // D-094: a STRK deposit pays the pool fee on top.
    expect(gate()!.textContent).toContain(COPY.bank.shieldFeeOnTop);
    // One token, so no picker: the amount says which.
    expect(container!.querySelector('select')).toBeNull();
    expect(container!.querySelector('label')?.textContent).toContain('Amount (STRK)');
    // The gate reads no public balance (the Bank's Shield control does, D-094).
    expect(gate()!.textContent).not.toMatch(/public balance/i);

    await type(amountInput(), '0.5');
    await click(button(COPY.entry.review));
    expect(gate()!.getAttribute('data-gate')).toBe('review');
    expect(gate()!.querySelector('.batch-list')?.textContent).toBe('Deposit 0.5 STRK');
    // The seam's public-leg warning, in the token's own units rather than wei.
    expect(gate()!.querySelector('.review-warnings')?.textContent).toBe(
      // D-094: the deposit is the amount plus the 6 STRK pool fee on top.
      'Depositing 6.5 STRK is public: the amount and your address are visible on-chain.',
    );
    expect(gate()!.textContent).not.toContain('500000000000000000');
    expect([...gate()!.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([SHIELD_DISCLOSURE]);
    // D-094: the fee goes on top, and the review states it and the total.
    expect([...gate()!.querySelectorAll('[data-review="shield"] dd')].map((dd) => dd.textContent)).toEqual(['0.5 STRK', '6 STRK', '6.5 STRK']);

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

  it('takes a non-STRK deposit from the Railway allowlist, in that token\'s decimals', async () => {
    const USDC = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'USDC')!.token;
    const USDT = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'USDT')!.token;
    const WBTC = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'WBTC')!.token;
    const railway = parseRoutePolicy({ ...SHIELD_ENV, VITE_STRK20_SHIELD_ALLOWED_TOKENS: [STRK, ETH, USDC, USDT, WBTC].join(',') });
    const operations = new FakePrivacyOperations();
    await mount({ operations, policy: railway });
    await click(button('Enter STRKWORLD'));

    const select = container!.querySelector<HTMLSelectElement>('select[name="token"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC']);
    await choose(select, USDC);
    await type(amountInput(), '12.5');
    await click(button(COPY.entry.review));
    expect(gate()!.querySelector('.batch-list')?.textContent).toBe('Deposit 12.5 USDC');
    expect(gate()!.querySelector('.review-warnings')?.textContent).toBe(
      'Depositing 12.5 USDC is public: the amount and your address are visible on-chain.',
    );
    // The register's approved disclosure names no token, so it holds for USDC too.
    expect([...gate()!.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([SHIELD_DISCLOSURE]);
    expect(SHIELD_DISCLOSURE).not.toMatch(/STRK\b(?!20)/);

    await click(button(COPY.flow.confirm));
    expect(operations.submitted).toEqual([[{ kind: 'shield', token: USDC, amount: 12_500000n }]]);
    expect(city()).not.toBeNull();
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

  it('shows the not-registered guidance when the deposit answers 118, and leads back through the check', async () => {
    const operations = new FakePrivacyOperations();
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    await mount({ operations });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '2');
    await click(button(COPY.entry.review));
    operations.injectFault({ kind: 'not-registered', on: 'confirm' });
    await click(button(COPY.flow.confirm));

    const card = container!.querySelector('[data-testid="not-registered"]')!;
    expect(card.querySelector('h2')?.textContent).toBe(COPY.notRegistered.title);
    expect(card.textContent).toContain(COPY.notRegistered.hint);
    // One way on, and it is not a second deposit: the balance check.
    expect([...card.querySelectorAll('button')].map((found) => found.textContent)).toEqual([COPY.entry.checkBalance]);
    await click(button(COPY.entry.checkBalance));
    expect(check).toHaveBeenCalledTimes(2);
    expect(gate()!.getAttribute('data-gate')).toBe('deposit');
    expect(amountInput().value).toBe('2');
  });

  it('offers the balance check on the deposit card as the second choice, and lets a funded player in', async () => {
    const operations = new FakePrivacyOperations();
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    await mount({ operations });
    await click(button('Enter STRKWORLD'));

    const form = gate()!.querySelector('form')!;
    // After the one call to action, inside the form, so it does not compete with it.
    expect([...form.querySelectorAll('button')].map((found) => [found.textContent, found.className])).toEqual([
      [COPY.entry.review, 'review'],
      [COPY.entry.checkBalance, ''],
    ]);
    expect(button(COPY.entry.checkBalance).type).toBe('button');

    check.mockResolvedValueOnce(true);
    await click(button(COPY.entry.checkBalance));
    expect(city()).not.toBeNull();
  });

  it('offers the balance check on the locked card, where it is the only way on', async () => {
    const operations = new FakePrivacyOperations();
    await mount({ operations, policy: parseRoutePolicy({}) });
    await click(button('Enter STRKWORLD'));
    expect(gate()!.querySelector('.room-locked')).not.toBeNull();
    const actions = [...gate()!.children].filter((child) => child.tagName === 'BUTTON');
    expect(actions.map((found) => found.textContent)).toEqual([COPY.entry.checkBalance]);

    vi.spyOn(operations, 'hasPrivateFunds').mockResolvedValueOnce(true);
    await click(button(COPY.entry.checkBalance));
    expect(city()).not.toBeNull();
  });

  it('reviews a STRK deposit with the pool fee on top, so the typed amount reaches the pool (D-094)', async () => {
    const operations = new FakePrivacyOperations();
    await mount({ operations });
    await click(button('Enter STRKWORLD'));
    expect(gate()!.textContent).toContain(COPY.bank.shieldFeeOnTop);
    await type(amountInput(), '9');
    await click(button(COPY.entry.review));

    const figures = gate()!.querySelector('[data-review="shield"]')!;
    expect([...figures.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['9 STRK', '6 STRK', '15 STRK']);
    expect(gate()!.querySelector('.panel-review')!.textContent).not.toContain(COPY.entry.feeNote);
    // The public leg names the deposit an observer sees: the amount and the fee.
    expect(gate()!.querySelector('.review-warnings')?.textContent).toBe(
      'Depositing 15 STRK is public: the amount and your address are visible on-chain.',
    );
    expect(button(COPY.flow.confirm).disabled).toBe(false);
  });

  it('keeps the plain fee note for another token, whatever the amount', async () => {
    const USDC = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'USDC')!.token;
    const operations = new FakePrivacyOperations();
    await mount({ operations, policy: parseRoutePolicy({ ...SHIELD_ENV, VITE_STRK20_SHIELD_ALLOWED_TOKENS: USDC }) });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '0.01');
    await click(button(COPY.entry.review));
    expect(gate()!.querySelector('[data-warning="fee-takes-all"]')).toBeNull();
    expect(gate()!.querySelector('.panel-review')!.textContent).toContain(COPY.entry.feeNote);
  });

  it('names the public balance of the chosen token when the wallet answers 119', async () => {
    const USDC = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'USDC')!.token;
    const operations = new FakePrivacyOperations();
    await mount({ operations, policy: parseRoutePolicy({ ...SHIELD_ENV, VITE_STRK20_SHIELD_ALLOWED_TOKENS: [STRK, USDC].join(',') }) });
    await click(button('Enter STRKWORLD'));
    await choose(container!.querySelector<HTMLSelectElement>('select[name="token"]')!, USDC);
    await type(amountInput(), '5');
    await click(button(COPY.entry.review));
    operations.injectFault({ kind: 'insufficient-balance', on: 'confirm' });
    await click(button(COPY.flow.confirm));

    expect(gate()!.getAttribute('data-gate')).toBe('deposit-failed');
    const alert = gate()!.querySelector('[role="alert"]')?.textContent;
    expect(alert).toBe("There is not enough USDC in your wallet's public balance for this deposit.");
    // Not the Bank's line about the shielded balance.
    expect(alert).not.toBe(COPY.errors['insufficient-balance']);
    expect(alert).not.toMatch(/shielded/);
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
    expect([...gate()!.querySelectorAll('button')].map((found) => found.textContent)).toEqual([
      COPY.entry.checkAgain,
      COPY.entry.checkBalance,
    ]);
    operations.setDepositStatus('0xfake0001', 'landed');
    await click(button(COPY.entry.checkAgain));
    expect(city()).not.toBeNull();
    expect(operations.submitted).toHaveLength(1);
  });

  it('says plainly when it cannot reach the network check, and offers both ways on', async () => {
    const operations = new FakePrivacyOperations();
    const status = vi.spyOn(operations, 'depositStatus').mockRejectedValue(
      new PrivacyError('unreachable', 'The network check for this deposit could not be made.'),
    );
    await mount({ operations, watch: { ...WATCH, attempts: 6, failureLimit: 3 } });
    await click(button('Enter STRKWORLD'));
    await type(amountInput(), '2');
    await click(button(COPY.entry.review));
    await click(button(COPY.flow.confirm));

    expect(gate()!.getAttribute('data-gate')).toBe('receipt-unreachable');
    expect(gate()!.querySelector('[role="status"]')?.textContent).toBe(COPY.entry.receiptUnreachable);
    expect(gate()!.textContent).not.toContain(COPY.entry.unconfirmed);
    expect(gate()!.querySelector('code')?.textContent).toBe('0xfake0001');
    expect(status).toHaveBeenCalledTimes(3);

    // Back again: watching resumes with no wallet prompt.
    status.mockResolvedValue('landed');
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

    // No raw address in session storage: only a digest, which the public address recomputes.
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
