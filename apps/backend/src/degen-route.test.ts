import { describe, expect, it, vi } from 'vitest';
import { DEGEN_CURATED_CORE } from './degen-catalog.js';
import { parseBackendEnvironment } from './environment.js';
import { createBackendFetchHandler } from './http.js';
import {
  BackendApi,
  DEGEN_TOKENS_PATH,
  MemoryAuthorizationCodec,
  type BackendConfig,
  type DegenCatalogPort,
  type DegenCatalogSnapshot,
  type DegenConfig,
  type DegenToken,
  type PaymasterPort,
  type PoolRpcPort,
  type PreparedArtifact,
  type SwapQuotePort,
} from './index.js';
import { createBackendRuntime, listenBackendServer } from './runtime.js';

const fetchTokensMock = vi.hoisted(() => vi.fn());
vi.mock('@avnu/avnu-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@avnu/avnu-sdk')>()),
  fetchTokens: fetchTokensMock,
}));

/**
 * D-067 on the backend: the degen list endpoint, the swap route's widened
 * admission, and the fail-closed `BACKEND_DEGEN_*` group. Since D-084 the
 * swap is never relayed: the admission guards the keyless quote proxy, and
 * the browser owns every other check.
 */

const POOL = '0x123';
const STRK = '0x4718';
const OTHER = '0xabc';
const FEE_RECIPIENT = '0x789';
const TAKER = '0x5ad0';
const LORDS = DEGEN_CURATED_CORE[0]!.address;
const LIVE: DegenToken = Object.freeze({
  address: '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87',
  symbol: 'EKUBO',
  name: 'Ekubo Protocol',
  decimals: 18,
  tags: Object.freeze(['Verified', 'AVNU'] as const),
  curated: false,
});
const STRANGER = '0x0666';
const DEGEN: DegenConfig = {
  enabled: true,
  tags: ['Verified', 'Community', 'Unruggable', 'AVNU'],
  minDailyVolumeUsd: 100,
  cacheTtlMs: 600_000,
};

function liveSnapshot(extra: readonly DegenToken[] = [LIVE]): DegenCatalogSnapshot {
  return { source: 'live', tokens: [...DEGEN_CURATED_CORE, ...extra] };
}

function fixture(options: { degen?: DegenConfig | null; catalog?: DegenCatalogPort | null } = {}) {
  let snapshot = liveSnapshot();
  const catalog: DegenCatalogPort = options.catalog === null
    ? undefined as never
    : options.catalog ?? { snapshot: vi.fn(async () => snapshot) };
  const submitted: PreparedArtifact[] = [];
  const paymaster: PaymasterPort = {
    buildFee: vi.fn(async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: 7n })),
    submit: vi.fn(async (input: Parameters<PaymasterPort['submit']>[0]) => {
      submitted.push(input.artifact);
      return { transactionHash: '0x5ab' };
    }),
  };
  const rpc: PoolRpcPort = {
    async getPoolConfig() {
      return { feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async getPublicKey() { return '0x99'; },
    async getReceipt(hash) { return { transactionHash: hash }; },
    async getBlockNumber() { return 1_000; },
  };
  const swapQuotes: SwapQuotePort = {
    quote: vi.fn(async (input) => ({
      quoteId: 'quote-1',
      chainId: '0x534e5f4d41494e',
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount,
      buyAmount: 100n,
      calls: [{ contractAddress: '0x4270', entrypoint: 'multi_route_swap', calldata: ['0xaaa'] }],
    })),
  };
  const degen = options.degen === null ? undefined : { ...(options.degen ?? DEGEN) };
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
    routes: {
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK, OTHER] },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      swap: {
        enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: true, allowedTokens: [STRK, OTHER], maxSlippageBps: 300,
      },
    },
    ...(degen ? { degen } : {}),
  };
  const api = new BackendApi({
    config,
    paymaster,
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    now: () => 1_000,
    swapQuotes,
    ...(catalog ? { degenCatalog: catalog } : {}),
  });
  return {
    api,
    config,
    catalog,
    paymaster,
    swapQuotes,
    submitted,
    setSnapshot(next: DegenCatalogSnapshot) { snapshot = next; },
  };
}

function list(api: BackendApi, body: unknown = null) {
  return api.handle({ method: 'GET', path: DEGEN_TOKENS_PATH, body });
}

