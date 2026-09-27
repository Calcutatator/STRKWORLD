import { describe, expect, it, vi } from 'vitest';
import { ENDUR_DEPOSIT_ANONYMIZER, ENDUR_XSTRK, ENDUR_XSTRK_ASSET } from './endur.js';
import { parseBackendEnvironment } from './environment.js';
import {
  BackendApi,
  MemoryAuthorizationCodec,
  type BackendConfig,
  type PaymasterPort,
  type PoolRpcPort,
  type PreparedArtifact,
  type RoutePolicy,
} from './index.js';

/**
 * Endur private staking (D-063) on the relay: fail-closed and disabled by
 * default, relayed through the ordinary delayed queue, and sponsored only for
 * the pinned anonymizer call with STRK in and xSTRK out.
 */

const POOL = '0x123';
const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const ANONYMIZER = ENDUR_DEPOSIT_ANONYMIZER;
const FEE_RECIPIENT = '0x789';
const OTHER = '0xabc';
const NOTE_ID = '0x5e1';
const U128_MASK = (1n << 128n) - 1n;

const STAKE_POLICY: RoutePolicy = {
  enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false, allowedTokens: [STRK],
};

function felt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** `null` configures no stake route at all, as a deployment without the variables does. */
function fixture(stake: RoutePolicy | null = STAKE_POLICY, feeAmount = 7n) {
  const delays: number[] = [];
  const submitted: PreparedArtifact[] = [];
  const paymaster: PaymasterPort = {
    buildFee: vi.fn(async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: feeAmount })),
    submit: vi.fn(async (input: Parameters<PaymasterPort['submit']>[0]) => {
      submitted.push(input.artifact);
      return { transactionHash: '0x5ab' };
    }),
  };
  const rpc: PoolRpcPort = {
    async getPoolConfig() {
      return { feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async getPublicKey() {
      return '0x99';
    },
    async getReceipt(hash) {
      return { transactionHash: hash };
    },
    async getBlockNumber() {
      return 1_000;
    },
  };
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
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false, allowedTokens: [STRK] },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false, allowedTokens: [STRK] },
      swap: {
        enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: true, allowedTokens: [STRK], maxSlippageBps: 300,
      },
      ...(stake ? { stake } : {}),
    },
  };
  const authorizations = new MemoryAuthorizationCodec();
  const api = new BackendApi({
    config,
    paymaster,
    rpc,
    authorizations,
    randomInt: () => 250,
    sleep: async (ms) => { delays.push(ms); },
    now: () => 1_000,
  });
  return { api, paymaster, authorizations, delays, submitted };
}

async function feeFor(api: BackendApi, route = 'stake', operationToken = STRK) {
  return api.handle({
    method: 'POST',
    path: '/v1/private/fees',
    body: { v: 1, route, feeToken: STRK, operationToken },
  });
}

async function authorizedStake(api: BackendApi): Promise<string> {
  const response = await feeFor(api);
  expect(response.status).toBe(200);
  return (response.body as { authorization: string }).authorization;
}

function submit(api: BackendApi, artifact: PreparedArtifact, feeAuthorization: string, route = 'stake') {
  return api.handle({
    method: 'POST',
    path: '/v1/private/submissions',
    body: { v: 1, route, artifact, feeAuthorization, proofValidityBlocks: 450 },
  });
}

interface StakeShape {
  assets?: bigint;
  target?: string;
  invokeCalldata?: string[];
  withdrawTo?: string;
  withdrawToken?: string;
  withdrawAmount?: bigint;
  feeAmount?: bigint;
  omitInvoke?: boolean;
  omitWithdrawal?: boolean;
  omitFee?: boolean;
  extra?: string[][];
}

/** The pool's `Span<ServerAction>` for a stake, as the proof output exposes it. */
function stakeActionCalldata(shape: StakeShape = {}): string[] {
  const assets = shape.assets ?? 5n;
  const invokeCalldata = shape.invokeCalldata ?? [STRK, XSTRK, felt(assets & U128_MASK), felt(assets >> 128n), NOTE_ID];
  const actions: string[][] = [];
  if (!shape.omitWithdrawal) {
    // TransferTo(to, token, amount): the pool pays the anonymizer.
    actions.push(['0x3', shape.withdrawTo ?? ANONYMIZER, shape.withdrawToken ?? STRK, felt(shape.withdrawAmount ?? assets)]);
  }
  if (!shape.omitFee) actions.push(['0x3', FEE_RECIPIENT, STRK, felt(shape.feeAmount ?? 7n)]);
  actions.push(['0x9', '0x9a1']); // EmitNoteUsed(nullifier)
  actions.push(['0x7', '0xe1', '0xe2', '0xe3', XSTRK, NOTE_ID]); // EmitOpenNoteCreated
  if (!shape.omitInvoke) {
    // Invoke(contract, Span<felt>)
    actions.push(['0xa', shape.target ?? ANONYMIZER, felt(BigInt(invokeCalldata.length)), ...invokeCalldata]);
  }
  actions.push(...(shape.extra ?? []));
  return [felt(BigInt(actions.length)), ...actions.flat()];
}

