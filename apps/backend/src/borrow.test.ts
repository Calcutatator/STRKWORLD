import { hash } from 'starknet';
import { describe, expect, it, vi } from 'vitest';
import { BackendApi } from './api.js';
import { MemoryAuthorizationCodec } from './authorization.js';
import {
  ASSET_CONFIG_SELECTOR,
  BORROW_MARKET_PATH,
  BORROW_PAIRS,
  BORROW_POOL,
  BORROW_POSITION_PATH,
  BORROW_TOKENS,
  PAIR_CONFIG_SELECTOR,
  PAIRS_SELECTOR,
  POSITION_SELECTOR,
  PRICE_SELECTOR,
} from './borrow.js';
import { createBackendRuntime } from './runtime.js';
import { StarknetRpcPoolPort, VAULT_RPC_BATCH_SIZE, VAULT_RPC_FALLBACK_CONCURRENCY } from './starknet-rpc.js';
import type { BackendConfig, BorrowMarketRead, BorrowRpcPort, PoolRpcPort } from './types.js';
import { VAULT_SHADOW_ACCOUNT_PATH, VESU_PRIME_POOL } from './vault.js';

/**
 * D-083: the Borrow counter's public reads. Both are pinned to Vesu's Prime
 * pool, its five tokens and their twenty pairs; the market read takes nothing
 * from the request and the position read takes the account alone, and
 * neither logs anything about it. A failed or malformed call fails its own
 * row only.
 */

const POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const USDT = '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8';
const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
const SHADOW = '0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9';
const FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const E18 = 10n ** 18n;
const MASK = (1n << 128n) - 1n;

const hex = (value: bigint) => `0x${value.toString(16)}`;
const u256 = (value: bigint) => [hex(value & MASK), hex(value >> 128n)];

describe('the pinned Borrow pool, tokens, pairs and selectors (D-083)', () => {
  it('reads Vesu’s Prime pool, the Vault’s own pinned constant', () => {
    expect(BORROW_POOL).toBe('0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5');
    expect(BORROW_POOL).toBe(VESU_PRIME_POOL);
  });

  it('pins STRK, ETH, USDC, USDT and WBTC, in that order, frozen', () => {
    expect(BORROW_TOKENS).toEqual([STRK, ETH, USDC, USDT, WBTC]);
    expect(Object.isFrozen(BORROW_TOKENS)).toBe(true);
  });

  it('pins all twenty ordered pairs of distinct tokens, collateral-major in token order, frozen', () => {
    expect(BORROW_PAIRS).toHaveLength(20);
    expect(BORROW_PAIRS.slice(0, 5)).toEqual([
      { collateral: STRK, debt: ETH },
      { collateral: STRK, debt: USDC },
      { collateral: STRK, debt: USDT },
      { collateral: STRK, debt: WBTC },
      { collateral: ETH, debt: STRK },
    ]);
    expect(BORROW_PAIRS.at(-1)).toEqual({ collateral: WBTC, debt: USDT });
    const expected = BORROW_TOKENS.flatMap((collateral) => BORROW_TOKENS
      .filter((debt) => debt !== collateral).map((debt) => ({ collateral, debt })));
    expect(BORROW_PAIRS).toEqual(expected);
    expect(new Set(BORROW_PAIRS.map(({ collateral, debt }) => `${collateral}:${debt}`)).size).toBe(20);
    expect(Object.isFrozen(BORROW_PAIRS)).toBe(true);
    for (const pair of BORROW_PAIRS) expect(Object.isFrozen(pair)).toBe(true);
  });

  it('names each entry point by its own sn_keccak', () => {
    expect(BigInt(POSITION_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('position')));
    expect(BigInt(PAIR_CONFIG_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('pair_config')));
    expect(BigInt(PAIRS_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('pairs')));
    expect(BigInt(PRICE_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('price')));
    expect(BigInt(ASSET_CONFIG_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('asset_config')));
    expect(POSITION_SELECTOR).toBe('0x334f8ce3b01e25d0b6fe82d0fdb6eb534f3183d7dc5a6bb44d8eb9f676f650c');
    expect(PAIR_CONFIG_SELECTOR).toBe('0x171c2fae45c0df09f8253d0a3bdf9756051f8fa442f4349827736d3e3135c06');
    expect(PAIRS_SELECTOR).toBe('0x26a6843931e99852362ca0dabb728b39e089c8c1788cda36477a012fa9967b9');
    expect(PRICE_SELECTOR).toBe('0x2bd803c09c6b34a4d86ee95434129ea89232e91fab09f9e5dc6fe984fa9a6f');
    expect(ASSET_CONFIG_SELECTOR).toBe('0x40a1db21c93dd4b0a09e752c7b8cc7db2b84275621c8d2941edd851a22b56f');
  });

  it('names its two routes', () => {
    expect(BORROW_MARKET_PATH).toBe('/v1/rpc/borrow-market');
    expect(BORROW_POSITION_PATH).toBe('/v1/rpc/borrow-position');
  });
});

