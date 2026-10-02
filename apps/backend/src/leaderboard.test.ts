import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from 'starknet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendApi } from './api.js';
import { MemoryAuthorizationCodec } from './authorization.js';
import { PerClientRateLimiter } from './client-key.js';
import { parseBackendEnvironment } from './environment.js';
import {
  COUNT_OF_SELECTOR,
  LB_CHECK_IN_PATH,
  LB_COUNTS_PATH,
  LB_HISTOGRAM_PATH,
  LB_SHADOWS_PATH,
  LEADERBOARD_DAPP_NAME,
  LEADERBOARD_SEASON,
  LEADERBOARD_SHADOW_PAGE,
  LeaderboardService,
  LeaderboardStore,
  MAX_LEADERBOARD_RECEIPTS,
  leaderboardEntryKey,
  receiptCommitment,
  type LeaderboardRpcPort,
} from './leaderboard.js';
import { StarknetRpcPoolPort } from './starknet-rpc.js';
import type { ApiRequest, BackendConfig, PoolRpcPort } from './types.js';
import {
  LEADERBOARD_DAPP_NAME as PRIVACY_DAPP_NAME,
  LEADERBOARD_SEASON as PRIVACY_SEASON,
  LEADERBOARD_SHADOW_PAGE as PRIVACY_PAGE,
  MAX_LEADERBOARD_RECEIPTS as PRIVACY_MAX,
  shadowCommitment,
} from '../../../packages/privacy/src/leaderboard.js';
import { SHADOW_ACCOUNT_ANONYMIZER } from './vault.js';

/**
 * Leaderboard phase 1's blind tally: it recounts a player's receipts on-chain
 * from `p`, stores only a hash of `p` and the count, never logs or keeps `p`
 * or the client's address, and answers the season's histogram, counts only.
 */

const POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const LEDGER = '0x1ed6e7';
const P = '0x1b5eed51de';
const NOW = Date.UTC(2026, 9, 2, 15, 47, 12);
const DAY = Date.UTC(2026, 9, 2);

/** A chain where `deployed[p]` lists the receipt nonces of `p`, and each counts once unless `counts` says otherwise. */
function chain(deployed: Record<string, number[]>, counts: Record<string, bigint> = {}) {
  const shadowCalls: unknown[][] = [];
  const countCalls: unknown[][] = [];
  const rpc: LeaderboardRpcPort = {
    getLeaderboardShadows: vi.fn(async (partial: string, start: number, count: number) => {
      shadowCalls.push([partial, start, count]);
      return Array.from({ length: count }, (_, index) => ({
        nonce: start + index,
        address: '0x123',
        deployed: (deployed[partial] ?? []).includes(start + index),
      }));
    }),
    getLeaderboardCounts: vi.fn(async (ledger: string, commitments: readonly string[]) => {
      countCalls.push([ledger, [...commitments]]);
      return commitments.map((commitment) => counts[commitment] ?? 1n);
    }),
  };
  return { rpc, shadowCalls, countCalls };
}

function service(rpc: LeaderboardRpcPort, store = new LeaderboardStore(null), extra: Partial<ConstructorParameters<typeof LeaderboardService>[0]> = {}) {
  return new LeaderboardService({ config: { ledger: LEDGER, storePath: null }, rpc, store, now: () => NOW, ...extra });
}

const checkIn = (partialCommitment: string, client = 'c0'): ApiRequest => ({
  method: 'POST', path: LB_CHECK_IN_PATH, body: { v: 1, season: 's1', partialCommitment }, client,
});
const signal = () => new AbortController().signal;

