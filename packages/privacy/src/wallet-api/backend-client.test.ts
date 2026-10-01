import { describe, expect, it, vi } from 'vitest';
import { PrivacyError } from '../types.js';
import { MAX_VAULT_MARKETS } from '../vault.js';
import { BackendPrivacyClient } from './backend-client.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
/** The backend's answer to a swap quote (D-084), as JSON carries it. */
const QUOTE_BODY = Object.freeze({
  quoteId: 'quote-1',
  chainId: '0x534e5f4d41494e',
  sellToken: '0xabc',
  buyToken: '0x4718',
  sellAmount: '20',
  buyAmount: '100',
  calls: [{ contractAddress: '0x4270', entrypoint: 'multi_route_swap', calldata: ['0xabc', '0x14'] }],
});
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
  it('owns response metadata and body reader from one prototype snapshot', async () => {
    const admittedPrototype = {
      ok: false,
      status: 400,
      json: async () => ({ message: 'admitted rejection' }),
    };
    const substitutedPrototype = {
      ok: false,
      status: 400,
      json: async () => ({ message: 'substituted rejection' }),
    };
    let prototypeReads = 0;
    const responseValue = new Proxy(Object.create(admittedPrototype), {
      getPrototypeOf() {
        prototypeReads += 1;
        return prototypeReads <= 2 ? admittedPrototype : substitutedPrototype;
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => responseValue as Response,
    );

    await expect(client.config()).rejects.toMatchObject({
      kind: 'unknown', message: 'admitted rejection',
    });
    expect(prototypeReads).toBe(2);
  });

  it('owns response ok and status from one prototype before error classification', async () => {
    const acceptedPrototype = {
      ok: false,
      status: 400,
      json: async () => ({ message: 'rejected' }),
    };
    const substitutedPrototype = {
      ok: false,
      status: 503,
      json: async () => ({ message: 'rejected' }),
    };
    let prototypeReads = 0;
    const responseValue = new Proxy(Object.create(acceptedPrototype), {
      getPrototypeOf() {
        prototypeReads += 1;
        return prototypeReads <= 2 ? acceptedPrototype : substitutedPrototype;
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => responseValue as Response,
    );

    await expect(client.config()).rejects.toMatchObject({ kind: 'unknown', message: 'rejected' });
    expect(prototypeReads).toBe(2);
  });

  it('owns submission artifact data before JSON serialization can substitute it', async () => {
    const fetcher = vi.fn(async () => response({ transactionHash: '0xabc123' }));
    const call = {
      contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'],
    };
    let callReads = 0;
    const artifact = new Proxy({
      call,
      proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
    }, {
      get(target, key, receiver) {
        if (key === 'call') {
          callReads += 1;
          return { contractAddress: '0x999', entrypoint: 'forged', calldata: ['0x9'] };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await client.submit({ route: 'transfer', artifact, feeAuthorization: 'auth', proofValidityBlocks: 450 });

    const dispatched = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(dispatched[1].body))).toMatchObject({
      artifact: { call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] } },
    });
    expect(callReads).toBe(0);
  });

  // starknet.js 10.8 (D-077) converts the wallet's snake_case call into a
  // starknet.js `Call`; the relay and avnu's paymaster take the Wallet API's
  // own shape, so the client converts it back, and refuses anything else.
  it('posts the proved call in the Wallet API wire shape the relay validates', async () => {
    const fetcher = vi.fn(async () => response({ transactionHash: '0xabc123' }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);
    const proof = { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] };

    await client.submit({
      route: 'unshield',
      artifact: { call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1', '0x2'] }, proof },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    });

    const dispatched = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(dispatched[1].body)).artifact).toEqual({
      call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1', '0x2'] },
      proof,
    });
  });

  it.each([
    ['the pre-10.8 snake_case call', { call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] } }],
    ['a call with an extra field', { call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'], extra: '0x1' } }],
    ['a call without calldata', { call: { contractAddress: '0x123', entrypoint: 'apply_actions', data: ['0x1'] } }],
    ['a numeric target', { call: { contractAddress: 291, entrypoint: 'apply_actions', calldata: ['0x1'] } }],
    ['an extra artifact field', { signature: ['0x1'] }],
  ] as const)('refuses %s before transport', async (_label, patch) => {
    const fetcher = vi.fn(async () => response({ transactionHash: '0x1' }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
        ...patch,
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    } as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('invokes an injected transport without granting the client as receiver', async () => {
    let receiver: unknown = 'unset';
    const fetcher = async function (this: unknown): Promise<Response> {
      receiver = this;
      return response({ publicKey: '0x123' });
    };
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.publicKey('0xabc')).resolves.toBe('0x123');
    expect(receiver).toBeUndefined();
  });

  it('owns submission request fields before a caller proxy can substitute them', async () => {
    const fetcher = vi.fn(async () => response({ transactionHash: '0xabc123' }));
    const source = {
      route: 'transfer' as const,
      artifact: {
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    };
    let routeReads = 0;
    const input = new Proxy(source, {
      get(target, key, receiver) {
        if (key === 'route') {
          routeReads += 1;
          return routeReads === 1 ? 'transfer' : 'swap';
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await client.submit(input);

    const dispatched = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(dispatched[1].body))).toMatchObject({ route: 'transfer' });
    expect(routeReads).toBe(0);
  });

  it('owns estimate request fields before a caller proxy can substitute them', async () => {
    const fetcher = vi.fn(async () => response({
      token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450,
    }));
    const source = { route: 'transfer' as const, feeToken: '0x4718', operationToken: '0xabc' };
    let routeReads = 0;
    const input = new Proxy(source, {
      get(target, key, receiver) {
        if (key === 'route') {
          routeReads += 1;
          return routeReads === 1 ? 'transfer' : 'unshield';
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await client.estimate(input);

    const dispatched = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(dispatched[1].body))).toMatchObject({ route: 'transfer' });
    expect(routeReads).toBe(0);
  });

  it('owns the response body reader before a proxy can substitute it', async () => {
    const source = {
      ok: true,
      status: 200,
      json: async () => ({ publicKey: '0x123' }),
    };
    let reads = 0;
    const responseValue = new Proxy(source, {
      get(target, key, receiver) {
        if (key === 'json') {
          reads += 1;
          return async () => ({ publicKey: '0x999' });
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => responseValue as unknown as Response,
    );

    await expect(client.publicKey('0xabc')).resolves.toBe('0x123');
    expect(reads).toBe(0);
  });

  it('does not invoke an accessor-backed response ok flag after submission dispatch', async () => {
    let getterCalled = false;
    const responseValue = { status: 200, json: async () => ({ transactionHash: '0xabc123' }) };
    Object.defineProperty(responseValue, 'ok', {
      get() {
        getterCalled = true;
        throw new Error('ok getter must not run');
      },
    });
    const client = new BackendPrivacyClient(
      'https://backend.example',
      async () => responseValue as unknown as Response,
    );

    await expect(client.submit({
      route: 'transfer',
      artifact: {
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth', proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'unknown' });
    expect(getterCalled).toBe(false);
  });

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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
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

  it.each([
    ['relay estimate', (client: BackendPrivacyClient, signal: AbortSignal) => client.estimate({
      route: 'transfer', feeToken: '0x4718', operationToken: '0xabc', signal,
    })],
    ['private submission', (client: BackendPrivacyClient, signal: AbortSignal) => client.submit({
      route: 'transfer',
      artifact: {
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
      signal,
    })],
    ['swap quote', (client: BackendPrivacyClient, signal: AbortSignal) => client.quoteSwap({
      sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, taker: '0x5ad0', slippageBps: 100, signal,
    })],
  ] as const)('accepts a genuine cross-realm-like AbortSignal for %s', async (_label, invoke) => {
    const native = new AbortController().signal;
    const prototype = {};
    for (const key of ['aborted', 'reason', 'addEventListener', 'removeEventListener'] as const) {
      const value = key === 'addEventListener' || key === 'removeEventListener'
        ? native[key].bind(native)
        : native[key];
      Object.defineProperty(prototype, key, { enumerable: true, value });
    }
    const signal = Object.create(prototype) as AbortSignal;
    const fetcher = vi.fn(async (url: string) => response(url.endsWith('/fees')
      ? { token: '0x4718', recipient: '0x789', amount: '7', authorization: 'auth', expiresAtBlock: 1450 }
      : url.endsWith('/submissions')
        ? { transactionHash: '0xabc123' }
        : QUOTE_BODY));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(invoke(client, signal)).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing listener', { aborted: false, reason: undefined, removeEventListener: () => undefined }],
    ['wrong aborted type', {
      aborted: 'false', reason: undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    }],
  ] as const)('rejects a malformed structural AbortSignal before transport: %s', async (_label, signal) => {
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.estimate({
      route: 'transfer', feeToken: '0x4718', operationToken: '0xabc', signal: signal as never,
    })).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed AbortSignal fields without invoking them', async () => {
    let getterRead = false;
    const signal = {
      reason: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    Object.defineProperty(signal, 'aborted', {
      get() {
        getterRead = true;
        return false;
      },
    });
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.quoteSwap({
      sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, taker: '0x5ad0',
      slippageBps: 100, signal: signal as never,
    })).rejects.toMatchObject({ kind: 'unknown' });
    expect(getterRead).toBe(false);
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
    ['swap quote', (client: BackendPrivacyClient, signal: AbortSignal) => client.quoteSwap({
      sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, taker: '0x5ad0', slippageBps: 100, signal,
    }), QUOTE_BODY],
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
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
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    })).rejects.toMatchObject({ kind: 'unreachable', message: 'submissions paused' });
  });

  describe('a relay with no avnu key (D-070)', () => {
    const refused = { code: 'RELAY_NOT_CONFIGURED', message: 'The private relay is not configured on this deployment.' };
    const submission: Parameters<BackendPrivacyClient['submit']>[0] = {
      route: 'unshield',
      artifact: {
        call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      },
      feeAuthorization: 'auth',
      proofValidityBlocks: 450,
    };

    it('is its own failure kind on every relayed call, never unreachable or uncertain', async () => {
      const client = new BackendPrivacyClient('https://backend.example', async () => response(refused, 503));
      const expected = { kind: 'relay-not-configured', message: refused.message };
      await expect(client.estimate({ route: 'unshield', feeToken: '0x4718', operationToken: '0x4718' }))
        .rejects.toMatchObject(expected);
      await expect(client.submit(submission)).rejects.toMatchObject(expected);
      await expect(client.submit(submission)).rejects.toBeInstanceOf(PrivacyError);
    });

    it('needs both the 503 and the code, so nothing else is reclassified', async () => {
      const disabled = new BackendPrivacyClient(
        'https://backend.example',
        async () => response({ code: 'SERVICE_DISABLED', message: 'Private operations are temporarily disabled.' }, 503),
      );
      await expect(disabled.submit(submission)).rejects.toMatchObject({ kind: 'unreachable' });
      const otherStatus = new BackendPrivacyClient('https://backend.example', async () => response(refused, 500));
      await expect(otherStatus.estimate({ route: 'unshield', feeToken: '0x4718', operationToken: '0x4718' }))
        .rejects.toMatchObject({ kind: 'unknown' });
      const noMessage = new BackendPrivacyClient(
        'https://backend.example',
        async () => response({ code: 'RELAY_NOT_CONFIGURED' }, 503),
      );
      await expect(noMessage.estimate({ route: 'transfer', feeToken: '0x4718', operationToken: '0x4718' }))
        .rejects.toMatchObject({ kind: 'relay-not-configured', message: refused.message });
    });

    it('reads the code without running an accessor or a proxy trap', async () => {
      let getterCalled = false;
      const accessor = { message: 'paused' } as { message: string; code?: string };
      Object.defineProperty(accessor, 'code', {
        enumerable: true,
        get() {
          getterCalled = true;
          return 'RELAY_NOT_CONFIGURED';
        },
      });
      const trapped = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
      for (const body of [accessor, trapped]) {
        const client = new BackendPrivacyClient('https://backend.example', async () => ({
          ok: false,
          status: 503,
          json: async () => body,
        }) as Response);
        await expect(client.config()).rejects.toMatchObject({ kind: 'unreachable' });
      }
      expect(getterCalled).toBe(false);
    });
  });

});

describe('BackendPrivacyClient receipt lookup (D-072)', () => {
  it('posts the hash to the receipt route and hands back the chain receipt as given', async () => {
    const receipt = { transaction_hash: '0x5eed', execution_status: 'SUCCEEDED', events: [] };
    const fetcher = vi.fn(async () => response(receipt));
    const client = new BackendPrivacyClient('/api', fetcher);

    await expect(client.receipt('0x5eed')).resolves.toEqual(receipt);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/rpc/receipt');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, transactionHash: '0x5eed' });
  });

  it('refuses a malformed hash without a request', async () => {
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('/api', fetcher);
    for (const bad of ['', '0x0', 'shield', 1 as unknown as string]) {
      await expect(client.receipt(bad)).rejects.toMatchObject({ kind: 'unknown' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('hands back null for a transaction the network has not seen yet', async () => {
    const fetcher = vi.fn(async () => response(null));
    const client = new BackendPrivacyClient('/api', fetcher);
    await expect(client.receipt('0x5eed')).resolves.toBeNull();
  });

  it.each([
    [429, { code: 'RATE_LIMITED', message: 'Service is busy. Try again shortly.' }, 'unknown'],
    [502, { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' }, 'unknown'],
    [503, { code: 'SERVICE_DISABLED', message: 'Private operations are temporarily disabled.' }, 'unreachable'],
  ] as const)('rejects a %i from the receipt route as a failed read', async (status, body, kind) => {
    const fetcher = vi.fn(async () => response(body, status));
    const client = new BackendPrivacyClient('/api', fetcher);
    await expect(client.receipt('0x5eed')).rejects.toMatchObject({ kind });
  });

  it('rejects an unreachable receipt route as unreachable', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const client = new BackendPrivacyClient('/api', fetcher);
    await expect(client.receipt('0x5eed')).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

describe('BackendPrivacyClient Vault reads (D-077, D-079)', () => {
  const PARTIAL = '0x5f2e1d';
  const SHADOW = '0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9';
  const VSTRK = '0x6d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d';
  const VUSDC = '0x387e8ddbb1ab36ca08874d9abc702ef4872ad600dcf76b7f240b71d7bc4e65';
  const row = (vault: string, fields: Record<string, unknown> = {}) => ({
    vault,
    ok: true,
    shares: '50000000000000000000',
    assets: '51000000000000000000',
    maxWithdraw: '51000000000000000000',
    maxRedeem: '50000000000000000000',
    ...fields,
  });

  it('asks the shadow-account route for the partial commitment alone', async () => {
    const fetcher = vi.fn(async () => response({ address: SHADOW, deployed: false }));
    const client = new BackendPrivacyClient('/api', fetcher);

    await expect(client.shadowAccount(PARTIAL)).resolves.toEqual({ address: SHADOW, deployed: false });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/rpc/shadow-account');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, partialCommitment: PARTIAL });
  });

  it('asks the position route for the stand-in address alone, and reads one row per vault in decimal base units', async () => {
    const fetcher = vi.fn(async () => response({
      positions: [
        row(VSTRK),
        row(VUSDC, { shares: '0', assets: '0', maxWithdraw: '0', maxRedeem: '0' }),
        { vault: '0x4ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c', ok: false },
      ],
    }));
    const client = new BackendPrivacyClient('/api', fetcher);

    const rows = await client.vaultPositions(SHADOW);
    expect(rows).toEqual([
      { vault: VSTRK, ok: true, shares: 50n * 10n ** 18n, assets: 51n * 10n ** 18n, maxWithdraw: 51n * 10n ** 18n, maxRedeem: 50n * 10n ** 18n },
      { vault: VUSDC, ok: true, shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n },
      { vault: '0x4ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c', ok: false },
    ]);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/rpc/vault-position');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, account: SHADOW });
  });

  it('asks the rates route for nothing but a version, and reads each vault’s APY as an integer and its decimals', async () => {
    const fetcher = vi.fn(async () => response({
      rates: [{ vault: VSTRK, supplyApy: { value: '27351899613523568', decimals: 18 } }],
    }));
    const client = new BackendPrivacyClient('/api', fetcher);
    await expect(client.vaultRates()).resolves.toEqual([
      { vault: VSTRK, supplyApy: { value: 27351899613523568n, decimals: 18 } },
    ]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/vault-rates');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1 });
  });

  it('refuses a malformed commitment or account without a request', async () => {
    const fetcher = vi.fn(async () => response({}));
    const client = new BackendPrivacyClient('/api', fetcher);
    for (const bad of ['', '0x0', 'shadow', `0x${STARK_FIELD_PRIME.toString(16)}`, 1 as unknown as string]) {
      await expect(client.shadowAccount(bad)).rejects.toMatchObject({ kind: 'unknown' });
      await expect(client.vaultPositions(bad)).rejects.toMatchObject({ kind: 'unknown' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a zero address', { address: '0x0', deployed: true }],
    ['a non-boolean deployment flag', { address: SHADOW, deployed: 1 }],
    ['an extra field', { address: SHADOW, deployed: false, nonce: '0x0' }],
    ['a missing field', { address: SHADOW }],
  ])('refuses a shadow-account answer with %s', async (_label, body) => {
    const client = new BackendPrivacyClient('/api', vi.fn(async () => response(body)));
    await expect(client.shadowAccount(PARTIAL)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['a hex figure', { positions: [row(VSTRK, { shares: '0x1' })] }],
    ['a number', { positions: [row(VSTRK, { shares: 1 })] }],
    ['a figure past u256', { positions: [row(VSTRK, { shares: (MAX_UINT256 + 1n).toString() })] }],
    ['an extra field in a row', { positions: [row(VSTRK, { account: SHADOW })] }],
    ['no ok flag', { positions: [{ vault: VSTRK, shares: '1', assets: '1', maxWithdraw: '1', maxRedeem: '1' }] }],
    ['an ok flag that is not a boolean', { positions: [row(VSTRK, { ok: 'true' })] }],
    ['an unread row that still carries figures', { positions: [row(VSTRK, { ok: false })] }],
    ['a missing field in a row', { positions: [{ vault: VSTRK, shares: '1', assets: '1', maxWithdraw: '1' }] }],
    ['a zero vault', { positions: [row('0x0')] }],
    ['a vault that is not a felt', { positions: [row('vSTRK')] }],
    ['a single position rather than a list', row(VSTRK)],
    ['an extra top-level field', { positions: [row(VSTRK)], account: SHADOW }],
    ['more rows than any backend pins', { positions: Array.from({ length: MAX_VAULT_MARKETS + 1 }, () => row(VSTRK)) }],
  ])('refuses a position answer with %s', async (_label, body) => {
    const client = new BackendPrivacyClient('/api', vi.fn(async () => response(body)));
    await expect(client.vaultPositions(SHADOW)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['a hex value', { rates: [{ vault: VSTRK, supplyApy: { value: '0x1', decimals: 18 } }] }],
    ['a number value', { rates: [{ vault: VSTRK, supplyApy: { value: 1, decimals: 18 } }] }],
    ['a negative value', { rates: [{ vault: VSTRK, supplyApy: { value: '-1', decimals: 18 } }] }],
    ['string decimals', { rates: [{ vault: VSTRK, supplyApy: { value: '1', decimals: '18' } }] }],
    ['too many decimals', { rates: [{ vault: VSTRK, supplyApy: { value: '1', decimals: 37 } }] }],
    ['negative decimals', { rates: [{ vault: VSTRK, supplyApy: { value: '1', decimals: -1 } }] }],
    ['an extra rate field', { rates: [{ vault: VSTRK, supplyApy: { value: '1', decimals: 18, source: 'vesu' } }] }],
    ['an extra row field', { rates: [{ vault: VSTRK, supplyApy: { value: '1', decimals: 18 }, apr: '1' }] }],
    ['a zero vault', { rates: [{ vault: '0x0', supplyApy: { value: '1', decimals: 18 } }] }],
    ['no list', { rates: null }],
    ['an extra top-level field', { rates: [], pool: VSTRK }],
  ])('refuses a rates answer with %s', async (_label, body) => {
    const client = new BackendPrivacyClient('/api', vi.fn(async () => response(body)));
    await expect(client.vaultRates()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('reads an unreachable or switched-off service as unreachable', async () => {
    const down = new BackendPrivacyClient('/api', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(down.shadowAccount(PARTIAL)).rejects.toMatchObject({ kind: 'unreachable' });
    const off = new BackendPrivacyClient('/api', vi.fn(async () => response(
      { code: 'SERVICE_DISABLED', message: 'Private operations are temporarily disabled.' },
      503,
    )));
    await expect(off.vaultPositions(SHADOW)).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(off.vaultRates()).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(down.vaultRates()).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

describe('BackendPrivacyClient swap quotes (D-084)', () => {
  const request = { sellToken: '0xabc', buyToken: '0x4718', sellAmount: 20n, taker: '0x5ad0', slippageBps: 100 };

  it('posts the request to the keyless quote route and maps the answer to bigints', async () => {
    const fetcher = vi.fn(async () => response({ ...QUOTE_BODY, buyAmount: '900719925474099312345' }));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.quoteSwap(request)).resolves.toEqual({
      quoteId: 'quote-1',
      chainId: '0x534e5f4d41494e',
      sellToken: '0xabc',
      buyToken: '0x4718',
      sellAmount: 20n,
      buyAmount: 900719925474099312345n,
      calls: [{ contractAddress: '0x4270', entrypoint: 'multi_route_swap', calldata: ['0xabc', '0x14'] }],
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://backend.example/v1/swap/quote');
    expect(JSON.parse(String(init.body))).toEqual({
      v: 1, sellToken: '0xabc', buyToken: '0x4718', sellAmount: '20', taker: '0x5ad0', slippageBps: 100,
    });
  });

  it('publishes an immutable answer graph', async () => {
    const client = new BackendPrivacyClient('https://backend.example', async () => response(QUOTE_BODY));
    const answer = await client.quoteSwap(request);

    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(answer.calls)).toBe(true);
    expect(Object.isFrozen(answer.calls[0])).toBe(true);
    expect(Object.isFrozen(answer.calls[0]?.calldata)).toBe(true);
  });

  it.each([
    ['decimal sell token', { sellToken: '123' }],
    ['zero buy token', { buyToken: '0x0' }],
    ['zero taker', { taker: '0x0' }],
    ['missing taker', { taker: undefined }],
    ['zero sell amount', { sellAmount: 0n }],
    ['number sell amount', { sellAmount: 20 }],
    ['zero slippage', { slippageBps: 0 }],
    ['fractional slippage', { slippageBps: 1.5 }],
    ['slippage above 100%', { slippageBps: 10_001 }],
  ] as const)('rejects an invalid request before transport: %s', async (_label, patch) => {
    const fetcher = vi.fn(async () => response(QUOTE_BODY));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await expect(client.quoteSwap({ ...request, ...patch } as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('owns request fields before a caller proxy can substitute them', async () => {
    const fetcher = vi.fn(async () => response(QUOTE_BODY));
    let takerReads = 0;
    const input = new Proxy({ ...request }, {
      get(target, key, receiver) {
        if (key === 'taker') {
          takerReads += 1;
          return '0xdef';
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const client = new BackendPrivacyClient('https://backend.example', fetcher);

    await client.quoteSwap(input);

    const dispatched = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(dispatched[1].body))).toMatchObject({ taker: '0x5ad0' });
    expect(takerReads).toBe(0);
  });

  it.each([
    ['empty quote id', { ...QUOTE_BODY, quoteId: '' }],
    ['zero buy amount', { ...QUOTE_BODY, buyAmount: '0' }],
    ['hex buy amount', { ...QUOTE_BODY, buyAmount: '0x64' }],
    ['signed sell amount', { ...QUOTE_BODY, sellAmount: '+20' }],
    ['calls not an array', { ...QUOTE_BODY, calls: {} }],
    ['numeric calldata', { ...QUOTE_BODY, calls: [{ contractAddress: '0x1', entrypoint: 'x', calldata: [1] }] }],
    ['missing calls', { ...QUOTE_BODY, calls: undefined }],
  ])('maps a malformed answer (%s) to a generic privacy error', async (_label, body) => {
    const client = new BackendPrivacyClient('https://backend.example', async () => response(body));
    await expect(client.quoteSwap(request)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects a sparse calls array and a call field supplied only by the prototype', async () => {
    const sparse = new BackendPrivacyClient('https://backend.example', async () => objectResponse({
      ...QUOTE_BODY, calls: new Array(1),
    }));
    await expect(sparse.quoteSwap(request)).rejects.toMatchObject({ kind: 'unknown' });

    const restore = inheritResponseField('entrypoint', 'multi_route_swap');
    try {
      const inherited = new BackendPrivacyClient('https://backend.example', async () => response({
        ...QUOTE_BODY, calls: [{ contractAddress: '0x4270', calldata: [] }],
      }));
      await expect(inherited.quoteSwap(request)).rejects.toMatchObject({ kind: 'unknown' });
    } finally {
      restore();
    }
  });

  it('answers a disabled proxy as unreachable and a rate-limited one as a refusal, never as a quote', async () => {
    const down = new BackendPrivacyClient('https://backend.example', async () => response({ code: 'SERVICE_DISABLED', message: 'off' }, 503));
    await expect(down.quoteSwap(request)).rejects.toMatchObject({ kind: 'unreachable' });
    const busy = new BackendPrivacyClient('https://backend.example', async () => response({ code: 'RATE_LIMITED', message: 'busy' }, 429));
    await expect(busy.quoteSwap(request)).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('BackendPrivacyClient borrow reads (D-083)', () => {
  const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
  const SHADOW = '0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9';
  const assetRow = {
    token: STRK,
    ok: true,
    price: '43278720000000000',
    priceValid: true,
    scale: '1000000000000000000',
    floor: '10000000000000000000',
    reserve: '4393629991301881601655583',
    totalNominalDebt: '9496271713342081596086830',
    rateAccumulator: '1023000000000000000',
    maxUtilization: '950000000000000000',
  };
  const pairRow = {
    collateral: STRK,
    debt: USDC,
    ok: true,
    maxLtv: '680000000000000000',
    liquidationFactor: '900000000000000000',
    debtCap: '200000000000',
    totalNominalDebt: '46475714863453008302364',
  };

  it('asks the market route for nothing but a version, and reads token and pair rows in decimal base units', async () => {
    const fetcher = vi.fn(async () => response({ assets: [assetRow, { token: USDC, ok: false }], pairs: [pairRow, { collateral: USDC, debt: STRK, ok: false }] }));
    const client = new BackendPrivacyClient('/api', fetcher);
    const market = await client.borrowMarket();
    expect(market.assets).toEqual([
      {
        token: STRK,
        ok: true,
        price: 43278720000000000n,
        priceValid: true,
        scale: 10n ** 18n,
        floor: 10n * 10n ** 18n,
        reserve: 4393629991301881601655583n,
        totalNominalDebt: 9496271713342081596086830n,
        rateAccumulator: 1023000000000000000n,
        maxUtilization: 950000000000000000n,
      },
      { token: USDC, ok: false },
    ]);
    expect(market.pairs).toEqual([
      { collateral: STRK, debt: USDC, ok: true, maxLtv: 680000000000000000n, liquidationFactor: 900000000000000000n, debtCap: 200000000000n, totalNominalDebt: 46475714863453008302364n },
      { collateral: USDC, debt: STRK, ok: false },
    ]);
    expect(Object.isFrozen(market.assets[0])).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/rpc/borrow-market');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1 });
  });

  it('asks the position route for the stand-in address alone', async () => {
    const fetcher = vi.fn(async () => response({
      positions: [{ collateral: STRK, debt: USDC, ok: true, collateralShares: '3', nominalDebt: '4', collateralAmount: '5', debtAmount: '6' }],
    }));
    const client = new BackendPrivacyClient('/api', fetcher);
    await expect(client.borrowPositions(SHADOW)).resolves.toEqual([
      { collateral: STRK, debt: USDC, ok: true, collateralShares: 3n, nominalDebt: 4n, collateralAmount: 5n, debtAmount: 6n },
    ]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/rpc/borrow-position');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, account: SHADOW });
    await expect(client.borrowPositions('0x0')).rejects.toThrow('The borrow account is invalid.');
  });

  it.each([
    ['an extra key', { assets: [], pairs: [], v: 1 }],
    ['a price that is not a string', { assets: [{ ...assetRow, price: 1 }], pairs: [] }],
    ['a non-boolean validity', { assets: [{ ...assetRow, priceValid: 'yes' }], pairs: [] }],
    ['an extra row key', { assets: [{ ...assetRow, extra: '1' }], pairs: [] }],
    ['a negative cap', { assets: [], pairs: [{ ...pairRow, debtCap: '-1' }] }],
    ['a zero address', { assets: [{ ...assetRow, token: '0x0' }], pairs: [] }],
    ['too many pairs', { assets: [], pairs: Array.from({ length: 21 }, () => pairRow) }],
  ])('refuses a market answer with %s', async (_label, body) => {
    const client = new BackendPrivacyClient('/api', vi.fn(async () => response(body)));
    await expect(client.borrowMarket()).rejects.toThrow('The private service returned an invalid response.');
  });
});

describe('the unstaking read (D-085)', () => {
  const ACCOUNT = '0x6ad69dce496ffd4177ffbaaa9800b18589303c62ac3ad44c08c4830cb50aba4';
  const body = {
    chainTime: 1_790_854_217,
    strk: '4000000000000000000',
    xstrk: '0',
    outstanding: '1',
    complete: true,
    requests: [{ requestId: '10589', assets: '15470269360521547710', shares: '13073397411927640064', claimed: false, requestedAt: 1_790_829_525, claimableAt: 1_791_434_325, claimableNow: false }],
  };

  it('posts the address alone and parses decimal strings into bigints', async () => {
    const fetcher = vi.fn(async () => response(body));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);
    await expect(client.endurUnstake(ACCOUNT)).resolves.toEqual({
      chainTime: 1_790_854_217,
      strk: 4n * 10n ** 18n,
      xstrk: 0n,
      outstanding: 1n,
      complete: true,
      requests: [{ requestId: 10_589n, assets: 15_470_269_360_521_547_710n, shares: 13_073_397_411_927_640_064n, claimed: false, requestedAt: 1_790_829_525, claimableAt: 1_791_434_325, claimableNow: false }],
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://backend.example/v1/rpc/endur-unstake');
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, account: ACCOUNT });
  });

  it.each([
    ['an extra field', { ...body, extra: 1 }],
    ['a hex amount', { ...body, strk: '0x1' }],
    ['a non-boolean claim', { ...body, requests: [{ ...body.requests[0], claimed: 'no' }] }],
    ['a missing dry run', { ...body, requests: [{ ...body.requests[0], claimableNow: undefined }] }],
    ['a non-boolean completeness flag', { ...body, complete: 'yes' }],
    ['a negative time', { ...body, chainTime: -1 }],
    ['too many rows', { ...body, requests: Array.from({ length: 65 }, () => body.requests[0]) }],
  ])('refuses %s', async (_label, answer) => {
    const client = new BackendPrivacyClient('https://backend.example', vi.fn(async () => response(answer)));
    await expect(client.endurUnstake(ACCOUNT)).rejects.toThrow('The private service returned an invalid response.');
  });

  it('refuses an invalid address before any request', async () => {
    const fetcher = vi.fn(async () => response(body));
    const client = new BackendPrivacyClient('https://backend.example', fetcher);
    await expect(client.endurUnstake('0x0')).rejects.toThrow('The unstaking account is invalid.');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
