import { describe, expect, it, vi } from 'vitest';
import { PRAGMA_ORACLE, PRICE_FEEDS, SWAP_PRICE_BOUND_BPS, checkSwapPrice, priceFeed, type PragmaPrice } from './swap-prices.js';
import { PragmaPriceReader } from './wallet-api/pragma-prices.js';

/** D-084: the swap's independent oracle check, and the reader that feeds it. */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const UNPRICED = '0x0666';
const NOW = 1_790_000_000_000;
const fresh = (pair: string, price: bigint, decimals = 8): PragmaPrice => ({ pair, price, decimals, updatedAt: NOW / 1000, sources: 10 });
const PRICES = [fresh('STRK/USD', 4_310_000n), fresh('USDC/USD', 999_960n, 6)];
const check = (buyAmount: bigint, prices: readonly PragmaPrice[] | null = PRICES, buyToken = USDC) => checkSwapPrice({
  sellToken: STRK, buyToken, sellAmount: 10n ** 19n, buyAmount, prices, nowMs: NOW,
});

describe('checkSwapPrice', () => {
  it('pins Pragma on mainnet, a 3% bound, and a feed for the five majors, wstETH, LORDS and EKUBO, not strkBTC', () => {
    expect(PRAGMA_ORACLE).toBe('0x02a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b');
    expect(SWAP_PRICE_BOUND_BPS).toBe(300);
    expect(PRICE_FEEDS.map((feed) => feed.pair)).toEqual(['STRK/USD', 'ETH/USD', 'USDC/USD', 'USDT/USD', 'WBTC/USD', 'WSTETH/USD', 'LORDS/USD', 'EKUBO/USD']);
    expect(priceFeed('0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135')).toBeUndefined();
    expect(priceFeed(`0x${BigInt(STRK).toString(16)}`)?.symbol).toBe('STRK');
  });

  it('checks a quote at the oracle value, with both USD values in 8 decimals', () => {
    // 10 STRK at $0.0431 = $0.431; 431,017 USDC base units at $0.99996 ≈ $0.431.
    expect(check(431_017n)).toEqual({ status: 'checked', boundBps: 300, sellUsd: 43_100_000n, expectedBuyUsd: 43_099_975n, shortfallBps: 0 });
    // A better quote is fine; it reads as negative shortfall.
    expect(check(450_000n)).toMatchObject({ status: 'checked', shortfallBps: -440 });
  });

  it('accepts exactly the bound and refuses past it: a 2%-of-fair route never reaches the review', () => {
    expect(check(418_100n)).toMatchObject({ shortfallBps: 299 });
    expect(() => check(417_000n)).toThrow(/below the oracle price, more than the 3% allowed/);
    expect(() => check(8_620n)).toThrow(/98\.00% below/);
  });

  it.each([
    ['missing', [fresh('STRK/USD', 4_310_000n)]],
    ['stale', [...PRICES.slice(0, 1), { ...fresh('USDC/USD', 999_960n, 6), updatedAt: NOW / 1000 - 1_801 }]],
    ['from too few sources', [...PRICES.slice(0, 1), { ...fresh('USDC/USD', 999_960n, 6), sources: 2 }]],
    ['zero', [...PRICES.slice(0, 1), fresh('USDC/USD', 0n)]],
    ['twice', [...PRICES, fresh('USDC/USD', 1n)]],
  ])('refuses a pinned pair whose price is %s', (_label, prices) => {
    expect(() => check(431_017n, prices)).toThrow(/USDC\/USD is missing or stale/);
  });

  it('refuses as unreachable when the reader failed and both sides are priced', () => {
    expect(() => check(431_017n, null)).toThrow(expect.objectContaining({ kind: 'unreachable' }));
  });

  it('leaves a pair with an unpriced token unchecked, with the priced side\'s USD when it can be read', () => {
    expect(check(5n, PRICES, UNPRICED)).toEqual({ status: 'unchecked', boundBps: 300, sellUsd: 43_100_000n });
    expect(check(5n, null, UNPRICED)).toEqual({ status: 'unchecked', boundBps: 300 });
    expect(check(5n, [], UNPRICED)).toEqual({ status: 'unchecked', boundBps: 300 });
    expect(checkSwapPrice({ sellToken: UNPRICED, buyToken: '0x0777', sellAmount: 1n, buyAmount: 1n, prices: PRICES, nowMs: NOW }))
      .toEqual({ status: 'unchecked', boundBps: 300 });
  });
});

describe('PragmaPriceReader', () => {
  const answer = (batch: Array<{ id: number }>) => batch.map(({ id }) => ({
    jsonrpc: '2.0', id, result: ['0x41c3f0', '0x8', '0x6abe4d52', '0xb', '0x0', '0x0'],
  }));
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

  it('asks the wallet\'s RPC for every pinned pair in one fixed batch, and caches for 30 s', async () => {
    let now = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => ok(answer(JSON.parse(String(init?.body)))));
    const reader = new PragmaPriceReader('https://rpc.example', { fetch, now: () => now });
    const prices = await reader.read();
    expect(prices).toHaveLength(8);
    expect(prices[0]).toEqual({ pair: 'STRK/USD', price: 0x41c3f0n, decimals: 8, updatedAt: 0x6abe4d52, sources: 11 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://rpc.example');
    const batch = JSON.parse(String(init?.body)) as Array<{ method: string; params: [{ contract_address: string; calldata: string[] }] }>;
    expect(batch.map((call) => call.method)).toEqual(Array(8).fill('starknet_call'));
    expect(batch.every((call) => call.params[0].contract_address === PRAGMA_ORACLE && call.params[0].calldata[0] === '0x0')).toBe(true);
    await reader.read();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 30_000;
    await reader.read();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to one call at a time for a node that refuses batches, and drops a failed pair', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number } | Array<{ id: number }>;
      if (Array.isArray(body)) return ok({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch refused' } });
      return ok(body.id === 3 ? { jsonrpc: '2.0', id: 3, error: { code: 40 } } : answer([body])[0]);
    });
    const prices = await new PragmaPriceReader('https://rpc.example', { fetch }).read();
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(prices.map((price) => price.pair)).not.toContain('USDC/USD');
    expect(prices).toHaveLength(7);
  });

  it('refuses a non-https RPC, and reports a failed node as unreachable', async () => {
    expect(() => new PragmaPriceReader('http://rpc.example')).toThrow(/https/);
    const down = new PragmaPriceReader('https://rpc.example', { fetch: async () => ({ ok: false, status: 503, text: async () => '' }) as Response });
    await expect(down.read()).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