function apiWith(options: { leaderboard?: LeaderboardService; enabled?: boolean } = {}) {
  const rpc: PoolRpcPort = {
    getPoolConfig: vi.fn(async () => ({ feeAmount: 6n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 })),
    getPublicKey: vi.fn(async () => '0x0'),
    getReceipt: vi.fn(async () => null),
    getBlockNumber: vi.fn(async () => 1),
  };
  const route = { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [STRK] };
  const config: BackendConfig = {
    poolAddress: POOL,
    feeToken: STRK,
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: { transfer: route, unshield: route, swap: { ...route, quoteBound: true, maxSlippageBps: 50 } },
    ...(options.enabled === false ? {} : { leaderboard: { ledger: LEDGER, storePath: null } }),
  };
  return new BackendApi({
    config,
    paymaster: { buildFee: vi.fn(), submit: vi.fn() },
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    ...(options.leaderboard ? { leaderboard: options.leaderboard } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the pinned season, selector and hashes', () => {
  it('names count_of by its own sn_keccak, and the season as the privacy package does', () => {
    expect(BigInt(COUNT_OF_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('count_of')));
    expect(LEADERBOARD_DAPP_NAME).toBe(PRIVACY_DAPP_NAME);
    expect(LEADERBOARD_SEASON).toBe(PRIVACY_SEASON);
    expect(LEADERBOARD_SHADOW_PAGE).toBe(PRIVACY_PAGE);
    expect(MAX_LEADERBOARD_RECEIPTS).toBe(PRIVACY_MAX);
  });

  it('derives each receipt\'s commitment exactly as the browser does', () => {
    for (const nonce of [0, 1, 77]) expect(BigInt(receiptCommitment(P, nonce))).toBe(BigInt(shadowCommitment(P, BigInt(nonce))));
  });

  it('keys an entry by a domain-separated hash that is neither p nor any receipt commitment', () => {
    const key = leaderboardEntryKey('s1', P);
    expect(BigInt(key)).not.toBe(BigInt(P));
    for (let nonce = 0; nonce < 64; nonce += 1) expect(BigInt(key)).not.toBe(BigInt(receiptCommitment(P, nonce)));
    expect(leaderboardEntryKey('s1', P)).toBe(key);
    expect(leaderboardEntryKey('s2', P)).not.toBe(key);
  });
});

describe('the blind check-in', () => {
  it('recounts on-chain from p and stores only the hash, the count and the day', async () => {
    const { rpc, countCalls } = chain({ [P]: [0, 1, 2, 4] }, { [receiptCommitment(P, 4)]: 2n });
    const store = new LeaderboardStore(null);
    const lb = service(rpc, store);
    const response = await lb.handle(checkIn(P), signal());
    expect(response).toEqual({ status: 200, body: { count: '5' } });
    expect(store.snapshot()).toEqual({ s1: { [leaderboardEntryKey('s1', P)]: { count: 5, day: DAY } } });
    // p is in no stored key or value.
    expect(JSON.stringify(store.snapshot())).not.toContain(BigInt(P).toString(16));
    // Counts are read on the configured ledger, for the deployed receipts only.
    expect(countCalls).toEqual([[LEDGER, [0, 1, 2, 4].map((nonce) => receiptCommitment(P, nonce))]]);
  });

  it('refreshes the same entry on a second check-in, never adding a second one', async () => {
    const deployed: Record<string, number[]> = { [P]: [0] };
    const { rpc } = chain(deployed);
    const store = new LeaderboardStore(null);
    const lb = service(rpc, store);
    await lb.handle(checkIn(P), signal());
    deployed[P] = [0, 1, 2];
    await lb.handle(checkIn(P), signal());
    expect(store.histogram('s1')).toEqual({ season: 's1', total: 1, buckets: [{ count: 3, players: 1 }] });
  });

  it('stores nothing for a commitment with no receipts, so random felts cannot pad the ranking', async () => {
    const store = new LeaderboardStore(null);
    const lb = service(chain({}).rpc, store);
    await expect(lb.handle(checkIn('0x777'), signal())).resolves.toEqual({ status: 200, body: { count: '0' } });
    expect(store.snapshot()).toEqual({});
  });

  it('pages on while a page still holds receipts, over a gap', async () => {
    const { rpc, shadowCalls } = chain({ [P]: [3, 127, 128, 200] });
    const lb = service(rpc);
    await expect(lb.handle(checkIn(P), signal())).resolves.toEqual({ status: 200, body: { count: '4' } });
    expect(shadowCalls.map((call) => call[1])).toEqual([0, 128, 256]);
  });

  it.each([
    ['an unknown season', { v: 1, season: 's0', partialCommitment: P }],
    ['an address beside p', { v: 1, season: 's1', partialCommitment: P, address: '0xabc' }],
    ['a signature beside p', { v: 1, season: 's1', partialCommitment: P, signature: ['0x1'] }],
    ['a zero commitment', { v: 1, season: 's1', partialCommitment: '0x0' }],
  ])('refuses %s', async (_label, body) => {
    const store = new LeaderboardStore(null);
    const lb = service(chain({ [P]: [0] }).rpc, store);
    await expect(lb.handle({ method: 'POST', path: LB_CHECK_IN_PATH, body, client: 'c0' }, signal())).rejects.toMatchObject({ status: 400 });
    expect(store.snapshot()).toEqual({});
  });

  it('rate-limits check-ins per client: three at once, then 429', async () => {
    const lb = service(chain({ [P]: [0] }).rpc);
    for (let i = 0; i < 3; i += 1) await expect(lb.handle(checkIn(P, 'same'), signal())).resolves.toMatchObject({ status: 200 });
    await expect(lb.handle(checkIn(P, 'same'), signal())).resolves.toMatchObject({ status: 429 });
    await expect(lb.handle(checkIn(P, 'other'), signal())).resolves.toMatchObject({ status: 200 });
  });

  it('rate-limits every route per client', async () => {
    const lb = service(chain({}).rpc, new LeaderboardStore(null), { clientLimiter: new PerClientRateLimiter(2, 60_000, () => NOW) });
    const read: ApiRequest = { method: 'GET', path: LB_HISTOGRAM_PATH, body: undefined, client: 'x' };
    await lb.handle(read, signal());
    await lb.handle(read, signal());
    await expect(lb.handle(read, signal())).resolves.toMatchObject({ status: 429 });
  });

  it('never logs p or the client key, on success or on a node failure', async () => {
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    const ok = service(chain({ [P]: [0] }).rpc);
    const okApi = apiWith({ leaderboard: ok });
    await okApi.handle({ ...checkIn(P, 'deadbeefdeadbeefdeadbeefdeadbeef') });
    const broken: LeaderboardRpcPort = {
      getLeaderboardShadows: vi.fn(async () => { throw new Error(`node refused ${P}`); }),
      getLeaderboardCounts: vi.fn(async () => []),
    };
    const failed = await apiWith({ leaderboard: service(broken) }).handle(checkIn(P, 'deadbeefdeadbeefdeadbeefdeadbeef'));
    expect(failed).toEqual({ status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } });
    const text = JSON.stringify(logged);
    expect(text).not.toContain(BigInt(P).toString(16));
    expect(text).not.toContain('deadbeef');
  });
});

describe('the reads the browser makes', () => {
  it('answers one shadow page and the ledger counts, and nothing it was not asked', async () => {
    const { rpc } = chain({ [P]: [1] }, { '0xc1': 3n });
    const lb = service(rpc);
    const page = await lb.handle({ method: 'POST', path: LB_SHADOWS_PATH, body: { v: 1, partialCommitment: P, page: 0 }, client: 'c' }, signal());
    expect((page.body as { rows: unknown[] }).rows).toHaveLength(LEADERBOARD_SHADOW_PAGE);
    expect((page.body as { rows: unknown[] }).rows[1]).toEqual({ nonce: 1, address: '0x123', deployed: true });
    const counts = await lb.handle({ method: 'POST', path: LB_COUNTS_PATH, body: { v: 1, commitments: ['0xc1', '0xc2'] }, client: 'c' }, signal());
    expect(counts).toEqual({ status: 200, body: { counts: ['3', '1'] } });
    await expect(lb.handle({ method: 'POST', path: LB_SHADOWS_PATH, body: { v: 1, partialCommitment: P, page: 8 }, client: 'c' }, signal()))
      .rejects.toMatchObject({ status: 400 });
    await expect(lb.handle({ method: 'POST', path: LB_COUNTS_PATH, body: { v: 1, commitments: Array(129).fill('0x1') }, client: 'c' }, signal()))
      .rejects.toMatchObject({ status: 400 });
  });

  it('answers the histogram to anyone, counts only', async () => {
    const store = new LeaderboardStore(null);
    store.upsert('s1', '0xa', 3, NOW);
    store.upsert('s1', '0xb', 1, NOW);
    store.upsert('s1', '0xc', 3, NOW);
    const lb = service(chain({}).rpc, store);
    const response = await lb.handle({ method: 'GET', path: LB_HISTOGRAM_PATH, body: undefined }, signal());
    expect(response).toEqual({ status: 200, body: { season: 's1', total: 3, buckets: [{ count: 1, players: 1 }, { count: 3, players: 2 }] } });
    expect(JSON.stringify(response.body)).not.toMatch(/0xa|0xb|0xc/);
  });
});

describe('behind BACKEND_LEADERBOARD_ENABLED', () => {
  it('is no route at all while off', async () => {
    const api = apiWith({ enabled: false, leaderboard: service(chain({}).rpc) });
    await expect(api.handle(checkIn(P))).resolves.toMatchObject({ status: 404 });
    await expect(api.handle({ method: 'GET', path: LB_HISTOGRAM_PATH, body: undefined })).resolves.toMatchObject({ status: 405 });
  });

  it('routes through the API while on, GET for the histogram and POST for the rest', async () => {
    const api = apiWith({ leaderboard: service(chain({ [P]: [0] }).rpc) });
    await expect(api.handle(checkIn(P))).resolves.toEqual({ status: 200, body: { count: '1' } });
    await expect(api.handle({ method: 'GET', path: LB_HISTOGRAM_PATH, body: undefined }))
      .resolves.toEqual({ status: 200, body: { season: 's1', total: 1, buckets: [{ count: 1, players: 1 }] } });
    await expect(api.handle({ method: 'GET', path: LB_CHECK_IN_PATH, body: undefined })).resolves.toMatchObject({ status: 405 });
  });

  it('parses the switch, the ledger and the file from the environment', () => {
    const base: Record<string, string> = {
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
    };
    expect(parseBackendEnvironment(base).backend.leaderboard).toBeUndefined();
    expect(parseBackendEnvironment({ ...base, BACKEND_LEADERBOARD_ENABLED: 'false' }).backend.leaderboard).toBeUndefined();
    expect(parseBackendEnvironment({ ...base, BACKEND_LEADERBOARD_ENABLED: 'true', BACKEND_LEADERBOARD_LEDGER: LEDGER }).backend.leaderboard)
      .toEqual({ ledger: LEDGER, storePath: null });
    expect(parseBackendEnvironment({ ...base, BACKEND_LEADERBOARD_ENABLED: 'true', BACKEND_LEADERBOARD_LEDGER: LEDGER, BACKEND_LEADERBOARD_FILE: '/data/lb.json' }).backend.leaderboard)
      .toEqual({ ledger: LEDGER, storePath: '/data/lb.json' });
    expect(() => parseBackendEnvironment({ ...base, BACKEND_LEADERBOARD_ENABLED: 'true' })).toThrow('BACKEND_LEADERBOARD_LEDGER');
    expect(() => parseBackendEnvironment({ ...base, BACKEND_LEADERBOARD_ENABLED: 'true', BACKEND_LEADERBOARD_LEDGER: LEDGER, BACKEND_LEADERBOARD_FILE: 'lb.json' }))
      .toThrow('Invalid BACKEND_LEADERBOARD_FILE.');
  });
});

describe('the tally file', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('survives a restart, and holds nothing but keys, counts and days', async () => {
    dir = await mkdtemp(join(tmpdir(), 'strkworld-lb-'));
    const path = join(dir, 'leaderboard.json');
    const store = new LeaderboardStore(path);
    await store.load();
    await service(chain({ [P]: [0, 1] }).rpc, store).handle(checkIn(P), signal());
    await store.flushed();
    const text = await readFile(path, 'utf8');
    expect(JSON.parse(text)).toEqual({ v: 1, seasons: { s1: { [leaderboardEntryKey('s1', P)]: { count: 2, day: DAY } } } });
    expect(text).not.toContain(BigInt(P).toString(16));
    const again = new LeaderboardStore(path);
    await again.load();
    expect(again.histogram('s1')).toEqual({ season: 's1', total: 1, buckets: [{ count: 2, players: 1 }] });
  });

  it('refuses a malformed file rather than ranking against it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'strkworld-lb-'));
    const path = join(dir, 'leaderboard.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ v: 1, seasons: { s1: { '0xa': { count: 1, day: 5, ip: '1.2.3.4' } } } }));
    await expect(new LeaderboardStore(path).load()).rejects.toThrow('malformed');
    const lb = service(chain({}).rpc, new LeaderboardStore(path), { ready: Promise.reject(new Error('x')) });
    await expect(lb.handle({ method: 'GET', path: LB_HISTOGRAM_PATH, body: undefined }, signal())).rejects.toMatchObject({ status: 503 });
  });
});

