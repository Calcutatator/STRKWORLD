import { describe, expect, it, vi } from 'vitest';
import { PrivacyError } from '../types.js';
import { BackendPrivacyClient } from './backend-client.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function objectResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function inheritResponseField(key: string, value: unknown): () => void {
  const prototype = Object.prototype as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(prototype, key);
  Object.defineProperty(prototype, key, { configurable: true, value });
  return () => {
    if (previous) Object.defineProperty(prototype, key, previous);
    else delete prototype[key];
  };
}

describe('BackendPrivacyClient', () => {
  it('does not invoke an accessor-backed response status during submission settlement', async () => {
    let getterCalled = false;
    const responseValue = {
      ok: false,
      json: async () => ({ message: 'rejected' }),
    };
    Object.defineProperty(responseValue, 'status', {
      get() {
        getterCalled = true;
        throw new Error('status getter must not run');
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => responseValue as unknown as Response,
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth', proofValidityBlocks: 450,
    })).rejects.toBeInstanceOf(PrivacyError);
    expect(getterCalled).toBe(false);
  });

  it('preserves submission uncertainty when an HTTP error body stream is lost', async () => {
    const client = new BackendPrivacyClient('https://backend.example', async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new TypeError('response stream terminated'); },
    }) as unknown as Response);

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

  it('rejects a blank backend base URL before dispatching transport', () => {
    const fetcher = vi.fn(async () => response({}));

    expect(() => new BackendPrivacyClient('   ', fetcher)).toThrow(/URL/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a non-string base URL before dispatching transport', () => {
    const fetcher = vi.fn(async () => response({}));

    expect(() => new BackendPrivacyClient(null as never, fetcher)).toThrow(/URL/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported route', { route: 'shield' }],
    ['empty authorization', { feeAuthorization: '' }],
    ['zero proof validity', { proofValidityBlocks: 0 }],
    ['fractional proof validity', { proofValidityBlocks: 1.5 }],
    ['null artifact', { artifact: null }],
  ] as const)('rejects an invalid private submission before transport: %s', async (_label, patch) => {
    const fetcher = vi.fn(async () => response({ transactionHash: '0x1' }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
      ...patch,
    } as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['decimal sell token', { sellToken: '123' }],
    ['zero buy token', { buyToken: '0x0' }],
    ['zero sell amount', { sellAmount: 0n }],
    ['number minimum output', { minAmountOut: 90 }],
    ['zero slippage', { slippageBps: 0 }],
    ['fractional slippage', { slippageBps: 1.5 }],
  ] as const)('rejects an invalid swap-prepare request before transport: %s', async (_label, patch) => {
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.prepareSwap({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 90n,
      slippageBps: 100,
      ...patch,
    } as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['decimal', '123'],
    ['zero', '0x0'],
    ['field-prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
  ])('rejects an invalid public-key address before transport: %s', async (_label, address) => {
    const fetcher = vi.fn(async () => response({ publicKey: '0x1' }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.publicKey(address)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported route', { route: 'swap', feeToken: '0x4718', operationToken: '0xabc' }],
    ['decimal fee token', { route: 'transfer', feeToken: '123', operationToken: '0xabc' }],
    ['zero operation token', { route: 'unshield', feeToken: '0x4718', operationToken: '0x0' }],
  ] as const)('rejects an invalid relay estimate request before transport: %s', async (_label, input) => {
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.estimate(input as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not dispatch a read already cancelled by its caller', async () => {
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);
    const controller = new AbortController();
    controller.abort(new DOMException('Panel closed.', 'AbortError'));

    await expect(client.config(controller.signal)).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves caller cancellation while a read transport is in flight', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    );
    const controller = new AbortController();
    const reading = client.config(controller.signal);

    controller.abort(new DOMException('Panel closed.', 'AbortError'));

    await expect(reading).rejects.toMatchObject({ kind: 'user-rejected' });
  });

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

  it('rejects a config field supplied only by the object prototype', async () => {
    const restore = inheritResponseField('feeAmount', '6');
    try {
      const client = new BackendPrivacyClient(
        'https://backend.example',
        async () => response({ feeToken: '0x4718', proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
      );

      await expect(client.config()).rejects.toMatchObject({ kind: 'unknown' });
    } finally {
      restore();
    }
  });

  it('rejects an accessor response field without invoking the getter', async () => {
    let getterCalled = false;
    const body = { feeToken: '0x4718', proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    Object.defineProperty(body, 'feeAmount', {
      configurable: true,
      get: () => {
        getterCalled = true;
        return '6';
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => objectResponse(body),
    );

    await expect(client.config()).rejects.toMatchObject({ kind: 'unknown' });
    expect(getterCalled).toBe(false);
  });

  it.each([
    ['negative proof-validity blocks', { proofValidityBlocks: -1, noteMaturityBlocks: 10 }],
    ['negative note-maturity blocks', { proofValidityBlocks: 450, noteMaturityBlocks: -1 }],
  ])('rejects %s from a pool configuration response', async (_label, blocks) => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ feeAmount: '6', feeToken: '0x4718', ...blocks }),
    );

    await expect(client.config()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('accepts zero note-maturity blocks', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ feeAmount: '6', feeToken: '0x4718', proofValidityBlocks: 1, noteMaturityBlocks: 0 }),
    );

    await expect(client.config()).resolves.toMatchObject({ proofValidityBlocks: 1, noteMaturityBlocks: 0 });
  });

  it.each([
    ['zero', '0', true],
    ['leading zeros', '006', true],
    ['maximum uint256', MAX_UINT256.toString(), true],
    ['whitespace', ' ', false],
    ['signed', '+6', false],
    ['fractional', '1.0', false],
    ['negative', '-1', false],
    ['above uint256', (MAX_UINT256 + 1n).toString(), false],
  ])('validates the pool fee amount as a uint256 (%s)', async (_label, feeAmount, valid) => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ feeAmount, feeToken: '0x4718', proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
    );

    if (valid) {
      await expect(client.config()).resolves.toMatchObject({ feeAmount: BigInt(feeAmount) });
    } else {
      await expect(client.config()).rejects.toMatchObject({ kind: 'unknown' });
    }
  });

  it.each([
    ['decimal', '123'],
    ['uppercase prefix', '0X7b'],
    ['field prime', STARK_FIELD_PRIME.toString(16).replace(/^/, '0x')],
  ])('rejects a noncanonical pool fee token (%s)', async (_label, feeToken) => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ feeAmount: '6', feeToken, proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
    );

    await expect(client.config()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['whitespace', ' '],
    ['signed', '+7'],
    ['fractional', '1.5'],
  ])('rejects a non-decimal relay estimate amount (%s)', async (_label, amount) => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ token: '0x4718', recipient: '0x789', amount, authorization: 'auth', expiresAtBlock: 1450 }),
    );

    await expect(client.estimate({ route: 'transfer', feeToken: '0x4718', operationToken: '0xabc' }))
      .rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects a public key supplied only by the object prototype', async () => {
    const restore = inheritResponseField('publicKey', '0x456');
    try {
      const client = new BackendPrivacyClient(
        'https://backend.example',
        async () => response({}),
      );

      await expect(client.publicKey('0x123')).rejects.toMatchObject({ kind: 'unknown' });
    } finally {
      restore();
    }
  });

  it('rejects a nested swap fee field supplied only by the object prototype', async () => {
    const restore = inheritResponseField('amount', '7');
    try {
      const client = new BackendPrivacyClient(
        'https://backend.example',
        async () => response({
          quoteId: 'quote-1',
          buyAmount: '100',
          expiresAt: 2_000,
          chainId: '0x534e5f4d41494e',
          executorAddress: '0x999',
          executorCalls: [],
          fee: { token: '0x4718', recipient: '0x789', authorization: 'auth', expiresAtBlock: 1450 },
        }),
      );

      await expect(client.prepareSwap({
        sellToken: '0xabc',
        buyToken: '0x4718',
        sellAmount: 20n,
        minAmountOut: 90n,
        slippageBps: 100,
      })).rejects.toMatchObject({ kind: 'unknown' });
    } finally {
      restore();
    }
  });

  it('rejects a nested swap call field supplied only by the object prototype', async () => {
    const restore = inheritResponseField('entrypoint', 'swap');
    try {
      const client = new BackendPrivacyClient(
        'https://backend.example',
        async () => response({
          quoteId: 'quote-1',
          buyAmount: '100',
          expiresAt: 2_000,
          chainId: '0x534e5f4d41494e',
          executorAddress: '0x999',
          executorCalls: [{ contractAddress: '0x111', calldata: ['0xaaa'] }],
          fee: {
            token: '0x4718',
            recipient: '0x789',
            amount: '7',
            authorization: 'auth',
            expiresAtBlock: 1450,
          },
        }),
      );

      await expect(client.prepareSwap({
        sellToken: '0xabc',
        buyToken: '0x4718',
        sellAmount: 20n,
        minAmountOut: 90n,
        slippageBps: 100,
      })).rejects.toMatchObject({ kind: 'unknown' });
    } finally {
      restore();
    }
  });

  it.each(['executorCalls', 'calldata'] as const)('rejects a sparse %s response array', async (field) => {
    const call = { contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] };
    const body = {
      quoteId: 'quote-1',
      buyAmount: '100',
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [call],
      fee: {
        token: '0x4718',
        recipient: '0x789',
        amount: '7',
        authorization: 'auth',
        expiresAtBlock: 1450,
      },
    } as { executorCalls: unknown[]; fee: Record<string, unknown> };
    if (field === 'executorCalls') body.executorCalls = new Array(1);
    else (body.executorCalls[0] as { calldata: unknown[] }).calldata = new Array(1);
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => objectResponse(body),
    );

    await expect(client.prepareSwap({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 90n,
      slippageBps: 100,
    })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects an empty swap quote identifier', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({
        quoteId: '', buyAmount: '100', expiresAt: 2_000,
        chainId: '0x534e5f4d41494e', executorAddress: '0x999', executorCalls: [],
        fee: { token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 },
      }),
    );
    await expect(client.prepareSwap({ sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, minAmountOut: 90n, slippageBps: 100 }))
      .rejects.toMatchObject({ kind: 'unknown' });
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

  it('publishes an immutable pool configuration', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({
        feeAmount: '6', feeToken: '0x4718', proofValidityBlocks: 450, noteMaturityBlocks: 10,
      }),
    );

    const config = await client.config();

    expect(Object.isFrozen(config)).toBe(true);
    expect(Reflect.set(config, 'feeAmount', 0n)).toBe(false);
    expect(config.feeAmount).toBe(6n);
    expect(config.proofValidityBlocks).toBe(450);
  });

  it('publishes an immutable relay fee quote', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({
        token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450,
      }),
    );

    const quote = await client.estimate({
      route: 'transfer', feeToken: '0x4718', operationToken: '0xabc',
    });

    expect(Object.isFrozen(quote)).toBe(true);
    expect(Reflect.set(quote, 'authorization', 'forged')).toBe(false);
    expect(quote.authorization).toBe('auth');
    expect(quote.amount).toBe(7n);
  });

  it('maps an unavailable backend without exposing a raw transport error', async () => {
    const client = new BackendPrivacyClient('https://backend.example', async () => response({ message: 'paused' }, 503));
    await expect(client.config()).rejects.toMatchObject({ kind: 'unreachable', message: 'paused' });
  });

  it('does not invoke an accessor-backed backend error message', async () => {
    let getterCalled = false;
    const failure = {} as { message?: string };
    Object.defineProperty(failure, 'message', {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error('backend error getter must not run');
      },
    });
    const client = new BackendPrivacyClient('https://backend.example', async () => ({
      ok: false,
      status: 400,
      json: async () => failure,
    }) as Response);

    await expect(client.config()).rejects.toMatchObject({ kind: 'unknown' });
    expect(getterCalled).toBe(false);
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

  it('does not let an acceptance observer rewrite the returned private receipt', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ transactionHash: '0xabc123' }),
    );
    let observed: { transactionHash: string } | undefined;

    const receipt = await client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
      onAccepted(result) {
        observed = result;
        Reflect.set(result, 'transactionHash', '0xdef456');
      },
    });

    expect(receipt).toBe(observed);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt.transactionHash).toBe('0xabc123');
  });

  it('does not let an acceptance observer failure hide an accepted receipt', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({ transactionHash: '0xabc123' }),
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
      onAccepted() {
        throw new Error('observer failed');
      },
    })).resolves.toEqual({ transactionHash: '0xabc123' });
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

  it('preserves submission uncertainty when caller cancellation races a lost response', async () => {
    let rejectResponse!: (reason?: unknown) => void;
    const client = new BackendPrivacyClient(
      'https://backend.example',
      () => new Promise<Response>((_resolve, reject) => { rejectResponse = reject; }),
    );
    const controller = new AbortController();
    const submitting = client.submit({
      route: 'transfer',
      artifact: {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
      signal: controller.signal,
    });

    controller.abort(new DOMException('Panel closed.', 'AbortError'));
    rejectResponse(new TypeError('response connection closed'));

    await expect(submitting).rejects.toMatchObject({ kind: 'submission-uncertain' });
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

  it('rejects a zero private swap output before publishing a plan', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({
        quoteId: 'quote-1', buyAmount: '0', expiresAt: 2_000,
        chainId: '0x534e5f4d41494e', executorAddress: '0x999', executorCalls: [],
        fee: { token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 },
      }),
    );

    await expect(client.prepareSwap({
      sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, minAmountOut: 1n, slippageBps: 100,
    })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('publishes an immutable private swap plan graph', async () => {
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response({
        quoteId: 'quote-1', buyAmount: '100', expiresAt: 2_000,
        chainId: '0x534e5f4d41494e', executorAddress: '0x999',
        executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
        fee: { token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 },
      }),
    );

    const plan = await client.prepareSwap({
      sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, minAmountOut: 90n, slippageBps: 100,
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.executorCalls)).toBe(true);
    expect(Object.isFrozen(plan.executorCalls[0])).toBe(true);
    expect(Object.isFrozen(plan.executorCalls[0]?.calldata)).toBe(true);
    expect(Object.isFrozen(plan.fee)).toBe(true);
    expect(Reflect.set(plan.executorCalls[0]!, 'entrypoint', 'forged')).toBe(false);
    expect(plan.executorCalls[0]?.entrypoint).toBe('swap');
  });

  it.each([
    ['buy amount', (body: Record<string, unknown>) => ({ ...body, buyAmount: '1.5' })],
    ['buy amount with whitespace', (body: Record<string, unknown>) => ({ ...body, buyAmount: ' 100' })],
    ['buy amount with sign', (body: Record<string, unknown>) => ({ ...body, buyAmount: '+100' })],
    ['buy amount with hex syntax', (body: Record<string, unknown>) => ({ ...body, buyAmount: '0x64' })],
    ['fee amount', (body: Record<string, unknown>) => ({
      ...body,
      fee: { ...(body.fee as Record<string, unknown>), amount: '1.5' },
    })],
    ['fee amount with whitespace', (body: Record<string, unknown>) => ({
      ...body,
      fee: { ...(body.fee as Record<string, unknown>), amount: ' 7' },
    })],
    ['fee amount with sign', (body: Record<string, unknown>) => ({
      ...body,
      fee: { ...(body.fee as Record<string, unknown>), amount: '+7' },
    })],
    ['fee amount with hex syntax', (body: Record<string, unknown>) => ({
      ...body,
      fee: { ...(body.fee as Record<string, unknown>), amount: '0x7' },
    })],
  ])('maps malformed swap %s into a generic privacy error', async (_label, mutate) => {
    const body = {
      quoteId: 'quote-1',
      buyAmount: '100',
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [],
      fee: { token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 },
    };
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => response(mutate(body)),
    );

    await expect(client.prepareSwap({
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      minAmountOut: 90n,
      slippageBps: 100,
    })).rejects.toMatchObject({ kind: 'unknown' });
  });
});
