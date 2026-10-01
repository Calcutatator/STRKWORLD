import { hash } from 'starknet';
import { describe, expect, it, vi } from 'vitest';
import { BackendApi } from './api.js';
import { MemoryAuthorizationCodec } from './authorization.js';
import { createBackendRuntime } from './runtime.js';
import { BALANCE_OF_SELECTOR, StarknetRpcPoolPort, VAULT_RPC_BATCH_SIZE, VAULT_RPC_FALLBACK_CONCURRENCY } from './starknet-rpc.js';
import type { BackendConfig, PoolRpcPort, VaultRatesPort, VaultRpcPort } from './types.js';
import {
  GET_SHADOW_ACCOUNTS_SELECTOR,
  MAX_REDEEM_SELECTOR,
  MAX_WITHDRAW_SELECTOR,
  PREVIEW_REDEEM_SELECTOR,
  SHADOW_ACCOUNT_ANONYMIZER,
  VAULT_POSITION_PATH,
  VAULT_RATES_PATH,
  VAULT_SHADOW_ACCOUNT_PATH,
  VESU_POOLS,
  VESU_PRIME_POOL,
  VESU_VAULTS,
  VESU_VSTRK,
  vesuPoolApiUrl,
} from './vault.js';
// The one token -> vault map (D-079, D-081), which this service pins its own copy of.
import { MAX_VAULT_MARKETS, VAULT_MARKETS, VESU_PRIME_POOL as PRIVACY_PRIME_POOL } from '../../../packages/privacy/src/vault.js';

/**
 * D-077: the Vault's public reads. Each is pinned to its contracts and
 * selectors, takes one value from the request, and logs nothing about it.
 * D-079: the position read covers every pinned vault, and a third route
 * answers Vesu's supply APY from this service's own cached read. D-081: the
 * vaults span Prime and curated pools, and the position read stays a few
 * batched requests however many there are.
 */

const POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const PARTIAL = '0x5f2e1d';
const SHADOW = '0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9';
const FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

describe('the pinned Vault contracts and selectors', () => {
  it('names each entry point by its own sn_keccak', () => {
    expect(BigInt(GET_SHADOW_ACCOUNTS_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('get_shadow_accounts')));
    expect(BigInt(PREVIEW_REDEEM_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('preview_redeem')));
    expect(BigInt(MAX_WITHDRAW_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('max_withdraw')));
    expect(BigInt(MAX_REDEEM_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('max_redeem')));
    // Shared with the pool: also the shares read here (`balance_of(account)` on vSTRK).
    // D-080 removed the pool-stats.ts held-balance reads that used to pin this.
    expect(BigInt(BALANCE_OF_SELECTOR)).toBe(BigInt(hash.getSelectorFromName('balance_of')));
  });

  it('pins the canonical anonymizer and Vesu vSTRK, as read on mainnet', () => {
    expect(SHADOW_ACCOUNT_ANONYMIZER).toBe('0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7');
    expect(VESU_VSTRK).toBe('0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d');
  });

  it('pins the same vaults, in the same pools, as the privacy package’s token → vault map, in its order (D-079, D-081)', () => {
    expect(VESU_VAULTS.map(({ token, vault, pool }) => [token, vault, pool]))
      .toEqual(VAULT_MARKETS.map(({ token, vault, pool }) => [token, vault, pool]));
    expect(VESU_VAULTS[0]).toEqual({ token: STRK, vault: VESU_VSTRK, pool: VESU_PRIME_POOL });
    expect(VESU_PRIME_POOL).toBe(PRIVACY_PRIME_POOL);
    expect(VESU_VAULTS.length).toBeLessThanOrEqual(MAX_VAULT_MARKETS);
    expect(VESU_POOLS.map(vesuPoolApiUrl)[0]).toBe(`https://api.vesu.xyz/pools/${VESU_PRIME_POOL}`);
    expect(Object.isFrozen(VESU_VAULTS)).toBe(true);
    for (const entry of VESU_VAULTS) expect(Object.isFrozen(entry)).toBe(true);
  });
});

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown[];
}

