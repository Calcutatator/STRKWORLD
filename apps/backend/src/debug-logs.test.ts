import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBackendEnvironment } from './environment.js';
import { createBackendFetchHandler } from './http.js';
import {
  BackendApi,
  DEBUG_LOGS_MAX_BODY_BYTES,
  DEBUG_LOGS_PATH,
  DebugLogSink,
  MemoryAuthorizationCodec,
  type BackendConfig,
  type PaymasterPort,
  type PoolRpcPort,
} from './index.js';
import { writeDebugLogLine } from './debug-logs.js';
import { createBackendRuntime, listenBackendServer } from './runtime.js';

/**
 * D-069 on the relay: the opt-in debug sink. Off, its path is exactly an
 * unknown path; on, each valid entry is one exact stdout line, within a
 * global entry limit that never touches the players' rate window.
 */

const POOL = '0x123';
const STRK = '0x4718';
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000cafe';
const T0 = Date.UTC(2026, 8, 28, 16, 0, 0);

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    poolAddress: POOL,
    feeToken: STRK,
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: {
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] },
      swap: {
        enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: true, allowedTokens: [STRK], maxSlippageBps: 300,
      },
    },
    ...overrides,
  };
}

function fixture(overrides: Partial<BackendConfig> = {}, sinkOptions: { limit?: number } = {}) {
  let clock = T0;
  const lines: string[] = [];
  const scheduled: Array<{ run: () => void; delayMs: number }> = [];
  const paymaster: PaymasterPort = { buildFee: vi.fn(), submit: vi.fn() };
  const rpc: PoolRpcPort = {
    async getPoolConfig() {
      return { feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async getPublicKey() { return '0x99'; },
    async getReceipt(hash) { return { transactionHash: hash }; },
    async getBlockNumber() { return 1_000; },
  };
  const now = () => clock;
  const api = new BackendApi({
    config: config(overrides),
    paymaster,
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    now,
    debugLogs: new DebugLogSink({
      write: (line) => lines.push(line),
      now,
      schedule: (run, delayMs) => scheduled.push({ run, delayMs }),
      ...sinkOptions,
    }),
  });
  return {
    api,
    lines,
    scheduled,
    advance(ms: number) { clock += ms; },
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return { t: T0, level: 'info', event: 'connect.state', detail: 'connected', ...overrides };
}

function batch(entries: unknown[] = [entry()], overrides: Record<string, unknown> = {}) {
  return { v: 1, session: SESSION, entries, ...overrides };
}

function post(api: BackendApi, body: unknown, path = DEBUG_LOGS_PATH) {
  return api.handle({ method: 'POST', path, body });
}

describe('the debug log route while switched off', () => {
  it.each([
    ['absent, the default', {}],
    ['switched off', { debugLogsEnabled: false }],
  ] as const)('answers exactly as an unknown route when %s', async (_label, overrides) => {
    const { api, lines } = fixture(overrides);
    const unknown = await post(api, batch(), '/v1/not-a-route');
    const debug = await post(api, batch());
    expect(unknown).toEqual({ status: 404, body: { code: 'HTTP_404', message: 'Endpoint not found.' } });
    expect(debug).toEqual(unknown);
    expect(await api.handle({ method: 'GET', path: DEBUG_LOGS_PATH, body: null }))
      .toEqual(await api.handle({ method: 'GET', path: '/v1/not-a-route', body: null }));
    expect(lines).toEqual([]);
  });

  it('shares the unknown route\'s answers under the kill switch and the rate limit too', async () => {
    const disabled = fixture({ globalEnabled: false });
    expect(await post(disabled.api, batch())).toEqual(await post(disabled.api, batch(), '/v1/not-a-route'));
    expect((await post(disabled.api, batch())).status).toBe(503);

    const limited = fixture({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    await post(limited.api, batch(), '/v1/not-a-route');
    const debug = await post(limited.api, batch());
    expect(debug).toEqual(await post(limited.api, batch(), '/v1/not-a-route'));
    expect(debug.status).toBe(429);
    expect(disabled.lines).toEqual([]);
    expect(limited.lines).toEqual([]);
  });

  it('is indistinguishable from an unknown path through the HTTP edge, oversized bodies included', async () => {
    const { api, lines } = fixture();
    const handler = createBackendFetchHandler(api);
    const send = (path: string, body: string) => handler(new Request(`https://private.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    for (const body of [JSON.stringify(batch()), JSON.stringify({ v: 1, junk: 'x'.repeat(DEBUG_LOGS_MAX_BODY_BYTES) })]) {
      const debug = await send(DEBUG_LOGS_PATH, body);
      const unknown = await send('/v1/not-a-route', body);
      expect(debug.status).toBe(404);
      expect(debug.status).toBe(unknown.status);
      expect(await debug.text()).toBe(await unknown.text());
    }
    expect(lines).toEqual([]);
  });
});

describe('the debug log route while switched on', () => {
  it('writes one exact line an entry, and nothing about the request', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    const response = await post(api, batch([
      entry(),
      entry({ t: T0 + 1_234, level: 'error', event: 'privacy.operation', detail: 'kind=not-registered code=118 NOT_REGISTERED' }),
      entry({ t: T0 + 2_000, level: 'warn', event: 'api.failure', detail: '' }),
    ]));
    expect(response).toEqual({ status: 202, body: { accepted: 3, dropped: 0 } });
    expect(lines).toEqual([
      `[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state connected`,
      `[debug] ${SESSION} 2026-09-28T16:00:01.234Z error privacy.operation kind=not-registered code=118 NOT_REGISTERED`,
      `[debug] ${SESSION} 2026-09-28T16:00:02.000Z warn api.failure`,
    ]);
  });

  it('never writes an IP or a header, even when the request carries them', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    const handler = createBackendFetchHandler(api);
    const response = await handler(new Request(`https://private.example${DEBUG_LOGS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.7',
        'user-agent': 'secret-agent/1.0',
        cookie: 'session=abc',
      },
      body: JSON.stringify(batch()),
    }));
    expect(response.status).toBe(202);
    expect(lines).toEqual([`[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state connected`]);
    expect(lines.join('\n')).not.toMatch(/203\.0\.113\.7|secret-agent|session=abc/);
  });

  it('strips every character that could split, forge or reorder a line', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    const detail = 'one\ntwo\r\n[debug] forged\tline\u0000\u0007\u001b[31m\u202e\u2066bidi\u2028sep\u0085nel\ud800end';
    expect((await post(api, batch([entry({ detail })]))).status).toBe(202);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state one two [debug] forged line[31mbidi sep nelend`,
    );
  });

  it('keeps working while the private kill switch is off, and takes no slot in the players\' rate window', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true, globalEnabled: false, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    for (let index = 0; index < 5; index += 1) {
      expect((await post(api, batch())).status).toBe(202);
    }
    expect(lines).toHaveLength(5);
    expect(api.metrics.snapshot()).toMatchObject({ requests: 0, rateLimited: 0, failures: 0 });

    const players = fixture({ debugLogsEnabled: true, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    for (let index = 0; index < 5; index += 1) await post(players.api, batch());
    const read = await players.api.handle({ method: 'POST', path: '/v1/rpc/pool-config', body: { v: 1 } });
    expect(read.status).toBe(200);
  });

  it('refuses every other method as the other POST routes do', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    expect(await api.handle({ method: 'GET', path: DEBUG_LOGS_PATH, body: null }))
      .toEqual({ status: 405, body: { code: 'HTTP_405', message: 'Method not allowed.' } });
    expect(lines).toEqual([]);
  });

  it.each([
    ['a missing body', null],
    ['an array body', [entry()]],
    ['an unknown field', { ...batch(), extra: true }],
    ['a missing field', { v: 1, session: SESSION }],
    ['another version', batch(undefined, { v: 2 })],
    ['a short session', batch(undefined, { session: 'abc1234' })],
    ['a long session', batch(undefined, { session: 'a'.repeat(65) })],
    ['a session outside the alphabet', batch(undefined, { session: 'abc_defgh' })],
    ['a numeric session', batch(undefined, { session: 12345678 })],
    ['no entries', batch([])],
    ['more than 50 entries', batch(Array.from({ length: 51 }, () => entry()))],
    ['entries that are not an array', batch(undefined, { entries: { 0: entry() } })],
    ['an entry that is not an object', batch(['connect.state'])],
    ['an entry with an unknown field', batch([{ ...entry(), ip: '203.0.113.7' }])],
    ['an entry missing its detail', batch([{ t: T0, level: 'info', event: 'connect.state' }])],
    ['a fractional time', batch([entry({ t: T0 + 0.5 })])],
    ['a negative time', batch([entry({ t: -1 })])],
    ['a time Date cannot print', batch([entry({ t: 8_640_000_000_000_001 })])],
    ['a string time', batch([entry({ t: String(T0) })])],
    ['an unknown level', batch([entry({ level: 'debug' })])],
    ['an upper-case level', batch([entry({ level: 'INFO' })])],
    ['an upper-case event', batch([entry({ event: 'Connect.state' })])],
    ['an event with a space', batch([entry({ event: 'connect state' })])],
    ['an empty event', batch([entry({ event: '' })])],
    ['an event over 64 characters', batch([entry({ event: 'e'.repeat(65) })])],
    ['a detail over 2,000 characters', batch([entry({ detail: 'd'.repeat(2_001) })])],
    ['a detail that is not text', batch([entry({ detail: { code: 118 } })])],
  ])('refuses the whole batch with %s, writing nothing', async (_label, body) => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    const response = await post(api, body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'HTTP_400' });
    expect(lines).toEqual([]);
  });

  it('refuses a malformed entry even after valid ones, writing none of them', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    expect((await post(api, batch([entry(), entry({ level: 'fatal' })]))).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it('accepts the edges: 50 entries, a 2,000-character detail, an 8 and a 64 character session', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    expect((await post(api, batch(Array.from({ length: 50 }, () => entry({ detail: '' }))))).status).toBe(202);
    expect((await post(api, batch([entry({ detail: 'd'.repeat(2_000) })]))).status).toBe(202);
    expect((await post(api, batch(undefined, { session: 'abcdEFG8' }))).status).toBe(202);
    expect((await post(api, batch(undefined, { session: 'z'.repeat(64) }))).status).toBe(202);
    expect(lines).toHaveLength(53);
    expect(lines[50]).toHaveLength(`[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state `.length + 2_000);
  });

  it('refuses a body over 32 KB as too large, writing nothing', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    const oversized = batch(Array.from({ length: 17 }, () => entry({ detail: 'd'.repeat(2_000) })));
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(DEBUG_LOGS_MAX_BODY_BYTES);
    expect(await post(api, oversized)).toEqual({
      status: 413, body: { code: 'HTTP_413', message: 'The debug log batch is too large.' },
    });
    // Counted in UTF-8 bytes: 11 details of 1,000 three-byte characters are
    // 11,000 characters but 33,000 bytes.
    const multibyte = batch(Array.from({ length: 11 }, () => entry({ detail: '€'.repeat(1_000) })));
    expect((await post(api, multibyte)).status).toBe(413);
    expect(lines).toEqual([]);
  });

  it('refuses an oversized body through the HTTP edge as well', async () => {
    const { api, lines } = fixture({ debugLogsEnabled: true });
    const handler = createBackendFetchHandler(api);
    const response = await handler(new Request(`https://private.example${DEBUG_LOGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch(Array.from({ length: 20 }, () => entry({ detail: 'd'.repeat(2_000) })))),
    }));
    expect(response.status).toBe(413);
    expect(lines).toEqual([]);
  });
});

describe('the debug log rate limit', () => {
  function fill(count: number) {
    return batch(Array.from({ length: count }, (_, index) => entry({ detail: `entry ${index}` })));
  }

  it('writes at most 600 entries a minute across all sessions, then drops and counts the rest', async () => {
    const { api, lines, scheduled } = fixture({ debugLogsEnabled: true });
    const responses = [];
    for (let index = 0; index < 12; index += 1) responses.push(await post(api, fill(50)));
    expect(lines).toHaveLength(600);
    expect(responses.every((response) => response.status === 202)).toBe(true);

    const other = await post(api, { ...fill(50), session: 'another-session-1' });
    expect(other).toEqual({ status: 202, body: { accepted: 0, dropped: 50 } });
    expect(await post(api, fill(20))).toEqual({ status: 202, body: { accepted: 0, dropped: 20 } });
    expect(lines).toHaveLength(600);
    // One summary is scheduled for the window's end, not one per batch.
    expect(scheduled).toEqual([{ run: expect.any(Function), delayMs: 60_000 }]);
  });

  it('ends a limited window with exactly one summary line when its timer fires', async () => {
    const { api, lines, scheduled, advance } = fixture({ debugLogsEnabled: true }, { limit: 3 });
    await post(api, fill(5));
    advance(10_000);
    await post(api, fill(2));
    expect(lines).toHaveLength(3);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(60_000);

    advance(50_000);
    scheduled[0]!.run();
    expect(lines.slice(3)).toEqual([
      '[debug] server 2026-09-28T16:01:00.000Z warn debug.dropped 4 entries dropped over the limit of 3 per 60 s',
    ]);
    // A new window opens with the next batch, and the old timer is spent.
    await post(api, fill(2));
    expect(lines).toHaveLength(6);
    scheduled[0]!.run();
    expect(lines).toHaveLength(6);
  });

  it('writes the summary before the next window\'s lines when a batch arrives first', async () => {
    const { api, lines, scheduled, advance } = fixture({ debugLogsEnabled: true }, { limit: 2 });
    await post(api, fill(3));
    advance(60_000);
    expect(await post(api, fill(1))).toEqual({ status: 202, body: { accepted: 1, dropped: 0 } });
    expect(lines).toEqual([
      `[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state entry 0`,
      `[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state entry 1`,
      '[debug] server 2026-09-28T16:01:00.000Z warn debug.dropped 1 entry dropped over the limit of 2 per 60 s',
      `[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state entry 0`,
    ]);
    // The late timer belongs to a window that has already closed.
    scheduled[0]!.run();
    expect(lines).toHaveLength(4);
  });

  it('writes no summary for a window that dropped nothing', async () => {
    const { api, lines, scheduled, advance } = fixture({ debugLogsEnabled: true }, { limit: 5 });
    await post(api, fill(5));
    advance(60_000);
    await post(api, fill(5));
    expect(lines).toHaveLength(10);
    expect(lines.some((line) => line.includes('debug.dropped'))).toBe(false);
    expect(scheduled).toEqual([]);
  });

  it('rejects a nonsensical limit at construction', () => {
    expect(() => new DebugLogSink({ limit: 0 })).toThrow('positive integers');
    expect(() => new DebugLogSink({ windowMs: 1.5 })).toThrow('positive integers');
  });
});

describe('the debug log writer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one line and its newline to stdout by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    writeDebugLogLine('[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info test.event hello');
    expect(write).toHaveBeenCalledWith('[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info test.event hello\n');
  });

  it('never fails the request when the writer throws', async () => {
    const api = new BackendApi({
      config: config({ debugLogsEnabled: true }),
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: { getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn() },
      authorizations: new MemoryAuthorizationCodec(),
      debugLogs: new DebugLogSink({ write: () => { throw new Error('EPIPE'); } }),
    });
    expect((await post(api, batch())).status).toBe(202);
  });
});

