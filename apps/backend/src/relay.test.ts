import { PaymasterRpcError } from '@avnu/avnu-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvnuPaymasterPort } from './avnu-paymaster.js';
import { ENDUR_XSTRK_ASSET } from './endur.js';
import {
  BackendApi,
  MemoryAuthorizationCodec,
  type BackendConfig,
  type DegenCatalogPort,
  type PaymasterPort,
  type PoolRpcPort,
  type PreparedArtifact,
  type RoutePolicy,
  type SwapQuotePort,
} from './index.js';
import {
  isRelayStartupNotice,
  RELAY_NOT_CONFIGURED_CODE,
  RELAY_NOT_CONFIGURED_MESSAGE,
  RelayNotConfiguredError,
  refusedRelayRoutes,
  relayStartupNotice,
} from './relay.js';
import { createBackendRuntime } from './runtime.js';

/**
 * D-070: avnu's paymaster refuses `sponsored_private` without a Portal key.
 * Without one the relay refuses every enabled relayed route with one fixed
 * 503 and never calls avnu; with a key avnu rejects, it answers the same.
 * Every other upstream failure keeps its old answer.
 */

const POOL = '0x123';
const STRK = ENDUR_XSTRK_ASSET;
const FEE_RECIPIENT = '0x789';
const REFUSED = { status: 503, body: { code: 'RELAY_NOT_CONFIGURED', message: 'The private relay is not configured on this deployment.' } };
const UPSTREAM = { status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } };

const transferCalldata = ['0x1', '0x3', FEE_RECIPIENT, STRK, '0x7'];
const artifact: PreparedArtifact = {
  call: { contract_address: POOL, entry_point: 'apply_actions', calldata: transferCalldata },
  proof: { data: 'proof-data', output: ['0xc1', ...transferCalldata], proof_facts: ['0x4'] },
};

const STAKE: RoutePolicy = {
  enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK],
};

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
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
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      swap: {
        enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: true, allowedTokens: [STRK, '0xabc'], maxSlippageBps: 300,
      },
      stake: STAKE,
    },
    ...overrides,
  };
}

function fixture(paymaster: PaymasterPort, overrides: Partial<BackendConfig> = {}) {
  const rpc: PoolRpcPort = {
    getPoolConfig: vi.fn(async () => ({ feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 })),
    getPublicKey: vi.fn(async () => '0x99'),
    getReceipt: vi.fn(async (hash: string) => ({ transactionHash: hash })),
    getBlockNumber: vi.fn(async () => 1_000),
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
  const degenCatalog: DegenCatalogPort = { snapshot: vi.fn(async () => ({ source: 'curated' as const, tokens: [] })) };
  const authorizations = new MemoryAuthorizationCodec();
  const api = new BackendApi({
    config: config(overrides),
    paymaster,
    rpc,
    authorizations,
    swapQuotes,
    degenCatalog,
    now: () => 1_000,
    sleep: async () => undefined,
  });
  return { api, rpc, swapQuotes, degenCatalog, authorizations };
}

function keylessPaymaster() {
  return {
    configured: false,
    buildFee: vi.fn(async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: 7n })),
    submit: vi.fn(async () => ({ transactionHash: '0x5ab' })),
  } satisfies PaymasterPort;
}

const fee = (api: BackendApi, route: string) => api.handle({
  method: 'POST',
  path: '/v1/private/fees',
  body: { v: 1, route, feeToken: STRK, operationToken: STRK },
});

const submission = (api: BackendApi, route: string, feeAuthorization: string) => api.handle({
  method: 'POST',
  path: '/v1/private/submissions',
  body: { v: 1, route, artifact, feeAuthorization, proofValidityBlocks: 450 },
});

const swapQuote = (api: BackendApi) => api.handle({
  method: 'POST',
  path: '/v1/swap/quote',
  body: { v: 1, sellToken: '0xabc', buyToken: STRK, sellAmount: '20', taker: '0x5ad0', slippageBps: 100 },
});

async function authorizationFor(authorizations: MemoryAuthorizationCodec, route: 'transfer' | 'unshield' | 'stake') {
  return authorizations.issue({
    v: 1,
    route,
    feeToken: STRK,
    operationToken: STRK,
    token: STRK,
    recipient: FEE_RECIPIENT,
    amount: 7n,
    issuedAtBlock: 1_000,
    expiresAtBlock: 1_450,
  });
}

function avnuPort(options: {
  apiKey?: string;
  buildFee?: () => Promise<unknown>;
  submit?: () => Promise<unknown>;
} = {}) {
  const buildFee = vi.fn(options.buildFee ?? (async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: 7n })));
  const submit = vi.fn(options.submit ?? (async () => ({ transactionHash: '0x5ab' })));
  const port = new AvnuPaymasterPort({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    functions: { buildFee: buildFee as never, submit: submit as never },
  });
  return { port, buildFee, submit };
}

