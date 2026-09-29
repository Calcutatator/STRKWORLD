import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hash } from 'starknet';
import {
  BackendApi,
  MemoryAuthorizationCodec,
  type BackendConfig,
  type PaymasterPort,
  type PoolRpcPort,
  type PoolStatsPort,
} from './index.js';
import { POOL_STATS_PATH } from './api.js';
import {
  DEPOSIT_EVENT,
  DEPOSIT_WINDOW_BLOCKS,
  POOL_FIRST_BLOCK,
  POOL_STATS_RATE_LIMIT,
  POOL_STATS_TOKENS,
  PoolStatsCache,
  VIEWING_KEY_SET_EVENT,
  isPoolStatsRpc,
} from './pool-stats.js';
import { BALANCE_OF_SELECTOR, StarknetRpcPoolPort } from './starknet-rpc.js';
import type { PoolEventsPage, PoolStatsRpcPort } from './types.js';

/**
 * The Privacy Plaza's pool stats (D-076): incremental cursor-based scans
 * behind an in-memory cache, and a route that serves aggregates only.
 */

const POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';

/** A block's hash on the fake chain. */
const hashOf = (block: number): string => `0x${(block * 7 + 0xb10c).toString(16)}`;

/**
 * A chain: events by key and block, token balances, a head, and every read
 * made. With a lag, the node answering the events trails the one that gave
 * the head, as one behind a load balancer can; like Pathfinder, it answers a
 * numeric `to_block` past its tip short, with no error, and refuses a block
 * hash it has not reached.
 */
function fakeChain(options: { head: number; pageBlocks?: number } = { head: 0 }) {
  const events = new Map<string, number[]>([[VIEWING_KEY_SET_EVENT, []], [DEPOSIT_EVENT, []]]);
  const balances = new Map<string, bigint>(POOL_STATS_TOKENS.map((token, index) => [token, BigInt(index + 1) * 10n ** 18n]));
  const reads: Array<{ key: string; from: number; to: number; hash: string | null; token: string | null }> = [];
  let head = options.head;
  let lag = 0;
  let fail: ((what: string) => boolean) | null = null;
  // Like the node: each page covers at most `pageBlocks` blocks, then hands back a cursor.
  const pageBlocks = options.pageBlocks ?? 100_000;
  const rpc: PoolStatsRpcPort = {
    async getHead() {
      if (fail?.('head')) throw new Error('head failed');
      return { number: head, hash: hashOf(head) };
    },
    async getPoolEvents(filter): Promise<PoolEventsPage> {
      const start = filter.continuationToken ? Number(filter.continuationToken) : filter.fromBlock;
      const hash = filter.toBlockHash ?? null;
      reads.push({ key: filter.key, from: filter.fromBlock, to: filter.toBlock, hash, token: filter.continuationToken ?? null });
      if (fail?.(filter.key === DEPOSIT_EVENT ? 'deposits' : `registrations:${filter.fromBlock}`)) throw new Error('events failed');
      const tip = head - lag;
      if (hash !== null && (hash !== hashOf(filter.toBlock) || filter.toBlock > tip)) throw new Error('Block not found');
      const last = Math.min(filter.toBlock, tip);
      const end = Math.min(last, start + pageBlocks - 1);
      const blocks = (events.get(filter.key) ?? []).filter((block) => block >= start && block <= end);
      return { blocks, continuationToken: end < last ? String(end + 1) : null };
    },
    async getPoolBalance(token) {
      if (fail?.('held')) throw new Error('balance failed');
      return balances.get(token) ?? 0n;
    },
  };
  return {
    rpc,
    reads,
    events,
    balances,
    setHead(value: number) {
      head = value;
    },
    /** How far the node answering the events trails the head. */
    setLag(value: number) {
      lag = value;
    },
    failWhen(test: ((what: string) => boolean) | null) {
      fail = test;
    },
    add(key: string, ...blocks: number[]) {
      events.get(key)!.push(...blocks);
    },
  };
}

