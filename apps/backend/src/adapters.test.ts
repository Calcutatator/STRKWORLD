import { describe, expect, it, vi } from 'vitest';
import { AvnuPaymasterPort } from './avnu-paymaster.js';
import { AvnuSwapPlanner } from './avnu-swap-planner.js';
import { StarknetRpcPoolPort } from './starknet-rpc.js';
import type { PreparedArtifact } from './types.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

const artifact: PreparedArtifact = {
  call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
  proof: { data: 'proof', output: ['0x2', '0x1'], proof_facts: ['0x3'] },
};

function directResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response;
}

describe('AVNU paymaster adapter', () => {
  it('maps the Wallet API artifact to sponsored_private without an account signer', async () => {
    const buildFee = vi.fn(async () => ({ token: '0x4718', recipient: '0x789', amount: 7n }));
    const submit = vi.fn(async () => ({ transactionHash: '0xsubmitted' }));
    const port = new AvnuPaymasterPort({
      apiKey: 'server-only',
      functions: { buildFee: buildFee as never, submit: submit as never },
    });
    await port.buildFee({ route: 'transfer', poolAddress: '0x123', feeToken: '0x4718', operationToken: '0xabc' });
    await port.submit({
      route: 'transfer',
      artifact,
      fee: { token: '0x4718', recipient: '0x789', amount: 7n },
    });
    expect(buildFee).toHaveBeenCalledWith(
      expect.objectContaining({ poolAddress: '0x123', feeMode: { poolFeeToken: '0x4718' }, paymasterApiKey: 'server-only' }),
      {},
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        callAndProof: {
          call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
          proof: { data: 'proof', proofFacts: ['0x3'] },
        },
      }),
      {},
    );
  });
});

describe('AVNU private swap planner', () => {
  it('selects an exact-input mainnet quote and asks AVNU for private executor calls', async () => {
    const getQuotes = vi.fn(async () => [{
      quoteId: 'quote-1',
      sellTokenAddress: '0xabc',
      buyTokenAddress: '0x4718',
      sellAmount: 20n,
      buyAmount: 95n,
      expiry: 2,
      chainId: '0x534e5f4d41494e',
    }]);
    const quoteToCalls = vi.fn(async () => ({
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      calls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
    }));
    const toPaymasterCall = vi.fn(() => ({ to: '0x111', selector: '0x555', calldata: ['0xaaa'] }));
    const planner = new AvnuSwapPlanner({
      chainId: '0x534e5f4d41494e',
      now: () => 1_000,
      functions: {
        getQuotes: getQuotes as never,
        quoteToCalls: quoteToCalls as never,
        toPaymasterCall: toPaymasterCall as never,
      },
    });
    await expect(planner.prepare({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 90n,
      slippageBps: 100,
    })).resolves.toMatchObject({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      executorAddress: '0x999',
      executorCalls: [{ selector: '0x555', calldata: ['0xaaa'] }],
    });
    expect(quoteToCalls).toHaveBeenCalledWith(
      { quoteId: 'quote-1', slippage: 0.01, private: true },
      undefined,
    );
  });

  it('rejects a quote below the requested minimum before call construction', async () => {
    const quoteToCalls = vi.fn();
    const planner = new AvnuSwapPlanner({
      chainId: '0x534e5f4d41494e',
      now: () => 2_000,
      functions: {
        getQuotes: vi.fn(async () => [{
          quoteId: 'quote-1',
          sellTokenAddress: '0xabc',
          buyTokenAddress: '0x4718',
          sellAmount: 20n,
          buyAmount: 89n,
          expiry: 1,
          chainId: '0x534e5f5345504f4c4941',
        }]) as never,
        quoteToCalls: quoteToCalls as never,
        toPaymasterCall: vi.fn() as never,
      },
    });
    await expect(planner.prepare({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 90n,
      slippageBps: 100,
    })).rejects.toThrow(/no quote/i);
    expect(quoteToCalls).not.toHaveBeenCalled();
  });

  it('rejects a quote whose protected minimum is below the requested minimum', async () => {
    const quoteToCalls = vi.fn();
    const planner = new AvnuSwapPlanner({
      chainId: '0x534e5f4d41494e',
      now: () => 1_000,
      functions: {
        getQuotes: vi.fn(async () => [{
          quoteId: 'quote-protected-floor',
          sellTokenAddress: '0xabc',
          buyTokenAddress: '0x4718',
          sellAmount: 20n,
          buyAmount: 100n,
          expiry: 2,
          chainId: '0x534e5f4d41494e',
        }]) as never,
        quoteToCalls: quoteToCalls as never,
        toPaymasterCall: vi.fn() as never,
      },
    });
    await expect(planner.prepare({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 100n,
      slippageBps: 100,
    })).rejects.toThrow(/no quote/i);
    expect(quoteToCalls).not.toHaveBeenCalled();
  });

  it('uses AVNU bigint rounding for the protected minimum and accepts its exact boundary', async () => {
    const quoteToCalls = vi.fn(async () => ({
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      calls: [],
    }));
    const planner = new AvnuSwapPlanner({
      chainId: '0x534e5f4d41494e',
      now: () => 1_000,
      functions: {
        getQuotes: vi.fn(async () => [{
          quoteId: 'quote-rounding',
          sellTokenAddress: '0xabc',
          buyTokenAddress: '0x4718',
          sellAmount: 20n,
          buyAmount: 101n,
          expiry: 2,
          chainId: '0x534e5f4d41494e',
        }]) as never,
        quoteToCalls: quoteToCalls as never,
        toPaymasterCall: vi.fn() as never,
      },
    });
    await expect(planner.prepare({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 100n,
      slippageBps: 100,
    })).resolves.toMatchObject({ buyAmount: 101n });
    expect(quoteToCalls).toHaveBeenCalledTimes(1);
  });
});

