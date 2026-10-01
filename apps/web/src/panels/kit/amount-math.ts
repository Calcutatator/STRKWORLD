import { formatTokenAmount, parseTokenAmount, sameAddress } from '../../format.js';
import { COPY } from '../../copy.js';

/**
 * The kit's amount maths: what Max fills in, whether a typed amount is usable,
 * and what the primary button says. `bigint` throughout, parsing and display
 * through `format.ts`, never a `number` for an amount.
 */

/**
 * What a typed amount is, against the figures a panel knows.
 *
 * `empty` is not a problem, just nothing yet; the field shows no error for it.
 */
export type AmountCheck =
  | { readonly status: 'empty'; readonly amount: null }
  | { readonly status: 'invalid'; readonly amount: null }
  | { readonly status: 'exceeds-balance' | 'below-minimum' | 'ok'; readonly amount: bigint };

export function checkAmount(
  text: string,
  options: { readonly decimals: number; readonly balance?: bigint | null; readonly minimum?: bigint | null },
): AmountCheck {
  if (text.trim() === '') return { status: 'empty', amount: null };
  const amount = parseTokenAmount(text, options.decimals);
  if (amount === null) return { status: 'invalid', amount: null };
  if (amount === 0n) return { status: 'empty', amount: null };
  if (options.balance !== undefined && options.balance !== null && amount > options.balance) {
    return { status: 'exceeds-balance', amount };
  }
  if (options.minimum !== undefined && options.minimum !== null && amount < options.minimum) {
    return { status: 'below-minimum', amount };
  }
  return { status: 'ok', amount };
}

/**
 * The pool fee a Max must leave behind for this token: the fee itself when
 * this token is the fee token, nothing otherwise. An unknown fee (`null`)
 * reserves an unknown amount, so the answer is unknown too.
 */
export function feeReserve(
  token: string,
  pool: { readonly feeAmount: bigint; readonly feeToken: string } | null,
): bigint | null {
  if (pool === null) return null;
  return sameAddress(token, pool.feeToken) ? pool.feeAmount : 0n;
}

/**
 * The most a player can put in: what is spendable less what must stay behind.
 *
 * `null` means "no honest Max", and the button is disabled: the spendable
 * figure is unknown (no balance read), the reserve is unknown, or nothing is
 * left after it. A wallet that reports one total per token and no maturity
 * split passes that total (D-089, `maxBasis`, D-090): the wallet refuses a
 * spend that counts a note still maturing, so no funds are at risk.
 */
export function maxAfterReserve(spendable: bigint | null, reserve: bigint | null = 0n): bigint | null {
  if (spendable === null || reserve === null) return null;
  const left = spendable - reserve;
  return left > 0n ? left : null;
}

/**
 * What a Max may fill from, for one token's pool balance: the spendable
 * figure when the wallet splits it, otherwise the per-token total
 * `wallet_strk20Balances` returns (D-089, D-090, amending D-022). That total is the
 * figure the balance line already shows and a player may type in by hand, so
 * Max fills in nothing a typed amount could not; a note received in the last
 * few blocks may not be spendable yet, and the wallet, which proves, refuses
 * a spend it cannot make. `null` (no balance read) is no Max.
 */
export function maxBasis(balance: { readonly total: bigint; readonly spendable: bigint; readonly maturityKnown: boolean } | null): bigint | null {
  if (balance === null) return null;
  return balance.maturityKnown ? balance.spendable : balance.total;
}

/**
 * `amount` floored to a tidy figure for a Max to fill in: two decimals for a
 * stablecoin, six significant figures for anything else (never coarser than
 * whole tokens), and never more places than the token has. Only ever rounds
 * down, so a tidied Max is always within the exact one; the maths that
 * produced it stays exact.
 */
export function tidyFloor(amount: bigint, decimals: number, options: { readonly stable?: boolean } = {}): bigint {
  if (amount <= 0n) return 0n;
  const integerDigits = amount.toString().length - decimals;
  const wanted = options.stable ? 2 : 6 - integerDigits;
  const keep = Math.max(0, Math.min(decimals, wanted));
  const unit = 10n ** BigInt(decimals - keep);
  return amount - (amount % unit);
}

/** `amount × numerator / denominator`, truncated towards zero. 50% is `(amount, 1n, 2n)`. */
export function fractionOf(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n || amount < 0n) throw new RangeError('fractionOf takes non-negative figures');
  return (amount * numerator) / denominator;
}

/**
 * The primary button's words and whether it can be pressed.
 *
 * In order: busy, no token, no amount, an unusable amount, then ready. The
 * caller supplies its own ready and busy words ("Review swap", "Preparing…").
 */
export function primaryAction(input: {
  readonly check: AmountCheck;
  readonly symbol: string | null;
  readonly ready: string;
  readonly busy?: string | null;
  /** The words for an amount above the balance; "Insufficient {symbol}" by default. */
  readonly exceeds?: string;
}): { readonly label: string; readonly disabled: boolean } {
  if (input.busy) return { label: input.busy, disabled: true };
  if (input.symbol === null) return { label: COPY.kit.chooseToken, disabled: true };
  switch (input.check.status) {
    case 'empty':
      return { label: COPY.kit.enterAmount, disabled: true };
    case 'invalid':
      return { label: COPY.kit.invalidAmount, disabled: true };
    case 'exceeds-balance':
      return { label: input.exceeds ?? COPY.kit.insufficient.replace('{symbol}', input.symbol), disabled: true };
    case 'below-minimum':
      return { label: COPY.kit.belowMinimum, disabled: true };
    case 'ok':
      return { label: input.ready, disabled: false };
  }
}

/** `"12.5 STRK"`, shortened, for the balance line. Never a commit-point figure. */
export function balanceText(amount: bigint, decimals: number, symbol: string): string {
  return `${formatTokenAmount(amount, decimals)} ${symbol}`;
}