/** A node error for one call, answered as JSON-RPC does, in place of a result. */
class NodeError {
  constructor(readonly code: number) {}
}

/**
 * A node that answers each call with `result(request)`, singly or in a batch.
 * `requests` lists every call it received, flattened; `posts` lists each HTTP
 * request and how many calls it carried. `batches: 'refuse'` answers a batch
 * the way a node without batch support does, with one error and no list.
 */
function port(result: (request: RpcRequest) => unknown, options: { batches?: 'answer' | 'refuse' } = {}) {
  const requests: RpcRequest[] = [];
  const posts: Array<{ readonly batch: boolean; readonly size: number }> = [];
  const answer = (request: RpcRequest) => {
    const value = result(request);
    return value instanceof NodeError
      ? { jsonrpc: '2.0', id: request.id, error: { code: value.code, message: 'node said no' } }
      : { jsonrpc: '2.0', id: request.id, result: value };
  };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    if (Array.isArray(body)) {
      posts.push({ batch: true, size: body.length });
      if (options.batches === 'refuse') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
      }
      requests.push(...body);
      return new Response(JSON.stringify(body.map(answer)));
    }
    posts.push({ batch: false, size: 1 });
    requests.push(body);
    return new Response(JSON.stringify(answer(body)));
  });
  return { rpc: new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher }), requests, posts, fetcher };
}

/** The call a request made: its contract, selector and calldata. */
function callOf(request: { params: unknown[] }): { contract_address: string; entry_point_selector: string; calldata: string[] } {
  return request.params[0] as { contract_address: string; entry_point_selector: string; calldata: string[] };
}

