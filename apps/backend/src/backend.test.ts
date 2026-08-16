import { describe, expect, it, vi } from 'vitest';
import {
  BackendApi,
  HmacAuthorizationCodec,
  MemoryAuthorizationCodec,
  type BackendConfig,
  type PaymasterPort,
  type PoolRpcPort,
  type PreparedArtifact,
  type SwapPlannerPort,
} from './index.js';

const POOL = '0x123';
const STRK = '0x4718';
const FEE_RECIPIENT = '0x789';

const transferCalldata = ['0x1', '0x3', FEE_RECIPIENT, STRK, '0x7'];
const artifact: PreparedArtifact = {
  call: { contract_address: POOL, entry_point: 'apply_actions', calldata: transferCalldata },
  proof: { data: 'proof-data', output: ['0xc1', ...transferCalldata], proof_facts: ['0x4'] },
};

function fixture(overrides: Partial<BackendConfig> = {}) {
  let block = 1_000;
  let now = 1_000;
  const delays: number[] = [];
  const submitted: PreparedArtifact[] = [];
  const paymaster: PaymasterPort = {
    async buildFee() {
      return { token: STRK, recipient: FEE_RECIPIENT, amount: 7n };
    },
    async submit(input) {
      submitted.push(input.artifact);
      return { transactionHash: '0xsubmitted' };
    },
  };
  const rpc: PoolRpcPort = {
    async getPoolConfig() {
      return { feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async getPublicKey(address) {
      return address === '0x456' ? '0x99' : '0x0';
    },
    async getReceipt(hash) {
      return { transactionHash: hash, status: 'accepted' };
    },
    async getBlockNumber() {
      return block;
    },
  };
  const config: BackendConfig = {
    poolAddress: POOL,
    feeToken: STRK,
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    routes: {
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false },
      swap: {
        enabled: true,
        maxRelayFee: 10n,
        maxQueueDelayMs: 0,
        quoteBound: true,
        allowedTokens: [STRK, '0xabc'],
        maxSlippageBps: 300,
      },
    },
    ...overrides,
  };
  const swapPlanner: SwapPlannerPort = {
    async prepare() {
      return {
        quoteId: 'quote-1',
        buyAmount: 100n,
        expiresAt: 2_000,
        chainId: '0x534e5f4d41494e',
        executorAddress: '0x999',
        executorCalls: [{
          contractAddress: '0x111',
          entrypoint: 'swap',
          selector: '0x555',
          calldata: ['0xaaa'],
        }],
      };
    },
  };
  const api = new BackendApi({
    config,
    paymaster,
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    randomInt: () => 250,
    sleep: async (ms) => { delays.push(ms); },
    now: () => now,
    swapPlanner,
  });
  return {
    api,
    paymaster,
    rpc,
    delays,
    submitted,
    setBlock(value: number) { block = value; },
    setNow(value: number) { now = value; },
  };
}

async function fee(api: BackendApi, route = 'transfer') {
  const response = await api.handle({
    method: 'POST',
    path: '/v1/private/fees',
    body: { v: 1, route, feeToken: STRK, operationToken: '0xabc' },
  });
  expect(response.status).toBe(200);
  return response.body as {
    token: string;
    recipient: string;
    amount: string;
    authorization: string;
    expiresAtBlock: number;
  };
}

describe('strict fee authorization', () => {
  it('validates the paymaster fee and returns a stateless authorization', async () => {
    const { api } = fixture();
    await expect(fee(api)).resolves.toMatchObject({
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: '7',
      expiresAtBlock: 1_450,
    });
  });

  it('rejects a tampered production HMAC authorization', async () => {
    const codec = new HmacAuthorizationCodec('a-long-production-secret-that-is-not-committed');
    const token = await codec.issue({
      v: 1,
      route: 'transfer',
      feeToken: STRK,
      operationToken: '0xabc',
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: 7n,
      issuedAtBlock: 1_000,
      expiresAtBlock: 1_450,
    });
    await expect(codec.verify(token)).resolves.toMatchObject({ amount: 7n });
    await expect(codec.verify(`${token.slice(0, -1)}x`)).resolves.toBeNull();
  });

  it('rejects unknown fields, wrong fee tokens, excessive fees, and disabled routes', async () => {
    const { api, paymaster } = fixture();
    await expect(api.handle({
      method: 'POST', path: '/v1/private/fees',
      body: { v: 1, route: 'transfer', feeToken: STRK, operationToken: '0xabc', target: '0xevil' },
    })).resolves.toMatchObject({ status: 400 });

    vi.spyOn(paymaster, 'buildFee').mockResolvedValue({ token: '0xdead', recipient: FEE_RECIPIENT, amount: 1n });
    await expect(fee(api)).rejects.toThrow();

    vi.mocked(paymaster.buildFee).mockResolvedValue({ token: STRK, recipient: FEE_RECIPIENT, amount: 11n });
    await expect(fee(api)).rejects.toThrow();

    const disabled = fixture({
      routes: {
        transfer: { enabled: false, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false },
        unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false },
        swap: {
          enabled: true,
          maxRelayFee: 10n,
          maxQueueDelayMs: 0,
          quoteBound: true,
          allowedTokens: [STRK, '0xabc'],
          maxSlippageBps: 300,
        },
      },
    });
    await expect(disabled.api.handle({
      method: 'POST', path: '/v1/private/fees',
      body: { v: 1, route: 'transfer', feeToken: STRK, operationToken: '0xabc' },
    })).resolves.toMatchObject({ status: 503 });
  });
});