// ---------------------------------------------------------------------------
// Live-shaped fixtures (Prime pool, block 15,725,569).

interface AssetFixture {
  readonly price: bigint;
  readonly valid: boolean;
  readonly totalCollateralShares: bigint;
  readonly totalNominalDebt: bigint;
  readonly reserve: bigint;
  readonly maxUtilization: bigint;
  readonly floor: bigint;
  readonly scale: bigint;
  readonly rateAccumulator: bigint;
}

const ASSETS: Record<string, AssetFixture> = {
  [STRK]: {
    price: 43_278_720_000_000_000n, valid: true,
    totalCollateralShares: 120_000_000n * E18, totalNominalDebt: 30_000_000n * E18, reserve: 85_000_000n * E18,
    maxUtilization: 95n * 10n ** 16n, floor: 10n ** 19n, scale: E18, rateAccumulator: 1_043_210_000_000_000_000n,
  },
  [ETH]: {
    price: 2_500n * E18, valid: true,
    totalCollateralShares: 900n * E18, totalNominalDebt: 300n * E18, reserve: 550n * E18,
    maxUtilization: 95n * 10n ** 16n, floor: 10n ** 19n, scale: E18, rateAccumulator: 1_020_000_000_000_000_000n,
  },
  [USDC]: {
    price: 999_900_000_000_000_000n, valid: true,
    totalCollateralShares: 5_000_000n * E18, totalNominalDebt: 2_500_000n * 10n ** 6n, reserve: 4_000_000n * 10n ** 6n,
    maxUtilization: 95n * 10n ** 16n, floor: 10n ** 19n, scale: 10n ** 6n, rateAccumulator: 1_081_000_000_000_000_000n,
  },
  [USDT]: {
    price: E18, valid: false,
    totalCollateralShares: 1_000_000n * E18, totalNominalDebt: 400_000n * 10n ** 6n, reserve: 600_000n * 10n ** 6n,
    maxUtilization: 95n * 10n ** 16n, floor: 10n ** 19n, scale: 10n ** 6n, rateAccumulator: 1_065_000_000_000_000_000n,
  },
  [WBTC]: {
    price: 60_000n * E18, valid: true,
    totalCollateralShares: 40n * E18, totalNominalDebt: 5n * 10n ** 8n, reserve: 30n * 10n ** 8n,
    maxUtilization: 95n * 10n ** 16n, floor: 10n ** 19n, scale: 10n ** 8n, rateAccumulator: 1_010_000_000_000_000_000n,
  },
};

const priceFelts = (asset: AssetFixture) => [...u256(asset.price), asset.valid ? '0x1' : '0x0'];

/** `AssetConfig`, all twenty-two felts in ABI order. */
function assetConfigFelts(asset: AssetFixture): string[] {
  return [
    ...u256(asset.totalCollateralShares),
    ...u256(asset.totalNominalDebt),
    ...u256(asset.reserve),
    ...u256(asset.maxUtilization),
    ...u256(asset.floor),
    ...u256(asset.scale),
    '0x0', // is_legacy
    hex(1_759_300_000n), // last_updated
    ...u256(asset.rateAccumulator),
    ...u256(3n * 10n ** 17n), // last_full_utilization_rate
    ...u256(10n ** 17n), // fee_rate
    ...u256(12_345n), // fee_shares
  ];
}

interface PairFixture {
  readonly maxLtv: bigint;
  readonly liquidationFactor: bigint;
  readonly debtCap: bigint;
  readonly totalCollateralShares: bigint;
  readonly totalNominalDebt: bigint;
}

const STRK_USDC: PairFixture = {
  maxLtv: 68n * 10n ** 16n, liquidationFactor: 9n * 10n ** 17n, debtCap: 200_000_000_000n,
  totalCollateralShares: 50_000_000n * E18, totalNominalDebt: 1_200_000n * 10n ** 6n,
};
const GENERIC_PAIR: PairFixture = {
  maxLtv: 75n * 10n ** 16n, liquidationFactor: 95n * 10n ** 16n, debtCap: 10n ** 24n,
  totalCollateralShares: 0n, totalNominalDebt: 0n,
};