describe('the shadow-account read (D-077)', () => {
  it("asks the pinned anonymizer's view for nonce 0 alone, and returns its row", async () => {
    const { rpc, requests } = port(() => ['0x1', '0x0', SHADOW, '0x1']);
    await expect(rpc.getShadowAccount(PARTIAL)).resolves.toEqual({ address: SHADOW, deployed: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'starknet_call',
      params: [{
        contract_address: SHADOW_ACCOUNT_ANONYMIZER,
        entry_point_selector: GET_SHADOW_ACCOUNTS_SELECTOR,
        // get_shadow_accounts(partial, start_nonce 0, end_nonce 1, until_undeployed false)
        calldata: [PARTIAL, '0x0', '0x1', '0x0'],
      }, 'latest'],
    });
  });

  it('reads an address that is not deployed yet as such', async () => {
    const { rpc } = port(() => ['0x1', '0x0', SHADOW, '0x0']);
    await expect(rpc.getShadowAccount(PARTIAL)).resolves.toEqual({ address: SHADOW, deployed: false });
  });

  it.each([
    ['no rows', ['0x0']],
    ['two rows', ['0x2', '0x0', SHADOW, '0x0', '0x1', '0x77', '0x0']],
    ['another nonce', ['0x1', '0x1', SHADOW, '0x0']],
    ['a zero address', ['0x1', '0x0', '0x0', '0x0']],
    ['an address at 2^251', ['0x1', '0x0', `0x${(1n << 251n).toString(16)}`, '0x0']],
    ['a deployed flag that is not a bool', ['0x1', '0x0', SHADOW, '0x2']],
    ['a trailing item', ['0x1', '0x0', SHADOW, '0x0', '0x0']],
    ['a non-felt item', ['0x1', '0x0', 'deadbeef', '0x0']],
  ])('refuses a view answer with %s', async (_label, answer) => {
    const { rpc } = port(() => answer);
    await expect(rpc.getShadowAccount(PARTIAL)).rejects.toThrow();
  });

  it('refuses a zero or malformed commitment before the RPC is asked', async () => {
    const { rpc, fetcher } = port(() => ['0x1', '0x0', SHADOW, '0x0']);
    for (const bad of ['0x0', '123', `0x${FIELD_PRIME.toString(16)}`, '0xnot']) {
      await expect(rpc.getShadowAccount(bad)).rejects.toThrow(/commitment is invalid/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('the position read across every pinned vault (D-077, D-079, D-081)', () => {
  const empty = { ok: true, shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n };
  const USDC_INDEX = VESU_VAULTS.findIndex(({ token }) => BigInt(token) === BigInt('0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb'));
  const LAST = VESU_VAULTS.length - 1;

  it('answers empty positions from one batch of balances, one row per vault in pinned order', async () => {
    const { rpc, requests, posts } = port(() => ['0x0', '0x0']);
    await expect(rpc.getVaultPositions(SHADOW)).resolves.toEqual(VESU_VAULTS.map(({ vault }) => ({ vault, ...empty })));
    expect(requests.map(callOf)).toEqual(VESU_VAULTS.map(({ vault }) => (
      { contract_address: vault, entry_point_selector: BALANCE_OF_SELECTOR, calldata: [SHADOW] }
    )));
    expect(posts).toEqual([{ batch: true, size: VESU_VAULTS.length }]);
  });

  it('previews the shares and reads both limits of a held position, as u256 values, on its own vault only, in a second batch', async () => {
    const shares = (1n << 128n) + 5n;
    const usdcVault = VESU_VAULTS[USDC_INDEX]!.vault;
    const { rpc, requests, posts } = port((request) => {
      const call = callOf(request);
      if (call.entry_point_selector === BALANCE_OF_SELECTOR) return call.contract_address === usdcVault ? ['0x5', '0x1'] : ['0x0', '0x0'];
      if (call.entry_point_selector === PREVIEW_REDEEM_SELECTOR) return ['0x64', '0x0'];
      if (call.entry_point_selector === MAX_WITHDRAW_SELECTOR) return ['0x60', '0x0'];
      if (call.entry_point_selector === MAX_REDEEM_SELECTOR) return ['0x4', '0x1'];
      return null;
    });
    const rows = await rpc.getVaultPositions(SHADOW);
    expect(rows[USDC_INDEX]).toEqual({ vault: usdcVault, ok: true, shares, assets: 100n, maxWithdraw: 96n, maxRedeem: (1n << 128n) + 4n });
    expect(rows.filter((row) => row.vault !== usdcVault)).toEqual(
      VESU_VAULTS.filter(({ vault }) => vault !== usdcVault).map(({ vault }) => ({ vault, ...empty })),
    );
    const followUps = requests.map(callOf).filter((call) => call.entry_point_selector !== BALANCE_OF_SELECTOR);
    expect(followUps).toHaveLength(3);
    expect(followUps.every((call) => call.contract_address === usdcVault)).toBe(true);
    expect(followUps.find((call) => call.entry_point_selector === PREVIEW_REDEEM_SELECTOR)?.calldata).toEqual(['0x5', '0x1']);
    expect(followUps.find((call) => call.entry_point_selector === MAX_WITHDRAW_SELECTOR)?.calldata).toEqual([SHADOW]);
    expect(followUps.find((call) => call.entry_point_selector === MAX_REDEEM_SELECTOR)?.calldata).toEqual([SHADOW]);
    expect(posts).toEqual([{ batch: true, size: VESU_VAULTS.length }, { batch: true, size: 3 }]);
  });

  it('stays three batched requests with every vault held, and never calls a contract outside the pinned vaults', async () => {
    const { rpc, requests, posts } = port(() => ['0x1', '0x0']);
    await rpc.getVaultPositions(SHADOW);
    const pinned = new Set(VESU_VAULTS.map(({ vault }) => vault));
    expect(requests.map(callOf).every((call) => pinned.has(call.contract_address))).toBe(true);
    expect(requests).toHaveLength(VESU_VAULTS.length * 4);
    // Twenty-three balances in one batch; their sixty-nine follow-ups in two.
    expect(posts).toEqual([
      { batch: true, size: VESU_VAULTS.length },
      { batch: true, size: VAULT_RPC_BATCH_SIZE },
      { batch: true, size: VESU_VAULTS.length * 3 - VAULT_RPC_BATCH_SIZE },
    ]);
    expect(posts.every(({ size }) => size <= VAULT_RPC_BATCH_SIZE)).toBe(true);
  });

  it('is bounded for the longest list the Vault may pin: at most four requests of at most a batch each', () => {
    const requestsFor = (vaults: number) => Math.ceil(vaults / VAULT_RPC_BATCH_SIZE) + Math.ceil((vaults * 3) / VAULT_RPC_BATCH_SIZE);
    expect(VESU_VAULTS).toHaveLength(23);
    expect(requestsFor(VESU_VAULTS.length)).toBe(3);
    // Two while at most sixteen vaults hold shares, as a player's usually do.
    expect(requestsFor(16) - Math.ceil(16 / VAULT_RPC_BATCH_SIZE) + 1).toBe(2);
    expect(requestsFor(MAX_VAULT_MARKETS)).toBe(4);
    expect(VAULT_RPC_FALLBACK_CONCURRENCY).toBeLessThanOrEqual(4);
  });

  it.each([
    ['a one-felt balance', () => ['0x5']],
    ['a limb above u128', () => [`0x${(1n << 128n).toString(16)}`, '0x0']],
    ['a non-felt limb', () => ['5', '0x0']],
    ['a node error', () => new NodeError(40)],
  ])('answers every vault as unread after %s, never as a figure', async (_label, answer) => {
    const { rpc } = port(answer);
    await expect(rpc.getVaultPositions(SHADOW)).resolves.toEqual(VESU_VAULTS.map(({ vault }) => ({ vault, ok: false })));
  });

  it('marks only the vault whose read is malformed or refused, so it never blocks another token', async () => {
    const lastVault = VESU_VAULTS[LAST]!.vault;
    const usdcVault = VESU_VAULTS[USDC_INDEX]!.vault;
    const { rpc } = port((request) => {
      const call = callOf(request);
      if (call.contract_address === lastVault) return ['0x5'];
      if (call.contract_address === usdcVault) return new NodeError(40);
      return ['0x0', '0x0'];
    });
    const rows = await rpc.getVaultPositions(SHADOW);
    expect(rows[LAST]).toEqual({ vault: lastVault, ok: false });
    expect(rows[USDC_INDEX]).toEqual({ vault: usdcVault, ok: false });
    expect(rows.filter((row) => row.vault !== lastVault && row.vault !== usdcVault)).toEqual(
      VESU_VAULTS.filter(({ vault }) => vault !== lastVault && vault !== usdcVault).map(({ vault }) => ({ vault, ...empty })),
    );
  });

  it('marks a held vault unread when one of its three follow-ups fails, and no other', async () => {
    const usdcVault = VESU_VAULTS[USDC_INDEX]!.vault;
    const { rpc } = port((request) => {
      const call = callOf(request);
      if (call.entry_point_selector === BALANCE_OF_SELECTOR) return ['0x5', '0x0'];
      if (call.contract_address === usdcVault && call.entry_point_selector === MAX_REDEEM_SELECTOR) return new NodeError(40);
      return ['0x5', '0x0'];
    });
    const rows = await rpc.getVaultPositions(SHADOW);
    expect(rows[USDC_INDEX]).toEqual({ vault: usdcVault, ok: false });
    expect(rows.filter((row) => row.ok)).toHaveLength(VESU_VAULTS.length - 1);
  });

  it('marks a vault unread when the batch answer leaves its call out or answers it twice', async () => {
    const usdcVault = VESU_VAULTS[USDC_INDEX]!.vault;
    const lastVault = VESU_VAULTS[LAST]!.vault;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest[];
      const answers = body.flatMap((request) => {
        const { contract_address: contract } = callOf(request);
        const reply = { jsonrpc: '2.0', id: request.id, result: ['0x0', '0x0'] };
        if (contract === usdcVault) return [];
        if (contract === lastVault) return [reply, reply];
        return [reply];
      });
      return new Response(JSON.stringify(answers.reverse()));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    const rows = await rpc.getVaultPositions(SHADOW);
    expect(rows[USDC_INDEX]).toEqual({ vault: usdcVault, ok: false });
    expect(rows[LAST]).toEqual({ vault: lastVault, ok: false });
    expect(rows.filter((row) => row.ok)).toHaveLength(VESU_VAULTS.length - 2);
  });

  it('reads a node without batch support one call at a time, a few at once, with the same answer', async () => {
    const usdcVault = VESU_VAULTS[USDC_INDEX]!.vault;
    let inFlight = 0;
    let most = 0;
    const answerOf = (request: RpcRequest) => {
      const call = callOf(request);
      if (call.entry_point_selector === BALANCE_OF_SELECTOR) return call.contract_address === usdcVault ? ['0x5', '0x0'] : ['0x0', '0x0'];
      return ['0x5', '0x0'];
    };
    const posts: boolean[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
      posts.push(Array.isArray(body));
      if (Array.isArray(body)) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
      }
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answerOf(body) }));
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    const rows = await rpc.getVaultPositions(SHADOW);
    expect(rows[USDC_INDEX]).toEqual({ vault: usdcVault, ok: true, shares: 5n, assets: 5n, maxWithdraw: 5n, maxRedeem: 5n });
    expect(rows.filter((row) => row.ok)).toHaveLength(VESU_VAULTS.length);
    expect(most).toBeLessThanOrEqual(VAULT_RPC_FALLBACK_CONCURRENCY);
    // One refused batch per round, then single calls: the balances, then USDC's three.
    expect(posts.filter(Boolean)).toHaveLength(2);
    expect(posts.filter((batch) => !batch)).toHaveLength(VESU_VAULTS.length + 3);
  });

  it.each([
    ['rate-limits', 429],
    ['fails', 502],
  ])('answers every vault as unread when the node %s the batch, without retrying it call by call', async (_label, status) => {
    const fetcher = vi.fn(async () => new Response('busy', { status }));
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    await expect(rpc.getVaultPositions(SHADOW)).resolves.toEqual(VESU_VAULTS.map(({ vault }) => ({ vault, ok: false })));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still rejects a cancelled read rather than calling every vault unread', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new DOMException('Aborted', 'AbortError');
    });
    const rpc = new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher });
    await expect(rpc.getVaultPositions(SHADOW, controller.signal)).rejects.toBeDefined();
  });

  it('refuses a zero or malformed account before the RPC is asked', async () => {
    const { rpc, fetcher } = port(() => ['0x0', '0x0']);
    for (const bad of ['0x0', 'abc', `0x${'f'.repeat(64)}`]) {
      await expect(rpc.getVaultPositions(bad)).rejects.toThrow(/account is invalid/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function apiWith(vault?: VaultRpcPort, overrides: Partial<BackendConfig> = {}, vaultRates?: VaultRatesPort) {
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
    ...overrides,
  };
  return new BackendApi({
    config,
    paymaster: { buildFee: vi.fn(), submit: vi.fn() },
    rpc,
    authorizations: new MemoryAuthorizationCodec(),
    ...(vault ? { vault } : {}),
    ...(vaultRates ? { vaultRates } : {}),
  });
}

function vaultPort(): VaultRpcPort & { getShadowAccount: ReturnType<typeof vi.fn>; getVaultPositions: ReturnType<typeof vi.fn> } {
  return {
    getShadowAccount: vi.fn(async () => ({ address: SHADOW, deployed: false })),
    getVaultPositions: vi.fn(async () => [
      { vault: VESU_VSTRK, ok: true as const, shares: 10n ** 18n, assets: 1_019_826_000_000_000_000n, maxWithdraw: 10n ** 18n, maxRedeem: 10n ** 18n },
      { vault: VESU_VAULTS[2]!.vault, ok: true as const, shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n },
      { vault: VESU_VAULTS.at(-1)!.vault, ok: false as const },
    ]),
  };
}

function ratesPort(): VaultRatesPort & { rates: ReturnType<typeof vi.fn> } {
  return {
    rates: vi.fn(async () => [{ vault: VESU_VSTRK, supplyApy: { value: 27351899613523568n, decimals: 18 } }]),
  };
}

describe('the Vault read routes (D-077)', () => {
  it('answers the shadow account for a partial commitment', async () => {
    const vault = vaultPort();
    const api = apiWith(vault);
    await expect(api.handle({ method: 'POST', path: VAULT_SHADOW_ACCOUNT_PATH, body: { v: 1, partialCommitment: PARTIAL } }))
      .resolves.toEqual({ status: 200, body: { address: SHADOW, deployed: false } });
    expect(vault.getShadowAccount).toHaveBeenCalledWith(PARTIAL, expect.any(AbortSignal));
  });

  it('answers every pinned vault’s position in decimal base units, one row each, and an unread vault as such', async () => {
    const vault = vaultPort();
    const api = apiWith(vault);
    await expect(api.handle({ method: 'POST', path: VAULT_POSITION_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toEqual({
        status: 200,
        body: {
          positions: [
            {
              vault: VESU_VSTRK,
              ok: true,
              shares: '1000000000000000000',
              assets: '1019826000000000000',
              maxWithdraw: '1000000000000000000',
              maxRedeem: '1000000000000000000',
            },
            { vault: VESU_VAULTS[2]!.vault, ok: true, shares: '0', assets: '0', maxWithdraw: '0', maxRedeem: '0' },
            { vault: VESU_VAULTS.at(-1)!.vault, ok: false },
          ],
        },
      });
    expect(vault.getVaultPositions).toHaveBeenCalledWith(SHADOW, expect.any(AbortSignal));
  });

  it('answers Vesu’s rates as an integer and its decimals, for a request carrying nothing but a version (D-079)', async () => {
    const rates = ratesPort();
    const api = apiWith(vaultPort(), {}, rates);
    await expect(api.handle({ method: 'POST', path: VAULT_RATES_PATH, body: { v: 1 } })).resolves.toEqual({
      status: 200,
      body: { rates: [{ vault: VESU_VSTRK, supplyApy: { value: '27351899613523568', decimals: 18 } }] },
    });
    for (const body of [{ v: 2 }, { v: 1, vault: VESU_VSTRK }, { v: 1, account: SHADOW }, {}]) {
      await expect(api.handle({ method: 'POST', path: VAULT_RATES_PATH, body }), JSON.stringify(body)).resolves.toMatchObject({ status: 400 });
    }
    expect(rates.rates).toHaveBeenCalledTimes(1);
    await expect(apiWith(vaultPort()).handle({ method: 'POST', path: VAULT_RATES_PATH, body: { v: 1 } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(apiWith(vaultPort(), { globalEnabled: false }, rates).handle({ method: 'POST', path: VAULT_RATES_PATH, body: { v: 1 } }))
      .resolves.toMatchObject({ status: 503 });
    expect(rates.rates).toHaveBeenCalledTimes(1);
  });

  it.each([
    [VAULT_SHADOW_ACCOUNT_PATH, { v: 2, partialCommitment: PARTIAL }],
    [VAULT_SHADOW_ACCOUNT_PATH, { v: 1, partialCommitment: '0x0' }],
    [VAULT_SHADOW_ACCOUNT_PATH, { v: 1, partialCommitment: 'abc' }],
    [VAULT_SHADOW_ACCOUNT_PATH, { v: 1, partialCommitment: PARTIAL, nonce: '0x1' }],
    [VAULT_SHADOW_ACCOUNT_PATH, { v: 1, partialCommitment: PARTIAL, contract: SHADOW }],
    [VAULT_POSITION_PATH, { v: 1, account: '0x0' }],
    [VAULT_POSITION_PATH, { v: 1, account: SHADOW, vault: VESU_VSTRK }],
    [VAULT_POSITION_PATH, { v: 1 }],
  ])('refuses %s with %j before any read', async (path, body) => {
    const vault = vaultPort();
    const api = apiWith(vault);
    await expect(api.handle({ method: 'POST', path, body })).resolves.toMatchObject({ status: 400 });
    expect(vault.getShadowAccount).not.toHaveBeenCalled();
    expect(vault.getVaultPositions).not.toHaveBeenCalled();
  });

  it('answers 503 on a service composed without the Vault reads', async () => {
    const api = apiWith(undefined);
    await expect(api.handle({ method: 'POST', path: VAULT_SHADOW_ACCOUNT_PATH, body: { v: 1, partialCommitment: PARTIAL } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(api.handle({ method: 'POST', path: VAULT_POSITION_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toMatchObject({ status: 503 });
  });

  it('honours the global kill switch before reading', async () => {
    const vault = vaultPort();
    const api = apiWith(vault, { globalEnabled: false });
    await expect(api.handle({ method: 'POST', path: VAULT_POSITION_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toMatchObject({ status: 503 });
    expect(vault.getVaultPositions).not.toHaveBeenCalled();
  });

  it('maps a provider failure to the generic answer without echoing it, and keeps metrics aggregate', async () => {
    const vault = vaultPort();
    vault.getShadowAccount.mockRejectedValueOnce(new Error(`node said ${SHADOW} for ${PARTIAL}`));
    const api = apiWith(vault);
    const response = await api.handle({ method: 'POST', path: VAULT_SHADOW_ACCOUNT_PATH, body: { v: 1, partialCommitment: PARTIAL } });
    expect(response).toEqual({ status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } });
    await api.handle({ method: 'POST', path: VAULT_POSITION_PATH, body: { v: 1, account: SHADOW } });
    expect(JSON.stringify(api.metrics.snapshot())).not.toMatch(new RegExp(`${SHADOW.slice(2, 12)}|${PARTIAL.slice(2)}`));
  });

  it('is composed over the private RPC port by the runtime, and only when the port offers it', async () => {
    const withReads = createBackendRuntime(environment(), {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: {
        getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn(),
        getShadowAccount: vi.fn(async () => ({ address: SHADOW, deployed: true })),
        getVaultPositions: vi.fn(),
      } as PoolRpcPort,
      swapPlanner: { prepare: vi.fn() },
    });
    await expect(withReads.api.handle({ method: 'POST', path: VAULT_SHADOW_ACCOUNT_PATH, body: { v: 1, partialCommitment: PARTIAL } }))
      .resolves.toEqual({ status: 200, body: { address: SHADOW, deployed: true } });

    const without = createBackendRuntime(environment(), {
      paymaster: { buildFee: vi.fn(), submit: vi.fn() },
      rpc: { getPoolConfig: vi.fn(), getPublicKey: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn() },
      swapPlanner: { prepare: vi.fn() },
    });
    await expect(without.api.handle({ method: 'POST', path: VAULT_SHADOW_ACCOUNT_PATH, body: { v: 1, partialCommitment: PARTIAL } }))
      .resolves.toMatchObject({ status: 503 });
  });
});

function environment(): Record<string, string> {
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
    BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_UNSHIELD_ENABLED: 'true',
    BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_SWAP_ENABLED: 'true',
    BACKEND_ROUTE_SWAP_MAX_RELAY_FEE: '10',
    BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS: '0',
    BACKEND_ROUTE_SWAP_ALLOWED_TOKENS: STRK,
    BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS: '50',
  };
}