/** A cache on a fake clock and a scheduler the test runs by hand. */
function cacheFor(chain: ReturnType<typeof fakeChain>, overrides: Partial<ConstructorParameters<typeof PoolStatsCache>[0]> = {}) {
  let now = 1_000_000;
  const scheduled: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const cache = new PoolStatsCache({
    rpc: chain.rpc,
    now: () => now,
    schedule: (run, ms) => {
      const entry = { at: now + ms, run, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    scanWindow: 250_000,
    ...overrides,
  });
  return {
    cache,
    scheduled: () => scheduled.filter((entry) => !entry.cancelled),
    advance(ms: number) {
      now += ms;
    },
    /** Fire every booked refresh that is due. */
    async runDue() {
      for (const entry of [...scheduled]) {
        if (entry.cancelled || entry.at > now) continue;
        entry.cancelled = true;
        entry.run();
      }
      await settle();
    },
  };
}

/** Let the background refresh's promise chain run to the end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Four scan windows' worth of blocks after the pool's first. */
const HEAD = POOL_FIRST_BLOCK + 999_999;

describe('the pool constants (D-076)', () => {
  it("pins the ViewingKeySet and Deposit event keys and balance_of's selector", () => {
    expect(BigInt(VIEWING_KEY_SET_EVENT)).toBe(BigInt(hash.getSelectorFromName('ViewingKeySet')));
    expect(BigInt(DEPOSIT_EVENT)).toBe(BigInt(hash.getSelectorFromName('Deposit')));
    expect(BigInt(BALANCE_OF_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('balance_of')));
  });

  it('starts at the pool\'s first block and counts a day of 1.68 s blocks', () => {
    expect(POOL_FIRST_BLOCK).toBe(8_978_970);
    expect(DEPOSIT_WINDOW_BLOCKS).toBe(51_429);
  });

  it("reads the balances of exactly the web Exchange catalog's tokens", () => {
    const catalog = readFileSync(new URL('../../web/src/panels/exchange/catalog.ts', import.meta.url), 'utf8');
    const listed = [...catalog.matchAll(/token: '(0x[0-9a-f]+)'/g)].map((match) => BigInt(match[1]!));
    expect(listed).toHaveLength(6);
    expect(POOL_STATS_TOKENS.map((token) => BigInt(token))).toEqual(listed);
  });
});

describe('the pool stats cache (D-076)', () => {
  it('scans the whole registration history once, a window at a time, following the node\'s pages', async () => {
    const chain = fakeChain({ head: HEAD });
    chain.add(VIEWING_KEY_SET_EVENT, POOL_FIRST_BLOCK + 5, POOL_FIRST_BLOCK + 260_000, HEAD - 1, HEAD);
    const { cache } = cacheFor(chain);
    await cache.refresh();
    const scanned = chain.reads.filter((read) => read.key === VIEWING_KEY_SET_EVENT);
    // Four windows of up to 250,000 blocks, each paged in 100,000s by the node.
    expect([...new Set(scanned.map((read) => `${read.from}-${read.to}`))]).toEqual([
      `${POOL_FIRST_BLOCK}-${POOL_FIRST_BLOCK + 249_999}`,
      `${POOL_FIRST_BLOCK + 250_000}-${POOL_FIRST_BLOCK + 499_999}`,
      `${POOL_FIRST_BLOCK + 500_000}-${POOL_FIRST_BLOCK + 749_999}`,
      `${POOL_FIRST_BLOCK + 750_000}-${HEAD}`,
    ]);
    expect(scanned.filter((read) => read.token !== null).length).toBeGreaterThan(0);
    // Only the window that reaches the head names it, by hash, on every page;
    // each window before it ends by number a whole window below the head.
    expect([...new Set(scanned.filter((read) => read.hash !== null).map((read) => `${read.from}-${read.to}:${read.hash}`))]).toEqual([
      `${POOL_FIRST_BLOCK + 750_000}-${HEAD}:${hashOf(HEAD)}`,
    ]);
    for (const read of scanned.filter((read) => read.hash === null)) expect(HEAD - read.to).toBeGreaterThanOrEqual(250_000);
    expect(cache.peek().accounts).toBe(4);
  });

  it('ends a window by number only a whole window below the head, however the range falls', async () => {
    const head = POOL_FIRST_BLOCK + 250_002;
    const chain = fakeChain({ head });
    chain.add(VIEWING_KEY_SET_EVENT, POOL_FIRST_BLOCK + 1, POOL_FIRST_BLOCK + 3, head);
    const { cache } = cacheFor(chain);
    await cache.refresh();
    const windows = chain.reads
      .filter((read) => read.key === VIEWING_KEY_SET_EVENT && read.token === null)
      .map(({ from, to, hash }) => ({ from, to, hash }));
    expect(windows).toEqual([
      { from: POOL_FIRST_BLOCK, to: POOL_FIRST_BLOCK + 2, hash: null },
      { from: POOL_FIRST_BLOCK + 3, to: head, hash: hashOf(head) },
    ]);
    expect(cache.peek().accounts).toBe(3);
  });

  it('never skips blocks when the node answering the events trails the head', async () => {
    const chain = fakeChain({ head: HEAD });
    const { cache } = cacheFor(chain);
    await cache.refresh();
    expect(cache.peek()).toMatchObject({ accounts: 0, deposits24h: 0 });
    // Ten blocks land, with a registration and a deposit near the end; the
    // node that answers the events is three blocks behind the one that gave the head.
    chain.add(VIEWING_KEY_SET_EVENT, HEAD + 9);
    chain.add(DEPOSIT_EVENT, HEAD + 9);
    chain.setHead(HEAD + 10);
    chain.setLag(3);
    await expect(cache.refresh()).rejects.toThrow(/partial/);
    // Refused, not answered short: nothing moved on past the blocks it lacks.
    expect(cache.peek()).toMatchObject({ accounts: 0, deposits24h: 0 });
    // Once it has caught up, the next refresh counts them.
    chain.setLag(0);
    await cache.refresh();
    expect(cache.peek()).toMatchObject({ accounts: 1, deposits24h: 1 });
  });

  it('reads only the new blocks after that', async () => {
    const chain = fakeChain({ head: HEAD });
    const { cache } = cacheFor(chain);
    await cache.refresh();
    chain.reads.length = 0;
    chain.add(VIEWING_KEY_SET_EVENT, HEAD + 10);
    chain.add(DEPOSIT_EVENT, HEAD + 11);
    chain.setHead(HEAD + 36);
    await cache.refresh();
    expect(chain.reads).toEqual([
      { key: DEPOSIT_EVENT, from: HEAD + 1, to: HEAD + 36, hash: hashOf(HEAD + 36), token: null },
      { key: VIEWING_KEY_SET_EVENT, from: HEAD + 1, to: HEAD + 36, hash: hashOf(HEAD + 36), token: null },
    ]);
    expect(cache.peek()).toMatchObject({ accounts: 1, deposits24h: 1 });
  });

  it('counts deposits in the last day of blocks, dropping each as it ages out', async () => {
    const chain = fakeChain({ head: HEAD });
    const oldest = HEAD - DEPOSIT_WINDOW_BLOCKS + 1;
    chain.add(DEPOSIT_EVENT, oldest - 1, oldest, oldest + 10, HEAD);
    const { cache } = cacheFor(chain);
    await cache.refresh();
    const first = chain.reads.filter((read) => read.key === DEPOSIT_EVENT);
    expect(first[0]).toMatchObject({ from: oldest, to: HEAD });
    expect(cache.peek().deposits24h).toBe(3);
    // Five blocks on, the deposit at `oldest` has aged out; nothing new landed.
    chain.setHead(HEAD + 5);
    await cache.refresh();
    expect(cache.peek().deposits24h).toBe(2);
    // After a gap longer than the window, the window is counted afresh.
    chain.reads.length = 0;
    chain.setHead(HEAD + DEPOSIT_WINDOW_BLOCKS * 2);
    chain.add(DEPOSIT_EVENT, HEAD + DEPOSIT_WINDOW_BLOCKS * 2 - 3);
    await cache.refresh();
    const rescan = chain.reads.filter((read) => read.key === DEPOSIT_EVENT);
    expect(rescan[0]).toMatchObject({ from: HEAD + DEPOSIT_WINDOW_BLOCKS + 1, to: HEAD + DEPOSIT_WINDOW_BLOCKS * 2 });
    expect(cache.peek().deposits24h).toBe(1);
  });

  it("reads each pinned token's pool balance", async () => {
    const chain = fakeChain({ head: HEAD });
    const { cache } = cacheFor(chain);
    await cache.refresh();
    expect(cache.peek().held).toEqual(POOL_STATS_TOKENS.map((token, index) => ({ token, amount: BigInt(index + 1) * 10n ** 18n })));
  });

  it("keeps a token's last good balance when only its read fails, and leaves out one never read", async () => {
    const chain = fakeChain({ head: HEAD });
    const { cache } = cacheFor(chain);
    const balance = vi.spyOn(chain.rpc, 'getPoolBalance');
    balance.mockImplementation(async (token) => {
      if (token === POOL_STATS_TOKENS[5]) throw new Error('strkBTC down');
      return 7n;
    });
    await cache.refresh().catch(() => undefined);
    expect(cache.peek().held?.map((entry) => entry.token)).toEqual(POOL_STATS_TOKENS.slice(0, 5));
    balance.mockImplementation(async (token) => {
      if (token === POOL_STATS_TOKENS[0]) throw new Error('STRK down');
      return 9n;
    });
    await cache.refresh().catch(() => undefined);
    const held = cache.peek().held!;
    expect(held.find((entry) => entry.token === POOL_STATS_TOKENS[0])?.amount).toBe(7n);
    expect(held.find((entry) => entry.token === POOL_STATS_TOKENS[5])?.amount).toBe(9n);
    balance.mockRestore();
  });

  it('serves nothing it has not counted: accounts stay null until the scan has caught up', async () => {
    const chain = fakeChain({ head: HEAD });
    const { cache } = cacheFor(chain);
    expect(cache.peek()).toEqual({ accounts: null, deposits24h: null, held: null });
    // The registration scan fails partway: held and deposits are served, accounts are not.
    chain.failWhen((what) => what === `registrations:${POOL_FIRST_BLOCK + 500_000}`);
    await expect(cache.refresh()).rejects.toThrow(/partial/);
    expect(cache.peek()).toMatchObject({ accounts: null, deposits24h: 0 });
    expect(cache.peek().held).toHaveLength(POOL_STATS_TOKENS.length);
    // The next refresh resumes at the window that failed, not at the pool's first block.
    chain.failWhen(null);
    chain.reads.length = 0;
    await cache.refresh();
    const resumed = chain.reads.filter((read) => read.key === VIEWING_KEY_SET_EVENT);
    expect(resumed[0]).toMatchObject({ from: POOL_FIRST_BLOCK + 500_000 });
    expect(cache.peek().accounts).toBe(0);
  });

  it('keeps the last good value of a part whose refresh fails', async () => {
    const chain = fakeChain({ head: HEAD });
    chain.add(VIEWING_KEY_SET_EVENT, HEAD);
    chain.add(DEPOSIT_EVENT, HEAD);
    const { cache } = cacheFor(chain);
    await cache.refresh();
    const good = cache.peek();
    chain.balances.set(POOL_STATS_TOKENS[0]!, 1n);
    chain.add(DEPOSIT_EVENT, HEAD + 1);
    chain.setHead(HEAD + 1);
    chain.failWhen((what) => what === 'held' || what === 'deposits');
    await expect(cache.refresh()).rejects.toThrow();
    expect(cache.peek().held).toEqual(good.held);
    expect(cache.peek().deposits24h).toBe(1);
    // A failed head read changes nothing at all.
    chain.failWhen((what) => what === 'head');
    await expect(cache.refresh()).rejects.toThrow('head failed');
    expect(cache.peek()).toEqual({ ...good, accounts: 1 });
  });

  it('refuses a page that strays outside its range or repeats its cursor', async () => {
    const chain = fakeChain({ head: HEAD });
    const stray: PoolStatsRpcPort = {
      ...chain.rpc,
      async getPoolEvents(filter) {
        return { blocks: [filter.toBlock + 1], continuationToken: null };
      },
    };
    const strayCache = new PoolStatsCache({ rpc: stray });
    await expect(strayCache.refresh()).rejects.toThrow();
    expect(strayCache.peek().deposits24h).toBeNull();
    strayCache.stop();
    const looping: PoolStatsRpcPort = {
      ...chain.rpc,
      async getPoolEvents() {
        return { blocks: [], continuationToken: 'again' };
      },
    };
    const loopCache = new PoolStatsCache({ rpc: looping });
    await expect(loopCache.refresh()).rejects.toThrow();
    expect(loopCache.peek().accounts).toBeNull();
    loopCache.stop();
  });

  it('refreshes about once a minute while it is asked, one at a time, and stops when nobody asks', async () => {
    const chain = fakeChain({ head: HEAD });
    const clock = cacheFor(chain);
    const heads = vi.spyOn(chain.rpc, 'getHead');
    clock.cache.snapshot();
    clock.cache.snapshot();
    await settle();
    expect(heads).toHaveBeenCalledTimes(1);
    expect(clock.scheduled()).toHaveLength(1);
    // A minute on, someone is still looking: the next refresh runs.
    clock.advance(60_000);
    clock.cache.snapshot();
    await clock.runDue();
    expect(heads).toHaveBeenCalledTimes(2);
    // Ten quiet minutes later the refreshes stop.
    for (let minute = 0; minute < 11; minute++) {
      clock.advance(60_000);
      await clock.runDue();
    }
    const calls = heads.mock.calls.length;
    expect(clock.scheduled()).toHaveLength(0);
    clock.advance(60_000);
    await clock.runDue();
    expect(heads.mock.calls.length).toBe(calls);
    // The next visitor starts them again, served the last good value meanwhile.
    expect(clock.cache.snapshot().deposits24h).toBe(0);
    await settle();
    expect(heads.mock.calls.length).toBe(calls + 1);
    clock.cache.stop();
    expect(clock.scheduled()).toHaveLength(0);
  });

  it('holds only counts, block numbers and pinned token balances', async () => {
    const chain = fakeChain({ head: HEAD });
    chain.add(VIEWING_KEY_SET_EVENT, HEAD);
    chain.add(DEPOSIT_EVENT, HEAD);
    const { cache } = cacheFor(chain);
    await cache.refresh();
    expect(Object.keys(cache.peek()).sort()).toEqual(['accounts', 'deposits24h', 'held']);
  });
});

describe('the pool stats reads (D-076)', () => {
  function port(result: (request: { method: string; params: unknown[] }) => unknown) {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      requests.push(request);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result(request) }));
    });
    return { rpc: new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: '0x4718', fetcher }), requests };
  }

  it("asks for the pool's own events under one key, and returns their blocks alone", async () => {
    const event = (block: number, user: string) => ({
      from_address: '0x40337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a',
      keys: [VIEWING_KEY_SET_EVENT, user, '0x77'],
      data: ['0x1', '0x2', '0x3'],
      block_number: block,
      block_hash: '0xb',
      transaction_hash: '0x7a',
    });
    const { rpc, requests } = port(() => ({ events: [event(10, '0xa11ce'), event(12, '0xb0b')], continuation_token: '13-0' }));
    const page = await rpc.getPoolEvents({ key: VIEWING_KEY_SET_EVENT, fromBlock: 10, toBlock: 20, continuationToken: '11-0' });
    expect(page).toEqual({ blocks: [10, 12], continuationToken: '13-0' });
    expect(JSON.stringify(page)).not.toMatch(/a11ce|b0b|0x7a/);
    expect(requests).toEqual([{
      jsonrpc: '2.0',
      id: expect.any(Number),
      method: 'starknet_getEvents',
      params: [{
        from_block: { block_number: 10 },
        to_block: { block_number: 20 },
        address: POOL,
        keys: [[VIEWING_KEY_SET_EVENT]],
        chunk_size: 1_000,
        continuation_token: '11-0',
      }],
    }]);
  });

  it("ends the range at a block named by hash when it has one", async () => {
    const { rpc, requests } = port(() => ({ events: [] }));
    await rpc.getPoolEvents({ key: DEPOSIT_EVENT, fromBlock: 10, toBlock: 20, toBlockHash: '0xabc' });
    expect(requests[0]!.params[0]).toMatchObject({ from_block: { block_number: 10 }, to_block: { block_hash: '0xabc' } });
    await expect(rpc.getPoolEvents({ key: DEPOSIT_EVENT, fromBlock: 10, toBlock: 20, toBlockHash: 'latest' })).rejects.toThrow(/filter is invalid/);
  });

  it('reads the head as a block number and its hash', async () => {
    const { rpc, requests } = port(() => ({ block_hash: '0x706211da', block_number: 15_629_677 }));
    await expect(rpc.getHead()).resolves.toEqual({ number: 15_629_677, hash: '0x706211da' });
    expect(requests[0]).toMatchObject({ method: 'starknet_blockHashAndNumber', params: [] });
    for (const bad of [{ block_number: 1 }, { block_hash: '0x1', block_number: -1 }, { block_hash: 'x', block_number: 1 }, 7]) {
      await expect(port(() => bad).rpc.getHead()).rejects.toThrow(/invalid head/);
    }
  });

  it('refuses a page with an event from another contract, another key or another range', async () => {
    const good = { from_address: POOL, keys: [DEPOSIT_EVENT], block_number: 15 };
    for (const event of [
      { ...good, from_address: '0x999' },
      { ...good, keys: [VIEWING_KEY_SET_EVENT] },
      { ...good, block_number: 99 },
      { ...good, block_number: '15' },
    ]) {
      const { rpc } = port(() => ({ events: [event] }));
      await expect(rpc.getPoolEvents({ key: DEPOSIT_EVENT, fromBlock: 10, toBlock: 20 })).rejects.toThrow(/outside its filter/);
    }
    const { rpc } = port(() => ({ events: [], continuation_token: 7 }));
    await expect(rpc.getPoolEvents({ key: DEPOSIT_EVENT, fromBlock: 10, toBlock: 20 })).rejects.toThrow(/continuation/);
    await expect(rpc.getPoolEvents({ key: 'Deposit', fromBlock: 10, toBlock: 20 })).rejects.toThrow(/filter is invalid/);
    await expect(rpc.getPoolEvents({ key: DEPOSIT_EVENT, fromBlock: 20, toBlock: 10 })).rejects.toThrow(/filter is invalid/);
  });

  it("reads balance_of(pool) as a u256", async () => {
    const { rpc, requests } = port(() => ['0x21e7d1373cbb85295cf05', '0x1']);
    await expect(rpc.getPoolBalance(POOL_STATS_TOKENS[0]!)).resolves.toBe(0x21e7d1373cbb85295cf05n + (1n << 128n));
    expect(requests[0]).toMatchObject({
      method: 'starknet_call',
      params: [{ contract_address: POOL_STATS_TOKENS[0], entry_point_selector: BALANCE_OF_SELECTOR, calldata: [POOL] }, 'latest'],
    });
    const short = port(() => ['0x1']);
    await expect(short.rpc.getPoolBalance(POOL_STATS_TOKENS[0]!)).rejects.toThrow(/balance/);
  });

  it('is what the runtime composes the cache over', () => {
    const { rpc } = port(() => null);
    expect(isPoolStatsRpc(rpc)).toBe(true);
    expect(isPoolStatsRpc({ getBlockNumber: () => 1 })).toBe(false);
  });
});