const pairFixture = (collateral: string, debt: string) => (collateral === STRK && debt === USDC ? STRK_USDC : GENERIC_PAIR);
const pairConfigFelts = (pair: PairFixture) => [hex(pair.maxLtv), hex(pair.liquidationFactor), hex(pair.debtCap)];
const pairFelts = (pair: PairFixture) => [...u256(pair.totalCollateralShares), ...u256(pair.totalNominalDebt)];

/** The answer a healthy Prime pool gives a pinned call. */
function healthy(call: PinnedCallParams): unknown {
  const [first, second] = call.calldata;
  switch (call.entry_point_selector) {
    case PRICE_SELECTOR: return priceFelts(ASSETS[first!]!);
    case ASSET_CONFIG_SELECTOR: return assetConfigFelts(ASSETS[first!]!);
    case PAIR_CONFIG_SELECTOR: return pairConfigFelts(pairFixture(first!, second!));
    case PAIRS_SELECTOR: return pairFelts(pairFixture(first!, second!));
    case POSITION_SELECTOR: return first === STRK && second === USDC
      ? [...u256((1n << 128n) + 7n), ...u256(20n * 10n ** 6n), ...u256(1_000n * E18), ...u256(21n * 10n ** 6n)]
      : [...u256(0n), ...u256(0n), ...u256(0n), ...u256(0n)];
    default: return null;
  }
}

const assetJson = (token: string) => {
  const asset = ASSETS[token]!;
  return {
    token,
    ok: true,
    price: asset.price.toString(),
    priceValid: asset.valid,
    scale: asset.scale.toString(),
    floor: asset.floor.toString(),
    reserve: asset.reserve.toString(),
    totalNominalDebt: asset.totalNominalDebt.toString(),
    rateAccumulator: asset.rateAccumulator.toString(),
    maxUtilization: asset.maxUtilization.toString(),
  };
};

const pairJson = (collateral: string, debt: string) => {
  const pair = pairFixture(collateral, debt);
  return {
    collateral,
    debt,
    ok: true,
    maxLtv: pair.maxLtv.toString(),
    liquidationFactor: pair.liquidationFactor.toString(),
    debtCap: pair.debtCap.toString(),
    totalNominalDebt: pair.totalNominalDebt.toString(),
  };
};

/** What the port reads from a healthy pool, as bigints. */
function healthyMarket(): BorrowMarketRead {
  return {
    assets: BORROW_TOKENS.map((token) => {
      const asset = ASSETS[token]!;
      return {
        token, ok: true as const, price: asset.price, priceValid: asset.valid, scale: asset.scale, floor: asset.floor,
        reserve: asset.reserve, totalNominalDebt: asset.totalNominalDebt, rateAccumulator: asset.rateAccumulator,
        maxUtilization: asset.maxUtilization,
      };
    }),
    pairs: BORROW_PAIRS.map(({ collateral, debt }) => {
      const pair = pairFixture(collateral, debt);
      return {
        collateral, debt, ok: true as const, maxLtv: pair.maxLtv, liquidationFactor: pair.liquidationFactor,
        debtCap: pair.debtCap, totalNominalDebt: pair.totalNominalDebt,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// A fake node, as vault.test.ts uses.

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown[];
}

interface PinnedCallParams {
  readonly contract_address: string;
  readonly entry_point_selector: string;
  readonly calldata: string[];
}

class NodeError {
  constructor(readonly code: number) {}
}

function node(result: (call: PinnedCallParams) => unknown) {
  const requests: RpcRequest[] = [];
  const posts: Array<{ readonly batch: boolean; readonly size: number }> = [];
  const answer = (request: RpcRequest) => {
    const value = result(callOf(request));
    return value instanceof NodeError
      ? { jsonrpc: '2.0', id: request.id, error: { code: value.code, message: 'node said no' } }
      : { jsonrpc: '2.0', id: request.id, result: value };
  };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    if (Array.isArray(body)) {
      posts.push({ batch: true, size: body.length });
      requests.push(...body);
      return new Response(JSON.stringify(body.map(answer)));
    }
    posts.push({ batch: false, size: 1 });
    requests.push(body);
    return new Response(JSON.stringify(answer(body)));
  });
  return { rpc: new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher }), requests, posts, fetcher };
}

function callOf(request: { params: unknown[] }): PinnedCallParams {
  return request.params[0] as PinnedCallParams;
}

const isCall = (call: PinnedCallParams, selector: string, ...calldata: string[]) => (
  call.entry_point_selector === selector && calldata.every((value, index) => call.calldata[index] === value)
);

