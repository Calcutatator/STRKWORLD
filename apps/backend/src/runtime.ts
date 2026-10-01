import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { BackendApi } from './api.js';
import { HmacAuthorizationCodec } from './authorization.js';
import { AvnuDegenCatalog } from './avnu-degen-catalog.js';
import { AvnuPaymasterPort } from './avnu-paymaster.js';
import { AvnuSwapPlanner } from './avnu-swap-planner.js';
import type { DebugLogSink } from './debug-logs.js';
import {
  parseBackendEnvironment,
  type Environment,
  type ParsedBackendEnvironment,
} from './environment.js';
import { createBackendFetchHandler } from './http.js';
import { HttpPoolValueSource, PoolStatsCache, isPoolStatsRpc } from './pool-stats.js';
import { relayStartupNotice } from './relay.js';
import { StarknetRpcPoolPort } from './starknet-rpc.js';
import type {
  BorrowRpcPort,
  DegenCatalogPort,
  PaymasterPort,
  PoolRpcPort,
  PoolStatsPort,
  SwapPlannerPort,
  VaultRatesPort,
  VaultRpcPort,
  EndurRpcPort,
} from './types.js';
import { VesuVaultRates } from './vesu-rates.js';

export interface BackendRuntimeOverrides {
  paymaster?: PaymasterPort;
  rpc?: PoolRpcPort;
  swapPlanner?: SwapPlannerPort;
  degenCatalog?: DegenCatalogPort;
  /** The Privacy Plaza's pool stats (D-076); by default a cache over the RPC port. */
  poolStats?: PoolStatsPort;
  /** Vesu's supply APY for the Vault (D-079); by default a cached read of Vesu's public API. */
  vaultRates?: VaultRatesPort;
  /** The D-069 debug sink, with a test writer in place of stdout. */
  debugLogs?: DebugLogSink;
}

export interface BackendRuntime {
  api: BackendApi;
  server: Server;
  port: number;
  /**
   * The relay's one startup line when enabled routes will be refused for want
   * of an avnu key (D-070), or null. The entry point prints it once; nothing
   * here prints per request (D-014).
   */
  startupNotice: string | null;
}

export interface ListenBackendServerOptions {
  port: number;
}

export interface RunningBackendServer {
  address: { address: string; family: string; port: number };
  close(): Promise<void>;
}

export type BackendShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface BackendShutdownLifecycle {
  listen(signal: BackendShutdownSignal, listener: () => void): () => void;
  exit(code: 0 | 1): void;
}

const processShutdownLifecycle: BackendShutdownLifecycle = {
  listen(signal, listener) {
    process.once(signal, listener);
    return () => process.off(signal, listener);
  },
  exit(code) {
    process.exit(code);
  },
};

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

  return { api, server, port: parsed.port, startupNotice: relayStartupNotice(api.relayRefusedRoutes()) };
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
        void closeServer(server).catch(() => undefined).finally(() => {
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
    try {
      server.listen(options.port, '0.0.0.0');
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

/** Close the live listener once and finish with an explicit process status. */
export function registerBackendShutdown(
  close: () => Promise<void>,
  lifecycle: BackendShutdownLifecycle = processShutdownLifecycle,
): () => void {
  const removers: Array<() => void> = [];
  let active = true;
  const detach = () => {
    for (const remove of removers.splice(0)) remove();
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    detach();
  };
  const shutdown = () => {
    if (!active) return;
    active = false;
    detach();
    void Promise.resolve().then(close).then(
      () => lifecycle.exit(0),
      () => lifecycle.exit(1),
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    try {
      const remove = lifecycle.listen(signal, shutdown);
      if (active) removers.push(remove);
      else remove();
    } catch (error) {
      active = false;
      detach();
      throw error;
    }
  }
  return dispose;
}

function createBackendApi(
  parsed: ParsedBackendEnvironment,
  overrides: BackendRuntimeOverrides,
): BackendApi {
  // D-067: composed only while the BACKEND_DEGEN_* group is present. It makes
  // no request until a player opens the degen counter or quotes a degen swap.
  const degen = parsed.backend.degen;
  const avnuBaseUrl = parsed.swapPlanner.baseUrl;
  const rpc = overrides.rpc ?? new StarknetRpcPoolPort(parsed.rpc);
  // D-076: the plaza's stats read the same private RPC, in the background,
  // and only when the port offers their narrow reads. D-080: its USD value
  // comes from a separate, public, no-key aggregate, read backend-side only.
  const poolStats = overrides.poolStats ?? (isPoolStatsRpc(rpc)
    ? new PoolStatsCache({ rpc, poolValue: new HttpPoolValueSource(parsed.poolValue) })
    : undefined);
  // D-077: the Vault's two pinned reads use the same private RPC, when the
  // port offers them. D-079: Vesu's rates come from its public API, fetched
  // by this service alone, and only once a request asks.
  const vault = isVaultRpc(rpc) ? rpc : undefined;
  // D-085: unstaking's pinned reads, on the same private RPC.
  const endur = isEndurRpc(rpc) ? rpc : undefined;
  const vaultRates = overrides.vaultRates ?? new VesuVaultRates();
  // D-083: the Borrow counter's two pinned reads use the same private RPC,
  // when the port offers them.
  const borrow = isBorrowRpc(rpc) ? rpc : undefined;
  return new BackendApi({
    config: parsed.backend,
    paymaster: overrides.paymaster ?? new AvnuPaymasterPort(parsed.paymaster),
    rpc,
    ...(poolStats ? { poolStats } : {}),
    ...(vault ? { vault } : {}),
    ...(endur ? { endur } : {}),
    vaultRates,
    ...(borrow ? { borrow } : {}),
    swapPlanner: overrides.swapPlanner ?? new AvnuSwapPlanner(parsed.swapPlanner),
    ...(degen ? {
      degenCatalog: overrides.degenCatalog ?? new AvnuDegenCatalog({
        config: degen,
        ...(avnuBaseUrl ? { baseUrl: avnuBaseUrl } : {}),
      }),
    } : {}),
    authorizations: new HmacAuthorizationCodec(parsed.authorizationSecret),
    // D-069: constructed either way; only BACKEND_DEBUG_LOGS_ENABLED=true routes to it.
    ...(overrides.debugLogs ? { debugLogs: overrides.debugLogs } : {}),
  });
}

/** Whether an RPC port offers unstaking's narrow read (D-085). */
function isEndurRpc(value: unknown): value is EndurRpcPort {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Partial<Record<keyof EndurRpcPort, unknown>>).getEndurUnstake === 'function';
}

/** Whether an RPC port offers the Vault's narrow reads (D-077). */
function isVaultRpc(value: unknown): value is VaultRpcPort {
  if (!value || typeof value !== 'object') return false;
  const port = value as Partial<Record<keyof VaultRpcPort, unknown>>;
  return typeof port.getShadowAccount === 'function' && typeof port.getVaultPositions === 'function';
}

/** Whether an RPC port offers the Borrow counter's narrow reads (D-083). */
function isBorrowRpc(value: unknown): value is BorrowRpcPort {
  if (!value || typeof value !== 'object') return false;
  const port = value as Partial<Record<keyof BorrowRpcPort, unknown>>;
  return typeof port.getBorrowMarket === 'function' && typeof port.getBorrowPositions === 'function';
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
  copyHeader(incoming, headers, 'content-encoding');
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