describe('bounded private submission', () => {
  it('validates, jitters a pool-native artifact, rechecks freshness, and relays it', async () => {
    const { api, delays, submitted } = fixture();
    const quote = await fee(api);
    const response = await api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1,
        route: 'transfer',
        artifact,
        feeAuthorization: quote.authorization,
        proofValidityBlocks: 450,
      },
    });
    expect(response).toEqual({ status: 200, body: { transactionHash: '0xsubmitted' } });
    expect(delays).toEqual([250]);
    expect(submitted).toEqual([artifact]);
  });

  it('never delays a quote-bound route', async () => {
    const { api, delays } = fixture();
    const prepared = await api.handle({
      method: 'POST', path: '/v1/private/swaps/prepare',
      body: {
        v: 1,
        sellToken: '0xabc',
        buyToken: STRK,
        sellAmount: '20',
        minAmountOut: '90',
        slippageBps: 100,
      },
    });
    expect(prepared.status).toBe(200);
    const plan = prepared.body as {
      fee: { authorization: string };
    };
    const invokeCalldata = [
      STRK,
      '0x1', '0x111', '0x555', '0x1', '0xaaa',
      '0x777',
    ];
    const swapCalldata = [
      '0x3',
      '0x3', '0x999', '0xabc', '0x14',
      '0x3', FEE_RECIPIENT, STRK, '0x7',
      '0x9', '0x999', `0x${invokeCalldata.length.toString(16)}`, ...invokeCalldata,
    ];
    const swapArtifact: PreparedArtifact = {
      call: { contract_address: POOL, entry_point: 'apply_actions', calldata: swapCalldata },
      proof: { data: 'proof-data', output: ['0xc1', ...swapCalldata], proof_facts: ['0x4'] },
    };
    const result = await api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1,
        route: 'swap',
        artifact: swapArtifact,
        feeAuthorization: plan.fee.authorization,
        proofValidityBlocks: 450,
      },
    });
    expect(result.status).toBe(200);
    expect(delays).toEqual([]);
  });

  it('rejects a swap after its AVNU quote expiry even while the block authorization is live', async () => {
    const { api, setNow, submitted } = fixture();
    const prepared = await api.handle({
      method: 'POST', path: '/v1/private/swaps/prepare',
      body: {
        v: 1, sellToken: '0xabc', buyToken: STRK,
        sellAmount: '20', minAmountOut: '90', slippageBps: 100,
      },
    });
    const plan = prepared.body as { fee: { authorization: string } };
    const invokeCalldata = [STRK, '0x1', '0x111', '0x555', '0x1', '0xaaa', '0x777'];
    const calldata = [
      '0x3',
      '0x3', '0x999', '0xabc', '0x14',
      '0x3', FEE_RECIPIENT, STRK, '0x7',
      '0x9', '0x999', `0x${invokeCalldata.length.toString(16)}`, ...invokeCalldata,
    ];
    setNow(2_001);
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1,
        route: 'swap',
        artifact: {
          call: { contract_address: POOL, entry_point: 'apply_actions', calldata },
          proof: { data: 'proof', output: ['0xc1', ...calldata], proof_facts: ['0x1'] },
        },
        feeAuthorization: plan.fee.authorization,
        proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 409 });
    expect(submitted).toHaveLength(0);
  });

  it('fails closed on arbitrary targets, empty proofs, expired authorizations, and route mismatch', async () => {
    const { api, setBlock, submitted } = fixture();
    const quote = await fee(api);
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: { v: 1, route: 'unshield', artifact, feeAuthorization: quote.authorization, proofValidityBlocks: 450 },
    })).resolves.toMatchObject({ status: 401 });
    const badTarget = { ...artifact, call: { ...artifact.call, contract_address: '0xevil' } };
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: { v: 1, route: 'transfer', artifact: badTarget, feeAuthorization: quote.authorization, proofValidityBlocks: 450 },
    })).resolves.toMatchObject({ status: 400 });
    const invokeCalldata = [
      '0x2',
      '0x3', FEE_RECIPIENT, STRK, '0x7',
      '0x9', '0x999', '0x0',
    ];
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1,
        route: 'transfer',
        artifact: {
          ...artifact,
          call: { ...artifact.call, calldata: invokeCalldata },
          proof: { ...artifact.proof, output: ['0xc1', ...invokeCalldata] },
        },
        feeAuthorization: quote.authorization,
        proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 400 });
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: { v: 1, route: 'transfer', artifact: { ...artifact, proof: { ...artifact.proof, data: '' } }, feeAuthorization: quote.authorization, proofValidityBlocks: 450 },
    })).resolves.toMatchObject({ status: 400 });

    setBlock(1_451);
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: { v: 1, route: 'transfer', artifact, feeAuthorization: quote.authorization, proofValidityBlocks: 450 },
    })).resolves.toMatchObject({ status: 409 });
    expect(submitted).toHaveLength(0);
  });
});

