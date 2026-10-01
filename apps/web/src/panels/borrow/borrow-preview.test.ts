import { describe, expect, it } from 'vitest';
import {
  BORROW_MIN_HEALTH_AFTER,
  BORROW_WARNING_HEALTH,
  assessBorrow,
  borrowHealth,
  type BorrowAsset,
  type BorrowMarket,
  type BorrowPair,
} from '@strkworld/privacy';
import { BORROW_TOKENS } from '../../production/config.js';
import {
  MAX_FILL_HEALTH,
  PREVIEW_MIN_HEALTH,
  PREVIEW_WARNING_HEALTH,
  maxBorrow,
  maxWithdraw,
  pairAssets,
  previewHealth,
  type PreviewLoan,
} from './borrow-preview.js';

/**
 * The Borrow form's preview (D-089) restates Vesu's arithmetic because the
 * shell may not import the seam's runtime. These tests hold it to the seam:
 * the same reads give the same health factor and liquidation price as
 * `borrowHealth`, and every Max it fills passes `assessBorrow` and leaves
 * health at 1.25 or above.
 */

const [STRK, , USDC, , WBTC] = BORROW_TOKENS as [string, string, string, string, string];
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const WBTC_ONE = 10n ** 8n;

function asset(token: string, decimals: number, price: bigint, overrides: Partial<BorrowAsset> = {}): BorrowAsset {
  const scale = 10n ** BigInt(decimals);
  return {
    token,
    price,
    priceValid: true,
    scale,
    floor: 10n * E18,
    reserve: 50_000_000n * scale,
    totalDebt: 1_000_000n * scale,
    maxUtilization: 950_000_000_000_000_000n,
    ...overrides,
  };
}

function pair(collateral: string, debt: string, maxLtv: bigint, overrides: Partial<BorrowPair> = {}): BorrowPair {
  return { collateral, debt, maxLtv, liquidationFactor: 900_000_000_000_000_000n, debtCap: 10n ** 40n, totalDebt: 0n, ...overrides };
}

/** Prices close to mainnet's at block 15,725,569: STRK $0.0414, USDC $0.9998, WBTC $83,579.75. */
function market(overrides: { strk?: Partial<BorrowAsset>; usdc?: Partial<BorrowAsset>; pairs?: BorrowPair[] } = {}): BorrowMarket {
  return {
    assets: [
      asset(STRK, 18, 41_400_000_000_000_000n, overrides.strk),
      asset(USDC, 6, 999_800_000_000_000_000n, overrides.usdc),
      asset(WBTC, 8, 83_579_750_000_000_000_000_000n),
    ],
    pairs: overrides.pairs ?? [
      pair(STRK, USDC, 680_000_000_000_000_000n),
      pair(WBTC, USDC, 860_000_000_000_000_000n),
      pair(USDC, STRK, 930_000_000_000_000_000n),
    ],
  };
}

const STRK_USDC = { collateral: STRK, debt: USDC };
const WBTC_USDC = { collateral: WBTC, debt: USDC };

