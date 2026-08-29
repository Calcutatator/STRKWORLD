import type { BackendApi } from './api.js';

export const DEFAULT_MAX_REQUEST_BYTES = 2_500_000;

export interface BackendFetchHandlerOptions {
  maxRequestBytes?: number;
}

type BackendHandler = Pick<BackendApi, 'handle'>;

/**
 * Deployment-neutral Fetch API edge. It deliberately has no access logger,
 * client identifier, CORS reflection or request persistence.
 */
export function createBackendFetchHandler(
  api: BackendHandler,
  options: BackendFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new Error('Backend request limit must be a positive integer.');
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.search) return json(400, { code: 'QUERY_NOT_ALLOWED', message: 'Query parameters are not accepted.' });

    let body: unknown = null;
    if (request.method === 'POST') {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
        return json(415, { code: 'JSON_REQUIRED', message: 'Content-Type must be application/json.' });
      }
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxRequestBytes) {
        return json(413, { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.' });
      }
      try {
        const raw = await readBoundedText(request, maxRequestBytes);
        rejectAmbiguousJsonKeys(raw);
        body = JSON.parse(raw);
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          return json(413, { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.' });
        }
        return json(400, { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
      }
      if (request.signal.aborted) {
        return json(400, { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
      }
    }

    const result = await api.handle({
      method: request.method,
      path: url.pathname,
      body,
      signal: request.signal,
    });
    return json(result.status, result.body);
  };
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAborted!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  let abortHandled = false;
  const onAbort = (): void => {
    if (abortHandled) return;
    abortHandled = true;
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The generic body-read boundary below handles a synchronous cancel failure.
    }
    rejectAborted(new Error('Request body read aborted.'));
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (request.signal.aborted) {
        onAbort();
        await aborted;
      }
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation failure does not change the authoritative size violation.
        }
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may keep a read pending after cancellation; its lock is then unreleasable.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

class RequestTooLargeError extends Error {}

const RESERVED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function rejectAmbiguousJsonKeys(raw: string): void {
  const objectKeys: Set<string>[] = [];
  let expectingKey = false;
  let index = 0;
  while (index < raw.length) {
    const character = raw[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '{') {
      objectKeys.push(new Set());
      expectingKey = true;
      index += 1;
      continue;
    }
    if (character === '}') {
      objectKeys.pop();
      expectingKey = false;
      index += 1;
      continue;
    }
    if (character === ',') {
      expectingKey = objectKeys.length > 0;
      index += 1;
      continue;
    }
    if (character === '"') {
      const end = scanJsonString(raw, index);
      if (expectingKey && objectKeys.length > 0) {
        const key = JSON.parse(raw.slice(index, end)) as string;
        const keys = objectKeys[objectKeys.length - 1]!;
        if (keys.has(key) || RESERVED_JSON_KEYS.has(key)) throw new SyntaxError('Ambiguous JSON key.');
        keys.add(key);
        let colon = end;
        while (/\s/.test(raw[colon] ?? '')) colon += 1;
        if (raw[colon] !== ':') throw new SyntaxError('Invalid JSON object key.');
        expectingKey = false;
      }
      index = end;
      continue;
    }
    index += 1;
  }
}

function scanJsonString(raw: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (!escaped && character === '"') return index + 1;
    if (!escaped && character === '\\') escaped = true;
    else escaped = false;
  }
  throw new SyntaxError('Unterminated JSON string.');
}
