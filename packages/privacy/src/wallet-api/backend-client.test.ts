import { describe, expect, it, vi } from 'vitest';
import { BackendPrivacyClient } from './backend-client.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BackendPrivacyClient', () => {
  it('maps the JSON wire format into bigint privacy ports', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/rpc/pool-config')) {
        return response({ feeAmount: '6', feeToken: '0x4718', proofValidityBlocks: 450, noteMaturityBlocks: 10 });
      }
      return response({ token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 });
    });
    const client = new BackendPrivacyClient('https://backend.example/', fetcher);
    await expect(client.config()).resolves.toMatchObject({ feeAmount: 6n });
    await expect(client.estimate({ route: 'transfer', feeToken: '0x4718', operationToken: '0xabc' }))
      .resolves.toMatchObject({ amount: 7n, authorization: 'auth' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://backend.example/v1/private/fees',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps an unavailable backend without exposing a raw transport error', async () => {
    const client = new BackendPrivacyClient('https://backend.example', async () => response({ message: 'paused' }, 503));
    await expect(client.config()).rejects.toMatchObject({ kind: 'unreachable', message: 'paused' });
  });

  it('reports an accepted private hash before returning the submission receipt', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ transactionHash: '0xaccepted' }),
    );
    const onAccepted = vi.fn();

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
      onAccepted,
    })).resolves.toEqual({ transactionHash: '0xaccepted' });
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith({ transactionHash: '0xaccepted' });
  });

  it('parses a quote-bound private swap plan without losing bigint amounts', async () => {
    const fetcher = vi.fn(async () => response({
      quoteId: 'quote-1',
      buyAmount: '900719925474099312345',
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{
        contractAddress: '0x111',
        entrypoint: 'swap',
        selector: '0x555',
        calldata: ['0xaaa'],
      }],
      fee: {
        token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450,
      },
    }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);
    await expect(client.prepareSwap({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 90n,
      slippageBps: 100,
    })).resolves.toMatchObject({
      buyAmount: 900719925474099312345n,
      fee: { amount: 7n, authorization: 'auth' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://backend.example/v1/private/swaps/prepare',
      expect.objectContaining({ body: expect.stringContaining('"sellAmount":"20"') }),
    );
  });
});