function stakeArtifact(shape?: StakeShape): PreparedArtifact {
  const actions = stakeActionCalldata(shape);
  return {
    // The current pool appends a `None` screening attestation after the actions.
    call: { contract_address: POOL, entry_point: 'apply_actions', calldata: [...actions, '0x1'] },
    proof: { data: 'proof-data', output: ['0xc1', ...actions], proof_facts: ['0x4'] },
  };
}

function baseEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
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
    BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS: '45000',
    BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_UNSHIELD_ENABLED: 'true',
    BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS: '45000',
    BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_SWAP_ENABLED: 'true',
    BACKEND_ROUTE_SWAP_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_SWAP_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS: '50',
    ...overrides,
  };
}

const STAKE_ENVIRONMENT = {
  BACKEND_ROUTE_STAKE_ENABLED: 'true',
  BACKEND_ROUTE_STAKE_MAX_RELAY_FEE: '10',
  BACKEND_ROUTE_STAKE_MAX_QUEUE_DELAY_MS: '45000',
  BACKEND_ROUTE_STAKE_ALLOWED_TOKENS: STRK,
};

describe('stake route environment', () => {
  it('is absent, and so disabled, when no stake variable is set', () => {
    const parsed = parseBackendEnvironment(baseEnvironment());

    expect(parsed.backend.routes.stake).toBeUndefined();
    expect('stake' in parsed.backend.routes).toBe(false);
  });

  it('treats an empty enable flag as unset', () => {
    const parsed = parseBackendEnvironment(baseEnvironment({ BACKEND_ROUTE_STAKE_ENABLED: '' }));
    expect(parsed.backend.routes.stake).toBeUndefined();
  });

  it('parses a complete group as a delayed, non-quote-bound route', () => {
    const parsed = parseBackendEnvironment(baseEnvironment(STAKE_ENVIRONMENT));

    expect(parsed.backend.routes.stake).toEqual({
      enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 45_000, quoteBound: false, allowedTokens: [STRK],
    });
  });

  it('parses an explicitly disabled group', () => {
    const parsed = parseBackendEnvironment(baseEnvironment({ ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_ENABLED: 'false' }));
    expect(parsed.backend.routes.stake).toMatchObject({ enabled: false });
  });

  it.each([
    ['a stake variable without the enable flag', { BACKEND_ROUTE_STAKE_ALLOWED_TOKENS: STRK }],
    ['an enabled group missing its fee ceiling', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_MAX_RELAY_FEE: '' }],
    ['a malformed enable flag', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_ENABLED: 'yes' }],
    ['an immediate queue', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_MAX_QUEUE_DELAY_MS: '0' }],
    ['a queue delay over the Node timer', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_MAX_QUEUE_DELAY_MS: '2147483648' }],
    ['a fee ceiling over u128', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_MAX_RELAY_FEE: (1n << 128n).toString() }],
    ['a placeholder allowlist', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_ALLOWED_TOKENS: '0xREPLACE_WITH_STRK_TOKEN_ADDRESS' }],
    ['a zero allowlisted token', { ...STAKE_ENVIRONMENT, BACKEND_ROUTE_STAKE_ALLOWED_TOKENS: '0x0' }],
  ])('fails startup on %s, naming the variable', (_label, override) => {
    expect(() => parseBackendEnvironment(baseEnvironment(override))).toThrow(/BACKEND_ROUTE_STAKE_/);
  });
});

describe('stake route configuration', () => {
  it.each([
    ['STRK and xSTRK', [STRK, XSTRK]],
    ['another token', [OTHER]],
    ['xSTRK alone', [XSTRK]],
  ])('refuses an enabled stake route admitting %s', (_label, allowedTokens) => {
    expect(() => fixture({ ...STAKE_POLICY, allowedTokens })).toThrow('must admit exactly STRK');
  });

  it.each([
    ['quote-bound', { quoteBound: true }],
    ['immediate', { maxQueueDelayMs: 0 }],
  ])('refuses a %s stake route', (_label, patch) => {
    expect(() => fixture({ ...STAKE_POLICY, ...patch })).toThrow('non-quote-bound and delayed');
  });

  it('accepts a disabled stake route whatever it would admit', () => {
    expect(() => fixture({ ...STAKE_POLICY, enabled: false, allowedTokens: [OTHER] })).not.toThrow();
  });
});

