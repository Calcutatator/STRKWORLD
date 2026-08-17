/**
 * Token amount parsing and display.
 *
 * `bigint` in, string out, never the reverse shortcut. Token amounts exceed
 * `Number.MAX_SAFE_INTEGER` routinely, so there is deliberately no `number`
 * anywhere in this file — a silent precision loss here is a lost-funds bug.
 */

export const STRK_DECIMALS = 18;
export const STRK_SYMBOL = 'STRK';

/**
 * Parse player input into a raw token amount.
 *
 * Returns `null` for anything that is not an unambiguous non-negative decimal,
 * including input with more fraction digits than the token has. Truncating
 * those digits would quietly change the amount the player typed, which is not
 * a thing to do to somebody's money.
 */
export function parseTokenAmount(
  input: string,
  decimals: number = STRK_DECIMALS,
): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;

  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * Full-precision display. Use wherever the number is the thing being agreed to
 * — the review screen, the confirm button, a receipt.
 */
export function formatTokenAmountExact(
  amount: bigint,
  decimals: number = STRK_DECIMALS,
): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * Shortened display for ambient UI — a HUD, a list row.
 *
 * Truncates towards zero rather than rounding: showing more than the player
 * has is worse than showing slightly less. Anywhere the exact figure matters,
 * use `formatTokenAmountExact`.
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number = STRK_DECIMALS,
  maxFractionDigits = 4,
): string {
  const exact = formatTokenAmountExact(amount, decimals);
  const dot = exact.indexOf('.');
  if (dot === -1) return exact;
  const trimmed = exact.slice(0, dot + 1 + maxFractionDigits).replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/**
 * `"12.5 STRK"`, shortened. For ambient display only — the HUD, a list of
 * balances. Never for a figure the player is agreeing to.
 */
export function formatStrk(amount: bigint): string {
  return `${formatTokenAmount(amount)} ${STRK_SYMBOL}`;
}

/** `"12.500000000000000001 STRK"`. Every figure at the commit point uses this. */
export function formatStrkExact(amount: bigint): string {
  return `${formatTokenAmountExact(amount)} ${STRK_SYMBOL}`;
}

/**
 * Shape check for a Starknet address typed by a player.
 *
 * Deliberately only a shape check: `packages/privacy` owns real validation and
 * the pool owns the truth. This exists so the panel can say "that is not an
 * address" before spending a round trip to find out.
 */
export function looksLikeAddress(input: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(input.trim());
}

/**
 * Padding-tolerant address comparison.
 *
 * The same address arrives padded from one source and unpadded from another,
 * so `===` silently answers "different" for two spellings of one account.
 */
export function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/** `0x04ab…c938d`. For display only — never compare shortened addresses. */
export function shortenAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 13) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-5)}`;
}
