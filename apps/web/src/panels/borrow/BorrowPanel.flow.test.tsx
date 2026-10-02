// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_BORROW_STAND_IN, FakePrivacyOperations, type PrivacyOperations } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import type { ConnectState } from '../../connect/connect-machine.js';
import { COPY } from '../../copy.js';
import { shortenAddress } from '../../format.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { VisitLayer } from '../../visits/VisitLayer.js';
import { formatLtv, formatUsd } from './BorrowPanel.js';

/**
 * The Borrow counter (D-083) as a player drives it through the real visit
 * layer, in demo: the World opens the Vault's door and the BORROW counter,
 * and every step after is a click or a keystroke on the rendered window.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'vault.borrow')!.disclosure!;
const CONNECTED: ConnectState = {
  name: 'connected',
  capability: { supportsStrk20: true, walletApiVersion: '0.10.4', registration: 'registered', supportsShadowAccounts: true },
  registrationConfirmed: true,
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

async function openCounter(operations: PrivacyOperations, station: 'vault:borrow' | 'vault:repay' = 'vault:borrow') {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const stations: Array<ShellEvents['world:stations']> = [];
  shell.on('world:stations', (payload) => stations.push(payload));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}>
        <VisitLayer world={world} shell={shell} />
      </PrivacyProvider>,
    );
  });
  await act(async () => world.emit('building:entered', { building: 'vault' }));
  await act(async () => world.emit('station:activated', { building: 'vault', station }));
  await settle();
  return { stations, world };
}

/** Close this counter's window and walk up to another, as a player does (D-099). */
async function walkTo(world: ReturnType<typeof createEventBus<WorldEvents>>, station: 'vault:borrow' | 'vault:repay'): Promise<void> {
  await click(button(COPY.flow.close));
  await act(async () => world.emit('station:activated', { building: 'vault', station }));
  await settle();
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

function counter(): Element {
  const panel = container!.querySelector('section.panel[data-building="vault"]');
  if (!panel) throw new Error('The Borrow window is not open.');
  return panel;
}

describe('the Borrow counter, driven through the screen in demo (D-083)', () => {
  it('stands beside the Vault\'s counter, opens with the liquidation disclosure, and opens a loan', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 20_000n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    const { stations } = await openCounter(operations);

    // The World is told all four counters are open: presentation only (D-099).
    expect(stations.at(-1)).toEqual({
      building: 'vault',
      stations: [
        { station: 'vault:supply', label: 'SUPPLY', status: 'available' },
        { station: 'vault:redeem', label: 'REDEEM', status: 'available' },
        { station: 'vault:borrow', label: 'BORROW', status: 'available' },
        { station: 'vault:repay', label: 'REPAY', status: 'available' },
      ],
    });
    const panel = counter();
    expect(panel.querySelector('.vault-eyebrow')?.textContent).toBe(COPY.borrow.eyebrow);
    expect(panel.querySelector('[data-testid="disclosure"]')?.textContent).toBe(DISCLOSURE);
    expect(panel.querySelector('.borrow-risk')?.textContent).toContain(COPY.borrow.risk.lines[1]);
    // D-099: BORROW borrows and adds collateral; repaying is the REPAY counter's.
    expect([...panel.querySelectorAll('.borrow-modes button')].map((node) => node.textContent)).toEqual([
      'Borrow', 'Add collateral',
    ]);
    // Nothing read that could prompt.
    expect(panel.textContent).toContain(COPY.borrow.loans.unrequested);

    await choose('debt', USDC);
    expect(counter().querySelector('.borrow-max-ltv')?.textContent).toBe(`${COPY.borrow.maxLtv} 68.00%`);
    await type('collateral-amount', '10000');
    await type('amount', '100');
    await click(button(COPY.gameMode.reviewAction));
    const review = counter().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.vault-review dd')].map((dd) => dd.textContent)).toEqual(['10000 STRK', '100 USDC']);
    expect(review.textContent).toContain(COPY.borrow.review.after);
    // 10,000 demo STRK at $0.04 against 100 USDC at $1: LTV 25%, liquidation at $0.0147, and health
    // 2.72 less a hair, since the estimate counts a base unit more debt for Vesu's rounding.
    expect(review.querySelector('.borrow-figures')?.textContent).toContain(`${formatLtv(250_000_000_000_000_000n)} / ${COPY.borrow.maxLtv} 68.00%`);
    expect(review.querySelector('.borrow-figures')?.textContent).toContain(`${COPY.borrow.loans.health}2.71`);
    expect(review.querySelector('.borrow-liquidation-line')?.textContent).toBe(
      `If STRK falls to ${formatUsd(14_705_882_352_941_177n)} and USDC holds its price, anyone can liquidate this loan.`,
    );
    expect([...review.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([DISCLOSURE]);
    expect(counter().querySelector('[data-testid="disclosure"]')).toBeNull();
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted).toEqual([{ kind: 'borrow', collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE }]);
    expect(counter().querySelector('.flow-done')?.textContent).toContain(COPY.borrow.submitted.succeeded);

    // The loan, read on request: its figures and the public stand-in.
    await click(button(COPY.flow.back));
    await click(button(COPY.borrow.loans.show));
    const loan = counter().querySelector('.borrow-loan')!;
    expect(loan.getAttribute('data-band')).toBe('safe');
    expect(loan.textContent).toContain('STRK → USDC');
    expect(counter().querySelector('.vault-stand-in code')?.textContent).toBe(shortenAddress(DEMO_BORROW_STAND_IN));
  });

  it('shows what can be borrowed once the loans are read, fills Max at a health of 1.25, and previews health before and after (D-089)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 20_000n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    await openCounter(operations);
    await choose('debt', USDC);
    await type('collateral-amount', '10000');
    // No loans read yet: an existing loan would change every figure, so none is shown.
    expect(counter().querySelector('.borrow-read-loans')?.textContent).toBe(COPY.borrow.form.readLoans);
    expect(counter().querySelector('.panel-compose .ui-detail')).toBeNull();

    await click(button(COPY.borrow.loans.show));
    await choose('debt', USDC);
    await type('collateral-amount', '10000');
    const rows = () => Object.fromEntries([...counter().querySelectorAll('.panel-compose .ui-detail')]
      .map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]));
    // 10,000 demo STRK at $0.04 and 68% max LTV, at health 1.25: about 217.6 USDC.
    const available = rows()[COPY.borrow.form.available]!;
    // Floored to cents for a stablecoin (D-089).
    expect(available).toMatch(/^217\.\d{1,2} USDC$/);
    await click(button(COPY.kit.max));
    expect(counter().querySelector('.ui-amount-hint')?.textContent).toBe(COPY.borrow.form.maxHint);
    expect(counter().querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe(available.replace(' USDC', ''));
    // Before: nothing owed. After: 1.25, with the price STRK would have to fall to,
    // each once, now → after (D-089).
    expect(rows()[COPY.borrow.form.health]).toBe(`${COPY.borrow.form.noDebt} →  to 1.25`);
    expect(rows()[COPY.borrow.loans.ltv]).toMatch(/^— → {2}to 54\.[34]\d%$/);
    expect(rows()[`${COPY.borrow.loans.liquidation} (STRK)`]).toMatch(/^— → {2}to \$0\.03/);
    expect(counter().querySelector('.panel-compose .borrow-health')).toBeNull();
    expect(button(COPY.gameMode.reviewAction).disabled).toBe(false);

    // Past the 1.05 floor the button will not offer a review.
    await type('amount', '260');
    expect(button(COPY.borrow.form.tooLow).disabled).toBe(true);
    await type('amount', '245');
    const health = counter().querySelector('.panel-compose .ui-detail[data-tone="warning"]');
    expect(health?.querySelector('.ui-detail-note')?.textContent).toBe(COPY.borrow.bands.warning);
    expect(button(COPY.gameMode.reviewAction).disabled).toBe(false);
  });

  it('flags a loan near liquidation, and says why it refuses a withdrawal past the max LTV', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
      borrow: { positions: [{ collateral: STRK, debt: USDC, collateralAmount: 1_000n * E18, debtAmount: 25n * USDC_ONE }] },
    });
    // D-099: withdrawing collateral is at the REPAY counter.
    await openCounter(operations, 'vault:repay');
    expect([...counter().querySelectorAll('.borrow-modes button')].map((node) => node.textContent)).toEqual([
      'Repay', 'Withdraw collateral',
    ]);
    await click(button(COPY.borrow.loans.show));
    const loan = counter().querySelector('.borrow-loan')!;
    expect(loan.getAttribute('data-band')).toBe('warning');
    expect(loan.querySelector('.borrow-band')?.textContent).toBe(COPY.borrow.bands.warning);
    expect(loan.querySelector('.borrow-warning')?.textContent).toBe(COPY.borrow.warningNote);

    // D-089: the form says before any review that this would pass the max
    // LTV, and the button will not offer it. The seam's own refusal stands
    // behind it (borrow-machine.test.ts).
    await click(button(COPY.borrow.modes['withdraw-collateral']));
    await type('amount', '100');
    const health = counter().querySelector('.panel-compose .ui-detail[data-tone="danger"]')!;
    expect(health.querySelector('dt')?.textContent).toBe(COPY.borrow.form.health);
    expect(health.querySelector('.ui-detail-note')?.textContent).toBe(COPY.borrow.bands.liquidatable);
    expect(button(COPY.borrow.form.tooLow).disabled).toBe(true);
    expect(counter().querySelector('.panel-review')).toBeNull();
    expect(operations.borrowSubmitted).toEqual([]);
  });

  it('repays everything from the demo, with the buffer note at the commit point', async () => {
    // The demo's 250 practice STRK, and a little USDC: repaying everything takes
    // the debt plus a small buffer from the pool balance.
    const demo = createDemoOperations({ funded: true });
    expect(await demo.borrowMarket()).toMatchObject({ pairs: expect.any(Array) });
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 250n * E18, [USDC]: USDC_ONE },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    const { world } = await openCounter(operations);
    // Open a small loan first at BORROW, from the 250 practice STRK.
    await choose('debt', USDC);
    await type('collateral-amount', '200');
    await type('amount', '3');
    await click(button(COPY.gameMode.reviewAction));
    await click(counter().querySelector<HTMLButtonElement>('.panel-review button.confirm')!);
    await click(button(COPY.flow.back));
    // Then walk to REPAY, which opens on its repay form (D-099).
    await walkTo(world, 'vault:repay');
    await click(button(COPY.borrow.loans.show));
    expect(counter().closest('.borrow-experience')?.getAttribute('data-mode')).toBe('repay');
    // D-089: Max is the debt as read, and repays everything.
    expect(counter().querySelector('.ui-amount-balance')?.textContent).toBe(`${COPY.borrow.form.owed}: 3 USDC`);
    await click(button(COPY.kit.max));
    expect(counter().querySelector('.ui-amount-hint')?.textContent).toBe(COPY.borrow.form.repayAllLine);
    await click(button(COPY.gameMode.reviewAction));
    const review = counter().querySelector('.panel-review')!;
    expect(review.textContent).toContain(COPY.borrow.review.repayAll);
    expect(review.textContent).toContain(COPY.borrow.review.bufferNote);
    expect(review.querySelector('.borrow-health-none')).not.toBeNull();
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted.at(-1)).toMatchObject({ kind: 'repay', all: true });
  });
});
