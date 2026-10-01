import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './fake.js';
import { ENDUR_XSTRK, ENDUR_XSTRK_ASSET } from '../endur.js';
import type { Intent } from '../operations.js';

/**
 * Demo-mode staking (D-063). The fake mints xSTRK at a fixed DEMO rate of
 * 4 shares per 5 STRK (floored). The rate is a fixture: it is asserted here so
 * the demo stays deterministic, never because it resembles Endur's live rate.
 */

const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const OTHER = '0x0123';
const ONE_STRK = 10n ** 18n;
const POOL_FEE = 6n * ONE_STRK;
const RELAY_UNIT = 1_000000000000000n;
const CEILING = 10n * ONE_STRK;

function stake(amountIn: bigint): Intent {
  return { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK, amountIn };
}

function fresh(balance = 100n * ONE_STRK) {
  return new FakePrivacyOperations({ balances: { [STRK]: balance } });
}

async function runDemoScript() {
  const fake = fresh();
  const batch = await fake.prepare([stake(5n * ONE_STRK)]);
  const receipt = await batch.confirm({ feeCeiling: CEILING });
  const beforeMaturity = await fake.balances([STRK, XSTRK]);
  fake.advanceBlocks(10);
  const afterMaturity = await fake.balances([STRK, XSTRK]);
  return { batch, receipt, beforeMaturity, afterMaturity, submitted: fake.submitted };
}

describe('fake Endur staking', () => {
  it('debits STRK and the pool fee, then matures xSTRK at the fixed demo rate', async () => {
    const { beforeMaturity, afterMaturity } = await runDemoScript();
    // No relay fee: the wallet submits a stake and prices its own network fee (D-082).
    const strkLeft = 100n * ONE_STRK - 5n * ONE_STRK - POOL_FEE;

    expect(beforeMaturity).toEqual([
      { token: STRK, spendable: strkLeft, maturing: 0n, total: strkLeft, maturityKnown: true },
      { token: XSTRK, spendable: 0n, maturing: 4n * ONE_STRK, total: 4n * ONE_STRK, maturityKnown: true },
    ]);
    expect(afterMaturity[1]).toEqual({
      token: XSTRK, spendable: 4n * ONE_STRK, maturing: 0n, total: 4n * ONE_STRK, maturityKnown: true,
    });
  });

  it('is deterministic: two runs of the same script are identical', async () => {
    const [first, second] = [await runDemoScript(), await runDemoScript()];

    expect(second.receipt).toEqual(first.receipt);
    expect(second.beforeMaturity).toEqual(first.beforeMaturity);
    expect(second.afterMaturity).toEqual(first.afterMaturity);
    expect(second.submitted).toEqual(first.submitted);
    expect(first.submitted).toEqual([[stake(5n * ONE_STRK)]]);
  });

  it('floors fractional demo shares and credits no note for dust', async () => {
    const fake = fresh();
    await (await fake.prepare([stake(9n)])).confirm({ feeCeiling: CEILING });
    await (await fake.prepare([stake(1n)])).confirm({ feeCeiling: CEILING });

    const [xstrk] = await fake.balances([XSTRK]);
    // 9 × 4/5 = 7.2 → 7; 1 × 4/5 = 0.8 → 0, and no empty note is created.
    expect(xstrk).toMatchObject({ maturing: 7n, total: 7n });
  });

  it('costs a stake at the pool fee alone, like the Wallet API adapter (D-082)', async () => {
    const batch = await fresh().prepare([stake(ONE_STRK)]);

    expect(batch.poolFee).toBe(POOL_FEE);
    expect(batch.gasEstimate).toBe(0n);
    expect(batch.totalCost).toBe(POOL_FEE);
    expect(batch.promptCount).toBe(1);
  });

  it('never presents the demo rate as review data, and adds no public-leg warning (D-064)', async () => {
    const batch = await fresh().prepare([stake(ONE_STRK)]);

    expect('swapReview' in batch).toBe(false);
    // Matches the Wallet API adapter: the waived stake disclosure is not
    // reintroduced as a seam warning in demo mode either.
    expect(batch.warnings).toEqual([]);
  });

  it.each([
    ['another input token', { tokenIn: OTHER }],
    ['another output token', { tokenOut: OTHER }],
    ['the reversed pair', { tokenIn: XSTRK, tokenOut: STRK }],
  ])('pins the pair like production: rejects %s', async (_label, patch) => {
    const fake = new FakePrivacyOperations({ balances: { [STRK]: 100n * ONE_STRK, [XSTRK]: 100n * ONE_STRK } });

    await expect(fake.prepare([{ ...stake(ONE_STRK), ...patch } as Intent]))
      .rejects.toThrow('The stake route accepts only STRK in and xSTRK out.');
  });

  it('prepares one stake at a time and never beside another route', async () => {
    const fake = new FakePrivacyOperations({ balances: { [STRK]: 100n * ONE_STRK }, registered: [OTHER] });

    await expect(fake.prepare([stake(ONE_STRK), stake(ONE_STRK)]))
      .rejects.toThrow('A private stake must be prepared one at a time.');
    await expect(fake.prepare([stake(ONE_STRK), { kind: 'transfer', token: STRK, amount: 1n, recipient: OTHER }]))
      .rejects.toThrow('A private batch may contain only one approved route type.');
    await expect(fake.prepare([{ kind: 'shield', token: STRK, amount: 1n }, stake(ONE_STRK)]))
      .rejects.toMatchObject({ kind: 'privacy-leak' });
  });

  it('rejects a stake the shielded STRK cannot cover once the pool fee is counted', async () => {
    await expect(fresh(5n * ONE_STRK).prepare([stake(5n * ONE_STRK)]))
      .rejects.toMatchObject({ kind: 'insufficient-balance' });
  });

  it('rejects a nonpositive stake amount', async () => {
    await expect(fresh().prepare([stake(0n)])).rejects.toThrow('Amounts must be positive.');
  });
});
