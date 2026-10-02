// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ENDUR_XSTRK, ENDUR_XSTRK_ASSET, FakePrivacyOperations } from '@strkworld/privacy';
import type { BuildingId, ShellEvents, StationId, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import type { ConnectState } from '../connect/connect-machine.js';
import { COPY } from '../copy.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { VisitLayer } from '../visits/VisitLayer.js';

/**
 * The owner's amount standard (D-103), counter by counter, through the real
 * windows: the typed amount is the amount that moves (what reaches the seam
 * equals what was typed), and the window's total is that amount plus the pool
 * fee, in each token it is paid in. Every form and review reads what you
 * enter, what you receive, the fees, then the total.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = ENDUR_XSTRK_ASSET;
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const BOB = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
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
  for (let turn = 0; turn < 4; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function open(operations: FakePrivacyOperations, building: BuildingId, station: StationId): Promise<void> {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}><VisitLayer world={world} shell={shell} /></PrivacyProvider>);
  });
  await act(async () => world.emit('building:entered', { building }));
  await act(async () => world.emit('station:activated', { building, station }));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
  await settle();
}

async function type(name: string, value: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function choose(name: string, value: string): Promise<void> {
  const select = container!.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => { set.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); });
}

/** The amounts a surface shows, label then figure, in order; the glossary words stripped from the labels. */
function amounts(scope: string): Array<[string, string]> {
  return [...container!.querySelectorAll(`${scope} .ui-amount-summary .ui-detail`)].map((row) => {
    const term = row.querySelector('dt summary')?.textContent;
    return [term ?? row.querySelector('dt')!.textContent ?? '', row.querySelector('dd')!.firstChild?.textContent ?? ''];
  });
}

/** The total row's figure, and that the rows before it ran entered → received → fees. */
function totalOf(scope: string, entered: string, fees: readonly string[]): string {
  const rows = amounts(scope);
  const labels = rows.map(([label]) => label);
  const total = labels.findIndex((label) => label === COPY.kit.totalFromPool || label === COPY.kit.totalFromWallet);
  expect(total).toBeGreaterThan(0);
  expect(labels[0]).toBe(entered);
  for (const fee of fees) expect(labels.indexOf(fee)).toBeGreaterThan(0);
  for (const fee of fees) expect(labels.indexOf(fee)).toBeLessThan(total);
  return rows[total]![1];
}

const bank = () => new FakePrivacyOperations({
  balances: { [STRK]: 250n * E18, [ENDUR_XSTRK]: 12n * E18 },
  publicBalances: { [STRK]: 120n * E18 },
  poolConfig: { noteMaturityBlocks: 0 },
  registered: [BOB],
});

describe('the amount standard at every Bank counter (D-103)', () => {
  it('SHIELD: 25 typed is 25 shielded; the wallet pays 25 + 6', async () => {
    const operations = bank();
    await open(operations, 'bank', 'bank:shielding');
    await type('amount', '25');
    expect(totalOf('.panel-compose', COPY.bank.youShield, [COPY.bank.poolFee])).toBe('31 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.bank.youShield, [COPY.bank.poolFee])).toBe('31 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 25n * E18 }]]);
  });

  it('UNSHIELD: 10 typed is 10 withdrawn; the pool pays 10 + 6', async () => {
    const operations = bank();
    await open(operations, 'bank', 'bank:unshielding');
    await type('recipient', BOB);
    await type('amount', '10');
    expect(totalOf('.panel-compose', COPY.bank.youUnshield, [COPY.bank.poolFee])).toBe('16 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.bank.youUnshield, [COPY.bank.poolFee])).toBe('16 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.submitted).toEqual([[{ kind: 'unshield', token: STRK, amount: 10n * E18, recipient: BOB }]]);
  });

  it('UNSHIELD: an amount that fits the pool balance but not with the fee on top is refused before review', async () => {
    const operations = bank();
    await open(operations, 'bank', 'bank:unshielding');
    await click(button(COPY.balance.refresh));
    await type('recipient', BOB);
    await type('amount', '247');
    expect(container!.querySelector('.ui-amount .ui-amount-message')?.textContent).toBe(COPY.kit.exceedsWithFee);
    expect(button(COPY.kit.insufficient.replace('{symbol}', 'STRK')).disabled).toBe(true);
    await type('amount', '244');
    expect(button(COPY.gameMode.reviewAction).disabled).toBe(false);
  });

  it('STAKE: 5 typed is 5 staked; the pool pays 5 + 6', async () => {
    const operations = bank();
    await open(operations, 'bank', 'bank:staking');
    await type('amount', '5');
    expect(totalOf('.panel-compose', COPY.stake.youStake, [COPY.bank.poolFee])).toBe('11 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.stake.youStake, [COPY.bank.poolFee])).toBe('11 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.submitted).toEqual([[{ kind: 'stake', tokenIn: STRK, tokenOut: ENDUR_XSTRK, amountIn: 5n * E18 }]]);
  });

  it('UNSTAKE: 4 xSTRK typed is 4 xSTRK sent; the pool pays 4 xSTRK + 6 STRK', async () => {
    const operations = bank();
    await open(operations, 'bank', 'bank:unstaking');
    await type('unstake-amount', '4');
    expect(totalOf('.unstake-compose', COPY.unstake.youUnstake, [COPY.bank.poolFee])).toBe('4 xSTRK + 6 STRK');
    await click(button(COPY.unstake.request));
    expect(totalOf('.panel-review', COPY.unstake.youUnstake, [COPY.bank.poolFee])).toBe('4 xSTRK + 6 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.endurSubmitted).toEqual([{ kind: 'request', shares: 4n * E18, leftover: 0n }]);
  });

  it('the Post Office: 3 typed is 3 sent; the pool pays 3 + 6', async () => {
    const operations = bank();
    await open(operations, 'post-office', 'post-office:transfer');
    await type('recipient', BOB);
    await type('amount', '3');
    expect(totalOf('.panel-compose', COPY.bank.youSend, [COPY.bank.poolFee])).toBe('9 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.bank.youSend, [COPY.bank.poolFee])).toBe('9 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.submitted).toEqual([[{ kind: 'transfer', token: STRK, amount: 3n * E18, recipient: BOB }]]);
  });
});

