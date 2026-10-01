import { hash } from 'starknet';
import { describe, expect, it, vi } from 'vitest';
import { BackendApi } from './api.js';
import { MemoryAuthorizationCodec } from './authorization.js';
import {
  CLAIM_WITHDRAWAL_SELECTOR,
  CONVERT_TO_ASSETS_SELECTOR,
  ENDUR_RATE_PATH,
  ENDUR_SCAN_MAX_PAGES,
  ENDUR_SCAN_WINDOW_BLOCKS,
  ENDUR_UNSTAKE_FIRST_BLOCK,
  ENDUR_UNSTAKE_PATH,
  ENDUR_WITHDRAWAL_QUEUE,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  GET_REQUEST_INFO_SELECTOR,
  MAX_ENDUR_CLAIM_DRY_RUNS,
  MAX_ENDUR_REQUESTS,
  WITHDRAW_QUEUE_EVENT_KEY,
} from './endur.js';
import { BALANCE_OF_SELECTOR, StarknetRpcPoolPort } from './starknet-rpc.js';
import type { BackendConfig, EndurRpcPort, PoolRpcPort } from './types.js';
import { ENDUR_WITHDRAWAL_QUEUE as PRIVACY_QUEUE } from '../../../packages/privacy/src/endur.js';

/**
 * D-085: Endur unstaking's one public read. Pinned to the withdrawal queue,
 * xSTRK and STRK; the request names the stand-in address alone; and a page,
 * an event or a call that is not what was asked for fails the read whole.
 */

const POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';
const SHADOW = '0x6ad69dce496ffd4177ffbaaa9800b18589303c62ac3ad44c08c4830cb50aba4';
const HEAD = 17_000_000;
const NOW = 1_790_854_217;
const ONE = 10n ** 18n;

describe('the pinned unstaking contracts and selectors (D-085)', () => {
  it('names each by its own sn_keccak, and pins the queue the privacy package pins', () => {
    expect(BigInt(WITHDRAW_QUEUE_EVENT_KEY)).toBe(BigInt(hash.getSelectorFromName('WithdrawQueue')));
    expect(BigInt(GET_REQUEST_INFO_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('get_request_info')));
    expect(BigInt(CLAIM_WITHDRAWAL_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('claim_withdrawal')));
    expect(BigInt(CONVERT_TO_ASSETS_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('convert_to_assets')));
    expect(ENDUR_WITHDRAWAL_QUEUE).toBe('0x0518a66e579f9eb1603f5ffaeff95d3f013788e9c37ee94995555026b9648b6');
    expect(ENDUR_WITHDRAWAL_QUEUE).toBe(PRIVACY_QUEUE);
  });
});

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown[];
}

/** A node's error answer for one call, as a reverting `starknet_call` gets. */
class RpcFailure {}

function u256(value: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  return [`0x${(value & mask).toString(16)}`, `0x${(value >> 128n).toString(16)}`];
}

function requestInfo(assets: bigint, shares: bigint, claimed: boolean, at: number, claimAt: number): string[] {
  return [...u256(assets), ...u256(shares), claimed ? '0x1' : '0x0', `0x${at.toString(16)}`, `0x${claimAt.toString(16)}`, '0x1', '0x0'];
}

function event(requestId: number, receiver = SHADOW, block = HEAD - 10): unknown {
  return {
    from_address: ENDUR_WITHDRAWAL_QUEUE,
    keys: [WITHDRAW_QUEUE_EVENT_KEY, receiver, ENDUR_XSTRK],
    data: [`0x${requestId.toString(16)}`, '0x1', '0x0'],
    block_number: block,
    transaction_hash: '0x1',
  };
}

