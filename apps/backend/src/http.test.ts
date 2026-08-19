import { describe, expect, it, vi } from 'vitest';
import { createBackendFetchHandler } from './http.js';

describe('privacy-safe Fetch edge', () => {
  it('passes only method, path and parsed body into the backend core', async () => {
    const api = {
      handle: vi.fn(async () => ({ status: 200, body: { feeAmount: '6' } })),
    };
    const handler = createBackendFetchHandler(api);
    const response = await handler(new Request('https://private.example/v1/rpc/pool-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
    }));
    expect(api.handle).toHaveBeenCalledWith({
      method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 }, signal: expect.any(AbortSignal),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects non-JSON, query parameters and oversized bodies before the core', async () => {
    const api = { handle: vi.fn(async () => ({ status: 200, body: {} })) };
    const handler = createBackendFetchHandler(api, { maxRequestBytes: 8 });
    await expect(handler(new Request('https://private.example/v1/rpc/pool-config?address=0xabc', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))).resolves.toMatchObject({ status: 400 });
    await expect(handler(new Request('https://private.example/v1/rpc/pool-config', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    }))).resolves.toMatchObject({ status: 415 });
    await expect(handler(new Request('https://private.example/v1/rpc/pool-config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"v":123456789}',
    }))).resolves.toMatchObject({ status: 413 });
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('keeps an oversized request authoritative when stream cancellation rejects', async () => {
    const api = { handle: vi.fn(async () => ({ status: 200, body: {} })) };
    const cancel = vi.fn(async () => {
      throw new Error('hostile cancellation failure');
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel,
    });
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    };
    const handler = createBackendFetchHandler(api, { maxRequestBytes: 8 });
    const response = await handler(new Request(
      'https://private.example/v1/rpc/pool-config',
      requestInit,
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      code: 'REQUEST_TOO_LARGE',
      message: 'Request body is too large.',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('returns a generic parse error without echoing malformed input', async () => {
    const api = { handle: vi.fn(async () => ({ status: 200, body: {} })) };
    const handler = createBackendFetchHandler(api);
    const response = await handler(new Request('https://private.example/v1/private/fees', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{secret',
    }));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.not.toContain('secret');
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('cancels a hanging request body when the client aborts before parsing', async () => {
    const api = { handle: vi.fn(async () => ({ status: 200, body: {} })) };
    const controller = new AbortController();
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => {
        cancelCalled = true;
      },
    });
    const handler = createBackendFetchHandler(api);
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
      duplex: 'half',
    };
    const pending = handler(new Request('https://private.example/v1/private/fees', requestInit));

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    const response = await Promise.race([
      pending,
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('aborted body did not settle promptly')), 100);
      }),
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
    });
    expect(cancelCalled).toBe(true);
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('rejects an abort after parsing before calling the backend core', async () => {
    const api = { handle: vi.fn(async () => ({ status: 200, body: {} })) };
    const controller = new AbortController();
    const request = new Request('https://private.example/v1/private/fees', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    const parseJson = JSON.parse;
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce((text, reviver) => {
      const parsed = parseJson(text, reviver);
      controller.abort();
      return parsed;
    });
    const handler = createBackendFetchHandler(api);
    let response: Response;

    try {
      response = await handler(request);
    } finally {
      parseSpy.mockRestore();
    }

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
    });
    expect(api.handle).not.toHaveBeenCalled();
  });
});
