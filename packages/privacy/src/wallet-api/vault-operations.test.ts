import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  MAX_VAULT_MARKETS,
  PrivacyError,
  VAULT_MARKETS,
  VESU_VSTRK,
  VESU_VSTRK_ASSET,
  WalletApiPrivacyOperations,
  type PoolReadClient,
  type VaultPositionRow,
  type VaultRateRow,
  type VaultReadClient,
  type VaultStage,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '../index.js';
import { shadowAccountAddress, vaultRedeemActions, vaultSupplyActions } from '../vault.js';
import { VAULT_RECEIPT_WAITS_MS } from './vault-operations.js';

/**
 * The Vault on the Wallet API adapter (D-077, D-079, D-081): capability, the
 * commitment, the cross-checked stand-in address, the position read for every
 * admitted token, the rates read, and the two wallet-submitted batches. The
 * wallet here answers like `WalletAccountV6`: it takes starknet.js `Call`
 * objects inside `shadow_account_invoke` and returns `{ transaction_hash }`.
 */

const STRK = VESU_VSTRK_ASSET;
const marketOf = (symbol: string) => VAULT_MARKETS.find((market) => market.symbol === symbol)!;
const [STRK_MARKET, ETH_MARKET, USDC_MARKET, USDT_MARKET, WBTC_MARKET] = ['STRK', 'ETH', 'USDC', 'USDT', 'WBTC'].map(marketOf) as [
  (typeof VAULT_MARKETS)[number],
  (typeof VAULT_MARKETS)[number],
  (typeof VAULT_MARKETS)[number],
  (typeof VAULT_MARKETS)[number],
  (typeof VAULT_MARKETS)[number],
];
const USDC = USDC_MARKET.token;
const PLAYER = '0xabc';
const PARTIAL = '0x5f2e1d';
const SHADOW = shadowAccountAddress(PARTIAL);
const POOL_FEE = 6n * 10n ** 18n;
const TX = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;

/** The backend's answer: one row per pinned vault, STRK's holding a position. */
function rows(overrides: Record<string, Record<string, unknown>> = {}): VaultPositionRow[] {
  return VAULT_MARKETS.map((market) => ({
    vault: market.vault,
    ok: true,
    ...(market === STRK_MARKET
      ? { shares: 50n * ONE, assets: 51n * ONE, maxWithdraw: 51n * ONE, maxRedeem: 50n * ONE }
      : { shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n }),
    ...overrides[market.symbol],
  }) as VaultPositionRow);
}

function vaultPolicy(overrides: Partial<WalletRoutePolicy> = {}): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 0n,
    enabledRoutes: ['vault'],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], vault: [STRK] },
    ...overrides,
  };
}

/** A policy admitting `tokens` in the Vault, in that order. */
function vaultTokens(...tokens: string[]): WalletRoutePolicy {
  return vaultPolicy({ allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], vault: tokens } });
}

interface Fixture {
  operations: WalletApiPrivacyOperations;
  wallet: WalletStrk20Account;
  invoked: STRK20_ACTION[][];
  commitmentRequests: Array<{ dappName: string; nonce: string | undefined }>;
  shadowReads: string[];
  positionReads: string[];
  rateReads: number;
  receiptReads: string[];
  sleeps: number[];
  stages: VaultStage[];
  onStage: (stage: VaultStage) => void;
  state: {
    versions: readonly string[];
    fee: bigint;
    shadowAddress: string;
    deployed: boolean;
    rows: unknown;
    rates: unknown;
    receipts: unknown[];
  };
}

