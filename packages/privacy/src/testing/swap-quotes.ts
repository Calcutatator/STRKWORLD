import { protectedMinimumOut } from '../protected-minimum.js';
import { AVNU_EXCHANGE, AVNU_SWAP_ENTRYPOINT, MAINNET_CHAIN_ID } from '../swap.js';
import { shadowAccountAddress } from '../vault.js';
import { PRICE_FEEDS, type PragmaPrice } from '../swap-prices.js';
import type { SwapPriceReader, SwapQuoteAnswer, SwapQuoteClient, VaultReadClient } from '../wallet-api/types.js';

/**
 * Test doubles for the shadow-account swap (D-084): a partial commitment, the
 * stand-in address the anonymizer derives from it, a read that answers it,
 * and a quote client that answers the way avnu's public `/swap/v3/build`
 * does for a one-route swap. No network. Not exported from the package.
 */

export const SWAP_TEST_PARTIAL = '0x5ab1e';
export const SWAP_TEST_SHADOW = shadowAccountAddress(SWAP_TEST_PARTIAL);
/** An ordinary avnu route's exchange (0dAMM's, from a live build on 2026-10-01). */
export const SWAP_TEST_ROUTE_EXCHANGE = '0x20d2431ba27021073cae53dab6d818b9e15f79e13639fd4f040f5b41a617fb6';

/** The backend's reads, answering the stand-in address and nothing else. */
export function swapTestReads(address: string = SWAP_TEST_SHADOW): VaultReadClient {
  return {
    async shadowAccount() { return { address, deployed: false }; },
    async vaultPositions() { throw new Error('a swap reads no Vault position'); },
    async vaultRates() { throw new Error('a swap reads no Vault rate'); },
  };
}

/** The serialized one-route `routes` array avnu builds: count, then a Direct route. */
export function oneRoute(sellToken: string, buyToken: string): string[] {
  return ['0x1', sellToken, buyToken, SWAP_TEST_ROUTE_EXCHANGE, '0xe8d4a51000', '0x1', '0x1'];
}

function felt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function u256(value: bigint): [string, string] {
  return [felt(value & ((1n << 128n) - 1n)), felt(value >> 128n)];
}

export interface SwapQuoteRequestRecord {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  taker: string;
  slippageBps: number;
}

/**
 * avnu's answer for `request`, built as its build endpoint builds one, with
 * `buyAmount` out and the protected minimum for the request's slippage.
 */
export function avnuAnswer(request: SwapQuoteRequestRecord, buyAmount: bigint, quoteId = 'quote-1'): SwapQuoteAnswer {
  const min = protectedMinimumOut(buyAmount, request.slippageBps);
  return {
    quoteId,
    chainId: MAINNET_CHAIN_ID,
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmount,
    buyAmount,
    calls: [{
      contractAddress: AVNU_EXCHANGE,
      entrypoint: AVNU_SWAP_ENTRYPOINT,
      calldata: [
        request.sellToken,
        ...u256(request.sellAmount),
        request.buyToken,
        ...u256(buyAmount),
        ...u256(min),
        request.taker,
        '0x0',
        '0x0',
        ...oneRoute(request.sellToken, request.buyToken),
      ],
    }],
  };
}

/**
 * A quote client whose `buyAmounts` answer each request in turn (the last
 * repeats), recording every request. `edit` may rewrite an answer, to make a
 * malformed or hostile one.
 */
export function swapTestQuotes(
  buyAmounts: readonly bigint[] = [95n],
  edit?: (answer: SwapQuoteAnswer, index: number) => unknown,
): SwapQuoteClient & { readonly requests: SwapQuoteRequestRecord[] } {
  const requests: SwapQuoteRequestRecord[] = [];
  return {
    requests,
    async quoteSwap(input) {
      const request = {
        sellToken: input.sellToken,
        buyToken: input.buyToken,
        sellAmount: input.sellAmount,
        taker: input.taker,
        slippageBps: input.slippageBps,
      };
      requests.push(request);
      const index = requests.length - 1;
      const buyAmount = buyAmounts.at(Math.min(index, buyAmounts.length - 1))!;
      const answer = avnuAnswer(request, buyAmount, `quote-${index + 1}`);
      return (edit ? edit(answer, index) : answer) as SwapQuoteAnswer;
    },
  };
}

/**
 * DEMO oracle prices (USD, 8 decimals) for every pinned feed, fresh at
 * `nowMs`, from 10 sources. STRK at $0.0431 matches `avnuAnswer`'s 431,000
 * USDC base units for 10 STRK. `overrides` replaces or drops (`null`) a pair.
 */
export function swapTestPrices(
  nowMs: number,
  overrides: Readonly<Record<string, Partial<PragmaPrice> | null>> = {},
): SwapPriceReader & { reads: number } {
  const base = new Map<string, bigint>([
    ['STRK/USD', 4_310_000n],
    ['ETH/USD', 400_000_000_000n],
    ['USDC/USD', 100_000_000n],
    ['USDT/USD', 100_000_000n],
    ['WBTC/USD', 10_000_000_000_000n],
    ['WSTETH/USD', 480_000_000_000n],
    ['LORDS/USD', 2_000_000n],
    ['EKUBO/USD', 100_000_000n],
  ]);
  const replaced = new Map(Object.entries(overrides));
  const reader = {
    reads: 0,
    async read() {
      reader.reads += 1;
      const prices: PragmaPrice[] = [];
      for (const feed of PRICE_FEEDS) {
        const override = replaced.get(feed.pair);
        if (override === null) continue;
        prices.push({
          pair: feed.pair,
          price: base.get(feed.pair)!,
          decimals: 8,
          updatedAt: Math.floor(nowMs / 1000),
          sources: 10,
          ...override,
        });
      }
      return prices;
    },
  };
  return reader;
}
