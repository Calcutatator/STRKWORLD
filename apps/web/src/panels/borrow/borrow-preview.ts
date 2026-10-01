import type { BorrowAsset, BorrowMarket } from '@strkworld/privacy';
import { sameAddress } from '../../format.js';
import type { BorrowPairChoice } from './borrow-machine.js';

/**
 * The Borrow counter's live preview (D-089): the health factor a typed amount
 * would leave, the price it would turn liquidatable at, and what Max fills
 * in. Display only. The seam re-reads Vesu and runs `assessBorrow` before the
 * wallet is asked anything, and its refusals stand (D-083); this module only
 * lets the form say early what the review will say.
 *
 * `apps/web` may not import a runtime value from `@strkworld/privacy`
 * (`architecture.test.ts`), so Vesu's few formulas are restated here, in the
 * seam's own rounding: collateral valued down, debt valued up, a base unit
 * more debt on a borrow and a base unit less collateral on a withdrawal.
 * `borrow-preview.test.ts` holds every figure equal to the seam's
 * `borrowHealth` and `assessBorrow` on the same reads.
 */

const SCALE = 10n ** 18n;

/** D-083's floor for risk-adding actions, as the seam holds it (`BORROW_MIN_HEALTH_AFTER`). */
export const PREVIEW_MIN_HEALTH = 1_050_000_000_000_000_000n;

/** D-083's warning band, as the seam holds it (`BORROW_WARNING_HEALTH`). */
export const PREVIEW_WARNING_HEALTH = 1_150_000_000_000_000_000n;

/**
 * What Max aims for (D-089): a health factor of 1.25, which is an LTV of 80%
 * of the pair's max. Safer than D-083's 1.05 floor on purpose: the collateral
 * can lose a fifth of its price against the debt before the loan turns
 * liquidatable, and a Max-filled loan starts clear of the 1.15 warning band.
 * Aave's Max is the whole limit; ours is not. Typing more is still allowed
 * down to the 1.05 floor, and the health row says how close that is.
 */
export const MAX_FILL_HEALTH = 1_250_000_000_000_000_000n;

/** A loan as the preview sees it: amounts in base units. */
export interface PreviewLoan {
  readonly collateralAmount: bigint;
  readonly debtAmount: bigint;
}

export type PreviewBand = 'none' | 'safe' | 'warning' | 'too-close' | 'liquidatable';

/** A loan's figures at Vesu's prices as read, or `stale` when a price is not valid. */
export type PreviewHealth =
  | { readonly status: 'stale' }
  | { readonly status: 'no-debt' }
  | {
      readonly status: 'priced';
      /** × 10^18, truncated as the seam does. */
      readonly healthFactor: bigint;
      /** The collateral's USD price × 10^18 at which the loan turns liquidatable; null with no collateral. */
      readonly liquidationPrice: bigint | null;
      readonly band: PreviewBand;
    };

interface PairAssets {
  readonly collateral: BorrowAsset;
  readonly debt: BorrowAsset;
  readonly maxLtv: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}

function collateralValue(amount: bigint, asset: Pick<BorrowAsset, 'price' | 'scale'>): bigint {
  return (amount * asset.price) / asset.scale;
}

function debtValue(amount: bigint, asset: Pick<BorrowAsset, 'price' | 'scale'>): bigint {
  return ceilDiv(amount * asset.price, asset.scale);
}

/**
 * The pair's assets and max LTV from a market read. A pair Vesu no longer
 * offers is absent from `market.pairs`; `pairMaxLtv` stands in for it.
 */
export function pairAssets(market: BorrowMarket, pair: BorrowPairChoice, pairMaxLtv?: bigint): PairAssets | null {
  const collateral = market.assets.find((asset) => sameAddress(asset.token, pair.collateral));
  const debt = market.assets.find((asset) => sameAddress(asset.token, pair.debt));
  const offered = market.pairs.find((entry) => sameAddress(entry.collateral, pair.collateral) && sameAddress(entry.debt, pair.debt));
  const maxLtv = offered?.maxLtv ?? pairMaxLtv;
  if (!collateral || !debt || maxLtv === undefined || maxLtv <= 0n) return null;
  return { collateral, debt, maxLtv };
}

