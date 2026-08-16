import { describe, expect, it, vi } from 'vitest';
import { AvnuPaymasterPort } from './avnu-paymaster.js';
import { AvnuSwapPlanner } from './avnu-swap-planner.js';
import { StarknetRpcPoolPort } from './starknet-rpc.js';
import type { PreparedArtifact } from './types.js';

const artifact: PreparedArtifact = {
  call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
  proof: { data: 'proof', output: ['0x2', '0x1'], proof_facts: ['0x3'] },
};

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
});

describe('fixed Starknet RPC adapter', () => {
  it('exposes pool config and public-key reads without accepting a client method', async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      requests.push(request);
      if (request.method === 'starknet_call') {
        const call = request.params[0] as { entry_point_selector: string; calldata: string[] };
        const result = call.calldata.length
          ? ['0x99']
          : call.entry_point_selector === '0x11d6d65b366023adbdaeaa04008285431f4509d78e78cda7067e58fbba35147'
            ? ['0x1c2']
            : ['0x6', '0x0'];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1000 }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });
    await expect(rpc.getPoolConfig()).resolves.toMatchObject({ feeAmount: 6n, proofValidityBlocks: 450 });
    await expect(rpc.getPublicKey('0x456')).resolves.toBe('0x99');
    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
    expect(requests.map((request) => request.method)).toEqual([
      'starknet_call', 'starknet_call', 'starknet_call', 'starknet_blockNumber',
    ]);
  });
});