describe('the market read (D-083)', () => {
  it('asks the pinned pool for each token’s price and asset config, then each pair’s config and totals, in one batch', async () => {
    const { rpc, requests, posts } = node(healthy);
    await rpc.getBorrowMarket();
    expect(requests.map(callOf)).toEqual([
      ...BORROW_TOKENS.flatMap((token) => [
        { contract_address: BORROW_POOL, entry_point_selector: PRICE_SELECTOR, calldata: [token] },
        { contract_address: BORROW_POOL, entry_point_selector: ASSET_CONFIG_SELECTOR, calldata: [token] },
      ]),
      ...BORROW_PAIRS.flatMap(({ collateral, debt }) => [
        { contract_address: BORROW_POOL, entry_point_selector: PAIR_CONFIG_SELECTOR, calldata: [collateral, debt] },
        { contract_address: BORROW_POOL, entry_point_selector: PAIRS_SELECTOR, calldata: [collateral, debt] },
      ]),
    ]);
    expect(requests.every((request) => request.method === 'starknet_call' && request.params[1] === 'latest')).toBe(true);
    expect(posts).toEqual([{ batch: true, size: 50 }]);
    expect(posts.every(({ size }) => size <= VAULT_RPC_BATCH_SIZE)).toBe(true);
  });

  it('decodes the live-shaped answers into one row per token and per pair, in pinned order', async () => {
    const { rpc } = node(healthy);
    const market = await rpc.getBorrowMarket();
    expect(market).toEqual(healthyMarket());
    expect(market.assets[0]).toEqual({
      token: STRK, ok: true, price: 43_278_720_000_000_000n, priceValid: true, scale: E18, floor: 10n ** 19n,
      reserve: 85_000_000n * E18, totalNominalDebt: 30_000_000n * E18, rateAccumulator: 1_043_210_000_000_000_000n,
      maxUtilization: 950_000_000_000_000_000n,
    });
    expect(market.assets[2]).toMatchObject({ token: USDC, ok: true, scale: 1_000_000n });
    expect(market.assets[3]).toMatchObject({ token: USDT, ok: true, priceValid: false });
    expect(market.pairs[1]).toEqual({
      collateral: STRK, debt: USDC, ok: true, maxLtv: 680_000_000_000_000_000n, liquidationFactor: 900_000_000_000_000_000n,
      debtCap: 200_000_000_000n, totalNominalDebt: 1_200_000_000_000n,
    });
  });

  it('reads a u256 high limb', async () => {
    const big = (5n << 128n) + 9n;
    const { rpc } = node((call) => (isCall(call, ASSET_CONFIG_SELECTOR, ETH)
      ? assetConfigFelts({ ...ASSETS[ETH]!, reserve: big })
      : healthy(call)));
    const market = await rpc.getBorrowMarket();
    expect(market.assets[1]).toMatchObject({ token: ETH, ok: true, reserve: big });
  });

  const priceCases: Array<[string, string[]]> = [
    ['a short price', u256(1n)],
    ['a trailing felt', [...priceFelts(ASSETS[ETH]!), '0x0']],
    ['an is_valid of 2', [...u256(1n), '0x2']],
    ['a limb at 2^128', [hex(1n << 128n), '0x0', '0x1']],
    ['a non-felt', ['5', '0x0', '0x1']],
    ['a felt at the field prime', [hex(FIELD_PRIME), '0x0', '0x1']],
  ];
  it.each(priceCases)('marks only that token unread after a price with %s', async (_label, answer) => {
    const { rpc } = node((call) => (isCall(call, PRICE_SELECTOR, ETH) ? answer : healthy(call)));
    const market = await rpc.getBorrowMarket();
    const expected = healthyMarket();
    expect(market.assets[1]).toEqual({ token: ETH, ok: false });
    expect(market.assets.filter((_row, index) => index !== 1)).toEqual(expected.assets.filter((_row, index) => index !== 1));
    expect(market.pairs).toEqual(expected.pairs);
  });

  const configCases: Array<[string, (felts: string[]) => unknown]> = [
    ['twenty-one felts', (felts) => felts.slice(0, 21)],
    ['twenty-three felts', (felts) => [...felts, '0x0']],
    ['an is_legacy of 2', (felts) => felts.map((felt, index) => (index === 12 ? '0x2' : felt))],
    ['a last_updated at 2^64', (felts) => felts.map((felt, index) => (index === 13 ? hex(1n << 64n) : felt))],
    ['a limb at 2^128', (felts) => felts.map((felt, index) => (index === 21 ? hex(1n << 128n) : felt))],
    ['a node error', () => new NodeError(40)],
    ['a non-list result', () => ({ value: '0x1' })],
  ];
  it.each(configCases)('marks only that token unread after an asset config with %s', async (_label, mangle) => {
    const { rpc } = node((call) => (isCall(call, ASSET_CONFIG_SELECTOR, USDC)
      ? mangle(assetConfigFelts(ASSETS[USDC]!))
      : healthy(call)));
    const market = await rpc.getBorrowMarket();
    const expected = healthyMarket();
    expect(market.assets[2]).toEqual({ token: USDC, ok: false });
    expect(market.assets.filter((_row, index) => index !== 2)).toEqual(expected.assets.filter((_row, index) => index !== 2));
    expect(market.pairs).toEqual(expected.pairs);
  });

  const pairCases: Array<[string, (call: PinnedCallParams) => unknown]> = [
    ['a max_ltv at 2^64', (call) => (call.entry_point_selector === PAIR_CONFIG_SELECTOR ? [hex(1n << 64n), '0x1', '0x1'] : healthy(call))],
    ['a liquidation_factor at 2^64', (call) => (call.entry_point_selector === PAIR_CONFIG_SELECTOR ? ['0x1', hex(1n << 64n), '0x1'] : healthy(call))],
    ['a debt_cap at 2^128', (call) => (call.entry_point_selector === PAIR_CONFIG_SELECTOR ? ['0x1', '0x1', hex(1n << 128n)] : healthy(call))],
    ['a short pair config', (call) => (call.entry_point_selector === PAIR_CONFIG_SELECTOR ? ['0x1', '0x1'] : healthy(call))],
    ['a three-felt pairs', (call) => (call.entry_point_selector === PAIRS_SELECTOR ? ['0x0', '0x0', '0x0'] : healthy(call))],
    ['a failed pairs', (call) => (call.entry_point_selector === PAIRS_SELECTOR ? new NodeError(40) : healthy(call))],
  ];
  it.each(pairCases)('marks only that pair unread after %s', async (_label, answer) => {
    const { rpc } = node((call) => (isCall(call, call.entry_point_selector, STRK, USDC) && call.calldata.length === 2
      ? answer(call)
      : healthy(call)));
    const market = await rpc.getBorrowMarket();
    const expected = healthyMarket();
    expect(market.pairs[1]).toEqual({ collateral: STRK, debt: USDC, ok: false });
    expect(market.pairs.filter((_row, index) => index !== 1)).toEqual(expected.pairs.filter((_row, index) => index !== 1));
    expect(market.assets).toEqual(expected.assets);
  });

  it.each([
    ['rate-limits', 429],
    ['fails', 502],
  ])('answers every row unread when the node %s the batch, without retrying it call by call', async (_label, status) => {
    const fetcher = vi.fn(async () => new Response('busy', { status }));
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    await expect(rpc.getBorrowMarket()).resolves.toEqual({
      assets: BORROW_TOKENS.map((token) => ({ token, ok: false })),
      pairs: BORROW_PAIRS.map(({ collateral, debt }) => ({ collateral, debt, ok: false })),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads a node without batch support one call at a time, a few at once, with the same answer', async () => {
    let inFlight = 0;
    let most = 0;
    const posts: boolean[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
      posts.push(Array.isArray(body));
      if (Array.isArray(body)) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
      }
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: healthy(callOf(body)) }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    await expect(rpc.getBorrowMarket()).resolves.toEqual(healthyMarket());
    expect(most).toBeLessThanOrEqual(VAULT_RPC_FALLBACK_CONCURRENCY);
    expect(posts.filter(Boolean)).toHaveLength(1);
    expect(posts.filter((batch) => !batch)).toHaveLength(50);
  });

  it('still rejects a cancelled read rather than calling every row unread', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new DOMException('Aborted', 'AbortError');
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    await expect(rpc.getBorrowMarket(controller.signal)).rejects.toBeDefined();
  });
});