function node(options: {
  pages?: unknown[][];
  calls?: (call: { contract_address: string; entry_point_selector: string; calldata: string[] }) => unknown;
  head?: number;
} = {}) {
  const requests: RpcRequest[] = [];
  const pages = options.pages ?? [[event(10_589), event(10_589), event(10_590)]];
  const head = options.head ?? HEAD;
  const answer = (request: RpcRequest): unknown => {
    if (request.method === 'starknet_getBlockWithTxHashes') return { block_number: head, timestamp: NOW, transactions: [] };
    if (request.method === 'starknet_getEvents') {
      const filter = request.params[0] as { continuation_token?: string };
      const index = filter.continuation_token ? Number(filter.continuation_token.slice(1)) : 0;
      return { events: pages[index] ?? [], ...(index + 1 < pages.length ? { continuation_token: `p${index + 1}` } : {}) };
    }
    const call = request.params[0] as { contract_address: string; entry_point_selector: string; calldata: string[] };
    if (options.calls) return options.calls(call);
    if (BigInt(call.entry_point_selector) === BigInt(BALANCE_OF_SELECTOR)) {
      if (BigInt(call.contract_address) === BigInt(ENDUR_XSTRK_ASSET)) return u256(4n * ONE);
      if (BigInt(call.contract_address) === BigInt(ENDUR_XSTRK)) return u256(0n);
      return u256(2n);
    }
    if (BigInt(call.calldata[0]!) === 10_589n) return requestInfo(15n * ONE, 13n * ONE, false, NOW - 100, NOW - 100 + 604_800);
    return requestInfo(12n * ONE, 10n * ONE, true, NOW - 900_000, NOW - 295_200);
  };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    const reply = (request: RpcRequest) => {
      const result = answer(request);
      return result instanceof RpcFailure
        ? { jsonrpc: '2.0', id: request.id, error: { code: 40, message: 'Contract error' } }
        : { jsonrpc: '2.0', id: request.id, result };
    };
    if (Array.isArray(body)) {
      requests.push(...body);
      return new Response(JSON.stringify(body.map(reply)));
    }
    requests.push(body);
    return new Response(JSON.stringify(reply(body)));
  });
  return {
    rpc: new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: ENDUR_XSTRK_ASSET, fetcher }),
    requests,
    fetcher,
  };
}