function fixture(options: {
  policy?: WalletRoutePolicy;
  withCommitment?: boolean;
  withReads?: boolean;
  commitment?: (dappName: string, nonce?: string) => Promise<string>;
  invoke?: (actions: STRK20_ACTION[]) => Promise<{ transaction_hash: string }>;
  receiptWaitsMs?: readonly number[];
} = {}): Fixture {
  const invoked: STRK20_ACTION[][] = [];
  const commitmentRequests: Fixture['commitmentRequests'] = [];
  const shadowReads: string[] = [];
  const positionReads: string[] = [];
  let rateReads = 0;
  const receiptReads: string[] = [];
  const sleeps: number[] = [];
  const stages: VaultStage[] = [];
  const state: Fixture['state'] = {
    versions: ['0.10.3', '0.10.4'],
    fee: POOL_FEE,
    shadowAddress: SHADOW,
    deployed: false,
    rows: rows(),
    rates: [
      { vault: STRK_MARKET.vault, supplyApy: { value: 27351899613523568n, decimals: 18 } },
      { vault: USDC_MARKET.vault, supplyApy: { value: 30925508207480051n, decimals: 18 } },
    ] satisfies VaultRateRow[],
    receipts: [{
      transaction_hash: TX,
      finality_status: 'ACCEPTED_ON_L2',
      execution_status: 'SUCCEEDED',
    }],
  };
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    async strk20Balances() {
      throw new Error('the Vault never reads a private balance');
    },
    async strk20PrepareInvoke() {
      throw new Error('the Vault never asks for a relayed proof');
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return options.invoke ? options.invoke(actions) : { transaction_hash: TX };
    },
    ...(options.withCommitment === false
      ? {}
      : {
          async strk20ShadowAccountCommitment(dappName: string, nonce?: string) {
            commitmentRequests.push({ dappName, nonce });
            return options.commitment ? options.commitment(dappName, nonce) : PARTIAL;
          },
        }),
  };
  const pool: PoolReadClient = {
    async config() {
      return { feeAmount: state.fee, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async publicKey() {
      return '0x1';
    },
    async receipt(hash) {
      receiptReads.push(hash);
      const next = state.receipts.length > 1 ? state.receipts.shift() : state.receipts[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  const reads: VaultReadClient = {
    async shadowAccount(partial) {
      shadowReads.push(partial);
      return { address: state.shadowAddress, deployed: state.deployed };
    },
    async vaultPositions(account) {
      positionReads.push(account);
      return state.rows as never;
    },
    async vaultRates() {
      rateReads += 1;
      if (state.rates instanceof Error) throw state.rates;
      return state.rates as never;
    },
  };
  const operations = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions: async () => state.versions,
    policy: options.policy ?? vaultPolicy(),
    ...(options.withReads === false ? {} : { vault: reads }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(options.receiptWaitsMs ? { vaultReceiptWaitsMs: options.receiptWaitsMs } : {}),
  });
  return {
    operations,
    wallet,
    invoked,
    commitmentRequests,
    shadowReads,
    positionReads,
    get rateReads() {
      return rateReads;
    },
    receiptReads,
    sleeps,
    stages,
    onStage: (stage) => stages.push(stage),
    state,
  };
}

describe('Vault capability (D-077)', () => {
  it.each([
    ['0.10.4 with the method', ['0.10.3', '0.10.4'], true, true],
    ['a later release', ['0.11.0'], true, true],
    ['0.10.3 alone', ['0.10.3'], true, false],
    ['a 0.10.4 prerelease', ['0.10.4-beta.2'], true, false],
    ['0.10.4 without the method', ['0.10.4'], false, false],
    ['nothing parseable', ['latest'], true, false],
  ] as const)('reads %s as %s', async (_label, versions, withCommitment, expected) => {
    const f = fixture({ withCommitment });
    f.state.versions = versions;
    await expect(f.operations.capability()).resolves.toMatchObject({ supportsShadowAccounts: expected });
    // A version query only: never a commitment, never a prompt.
    expect(f.commitmentRequests).toEqual([]);
  });

  it('reads the method without running an accessor', async () => {
    const f = fixture({ withCommitment: false });
    let reads = 0;
    Object.defineProperty(f.wallet, 'strk20ShadowAccountCommitment', {
      get() {
        reads += 1;
        return async () => PARTIAL;
      },
    });
    await expect(f.operations.capability()).resolves.toMatchObject({ supportsShadowAccounts: false });
    expect(reads).toBe(0);
  });

  it('finds the method on the account’s prototype, where WalletAccountV6 declares it', async () => {
    class Account {
      readonly address = PLAYER;
      async strk20Balances() { return []; }
      async strk20PrepareInvoke(): Promise<never> { throw new Error('unused'); }
      async strk20InvokeTransaction() { return { transaction_hash: TX }; }
      async strk20ShadowAccountCommitment() { return PARTIAL; }
    }
    const operations = new WalletApiPrivacyOperations({
      wallet: new Account() as unknown as WalletStrk20Account,
      pool: {} as PoolReadClient,
      supportedVersions: async () => ['0.10.4'],
      policy: vaultPolicy(),
    });
    await expect(operations.capability()).resolves.toMatchObject({ supportsShadowAccounts: true });
  });
});

describe('vaultPositions', () => {
  it('asks the wallet once for the partial commitment, then reads the position publicly', async () => {
    const f = fixture();
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).resolves.toEqual({
      standIn: SHADOW,
      positions: [{ token: STRK, shares: 50n * ONE, assets: 51n * ONE, redeemable: 51n * ONE }],
    });
    // The fixed dapp name, and no nonce: the partial commitment.
    expect(f.commitmentRequests).toEqual([{ dappName: 'strkworld-vault', nonce: undefined }]);
    expect(f.shadowReads).toEqual([PARTIAL]);
    expect(f.positionReads).toEqual([SHADOW]);
    expect(f.invoked).toEqual([]);
    expect(f.stages).toEqual([
      { stage: 'capability', supported: true },
      { stage: 'commitment', ok: true },
      { stage: 'address', resolved: true, deployed: false },
      { stage: 'position', ok: true },
    ]);

    await f.operations.vaultPositions();
    // Deterministic for this account, so asked once per connection.
    expect(f.commitmentRequests).toHaveLength(1);
    expect(f.shadowReads).toEqual([PARTIAL, PARTIAL]);
  });

  it('answers every admitted token in the build’s order, from one read, each from its own vault’s row', async () => {
    const f = fixture({ policy: vaultTokens(USDC, STRK, WBTC_MARKET.token) });
    f.state.rows = rows({
      USDC: { shares: 5n * ONE, assets: 5_090_000n, maxWithdraw: 5_090_000n, maxRedeem: 5n * ONE },
      WBTC: { shares: 2n * ONE, assets: 200_836_820n, maxWithdraw: 100_000_000n, maxRedeem: ONE },
    });
    const read = await f.operations.vaultPositions({ onStage: f.onStage });
    expect(read).toEqual({
      standIn: SHADOW,
      positions: [
        // In the token's own units: vUSDC shares have 18 decimals, USDC 6.
        { token: USDC, shares: 5n * ONE, assets: 5_090_000n, redeemable: 5_090_000n },
        { token: STRK, shares: 50n * ONE, assets: 51n * ONE, redeemable: 51n * ONE },
        { token: WBTC_MARKET.token, shares: 2n * ONE, assets: 200_836_820n, redeemable: 100_000_000n },
      ],
    });
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.positions)).toBe(true);
    expect(f.positionReads).toEqual([SHADOW]);
    expect(f.stages.filter((stage) => stage.stage === 'position')).toEqual([{ stage: 'position', ok: true }]);
  });

  it('needs good rows only for the vaults it admits: another vault’s failed read never blocks it', async () => {
    const f = fixture({ policy: vaultTokens(STRK) });
    f.state.rows = rows({ WBTC: { ok: false, shares: undefined, assets: undefined, maxWithdraw: undefined, maxRedeem: undefined } })
      .map((row) => (row.ok ? row : { vault: row.vault, ok: false as const }));
    await expect(f.operations.vaultPositions()).resolves.toMatchObject({ positions: [{ token: STRK, shares: 50n * ONE }] });
    await expect(f.operations.prepareVaultRedeem(STRK, 'all')).resolves.toMatchObject({ action: { token: STRK, all: true } });
  });

  it('reads an admitted vault the backend could not read as unreachable, never as empty', async () => {
    const f = fixture({ policy: vaultTokens(STRK, USDC) });
    f.state.rows = rows().map((row) => (row.vault === USDC_MARKET.vault ? { vault: row.vault, ok: false as const } : row));
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).rejects.toMatchObject({ kind: 'unreachable' });
    expect(f.stages.at(-1)).toEqual({ stage: 'position', ok: false });
    await expect(f.operations.prepareVaultRedeem(USDC, 'all')).rejects.toMatchObject({ kind: 'unreachable' });
    // A redeem of the other token needs only its own vault's row.
    await expect(f.operations.prepareVaultRedeem(STRK, 'all')).resolves.toMatchObject({ action: { token: STRK } });
    expect(f.invoked).toEqual([]);
  });

  it('ignores rows for vaults the build does not admit, and reads the stand-in address canonically', async () => {
    const f = fixture({ policy: vaultTokens(USDC) });
    f.state.shadowAddress = `0x${'0'.repeat(64 - SHADOW.slice(2).length)}${SHADOW.slice(2)}`;
    await expect(f.operations.vaultPositions()).resolves.toEqual({
      standIn: SHADOW,
      positions: [{ token: USDC, shares: 0n, assets: 0n, redeemable: 0n }],
    });
  });

  it('caps the redeemable amount at what the vault lets the position withdraw now', async () => {
    const f = fixture();
    f.state.rows = rows({ STRK: { shares: 50n * ONE, assets: 51n * ONE, maxWithdraw: 10n * ONE, maxRedeem: 9n * ONE } });
    await expect(f.operations.vaultPositions()).resolves.toMatchObject({ positions: [{ redeemable: 10n * ONE }] });
  });

  it('never puts an amount, an address or the commitment in a stage', async () => {
    const f = fixture();
    await f.operations.vaultPositions({ onStage: f.onStage });
    const text = JSON.stringify(f.stages, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    expect(text).not.toContain(PARTIAL.slice(2));
    expect(text).not.toContain(SHADOW.slice(2, 12));
    expect(text).not.toContain('51');
  });

  it('asks again after a refused commitment', async () => {
    let calls = 0;
    const f = fixture({
      commitment: async () => {
        calls += 1;
        if (calls === 1) throw { code: 113, message: 'An error occurred (USER_REFUSED_OP)' };
        return PARTIAL;
      },
    });
    await expect(f.operations.vaultPositions()).rejects.toMatchObject({ kind: 'user-rejected' });
    await expect(f.operations.vaultPositions()).resolves.toMatchObject({ positions: [{ shares: 50n * ONE }] });
    expect(calls).toBe(2);
  });
});