describe('the position read across every pinned pair (D-083)', () => {
  it('asks the pinned pool for position(collateral, debt, account) on every pair, in one batch', async () => {
    const { rpc, requests, posts } = node(healthy);
    await rpc.getBorrowPositions(SHADOW);
    expect(requests.map(callOf)).toEqual(BORROW_PAIRS.map(({ collateral, debt }) => (
      { contract_address: BORROW_POOL, entry_point_selector: POSITION_SELECTOR, calldata: [collateral, debt, SHADOW] }
    )));
    expect(posts).toEqual([{ batch: true, size: 20 }]);
  });

  it('decodes each position’s shares, nominal debt and amounts, one row per pair in pinned order', async () => {
    const { rpc } = node(healthy);
    const rows = await rpc.getBorrowPositions(SHADOW);
    expect(rows).toHaveLength(20);
    expect(rows[1]).toEqual({
      collateral: STRK, debt: USDC, ok: true,
      collateralShares: (1n << 128n) + 7n, nominalDebt: 20_000_000n, collateralAmount: 1_000n * E18, debtAmount: 21_000_000n,
    });
    expect(rows.filter((_row, index) => index !== 1)).toEqual(BORROW_PAIRS.filter((_pair, index) => index !== 1).map(({ collateral, debt }) => (
      { collateral, debt, ok: true, collateralShares: 0n, nominalDebt: 0n, collateralAmount: 0n, debtAmount: 0n }
    )));
  });

  it.each([
    ['seven felts', u256(0n).concat(u256(0n), u256(0n), ['0x0'])],
    ['nine felts', [...u256(0n), ...u256(0n), ...u256(0n), ...u256(0n), '0x0']],
    ['a limb at 2^128', [hex(1n << 128n), '0x0', ...u256(0n), ...u256(0n), ...u256(0n)]],
    ['a non-felt', ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0', 'zz', '0x0']],
    ['a node error', new NodeError(40)],
  ])('marks only that pair unread after %s', async (_label, answer) => {
    const { rpc } = node((call) => (isCall(call, POSITION_SELECTOR, WBTC, USDT) ? answer : healthy(call)));
    const rows = await rpc.getBorrowPositions(SHADOW);
    expect(rows[19]).toEqual({ collateral: WBTC, debt: USDT, ok: false });
    expect(rows.filter((row) => row.ok)).toHaveLength(19);
  });

  it('still rejects a cancelled read rather than calling every pair unread', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new DOMException('Aborted', 'AbortError');
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    await expect(rpc.getBorrowPositions(SHADOW, controller.signal)).rejects.toBeDefined();
  });

  it('refuses a zero or malformed account before the RPC is asked', async () => {
    const { rpc, fetcher } = node(healthy);
    for (const bad of ['0x0', 'abc', `0x${'f'.repeat(64)}`]) {
      await expect(rpc.getBorrowPositions(bad)).rejects.toThrow(/account is invalid/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The routes.

function apiWith(borrow?: BorrowRpcPort, overrides: Partial<BackendConfig> = {}) {
  const rpc: PoolRpcPort = {
    getPoolConfig: vi.fn(async () => ({ feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 })),
    getPublicKey: vi.fn(async () => '0x0'),
    getReceipt: vi.fn(async () => null),
    getBlockNumber: vi.fn(async () => 1),
  };
  const route = { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] };
  const config: BackendConfig = {
    poolAddress: POOL,
    feeToken: STRK,
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: { transfer: route, unshield: route, swap: { ...route, quoteBound: true, maxSlippageBps: 50 } },
    ...overrides,
  };
  return new BackendApi({
    config,
    paymaster: { buildFee: vi.fn(), submit: vi.fn() },
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    ...(borrow ? { borrow } : {}),
  });
}

function borrowPort(): BorrowRpcPort & { getBorrowMarket: ReturnType<typeof vi.fn>; getBorrowPositions: ReturnType<typeof vi.fn> } {
  return {
    getBorrowMarket: vi.fn(async () => {
      const market = healthyMarket();
      return {
        assets: market.assets.map((row) => (row.token === WBTC ? { token: WBTC, ok: false as const } : row)),
        pairs: market.pairs.map((row) => (row.collateral === ETH && row.debt === USDT
          ? { collateral: ETH, debt: USDT, ok: false as const }
          : row)),
      };
    }),
    getBorrowPositions: vi.fn(async () => BORROW_PAIRS.map(({ collateral, debt }) => {
      if (collateral === STRK && debt === USDC) {
        return { collateral, debt, ok: true as const, collateralShares: 999n * E18, nominalDebt: 20_000_000n, collateralAmount: 1_000n * E18, debtAmount: 21_000_000n };
      }
      if (collateral === WBTC && debt === USDT) return { collateral, debt, ok: false as const };
      return { collateral, debt, ok: true as const, collateralShares: 0n, nominalDebt: 0n, collateralAmount: 0n, debtAmount: 0n };
    })),
  };
}

describe('the Borrow read routes (D-083)', () => {
  it('answers every pinned token and pair as decimal strings, and an unread row as such, for a request carrying only a version', async () => {
    const borrow = borrowPort();
    const response = await apiWith(borrow).handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } });
    expect(response).toEqual({
      status: 200,
      body: {
        assets: BORROW_TOKENS.map((token) => (token === WBTC ? { token, ok: false } : assetJson(token))),
        pairs: BORROW_PAIRS.map(({ collateral, debt }) => (collateral === ETH && debt === USDT
          ? { collateral, debt, ok: false }
          : pairJson(collateral, debt))),
      },
    });
    const body = response.body as { assets: unknown[]; pairs: unknown[] };
    expect(body.assets).toHaveLength(5);
    expect(body.pairs).toHaveLength(20);
    expect(body.assets[0]).toEqual({
      token: STRK, ok: true, price: '43278720000000000', priceValid: true, scale: '1000000000000000000',
      floor: '10000000000000000000', reserve: '85000000000000000000000000', totalNominalDebt: '30000000000000000000000000',
      rateAccumulator: '1043210000000000000', maxUtilization: '950000000000000000',
    });
    expect(body.pairs[1]).toEqual({
      collateral: STRK, debt: USDC, ok: true, maxLtv: '680000000000000000', liquidationFactor: '900000000000000000',
      debtCap: '200000000000', totalNominalDebt: '1200000000000',
    });
    expect(borrow.getBorrowMarket).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('answers a stand-in address’s position in every pinned pair as decimal strings, one row each', async () => {
    const borrow = borrowPort();
    const response = await apiWith(borrow).handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } });
    expect(response.status).toBe(200);
    const { positions } = response.body as { positions: unknown[] };
    expect(positions).toHaveLength(20);
    expect(positions[1]).toEqual({
      collateral: STRK, debt: USDC, ok: true, collateralShares: '999000000000000000000', nominalDebt: '20000000',
      collateralAmount: '1000000000000000000000', debtAmount: '21000000',
    });
    expect(positions[19]).toEqual({ collateral: WBTC, debt: USDT, ok: false });
    expect(positions[0]).toEqual({ collateral: STRK, debt: ETH, ok: true, collateralShares: '0', nominalDebt: '0', collateralAmount: '0', debtAmount: '0' });
    expect(borrow.getBorrowPositions).toHaveBeenCalledWith(SHADOW, expect.any(AbortSignal));
  });

  it('serves the full path over the real RPC port: the wire JSON matches the live-shaped pool', async () => {
    const { rpc } = node(healthy);
    const api = apiWith(rpc);
    await expect(api.handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } })).resolves.toEqual({
      status: 200,
      body: {
        assets: BORROW_TOKENS.map(assetJson),
        pairs: BORROW_PAIRS.map(({ collateral, debt }) => pairJson(collateral, debt)),
      },
    });
  });

  it.each([
    [BORROW_MARKET_PATH, { v: 2 }],
    [BORROW_MARKET_PATH, {}],
    [BORROW_MARKET_PATH, { v: 1, pool: VESU_PRIME_POOL }],
    [BORROW_MARKET_PATH, { v: 1, token: STRK }],
    [BORROW_MARKET_PATH, { v: 1, account: SHADOW }],
    [BORROW_POSITION_PATH, { v: 2, account: SHADOW }],
    [BORROW_POSITION_PATH, { v: 1 }],
    [BORROW_POSITION_PATH, { v: 1, account: '0x0' }],
    [BORROW_POSITION_PATH, { v: 1, account: 'abc' }],
    [BORROW_POSITION_PATH, { v: 1, account: `0x${FIELD_PRIME.toString(16)}` }],
    [BORROW_POSITION_PATH, { v: 1, account: 7 }],
    [BORROW_POSITION_PATH, { v: 1, account: SHADOW, collateral: STRK }],
    [BORROW_POSITION_PATH, { v: 1, account: SHADOW, pool: VESU_PRIME_POOL }],
  ])('refuses %s with %j before any read', async (path, body) => {
    const borrow = borrowPort();
    await expect(apiWith(borrow).handle({ method: 'POST', path, body })).resolves.toMatchObject({ status: 400 });
    expect(borrow.getBorrowMarket).not.toHaveBeenCalled();
    expect(borrow.getBorrowPositions).not.toHaveBeenCalled();
  });

  it('answers 503 on a service composed without the Borrow reads', async () => {
    const api = apiWith(undefined);
    await expect(api.handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } }))
      .resolves.toEqual({ status: 503, body: expect.objectContaining({ message: 'The borrow reads are unavailable.' }) });
    await expect(api.handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toEqual({ status: 503, body: expect.objectContaining({ message: 'The borrow reads are unavailable.' }) });
  });

  it('honours the global kill switch before reading', async () => {
    const borrow = borrowPort();
    const api = apiWith(borrow, { globalEnabled: false });
    await expect(api.handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } })).resolves.toMatchObject({ status: 503 });
    await expect(api.handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } })).resolves.toMatchObject({ status: 503 });
    expect(borrow.getBorrowMarket).not.toHaveBeenCalled();
    expect(borrow.getBorrowPositions).not.toHaveBeenCalled();
  });

  it('answers only POST', async () => {
    const borrow = borrowPort();
    await expect(apiWith(borrow).handle({ method: 'GET', path: BORROW_MARKET_PATH, body: undefined })).resolves.toMatchObject({ status: 405 });
    expect(borrow.getBorrowMarket).not.toHaveBeenCalled();
  });

  it('maps a provider failure to the generic answer without echoing it, and keeps metrics aggregate', async () => {
    const borrow = borrowPort();
    borrow.getBorrowPositions.mockRejectedValueOnce(new Error(`node said no for ${SHADOW}`));
    const api = apiWith(borrow);
    const response = await api.handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } });
    expect(response).toEqual({ status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } });
    await api.handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } });
    expect(JSON.stringify(api.metrics.snapshot())).not.toContain(SHADOW.slice(2, 12));
  });

  it('writes nothing while it serves, succeeds or fails (D-014)', async () => {
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level)),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    try {
      const { rpc } = node((call) => (call.entry_point_selector === POSITION_SELECTOR ? new NodeError(40) : healthy(call)));
      const api = apiWith(rpc);
      await api.handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } });
      await api.handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } });
      await api.handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: '0x0' } });
      const failing = borrowPort();
      failing.getBorrowPositions.mockRejectedValueOnce(new Error(`boom ${SHADOW}`));
      await apiWith(failing).handle({ method: 'POST', path: BORROW_POSITION_PATH, body: { v: 1, account: SHADOW } });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('is composed over the private RPC port by the runtime, only when the port offers it, and leaves the shadow-account route to the Vault port', async () => {
    const getBorrowMarket = vi.fn(async () => healthyMarket());
    const withReads = createBackendRuntime(environment(), {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: {
        getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn(),
        getBorrowMarket,
        getBorrowPositions: vi.fn(),
      } as PoolRpcPort,
      swapQuotes: { quote: vi.fn() },
    });
    await expect(withReads.api.handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } }))
      .resolves.toMatchObject({ status: 200 });
    expect(getBorrowMarket).toHaveBeenCalledTimes(1);
    // The borrow reads alone do not stand in for the Vault's shadow-account read.
    await expect(withReads.api.handle({ method: 'POST', path: VAULT_SHADOW_ACCOUNT_PATH, body: { v: 1, partialCommitment: '0x5f2e1d' } }))
      .resolves.toMatchObject({ status: 503 });

    const without = createBackendRuntime(environment(), {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: { getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn(), getBorrowMarket: vi.fn() } as PoolRpcPort,
      swapQuotes: { quote: vi.fn() },
    });
    await expect(without.api.handle({ method: 'POST', path: BORROW_MARKET_PATH, body: { v: 1 } }))
      .resolves.toMatchObject({ status: 503 });
  });
});

