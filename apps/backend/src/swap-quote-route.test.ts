import { describe, expect, it, vi } from 'vitest';
import {
  BackendApi,
  MemoryAuthorizationCodec,
  SWAP_QUOTE_PATH,
  SWAP_QUOTE_RATE_LIMIT,
  type BackendConfig,
  type PaymasterPort,
  type PoolRpcPort,
  type SwapQuote,
  type SwapQuotePort,
} from './index.js';
import { PerClientRateLimiter } from './client-key.js';
import { AggregateRateLimiter } from './metrics.js';

/**
 * D-084: the private swap's keyless quote proxy. The browser asks this
 * service, not avnu, so avnu never sees the player's IP next to the swap
 * stand-in and the amounts (D-014). It admits what the swap route admits,
 * keeps its own rate window besides the shared one, relays nothing, and
 * writes nothing per request.
 */

const STRK = '0x4718';
const OTHER = '0xabc';
const TAKER = '0x771b47d5784bbcaa14e989adee560efae541c09b3f12db34e16562e392cf032';
const MAINNET = '0x534e5f4d41494e';

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    poolAddress: '0x123',
    feeToken: STRK,
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: {
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      swap: { enabled: true, maxRelayFee: 0n, maxQueueDelayMs: 0, quoteBound: true, allowedTokens: [STRK, OTHER], maxSlippageBps: 300 },
    },
    ...overrides,
  };
}

function answer(input: Parameters<SwapQuotePort['quote']>[0]): SwapQuote {
  return {
    quoteId: 'quote-1',
    chainId: MAINNET,
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmount: input.sellAmount,
    buyAmount: 430_588n,
    calls: [{ contractAddress: '0x4270', entrypoint: 'multi_route_swap', calldata: ['0x4718', '0x14'] }],
  };
}

function fixture(options: {
  config?: Partial<BackendConfig>;
  quote?: SwapQuotePort['quote'];
  withQuotes?: boolean;
  swapQuoteRateLimiter?: AggregateRateLimiter;
  swapQuoteClientRateLimiter?: PerClientRateLimiter;
} = {}) {
  const paymaster: PaymasterPort = { buildFee: vi.fn(), submit: vi.fn() };
  const rpc: PoolRpcPort = { getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn() };
  const swapQuotes: SwapQuotePort = { quote: vi.fn(options.quote ?? (async (input) => answer(input))) };
  const api = new BackendApi({
    config: config(options.config),
    paymaster,
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    ...(options.withQuotes === false ? {} : { swapQuotes }),
    ...(options.swapQuoteRateLimiter ? { swapQuoteRateLimiter: options.swapQuoteRateLimiter } : {}),
    ...(options.swapQuoteClientRateLimiter ? { swapQuoteClientRateLimiter: options.swapQuoteClientRateLimiter } : {}),
  });
  return { api, swapQuotes, paymaster, rpc };
}

const BODY = { v: 1, sellToken: STRK, buyToken: OTHER, sellAmount: '10000000000000000000', taker: TAKER, slippageBps: 100 };
const ask = (api: BackendApi, body: unknown = BODY, method = 'POST', client?: string) =>
  api.handle({ method, path: SWAP_QUOTE_PATH, body, ...(client ? { client } : {}) });

