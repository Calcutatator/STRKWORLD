import { describe, expect, it, vi } from 'vitest';
import {
  BackendApi,
  HmacAuthorizationCodec,
  MemoryAuthorizationCodec,
  validateServerActionRoute,
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
  let proofValidityBlocks = 450;
  const delays: number[] = [];
  const submitted: PreparedArtifact[] = [];
  const paymaster: PaymasterPort = {
    async buildFee() {
      return { token: STRK, recipient: FEE_RECIPIENT, amount: 7n };
    },
    async submit(input) {
      submitted.push(input.artifact);
      return { transactionHash: '0x5ab' };
    },
  };
  const rpc: PoolRpcPort = {
    async getPoolConfig() {
      return { feeAmount: 6n, feeToken: STRK, proofValidityBlocks, noteMaturityBlocks: 10 };
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
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: {
      transfer: {
        enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false,
        allowedTokens: [STRK, '0xabc'],
      },
      unshield: {
        enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false,
        allowedTokens: [STRK, '0xabc'],
      },
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
    config,
    paymaster,
    rpc,
    delays,
    submitted,
    setBlock(value: number) { block = value; },
    setProofValidityBlocks(value: number) { proofValidityBlocks = value; },
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
    await expect(api.handle({
      method: 'POST', path: '/v1/private/fees',
      body: { v: 1, route: 'transfer', feeToken: STRK, operationToken: '0xdead' },
    })).resolves.toMatchObject({ status: 400 });

    vi.spyOn(paymaster, 'buildFee').mockResolvedValue({ token: '0xdead', recipient: FEE_RECIPIENT, amount: 1n });
    await expect(fee(api)).rejects.toThrow();

    vi.mocked(paymaster.buildFee).mockResolvedValue({ token: STRK, recipient: FEE_RECIPIENT, amount: 11n });
    await expect(fee(api)).rejects.toThrow();

    const disabled = fixture({
      routes: {
        transfer: {
          enabled: false, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false,
          allowedTokens: [STRK, '0xabc'],
        },
        unshield: {
          enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 500, quoteBound: false,
          allowedTokens: [STRK, '0xabc'],
        },
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

  it('aborts a stalled upstream at the configured request deadline', async () => {
    const { api, paymaster } = fixture({ requestTimeoutMs: 1 });
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(paymaster, 'buildFee').mockImplementation(async (input) => {
      observedSignal = input.signal;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { token: STRK, recipient: FEE_RECIPIENT, amount: 7n };
    });

    await expect(api.handle({
      method: 'POST', path: '/v1/private/fees',
      body: { v: 1, route: 'transfer', feeToken: STRK, operationToken: '0xabc' },
    })).resolves.toMatchObject({ status: 504 });
    expect(observedSignal?.aborted).toBe(true);
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
    expect(response).toEqual({ status: 200, body: { transactionHash: '0x5ab' } });
    expect(delays).toEqual([250]);
    expect(submitted).toEqual([artifact]);
  });

  it('binds an unshield public withdrawal to the authorized token allowlist', async () => {
    const { api, submitted } = fixture();
    const quote = await fee(api, 'unshield');
    const makeArtifact = (withdrawToken: string): PreparedArtifact => {
      const calldata = [
        '0x2',
        '0x3', FEE_RECIPIENT, STRK, '0x7',
        '0x3', '0x456', withdrawToken, '0x14',
      ];
      return {
        call: { contract_address: POOL, entry_point: 'apply_actions', calldata },
        proof: { data: 'proof', output: ['0xc1', ...calldata], proof_facts: ['0x1'] },
      };
    };
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1, route: 'unshield', artifact: makeArtifact('0xabc'),
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 200 });
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1, route: 'unshield', artifact: makeArtifact('0xdead'),
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 400 });
    expect(submitted).toHaveLength(1);
  });

  it('rechecks the current token allowlist before relaying an issued authorization', async () => {
    const { api, config, submitted } = fixture();
    const quote = await fee(api);
    config.routes.transfer.allowedTokens = [STRK];

    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1, route: 'transfer', artifact,
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 401 });
    expect(submitted).toHaveLength(0);
  });

  it('uses the current pool proof-validity window after authorization issuance', async () => {
    const { api, setBlock, setProofValidityBlocks, submitted } = fixture();
    const quote = await fee(api);
    setProofValidityBlocks(1);
    setBlock(1_002);

    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1, route: 'transfer', artifact,
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 409 });
    expect(submitted).toHaveLength(0);
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
      '0xa', '0x999', `0x${invokeCalldata.length.toString(16)}`, ...invokeCalldata,
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
      '0xa', '0x999', `0x${invokeCalldata.length.toString(16)}`, ...invokeCalldata,
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
      '0xa', '0x999', '0x0',
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

  it('stops before relay when the aggregate sponsorship budget is exhausted', async () => {
    const { api, submitted } = fixture({
      sponsorshipBudget: { maxFeeAmount: 6n, windowMs: 60_000 },
    });
    const quote = await fee(api);
    await expect(api.handle({
      method: 'POST', path: '/v1/private/submissions',
      body: {
        v: 1,
        route: 'transfer',
        artifact,
        feeAuthorization: quote.authorization,
        proofValidityBlocks: 450,
      },
    })).resolves.toMatchObject({ status: 503 });
    expect(submitted).toHaveLength(0);
    expect(api.metrics.snapshot()).toMatchObject({ budgetExhausted: 1 });
  });

  it('bounds concurrent pool-native submissions and rejects overflow before relay', async () => {
    const { api, paymaster } = fixture({
      submissionQueue: { maxInFlight: 1, maxQueued: 1 },
    });
    const quote = await fee(api);
    let releaseFirst!: () => void;
    let submitCalls = 0;
    vi.spyOn(paymaster, 'submit').mockImplementation(async () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { transactionHash: `0x${submitCalls}` };
    });
    const request = {
      method: 'POST',
      path: '/v1/private/submissions',
      body: {
        v: 1, route: 'transfer', artifact,
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    } as const;

    const first = api.handle(request);
    await vi.waitFor(() => expect(submitCalls).toBe(1));
    const second = api.handle(request);
    const third = api.handle(request);
    const overflow = await third;
    releaseFirst();

    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(overflow).toMatchObject({ status: 503 });
    expect(submitCalls).toBe(2);
    expect(api.metrics.snapshot()).toMatchObject({ queueRejected: 1 });
  });

  it('rechecks proof freshness after a queued submission is admitted', async () => {
    const { api, paymaster, setBlock } = fixture({
      submissionQueue: { maxInFlight: 1, maxQueued: 1 },
    });
    const quote = await fee(api);
    let releaseFirst!: () => void;
    let submitCalls = 0;
    vi.spyOn(paymaster, 'submit').mockImplementation(async () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { transactionHash: `0x${submitCalls}` };
    });
    const request = {
      method: 'POST',
      path: '/v1/private/submissions',
      body: {
        v: 1, route: 'transfer', artifact,
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    } as const;

    const first = api.handle(request);
    await vi.waitFor(() => expect(submitCalls).toBe(1));
    const queued = api.handle(request);
    setBlock(1_451);
    releaseFirst();

    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(queued).resolves.toMatchObject({ status: 409 });
    expect(submitCalls).toBe(1);
  });

  it('honors a route kill switch while a submission is waiting in the queue', async () => {
    const { api, config, paymaster } = fixture({
      submissionQueue: { maxInFlight: 1, maxQueued: 1 },
    });
    const quote = await fee(api);
    let releaseFirst!: () => void;
    let submitCalls = 0;
    vi.spyOn(paymaster, 'submit').mockImplementation(async () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { transactionHash: `0x${submitCalls}` };
    });
    const request = {
      method: 'POST',
      path: '/v1/private/submissions',
      body: {
        v: 1, route: 'transfer', artifact,
        feeAuthorization: quote.authorization, proofValidityBlocks: 450,
      },
    } as const;

    const first = api.handle(request);
    await vi.waitFor(() => expect(submitCalls).toBe(1));
    const queued = api.handle(request);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    config.routes.transfer.enabled = false;
    releaseFirst();

    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(queued).resolves.toMatchObject({ status: 503 });
    expect(submitCalls).toBe(1);
  });
});

