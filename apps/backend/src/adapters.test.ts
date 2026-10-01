import { describe, expect, it, vi } from 'vitest';
import { AvnuPaymasterPort } from './avnu-paymaster.js';
import { AVNU_EXCHANGE, AvnuSwapQuotes, MAX_RESPONSE_BYTES } from './avnu-swap-quotes.js';
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

describe('avnu keyless swap quotes (D-084)', () => {
  const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
  const TAKER = '0x771b47d5784bbcaa14e989adee560efae541c09b3f12db34e16562e392cf032';
  const CHAIN = '0x534e5f4d41494e';
  const input = { sellToken: STRK, buyToken: USDC, sellAmount: 10n ** 19n, taker: TAKER, slippageBps: 100 };
  // The shapes avnu's public API answered on 2026-10-01, abridged.
  const quoteBody = [{
    quoteId: 'd390cd45-ab25-4cab-88c7-852ba847005a',
    sellTokenAddress: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    sellAmount: '0x8ac7230489e80000',
    buyTokenAddress: '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
    buyAmount: '0x691fc',
    chainId: CHAIN,
    expiry: null,
  }];
  const swapCall = {
    contractAddress: '0x4270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f',
    entrypoint: 'multi_route_swap',
    calldata: [
      '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', '0x8ac7230489e80000', '0x0',
      '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', '0x691fc', '0x0', '0x6812a', '0x0',
      TAKER, '0x0', '0x0',
      '0x1', '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
      '0x20d2431ba27021073cae53dab6d818b9e15f79e13639fd4f040f5b41a617fb6', '0xe8d4a51000', '0x1', '0x1',
    ],
  };
  const buildBody = { chainId: CHAIN, calls: [swapCall], executorAddress: null };
  const text = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function fetcher(quote: unknown = quoteBody, build: unknown = buildBody) {
    return vi.fn(async (url: string, _init?: RequestInit) => (url.includes('/swap/v3/quotes') ? text(quote) : text(build)));
  }

  it('asks the public quote and build endpoints with no key, the stand-in as taker, and no approve', async () => {
    const fetch = fetcher();
    const quotes = new AvnuSwapQuotes({ chainId: CHAIN, fetch });

    await expect(quotes.quote(input)).resolves.toEqual({
      quoteId: 'd390cd45-ab25-4cab-88c7-852ba847005a',
      chainId: CHAIN,
      sellToken: STRK,
      buyToken: USDC,
      sellAmount: 10n ** 19n,
      buyAmount: 430_588n,
      calls: [{ contractAddress: AVNU_EXCHANGE, entrypoint: 'multi_route_swap', calldata: swapCall.calldata }],
    });
    const [quoteUrl, quoteInit] = fetch.mock.calls[0]!;
    const url = new URL(quoteUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://starknet.api.avnu.fi/swap/v3/quotes');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sellTokenAddress: STRK, buyTokenAddress: USDC, sellAmount: '0x8ac7230489e80000', takerAddress: TAKER, size: '1',
    });
    expect(quoteInit?.method).toBe('GET');
    const [buildUrl, buildInit] = fetch.mock.calls[1]!;
    expect(buildUrl).toBe('https://starknet.api.avnu.fi/swap/v3/build');
    expect(JSON.parse(String(buildInit?.body))).toEqual({
      quoteId: 'd390cd45-ab25-4cab-88c7-852ba847005a', takerAddress: TAKER, slippage: 0.01, includeApprove: false,
    });
    // No key header, and nothing but the content type.
    expect(buildInit?.headers).toEqual({ 'content-type': 'application/json' });
    expect(quoteInit?.headers).toBeUndefined();
  });

  it('uses AVNU_BASE_URL when set', async () => {
    const fetch = fetcher();
    await new AvnuSwapQuotes({ chainId: CHAIN, fetch, baseUrl: 'https://avnu.example/' }).quote(input);
    expect(fetch.mock.calls[0]![0]).toMatch(/^https:\/\/avnu\.example\/swap\/v3\/quotes\?/);
  });

  it.each([
    ['no quote', [], buildBody],
    ['a quote for another chain', [{ ...quoteBody[0], chainId: '0x534e5f5345504f4c4941' }], buildBody],
    ['a quote for another sell amount', [{ ...quoteBody[0], sellAmount: '0x1' }], buildBody],
    ['a quote buying another token', [{ ...quoteBody[0], buyTokenAddress: STRK }], buildBody],
    ['a zero buy amount', [{ ...quoteBody[0], buyAmount: '0x0' }], buildBody],
    ['an odd quote id', [{ ...quoteBody[0], quoteId: 'a b' }], buildBody],
    ['an approve in the build', quoteBody, { ...buildBody, calls: [{ ...swapCall, entrypoint: 'approve' }, swapCall] }],
    ['a build on another contract', quoteBody, { ...buildBody, calls: [{ ...swapCall, contractAddress: '0x123' }] }],
    ['a build for another beneficiary', quoteBody, {
      ...buildBody, calls: [{ ...swapCall, calldata: swapCall.calldata.map((felt, index) => (index === 8 ? '0xabc' : felt)) }],
    }],
    ['a non-felt in the calldata', quoteBody, { ...buildBody, calls: [{ ...swapCall, calldata: [...swapCall.calldata, 'x'] }] }],
  ])('refuses %s', async (_label, quote, build) => {
    const quotes = new AvnuSwapQuotes({ chainId: CHAIN, fetch: fetcher(quote, build) });
    await expect(quotes.quote(input)).rejects.toThrow();
  });

  it('refuses an error status from avnu, and never builds after a failed quote', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => text({ messages: ['Invalid quote id'] }, 400));
    await expect(new AvnuSwapQuotes({ chainId: CHAIN, fetch }).quote(input)).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('streams avnu\'s answer and aborts it past 256 KB, never holding an oversized body', async () => {
    expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { status: 200 });
    await expect(new AvnuSwapQuotes({ chainId: CHAIN, fetch: async () => endless() }).quote(input)).rejects.toThrow(/too much/);
    // Five 64 KB chunks cross the cap; the stream is cancelled there.
    expect(pulled).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);

    const declared = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }));
    await expect(new AvnuSwapQuotes({ chainId: CHAIN, fetch: declared }).quote(input)).rejects.toThrow(/too much/);
  });

  it('stops on its own timeout and on the caller\'s cancellation', async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await expect(new AvnuSwapQuotes({ chainId: CHAIN, fetch: hang, timeoutMs: 5 }).quote(input))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    const controller = new AbortController();
    const pending = new AvnuSwapQuotes({ chainId: CHAIN, fetch: hang }).quote({ ...input, signal: controller.signal });
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fixed Starknet RPC adapter', () => {
  it('binds the default fetch to the global receiver without making a real request', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const receiverSensitiveFetch = function (this: unknown, url: string, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push({ url, init });
      return Promise.resolve(directResponse({ jsonrpc: '2.0', id: 1, result: 1000 }));
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: originalFetch?.enumerable ?? true,
      writable: true,
      value: receiverSensitiveFetch,
    });

    try {
      const rpc = new StarknetRpcPoolPort({
        rpcUrl: 'https://rpc.example',
        poolAddress: '0x123',
        feeToken: '0x4718',
      });
      await expect(rpc.getBlockNumber()).resolves.toBe(1000);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://rpc.example');
    } finally {
      if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
      else delete (globalThis as { fetch?: unknown }).fetch;
    }
  });

  it('preserves injected fetcher call behavior and receiver', async () => {
    let receiver: unknown;
    const injected = vi.fn(async function (this: unknown, url: string, init?: RequestInit) {
      receiver = this;
      expect(url).toBe('https://rpc.example');
      expect(init?.method).toBe('POST');
      return directResponse({ jsonrpc: '2.0', id: 1, result: 1000 });
    });
    const rpc = new StarknetRpcPoolPort({
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      feeToken: '0x4718',
      fetcher: injected,
    });

    await expect(rpc.getBlockNumber()).resolves.toBe(1000);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(receiver).toBe(rpc);
  });

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
            : ['0x6'];
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

  it('reads a receipt with the fixed method and hands it back as the chain gave it (D-072)', async () => {
    const receipt = { transaction_hash: '0xaaa', execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2', events: [] };
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      requests.push(request);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: receipt }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });

    await expect(rpc.getReceipt('0xaaa')).resolves.toEqual(receipt);
    expect(requests.map(({ method, params }) => [method, params])).toEqual([
      ['starknet_getTransactionReceipt', ['0xaaa']],
    ]);
  });

  it('answers null for a hash the node has not seen (error 29), and rejects every other error (D-072)', async () => {
    const errors: unknown[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: errors.shift() }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });

    errors.push({ code: 29, message: 'Transaction hash not found' });
    await expect(rpc.getReceipt('0xaaa')).resolves.toBeNull();

    for (const error of [
      { code: 24, message: 'Block not found' },
      { code: -32000, message: 'Transaction hash not found' },
      { code: '29', message: 'Transaction hash not found' },
      { code: 29.5 },
      { message: 'Transaction hash not found' },
      [29],
      'Transaction hash not found',
    ]) {
      errors.push(error);
      await expect(rpc.getReceipt('0xaaa'), JSON.stringify(error)).rejects.toThrow(/rpc returned an error/i);
    }

    // Only the receipt read takes "not seen" as an answer.
    errors.push({ code: 29, message: 'Transaction hash not found' });
    await expect(rpc.getBlockNumber()).rejects.toThrow(/rpc returned an error/i);
  });

  it('reads the error code only from an own data property', async () => {
    const fetcher = vi.fn(async () => directResponse({
      jsonrpc: '2.0',
      id: 1,
      error: Object.defineProperty({ message: 'Transaction hash not found' }, 'code', { get: () => 29, enumerable: true }),
    }));
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });

    await expect(rpc.getReceipt('0xaaa')).rejects.toThrow(/rpc returned an error/i);
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

  it('reads the live pool fee as the single u128 the mainnet ABI returns', async () => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      // What mainnet answered for get_fee_amount on 2026-09-27: 6 STRK.
      const result = call === 1 ? ['0x53444835ec580000'] : ['0x1c2'];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call, result }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });
    await expect(rpc.getPoolConfig()).resolves.toMatchObject({ feeAmount: 6_000_000_000_000_000_000n });
  });

  it('refuses a fee result that is not exactly one felt, such as the old u256 shape', async () => {
    for (const shaped of [['0x6', '0x0'], []]) {
      let call = 0;
      const fetcher = vi.fn(async () => {
        call += 1;
        const result = call === 1 ? shaped : ['0x1c2'];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call, result }));
      });
      const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: '0x123', feeToken: '0x4718', fetcher });
      await expect(rpc.getPoolConfig()).rejects.toThrow(/invalid fee amount/i);
    }
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
      const result = call === 1 ? [malformed] : ['0x1c2'];
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
      const result = call === 1 ? ['0x6'] : [malformed];
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
      const result = call++ === 0 ? ['0x6'] : malformed;
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
