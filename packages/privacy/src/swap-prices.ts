import type { SwapPriceCheck } from './operations.js';
import { PrivacyError, SwapPriceGuardError, type Address } from './types.js';

/**
 * The swap's independent price check (D-084). avnu's quote fixes the floor
 * the chain enforces, so a lying quote (a compromised avnu answer, proxy or
 * `AVNU_BASE_URL`) could route through a pool at a fraction of fair value and
 * still pass its own floor. Before the player sees a price, the expected
 * output is held against Pragma's on-chain spot prices, read by the browser
 * over the wallet's own RPC, never through STRKWORLD's backend or avnu.
 *
 * D-126 gives the degen floor its own, wider pair of limits
 * (`SWAP_DEGEN_PRICE_BOUND_BPS`, `SWAP_DEGEN_MAX_SLIPPAGE_BPS`), passed in by
 * the caller. Everything below is otherwise unchanged, and the Exchange's
 * numbers are the defaults.
 *
 * - Both tokens have a pinned feed: the expected output's USD value may fall
 *   at most `boundBps` below the sell amount's, and the floor the
 *   chain enforces (`minAmountOut`) at most the bound plus the slippage, or
 *   the swap is refused before the review. The floor is what a hostile route
 *   can actually deliver, so it is checked itself, not only the quote. A pinned feed that cannot be read, is stale or
 *   has too few sources refuses too: a token that should be checked is never
 *   quietly left unchecked.
 * - Either token has no pinned feed (most of the degen floor): the review says
 *   there is no independent price check, and the swap needs the player's
 *   explicit acknowledgement at confirmation.
 *
 * Read on mainnet over `https://api.cartridge.gg/x/starknet/mainnet` on
 * 2026-10-01: the oracle's class is
 * `0x4d6370214accdaac8cc249db34a916c92464235b87cf03641a85889d2f6d8e7`, and
 * `get_data_median(SpotEntry(pair))` answered each pinned pair below with
 * 8 or 6 decimals, a timestamp about 540 s old (Pragma pushes on
 * deviation and heartbeat, not every block, hence the 30-minute staleness
 * bound) and 3 to 11 sources.
 * strkBTC/USD answered all zeros: it has no feed, so it is unchecked.
 */

/** Pragma's oracle on Starknet mainnet. */
export const PRAGMA_ORACLE = '0x02a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b';

/** How far below the oracle value the expected output may sit: 3%, which covers avnu's 0.1% fee, the slippage and ordinary price impact. */
export const SWAP_PRICE_BOUND_BPS = 300;

/**
 * The widest slippage a swap may use (D-084): with the 3% bound, the floor
 * the chain enforces is never more than 6% below the oracle value.
 */
export const SWAP_MAX_SLIPPAGE_BPS = 300;

/**
 * D-126: the degen floor's own oracle bound, 12%. Its tokens are the thin,
 * illiquid ones the ground floor does not list, and routed liquidity there is
 * genuinely worse than Pragma's median — a 3% bound refused every real LORDS
 * quote before the wallet was ever asked. The guard is not removed upstairs,
 * only widened, and the review says in plain words how far below market the
 * quote sits whenever it passes 3%.
 */
export const SWAP_DEGEN_PRICE_BOUND_BPS = 1_200;

/**
 * D-126: the widest slippage a degen swap may use, 8%. With the 12% bound the
 * floor the chain enforces upstairs is never more than 20% below the oracle
 * value — wide, and deliberately so: the ground floor's 6% is unchanged.
 */
export const SWAP_DEGEN_MAX_SLIPPAGE_BPS = 800;

/**
 * D-126: past this, a quote that still passes its floor's bound is shown with
 * a small warning line in the review. 3% on both floors, so the ground floor's
 * old refusal threshold becomes the degen floor's warning threshold.
 */
export const SWAP_PRICE_WARN_BPS = 300;