/** avnu's answer to the exact SDK request with no key, replayed 2026-09-28. */
function keyRejection(method = 'paymaster_buildTransaction'): PaymasterRpcError {
  return new PaymasterRpcError(method, 'An error occurred (UNKNOWN_ERROR)', 163, 'x-paymaster-api-key is invalid');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a relay with no avnu key (D-070)', () => {
  it.each(['transfer', 'unshield', 'stake'])('refuses a %s fee without asking avnu or the chain', async (route) => {
    const paymaster = keylessPaymaster();
    const { api, rpc } = fixture(paymaster);
    await expect(fee(api, route)).resolves.toEqual(REFUSED);
    expect(paymaster.buildFee).not.toHaveBeenCalled();
    expect(rpc.getPoolConfig).not.toHaveBeenCalled();
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
  });

  it('still quotes a swap: the swap is never relayed, and its quote needs no key (D-084)', async () => {
    const paymaster = keylessPaymaster();
    const { api, swapQuotes } = fixture(paymaster);
    await expect(swapQuote(api)).resolves.toMatchObject({ status: 200, body: { quoteId: 'quote-1' } });
    expect(swapQuotes.quote).toHaveBeenCalledTimes(1);
    expect(paymaster.buildFee).not.toHaveBeenCalled();
  });

  it('refuses a swap on the relay routes as not relayed (D-084)', async () => {
    const paymaster = keylessPaymaster();
    const { api } = fixture(paymaster);
    await expect(fee(api, 'swap')).resolves.toMatchObject({ status: 400, body: { message: 'Swaps are not relayed.' } });
    await expect(submission(api, 'swap', 'auth')).resolves.toMatchObject({ status: 400 });
    expect(paymaster.buildFee).not.toHaveBeenCalled();
    expect(paymaster.submit).not.toHaveBeenCalled();
  });

  it.each(['transfer', 'unshield', 'stake'] as const)('refuses a %s submission, even one carrying a valid authorization', async (route) => {
    const paymaster = keylessPaymaster();
    const { api, rpc, authorizations } = fixture(paymaster);
    await expect(submission(api, route, await authorizationFor(authorizations, route))).resolves.toEqual(REFUSED);
    expect(paymaster.submit).not.toHaveBeenCalled();
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
  });

  it('keeps a disabled route disabled and the kill switch in charge', async () => {
    const paymaster = keylessPaymaster();
    const disabled = fixture(paymaster, { routes: { ...config().routes, unshield: { ...config().routes.unshield, enabled: false } } });
    await expect(fee(disabled.api, 'unshield')).resolves.toEqual({
      status: 503, body: { code: 'HTTP_503', message: 'This private route is disabled.' },
    });
    // A deployment without the stake group has no stake route at all.
    const noStake = fixture(paymaster, { routes: { ...config().routes, stake: undefined } });
    await expect(fee(noStake.api, 'stake')).resolves.toMatchObject({ status: 503, body: { code: 'HTTP_503' } });
    const killed = fixture(paymaster, { globalEnabled: false });
    await expect(fee(killed.api, 'transfer')).resolves.toMatchObject({ status: 503, body: { code: 'SERVICE_DISABLED' } });
    expect(paymaster.buildFee).not.toHaveBeenCalled();
  });

  it('still rejects a malformed request as malformed, and still reads the pool', async () => {
    const { api } = fixture(keylessPaymaster());
    await expect(api.handle({
      method: 'POST', path: '/v1/private/fees', body: { v: 1, route: 'transfer' },
    })).resolves.toMatchObject({ status: 400 });
    await expect(api.handle({
      method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('writes nothing per request (D-014): the refusal is an answer, not a log line', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const { api, authorizations } = fixture(keylessPaymaster());
    for (let request = 0; request < 3; request += 1) {
      await fee(api, 'unshield');
      await swapQuote(api);
      await submission(api, 'transfer', await authorizationFor(authorizations, 'transfer'));
    }
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the avnu adapter without a key (D-070)', () => {
  it('never calls avnu, and says the relay is not configured', async () => {
    const { port, buildFee, submit } = avnuPort();
    expect(port.configured).toBe(false);
    await expect(port.buildFee({ route: 'unshield', poolAddress: POOL, feeToken: STRK, operationToken: STRK }))
      .rejects.toBeInstanceOf(RelayNotConfiguredError);
    await expect(port.submit({ route: 'unshield', artifact, fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 7n } }))
      .rejects.toBeInstanceOf(RelayNotConfiguredError);
    expect(buildFee).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(avnuPort({ apiKey: '' }).port.configured).toBe(false);
    expect(avnuPort({ apiKey: 'portal-key' }).port.configured).toBe(true);
  });
});

describe('a key avnu rejects (D-070)', () => {
  it.each([
    ['the replayed 163', keyRejection()],
    ['a 163 naming the key in its message', new PaymasterRpcError('paymaster_buildTransaction', 'Invalid API key', 163)],
    ['a 163 in other capitals', new PaymasterRpcError('paymaster_buildTransaction', 'error', 163, 'X-Paymaster-API-Key is invalid')],
    ['a 163 whose data is an object', new PaymasterRpcError('paymaster_buildTransaction', 'error', 163, { reason: 'api_key rejected' })],
  ])('answers the fee build RELAY_NOT_CONFIGURED for %s', async (_label, rejection) => {
    const { port, buildFee } = avnuPort({ apiKey: 'portal-key', buildFee: async () => { throw rejection; } });
    const { api } = fixture(port);
    await expect(fee(api, 'unshield')).resolves.toEqual(REFUSED);
    expect(buildFee).toHaveBeenCalledTimes(1);
    expect(buildFee.mock.calls[0]).toEqual([expect.objectContaining({ paymasterApiKey: 'portal-key' }), expect.anything()]);
  });

  it('answers a submission the same way, and never touches a swap quote, which needs no key (D-084)', async () => {
    const swap = avnuPort({ apiKey: 'portal-key', buildFee: async () => { throw keyRejection(); } });
    await expect(swapQuote(fixture(swap.port).api)).resolves.toMatchObject({ status: 200 });
    expect(swap.buildFee).not.toHaveBeenCalled();

    const relay = avnuPort({ apiKey: 'portal-key', submit: async () => { throw keyRejection('paymaster_executeTransaction'); } });
    const { api, authorizations } = fixture(relay.port);
    await expect(submission(api, 'transfer', await authorizationFor(authorizations, 'transfer'))).resolves.toEqual(REFUSED);
    expect(relay.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 163 outage', new PaymasterRpcError('paymaster_buildTransaction', 'An error occurred (UNKNOWN_ERROR)', 163, 'service unavailable')],
    ['a 163 blacklisted call', new PaymasterRpcError('paymaster_buildTransaction', 'An error occurred (UNKNOWN_ERROR)', 163)],
    ['another code naming the key', new PaymasterRpcError('paymaster_buildTransaction', 'bad', 156, 'api key fine, execution failed')],
    ['a plain error naming the key', new Error('x-paymaster-api-key is invalid')],
  ])('keeps %s an ordinary upstream failure', async (_label, failure) => {
    const { port } = avnuPort({ apiKey: 'portal-key', buildFee: async () => { throw failure; } });
    await expect(fee(fixture(port).api, 'unshield')).resolves.toEqual(UPSTREAM);
  });

  it('relays normally with a key avnu accepts', async () => {
    const { port, buildFee } = avnuPort({ apiKey: 'portal-key' });
    await expect(fee(fixture(port).api, 'unshield')).resolves.toMatchObject({ status: 200 });
    expect(buildFee).toHaveBeenCalledTimes(1);
  });
});

describe('the relay startup notice (D-070)', () => {
  it('names the enabled routes it will refuse, and nothing while a key is set or the switch is off', () => {
    // An enabled swap route is never refused: it is not relayed (D-084).
    expect(refusedRelayRoutes(config(), false)).toEqual(['transfer', 'unshield', 'stake']);
    expect(refusedRelayRoutes(config({ routes: { ...config().routes, stake: undefined } }), false))
      .toEqual(['transfer', 'unshield']);
    expect(refusedRelayRoutes(config(), true)).toEqual([]);
    expect(refusedRelayRoutes(config({ globalEnabled: false }), false)).toEqual([]);

    expect(relayStartupNotice(['transfer', 'unshield'])).toBe(
      '[relay] AVNU_PAYMASTER_API_KEY is not set: transfer, unshield will answer 503 RELAY_NOT_CONFIGURED until it is (D-070).',
    );
    expect(relayStartupNotice([])).toBeNull();
    expect(RELAY_NOT_CONFIGURED_CODE).toBe(REFUSED.body.code);
    expect(RELAY_NOT_CONFIGURED_MESSAGE).toBe(REFUSED.body.message);
  });

  it('admits exactly its own lines at the edge, so a child cannot print anything else', () => {
    const routes = ['transfer', 'unshield', 'stake'] as const;
    for (let mask = 1; mask < 1 << routes.length; mask += 1) {
      const subset = routes.filter((_, index) => mask & (1 << index));
      expect(isRelayStartupNotice(relayStartupNotice(subset)), subset.join()).toBe(true);
    }
    const line = relayStartupNotice(['unshield'])!;
    for (const forged of [`${line}\n[relay] more`, ` ${line}`, line.replace('unshield', 'withdraw'), line.replace('unshield', 'swap'), '[debug] x', 42, null, undefined]) {
      expect(isRelayStartupNotice(forged), String(forged)).toBe(false);
    }
  });

  it('is composed once by the runtime from the parsed environment', () => {
    const keyless = { ...environment() };
    delete keyless['AVNU_PAYMASTER_API_KEY'];
    expect(createBackendRuntime(keyless).startupNotice).toBe(
      '[relay] AVNU_PAYMASTER_API_KEY is not set: transfer, unshield will answer 503 RELAY_NOT_CONFIGURED until it is (D-070).',
    );
    expect(createBackendRuntime({ ...environment(), AVNU_PAYMASTER_API_KEY: '' }).startupNotice).toMatch(/^\[relay\] /);
    expect(createBackendRuntime(environment()).startupNotice).toBeNull();
    expect(createBackendRuntime({ ...keyless, BACKEND_GLOBAL_ENABLED: 'false' }).startupNotice).toBeNull();
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