describe('Vault refusals: fail closed before the wallet is asked', () => {
  it('keeps every Vault call shut while the policy leaves the route off', async () => {
    for (const policy of [
      vaultPolicy({ enabledRoutes: [] }),
      vaultPolicy({ allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] } }),
      vaultTokens(),
      vaultTokens('0x123'),
      // D-079: one unpinned token or a repeat shuts the whole Vault, as the build's parser does.
      vaultTokens(STRK, '0x123'),
      vaultTokens(STRK, USDC, `0x${STRK.slice(3)}`),
      // A token Vesu does not list (LORDS) has no pinned vault.
      vaultTokens('0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49'),
    ]) {
      const f = fixture({ policy });
      await expect(f.operations.vaultPositions()).rejects.toMatchObject({ kind: 'unknown', message: 'The vault route is disabled.' });
      await expect(f.operations.prepareVaultSupply(STRK, ONE)).rejects.toMatchObject({ kind: 'unknown' });
      await expect(f.operations.prepareVaultRedeem(STRK, 'all')).rejects.toMatchObject({ kind: 'unknown' });
      await expect(f.operations.vaultRates()).rejects.toMatchObject({ kind: 'unknown', message: 'The vault route is disabled.' });
      expect(f.commitmentRequests).toEqual([]);
      expect(f.invoked).toEqual([]);
      expect(f.rateReads).toBe(0);
    }
  });

  it('refuses a supply into a collateral-only market before the wallet is asked, and still reads and redeems it (D-081)', async () => {
    const xstrk = marketOf('xSTRK');
    expect(xstrk.lendable).toBe(false);
    const f = fixture({ policy: vaultTokens(STRK, xstrk.token) });
    await expect(f.operations.prepareVaultSupply(xstrk.token, ONE)).rejects.toMatchObject({
      kind: 'unknown',
      message: 'Vesu lends none of that token out, so the Vault does not supply it.',
    });
    expect(f.commitmentRequests).toEqual([]);
    expect(f.invoked).toEqual([]);
    // A position already there reads and redeems as any other.
    f.state.rows = rows({ xSTRK: { shares: 3n * ONE, assets: 3n * ONE, maxWithdraw: 3n * ONE, maxRedeem: 3n * ONE } });
    await expect(f.operations.vaultPositions()).resolves.toMatchObject({
      positions: [{ token: STRK }, { token: xstrk.token, shares: 3n * ONE, assets: 3n * ONE, redeemable: 3n * ONE }],
    });
    const batch = await f.operations.prepareVaultRedeem(xstrk.token, 'all');
    expect(batch.action).toEqual({ kind: 'redeem', token: xstrk.token, amount: 3n * ONE, all: true });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([
      vaultRedeemActions({ market: xstrk, shadowAccount: SHADOW, player: PLAYER, redeem: { shares: 3n * ONE } }),
    ]);
  });

  it('refuses a token the build does not admit, even one with a pinned vault, before the wallet is asked', async () => {
    const f = fixture({ policy: vaultTokens(STRK) });
    await expect(f.operations.prepareVaultSupply(USDC, USDC_ONE)).rejects.toMatchObject({
      kind: 'unknown',
      message: 'The Vault does not lend that token in this build.',
    });
    await expect(f.operations.prepareVaultRedeem(USDC, 'all')).rejects.toMatchObject({ kind: 'unknown' });
    await expect(f.operations.prepareVaultSupply(42 as never, ONE)).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.commitmentRequests).toEqual([]);
  });

  it('says the wallet cannot run a shadow account yet, without asking it anything', async () => {
    const f = fixture();
    f.state.versions = ['0.10.3'];
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).rejects.toMatchObject({
      kind: 'shadow-accounts-unsupported',
    });
    expect(f.commitmentRequests).toEqual([]);
    expect(f.stages).toEqual([{ stage: 'capability', supported: false }]);
  });

  it.each([
    ['API_VERSION_NOT_SUPPORTED', { code: 162, message: 'An error occurred (API_VERSION_NOT_SUPPORTED)' }, 'shadow-accounts-unsupported', 162],
    ['method not found', { code: -32601, message: 'Method not found' }, 'shadow-accounts-unsupported', -32601],
    ['NOT_REGISTERED', { code: 118, message: 'An error occurred (NOT_REGISTERED)' }, 'not-registered', 118],
    ['USER_REFUSED_OP', { code: 113, message: 'An error occurred (USER_REFUSED_OP)' }, 'user-rejected', 113],
    ['a codeless failure', new Error('socket closed'), 'unreachable', null],
  ] as const)('maps a commitment answered with %s to %s, keeping only the code for the log', async (_label, answer, kind, code) => {
    const f = fixture({ commitment: async () => { throw answer; } });
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).rejects.toMatchObject({ kind });
    expect(f.stages).toEqual([
      { stage: 'capability', supported: true },
      { stage: 'commitment', ok: false, code },
    ]);
    expect(f.shadowReads).toEqual([]);
  });

  it.each([
    ['zero', '0x0'],
    ['not a felt', 'commitment'],
    ['a number', 42],
  ])('refuses a %s commitment from the wallet', async (_label, answer) => {
    const f = fixture({ commitment: async () => answer as never });
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.stages.at(-1)).toEqual({ stage: 'commitment', ok: false, code: null });
    expect(f.shadowReads).toEqual([]);
  });

  it('refuses a stand-in address the anonymizer would not derive, so a relay cannot redirect the supply', async () => {
    const f = fixture();
    f.state.shadowAddress = '0x7a5c0ffee';
    await expect(f.operations.prepareVaultSupply(STRK, ONE, { onStage: f.onStage })).rejects.toMatchObject({
      kind: 'unknown',
      message: 'The Vault could not verify its stand-in address, so nothing was sent.',
    });
    expect(f.stages.at(-1)).toEqual({ stage: 'address', resolved: false });
    expect(f.positionReads).toEqual([]);
    expect(f.invoked).toEqual([]);
  });

  it('fails closed with no backend reads composed', async () => {
    const f = fixture({ withReads: false });
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.stages.at(-1)).toEqual({ stage: 'address', resolved: false });
    await expect(f.operations.vaultRates()).rejects.toMatchObject({ kind: 'unknown', message: 'The Vault reads are not configured.' });
  });

  it('reports an unreachable address read as unreachable', async () => {
    const f = fixture();
    vi.spyOn(f.state, 'shadowAddress', 'get').mockImplementation(() => {
      throw new Error('socket closed');
    });
    await expect(f.operations.vaultPositions()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it.each([
    ['a negative figure', rows({ STRK: { shares: -1n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n } })],
    ['more redeemable shares than held', rows({ STRK: { shares: 1n, assets: 1n, maxWithdraw: 1n, maxRedeem: 2n } })],
    ['a number', rows({ STRK: { shares: 1 as never } })],
    ['no row for an admitted vault', rows().filter((row) => row.vault !== STRK_MARKET.vault)],
    ['two rows for one vault', [...rows(), rows()[0]!]],
    ['a row whose vault is not an address', rows().map((row, index) => (index === 0 ? { ...row, vault: 42 } : row))],
    ['a row that says neither ok nor not', rows({ STRK: { ok: 'yes' } })],
    ['a row with figures but no ok', rows().map((row, index) => (index === 0 ? { ...row, ok: undefined } : row))],
    ['an object, not a list', { ...rows() }],
    ['more rows than any backend pins', Array.from({ length: MAX_VAULT_MARKETS + 1 }, () => rows()[1]!)],
  ])('refuses a position read with %s', async (_label, answer) => {
    const f = fixture();
    f.state.rows = answer;
    await expect(f.operations.vaultPositions({ onStage: f.onStage })).rejects.toMatchObject({
      kind: 'unknown',
      message: 'The Vault position read is invalid.',
    });
    expect(f.stages.at(-1)).toEqual({ stage: 'position', ok: false });
  });

  it('never runs a getter on a position row', async () => {
    const f = fixture();
    let reads = 0;
    const [first, ...rest] = rows();
    const hostile = Object.defineProperty({ ...first! }, 'assets', {
      get() {
        reads += 1;
        return 51n * ONE;
      },
      enumerable: true,
    });
    f.state.rows = [hostile, ...rest];
    await expect(f.operations.vaultPositions()).rejects.toMatchObject({ kind: 'unknown' });
    expect(reads).toBe(0);
  });
});

describe('vaultRates (D-079)', () => {
  it('answers Vesu’s figure for each admitted token that has one, in the build’s order, asking no wallet', async () => {
    const f = fixture({ policy: vaultTokens(USDC, ETH_MARKET.token, STRK) });
    await expect(f.operations.vaultRates()).resolves.toEqual([
      { token: USDC, supplyApy: { value: 30925508207480051n, decimals: 18 } },
      { token: STRK, supplyApy: { value: 27351899613523568n, decimals: 18 } },
    ]);
    expect(f.rateReads).toBe(1);
    expect(f.commitmentRequests).toEqual([]);
    expect(f.shadowReads).toEqual([]);
  });

  it('leaves out a rate for a vault the build does not admit', async () => {
    const f = fixture({ policy: vaultTokens(USDT_MARKET.token) });
    await expect(f.operations.vaultRates()).resolves.toEqual([]);
  });

  it.each([
    ['a negative value', [{ vault: STRK_MARKET.vault, supplyApy: { value: -1n, decimals: 18 } }]],
    ['a number value', [{ vault: STRK_MARKET.vault, supplyApy: { value: 1, decimals: 18 } }]],
    ['fractional decimals', [{ vault: STRK_MARKET.vault, supplyApy: { value: 1n, decimals: 1.5 } }]],
    ['too many decimals', [{ vault: STRK_MARKET.vault, supplyApy: { value: 1n, decimals: 37 } }]],
    ['a rate of 10,000%', [{ vault: STRK_MARKET.vault, supplyApy: { value: 100n * ONE, decimals: 18 } }]],
    ['a rate past u256', [{ vault: STRK_MARKET.vault, supplyApy: { value: 1n << 256n, decimals: 18 } }]],
    ['no rate', [{ vault: STRK_MARKET.vault }]],
    ['two rows for one vault', [
      { vault: STRK_MARKET.vault, supplyApy: { value: 1n, decimals: 2 } },
      { vault: STRK_MARKET.vault, supplyApy: { value: 2n, decimals: 2 } },
    ]],
    ['an object, not a list', { vault: STRK_MARKET.vault }],
  ])('refuses a rates read with %s', async (_label, answer) => {
    const f = fixture();
    f.state.rates = answer;
    await expect(f.operations.vaultRates()).rejects.toMatchObject({ kind: 'unknown', message: 'The Vault rates read is invalid.' });
  });

  it('reports an unreachable read as unreachable, and a cancelled one as cancelled', async () => {
    const f = fixture();
    f.state.rates = new Error('socket closed');
    await expect(f.operations.vaultRates()).rejects.toMatchObject({ kind: 'unreachable' });
    const controller = new AbortController();
    controller.abort();
    await expect(f.operations.vaultRates(controller.signal)).rejects.toMatchObject({ kind: 'user-rejected' });
    await expect(f.operations.vaultRates({} as never)).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('prepareVaultSupply', () => {
  it('costs a supply of STRK and hands the wallet the reviewed actions to prove and submit', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultSupply(STRK, 5n * ONE, { onStage: f.onStage });
    expect(batch).toMatchObject({
      action: { kind: 'supply', token: STRK, amount: 5n * ONE },
      poolFee: POOL_FEE,
      gasEstimate: 0n,
      totalCost: POOL_FEE,
      warnings: [],
      promptCount: 1,
    });
    // Preparing proves nothing and submits nothing.
    expect(f.invoked).toEqual([]);

    const submitted: string[] = [];
    const confirmStages: VaultStage[] = [];
    const progress: string[] = [];
    await expect(batch.confirm({
      feeCeiling: POOL_FEE,
      onStage: (stage) => confirmStages.push(stage),
      onProgress: ({ stage }) => progress.push(stage),
      onSubmitted: ({ transactionHash }) => submitted.push(transactionHash),
    })).resolves.toEqual({ transactionHash: TX, outcome: 'succeeded' });

    expect(f.invoked).toEqual([vaultSupplyActions({ market: STRK_MARKET, shadowAccount: SHADOW, amount: 5n * ONE })]);
    expect(f.invoked[0]).toEqual([
      { type: 'withdraw', token: STRK, amount: '0x4563918244f40000', recipient: SHADOW },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [
          { contractAddress: STRK, entrypoint: 'approve', calldata: [VESU_VSTRK, '0x4563918244f40000', '0x0'] },
          { contractAddress: VESU_VSTRK, entrypoint: 'deposit', calldata: ['0x4563918244f40000', '0x0', SHADOW] },
        ],
        collect_policy: { type: 'exact', amount: '0x0' },
      },
    ]);
    expect(submitted).toEqual([TX]);
    expect(confirmStages).toEqual([
      { stage: 'submit', ok: true },
      { stage: 'receipt', status: 'succeeded' },
    ]);
    expect(progress).toEqual(['awaiting-approval', 'confirming', 'done']);
    expect(f.receiptReads).toEqual([TX]);
    expect(f.sleeps).toEqual([VAULT_RECEIPT_WAITS_MS[0]]);
  });

  it('supplies another admitted token through its own vault, in its own units', async () => {
    const f = fixture({ policy: vaultTokens(STRK, USDC) });
    const batch = await f.operations.prepareVaultSupply(USDC, 25n * USDC_ONE);
    // The pool fee is the pool's, in STRK, whatever the action moves.
    expect(batch).toMatchObject({ action: { kind: 'supply', token: USDC, amount: 25n * USDC_ONE }, poolFee: POOL_FEE, totalCost: POOL_FEE });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([[
      { type: 'withdraw', token: USDC, amount: '0x17d7840', recipient: SHADOW },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [
          { contractAddress: USDC, entrypoint: 'approve', calldata: [USDC_MARKET.vault, '0x17d7840', '0x0'] },
          { contractAddress: USDC_MARKET.vault, entrypoint: 'deposit', calldata: ['0x17d7840', '0x0', SHADOW] },
        ],
        collect_policy: { type: 'exact', amount: '0x0' },
      },
    ]]);
  });

  it('reviews the pinned spelling of the token, whatever spelling it was asked in', async () => {
    const f = fixture({ policy: vaultTokens(USDC) });
    const batch = await f.operations.prepareVaultSupply(`0x${USDC.slice(3).toUpperCase()}`, USDC_ONE);
    expect(batch.action).toEqual({ kind: 'supply', token: USDC, amount: USDC_ONE });
  });

  it.each([
    ['another token', '0x123', ONE],
    ['a zero amount', STRK, 0n],
    ['a negative amount', STRK, -1n],
    ['an amount past u256', STRK, 1n << 256n],
  ])('refuses %s before the wallet is asked', async (_label, token, amount) => {
    const f = fixture();
    await expect(f.operations.prepareVaultSupply(token, amount)).rejects.toBeInstanceOf(PrivacyError);
    expect(f.commitmentRequests).toEqual([]);
  });

  it('refuses to sign above the fee ceiling, before the wallet is asked', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    f.state.fee = POOL_FEE + 1n;
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.invoked).toEqual([]);
  });

  it('is single-attempt and honours discard', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    await batch.confirm({ feeCeiling: POOL_FEE });
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });

    const discarded = await f.operations.prepareVaultSupply(STRK, ONE);
    discarded.discard();
    discarded.discard();
    await expect(discarded.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.invoked).toHaveLength(1);
  });

  it('gives the wallet its own copy, so nothing it does reaches the reviewed batch', async () => {
    const f = fixture({
      invoke: async (actions) => {
        const invoke = actions[1] as Extract<STRK20_ACTION, { type: 'shadow_account_invoke' }>;
        (invoke.calls[1]!.calldata as string[])[2] = '0xbad';
        (actions[0] as { recipient: string }).recipient = '0xbad';
        return { transaction_hash: TX };
      },
    });
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    await batch.confirm({ feeCeiling: POOL_FEE });
    // The recorded argument is the wallet's own copy, which it mutated; the
    // reviewed actions behind the batch are frozen and untouched.
    expect(Object.isFrozen(batch)).toBe(true);
    expect(f.invoked[0]![0]).toMatchObject({ recipient: '0xbad' });
  });

  it.each([
    ['USER_REFUSED_OP', 113, 'user-rejected'],
    ['NOT_REGISTERED', 118, 'not-registered'],
    ['INSUFFICIENT_PRIVATE_BALANCE', 119, 'insufficient-balance'],
    ['PRIVACY_LEAK', 120, 'privacy-leak'],
    ['API_VERSION_NOT_SUPPORTED', 162, 'shadow-accounts-unsupported'],
    ['UNKNOWN_ERROR', 163, 'unknown'],
  ] as const)('maps a submission answered with %s to %s, with the code for the log', async (name, code, kind) => {
    const f = fixture({ invoke: async () => { throw { code, message: `An error occurred (${name})` }; } });
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    const stages: VaultStage[] = [];
    const submitted: string[] = [];
    await expect(batch.confirm({
      feeCeiling: POOL_FEE,
      onStage: (stage) => stages.push(stage),
      onSubmitted: ({ transactionHash }) => submitted.push(transactionHash),
    })).rejects.toMatchObject({ kind });
    expect(stages).toEqual([{ stage: 'submit', ok: false, code }]);
    expect(submitted).toEqual([]);
    expect(f.receiptReads).toEqual([]);
  });

  it('refuses an invalid transaction result', async () => {
    const f = fixture({ invoke: async () => ({ transaction_hash: '0x0' }) });
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('the receipt wait after the wallet submits', () => {
  it('reads until the receipt settles, and reports a revert', async () => {
    const f = fixture();
    f.state.receipts = [
      null,
      { transaction_hash: TX, finality_status: 'PRE_CONFIRMED', execution_status: 'SUCCEEDED' },
      { transaction_hash: TX, finality_status: 'ACCEPTED_ON_L2', execution_status: 'REVERTED' },
    ];
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    const stages: VaultStage[] = [];
    await expect(batch.confirm({ feeCeiling: POOL_FEE, onStage: (stage) => stages.push(stage) }))
      .resolves.toEqual({ transactionHash: TX, outcome: 'reverted' });
    expect(f.receiptReads).toHaveLength(3);
    expect(f.sleeps).toEqual(VAULT_RECEIPT_WAITS_MS.slice(0, 3));
    expect(stages.at(-1)).toEqual({ stage: 'receipt', status: 'reverted' });
  });

  it('never rejects once a hash exists: an unreadable chain resolves pending', async () => {
    const f = fixture({ receiptWaitsMs: [1, 1, 1] });
    f.state.receipts = [new Error('502'), new Error('502')];
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    const stages: VaultStage[] = [];
    await expect(batch.confirm({ feeCeiling: POOL_FEE, onStage: (stage) => stages.push(stage) }))
      .resolves.toEqual({ transactionHash: TX, outcome: 'pending' });
    expect(stages.at(-1)).toEqual({ stage: 'receipt', status: 'unreadable' });
  });

  it('resolves pending when the caller stops waiting', async () => {
    const f = fixture();
    const controller = new AbortController();
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    await expect(batch.confirm({
      feeCeiling: POOL_FEE,
      signal: controller.signal,
      onSubmitted: () => controller.abort(),
    })).resolves.toEqual({ transactionHash: TX, outcome: 'pending' });
    expect(f.receiptReads).toEqual([]);
  });

  it('keeps the submitted result when an observer throws', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultSupply(STRK, ONE);
    await expect(batch.confirm({
      feeCeiling: POOL_FEE,
      onSubmitted: () => { throw new Error('observer'); },
      onStage: () => { throw new Error('observer'); },
      onProgress: () => { throw new Error('observer'); },
    })).resolves.toEqual({ transactionHash: TX, outcome: 'succeeded' });
  });
});

describe('prepareVaultRedeem', () => {
  it('withdraws an exact amount back into a pool note owned by this account', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultRedeem(STRK, 10n * ONE, { onStage: f.onStage });
    expect(batch.action).toEqual({ kind: 'redeem', token: STRK, amount: 10n * ONE, all: false });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([
      vaultRedeemActions({ market: STRK_MARKET, shadowAccount: SHADOW, player: PLAYER, redeem: { assets: 10n * ONE } }),
    ]);
    expect(f.invoked[0]).toEqual([
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: PLAYER },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [{ contractAddress: VESU_VSTRK, entrypoint: 'withdraw', calldata: ['0x8ac7230489e80000', '0x0', SHADOW, SHADOW] }],
        collect_policy: { type: 'diff' },
      },
    ]);
    expect(f.stages).toEqual([
      { stage: 'capability', supported: true },
      { stage: 'commitment', ok: true },
      { stage: 'address', resolved: true, deployed: false },
      { stage: 'position', ok: true },
    ]);
  });

  it('redeems every share for “all”, reviewing the vault’s preview as the amount', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultRedeem(STRK, 'all');
    expect(batch.action).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([
      vaultRedeemActions({ market: STRK_MARKET, shadowAccount: SHADOW, player: PLAYER, redeem: { shares: 50n * ONE } }),
    ]);
  });

  it('redeems another token from its own vault into a note of that token', async () => {
    const f = fixture({ policy: vaultTokens(STRK, USDC) });
    f.state.rows = rows({ USDC: { shares: 5n * ONE, assets: 5_090_000n, maxWithdraw: 5_090_000n, maxRedeem: 5n * ONE } });
    const partial = await f.operations.prepareVaultRedeem(USDC, 2n * USDC_ONE);
    expect(partial.action).toEqual({ kind: 'redeem', token: USDC, amount: 2n * USDC_ONE, all: false });
    await partial.confirm({ feeCeiling: POOL_FEE });
    const all = await f.operations.prepareVaultRedeem(USDC, 'all');
    expect(all.action).toEqual({ kind: 'redeem', token: USDC, amount: 5_090_000n, all: true });
    await all.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([
      [
        { type: 'transfer', token: USDC, amount: 'OPEN', recipient: PLAYER },
        {
          type: 'shadow_account_invoke',
          dapp_name: 'strkworld-vault',
          nonce: '0x0',
          calls: [{ contractAddress: USDC_MARKET.vault, entrypoint: 'withdraw', calldata: ['0x1e8480', '0x0', SHADOW, SHADOW] }],
          collect_policy: { type: 'diff' },
        },
      ],
      vaultRedeemActions({ market: USDC_MARKET, shadowAccount: SHADOW, player: PLAYER, redeem: { shares: 5n * ONE } }),
    ]);
  });

  it('checks the redeem against its own token’s position, not another’s', async () => {
    const f = fixture({ policy: vaultTokens(STRK, USDC) });
    // STRK holds 51; USDC holds nothing.
    await expect(f.operations.prepareVaultRedeem(USDC, 'all')).rejects.toMatchObject({
      kind: 'unknown',
      message: 'There is nothing in the Vault to redeem.',
    });
    await expect(f.operations.prepareVaultRedeem(USDC, 1n)).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.invoked).toEqual([]);
  });

  it('refuses more than the vault lets the position withdraw now', async () => {
    const f = fixture();
    f.state.rows = rows({ STRK: { shares: 50n * ONE, assets: 51n * ONE, maxWithdraw: 10n * ONE, maxRedeem: 9n * ONE } });
    await expect(f.operations.prepareVaultRedeem(STRK, 10n * ONE + 1n)).rejects.toMatchObject({ kind: 'unknown' });
    // “All” needs every share redeemable now.
    await expect(f.operations.prepareVaultRedeem(STRK, 'all')).rejects.toMatchObject({ kind: 'unknown' });
    await expect(f.operations.prepareVaultRedeem(STRK, 10n * ONE)).resolves.toMatchObject({ action: { amount: 10n * ONE } });
  });

  it('refuses to redeem an empty position', async () => {
    const f = fixture();
    f.state.rows = rows({ STRK: { shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n } });
    await expect(f.operations.prepareVaultRedeem(STRK, 'all')).rejects.toMatchObject({ kind: 'unknown' });
    await expect(f.operations.prepareVaultRedeem(STRK, 1n)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([0n, -1n])('refuses a %s amount before the wallet is asked', async (amount) => {
    const f = fixture();
    await expect(f.operations.prepareVaultRedeem(STRK, amount)).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.commitmentRequests).toEqual([]);
  });
});