/** A Pragma price older than this is stale, in seconds. */
export const PRAGMA_MAX_AGE_S = 1_800;

/** A Pragma median from fewer sources than this is not independent enough. */
export const PRAGMA_MIN_SOURCES = 3;

/** USD values are carried with 8 decimals. */
export const USD_DECIMALS = 8;

export interface PriceFeed {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** Pragma's pair id, as its short string. */
  readonly pair: string;
}

/**
 * Every token the swap can check, with its Pragma pair. Tokens are compared
 * by field value. WBTC uses its own WBTC/USD pair, not BTC/USD.
 */
export const PRICE_FEEDS: readonly PriceFeed[] = Object.freeze([
  { token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', symbol: 'STRK', decimals: 18, pair: 'STRK/USD' },
  { token: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', symbol: 'ETH', decimals: 18, pair: 'ETH/USD' },
  { token: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', symbol: 'USDC', decimals: 6, pair: 'USDC/USD' },
  { token: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', symbol: 'USDT', decimals: 6, pair: 'USDT/USD' },
  { token: '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', symbol: 'WBTC', decimals: 8, pair: 'WBTC/USD' },
  { token: '0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b', symbol: 'wstETH', decimals: 18, pair: 'WSTETH/USD' },
  { token: '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49', symbol: 'LORDS', decimals: 18, pair: 'LORDS/USD' },
  { token: '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87', symbol: 'EKUBO', decimals: 18, pair: 'EKUBO/USD' },
].map((feed) => Object.freeze(feed)));

/** One Pragma answer, as the reader owns it. */
export interface PragmaPrice {
  readonly pair: string;
  readonly price: bigint;
  readonly decimals: number;
  /** Unix seconds. */
  readonly updatedAt: number;
  readonly sources: number;
}

export function priceFeed(token: unknown): PriceFeed | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    const value = BigInt(token);
    return PRICE_FEEDS.find((feed) => BigInt(feed.token) === value);
  } catch {
    return undefined;
  }
}

/**
 * Hold a quote against the oracle. Refuses (`unknown`) when both tokens have
 * feeds and the output is worth more than the bound below the input, or a
 * pinned feed's price is missing, stale, too thinly sourced or zero.
 * `prices` is null when the reader could not be asked at all; with feeds on
 * both sides that refuses as `unreachable`. A pair with a token that has no
 * feed is `unchecked`, carrying the USD value of a side the oracle prices.
 */
export function checkSwapPrice(input: {
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  /** The floor the chain enforces: `buy_token_min_amount`. */
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
  readonly prices: readonly PragmaPrice[] | null;
  readonly nowMs: number;
  /**
   * D-126: how far below the oracle value this floor lets the expected output
   * sit. The Exchange's `SWAP_PRICE_BOUND_BPS` unless the degen floor passes
   * its own, wider one; never above `SWAP_DEGEN_PRICE_BOUND_BPS`.
   */
  readonly boundBps?: number;
  /** D-126: the widest slippage this floor allows, `SWAP_MAX_SLIPPAGE_BPS` by default. */
  readonly maxSlippageBps?: number;
}): SwapPriceCheck {
  const boundBps = ownBound(input.boundBps, SWAP_PRICE_BOUND_BPS, SWAP_DEGEN_PRICE_BOUND_BPS);
  const maxSlippageBps = ownBound(input.maxSlippageBps, SWAP_MAX_SLIPPAGE_BPS, SWAP_DEGEN_MAX_SLIPPAGE_BPS);
  const sellFeed = priceFeed(input.sellToken);
  const buyFeed = priceFeed(input.buyToken);
  const value = (feed: PriceFeed, amount: bigint): bigint => {
    const price = usablePrice(input.prices!, feed.pair, input.nowMs);
    return (amount * price.price * 10n ** BigInt(USD_DECIMALS)) / (10n ** BigInt(feed.decimals) * 10n ** BigInt(price.decimals));
  };
  if (!sellFeed || !buyFeed) {
    // Nothing independent can vouch for this pair. Show what the oracle says
    // of the side it prices, when it can be read; a failed read hides it.
    const tryValue = (feed: PriceFeed | undefined, amount: bigint): bigint | undefined => {
      if (!feed || input.prices === null) return undefined;
      try { return value(feed, amount); } catch { return undefined; }
    };
    const sellUsd = tryValue(sellFeed, input.sellAmount);
    const expectedBuyUsd = tryValue(buyFeed, input.buyAmount);
    return Object.freeze({
      status: 'unchecked',
      boundBps,
      ...(sellUsd !== undefined ? { sellUsd } : {}),
      ...(expectedBuyUsd !== undefined ? { expectedBuyUsd } : {}),
    });
  }
  if (input.prices === null) {
    throw new PrivacyError('unreachable', 'The swap could not read the oracle price to check this quote, so nothing was sent.');
  }
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps <= 0 || input.slippageBps > maxSlippageBps) {
    throw new PrivacyError('unknown', `A swap's slippage may be at most ${maxSlippageBps / 100}%.`);
  }
  const sellUsd = value(sellFeed, input.sellAmount);
  const expectedBuyUsd = value(buyFeed, input.buyAmount);
  const floorUsd = value(buyFeed, input.minAmountOut);
  if (sellUsd <= 0n) {
    throw new PrivacyError('unknown', 'This amount is too small to check against the oracle price.');
  }
  const shortfallBps = Number(((sellUsd - expectedBuyUsd) * 10_000n) / sellUsd);
  if (shortfallBps > boundBps) {
    throw new SwapPriceGuardError(
      `avnu's quote is ${(shortfallBps / 100).toFixed(2)}% below the oracle price, more than the ${boundBps / 100}% allowed, so it was refused.`,
      { shortfallBps, boundBps },
    );
  }
  // The floor itself: what the chain lets a route deliver. Refused unless
  // minAmountOut ≥ oracle value × (1 − bound − slippage).
  const floorAllowanceBps = BigInt(boundBps + input.slippageBps);
  if (floorUsd * 10_000n < sellUsd * (10_000n - floorAllowanceBps)) {
    throw new SwapPriceGuardError(
      `The swap's minimum output is more than ${Number(floorAllowanceBps) / 100}% below the oracle price, so it was refused.`,
      { shortfallBps: Number(((sellUsd - floorUsd) * 10_000n) / sellUsd), boundBps: Number(floorAllowanceBps) },
    );
  }
  return Object.freeze({ status: 'checked', boundBps, sellUsd, expectedBuyUsd, shortfallBps });
}

/**
 * D-126: a floor's own bound, defaulting to the Exchange's. A caller may only
 * widen it as far as the degen floor's cap; anything else (a malformed number,
 * a zero, a value past the cap) falls back to the Exchange's, so a misread
 * config can never loosen the guard.
 */
function ownBound(value: number | undefined, fallback: number, cap: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > cap) return fallback;
  return value;
}

function usablePrice(prices: readonly PragmaPrice[], pair: string, nowMs: number): PragmaPrice {
  const matches = prices.filter((price) => price.pair === pair);
  const price = matches.length === 1 ? matches[0]! : undefined;
  const ageS = price ? Math.floor(nowMs / 1000) - price.updatedAt : Infinity;
  if (
    !price
    || typeof price.price !== 'bigint' || price.price <= 0n
    || !Number.isSafeInteger(price.decimals) || price.decimals < 0 || price.decimals > 36
    || !Number.isSafeInteger(price.sources) || price.sources < PRAGMA_MIN_SOURCES
    || !Number.isSafeInteger(price.updatedAt) || ageS > PRAGMA_MAX_AGE_S || ageS < -300
  ) {
    throw new PrivacyError('unknown', `The oracle price for ${pair} is missing or stale, so this swap cannot be checked and was refused.`);
  }
  return price;
}
