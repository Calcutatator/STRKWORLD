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

/** Close this counter's window and walk up to another, as a player does (D-103). */
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

/** The amount field holding `input[name]`, for its own Max, balance line and hint. */
function field(name: string): Element {
  const input = container!.querySelector(`input[name="${name}"]`);
  const box = input?.closest('.ui-amount');
  if (!box) throw new Error(`No amount field ${name}`);
  return box;
}

function maxOf(name: string): HTMLButtonElement {
  return field(name).querySelector<HTMLButtonElement>('.ui-amount-quick button')!;
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

    // The World is told all four counters are open: presentation only (D-103).
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
    // D-103: BORROW borrows and adds collateral; repaying is the REPAY counter's.
    expect([...panel.querySelectorAll('.borrow-modes button')].map((node) => node.textContent)).toEqual([
      'Borrow', 'Add collateral',
    ]);
    // D-102: the loans and the pool balance are read on opening, with no button to press first.
    expect(panel.querySelector('.borrow-loans')?.textContent).toContain(COPY.borrow.loans.empty);
    expect(panel.querySelector('.borrow-loans button')?.textContent).toBe(COPY.borrow.loans.again);

    await choose('debt', USDC);
    expect(counter().querySelector('.borrow-max-ltv')?.textContent).toBe(`${COPY.borrow.maxLtv} 68.00%`);
    // What the pair holds as collateral, where collateral comes from, and the pool balance to add it from.
    expect(counter().querySelector('.borrow-collateral-held p')?.textContent).toBe(`${COPY.borrow.form.yourCollateral}: 0 STRK`);
    expect(counter().querySelector('.borrow-collateral-source')?.textContent).toBe(COPY.borrow.form.collateralSource);
    expect(field('collateral-amount').querySelector('.ui-amount-balance')?.textContent).toBe(`${COPY.kit.poolBalance}: 20000 STRK`);
    await type('collateral-amount', '10000');
    await type('amount', '100');
    await click(button(COPY.gameMode.reviewAction));
    const review = counter().querySelector('.panel-review')!;
    // D-103: the collateral and the loan typed, the USDC received, the fees on
    // top, and what leaves the pool: the collateral plus the pool fee, both STRK.
    expect([...review.querySelectorAll('.ui-amount-summary .ui-detail')].map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent])).toEqual([
      [COPY.borrow.review.collateral, '10000 STRK'],
      [COPY.borrow.review.borrow, '100 USDC'],
      [COPY.kit.youReceive, '100 USDC'],
      [`${COPY.bank.poolFee}${COPY.glossary.poolFee}`, '6 STRK'],
      [`${COPY.bank.networkCost}${COPY.glossary.networkCost}`, COPY.borrow.review.networkByWallet],
      [COPY.kit.totalFromPool, '10006 STRK'],
    ]);
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

    // Back at the form, the loan is read again on its own (D-102): its figures and the public stand-in.
    await click(button(COPY.flow.back));
    const loan = counter().querySelector('.borrow-loan')!;
    expect(counter().querySelector('.borrow-collateral-held p')?.textContent).toBe(`${COPY.borrow.form.yourCollateral}: 10000 STRK`);
    expect(loan.getAttribute('data-band')).toBe('safe');
    expect(loan.textContent).toContain('STRK → USDC');
    expect(counter().querySelector('.vault-stand-in code')?.textContent).toBe(shortenAddress(DEMO_BORROW_STAND_IN));
  });

  it('shows what can be borrowed, fills Max at a health of 1.25, and previews health before and after (D-089, D-102)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 20_000n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    await openCounter(operations);
    await choose('debt', USDC);
    const rows = () => Object.fromEntries([...counter().querySelectorAll('.panel-compose .ui-detail')]
      .map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]));
    // No collateral yet: "Available to borrow" says why, the borrow Max is off,
    // and the form offers the pool balance less the 6 STRK pool fee as collateral.
    expect(rows()[COPY.borrow.form.available]).toBe(COPY.borrow.form.availableWhy['no-collateral']);
    expect(maxOf('amount').disabled).toBe(true);
    expect(field('amount').querySelector('.ui-amount-hint')?.textContent).toBe(`${COPY.borrow.form.addCollateralFirst} ${COPY.borrow.form.maxCollateral}`);
    await click(button(COPY.borrow.form.maxCollateral));
    expect(counter().querySelector<HTMLInputElement>('input[name="collateral-amount"]')!.value).toBe('19994');
    // D-131: the same figure a press on the balance line fills, so the field
    // states the 6 STRK it kept aside.
    expect(field('collateral-amount').querySelector('.ui-amount-hint')?.textContent).toBe(COPY.kit.feeKeptAside.replace('{amount}', '6 STRK'));
    // The collateral field's own Max fills the same figure.
    await type('collateral-amount', '');
    await click(maxOf('collateral-amount'));
    expect(counter().querySelector<HTMLInputElement>('input[name="collateral-amount"]')!.value).toBe('19994');
    expect(rows()[COPY.borrow.form.available]).toMatch(/^\d+(\.\d{1,2})? USDC$/);
    // More collateral than the pool balance holds is not offered.
    await type('collateral-amount', '30000');
    expect(button(COPY.kit.insufficient.replace('{symbol}', 'STRK')).disabled).toBe(true);

    await type('collateral-amount', '10000');
    // 10,000 demo STRK at $0.04 and 68% max LTV, at health 1.25: about 217.6 USDC.
    const available = rows()[COPY.borrow.form.available]!;
    // Floored to cents for a stablecoin (D-089).
    expect(available).toMatch(/^217\.\d{1,2} USDC$/);
    await click(maxOf('amount'));
    expect(field('amount').querySelector('.ui-amount-hint')?.textContent).toBe(COPY.borrow.form.maxHint);
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

  it('bases Max on the collateral already held when the field is empty, and adds collateral from the pool balance (D-102)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 250n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
      borrow: { positions: [{ collateral: STRK, debt: USDC, collateralAmount: 2_000n * E18, debtAmount: 10n * USDC_ONE }] },
    });
    await openCounter(operations);
    await choose('debt', USDC);
    const rows = () => Object.fromEntries([...counter().querySelectorAll('.panel-compose .ui-detail')]
      .map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]));
    expect(counter().querySelector('.borrow-collateral-held p')?.textContent).toBe(`${COPY.borrow.form.yourCollateral}: 2000 STRK`);
    // 2,000 demo STRK at $0.04 and 68% max LTV back $43.52 at a health of 1.25, less the 10 USDC owed.
    const available = rows()[COPY.borrow.form.available]!;
    expect(available).toMatch(/^33\.5\d USDC$/);
    expect(maxOf('amount').disabled).toBe(false);
    await click(maxOf('amount'));
    expect(counter().querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe(available.replace(' USDC', ''));
    expect(rows()[COPY.borrow.form.health]).toMatch(/→ {2}to 1\.25$/);

    // Adding collateral: the pool balance, and a Max that leaves the 6 STRK pool fee behind.
    await click(button(COPY.borrow.modes['add-collateral']));
    expect(field('amount').querySelector('.ui-amount-balance')?.textContent).toBe(`${COPY.kit.poolBalance}: 250 STRK`);
    await click(maxOf('amount'));
    expect(counter().querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe('244');
  });

  it('says when collateral is too small for Vesu\'s $10 minimum (D-102)', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 250n * E18 }, poolConfig: { noteMaturityBlocks: 0 } });
    await openCounter(operations);
    await choose('debt', USDC);
    // 20 demo STRK at $0.04 is worth $0.80, under the demo's $1 floor (Vesu's is $10).
    await type('collateral-amount', '20');
    const available = [...counter().querySelectorAll('.panel-compose .ui-detail')]
      .find((row) => row.querySelector('dt')!.textContent === COPY.borrow.form.available)!;
    expect(available.querySelector('dd')?.textContent).toBe(COPY.borrow.form.availableWhy['below-floor']);
    expect(field('amount').querySelector('.ui-amount-hint')?.textContent).toBe(COPY.borrow.form.belowFloorHint);
    expect(maxOf('amount').disabled).toBe(true);
  });

  it('flags a loan near liquidation, and says why it refuses a withdrawal past the max LTV', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * E18 },
      poolConfig: { noteMaturityBlocks: 0 },
      borrow: { positions: [{ collateral: STRK, debt: USDC, collateralAmount: 1_000n * E18, debtAmount: 25n * USDC_ONE }] },
    });
    // D-103: withdrawing collateral is at the REPAY counter, which reads the loans on opening (D-102).
    await openCounter(operations, 'vault:repay');
    expect([...counter().querySelectorAll('.borrow-modes button')].map((node) => node.textContent)).toEqual([
      'Repay', 'Withdraw collateral',
    ]);
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
    // Then walk to REPAY, which opens on its repay form and reads the loan (D-103, D-102).
    await walkTo(world, 'vault:repay');
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
