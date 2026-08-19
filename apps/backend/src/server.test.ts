import { describe, expect, it, vi } from 'vitest';
import { parseBackendEnvironment } from './environment.js';
import {
  createBackendRuntime,
  listenBackendServer,
  registerBackendShutdown,
} from './runtime.js';
import type { PaymasterPort, PoolRpcPort, SwapPlannerPort } from './types.js';

const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const POOL = '0x123';
const STRK = '0x4718';

function shutdownHarness() {
  const listeners = new Map<'SIGTERM' | 'SIGINT', Set<() => void>>([
    ['SIGTERM', new Set()],
    ['SIGINT', new Set()],
  ]);
  const exit = vi.fn((_code: 0 | 1) => undefined);
  return {
    lifecycle: {
      listen(signal: 'SIGTERM' | 'SIGINT', listener: () => void) {
        listeners.get(signal)!.add(listener);
        return () => listeners.get(signal)!.delete(listener);
      },
      exit,
    },
    emit(signal: 'SIGTERM' | 'SIGINT') {
      for (const listener of [...listeners.get(signal)!]) listener();
    },
    exit,
    listeners(signal: 'SIGTERM' | 'SIGINT') {
      return [...listeners.get(signal)!];
    },
    listenerCount(signal: 'SIGTERM' | 'SIGINT') {
      return listeners.get(signal)!.size;
    },
  };
}

async function settleShutdown(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function validEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PORT: '8080',
    STARKNET_RPC_URL: 'https://rpc.invalid/v3/private-key',
    STRK20_POOL_ADDRESS: POOL,
    STRK20_FEE_TOKEN: STRK,
    STRK20_NOTE_MATURITY_BLOCKS: '10',
    AVNU_PAYMASTER_API_KEY: 'private-paymaster-key',
    AVNU_PAYMASTER_BASE_URL: '',
    AVNU_BASE_URL: '',
    STARKNET_CHAIN_ID: 'SN_MAIN',
    FEE_AUTHORIZATION_SECRET: 'hmac-secret-with-at-least-32-characters',
    BACKEND_MAX_REQUEST_BYTES: '2500000',
    BACKEND_MAX_CALLDATA_ITEMS: '256',
    BACKEND_MAX_PROOF_BYTES: '2000000',
    BACKEND_REQUEST_TIMEOUT_MS: '20000',
    BACKEND_GLOBAL_ENABLED: 'true',
    BACKEND_RATE_LIMIT_MAX_REQUESTS: '120',
    BACKEND_RATE_LIMIT_WINDOW_MS: '60000',
    BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT: '1000',
    BACKEND_SPONSORSHIP_WINDOW_MS: '3600000',
    BACKEND_QUEUE_MAX_IN_FLIGHT: '4',
    BACKEND_QUEUE_MAX_QUEUED: '64',
    BACKEND_ROUTE_TRANSFER_ENABLED: 'true',
    BACKEND_ROUTE_TRANSFER_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS: '45000',
    BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS: `${STRK},0xabc`,
    BACKEND_ROUTE_UNSHIELD_ENABLED: 'true',
    BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS: '45000',
    BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS: `${STRK},0xabc`,
    BACKEND_ROUTE_SWAP_ENABLED: 'true',
    BACKEND_ROUTE_SWAP_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_SWAP_ALLOWED_TOKENS: `${STRK},0xabc`,
    BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS: '50',
    ...overrides,
  };
}

describe('strict production backend environment', () => {
  it('constructs fixed route semantics and normalizes the named mainnet chain', () => {
    const parsed = parseBackendEnvironment(validEnvironment());
    expect(parsed.port).toBe(8080);
    expect(parsed.swapPlanner.chainId).toBe(MAINNET_CHAIN_ID);
    expect(parsed.backend.routes.transfer).toMatchObject({ quoteBound: false, maxQueueDelayMs: 45_000 });
    expect(parsed.backend.routes.unshield).toMatchObject({ quoteBound: false, maxQueueDelayMs: 45_000 });
    expect(parsed.backend.routes.swap).toMatchObject({ quoteBound: true, maxQueueDelayMs: 0 });
  });

  it('accepts the maximum request timeout supported by the Node timer', () => {
    const parsed = parseBackendEnvironment(validEnvironment({
      BACKEND_REQUEST_TIMEOUT_MS: '2147483647',
    }));
    expect(parsed.backend.requestTimeoutMs).toBe(2_147_483_647);
  });

  it.each([
    ['placeholder secret', { AVNU_PAYMASTER_API_KEY: 'REPLACE_WITH_AVNU_PAYMASTER_KEY' }],
    ['malformed boolean', { BACKEND_GLOBAL_ENABLED: 'yes' }],
    ['unsafe integer', { BACKEND_MAX_PROOF_BYTES: '9007199254740992' }],
    ['port overflow', { PORT: '65536' }],
    ['request timeout overflow', { BACKEND_REQUEST_TIMEOUT_MS: '2147483648' }],
    ['fee overflow', { BACKEND_ROUTE_TRANSFER_MAX_RELAY_FEE: (1n << 128n).toString() }],
    ['immediate transfer', { BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS: '0' }],
    ['delayed swap', { BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS: '1' }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseBackendEnvironment(validEnvironment(override))).toThrow(/invalid|required/i);
  });

  it('never includes a rejected secret value in its error', () => {
    const exposed = 'REPLACE_WITH_SUPER_SENSITIVE_VALUE';
    try {
      parseBackendEnvironment(validEnvironment({ FEE_AUTHORIZATION_SECRET: exposed }));
      throw new Error('Expected environment parsing to fail.');
    } catch (error) {
      expect(String(error)).not.toContain(exposed);
      expect(String(error)).toContain('FEE_AUTHORIZATION_SECRET');
    }
  });
});