function environment(): Record<string, string> {
  return {
    PORT: '8080',
    STARKNET_RPC_URL: 'https://rpc.invalid/v3/private-key',
    STRK20_POOL_ADDRESS: POOL,
    STRK20_FEE_TOKEN: STRK,
    STRK20_NOTE_MATURITY_BLOCKS: '10',
    AVNU_PAYMASTER_API_KEY: 'private-paymaster-key',
    AVNU_PAYMASTER_BASE_URL: '',
    AVNU_BASE_URL: '',
    STARKNET_CHAIN_ID: 'SN_MAIN',
    FEE_AUTHORIZATION_SECRET: 'hmac-secret-with-at-least-32-characters',
    BACKEND_MAX_REQUEST_BYTES: '2500000',
    BACKEND_MAX_CALLDATA_ITEMS: '256',
    BACKEND_MAX_PROOF_BYTES: '2000000',
    BACKEND_REQUEST_TIMEOUT_MS: '20000',
    BACKEND_GLOBAL_ENABLED: 'true',
    BACKEND_RATE_LIMIT_MAX_REQUESTS: '120',
    BACKEND_RATE_LIMIT_WINDOW_MS: '60000',
    BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT: '1000',
    BACKEND_SPONSORSHIP_WINDOW_MS: '3600000',
    BACKEND_QUEUE_MAX_IN_FLIGHT: '4',
    BACKEND_QUEUE_MAX_QUEUED: '64',
    BACKEND_ROUTE_TRANSFER_ENABLED: 'true',
    BACKEND_ROUTE_TRANSFER_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_UNSHIELD_ENABLED: 'true',
    BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_SWAP_ENABLED: 'true',
    BACKEND_ROUTE_SWAP_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS: '50',
  };
}