/** A loan's health at the read prices, as the seam's `borrowHealth` gives it, with the floor as its own band. */
export function previewHealth(loan: PreviewLoan, assets: PairAssets): PreviewHealth {
  const { collateral, debt, maxLtv } = assets;
  if (!collateral.priceValid || !debt.priceValid) return { status: 'stale' };
  const cv = collateralValue(loan.collateralAmount, collateral);
  const dv = debtValue(loan.debtAmount, debt);
  if (dv === 0n) return { status: 'no-debt' };
  const healthFactor = (cv * maxLtv) / dv;
  const liquidationPrice = loan.collateralAmount > 0n
    ? ceilDiv(dv * collateral.scale * SCALE, loan.collateralAmount * maxLtv)
    : null;
  const band: PreviewBand = cv * maxLtv < dv * SCALE
    ? 'liquidatable'
    : cv * maxLtv < dv * PREVIEW_MIN_HEALTH
      ? 'too-close'
      : healthFactor < PREVIEW_WARNING_HEALTH ? 'warning' : 'safe';
  return { status: 'priced', healthFactor, liquidationPrice, band };
}

/**
 * The most a borrow may add to `loan` (whose collateral already counts any
 * collateral being added) and leave health at `target` or above, within
 * Vesu's debt cap, its utilization ceiling and its $10 floor. Null when
 * nothing can be borrowed or a price is stale.
 */
export function maxBorrow(
  market: BorrowMarket,
  pair: BorrowPairChoice,
  loan: PreviewLoan,
  target: bigint = MAX_FILL_HEALTH,
): bigint | null {
  const assets = pairAssets(market, pair);
  const offered = market.pairs.find((entry) => sameAddress(entry.collateral, pair.collateral) && sameAddress(entry.debt, pair.debt));
  if (!assets || !offered || offered.debtCap <= 0n) return null;
  const { collateral, debt, maxLtv } = assets;
  if (!collateral.priceValid || !debt.priceValid || debt.price <= 0n) return null;
  // debtValue(after) × target ≤ collateralValue × maxLtv, with the seam's base unit more debt.
  const limitUsd = (collateralValue(loan.collateralAmount, collateral) * maxLtv) / target;
  const debtLimit = (limitUsd * debt.scale) / debt.price;
  let amount = debtLimit - loan.debtAmount - 1n;
  // The pair's debt cap and the asset's utilization ceiling.
  amount = min(amount, offered.debtCap - offered.totalDebt - 1n);
  const utilizationLimit = (debt.maxUtilization * (debt.reserve + debt.totalDebt)) / SCALE - debt.totalDebt;
  amount = min(amount, utilizationLimit, debt.reserve);
  if (amount <= 0n) return null;
  // Vesu's floors: the debt after, and the collateral behind it, must each be worth more than theirs.
  if (debtValue(loan.debtAmount + amount + 1n, debt) <= debt.floor) return null;
  if (collateralValue(loan.collateralAmount, collateral) <= collateral.floor) return null;
  return amount;
}

/**
 * The most collateral a withdrawal may take from `loan` and leave health at
 * `target` or above, within the asset's liquidity. With nothing owed it is
 * the whole collateral (a withdraw-all). Null when nothing can be withdrawn
 * or a price is stale.
 */
export function maxWithdraw(
  market: BorrowMarket,
  pair: BorrowPairChoice,
  loan: PreviewLoan,
  pairMaxLtv?: bigint,
  target: bigint = MAX_FILL_HEALTH,
): bigint | null {
  if (loan.collateralAmount <= 0n) return null;
  if (loan.debtAmount === 0n) return loan.collateralAmount;
  const assets = pairAssets(market, pair, pairMaxLtv);
  if (!assets) return null;
  const { collateral, debt, maxLtv } = assets;
  if (!collateral.priceValid || !debt.priceValid || collateral.price <= 0n) return null;
  // collateralValue(after) × maxLtv ≥ debtValue × target, with the seam's base unit less collateral.
  const neededUsd = ceilDiv(debtValue(loan.debtAmount, debt) * target, maxLtv);
  // Vesu's floor: the collateral left must be worth more than it while anything is owed.
  const floorAmount = ceilDiv((collateral.floor + 1n) * collateral.scale, collateral.price);
  const neededAmount = max(ceilDiv(neededUsd * collateral.scale, collateral.price), floorAmount);
  let amount = loan.collateralAmount - 1n - neededAmount;
  // Liquidity: what the pool holds, and its utilization ceiling once this leaves.
  const { reserve, totalDebt, maxUtilization } = collateral;
  const utilizationLimit = maxUtilization > 0n ? reserve + totalDebt - ceilDiv(totalDebt * SCALE, maxUtilization) : totalDebt === 0n ? reserve : 0n;
  amount = min(amount, reserve, utilizationLimit);
  return amount > 0n ? amount : null;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function min(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((low, value) => (value < low ? value : low), first);
}
