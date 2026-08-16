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
        body = JSON.parse(raw);
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          return json(413, { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.' });
        }
        return json(400, { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
      }
    }

    const result = await api.handle({ method: request.method, path: url.pathname, body });
    return json(result.status, result.body);
  };
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
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