describe('quote-bound swap withdrawal matching', () => {
  const invokePrefix = ['0xabc'];
  const swapBinding = {
    executor: '0x999',
    sellToken: STRK,
    buyToken: '0xabc',
    sellAmount: 7n,
    quoteExpiresAt: 2_000,
    invokePrefix,
  };

  function swapArtifact(transfers: string[]): PreparedArtifact {
    const calldata = [
      '0x3',
      ...transfers,
      '0xa', '0x999', '0x2', ...invokePrefix, '0x777',
    ];
    return {
      call: { contract_address: POOL, entry_point: 'apply_actions', calldata },
      proof: { data: 'proof', output: ['0xc1', ...calldata], proof_facts: ['0x1'] },
    };
  }

  it('does not let one withdrawal satisfy both fee and sell while a second is arbitrary', () => {
    expect(() => validateServerActionRoute(
      'swap',
      swapArtifact([
        '0x3', '0x999', STRK, '0x7',
        '0x3', '0xdead', '0xbeef', '0x1',
      ]),
      { token: STRK, recipient: '0x999', amount: 7n },
      STRK,
      swapBinding,
    )).toThrow(/withdrawals/i);
  });

  it('accepts two separately assigned withdrawals even when their fields are identical', () => {
    expect(() => validateServerActionRoute(
      'swap',
      swapArtifact([
        '0x3', '0x999', STRK, '0x7',
        '0x3', '0x999', STRK, '0x7',
      ]),
      { token: STRK, recipient: '0x999', amount: 7n },
      STRK,
      swapBinding,
    )).not.toThrow();
  });

  it('accepts the current screening None suffix without treating it as proof output', () => {
    const screened = swapArtifact([
      '0x3', '0x999', STRK, '0x7',
      '0x3', '0x999', STRK, '0x7',
    ]);
    screened.call.calldata!.push('0x1');

    expect(() => validateServerActionRoute(
      'swap', screened,
      { token: STRK, recipient: '0x999', amount: 7n },
      STRK,
      swapBinding,
    )).not.toThrow();
  });

  it('rejects a deposit screening attestation on a non-deposit private route', () => {
    const screened = swapArtifact([
      '0x3', '0x999', STRK, '0x7',
      '0x3', '0x999', STRK, '0x7',
    ]);
    screened.call.calldata!.push('0x0', '0x64', '0x1', '0x2');

    expect(() => validateServerActionRoute(
      'swap', screened,
      { token: STRK, recipient: '0x999', amount: 7n },
      STRK,
      swapBinding,
    )).toThrow(/screening|deposit/i);
  });

  it('decodes the current five-felt open-note event before a swap invoke', () => {
    const transfers = [
      '0x3', '0x999', STRK, '0x7',
      '0x3', '0x999', STRK, '0x7',
    ];
    const calldata = [
      '0x4',
      ...transfers,
      '0x7', '0x11', '0x12', '0x13', '0xabc', '0x777',
      '0xa', '0x999', '0x2', ...invokePrefix, '0x777',
    ];

    expect(() => validateServerActionRoute(
      'swap', {
        call: { contract_address: POOL, entry_point: 'apply_actions', calldata },
        proof: { data: 'proof', output: ['0xc1', ...calldata], proof_facts: ['0x1'] },
      },
      { token: STRK, recipient: '0x999', amount: 7n },
      STRK,
      swapBinding,
    )).not.toThrow();
  });

  it('rejects a current-ABI computed invoke and a public deposit on private routes', () => {
    const computed = swapArtifact([
      '0x3', '0x999', STRK, '0x7',
      '0x3', '0x999', STRK, '0x7',
    ]);
    computed.call.calldata![computed.call.calldata!.indexOf('0xa')] = '0xb';
    computed.proof.output = ['0xc1', ...computed.call.calldata!];
    expect(() => validateServerActionRoute(
      'swap', computed,
      { token: STRK, recipient: '0x999', amount: 7n },
      STRK,
      swapBinding,
    )).toThrow(/computed|unauthorized|action/i);

    const depositCalldata = [
      '0x3',
      '0x2', '0x123', STRK, '0x1',
      '0x6', '0x123', STRK, '0x1',
      '0x3', FEE_RECIPIENT, STRK, '0x7',
    ];
    expect(() => validateServerActionRoute(
      'transfer', {
        call: { contract_address: POOL, entry_point: 'apply_actions', calldata: depositCalldata },
        proof: { data: 'proof', output: ['0xc1', ...depositCalldata], proof_facts: ['0x1'] },
      },
      { token: STRK, recipient: FEE_RECIPIENT, amount: 7n },
      STRK,
    )).toThrow(/deposit|unauthorized|action/i);
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

  it('rejects out-of-field Starknet values before touching RPC', async () => {
    const { api, rpc } = fixture();
    const publicKey = vi.spyOn(rpc, 'getPublicKey');
    await expect(api.handle({
      method: 'POST', path: '/v1/rpc/public-key',
      body: { v: 1, address: `0x${'f'.repeat(64)}` },
    })).resolves.toMatchObject({ status: 400 });
    expect(publicKey).not.toHaveBeenCalled();
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

  it('fixes pool-native routes as delayed and swaps as quote-bound and immediate', () => {
    const { config } = fixture();
    const invalidPolicies: Array<{
      route: keyof BackendConfig['routes'];
      changes: Partial<BackendConfig['routes']['transfer']>;
    }> = [
      { route: 'transfer', changes: { quoteBound: true } },
      { route: 'transfer', changes: { maxQueueDelayMs: 0 } },
      { route: 'unshield', changes: { quoteBound: true } },
      { route: 'unshield', changes: { maxQueueDelayMs: 0 } },
      { route: 'swap', changes: { quoteBound: false } },
      { route: 'swap', changes: { maxQueueDelayMs: 1 } },
    ];

    for (const { route, changes } of invalidPolicies) {
      expect(() => fixture({
        routes: {
          ...config.routes,
          [route]: { ...config.routes[route], ...changes },
        },
      }), `${route}: ${Object.keys(changes).join(', ')}`).toThrow(/route policy|quote-bound|immediate|delayed/i);
    }
  });

  it.each(['transfer', 'unshield'] as const)(
    'rejects a %s queue delay beyond the Node timer ceiling at direct construction',
    (route) => {
      const { config } = fixture();
      expect(() => fixture({
        routes: {
          ...config.routes,
          [route]: { ...config.routes[route], maxQueueDelayMs: 2_147_483_648 },
        },
      })).toThrow(`Backend ${route} policy has invalid limits.`);
    },
  );
});
