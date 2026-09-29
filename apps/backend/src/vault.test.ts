import { hash } from 'starknet';
import { describe, expect, it, vi } from 'vitest';
import { BackendApi } from './api.js';
import { MemoryAuthorizationCodec } from './authorization.js';
import { createBackendRuntime } from './runtime.js';
import { BALANCE_OF_SELECTOR, StarknetRpcPoolPort } from './starknet-rpc.js';
import type { BackendConfig, PoolRpcPort, VaultRpcPort } from './types.js';
import {
  GET_SHADOW_ACCOUNTS_SELECTOR,
  MAX_REDEEM_SELECTOR,
  MAX_WITHDRAW_SELECTOR,
  PREVIEW_REDEEM_SELECTOR,
  SHADOW_ACCOUNT_ANONYMIZER,
  VAULT_POSITION_PATH,
  VAULT_SHADOW_ACCOUNT_PATH,
  VESU_VSTRK,
} from './vault.js';

/**
 * D-077: the Vault's two public reads. Each is pinned to one contract and one
 * selector, takes one value from the request, and logs nothing about it.
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
  });

  it('pins the canonical anonymizer and Vesu vSTRK, as read on mainnet', () => {
    expect(SHADOW_ACCOUNT_ANONYMIZER).toBe('0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7');
    expect(VESU_VSTRK).toBe('0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d');
  });
});

function port(result: (request: { method: string; params: unknown[] }) => unknown) {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    requests.push(request);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result(request) }));
  });
  return { rpc: new StarknetRpcPoolPort({ rpcUrl: 'https://rpc.example', poolAddress: POOL, feeToken: STRK, fetcher }), requests, fetcher };
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

describe('the vSTRK position read (D-077)', () => {
  it('answers an empty position from its balance alone', async () => {
    const { rpc, requests } = port(() => ['0x0', '0x0']);
    await expect(rpc.getVaultPosition(SHADOW)).resolves.toEqual({ shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n });
    expect(requests.map(callOf)).toEqual([
      { contract_address: VESU_VSTRK, entry_point_selector: BALANCE_OF_SELECTOR, calldata: [SHADOW] },
    ]);
  });

  it('previews the shares and reads both limits of a held position, as u256 values', async () => {
    const shares = (1n << 128n) + 5n;
    const { rpc, requests } = port((request) => {
      const selector = callOf(request).entry_point_selector;
      if (selector === BALANCE_OF_SELECTOR) return ['0x5', '0x1'];
      if (selector === PREVIEW_REDEEM_SELECTOR) return ['0x64', '0x0'];
      if (selector === MAX_WITHDRAW_SELECTOR) return ['0x60', '0x0'];
      if (selector === MAX_REDEEM_SELECTOR) return ['0x4', '0x1'];
      return null;
    });
    await expect(rpc.getVaultPosition(SHADOW)).resolves.toEqual({
      shares,
      assets: 100n,
      maxWithdraw: 96n,
      maxRedeem: (1n << 128n) + 4n,
    });
    const calls = requests.map(callOf);
    expect(calls.every((call) => call.contract_address === VESU_VSTRK)).toBe(true);
    expect(calls.find((call) => call.entry_point_selector === PREVIEW_REDEEM_SELECTOR)?.calldata).toEqual(['0x5', '0x1']);
    expect(calls.find((call) => call.entry_point_selector === MAX_WITHDRAW_SELECTOR)?.calldata).toEqual([SHADOW]);
    expect(calls.find((call) => call.entry_point_selector === MAX_REDEEM_SELECTOR)?.calldata).toEqual([SHADOW]);
  });

  it.each([
    ['a one-felt balance', () => ['0x5']],
    ['a limb above u128', () => [`0x${(1n << 128n).toString(16)}`, '0x0']],
    ['a non-felt limb', () => ['5', '0x0']],
  ])('refuses %s', async (_label, answer) => {
    const { rpc } = port(answer);
    await expect(rpc.getVaultPosition(SHADOW)).rejects.toThrow();
  });

  it('refuses a zero or malformed account before the RPC is asked', async () => {
    const { rpc, fetcher } = port(() => ['0x0', '0x0']);
    for (const bad of ['0x0', 'abc', `0x${'f'.repeat(64)}`]) {
      await expect(rpc.getVaultPosition(bad)).rejects.toThrow(/account is invalid/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function apiWith(vault?: VaultRpcPort, overrides: Partial<BackendConfig> = {}) {
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
  });
}

function vaultPort(): VaultRpcPort & { getShadowAccount: ReturnType<typeof vi.fn>; getVaultPosition: ReturnType<typeof vi.fn> } {
  return {
    getShadowAccount: vi.fn(async () => ({ address: SHADOW, deployed: false })),
    getVaultPosition: vi.fn(async () => ({ shares: 10n ** 18n, assets: 1_019_826_000_000_000_000n, maxWithdraw: 10n ** 18n, maxRedeem: 10n ** 18n })),
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

  it('answers a position in decimal base units', async () => {
    const vault = vaultPort();
    const api = apiWith(vault);
    await expect(api.handle({ method: 'POST', path: VAULT_POSITION_PATH, body: { v: 1, account: SHADOW } }))
      .resolves.toEqual({
        status: 200,
        body: {
          shares: '1000000000000000000',
          assets: '1019826000000000000',
          maxWithdraw: '1000000000000000000',
          maxRedeem: '1000000000000000000',
        },
      });
    expect(vault.getVaultPosition).toHaveBeenCalledWith(SHADOW, expect.any(AbortSignal));
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
    expect(vault.getVaultPosition).not.toHaveBeenCalled();
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
    expect(vault.getVaultPosition).not.toHaveBeenCalled();
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
        getVaultPosition: vi.fn(),
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