describe('privacy-safe RPC and operations', () => {
  it('proxies only the fixed pool reads and keeps metrics aggregate', async () => {
    const { api } = fixture();
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/public-key', body: { v: 1, address: '0x456' } }))
      .resolves.toEqual({ status: 200, body: { publicKey: '0x99' } });
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 } }))
      .resolves.toMatchObject({ status: 200, body: { feeAmount: '6', feeToken: STRK } });
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/receipt', body: { v: 1, transactionHash: '0xaaa' } }))
      .resolves.toMatchObject({ status: 200, body: { transactionHash: '0xaaa' } });
    expect(JSON.stringify(api.metrics.snapshot())).not.toMatch(/0x456|0xaaa|publicKey|artifact/);
  });

  it('enforces a global aggregate rate limit without an IP key', async () => {
    const { api } = fixture({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 } }))
      .resolves.toMatchObject({ status: 200 });
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 } }))
      .resolves.toMatchObject({ status: 429 });
  });

  it('honours the global kill switch before touching a provider', async () => {
    const { api, rpc } = fixture({ globalEnabled: false });
    const call = vi.spyOn(rpc, 'getPoolConfig');
    await expect(api.handle({ method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 } }))
      .resolves.toMatchObject({ status: 503 });
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects a swap configuration that could delay or broaden the quote-bound route', () => {
    expect(() => fixture({
      routes: {
        transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false },
        unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false },
        swap: {
          enabled: true,
          maxRelayFee: 10n,
          maxQueueDelayMs: 500,
          quoteBound: false,
          allowedTokens: [],
          maxSlippageBps: 5_000,
        },
      },
    })).toThrow(/quote-bound/i);
  });
});