describe('fixed Starknet RPC adapter', () => {
  it('exposes pool config and public-key reads without accepting a client method', async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      requests.push(request);
      if (request.method === 'starknet_call') {
        const call = request.params[0] as { entry_point_selector: string; calldata: string[] };
        const result = call.calldata.length
          ? ['0x99']
          : call.entry_point_selector === '0x11d6d65b366023adbdaeaa04008285431f4509d78e78cda7067e58fbba35147'
            ? ['0x1c2']
            : ['0x6', '0x0'];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 1000 }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });
    await expect(rpc.getPoolConfig()).resolves.toMatchObject({ feeAmount: 6n, proofValidityBlocks: 450 });
    await expect(rpc.getPublicKey('0x456')).resolves.toBe('0x99');
    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
    expect(requests.map((request) => request.method)).toEqual([
      'starknet_call', 'starknet_call', 'starknet_call', 'starknet_blockNumber',
    ]);
  });

  it.each([
    ['wrong jsonrpc version', { jsonrpc: '1.0', id: 1, result: 1000 }],
    ['mismatched id', { jsonrpc: '2.0', id: 99, result: 1000 }],
    ['batch response', [{ jsonrpc: '2.0', id: 1, result: 1000 }]],
    ['result and null error', { jsonrpc: '2.0', id: 1, result: 1000, error: null }],
    ['result and false error', { jsonrpc: '2.0', id: 1, result: 1000, error: false }],
    ['result and zero error', { jsonrpc: '2.0', id: 1, result: 1000, error: 0 }],
    ['result and empty error', { jsonrpc: '2.0', id: 1, result: 1000, error: '' }],
  ])('rejects a malformed JSON-RPC envelope: %s', async (_label, payload) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload)));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).rejects.toThrow(/rpc returned an (error|invalid response)/i);
  });

  it('accepts a valid result envelope with a JSON-RPC extension member', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: 1000, providerTraceId: 'opaque-extension',
    })));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
  });

  it('preserves an abort while reading the JSON-RPC response body', async () => {
    const abort = new DOMException('request aborted', 'AbortError');
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => { throw abort; },
    } as unknown as Response));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).rejects.toBe(abort);
  });

  it('wraps safe numeric request ids without colliding with an in-flight request', async () => {
    const ids: number[] = [];
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const firstRelease = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      ids.push(id);
      if (ids.length === 1) {
        started();
        await firstRelease;
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: 1000 }));
    });
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });
    Reflect.set(rpc, 'id', Number.MAX_SAFE_INTEGER);
    const first = rpc.getBlockNumber();
    await firstStarted;
    Reflect.set(rpc, 'id', Number.MAX_SAFE_INTEGER);
    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
    release();
    await expect(first).resolves.toBe(1000);
    expect(ids).toEqual([1, 2]);
    expect(ids.every((id) => Number.isSafeInteger(id) && id > 0)).toBe(true);
  });

  it('releases allocated ids after fetch, response-read, and successful completion', async () => {
    const ids: number[] = [];
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      ids.push(id);
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      if (calls === 3) {
        const abort = new DOMException('response aborted', 'AbortError');
        return {
          ok: true,
          json: async () => { throw abort; },
        } as unknown as Response;
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: 1000 }));
    });
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    Reflect.set(rpc, 'id', Number.MAX_SAFE_INTEGER);
    await expect(rpc.getBlockNumber()).rejects.toThrow('fetch failed');
    Reflect.set(rpc, 'id', Number.MAX_SAFE_INTEGER);
    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
    Reflect.set(rpc, 'id', Number.MAX_SAFE_INTEGER);
    await expect(rpc.getBlockNumber()).rejects.toMatchObject({ name: 'AbortError' });
    Reflect.set(rpc, 'id', Number.MAX_SAFE_INTEGER);
    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
    expect(ids).toEqual([1, 1, 1, 1]);
  });

  it.each([
    ['null', 'null'],
    ['malformed JSON', '{not-json'],
    ['missing result and error', JSON.stringify({ jsonrpc: '2.0', id: 1 })],
    ['null error without result', JSON.stringify({ jsonrpc: '2.0', id: 1, error: null })],
  ])('rejects a non-response JSON-RPC payload: %s', async (_label, payload) => {
    const fetcher = vi.fn(async () => new Response(payload));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).rejects.toThrow(/rpc returned an (error|invalid response)/i);
  });

  it.each([
    ['inherited jsonrpc', Object.assign(Object.create({ jsonrpc: '2.0' }), { id: 1, result: 1000 })],
    ['accessor id', Object.defineProperty({ jsonrpc: '2.0', result: 1000 }, 'id', { get: () => 1 })],
    ['accessor result', Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'result', { get: () => 1000 })],
    ['accessor error', Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'error', {
      get: () => ({ code: -1, message: 'provider failure' }),
    })],
  ])('rejects a JSON-RPC envelope with a non-data or inherited field: %s', async (_label, payload) => {
    const fetcher = vi.fn(async () => directResponse(payload));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).rejects.toThrow(/rpc returned an invalid response/i);
  });

  it('rejects a truthy JSON-RPC error envelope without exposing provider details', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'secret provider detail' },
    })));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).rejects.toThrow(/rpc returned an error/i);
  });

  it('rejects a negative Starknet block number', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: -1,
    })));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getBlockNumber()).rejects.toThrow(/invalid block number/i);
  });

  it.each([
    ['empty', []],
    ['multiple', ['0x0', '0x1']],
    ['non-felt', ['123']],
    ['field-prime', [`0x${STARK_FIELD_PRIME.toString(16)}`]],
  ])('rejects a malformed get_public_key %s result', async (_label, result) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result,
    })));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getPublicKey('0x456')).rejects.toThrow(/invalid public key/i);
  });

  it.each(['0x0', '0x00', '0x0001'])('preserves valid get_public_key felt %s', async (key) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: [key],
    })));
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getPublicKey('0x456')).resolves.toBe(key);
  });

  it.each([
    ['negative', '-1'],
    ['decimal', '123'],
    ['outside u128', `0x1${'0'.repeat(32)}`],
    ['field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
  ])('rejects a malformed %s pool fee word', async (_label, malformed) => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      const result = call === 1 ? [malformed, '0x0'] : ['0x1c2'];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call, result }));
    });
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getPoolConfig()).rejects.toThrow(/invalid fee amount/i);
  });

  it.each([
    ['decimal', '123'],
    ['negative', '-1'],
    ['field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
    ['above the field', `0x${(STARK_FIELD_PRIME + 1n).toString(16)}`],
    ['above the safe integer bound', `0x${(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(16)}`],
  ])('rejects a malformed %s proof-validity result', async (_label, malformed) => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      const result = call === 1 ? ['0x6', '0x0'] : [malformed];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call, result }));
    });
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getPoolConfig()).rejects.toThrow(/invalid proof-validity/i);
  });

  it.each([
    ['missing', []],
    ['extra', ['0x1c2', '0x0']],
  ])('rejects a %s proof-validity result', async (_label, malformed) => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      const result = call++ === 0 ? ['0x6', '0x0'] : malformed;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call, result }));
    });
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher,
    });

    await expect(rpc.getPoolConfig()).rejects.toThrow(/invalid proof-validity/i);
  });
});