describe('BACKEND_DEBUG_LOGS_ENABLED', () => {
  function environment(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      PORT: '8080',
      STARKNET_RPC_URL: 'https://rpc.invalid/v3/private-key',
      STRK20_POOL_ADDRESS: POOL,
      STRK20_FEE_TOKEN: STRK,
      STRK20_NOTE_MATURITY_BLOCKS: '10',
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
      BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS: '0',
      BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS: STRK,
      BACKEND_ROUTE_UNSHIELD_ENABLED: 'true',
      BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE: '10',
      BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS: '0',
      BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS: STRK,
      BACKEND_ROUTE_SWAP_ENABLED: 'false',
      BACKEND_ROUTE_SWAP_ALLOWED_TOKENS: STRK,
      BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS: '50',
      ...overrides,
    };
  }

  it('is off when unset or empty, and on only when exactly true', () => {
    expect(parseBackendEnvironment(environment()).backend.debugLogsEnabled).toBe(false);
    expect(parseBackendEnvironment(environment({ BACKEND_DEBUG_LOGS_ENABLED: '' })).backend.debugLogsEnabled).toBe(false);
    expect(parseBackendEnvironment(environment({ BACKEND_DEBUG_LOGS_ENABLED: 'false' })).backend.debugLogsEnabled).toBe(false);
    expect(parseBackendEnvironment(environment({ BACKEND_DEBUG_LOGS_ENABLED: 'true' })).backend.debugLogsEnabled).toBe(true);
  });

  it.each(['TRUE', 'True', 'yes', '1', 'on', ' true', 'true '])('refuses to start with %j rather than guess', (value) => {
    expect(() => parseBackendEnvironment(environment({ BACKEND_DEBUG_LOGS_ENABLED: value })))
      .toThrow('Invalid BACKEND_DEBUG_LOGS_ENABLED.');
  });

  it('serves the route through the real listener only when switched on', async () => {
    const lines: string[] = [];
    const ports = {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: { getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn() },
      swapQuotes: { quote: vi.fn() },
      debugLogs: new DebugLogSink({ write: (line) => lines.push(line) }),
    };
    for (const [flag, expected] of [['true', 202], ['', 404]] as const) {
      const runtime = createBackendRuntime(environment({ BACKEND_DEBUG_LOGS_ENABLED: flag }), ports);
      const running = await listenBackendServer(runtime.server, { port: 0 });
      try {
        const response = await fetch(`http://127.0.0.1:${running.address.port}${DEBUG_LOGS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch()),
        });
        expect(response.status).toBe(expected);
      } finally {
        await running.close();
      }
    }
    expect(lines).toEqual([`[debug] ${SESSION} 2026-09-28T16:00:00.000Z info connect.state connected`]);
  });
});
