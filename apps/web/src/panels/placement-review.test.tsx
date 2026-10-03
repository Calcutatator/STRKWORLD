import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ENDUR_XSTRK, FakePrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { createReceiptLedger } from '../receipts/receipt-ledger.js';
import { BankPanel } from './bank/BankPanel.js';
import { createBankPanel } from './bank/bank-machine.js';
import { UnstakeCounter } from './bank/UnstakeCounter.js';
import { createUnstakePanel } from './bank/unstake-machine.js';
import { VaultPanel } from './vault/VaultPanel.js';
import { createVaultPanel } from './vault/vault-machine.js';
import { BorrowPanel } from './borrow/BorrowPanel.js';
import { createBorrowPanel } from './borrow/borrow-machine.js';
import { ExchangePanel } from './exchange/ExchangePanel.js';
import { createExchangePanel } from './exchange/exchange-machine.js';
import { EXCHANGE_CATALOG } from './exchange/catalog.js';
import { BORROW_TOKENS } from '../production/config.js';

/**
 * D-122, amended 2026-10-02: the review step's one quiet line, on every flow
 * that pays the pool fee and so earns a placement receipt — shield, unshield,
 * send, the Vault, Borrow, unstaking and the swap.
 *
 * Each counter is driven to its review state against the demo seam and then
 * rendered, and the assertion is made inside the `ConfirmGate` subtree, so a
 * line somewhere else on the page cannot satisfy it. The seam's
 * `placementReceipts` switch stands for a probing tab with a ledger
 * configured: with it off — the ordinary visit — every one of these reviews
 * must say nothing at all about a placement.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';
/** Borrow's own pinned pair, so the collateral and the debt are the counter's. */
const [BORROW_STRK, , USDC] = BORROW_TOKENS as readonly [string, string, string, ...string[]];
const ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const HINT = COPY.plaza.placement.reviewHint;
const SWAP_TOKEN = EXCHANGE_CATALOG[0]!.token;

/** The demo seam, with or without the placement a probing tab would have. */
function seam(placementReceipts: boolean, extra: Record<string, unknown> = {}) {
  return new FakePrivacyOperations({
    // STRK last: the swap's own first token is STRK too, and Borrow's
    // collateral needs the larger holding of the two.
    balances: { [SWAP_TOKEN]: 100n * ONE, [ENDUR_XSTRK]: 8n * ONE, [USDC]: 500n * USDC_ONE, [STRK]: 50_000n * ONE },
    poolConfig: { noteMaturityBlocks: 0 },
    registered: [BOB],
    ...(placementReceipts ? { placementReceipts: true } : {}),
    ...extra,
  });
}

/** The `ConfirmGate` subtree alone, so nothing around it can answer for it. */
function commitGate(markup: string): string {
  const start = markup.indexOf('class="confirm-gate"');
  expect(start, 'the review should be at its commit point').not.toBe(-1);
  return markup.slice(start);
}

/** Each fee-paying counter: drive it to review, render it, return its commit point. */
const FLOWS = {
  async shield(operations: FakePrivacyOperations) {
    const panel = createBankPanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await panel.open();
    panel.setAmount('3');
    await panel.review();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}><BankPanel panel={panel} mode="shield" onClose={() => {}} /></PrivacyProvider>,
    );
  },
  async unshield(operations: FakePrivacyOperations) {
    const panel = createBankPanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await panel.open();
    panel.setMode('unshield');
    panel.setAmount('3');
    panel.setRecipient(BOB);
    await panel.review();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}><BankPanel panel={panel} mode="unshield" onClose={() => {}} /></PrivacyProvider>,
    );
  },
  async send(operations: FakePrivacyOperations) {
    const panel = createBankPanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await panel.open();
    panel.setMode('transfer');
    panel.setAmount('3');
    panel.setRecipient(BOB);
    await panel.review();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}>
        <BankPanel panel={panel} mode="transfer" building="post-office" onClose={() => {}} />
      </PrivacyProvider>,
    );
  },
  async vault(operations: FakePrivacyOperations) {
    const panel = createVaultPanel({
      operations,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
      onError: () => undefined,
    });
    await panel.open();
    panel.setAmount('5');
    await panel.prepare();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}><VaultPanel panel={panel} onClose={() => {}} /></PrivacyProvider>,
    );
  },
  async borrow(operations: FakePrivacyOperations) {
    const panel = createBorrowPanel({
      operations,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
      onError: () => undefined,
    });
    await panel.open();
    panel.setPair(BORROW_STRK, USDC);
    panel.setCollateralAmount('10000');
    panel.setAmount('100');
    await panel.prepare();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}><BorrowPanel panel={panel} onClose={() => {}} /></PrivacyProvider>,
    );
  },
  async unstake(operations: FakePrivacyOperations) {
    const panel = createUnstakePanel({
      operations,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
      onError: () => undefined,
    });
    await panel.open();
    panel.setAmount('4');
    await panel.prepareRequest();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}><UnstakeCounter panel={panel} /></PrivacyProvider>,
    );
  },
  async swap(operations: FakePrivacyOperations) {
    const panel = createExchangePanel({
      operations,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
      quoteSpacingMs: 0,
    });
    await panel.open();
    await panel.refreshBalances();
    panel.setAmount('1');
    await panel.prepare();
    return renderToStaticMarkup(
      <PrivacyProvider operations={operations}><ExchangePanel panel={panel} onClose={() => {}} /></PrivacyProvider>,
    );
  },
} as const;

/** The swap's review needs a quote to review, whichever way the placement goes. */
const SWAP_REVIEW = { swapReview: { expectedAmountOut: 2n * ONE, slippageBps: 50, expiresAt: 4_102_444_800_000 } };

function operationsFor(flow: keyof typeof FLOWS, placementReceipts: boolean): FakePrivacyOperations {
  return seam(placementReceipts, flow === 'swap' ? SWAP_REVIEW : {});
}

describe('the review step says "Counts toward your private placement" on every fee-paying flow', () => {
  it.each(Object.keys(FLOWS) as (keyof typeof FLOWS)[])('says it at %s\'s commit point while probing', async (flow) => {
    const gate = commitGate(await FLOWS[flow](operationsFor(flow, true)));
    expect(gate).toContain('data-testid="placement-hint"');
    expect(gate).toContain(HINT);
  });

  it.each(Object.keys(FLOWS) as (keyof typeof FLOWS)[])('says nothing at %s\'s commit point otherwise', async (flow) => {
    const gate = commitGate(await FLOWS[flow](operationsFor(flow, false)));
    expect(gate).not.toContain('placement-hint');
    expect(gate).not.toContain(HINT);
    expect(gate).not.toContain('placement');
  });
});
