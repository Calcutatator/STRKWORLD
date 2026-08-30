import { describe, expect, it, vi } from 'vitest';
import { BackendPrivacyClient } from './backend-client.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BackendPrivacyClient', () => {
  it.each([
    ['config', (client: BackendPrivacyClient, signal: AbortSignal) => client.config(signal), {
      feeAmount: '6', feeToken: '0x4718', proofValidityBlocks: 450, noteMaturityBlocks: 10,
    }],
    ['public key', (client: BackendPrivacyClient, signal: AbortSignal) => client.publicKey('0x123', signal), {
      publicKey: '0x456',
    }],
    ['relay estimate', (client: BackendPrivacyClient, signal: AbortSignal) => client.estimate({
      route: 'transfer', feeToken: '0x4718', operationToken: '0xabc', signal,
    }), {
      token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450,
    }],
    ['swap preparation', (client: BackendPrivacyClient, signal: AbortSignal) => client.prepareSwap({
      sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, minAmountOut: 90n, slippageBps: 100, signal,
    }), {
      quoteId: 'quote-1', buyAmount: '100', expiresAt: 2_000, chainId: '0x534e5f4d41494e',
      executorAddress: '0x999', executorCalls: [],
      fee: { token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 },
    }],
  ] as const)('does not return a stale %s result when its transport ignores cancellation', async (_name, read, body) => {
    let resolveResponse!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);
    const controller = new AbortController();
    const reading = read(client, controller.signal);

    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    resolveResponse(response(body));

    await expect(reading).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('calls the default browser fetch with its required global receiver', async () => {
    const browserFetch = vi.fn(function (this: unknown, _url: string, _init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response({
        feeAmount: '6',
        feeToken: '0x4718',
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      }));
    });
    vi.stubGlobal('fetch', browserFetch);

    try {
      const client = new BackendPrivacyClient('/api');
      await expect(client.config()).resolves.toMatchObject({ feeAmount: 6n });
      expect(browserFetch).toHaveBeenCalledWith('/api/v1/rpc/pool-config', expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
      async () => response({ transactionHash: '0xabc123' }),
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
    })).resolves.toEqual({ transactionHash: '0xabc123' });
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith({ transactionHash: '0xabc123' });
  });

  it.each([
    ['zero', '0x0'],
    ['leading-zero zero', '0x000'],
    ['decimal', '123'],
    ['malformed hex', '0xaccepted'],
    ['field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
    ['above field', `0x${(STARK_FIELD_PRIME + 1n).toString(16)}`],
  ])('rejects a %s private submission hash before reporting acceptance', async (_label, transactionHash) => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ transactionHash }),
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
    })).rejects.toMatchObject({ kind: 'unknown' });
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it.each(['0x00Ab', '0xABC'])('accepts a valid nonzero submission felt %s', async (transactionHash) => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ transactionHash }),
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).resolves.toEqual({ transactionHash });
  });

  it('marks a lost private-submit response after dispatch as submission uncertainty', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => { throw new TypeError('response connection closed'); },
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'submission-uncertain' });
  });

  it('keeps a private submit failure before dispatch retryable', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      () => { throw new TypeError('request could not be dispatched'); },
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('marks a private-submit response stream loss as submission uncertainty', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"transactionHash":"0x'));
        controller.error(new TypeError('response stream terminated'));
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => new Response(body, { status: 200 }),
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'submission-uncertain' });
  });

  it('keeps a malformed private-submit response as an unknown protocol failure', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => new Response('{not-json', { status: 200 }),
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('keeps an explicit unavailable response from private submit retryable', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ message: 'submissions paused' }, 503),
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'unreachable', message: 'submissions paused' });
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