describe('the RPC reads, pinned', () => {
  function rpcAnswering(result: (request: { method: string; params: unknown[] }) => unknown) {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
      const list = Array.isArray(body) ? body : [body];
      requests.push(...list);
      const answers = list.map((request) => ({ jsonrpc: '2.0', id: request.id, result: result(request) }));
      return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
    });
    return { rpc: new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher }), requests };
  }

  it('reads get_shadow_accounts on the canonical anonymizer, until_undeployed false, one row per nonce', async () => {
    const { rpc, requests } = rpcAnswering(() => ['0x2', '0x80', '0x111', '0x1', '0x81', '0x222', '0x0']);
    await expect(rpc.getLeaderboardShadows(P, 128, 2)).resolves.toEqual([
      { nonce: 128, address: '0x111', deployed: true },
      { nonce: 129, address: '0x222', deployed: false },
    ]);
    expect(requests[0]!.params[0]).toEqual({
      contract_address: SHADOW_ACCOUNT_ANONYMIZER,
      entry_point_selector: hash.getSelectorFromName('get_shadow_accounts'),
      calldata: [P, '0x80', '0x82', '0x0'],
    });
    const bad = rpcAnswering(() => ['0x2', '0x80', '0x111', '0x1', '0x80', '0x222', '0x0']);
    await expect(bad.rpc.getLeaderboardShadows(P, 128, 2)).rejects.toThrow('invalid shadow page');
  });

  it('reads count_of -> u64 on the ledger, refusing anything else', async () => {
    let n = 0;
    const { rpc, requests } = rpcAnswering(() => [['0x3'], ['0x2', '0x0'], [`0x${(1n << 64n).toString(16)}`]][n++]);
    await expect(rpc.getLeaderboardCounts(LEDGER, ['0xc1', '0xc2', '0xc3'])).resolves.toEqual([3n, null, null]);
    expect(requests.map((request) => (request.params[0] as { contract_address: string; entry_point_selector: string }).contract_address)).toEqual([LEDGER, LEDGER, LEDGER]);
    expect((requests[0]!.params[0] as { entry_point_selector: string }).entry_point_selector).toBe(COUNT_OF_SELECTOR);
  });
});