describe('the keyless swap quote proxy (D-084)', () => {
  it('quotes for the stand-in and answers decimal amounts and the built call', async () => {
    const { api, swapQuotes, paymaster, rpc } = fixture();

    await expect(ask(api)).resolves.toEqual({
      status: 200,
      body: {
        quoteId: 'quote-1',
        chainId: MAINNET,
        sellToken: STRK,
        buyToken: OTHER,
        sellAmount: '10000000000000000000',
        buyAmount: '430588',
        calls: [{ contractAddress: '0x4270', entrypoint: 'multi_route_swap', calldata: ['0x4718', '0x14'] }],
      },
    });
    expect(swapQuotes.quote).toHaveBeenCalledWith(expect.objectContaining({
      sellToken: STRK, buyToken: OTHER, sellAmount: 10n ** 19n, taker: TAKER, slippageBps: 100,
    }));
    // No relay, no paymaster, no chain read: a quote is avnu's alone.
    expect(paymaster.buildFee).not.toHaveBeenCalled();
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing taker', { ...BODY, taker: undefined }],
    ['an extra field', { ...BODY, minAmountOut: '1' }],
    ['a zero taker', { ...BODY, taker: '0x0' }],
    ['a taker beyond the address range', { ...BODY, taker: `0x${(1n << 251n).toString(16)}` }],
    ['a sell amount no pool note holds', { ...BODY, sellAmount: (1n << 128n).toString() }],
    ['a hex sell amount', { ...BODY, sellAmount: '0x14' }],
    ['a zero sell amount', { ...BODY, sellAmount: '0' }],
    ['the same token twice', { ...BODY, buyToken: STRK }],
    ['a slippage above the route ceiling', { ...BODY, slippageBps: 301 }],
    ['a fractional slippage', { ...BODY, slippageBps: 1.5 }],
    ['a token the route does not admit', { ...BODY, buyToken: '0x666' }],
    ['another version', { ...BODY, v: 2 }],
  ])('refuses %s before asking avnu', async (_label, body) => {
    const { api, swapQuotes } = fixture();
    await expect(ask(api, body)).resolves.toMatchObject({ status: 400 });
    expect(swapQuotes.quote).not.toHaveBeenCalled();
  });

  it('is shut with the swap route, without a quote source, and under the kill switch', async () => {
    const disabled = fixture({ config: { routes: { ...config().routes, swap: { ...config().routes.swap, enabled: false } } } });
    await expect(ask(disabled.api)).resolves.toMatchObject({ status: 503, body: { message: 'This private route is disabled.' } });
    await expect(ask(fixture({ withQuotes: false }).api)).resolves.toMatchObject({ status: 503 });
    const killed = fixture({ config: { globalEnabled: false } });
    await expect(ask(killed.api)).resolves.toMatchObject({ status: 503, body: { code: 'SERVICE_DISABLED' } });
    expect(killed.swapQuotes.quote).not.toHaveBeenCalled();
    await expect(ask(fixture().api, BODY, 'GET')).resolves.toMatchObject({ status: 405 });
  });

  it('answers a failing, mismatched or oversized avnu answer as an upstream failure, never a quote', async () => {
    const down = fixture({ quote: async () => { throw new Error('avnu answered 500.'); } });
    await expect(ask(down.api)).resolves.toMatchObject({ status: 502, body: { code: 'UPSTREAM_FAILURE' } });
    const wrongAmount = fixture({ quote: async (input) => ({ ...answer(input), sellAmount: 1n }) });
    await expect(ask(wrongAmount.api)).resolves.toMatchObject({ status: 502 });
    const wrongChain = fixture({ quote: async (input) => ({ ...answer(input), chainId: '0x1' }) });
    await expect(ask(wrongChain.api)).resolves.toMatchObject({ status: 502 });
    const tooLong = fixture({
      quote: async (input) => ({ ...answer(input), calls: [{ ...answer(input).calls[0]!, calldata: Array.from({ length: 129 }, () => '0x1') }] }),
    });
    await expect(ask(tooLong.api)).resolves.toMatchObject({ status: 502 });
    const timedOut = fixture({ quote: async () => { throw new DOMException('avnu timed out.', 'TimeoutError'); } });
    await expect(ask(timedOut.api)).resolves.toMatchObject({ status: 504 });
  });

  it('keeps its own aggregate window besides the shared one, so avnu is asked a bounded amount', async () => {
    expect(SWAP_QUOTE_RATE_LIMIT).toEqual({ maxRequests: 60, windowMs: 60_000 });
    const { api, swapQuotes } = fixture({ swapQuoteRateLimiter: new AggregateRateLimiter(2, 60_000, () => 0) });
    await expect(ask(api)).resolves.toMatchObject({ status: 200 });
    await expect(ask(api)).resolves.toMatchObject({ status: 200 });
    await expect(ask(api)).resolves.toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect(swapQuotes.quote).toHaveBeenCalledTimes(2);
    // Its window is its own: other routes still answer.
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 } })).resolves.not.toMatchObject({ status: 429 });
  });

  it('spends its own window only on admitted requests, so refused ones cannot exhaust it', async () => {
    const { api, swapQuotes } = fixture({ swapQuoteRateLimiter: new AggregateRateLimiter(1, 60_000, () => 0) });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(ask(api, { ...BODY, buyToken: '0x666' })).resolves.toMatchObject({ status: 400 });
    }
    await expect(ask(api)).resolves.toMatchObject({ status: 200 });
    await expect(ask(api)).resolves.toMatchObject({ status: 429 });
    expect(swapQuotes.quote).toHaveBeenCalledTimes(1);
  });

  it('limits each client on its own, so one client cannot spend the window for everyone', async () => {
    const { api, swapQuotes } = fixture({ swapQuoteClientRateLimiter: new PerClientRateLimiter(2, 60_000, () => 0) });
    const greedy = 'a'.repeat(32);
    await expect(ask(api, BODY, 'POST', greedy)).resolves.toMatchObject({ status: 200 });
    await expect(ask(api, BODY, 'POST', greedy)).resolves.toMatchObject({ status: 200 });
    await expect(ask(api, BODY, 'POST', greedy)).resolves.toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    // Another client still gets quotes.
    await expect(ask(api, BODY, 'POST', 'b'.repeat(32))).resolves.toMatchObject({ status: 200 });
    expect(swapQuotes.quote).toHaveBeenCalledTimes(3);
  });

  it('also takes a slot in the shared window', async () => {
    const { api } = fixture({ config: { rateLimit: { maxRequests: 1, windowMs: 60_000 } } });
    await expect(ask(api)).resolves.toMatchObject({ status: 200 });
    await expect(ask(api)).resolves.toMatchObject({ status: 429 });
  });

  it('writes nothing per request (D-014)', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    try {
      const { api } = fixture();
      await ask(api);
      await ask(api, { ...BODY, buyToken: '0x666' });
      await ask(fixture({ quote: async () => { throw new Error('down'); } }).api);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