describe('the pool stats route (D-076)', () => {
  const config: BackendConfig = {
    poolAddress: POOL,
    feeToken: '0x4718',
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: {
      transfer: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: ['0x4718'] },
      unshield: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: ['0x4718'] },
      swap: { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: true, allowedTokens: ['0x4718'], maxSlippageBps: 300 },
    },
  };
  const paymaster: PaymasterPort = {
    async buildFee() {
      throw new Error('not used');
    },
    async submit() {
      throw new Error('not used');
    },
  };
  const rpc: PoolRpcPort = {
    async getPoolConfig() {
      throw new Error('not used');
    },
    async getPublicKey() {
      throw new Error('not used');
    },
    async getReceipt() {
      throw new Error('not used');
    },
    async getBlockNumber() {
      throw new Error('not used');
    },
  };
  const stats: PoolStatsPort = {
    snapshot: () => ({
      accounts: 2_932,
      deposits24h: 23,
      held: [{ token: POOL_STATS_TOKENS[0]!, amount: 2_561_829_878_412_000_000_000_000n }],
    }),
  };
  const api = (overrides: Partial<BackendConfig> = {}, poolStats: PoolStatsPort | null = stats) =>
    new BackendApi({
      config: { ...config, ...overrides },
      paymaster,
      rpc,
      authorizations: new MemoryAuthorizationCodec(),
      ...(poolStats ? { poolStats } : {}),
    });
  const ASK = { method: 'POST', path: POOL_STATS_PATH, body: { v: 1 } } as const;

  it('answers POST /v1/rpc/pool-stats with the three aggregates and nothing else', async () => {
    const response = await api().handle({ method: 'POST', path: '/v1/rpc/pool-stats', body: { v: 1 } });
    expect(response).toEqual({
      status: 200,
      body: {
        accounts: 2_932,
        deposits24h: 23,
        held: [{ token: POOL_STATS_TOKENS[0], amount: '2561829878412000000000000' }],
      },
    });
  });

  it('serves nulls for parts not counted yet', async () => {
    const empty: PoolStatsPort = { snapshot: () => ({ accounts: null, deposits24h: null, held: null }) };
    const response = await api({}, empty).handle({ method: 'POST', path: '/v1/rpc/pool-stats', body: { v: 1 } });
    expect(response).toEqual({ status: 200, body: { accounts: null, deposits24h: null, held: null } });
  });

  it('takes nothing but its version, and only by POST', async () => {
    for (const body of [{}, { v: 2 }, { v: 1, token: POOL }, null]) {
      const response = await api().handle({ method: 'POST', path: '/v1/rpc/pool-stats', body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await api().handle({ method: 'GET', path: '/v1/rpc/pool-stats', body: null })).status).toBe(405);
  });

  it('keeps the kill switch and a plain 503 without a cache', async () => {
    const snapshot = vi.fn(stats.snapshot);
    const off = await api({ globalEnabled: false }, { snapshot }).handle(ASK);
    expect(off).toMatchObject({ status: 503, body: { code: 'SERVICE_DISABLED' } });
    expect(snapshot).not.toHaveBeenCalled();
    const none = await api({}, null).handle(ASK);
    expect(none).toMatchObject({ status: 503, body: { code: 'HTTP_503' } });
  });

  it("has its own rate window, and takes no slot from the one the private routes share", async () => {
    const shared = vi.fn(() => false);
    const own = vi.fn(() => true);
    const apart = new BackendApi({
      config,
      paymaster,
      rpc,
      authorizations: new MemoryAuthorizationCodec(),
      poolStats: stats,
      rateLimiter: { take: shared },
      poolStatsRateLimiter: { take: own },
    });
    // The shared window is spent: a fee quote waits, the plaza's figures do not.
    expect((await apart.handle(ASK)).status).toBe(200);
    expect(shared).not.toHaveBeenCalled();
    expect(await apart.handle({ method: 'POST', path: '/v1/private/fees', body: {} })).toMatchObject({ status: 429 });
    expect(shared).toHaveBeenCalledTimes(1);
    expect(own).toHaveBeenCalledTimes(1);
    // Its own window spent, the route says so.
    const limited = new BackendApi({
      config,
      paymaster,
      rpc,
      authorizations: new MemoryAuthorizationCodec(),
      poolStats: stats,
      poolStatsRateLimiter: { take: () => false },
    });
    expect(await limited.handle(ASK)).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    // By default, POOL_STATS_RATE_LIMIT a minute, whatever the shared window allows.
    const fresh = api({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    for (let asked = 0; asked < POOL_STATS_RATE_LIMIT.maxRequests; asked++) {
      const response = await fresh.handle(ASK);
      if (response.status !== 200) throw new Error(`request ${asked + 1} answered ${response.status}`);
    }
    expect((await fresh.handle(ASK)).status).toBe(429);
  });

  it('answers at once from memory while a refresh is still reading the chain', async () => {
    const chain = fakeChain({ head: HEAD });
    chain.add(VIEWING_KEY_SET_EVENT, HEAD);
    const { cache } = cacheFor(chain);
    await cache.refresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.spyOn(chain.rpc, 'getHead').mockImplementation(async () => {
      await gate;
      return { number: HEAD + 1, hash: hashOf(HEAD + 1) };
    });
    // The request starts the next refresh, which waits on the chain...
    const response = await api({}, cache).handle(ASK);
    expect(slow).toHaveBeenCalledTimes(1);
    // ...and the route has already answered with the last good figures.
    expect(response).toMatchObject({ status: 200, body: { accounts: 1, deposits24h: 0 } });
    release();
    await settle();
    cache.stop();
    slow.mockRestore();
  });

  it('warms the cache at boot, unless the kill switch is off', () => {
    const warm = vi.fn();
    api({}, { snapshot: stats.snapshot, warm }).warmPoolStats();
    expect(warm).toHaveBeenCalledTimes(1);
    api({ globalEnabled: false }, { snapshot: stats.snapshot, warm }).warmPoolStats();
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('writes nothing while it serves, nor while its background refresh keeps failing (D-014)', async () => {
    const chain = fakeChain({ head: HEAD });
    chain.failWhen(() => true);
    const clock = cacheFor(chain);
    const heads = vi.spyOn(chain.rpc, 'getHead');
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level)),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const served = await api({}, clock.cache).handle(ASK);
    await settle();
    expect(served).toEqual({ status: 200, body: { accounts: null, deposits24h: null, held: null } });
    // The failed refresh booked the next one, which fails the same way.
    expect(clock.scheduled()).toHaveLength(1);
    clock.advance(60_000);
    await clock.runDue();
    expect(heads).toHaveBeenCalledTimes(2);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    clock.cache.stop();
  });
});