describe('production backend composition and HTTP listener', () => {
  it('serves the strict Fetch edge on an ephemeral port with one process-local API', async () => {
    const paymaster: PaymasterPort = {
      buildFee: vi.fn(async () => ({ token: STRK, recipient: '0x789', amount: 7n })),
      submit: vi.fn(async () => ({ transactionHash: '0x5ab' })),
    };
    const rpc: PoolRpcPort = {
      getPoolConfig: vi.fn(async () => ({
        feeAmount: 6n,
        feeToken: STRK,
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      })),
      getPublicKey: vi.fn(async () => '0x99'),
      getReceipt: vi.fn(async (transactionHash) => ({ transactionHash, status: 'ACCEPTED_ON_L2' })),
      getBlockNumber: vi.fn(async () => 1_000),
    };
    const swapPlanner: SwapPlannerPort = {
      prepare: vi.fn(async () => ({
        quoteId: 'quote-1',
        buyAmount: 1n,
        expiresAt: Date.now() + 60_000,
        chainId: MAINNET_CHAIN_ID,
        executorAddress: '0x999',
        executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', selector: '0x555', calldata: [] }],
      })),
    };
    const runtime = createBackendRuntime(validEnvironment(), { paymaster, rpc, swapPlanner });
    const running = await listenBackendServer(runtime.server, { port: 0 });

    try {
      expect(running.address.address).toBe('0.0.0.0');
      const base = `http://127.0.0.1:${running.address.port}`;
      const response = await fetch(`${base}/v1/rpc/pool-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1 }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        feeAmount: '6', feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get(['cross-origin', 'opener-policy'].join('-'))).toBeNull();
      expect(response.headers.get(['cross-origin', 'embedder-policy'].join('-'))).toBeNull();

      const health = await fetch(`${base}/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1 }),
      });
      expect(health.status).toBe(404);
      expect(runtime.api.metrics.snapshot().requests).toBe(2);
    } finally {
      await running.close();
    }
    expect(runtime.server.listening).toBe(false);
  });
});

describe('production backend shutdown lifecycle', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('closes cleanly and exits zero on %s', async (signal) => {
    const harness = shutdownHarness();
    const close = vi.fn(async () => undefined);
    registerBackendShutdown(close, harness.lifecycle);

    harness.emit(signal);
    await settleShutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.listenerCount('SIGTERM')).toBe(0);
    expect(harness.listenerCount('SIGINT')).toBe(0);
  });

  it('coalesces duplicate and cross-signal shutdown requests into one close', async () => {
    const harness = shutdownHarness();
    const close = vi.fn(async () => undefined);
    registerBackendShutdown(close, harness.lifecycle);
    const term = harness.listeners('SIGTERM')[0]!;
    const interrupt = harness.listeners('SIGINT')[0]!;

    term();
    interrupt();
    term();
    await settleShutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('accepts shutdown while the running server is not available yet', async () => {
    const harness = shutdownHarness();
    const close = vi.fn(async () => undefined);
    let publishRunning!: () => void;
    const starting = new Promise<{ close(): Promise<void> }>((resolve) => {
      publishRunning = () => resolve({ close });
    });
    registerBackendShutdown(async () => (await starting).close(), harness.lifecycle);

    harness.emit('SIGTERM');
    harness.emit('SIGINT');
    await Promise.resolve();

    expect(close).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();

    publishRunning();
    await settleShutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ['a synchronous close throw', () => { throw new Error('close failed'); }],
    ['an asynchronous close rejection', () => Promise.reject(new Error('close failed'))],
  ])('exits nonzero after %s', async (_label, closeImplementation) => {
    const harness = shutdownHarness();
    const close = vi.fn(closeImplementation);
    registerBackendShutdown(close, harness.lifecycle);

    expect(() => harness.emit('SIGTERM')).not.toThrow();
    await settleShutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('disposes listeners idempotently and ignores captured late signals', async () => {
    const harness = shutdownHarness();
    const close = vi.fn(async () => undefined);
    const dispose = registerBackendShutdown(close, harness.lifecycle);
    const captured = harness.listeners('SIGTERM')[0]!;

    dispose();
    dispose();
    captured();
    await settleShutdown();

    expect(harness.listenerCount('SIGTERM')).toBe(0);
    expect(harness.listenerCount('SIGINT')).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
  });

  it('always exits once after a signal is accepted, even if the disposer is called later', async () => {
    const harness = shutdownHarness();
    let finishClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    const dispose = registerBackendShutdown(close, harness.lifecycle);

    harness.emit('SIGTERM');
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    dispose();
    finishClose();
    await settleShutdown();

    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('removes only its own signal listeners and leaves existing listeners unchanged', async () => {
    const harness = shutdownHarness();
    const existingTerm = vi.fn();
    const existingInterrupt = vi.fn();
    harness.lifecycle.listen('SIGTERM', existingTerm);
    harness.lifecycle.listen('SIGINT', existingInterrupt);
    const close = vi.fn(async () => undefined);
    const dispose = registerBackendShutdown(close, harness.lifecycle);

    expect(harness.listenerCount('SIGTERM')).toBe(2);
    expect(harness.listenerCount('SIGINT')).toBe(2);
    dispose();
    harness.emit('SIGTERM');
    harness.emit('SIGINT');
    await settleShutdown();

    expect(existingTerm).toHaveBeenCalledTimes(1);
    expect(existingInterrupt).toHaveBeenCalledTimes(1);
    expect(harness.listenerCount('SIGTERM')).toBe(1);
    expect(harness.listenerCount('SIGINT')).toBe(1);
    expect(close).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
  });
});
