// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type PrivacyOperations, type WalletRoutePolicy } from '@strkworld/privacy';
import type { BuildingId, ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import type { ConnectState } from '../connect/connect-machine.js';
import { COPY } from '../copy.js';
import { createDemoOperations } from '../privacy/demo-operations.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { DegenCatalogProvider } from '../panels/exchange/DegenCatalogProvider.js';
import { ExchangeMenuPanel } from '../panels/exchange/ExchangeMenuPanel.js';
import { BANK_COUNTERS, BankMenuPanel } from '../panels/bank/BankMenuPanel.js';
import { menuCounters } from '../panels/MenuCounters.js';
import { VAULT_COUNTERS, VaultMenuPanel } from '../panels/vault/VaultMenuPanel.js';
import { VisitLayer } from './VisitLayer.js';

/**
 * Menu Mode parity (D-088), driven through the real visit layer: every
 * window a Game Mode room offers is reachable from Menu Mode, behind the
 * same door, with the same disclosure, and hidden when the build leaves its
 * counter off.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const DOG = '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4';
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const disclosureOf = (route: string) => PRIVACY_REGISTER.find((entry) => entry.route === route)!.disclosure!;
const CONNECTED: ConnectState = {
  name: 'connected',
  capability: { supportsStrk20: true, walletApiVersion: '0.10.4', registration: 'registered', supportsShadowAccounts: true },
  registrationConfirmed: true,
};

const denyAll: WalletRoutePolicy = {
  maxIntents: 0,
  maxRelayFee: 0n,
  enabledRoutes: [],
  allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
};
const vaultOn: WalletRoutePolicy = {
  ...denyAll,
  maxIntents: 1,
  enabledRoutes: ['vault'],
  allowedTokens: { ...denyAll.allowedTokens, vault: [STRK] },
};
const borrowOn: WalletRoutePolicy = {
  ...vaultOn,
  enabledRoutes: ['vault', 'borrow'],
  allowedTokens: { ...vaultOn.allowedTokens, borrow: [STRK, USDC] },
};
const swapOn: WalletRoutePolicy = {
  ...denyAll,
  maxIntents: 1,
  enabledRoutes: ['swap'],
  allowedTokens: { ...denyAll.allowedTokens, swap: [STRK, USDC] },
};

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
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  await settle();
}

/** Walk into `building` and press Menu Mode, as a player does. */
async function openMenu(building: BuildingId, operations: PrivacyOperations): Promise<void> {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  await mount(
    <PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}>
      <DegenCatalogProvider demo build={{ production: false }}>
        <VisitLayer world={world} shell={shell} />
      </DegenCatalogProvider>
    </PrivacyProvider>,
  );
  await act(async () => world.emit('building:entered', { building }));
  await click(button(COPY.gameMode.menu));
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

async function choose(name: string, value: string): Promise<void> {
  const select = container!.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  await chooseIn(select, value);
}

/** A select by its label, as the Exchange's compose form names them (D-090: a hidden label tied by `for`). */
function selectLabelled(label: string): HTMLSelectElement {
  const found = [...container!.querySelectorAll('label')].find((candidate) => candidate.textContent === label);
  const control = found?.htmlFor ? container!.querySelector<HTMLSelectElement>(`select[id="${found.htmlFor}"]`) : found?.querySelector('select');
  if (!control) throw new Error(`No select labelled ${label}`);
  return control;
}

async function chooseIn(select: HTMLSelectElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(name: string, value: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function tabs(): string[] {
  return [...container!.querySelectorAll('.menu-counters [role="tab"]')].map((tab) => tab.textContent ?? '');
}

function selectedTab(): string | null {
  return container!.querySelector('.menu-counters [role="tab"][aria-selected="true"]')?.textContent ?? null;
}

function onlyWindow(): Element {
  const windows = container!.querySelectorAll('section.panel');
  expect(windows).toHaveLength(1);
  return windows[0]!;
}

describe('Menu Mode offers the counters its Game Mode room holds (D-088)', () => {
  it('names the counters as the room does, admitting each as its counter is', () => {
    // D-099: the Vault's four counters, in the room's order.
    expect(menuCounters('vault', VAULT_COUNTERS, PRIVACY_REGISTER, borrowOn)).toEqual([
      { station: 'vault:supply', label: 'SUPPLY' },
      { station: 'vault:redeem', label: 'REDEEM' },
      { station: 'vault:borrow', label: 'BORROW' },
      { station: 'vault:repay', label: 'REPAY' },
    ]);
    // Borrowing off in this build: BORROW and REPAY are locked, so Menu Mode hides them.
    expect(menuCounters('vault', VAULT_COUNTERS, PRIVACY_REGISTER, vaultOn)).toEqual([
      { station: 'vault:supply', label: 'SUPPLY' },
      { station: 'vault:redeem', label: 'REDEEM' },
    ]);
    // Their route unapproved in the register: hidden too, with borrowing switched on.
    const unapproved = PRIVACY_REGISTER.map((entry) => (entry.route === 'vault.borrow' ? { ...entry, approvedBy: null } : entry));
    expect(menuCounters('vault', VAULT_COUNTERS, unapproved, borrowOn)).toHaveLength(2);
    // The Bank's four (D-099): SHIELD always, the others while their counters open.
    expect(menuCounters('bank', BANK_COUNTERS, PRIVACY_REGISTER, null)).toEqual([
      { station: 'bank:shielding', label: 'SHIELD' },
      { station: 'bank:unshielding', label: 'UNSHIELD' },
      { station: 'bank:staking', label: 'STAKE' },
      { station: 'bank:unstaking', label: 'UNSTAKE' },
    ]);
    const stakeOnly: WalletRoutePolicy = { ...denyAll, maxIntents: 1, enabledRoutes: ['stake'] };
    expect(menuCounters('bank', BANK_COUNTERS, PRIVACY_REGISTER, stakeOnly).map((counter) => counter.label)).toEqual(['SHIELD', 'STAKE']);
    expect(menuCounters('bank', BANK_COUNTERS, PRIVACY_REGISTER, denyAll).map((counter) => counter.label)).toEqual(['SHIELD']);
    expect(menuCounters('exchange', ['exchange:swap', 'exchange:degen'], PRIVACY_REGISTER, swapOn)).toEqual([
      { station: 'exchange:swap', label: 'SWAP' },
      { station: 'exchange:degen', label: 'DEGEN SWAP' },
    ]);
    // Swap off: the degen floor's counter is locked, so only the building's own window stays, behind its locked door.
    expect(menuCounters('exchange', ['exchange:swap', 'exchange:degen'], PRIVACY_REGISTER, denyAll)).toEqual([
      { station: 'exchange:swap', label: 'SWAP' },
    ]);
    expect(Object.isFrozen(menuCounters('vault', ['vault:supply'], PRIVACY_REGISTER, borrowOn))).toBe(true);
  });

  it('opens the Borrow window from the Vault\'s Menu Mode, with its own disclosure, and opens a loan', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 20_000n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    await openMenu('vault', operations);

    // The Vault's own window first, SUPPLY, with the four counter tabs above it (D-099).
    expect(tabs()).toEqual(['SUPPLY', 'REDEEM', 'BORROW', 'REPAY']);
    expect(selectedTab()).toBe('SUPPLY');
    expect(onlyWindow().closest('.vault-experience')?.getAttribute('data-mode')).toBe('supply');
    expect(onlyWindow().closest('.vault-experience')?.getAttribute('data-experience')).toBe('menu');
    expect(onlyWindow().classList.contains('borrow-experience')).toBe(false);
    expect(onlyWindow().querySelector('.borrow-risk')).toBeNull();

    await click(button('BORROW'));
    expect(selectedTab()).toBe('BORROW');
    const borrow = onlyWindow();
    // BORROW borrows and adds collateral; repaying is REPAY's (D-099).
    expect([...borrow.querySelectorAll('.borrow-modes [role="tab"]')].map((tab) => tab.textContent)).toEqual([
      COPY.borrow.modes.borrow,
      COPY.borrow.modes['add-collateral'],
    ]);
    expect(borrow.closest('.borrow-experience')?.getAttribute('data-experience')).toBe('menu');
    expect(borrow.querySelector('.vault-eyebrow')?.textContent).toBe(COPY.borrow.eyebrow);
    // D-024: the approved words, verbatim, previewed while composing.
    expect(borrow.querySelector('[data-testid="disclosure"]')?.textContent).toBe(disclosureOf('vault.borrow'));
    expect(borrow.querySelector('.borrow-risk')?.textContent).toContain(COPY.borrow.risk.lines[1]);
    expect(borrow.textContent).toContain(COPY.borrow.loans.unrequested);

    await choose('debt', USDC);
    await type('collateral-amount', '10000');
    await type('amount', '100');
    await click(button(COPY.gameMode.reviewAction));
    const review = onlyWindow().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([disclosureOf('vault.borrow')]);
    expect(container!.querySelectorAll('button.confirm')).toHaveLength(1);
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted).toEqual([
      { kind: 'borrow', collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE },
    ]);
    expect(onlyWindow().querySelector('.flow-done')?.textContent).toContain(COPY.borrow.submitted.succeeded);

    // REPAY: repaying and withdrawing collateral, on the same loan route.
    await click(button('REPAY'));
    expect(selectedTab()).toBe('REPAY');
    const repay = onlyWindow();
    expect(repay.closest('.borrow-experience')?.getAttribute('data-mode')).toBe('repay');
    expect([...repay.querySelectorAll('.borrow-modes [role="tab"]')].map((tab) => tab.textContent)).toEqual([
      COPY.borrow.modes.repay,
      COPY.borrow.modes['withdraw-collateral'],
    ]);
    expect(repay.querySelector('[data-testid="disclosure"]')?.textContent).toBe(disclosureOf('vault.borrow'));

    // REDEEM: the lending window on its redeem form alone, no supply tab.
    await click(button('REDEEM'));
    expect(onlyWindow().closest('.vault-experience')?.getAttribute('data-mode')).toBe('redeem');
    expect(onlyWindow().querySelector('.panel-body .panel-modes')).toBeNull();

    // Back to the Vault's counter: its window again, the Borrow window gone.
    await click(button('SUPPLY'));
    expect(selectedTab()).toBe('SUPPLY');
    expect(onlyWindow().classList.contains('borrow-experience')).toBe(false);
    expect(container!.querySelector('.borrow-experience')).toBeNull();
  });

  it('keeps the Vault\'s Menu Mode to its lending counters while borrowing is off', async () => {
    await mount(
      <PrivacyProvider operations={new FakePrivacyOperations()} initialConnectState={CONNECTED}>
        <VaultMenuPanel onClose={() => {}} policy={vaultOn} />
      </PrivacyProvider>,
    );
    expect(tabs()).toEqual(['SUPPLY', 'REDEEM']);
    expect(onlyWindow().closest('.vault-experience')?.getAttribute('data-experience')).toBe('menu');
    expect(container!.querySelector('.borrow-experience')).toBeNull();
  });

  it('offers the Bank\'s four counters as tabs, one window at a time, each doing one thing (D-099)', async () => {
    const operations = createDemoOperations({ funded: true });
    await openMenu('bank', operations);
    expect(tabs()).toEqual(['SHIELD', 'UNSHIELD', 'STAKE', 'UNSTAKE']);
    expect(selectedTab()).toBe('SHIELD');
    expect(onlyWindow().closest('.bank-experience')?.getAttribute('data-mode')).toBe('shield');
    expect(onlyWindow().getAttribute('data-brand')).toBeNull();
    // No transfer anywhere in the Bank: the Post Office is the one place to send.
    expect(container!.textContent).not.toContain(COPY.bank.transfer);

    await click(button('UNSHIELD'));
    expect(onlyWindow().closest('.bank-experience')?.getAttribute('data-mode')).toBe('unshield');
    expect(onlyWindow().querySelector('input[name="recipient"]')).not.toBeNull();

    await click(button('STAKE'));
    expect(onlyWindow().closest('.bank-experience')?.getAttribute('data-mode')).toBe('stake');
    expect(onlyWindow().getAttribute('data-brand')).toBe('endur');
    expect(onlyWindow().querySelector('section.unstake-counter')).toBeNull();

    await click(button('UNSTAKE'));
    expect(onlyWindow().closest('.bank-experience')?.getAttribute('data-mode')).toBe('unstake');
    expect(onlyWindow().getAttribute('data-brand')).toBe('endur');
    expect(onlyWindow().querySelector('section.unstake-counter')).not.toBeNull();
    expect(onlyWindow().querySelector('input[name="amount"]')).toBeNull();

    // A shield from its tab: one action, reviewed and confirmed on its own.
    await click(button('SHIELD'));
    await type('amount', '5');
    await click(button(COPY.gameMode.reviewAction));
    expect(container!.querySelectorAll('button.confirm')).toHaveLength(1);
    expect(onlyWindow().querySelector('.commit-disclosures')?.textContent).toContain(disclosureOf('bank.shield'));
    await click(onlyWindow().querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.submitted).toEqual([[expect.objectContaining({ kind: 'shield', amount: 5n * E18 })]]);
  });

  it('hides the Bank counters its build leaves off, keeping SHIELD, the Bank\'s own window', async () => {
    await mount(
      <PrivacyProvider operations={new FakePrivacyOperations()} initialConnectState={CONNECTED}>
        <BankMenuPanel onClose={() => {}} policy={denyAll} />
      </PrivacyProvider>,
    );
    // One counter left: no tabs, and SHIELD's window, which still shows its
    // own door from the build's policy.
    expect(container!.querySelector('.menu-counters')).toBeNull();
    expect(onlyWindow().closest('.bank-experience')?.getAttribute('data-mode')).toBe('shield');
    expect(onlyWindow().querySelector('h3.counter-action')?.textContent).toBe(COPY.bank.shield);
  });

  it('asks for the unpriced-token acknowledgement in the Exchange\'s Menu Mode, and offers the degen floor', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * E18 },
      swapReview: {
        expectedAmountOut: 2n * E18, slippageBps: 50, expiresAt: 4_102_444_800_000,
        priceCheck: { status: 'unchecked', boundBps: 300 },
      },
    });
    await openMenu('exchange', operations);

    expect(tabs()).toEqual(['SWAP', 'DEGEN SWAP']);
    expect(selectedTab()).toBe('SWAP');
    const ground = onlyWindow();
    expect(ground.closest('.exchange-experience')?.getAttribute('data-mode')).toBe('ground');
    expect(ground.closest('.exchange-experience')?.getAttribute('data-experience')).toBe('menu');
    expect(ground.textContent).toContain(COPY.balance.refresh);

    await click(button(COPY.balance.refresh));
    await type('amount', '1');
    await click(button(COPY.exchange.review));
    const gate = onlyWindow().querySelector('.confirm-gate')!;
    expect(gate.querySelector('.commit-disclosures')?.textContent).toBe(disclosureOf('exchange.swap'));
    expect(gate.querySelector('.exchange-price-check')?.getAttribute('data-status')).toBe('unchecked');
    const acknowledge = gate.querySelector<HTMLInputElement>('.exchange-acknowledge input[type="checkbox"]')!;
    expect(acknowledge.closest('label')?.textContent).toContain(COPY.exchange.acknowledgeUnchecked);

    // Without the tick, nothing is sent.
    await click(button(COPY.flow.confirm));
    expect(operations.submitted).toEqual([]);
    expect(onlyWindow().textContent).toContain(COPY.exchange.acknowledgeFirst);
    await click(onlyWindow().querySelector<HTMLInputElement>('.exchange-acknowledge input[type="checkbox"]')!);
    await click(button(COPY.flow.confirm));
    expect(operations.submitted).toHaveLength(1);
    expect(onlyWindow().textContent).toContain(COPY.flow.submitted);

    // The degen floor's window, in its own look, over its own list.
    await click(button('DEGEN SWAP'));
    expect(selectedTab()).toBe('DEGEN SWAP');
    const degen = onlyWindow();
    expect(degen.getAttribute('data-brand')).toBe('degen');
    expect(degen.closest('.exchange-experience')?.getAttribute('data-mode')).toBe('degen');
    expect(degen.textContent).toContain(COPY.degen.eyebrow);
    // The swap just sent is the building's latest receipt, so the degen window
    // shows it first, exactly as the degen counter upstairs would.
    expect(degen.textContent).toContain(COPY.flow.receiptWaiting);
    await click(button(COPY.flow.back));
    expect(onlyWindow().querySelectorAll('.degen-token').length).toBeGreaterThan(1);
  });

  it('swaps on the degen floor from Menu Mode, with the same disclosure', async () => {
    const operations = createDemoOperations({ funded: true });
    await openMenu('exchange', operations);
    await click(button('DEGEN SWAP'));
    await click(button(COPY.balance.refresh));
    await chooseIn(selectLabelled(COPY.exchange.buyToken), DOG);
    await type('amount', '2');
    await click(button(COPY.exchange.review));
    const gate = onlyWindow().querySelector('.confirm-gate')!;
    expect(gate.textContent).toContain('2000 DOG');
    expect(gate.querySelector('.commit-disclosures')?.textContent).toBe(disclosureOf('exchange.swap'));
    await click(button(COPY.flow.confirm));
    expect(operations.submitted).toHaveLength(1);
    expect(operations.submitted[0]![0]).toMatchObject({ kind: 'swap', tokenOut: DOG });
  });

  it('keeps the Exchange\'s Menu Mode one window, with no tabs, while swapping is off', async () => {
    await mount(
      <PrivacyProvider operations={new FakePrivacyOperations()} initialConnectState={CONNECTED}>
        <DegenCatalogProvider demo build={{ production: false }}>
          <ExchangeMenuPanel onClose={() => {}} policy={denyAll} />
        </DegenCatalogProvider>
      </PrivacyProvider>,
    );
    expect(container!.querySelector('.menu-counters')).toBeNull();
    expect(onlyWindow().closest('.exchange-experience')?.getAttribute('data-mode')).toBe('ground');
  });
});