function quote(api: BackendApi, sellToken: string, buyToken: string, extra: Record<string, unknown> = {}) {
  return api.handle({
    method: 'POST',
    path: '/v1/swap/quote',
    body: { v: 1, sellToken, buyToken, sellAmount: '20', taker: TAKER, slippageBps: 100, ...extra },
  });
}

describe('the degen token list endpoint', () => {
  it('serves the curated core first, then the live list, with explicit public fields only', async () => {
    const { api } = fixture();
    const response = await list(api);
    expect(response.status).toBe(200);
    const body = response.body as { source: string; tokens: Array<Record<string, unknown>> };
    expect(body.source).toBe('live');
    expect(body.tokens.map((token) => token.symbol)).toEqual([
      'LORDS', 'DREAMS', 'SLAY', 'BROTHER', 'tBTC', 'CASH', 'DOG', 'EKUBO',
    ]);
    expect(body.tokens.at(-1)).toEqual({
      address: LIVE.address, symbol: 'EKUBO', name: 'Ekubo Protocol', decimals: 18, tags: ['Verified', 'AVNU'], curated: false,
    });
    expect(Object.keys(body)).toEqual(['source', 'tokens']);
  });

  it('says when avnu was unreachable and only the curated core is listed', async () => {
    const { api, setSnapshot } = fixture();
    setSnapshot({ source: 'curated', tokens: DEGEN_CURATED_CORE });
    const response = await list(api);
    expect(response.body).toMatchObject({ source: 'curated' });
    expect((response.body as { tokens: unknown[] }).tokens).toHaveLength(7);
  });

  it.each([
    ['absent, the default', { degen: null }],
    ['configured but switched off', { degen: { ...DEGEN, enabled: false } }],
    ['switched on without a catalog to read', { catalog: null }],
  ] as const)('is shut when degen mode is %s', async (_label, options) => {
    const { api } = fixture(options);
    await expect(list(api)).resolves.toEqual({
      status: 503,
      body: { code: 'HTTP_503', message: 'Degen mode is disabled.' },
    });
  });

  it('is shut whenever the swap route is, so the counter stays off with swap', async () => {
    const { api, config, catalog } = fixture();
    config.routes.swap.enabled = false;
    await expect(list(api)).resolves.toMatchObject({ status: 503, body: { message: 'This private route is disabled.' } });
    config.routes.swap.enabled = true;
    config.globalEnabled = false;
    await expect(list(api)).resolves.toMatchObject({ status: 503, body: { code: 'SERVICE_DISABLED' } });
    expect(catalog.snapshot).not.toHaveBeenCalled();
  });

  it('takes nothing from the request: no body, no other method, no query string', async () => {
    const { api, catalog } = fixture();
    await expect(list(api, { v: 1, tokens: [STRANGER] })).resolves.toMatchObject({ status: 400 });
    await expect(list(api, {})).resolves.toMatchObject({ status: 400 });
    await expect(api.handle({ method: 'POST', path: DEGEN_TOKENS_PATH, body: { v: 1 } }))
      .resolves.toMatchObject({ status: 405 });
    await expect(api.handle({ method: 'GET', path: '/v1/rpc/pool-config', body: null }))
      .resolves.toMatchObject({ status: 405 });
    expect(catalog.snapshot).not.toHaveBeenCalled();

    const edge = createBackendFetchHandler(api);
    const queried = await edge(new Request(`http://backend.invalid${DEGEN_TOKENS_PATH}?address=${STRANGER}`));
    expect(queried.status).toBe(400);
    await expect(queried.json()).resolves.toMatchObject({ code: 'QUERY_NOT_ALLOWED' });
    expect(catalog.snapshot).not.toHaveBeenCalled();

    const plain = await edge(new Request(`http://backend.invalid${DEGEN_TOKENS_PATH}`));
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe('no-store');
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
    // The catalog is asked with a cancellation signal and nothing else.
    expect((catalog.snapshot as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    expect((catalog.snapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
  });
});

describe('degen swap admission (D-067, on the quote proxy since D-084)', () => {
  it('admits a curated token only while degen mode is on', async () => {
    const off = fixture({ degen: null });
    await expect(quote(off.api, STRK, LORDS)).resolves.toMatchObject({
      status: 400, body: { message: 'Swap token is not allowlisted.' },
    });
    expect(off.swapQuotes.quote).not.toHaveBeenCalled();

    const on = fixture();
    await expect(quote(on.api, STRK, LORDS)).resolves.toMatchObject({ status: 200 });
    await expect(quote(on.api, LORDS, STRK)).resolves.toMatchObject({ status: 200 });
  });

  it('admits a token from the backend\'s own current live list, and nothing else', async () => {
    const { api, swapQuotes } = fixture();
    await expect(quote(api, STRK, LIVE.address)).resolves.toMatchObject({ status: 200 });
    await expect(quote(api, LIVE.address, LORDS)).resolves.toMatchObject({ status: 200 });
    await expect(quote(api, STRK, STRANGER)).resolves.toMatchObject({
      status: 400, body: { message: 'Swap token is not allowlisted.' },
    });
    await expect(quote(api, STRANGER, LORDS)).resolves.toMatchObject({ status: 400 });
    expect(swapQuotes.quote).toHaveBeenCalledTimes(2);
  });

  it('lets nothing in the request widen the set', async () => {
    const { api, swapQuotes } = fixture();
    await expect(quote(api, STRK, STRANGER, { degen: true })).resolves.toMatchObject({ status: 400 });
    await expect(quote(api, STRK, STRANGER, { allowedTokens: [STRANGER] })).resolves.toMatchObject({ status: 400 });
    await expect(quote(api, STRK, STRANGER, { tokens: [{ address: STRANGER, curated: true }] }))
      .resolves.toMatchObject({ status: 400 });
    expect(swapQuotes.quote).not.toHaveBeenCalled();
  });

  it('never consults the degen list for a swap the static allowlist already covers', async () => {
    const { api, catalog } = fixture();
    await expect(quote(api, STRK, OTHER)).resolves.toMatchObject({ status: 200 });
    expect(catalog.snapshot).not.toHaveBeenCalled();
  });

  it('keeps the route\'s slippage ceiling for a degen swap', async () => {
    const { api, swapQuotes } = fixture();
    await expect(quote(api, STRK, LORDS, { slippageBps: 301 })).resolves.toMatchObject({ status: 400 });
    expect(swapQuotes.quote).not.toHaveBeenCalled();
  });

  it('quotes nothing once avnu has dropped the token, or degen mode is switched off', async () => {
    const dropped = fixture();
    await expect(quote(dropped.api, STRK, LIVE.address)).resolves.toMatchObject({ status: 200 });
    dropped.setSnapshot(liveSnapshot([]));
    await expect(quote(dropped.api, STRK, LIVE.address)).resolves.toMatchObject({ status: 400 });

    const switched = fixture();
    await expect(quote(switched.api, LORDS, STRK)).resolves.toMatchObject({ status: 200 });
    switched.config.degen!.enabled = false;
    await expect(quote(switched.api, LORDS, STRK)).resolves.toMatchObject({ status: 400 });
    expect(switched.swapQuotes.quote).toHaveBeenCalledTimes(1);
  });

  it('relays no swap at all, degen or not', async () => {
    const { api, paymaster } = fixture();
    await expect(api.handle({
      method: 'POST',
      path: '/v1/private/fees',
      body: { v: 1, route: 'swap', feeToken: STRK, operationToken: LORDS },
    })).resolves.toMatchObject({ status: 400, body: { message: 'Swaps are not relayed.' } });
    expect(paymaster.buildFee).not.toHaveBeenCalled();
  });

  it('widens the swap route only', async () => {
    const { api } = fixture();
    await expect(api.handle({
      method: 'POST',
      path: '/v1/private/fees',
      body: { v: 1, route: 'transfer', feeToken: STRK, operationToken: LORDS },
    })).resolves.toMatchObject({ status: 400, body: { message: 'Operation token is not allowlisted for this route.' } });
  });

  it('refuses a malformed degen configuration at construction', () => {
    expect(() => fixture({ degen: { ...DEGEN, tags: ['Unknown' as never] } })).toThrow('degen catalog configuration is invalid');
    expect(() => fixture({ degen: { ...DEGEN, minDailyVolumeUsd: 0 } })).toThrow('degen catalog configuration is invalid');
  });
});

describe('the fail-closed BACKEND_DEGEN_* group', () => {
  function environment(overrides: Record<string, string> = {}): Record<string, string> {
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
      ...overrides,
    };
  }

  const DEGEN_ENVIRONMENT = {
    BACKEND_DEGEN_ENABLED: 'true',
    BACKEND_DEGEN_TAGS: 'Verified,Community,Unruggable,AVNU',
    BACKEND_DEGEN_MIN_DAILY_VOLUME_USD: '100',
    BACKEND_DEGEN_CACHE_TTL_MS: '600000',
  };

  it('is off when absent, and absent is the default', () => {
    expect(parseBackendEnvironment(environment()).backend.degen).toBeUndefined();
    expect(parseBackendEnvironment(environment({ BACKEND_DEGEN_ENABLED: '' })).backend.degen).toBeUndefined();
  });

  it('parses a complete group, and may be present but switched off', () => {
    expect(parseBackendEnvironment(environment(DEGEN_ENVIRONMENT)).backend.degen).toEqual(DEGEN);
    expect(parseBackendEnvironment(environment({
      ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'Community , Verified',
    })).backend.degen?.tags).toEqual(['Community', 'Verified']);
    expect(parseBackendEnvironment(environment({ ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_ENABLED: 'false' }))
      .backend.degen).toMatchObject({ enabled: false });
  });

  it.each([
    ['a degen variable without the enable flag', { BACKEND_DEGEN_TAGS: 'Verified' }],
    ['a volume floor without the enable flag', { BACKEND_DEGEN_MIN_DAILY_VOLUME_USD: '100' }],
    ['an enabled group missing its tags', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: '' }],
    ['an enabled group missing its floor', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_MIN_DAILY_VOLUME_USD: '' }],
    ['an enabled group missing its cache lifetime', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_CACHE_TTL_MS: '' }],
    ['a malformed enable flag', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_ENABLED: 'yes' }],
    ['the Unknown tag', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'Verified,Unknown' }],
    ['a tag avnu does not define', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'Verified,Meme' }],
    ['a lower-case tag', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'verified' }],
    ['a repeated tag', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'Verified,Verified' }],
    ['an empty tag entry', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'Verified,' }],
    ['a placeholder tag list', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: 'REPLACE_WITH_TAGS' }],
    ['an untrimmed tag list', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_TAGS: ' Verified' }],
    ['a zero volume floor', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_MIN_DAILY_VOLUME_USD: '0' }],
    ['a fractional volume floor', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_MIN_DAILY_VOLUME_USD: '0.5' }],
    ['a negative volume floor', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_MIN_DAILY_VOLUME_USD: '-1' }],
    ['a cache lifetime under a minute', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_CACHE_TTL_MS: '59999' }],
    ['a cache lifetime over a day', { ...DEGEN_ENVIRONMENT, BACKEND_DEGEN_CACHE_TTL_MS: '86400001' }],
  ])('refuses to start with %s', (_label, override) => {
    expect(() => parseBackendEnvironment(environment(override))).toThrow(/BACKEND_DEGEN_/);
  });

  it('composes the backend-side avnu fetch and serves it through the HTTP listener', async () => {
    fetchTokensMock.mockReset();
    fetchTokensMock.mockResolvedValue({
      content: [{
        name: 'Ekubo Protocol', address: LIVE.address, symbol: 'EKUBO', decimals: 18, logoUri: null,
        lastDailyVolumeUsd: 1742.44, extensions: {}, tags: ['AVNU', 'Verified'],
      }],
      totalPages: 1, totalElements: 1, size: 200, number: 0,
    });
    const runtime = createBackendRuntime(environment(DEGEN_ENVIRONMENT), {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: {
        getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn(),
      },
      swapQuotes: { quote: vi.fn() },
    });
    const running = await listenBackendServer(runtime.server, { port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${running.address.port}${DEGEN_TOKENS_PATH}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { source: string; tokens: Array<{ symbol: string }> };
      expect(body.source).toBe('live');
      expect(body.tokens.map((token) => token.symbol).at(-1)).toBe('EKUBO');
      expect(fetchTokensMock).toHaveBeenCalledOnce();
      expect(fetchTokensMock.mock.calls[0]![0]).toEqual({
        page: 0, size: 200, tags: ['Verified', 'Community', 'Unruggable', 'AVNU'],
      });
    } finally {
      await running.close();
    }
  });

  it('composes no avnu fetch at all without the group', async () => {
    fetchTokensMock.mockReset();
    const runtime = createBackendRuntime(environment(), {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: {
        getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn(),
      },
      swapQuotes: { quote: vi.fn() },
    });
    await expect(runtime.api.handle({ method: 'GET', path: DEGEN_TOKENS_PATH, body: null }))
      .resolves.toMatchObject({ status: 503, body: { message: 'Degen mode is disabled.' } });
    expect(fetchTokensMock).not.toHaveBeenCalled();
  });
});
