import { describe, expect, it } from 'vitest';
import { BORROW_TOKENS, BorrowRefusedError } from '../borrow.js';
import type { VaultStage } from '../operations.js';
import { DEMO_BORROW_STAND_IN, DEMO_VAULT_STAND_IN, FakePrivacyOperations } from './fake.js';

/**
 * D-083: the demo's Borrow counter, so the panel can run without a wallet:
 * DEMO prices and pairs, the adapter's stages, the adapter's refusals, and
 * balances that move as the four flows say.
 */

const [STRK, , USDC] = BORROW_TOKENS as [string, string, string];
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const FEE = 6n * E18;

function fake(balances: Record<string, bigint> = { [STRK]: 20_000n * E18, [USDC]: 500n * USDC_ONE }) {
  return new FakePrivacyOperations({ balances, poolConfig: { noteMaturityBlocks: 0 } });
}

async function spendable(operations: FakePrivacyOperations, token: string): Promise<bigint> {
  const [balance] = await operations.balances([token]);
  return balance?.spendable ?? 0n;
}

describe('the demo Borrow counter (D-083)', () => {
  it('offers all twenty demo pairs at demo prices, and its own stand-in, not the Vault\'s', async () => {
    const operations = fake();
    const market = await operations.borrowMarket();
    expect(market.assets).toHaveLength(5);
    expect(market.pairs).toHaveLength(20);
    const loans = await operations.borrowPositions();
    expect(loans).toEqual({ standIn: DEMO_BORROW_STAND_IN, positions: [] });
    expect(DEMO_BORROW_STAND_IN).not.toBe(DEMO_VAULT_STAND_IN);
  });

  it('opens, repays all and withdraws all, moving the pool balance each time', async () => {
    const operations = fake();
    const stages: VaultStage[] = [];
    const open = await operations.prepareBorrow(
      { kind: 'borrow', collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE },
      { onStage: (stage) => stages.push(stage) },
    );
    expect(open.after.band).toBe('safe');
    expect(stages.map((stage) => stage.stage)).toEqual(['capability', 'commitment', 'address', 'position']);
    await open.confirm({ feeCeiling: FEE });
    expect(await spendable(operations, STRK)).toBe(20_000n * E18 - 10_000n * E18 - FEE);
    expect(await spendable(operations, USDC)).toBe(600n * USDC_ONE);
    const [loan] = (await operations.borrowPositions()).positions;
    expect(loan).toMatchObject({ collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE });
    expect(loan!.health.status).toBe('priced');

    const repay = await operations.prepareBorrow({ kind: 'repay', collateral: STRK, debt: USDC, amount: 'all' });
    expect(repay.action).toMatchObject({ kind: 'repay', all: true, amount: 100n * USDC_ONE + 100_002n, buffer: 100_002n });
    await repay.confirm({ feeCeiling: FEE });
    // The demo accrues no interest: the whole buffer comes back.
    expect(await spendable(operations, USDC)).toBe(500n * USDC_ONE);

    const withdraw = await operations.prepareBorrow({ kind: 'withdraw-collateral', collateral: STRK, debt: USDC, amount: 'all' });
    await withdraw.confirm({ feeCeiling: FEE });
    expect(await spendable(operations, STRK)).toBe(20_000n * E18 - 3n * FEE);
    expect((await operations.borrowPositions()).positions).toEqual([]);
    expect(operations.borrowSubmitted.map((action) => action.kind)).toEqual(['borrow', 'repay', 'withdraw-collateral']);
    expect(operations.vaultSubmitted).toEqual([]);
  });

  it('refuses what Vesu would, with the rule named', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 20_000n * E18 },
      borrow: { positions: [{ collateral: STRK, debt: USDC, collateralAmount: 1_000n * E18, debtAmount: 25n * USDC_ONE }] },
    });
    // 1,000 STRK at the demo $0.04 is $40, so 25 USDC sits near the 0.68 max LTV.
    const [loan] = (await operations.borrowPositions()).positions;
    expect(loan!.health.band).toBe('warning');
    await expect(operations.prepareBorrow({ kind: 'withdraw-collateral', collateral: STRK, debt: USDC, amount: 100n * E18 }))
      .rejects.toMatchObject({ refusal: 'above-max-ltv' });
    await expect(operations.prepareBorrow({ kind: 'repay', collateral: STRK, debt: USDC, amount: 25n * USDC_ONE }))
      .rejects.toBeInstanceOf(BorrowRefusedError);
    // The demo floor is $1: leaving 50 cents owed is refused.
    await expect(operations.prepareBorrow({ kind: 'repay', collateral: STRK, debt: USDC, amount: 24_500_000n }))
      .rejects.toMatchObject({ refusal: 'debt-below-floor' });
  });

  it('reads a stale demo price as Vesu does: no health figure, and nothing offered', async () => {
    const operations = new FakePrivacyOperations({
      borrow: { stalePrices: [USDC], positions: [{ collateral: STRK, debt: USDC, collateralAmount: 1_000n * E18, debtAmount: 11n * USDC_ONE }] },
    });
    const [loan] = (await operations.borrowPositions()).positions;
    expect(loan!.health).toMatchObject({ status: 'stale-price', band: 'unknown' });
    await expect(operations.prepareBorrow({ kind: 'repay', collateral: STRK, debt: USDC, amount: 'all' })).rejects.toMatchObject({ refusal: 'stale-price' });
  });

  it('runs out of funds as the wallet would, pool fee included', async () => {
    const operations = fake({ [USDC]: 500n * USDC_ONE });
    await expect(operations.prepareBorrow({ kind: 'borrow', collateral: USDC, debt: STRK, collateralAmount: 100n * USDC_ONE, borrowAmount: 1_000n * E18 }))
      .rejects.toMatchObject({ kind: 'insufficient-balance' });
  });
});
