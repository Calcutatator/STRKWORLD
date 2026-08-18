import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { BackendApi } from './api.js';
import { HmacAuthorizationCodec } from './authorization.js';
import { AvnuPaymasterPort } from './avnu-paymaster.js';
import { AvnuSwapPlanner } from './avnu-swap-planner.js';
import {
  parseBackendEnvironment,
  type Environment,
  type ParsedBackendEnvironment,
} from './environment.js';
import { createBackendFetchHandler } from './http.js';
import { StarknetRpcPoolPort } from './starknet-rpc.js';
import type { PaymasterPort, PoolRpcPort, SwapPlannerPort } from './types.js';

export interface BackendRuntimeOverrides {
  paymaster?: PaymasterPort;
  rpc?: PoolRpcPort;
  swapPlanner?: SwapPlannerPort;
}

export interface BackendRuntime {
  api: BackendApi;
  server: Server;
  port: number;
}

export interface ListenBackendServerOptions {
  port: number;
}

export interface RunningBackendServer {
  address: { address: string; family: string; port: number };
  close(): Promise<void>;
}

/** Production composition root. Test overrides replace whole external ports. */
export function createBackendRuntime(
  environment: Environment,
  overrides: BackendRuntimeOverrides = {},
): BackendRuntime {
  const parsed = parseBackendEnvironment(environment);
  const api = createBackendApi(parsed, overrides);
  const handler = createBackendFetchHandler(api, {
    maxRequestBytes: parsed.maxRequestBytes,
  });
  const server = createServer((request, response) => {
    void serveFetchRequest(request, response, handler);
  });
  server.requestTimeout = parsed.backend.requestTimeoutMs;

  return { api, server, port: parsed.port };
}

/** Bind the private edge on every container interface; port 0 is test-only. */
export function listenBackendServer(
  server: Server,
  options: ListenBackendServerOptions,
): Promise<RunningBackendServer> {
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    return Promise.reject(new Error('Backend listener port is invalid.'));
  }

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        void closeServer(server).finally(() => {
          reject(new Error('Backend listener did not bind a TCP address.'));
        });
        return;
      }
      resolve({
        address: {
          address: address.address,
          family: address.family,
          port: address.port,
        },
        close: () => closeServer(server),
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, '0.0.0.0');
  });
}

function createBackendApi(
  parsed: ParsedBackendEnvironment,
  overrides: BackendRuntimeOverrides,
): BackendApi {
  return new BackendApi({
    config: parsed.backend,
    paymaster: overrides.paymaster ?? new AvnuPaymasterPort(parsed.paymaster),
    rpc: overrides.rpc ?? new StarknetRpcPoolPort(parsed.rpc),
    swapPlanner: overrides.swapPlanner ?? new AvnuSwapPlanner(parsed.swapPlanner),
    authorizations: new HmacAuthorizationCodec(parsed.authorizationSecret),
  });
}

type FetchHandler = (request: Request) => Promise<Response>;

async function serveFetchRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: FetchHandler,
): Promise<void> {
  const abort = new AbortController();
  const abortRequest = () => abort.abort(new DOMException('Request aborted.', 'AbortError'));
  const abortResponse = () => {
    if (!outgoing.writableEnded) abortRequest();
  };
  incoming.once('aborted', abortRequest);
  outgoing.once('close', abortResponse);

  try {
    const request = toFetchRequest(incoming, abort.signal);
    const response = await handler(request);
    if (outgoing.destroyed) return;
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (outgoing.destroyed) return;
    outgoing.statusCode = 500;
    outgoing.setHeader('cache-control', 'no-store');
    outgoing.setHeader('content-type', 'application/json; charset=utf-8');
    outgoing.setHeader('x-content-type-options', 'nosniff');
    outgoing.end(JSON.stringify({
      code: 'INTERNAL_FAILURE',
      message: 'The private service could not process the request.',
    }));
  } finally {
    incoming.off('aborted', abortRequest);
    outgoing.off('close', abortResponse);
  }
}

function toFetchRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const method = incoming.method ?? 'GET';
  const headers = new Headers();
  copyHeader(incoming, headers, 'content-type');
  copyHeader(incoming, headers, 'content-length');
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(`http://backend.invalid${incoming.url ?? '/'}`, init);
}

function copyHeader(incoming: IncomingMessage, headers: Headers, name: string): void {
  const value = incoming.headers[name];
  if (typeof value === 'string') headers.set(name, value);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