const vault = () => new FakePrivacyOperations({
  balances: { [STRK]: 120n * E18, [USDC]: 250n * USDC_ONE },
  poolConfig: { noteMaturityBlocks: 0 },
  vault: { shares: 40n * E18 },
  borrow: { positions: [{ collateral: STRK, debt: USDC, collateralAmount: 4_000n * E18, debtAmount: 60n * USDC_ONE }] },
});

describe('the amount standard at every Vault counter (D-103)', () => {
  it('SUPPLY: 20 typed is 20 supplied; the pool pays 20 + 6', async () => {
    const operations = vault();
    await open(operations, 'vault', 'vault:supply');
    await type('amount', '20');
    expect(totalOf('.panel-compose', COPY.vault.review.supply, [COPY.bank.poolFee])).toBe('26 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.vault.review.supply, [COPY.bank.poolFee])).toBe('26 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 20n * E18 }]);
  });

  it('REDEEM: 5 typed is 5 redeemed out of Vesu; only the 6 fee leaves the pool', async () => {
    const operations = vault();
    await open(operations, 'vault', 'vault:redeem');
    await click(button(COPY.vault.position.show));
    await type('amount', '5');
    expect(totalOf('.panel-compose', COPY.vault.review.redeem, [COPY.bank.poolFee])).toBe('6 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.vault.review.redeem, [COPY.bank.poolFee])).toBe('6 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'redeem', token: STRK, amount: 5n * E18, all: false }]);
  });

  it('BORROW: 100 STRK collateral and 20 USDC typed move as typed; the pool pays the collateral + 6', async () => {
    const operations = vault();
    await open(operations, 'vault', 'vault:borrow');
    await choose('debt', USDC);
    await type('collateral-amount', '100');
    await type('amount', '20');
    expect(totalOf('.panel-compose', COPY.borrow.review.collateral, [COPY.bank.poolFee])).toBe('106 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.borrow.review.collateral, [COPY.bank.poolFee])).toBe('106 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted).toEqual([{ kind: 'borrow', collateral: STRK, debt: USDC, collateralAmount: 100n * E18, borrowAmount: 20n * USDC_ONE }]);
  });

  it('BORROW, adding collateral: 50 typed is 50 added; the pool pays 50 + 6', async () => {
    const operations = vault();
    await open(operations, 'vault', 'vault:borrow');
    await click(button(COPY.borrow.modes['add-collateral']));
    await type('amount', '50');
    expect(totalOf('.panel-compose', COPY.borrow.review.collateral, [COPY.bank.poolFee])).toBe('56 STRK');
    await click(button(COPY.gameMode.reviewAction));
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted.at(-1)).toMatchObject({ kind: 'add-collateral', amount: 50n * E18 });
  });

  it('REPAY: 10 USDC typed is 10 USDC repaid; the pool pays 10 USDC + 6 STRK', async () => {
    const operations = vault();
    await open(operations, 'vault', 'vault:repay');
    await type('amount', '10');
    expect(totalOf('.panel-compose', COPY.borrow.review.repay, [COPY.bank.poolFee])).toBe('10 USDC + 6 STRK');
    await click(button(COPY.gameMode.reviewAction));
    expect(totalOf('.panel-review', COPY.borrow.review.repay, [COPY.bank.poolFee])).toBe('10 USDC + 6 STRK');
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted.at(-1)).toMatchObject({ kind: 'repay', amount: 10n * USDC_ONE, all: false });
  });

  it('REPAY, withdrawing collateral: 100 typed is 100 withdrawn; only the 6 fee leaves the pool', async () => {
    const operations = vault();
    await open(operations, 'vault', 'vault:repay');
    await click(button(COPY.borrow.modes['withdraw-collateral']));
    await type('amount', '100');
    expect(totalOf('.panel-compose', COPY.borrow.review.withdraw, [COPY.bank.poolFee])).toBe('6 STRK');
    await click(button(COPY.gameMode.reviewAction));
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.borrowSubmitted.at(-1)).toMatchObject({ kind: 'withdraw-collateral', amount: 100n * E18 });
  });
});