describe('stake fee authorization', () => {
  it.each([
    ['absent', null],
    ['explicitly disabled', { ...STAKE_POLICY, enabled: false }],
  ])('denies a stake fee while the route is %s, exactly as any disabled route', async (_label, stake) => {
    const { api, paymaster } = fixture(stake);
    const response = await feeFor(api);

    expect(response).toEqual({
      status: 503, body: { code: 'HTTP_503', message: 'This private route is disabled.' },
    });
    expect(paymaster.buildFee).not.toHaveBeenCalled();
  });

  it('issues a stake-bound relay authorization for STRK with no swap binding', async () => {
    const { api, authorizations } = fixture();
    const claims = await authorizations.verify(await authorizedStake(api));

    expect(claims).toMatchObject({ route: 'stake', operationToken: STRK, token: STRK, amount: 7n });
    expect(claims?.swap).toBeUndefined();
  });

  it('refuses an operation token other than STRK', async () => {
    const { api, paymaster } = fixture();
    const response = await feeFor(api, 'stake', XSTRK);

    expect(response.status).toBe(400);
    expect(paymaster.buildFee).not.toHaveBeenCalled();
  });

  it('refuses a paymaster fee above the stake ceiling', async () => {
    const { api } = fixture(STAKE_POLICY, 11n);
    expect((await feeFor(api)).status).toBe(400);
  });
});

describe('stake submission validation', () => {
  it('relays the exact stake action set after the ordinary queue delay', async () => {
    const { api, delays, submitted } = fixture();
    const artifact = stakeArtifact();

    const response = await submit(api, artifact, await authorizedStake(api));
    expect(response).toEqual({ status: 200, body: { transactionHash: '0x5ab' } });
    expect(delays).toEqual([250]);
    expect(submitted).toEqual([artifact]);
  });

  it('binds the u256 across both limbs', async () => {
    const { api } = fixture();
    const response = await submit(api, stakeArtifact({ assets: (1n << 128n) + 5n }), await authorizedStake(api));
    expect(response.status).toBe(200);
  });

  it.each<[string, StakeShape]>([
    ['another invoke target', { target: OTHER }],
    ['no invoke', { omitInvoke: true }],
    ['a second invoke', { extra: [['0xa', ANONYMIZER, '0x5', STRK, XSTRK, '0x5', '0x0', NOTE_ID]] }],
    ['xSTRK as the input token', { invokeCalldata: [XSTRK, XSTRK, '0x5', '0x0', NOTE_ID] }],
    ['STRK as the output token', { invokeCalldata: [STRK, STRK, '0x5', '0x0', NOTE_ID] }],
    ['another output token', { invokeCalldata: [STRK, OTHER, '0x5', '0x0', NOTE_ID] }],
    ['a missing note id', { invokeCalldata: [STRK, XSTRK, '0x5', '0x0'] }],
    ['trailing calldata', { invokeCalldata: [STRK, XSTRK, '0x5', '0x0', NOTE_ID, '0x1'] }],
    ['a low limb outside u128', { invokeCalldata: [STRK, XSTRK, felt(1n << 128n), '0x0', NOTE_ID], withdrawAmount: 1n << 128n }],
    ['a zero amount', { assets: 0n }],
    ['a withdrawal that disagrees with the invoke amount', { withdrawAmount: 6n }],
    ['a high limb the withdrawal ignores', { invokeCalldata: [STRK, XSTRK, '0x5', '0x1', NOTE_ID] }],
    ['a withdrawal to someone other than the anonymizer', { withdrawTo: OTHER }],
    ['a withdrawal of another token', { withdrawToken: XSTRK }],
    ['no withdrawal to the anonymizer', { omitWithdrawal: true }],
    ['an extra public withdrawal', { extra: [['0x3', OTHER, STRK, '0x1']] }],
    ['no relay fee', { omitFee: true }],
    ['a relay fee other than the authorized one', { feeAmount: 8n }],
    ['a public deposit', { extra: [['0x6', OTHER, STRK, '0x1']] }],
    ['a computed invoke', { extra: [['0xb', ANONYMIZER, '0x0']] }],
  ])('rejects %s without sponsoring it', async (_label, shape) => {
    const { api, paymaster } = fixture();
    const response = await submit(api, stakeArtifact(shape), await authorizedStake(api));

    expect(response.status).toBe(400);
    expect(paymaster.submit).not.toHaveBeenCalled();
  });

  it('rejects a transfer authorization replayed on the stake route', async () => {
    const { api, paymaster } = fixture();
    const transfer = await feeFor(api, 'transfer');
    const response = await submit(api, stakeArtifact(), (transfer.body as { authorization: string }).authorization);

    expect(response.status).toBe(401);
    expect(paymaster.submit).not.toHaveBeenCalled();
  });

  it('rejects a stake authorization and artifact replayed on the transfer route', async () => {
    const { api, paymaster } = fixture();
    const response = await submit(api, stakeArtifact(), await authorizedStake(api), 'transfer');

    expect(response.status).toBe(401);
    expect(paymaster.submit).not.toHaveBeenCalled();
  });

  it('denies a stake submission once the route is disabled', async () => {
    const enabled = fixture();
    const authorization = await authorizedStake(enabled.api);
    const { api, paymaster } = fixture(null);
    const response = await submit(api, stakeArtifact(), authorization);

    expect(response.status).toBe(503);
    expect(paymaster.submit).not.toHaveBeenCalled();
  });
});