describe('the Borrow form preview (D-089)', () => {
  it('restates the seam\'s floor and warning band', () => {
    expect(PREVIEW_MIN_HEALTH).toBe(BORROW_MIN_HEALTH_AFTER);
    expect(PREVIEW_WARNING_HEALTH).toBe(BORROW_WARNING_HEALTH);
    // Safer than D-083's floor, and clear of its warning band.
    expect(MAX_FILL_HEALTH > BORROW_WARNING_HEALTH).toBe(true);
  });

  it('gives the seam\'s health factor and liquidation price for the same reads', () => {
    const read = market();
    const loans: Array<[typeof STRK_USDC, PreviewLoan]> = [
      [STRK_USDC, { collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE }],
      [STRK_USDC, { collateralAmount: 1_000n * E18, debtAmount: 25n * USDC_ONE }],
      [STRK_USDC, { collateralAmount: 3n * E18 + 7n, debtAmount: 1n }],
      [WBTC_USDC, { collateralAmount: 12_345_678n, debtAmount: 7_000n * USDC_ONE + 3n }],
    ];
    for (const [choice, loan] of loans) {
      const assets = pairAssets(read, choice)!;
      const seam = borrowHealth({ ...loan, collateral: assets.collateral, debt: assets.debt, maxLtv: assets.maxLtv });
      const preview = previewHealth(loan, assets);
      expect(preview.status).toBe('priced');
      if (preview.status !== 'priced') continue;
      expect(preview.healthFactor).toBe(seam.healthFactor);
      expect(preview.liquidationPrice).toBe(seam.liquidationPrice);
      const band = seam.band === 'liquidatable' ? 'liquidatable'
        : preview.healthFactor < BORROW_MIN_HEALTH_AFTER ? 'too-close' : seam.band;
      expect(preview.band).toBe(band);
    }
    expect(previewHealth({ collateralAmount: E18, debtAmount: 0n }, pairAssets(read, STRK_USDC)!)).toEqual({ status: 'no-debt' });
    expect(previewHealth({ collateralAmount: E18, debtAmount: 1n }, pairAssets(market({ strk: { priceValid: false } }), STRK_USDC)!)).toEqual({ status: 'stale' });
  });

  it('fills a borrow Max that the seam accepts, at a health of 1.25 or a hair above', () => {
    const read = market();
    for (const [choice, held, added] of [
      [STRK_USDC, { collateralAmount: 0n, debtAmount: 0n }, 10_000n * E18],
      [STRK_USDC, { collateralAmount: 50_000n * E18, debtAmount: 300n * USDC_ONE }, 0n],
      [WBTC_USDC, { collateralAmount: 0n, debtAmount: 0n }, 12_345_678n],
    ] as const) {
      const loan = { collateralAmount: held.collateralAmount + added, debtAmount: held.debtAmount };
      const max = maxBorrow(read, choice, loan)!;
      expect(max > 0n).toBe(true);
      const position = held.collateralAmount === 0n ? undefined : { collateralShares: held.collateralAmount, nominalDebt: held.debtAmount, ...held };
      const assessed = assessBorrow({ kind: 'borrow', ...choice, collateralAmount: added, borrowAmount: max }, read, position);
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) continue;
      expect(assessed.after.healthFactor! >= MAX_FILL_HEALTH).toBe(true);
      // And it is the most: a thousandth more lands under 1.25.
      const more = assessBorrow({ kind: 'borrow', ...choice, collateralAmount: added, borrowAmount: max + max / 1000n + 1n }, read, position);
      expect(more.ok && more.after.healthFactor! >= MAX_FILL_HEALTH).toBe(false);
    }
  });

  it('keeps a borrow Max inside the debt cap, the utilization ceiling and the $10 floor', () => {
    const loan = { collateralAmount: 100_000n * E18, debtAmount: 0n };
    const capped = market({ pairs: [pair(STRK, USDC, 680_000_000_000_000_000n, { debtCap: 1_000n * USDC_ONE, totalDebt: 900n * USDC_ONE })] });
    const underCap = maxBorrow(capped, STRK_USDC, loan)!;
    expect(underCap).toBe(100n * USDC_ONE - 1n);
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 100_000n * E18, borrowAmount: underCap }, capped, undefined).ok).toBe(true);

    const busy = market({ usdc: { reserve: 600n * USDC_ONE, totalDebt: 9_000n * USDC_ONE } });
    const underCeiling = maxBorrow(busy, STRK_USDC, loan)!;
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 100_000n * E18, borrowAmount: underCeiling }, busy, undefined).ok).toBe(true);
    expect(underCeiling < 600n * USDC_ONE).toBe(true);

    // 100 STRK at $0.0414 backs about $2.25 at 1.25: under Vesu's $10 floor, so nothing to fill.
    expect(maxBorrow(market(), STRK_USDC, { collateralAmount: 100n * E18, debtAmount: 0n })).toBeNull();
    expect(maxBorrow(market({ strk: { priceValid: false } }), STRK_USDC, loan)).toBeNull();
  });

  it('fills a withdrawal Max the seam accepts, and the whole collateral when nothing is owed', () => {
    const read = market();
    const held = { collateralAmount: 50_000n * E18, debtAmount: 500n * USDC_ONE };
    const max = maxWithdraw(read, STRK_USDC, held)!;
    const position = { collateralShares: held.collateralAmount, nominalDebt: held.debtAmount, ...held };
    const assessed = assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: max }, read, position);
    expect(assessed.ok).toBe(true);
    if (assessed.ok) expect(assessed.after.healthFactor! >= MAX_FILL_HEALTH).toBe(true);
    const more = assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: max + max / 1000n + 1n }, read, position);
    expect(more.ok && more.after.healthFactor! >= MAX_FILL_HEALTH).toBe(false);

    expect(maxWithdraw(read, STRK_USDC, { collateralAmount: 7n * E18, debtAmount: 0n })).toBe(7n * E18);
    // A loan already under 1.25 has nothing to take back at Max.
    expect(maxWithdraw(read, STRK_USDC, { collateralAmount: 1_000n * E18, debtAmount: 25n * USDC_ONE })).toBeNull();
  });
});