describe('the unstaking read (D-085)', () => {
  it('scans the queue for the address, then reads its balances and each request, newest first', async () => {
    const { rpc, requests } = node();
    await expect(rpc.getEndurUnstake(SHADOW)).resolves.toEqual({
      chainTime: NOW,
      strk: 4n * ONE,
      xstrk: 0n,
      outstanding: 2n,
      complete: true,
      requests: [
        { requestId: 10_590n, assets: 12n * ONE, shares: 10n * ONE, claimed: true, requestedAt: NOW - 900_000, claimableAt: NOW - 295_200, claimableNow: false },
        { requestId: 10_589n, assets: 15n * ONE, shares: 13n * ONE, claimed: false, requestedAt: NOW - 100, claimableAt: NOW - 100 + 604_800, claimableNow: false },
      ],
    });
    const scan = requests.find((request) => request.method === 'starknet_getEvents')!;
    expect(scan.params[0]).toEqual({
      from_block: { block_number: HEAD - ENDUR_SCAN_WINDOW_BLOCKS },
      to_block: { block_number: HEAD },
      address: ENDUR_WITHDRAWAL_QUEUE,
      keys: [[WITHDRAW_QUEUE_EVENT_KEY], [SHADOW]],
      chunk_size: 100,
    });
    const calls = requests.filter((request) => request.method === 'starknet_call').map((request) => request.params[0] as { contract_address: string; entry_point_selector: string; calldata: string[] });
    expect(calls.map((call) => [call.contract_address, call.entry_point_selector, call.calldata])).toEqual([
      [ENDUR_XSTRK_ASSET, BALANCE_OF_SELECTOR, [SHADOW]],
      [ENDUR_XSTRK, BALANCE_OF_SELECTOR, [SHADOW]],
      [ENDUR_WITHDRAWAL_QUEUE, BALANCE_OF_SELECTOR, [SHADOW]],
      [ENDUR_WITHDRAWAL_QUEUE, GET_REQUEST_INFO_SELECTOR, ['0x295e']],
      [ENDUR_WITHDRAWAL_QUEUE, GET_REQUEST_INFO_SELECTOR, ['0x295d']],
    ]);
  });

  it('never scans before the block unstaking shipped, and stops after its page budget', async () => {
    const early = node({ head: ENDUR_UNSTAKE_FIRST_BLOCK + 10, pages: [[]] });
    await early.rpc.getEndurUnstake(SHADOW);
    const scan = early.requests.find((request) => request.method === 'starknet_getEvents')!;
    expect((scan.params[0] as { from_block: unknown }).from_block).toEqual({ block_number: ENDUR_UNSTAKE_FIRST_BLOCK });

    const endless = node({ pages: Array.from({ length: ENDUR_SCAN_MAX_PAGES + 5 }, () => []) });
    // Pages left over: the read says it is incomplete rather than answer short in silence.
    await expect(endless.rpc.getEndurUnstake(SHADOW)).resolves.toMatchObject({ complete: false });
    expect(endless.requests.filter((request) => request.method === 'starknet_getEvents')).toHaveLength(ENDUR_SCAN_MAX_PAGES);

    const exact = node({ pages: Array.from({ length: ENDUR_SCAN_MAX_PAGES }, () => []) });
    await expect(exact.rpc.getEndurUnstake(SHADOW)).resolves.toMatchObject({ complete: true });
  });

  it('dry-runs the claim of each unpaid request past its wait, and only those, read-only', async () => {
    // #1 past due and funded, #2 past due but unfunded, #3 early, #4 paid.
    const info: Record<number, string[]> = {
      1: requestInfo(ONE, ONE, false, NOW - 700_000, NOW - 1),
      2: requestInfo(2n * ONE, ONE, false, NOW - 700_000, NOW - 1),
      3: requestInfo(3n * ONE, ONE, false, NOW - 10, NOW + 604_790),
      4: requestInfo(4n * ONE, ONE, true, NOW - 900_000, NOW - 295_200),
    };
    const dryRuns: string[] = [];
    const { rpc, requests } = node({
      pages: [[event(1), event(2), event(3), event(4)]],
      calls: (call) => {
        if (BigInt(call.entry_point_selector) === BigInt(BALANCE_OF_SELECTOR)) return u256(0n);
        if (BigInt(call.entry_point_selector) === BigInt(GET_REQUEST_INFO_SELECTOR)) return info[Number(BigInt(call.calldata[0]!))];
        dryRuns.push(call.calldata[0]!);
        // The queue reverts an unfunded claim: a node error, not a result.
        return BigInt(call.calldata[0]!) === 2n ? new RpcFailure() : [];
      },
    });
    const read = await rpc.getEndurUnstake(SHADOW);
    expect(Object.fromEntries(read.requests.map((request) => [Number(request.requestId), request.claimableNow]))).toEqual({ 1: true, 2: false, 3: false, 4: false });
    expect(dryRuns).toEqual(['0x1', '0x2']);
    // Never submitted: a call, against the pinned queue and selector.
    const claims = requests.filter((request) => BigInt((request.params[0] as { entry_point_selector?: string }).entry_point_selector ?? '0x0') === BigInt(CLAIM_WITHDRAWAL_SELECTOR));
    expect(claims.every((request) => request.method === 'starknet_call' && BigInt((request.params[0] as { contract_address: string }).contract_address) === BigInt(ENDUR_WITHDRAWAL_QUEUE))).toBe(true);
  });

  it(`dry-runs at most ${MAX_ENDUR_CLAIM_DRY_RUNS} claims, oldest first`, async () => {
    const dryRuns: bigint[] = [];
    const { rpc } = node({
      pages: [Array.from({ length: 12 }, (_u, index) => event(100 + index))],
      calls: (call) => {
        if (BigInt(call.entry_point_selector) === BigInt(BALANCE_OF_SELECTOR)) return u256(0n);
        if (BigInt(call.entry_point_selector) === BigInt(GET_REQUEST_INFO_SELECTOR)) return requestInfo(ONE, ONE, false, NOW - 700_000, NOW - 1);
        dryRuns.push(BigInt(call.calldata[0]!));
        return [];
      },
    });
    const read = await rpc.getEndurUnstake(SHADOW);
    expect(dryRuns).toEqual(Array.from({ length: MAX_ENDUR_CLAIM_DRY_RUNS }, (_u, index) => BigInt(100 + index)));
    expect(read.requests.filter((request) => request.claimableNow)).toHaveLength(MAX_ENDUR_CLAIM_DRY_RUNS);
  });

  it(`keeps the newest ${MAX_ENDUR_REQUESTS} requests`, async () => {
    const { rpc } = node({ pages: [Array.from({ length: MAX_ENDUR_REQUESTS + 4 }, (_u, index) => event(20_000 + index))] });
    const read = await rpc.getEndurUnstake(SHADOW);
    expect(read.requests).toHaveLength(MAX_ENDUR_REQUESTS);
    expect(read.requests[0]!.requestId).toBe(BigInt(20_000 + MAX_ENDUR_REQUESTS + 3));
  });

  it.each([
    ['an event for another receiver', { pages: [[event(1, '0x1234')]] }],
    ['an event outside the range', { pages: [[event(1, SHADOW, HEAD + 1)]] }],
    ['a request id beyond u128', { pages: [[{ ...(event(1) as object), data: [`0x${(1n << 128n).toString(16)}`] }]] }],
    ['a malformed request', { calls: (call: { entry_point_selector: string }) => (BigInt(call.entry_point_selector) === BigInt(GET_REQUEST_INFO_SELECTOR) ? ['0x1'] : u256(0n)) }],
    ['a claim time before the request', { calls: (call: { entry_point_selector: string }) => (BigInt(call.entry_point_selector) === BigInt(GET_REQUEST_INFO_SELECTOR) ? requestInfo(1n, 1n, false, 500, 400) : u256(0n)) }],
    ['a balance it could not read', { calls: () => ['0x1'] }],
  ])('fails whole on %s', async (_label, options) => {
    const { rpc } = node(options as Parameters<typeof node>[0]);
    await expect(rpc.getEndurUnstake(SHADOW)).rejects.toThrow();
  });

  it('refuses an invalid address before any request', async () => {
    const { rpc, fetcher } = node();
    for (const bad of ['0x0', 'abc', `0x${'f'.repeat(64)}`]) {
      await expect(rpc.getEndurUnstake(bad)).rejects.toThrow(/account is invalid/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function apiWith(endur?: EndurRpcPort, overrides: Partial<BackendConfig> = {}) {
  const rpc: PoolRpcPort = {
    getPoolConfig: vi.fn(async () => ({ feeAmount: 6n, feeToken: ENDUR_XSTRK_ASSET, proofValidityBlocks: 450, noteMaturityBlocks: 10 })),
    getPublicKey: vi.fn(async () => '0x0'),
    getReceipt: vi.fn(async () => null),
    getBlockNumber: vi.fn(async () => 1),
  };
  const route = { enabled: true, maxRelayFee: 10n, maxQueueDelayMs: 0, quoteBound: false, allowedTokens: [ENDUR_XSTRK_ASSET] };
  const config: BackendConfig = {
    poolAddress: POOL,
    feeToken: ENDUR_XSTRK_ASSET,
    maxCalldataItems: 128,
    maxProofBytes: 2_000_000,
    requestTimeoutMs: 30_000,
    globalEnabled: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    sponsorshipBudget: { maxFeeAmount: 1_000n, windowMs: 60_000 },
    submissionQueue: { maxInFlight: 4, maxQueued: 16 },
    routes: { transfer: route, unshield: route, swap: { ...route, quoteBound: true, maxSlippageBps: 50 } },
    ...overrides,
  };
  return new BackendApi({
    config,
    paymaster: { buildFee: vi.fn(), submit: vi.fn() },
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    ...(endur ? { endur } : {}),
  });
}

function endurPort(): EndurRpcPort & { getEndurUnstake: ReturnType<typeof vi.fn>; getEndurRate: ReturnType<typeof vi.fn> } {
  return {
    getEndurRate: vi.fn(async () => 1_183_444_769_437_096_259n),
    getEndurUnstake: vi.fn(async () => ({
      chainTime: NOW,
      strk: 4n * ONE,
      xstrk: 0n,
      outstanding: 1n,
      complete: false,
      requests: [{ requestId: 10_589n, assets: 15n * ONE, shares: 13n * ONE, claimed: false, requestedAt: NOW - 100, claimableAt: NOW + 604_700, claimableNow: false }],
    })),
  };
}

describe('the unstaking route (D-085)', () => {
  it('answers in decimal strings and integers, for the address alone', async () => {
    const endur = endurPort();
    await expect(apiWith(endur).handle({ method: 'POST', path: ENDUR_UNSTAKE_PATH, body: { v: 1, account: SHADOW } })).resolves.toEqual({
      status: 200,
      body: {
        chainTime: NOW,
        strk: '4000000000000000000',
        xstrk: '0',
        outstanding: '1',
        requests: [{ requestId: '10589', assets: '15000000000000000000', shares: '13000000000000000000', claimed: false, requestedAt: NOW - 100, claimableAt: NOW + 604_700, claimableNow: false }],
        complete: false,
      },
    });
    expect(endur.getEndurUnstake).toHaveBeenCalledWith(SHADOW, expect.any(AbortSignal));
  });

  it.each([
    [{ v: 2, account: SHADOW }],
    [{ v: 1, account: '0x0' }],
    [{ v: 1, account: SHADOW, contract: ENDUR_WITHDRAWAL_QUEUE }],
    [{ v: 1 }],
  ])('refuses %j before any read', async (body) => {
    const endur = endurPort();
    await expect(apiWith(endur).handle({ method: 'POST', path: ENDUR_UNSTAKE_PATH, body })).resolves.toMatchObject({ status: 400 });
    expect(endur.getEndurUnstake).not.toHaveBeenCalled();
  });

  it('answers 503 without the reads, and honours the kill switch', async () => {
    await expect(apiWith().handle({ method: 'POST', path: ENDUR_UNSTAKE_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toMatchObject({ status: 503 });
    const endur = endurPort();
    await expect(apiWith(endur, { globalEnabled: false }).handle({ method: 'POST', path: ENDUR_UNSTAKE_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toMatchObject({ status: 503 });
    expect(endur.getEndurUnstake).not.toHaveBeenCalled();
  });
});

describe('the xSTRK rate read (D-091)', () => {
  it('makes one pinned convert_to_assets call for one whole xSTRK', async () => {
    const { rpc, requests } = node({ calls: () => u256(1_183_444_769_437_096_259n) });
    await expect(rpc.getEndurRate()).resolves.toBe(1_183_444_769_437_096_259n);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('starknet_call');
    expect(requests[0]!.params[0]).toEqual({
      contract_address: ENDUR_XSTRK,
      entry_point_selector: CONVERT_TO_ASSETS_SELECTOR,
      calldata: ['0xde0b6b3a7640000', '0x0'],
    });
  });

  it.each([
    ['a zero rate', () => u256(0n)],
    ['a short answer', () => ['0x1']],
    ['a reverted call', () => new RpcFailure()],
  ])('fails on %s', async (_label, calls) => {
    const { rpc } = node({ calls });
    await expect(rpc.getEndurRate()).rejects.toThrow(/xSTRK rate/);
  });

  it('answers a decimal string for a version alone, and nothing else', async () => {
    const endur = endurPort();
    await expect(apiWith(endur).handle({ method: 'POST', path: ENDUR_RATE_PATH, body: { v: 1 } })).resolves.toEqual({
      status: 200,
      body: { strkPerXstrk: '1183444769437096259' },
    });
    for (const body of [{ v: 2 }, { v: 1, account: SHADOW }, {}]) {
      await expect(apiWith(endur).handle({ method: 'POST', path: ENDUR_RATE_PATH, body })).resolves.toMatchObject({ status: 400 });
    }
    expect(endur.getEndurRate).toHaveBeenCalledTimes(1);
    expect(endur.getEndurUnstake).not.toHaveBeenCalled();
  });

  it('answers 503 without the reads, and honours the kill switch', async () => {
    await expect(apiWith().handle({ method: 'POST', path: ENDUR_RATE_PATH, body: { v: 1 } })).resolves.toMatchObject({ status: 503 });
    const endur = endurPort();
    await expect(apiWith(endur, { globalEnabled: false }).handle({ method: 'POST', path: ENDUR_RATE_PATH, body: { v: 1 } }))
      .resolves.toMatchObject({ status: 503 });
    expect(endur.getEndurRate).not.toHaveBeenCalled();
  });
});
