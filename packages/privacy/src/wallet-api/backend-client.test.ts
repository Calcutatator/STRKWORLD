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
