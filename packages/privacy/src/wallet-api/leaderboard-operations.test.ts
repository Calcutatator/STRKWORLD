import { afterEach, describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  VAULT_MARKETS,
  WalletApiPrivacyOperations,
  type EndurReadClient,
  type EndurUnstakeRead,
  type Intent,
  type LeaderboardReadClient,
  type LeaderboardShadowRow,
  type PoolReadClient,
  type VaultReadClient,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '../index.js';
import { LEADERBOARD_SHADOW_PAGE, receiptInvokeAction, shadowCommitment } from '../leaderboard.js';
import { shadowAccountAddress, vaultSupplyActions } from '../vault.js';

/**
 * Leaderboard phase 1 on the Wallet API: receipts on shield, unshield and
 * send; ledger ticks on the DeFi counters; the placement check; and the one
 * secret, the season partial commitment `p`, kept in memory only.
 */

const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const PLAYER = '0xabc';
const BOB = '0xb0b';
const LEDGER = '0x1ed6e7';
const POOL_FEE = 6n * 10n ** 18n;
const ONE = 10n ** 18n;
const TX = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** The season partial commitment: the secret under test. */
const LB_PARTIAL = '0x1b5eed51de';
const PARTIALS: Record<string, string> = {
  'strkworld-lb-s1': LB_PARTIAL,
  'strkworld-vault': '0x5f2e1d',
  'strkworld-borrow': '0x7a11b0',
  'strkworld-endur': '0x7e11d',
  'strkworld-swap': '0x5aa9',
};
const STRK_MARKET = VAULT_MARKETS.find((market) => market.symbol === 'STRK')!;
const felt = (value: bigint | string) => `0x${BigInt(value).toString(16)}`;

function policy(leaderboard: boolean): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 10n * ONE,
    enabledRoutes: ['shield', 'unshield', 'transfer', 'stake', 'vault', 'unstake'],
    allowedTokens: { shield: [STRK], unshield: [STRK], transfer: [STRK], swap: [], stake: [STRK, XSTRK], vault: [STRK] },
    ...(leaderboard ? { leaderboard: { ledger: LEDGER } } : {}),
  };
}

function endurRead(): EndurUnstakeRead {
  return { chainTime: 1_790_000_000, strk: 0n, xstrk: 0n, outstanding: 0n, complete: true, requests: [] };
}

function fixture(options: {
  leaderboard?: boolean;
  versions?: readonly string[];
  /** Dapp names whose commitment the wallet refuses. */
  refuse?: readonly string[];
  withLeaderboardReads?: boolean;
} = {}) {
  const invoked: STRK20_ACTION[][] = [];
  const commitments: string[] = [];
  const lbCalls: Array<{ method: string; args: unknown[] }> = [];
  const state = {
    deployed: new Set<number>(),
    counts: new Map<bigint, bigint>(),
    verified: 0n as bigint | Error,
    histogram: { season: 's1', total: 3, buckets: [{ count: 1, players: 1 }, { count: 3, players: 1 }, { count: 9, players: 1 }] } as unknown,
    shadowsFail: false,
    /** Addresses the shadow read answers wrong, by nonce. */
    forged: new Set<number>(),
  };
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    async strk20Balances(tokens) { return tokens.map((token) => ({ token, balance: '0x64' })); },
    async strk20PrepareInvoke() { throw new Error('nothing here is relayed'); },
    async strk20InvokeTransaction(actions) {
      invoked.push(structuredClone(actions));
      return { transaction_hash: TX };
    },
    async strk20ShadowAccountCommitment(dappName: string) {
      commitments.push(dappName);
      if (options.refuse?.includes(dappName)) throw { code: 113, message: 'USER_REFUSED_OP' };
      const partial = PARTIALS[dappName];
      if (!partial) throw new Error(`unexpected dapp name ${dappName}`);
      return partial;
    },
  };
  const pool: PoolReadClient = {
    async config() { return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }; },
    async publicKey() { return '0x99'; },
    async receipt() { return { transaction_hash: TX, finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }; },
  };
  const shadowAccount: VaultReadClient['shadowAccount'] = async (partial) => ({ address: shadowAccountAddress(partial), deployed: true });
  const vault: VaultReadClient = {
    shadowAccount,
    async vaultPositions() { return []; },
    async vaultRates() { return []; },
  };
  const endur: EndurReadClient = {
    shadowAccount,
    async endurUnstake() { return endurRead(); },
    async endurRate() { return { strkPerXstrk: ONE }; },
  };
  const leaderboard: LeaderboardReadClient = {
    async leaderboardShadows(partial, page) {
      lbCalls.push({ method: 'shadows', args: [partial, page] });
      if (state.shadowsFail) throw new Error('backend down');
      return Array.from({ length: LEADERBOARD_SHADOW_PAGE }, (_, index): LeaderboardShadowRow => {
        const nonce = page * LEADERBOARD_SHADOW_PAGE + index;
        return {
          nonce: BigInt(nonce),
          // Deriving an address is slow (Pedersen), and only the newest deployed row is checked.
          address: state.forged.has(nonce) ? '0xbad' : nonce === Math.max(-1, ...state.deployed) ? shadowAccountAddress(partial, felt(BigInt(nonce))) : '0x1',
          deployed: state.deployed.has(nonce),
        };
      });
    },
    async leaderboardCounts(commitments) {
      lbCalls.push({ method: 'counts', args: [[...commitments]] });
      return commitments.map((commitment) => state.counts.get(BigInt(commitment)) ?? 0n);
    },
    async leaderboardCheckIn(season, partial) {
      lbCalls.push({ method: 'check-in', args: [season, partial] });
      if (state.verified instanceof Error) throw state.verified;
      return { count: state.verified };
    },
    async leaderboardHistogram() {
      lbCalls.push({ method: 'histogram', args: [] });
      return state.histogram;
    },
  };
  const operations = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions: async () => [...(options.versions ?? ['0.10.3', '0.10.4'])],
    policy: policy(options.leaderboard ?? true),
    vault,
    endur,
    ...(options.withLeaderboardReads === false ? {} : { leaderboard }),
    sleep: async () => undefined,
  });
  return { operations, invoked, commitments, lbCalls, state };
}

const SHIELD: Intent = { kind: 'shield', token: STRK, amount: 20n * ONE };
const UNSHIELD: Intent = { kind: 'unshield', token: STRK, amount: 5n * ONE, recipient: BOB };
const SEND: Intent = { kind: 'transfer', token: STRK, amount: 3n * ONE, recipient: BOB };
const STAKE: Intent = { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK, amountIn: 2n * ONE };

/** The actions each flow sends with the leaderboard off, written out independently. */
const BASELINE = {
  shield: [{ type: 'deposit', token: STRK, amount: felt(20n * ONE + POOL_FEE) }],
  unshield: [{ type: 'withdraw', token: STRK, amount: felt(5n * ONE), recipient: BOB }],
  send: [{ type: 'transfer', token: STRK, amount: felt(3n * ONE), recipient: BOB }],
};

const receipt = (nonce: bigint) => receiptInvokeAction({ ledger: LEDGER, partialCommitment: LB_PARTIAL, nonce });

async function run(ops: WalletApiPrivacyOperations, intent: Intent) {
  const batch = await ops.prepare([intent]);
  await batch.confirm({ feeCeiling: POOL_FEE });
  return batch;
}

describe('leaderboard off: every flow byte-for-byte unchanged', () => {
  it.each([
    ['shield', SHIELD, BASELINE.shield],
    ['unshield', UNSHIELD, BASELINE.unshield],
    ['send', SEND, BASELINE.send],
  ] as const)('%s sends exactly its own actions, asks for no season commitment and reads nothing', async (_label, intent, expected) => {
    const f = fixture({ leaderboard: false });
    const batch = await run(f.operations, intent);
    expect(JSON.stringify(f.invoked)).toBe(JSON.stringify([expected]));
    expect(Object.keys(batch)).not.toContain('countsTowardPlacement');
    expect(f.commitments).toEqual([]);
    expect(f.lbCalls).toEqual([]);
  });

  it('the Vault and Endur unstaking send their own actions, with no tick', async () => {
    const f = fixture({ leaderboard: false });
    const supply = await f.operations.prepareVaultSupply(STRK, 2n * ONE);
    await supply.confirm({ feeCeiling: POOL_FEE });
    const vaultShadow = shadowAccountAddress(PARTIALS['strkworld-vault']!);
    expect(JSON.stringify(f.invoked[0])).toBe(JSON.stringify(vaultSupplyActions({ market: STRK_MARKET, shadowAccount: vaultShadow, amount: 2n * ONE })));
    const unstake = await f.operations.prepareEndurUnstake(ONE);
    await unstake.confirm({ feeCeiling: POOL_FEE });
    const calls = (f.invoked[1]!.find((action) => action.type === 'shadow_account_invoke') as { calls: Array<{ entrypoint: string }> }).calls;
    expect(calls.map((call) => call.entrypoint)).toEqual(['redeem']);
    expect(Object.keys(supply)).not.toContain('countsTowardPlacement');
    expect(Object.keys(unstake)).not.toContain('countsTowardPlacement');
    expect(f.commitments).toEqual(['strkworld-vault', 'strkworld-endur']);
    expect(f.lbCalls).toEqual([]);
  });

  it('refuses a placement check', async () => {
    const f = fixture({ leaderboard: false });
    await expect(f.operations.checkPlacement()).rejects.toThrow('The private placement is switched off.');
    expect(f.commitments).toEqual([]);
  });

  it('refuses a policy whose ledger is not a contract address', () => {
    expect(() => new WalletApiPrivacyOperations({
      wallet: { address: PLAYER } as WalletStrk20Account,
      pool: {} as PoolReadClient,
      supportedVersions: async () => [],
      policy: { ...policy(false), leaderboard: { ledger: '0x0' } },
    })).toThrow('The leaderboard ledger address is invalid.');
  });
});

describe('leaderboard on: receipt mode (shield, unshield, send)', () => {
  it.each([
    ['shield', SHIELD, BASELINE.shield],
    ['unshield', UNSHIELD, BASELINE.unshield],
    ['send', SEND, BASELINE.send],
  ] as const)('%s carries one receipt at nonce 0, last, for the same one pool fee', async (_label, intent, expected) => {
    const f = fixture();
    const batch = await run(f.operations, intent);
    expect(f.invoked).toEqual([[...expected, receipt(0n)]]);
    expect(batch.countsTowardPlacement).toBe(true);
    // One transaction, one pool fee: the receipt costs no second fee.
    expect(batch.poolFee).toBe(POOL_FEE);
    expect(batch.totalCost).toBe(POOL_FEE);
    expect(f.commitments).toEqual(['strkworld-lb-s1']);
  });

  it('takes the nonce after the highest deployed receipt, over a gap', async () => {
    const f = fixture();
    f.state.deployed = new Set([0, 1, 3]);
    await run(f.operations, SEND);
    expect(f.invoked[0]!.at(-1)).toEqual(receipt(4n));
  });

  it('pages past a full first page', async () => {
    const f = fixture();
    f.state.deployed = new Set(Array.from({ length: LEADERBOARD_SHADOW_PAGE + 2 }, (_, n) => n));
    await run(f.operations, SEND);
    expect(f.invoked[0]!.at(-1)).toEqual(receipt(BigInt(LEADERBOARD_SHADOW_PAGE + 2)));
    // Page 1 still held receipts, so page 2 is read too, and holds none.
    expect(f.lbCalls.filter((call) => call.method === 'shadows').map((call) => call.args[1])).toEqual([0, 1, 2]);
  });

  it('never reuses a nonce it has submitted but the chain has not shown yet', async () => {
    const f = fixture();
    await run(f.operations, SHIELD);
    await run(f.operations, SEND);
    expect(f.invoked.map((actions) => actions.at(-1))).toEqual([receipt(0n), receipt(1n)]);
    // The commitment is asked once per connection.
    expect(f.commitments).toEqual(['strkworld-lb-s1']);
  });

  it('a discarded batch leaves no gap: the next one takes the same nonce', async () => {
    const f = fixture();
    const first = await f.operations.prepare([SEND]);
    first.discard();
    await run(f.operations, SEND);
    expect(f.invoked).toEqual([[...BASELINE.send, receipt(0n)]]);
  });

  it('a stake carries no receipt: its one external invoke is Endur\'s', async () => {
    const f = fixture();
    const batch = await run(f.operations, STAKE);
    expect(f.invoked[0]!.filter((action) => action.type === 'shadow_account_invoke')).toEqual([]);
    expect(Object.keys(batch)).not.toContain('countsTowardPlacement');
    expect(f.lbCalls).toEqual([]);
  });

  describe('fails open: the action goes out exactly as without a receipt', () => {
    it.each([
      ['the wallet refuses the season commitment', { refuse: ['strkworld-lb-s1'] }, () => undefined],
      ['the wallet predates shadow accounts', { versions: ['0.10.3'] }, () => undefined],
      ['the backend has no placement reads', { withLeaderboardReads: false }, () => undefined],
      ['the shadow read fails', {}, (f: ReturnType<typeof fixture>) => { f.state.shadowsFail = true; }],
      ['the shadow read names a forged address', {}, (f: ReturnType<typeof fixture>) => { f.state.deployed.add(7); f.state.forged.add(7); }],
    ] as const)('when %s', async (_label, options, arrange) => {
      const f = fixture(options);
      arrange(f);
      const batch = await run(f.operations, SEND);
      expect(JSON.stringify(f.invoked)).toBe(JSON.stringify([BASELINE.send]));
      expect(Object.keys(batch)).not.toContain('countsTowardPlacement');
    });
  });
});

describe('leaderboard on: DeFi mode (the feature shadow ticks)', () => {
  it('the Vault appends ledger.tick(C_vault) after its own calls and reads nothing about the season', async () => {
    const f = fixture();
    const batch = await f.operations.prepareVaultSupply(STRK, 2n * ONE);
    expect(batch.countsTowardPlacement).toBe(true);
    expect(batch.totalCost).toBe(POOL_FEE);
    await batch.confirm({ feeCeiling: POOL_FEE });
    const vaultPartial = PARTIALS['strkworld-vault']!;
    const built = vaultSupplyActions({ market: STRK_MARKET, shadowAccount: shadowAccountAddress(vaultPartial), amount: 2n * ONE });
    const invoke = built[1] as Extract<STRK20_ACTION, { type: 'shadow_account_invoke' }>;
    expect(f.invoked).toEqual([[
      built[0],
      { ...invoke, calls: [...invoke.calls, { contractAddress: LEDGER, entrypoint: 'tick', calldata: [shadowCommitment(vaultPartial, '0x0')] }] },
    ]]);
    // The feature's own commitment, asked once; never the season's.
    expect(f.commitments).toEqual(['strkworld-vault']);
    expect(f.lbCalls).toEqual([]);
  });

  it('Endur unstaking appends ledger.tick(C_endur)', async () => {
    const f = fixture();
    const batch = await f.operations.prepareEndurUnstake(ONE);
    expect(batch.countsTowardPlacement).toBe(true);
    await batch.confirm({ feeCeiling: POOL_FEE });
    const invoke = f.invoked[0]!.find((action) => action.type === 'shadow_account_invoke') as Extract<STRK20_ACTION, { type: 'shadow_account_invoke' }>;
    expect(invoke.calls.at(-1)).toEqual({ contractAddress: LEDGER, entrypoint: 'tick', calldata: [shadowCommitment(PARTIALS['strkworld-endur']!, '0x0')] });
    expect(invoke.calls.map((call) => call.entrypoint)).toEqual(['redeem', 'tick']);
  });
});

describe('the placement check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('counts receipts and DeFi ticks on-chain, checks in with p alone, and reads the histogram', async () => {
    const f = fixture();
    f.state.deployed = new Set([0, 1, 2]);
    for (const nonce of [0n, 1n, 2n]) f.state.counts.set(BigInt(shadowCommitment(LB_PARTIAL, nonce)), 1n);
    f.state.counts.set(BigInt(shadowCommitment(PARTIALS['strkworld-vault']!, '0x0')), 2n);
    f.state.counts.set(BigInt(shadowCommitment(PARTIALS['strkworld-swap']!, '0x0')), 1n);
    f.state.verified = 3n;
    const check = await f.operations.checkPlacement();
    expect(check).toEqual({
      season: 's1',
      receipts: 3,
      defi: 3,
      verified: 3,
      histogram: { season: 's1', total: 3, buckets: [{ count: 1, players: 1 }, { count: 3, players: 1 }, { count: 9, players: 1 }] },
      // Ranked on the verified count, on the device: one player has more.
      ranked: 3,
      placement: { rank: 2, total: 3, topPercent: 67 },
    });
    // The tally gets the season and p: no address, no signature, nothing else.
    expect(f.lbCalls.find((call) => call.method === 'check-in')!.args).toEqual(['s1', LB_PARTIAL]);
    expect(f.commitments).toEqual(['strkworld-lb-s1', 'strkworld-vault', 'strkworld-borrow', 'strkworld-endur', 'strkworld-swap']);
  });

  it('still answers when a DeFi commitment is refused, the tally is down, or the histogram is malformed', async () => {
    const f = fixture({ refuse: ['strkworld-borrow'] });
    f.state.verified = new Error('tally down');
    f.state.histogram = { season: 's1', total: 9, buckets: [] };
    await expect(f.operations.checkPlacement()).resolves.toEqual({
      season: 's1', receipts: 0, defi: 0, verified: null, histogram: null, ranked: 0, placement: null,
    });
  });

  it('rejects as the wallet did when the season commitment is refused', async () => {
    const f = fixture({ refuse: ['strkworld-lb-s1'] });
    await expect(f.operations.checkPlacement()).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(f.lbCalls).toEqual([]);
  });

  it('never persists or logs p: no storage write, no console line, no error and no result carries it', async () => {
    const writes: unknown[][] = [];
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn((...args: unknown[]) => { writes.push(args); }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    const f = fixture();
    f.state.deployed = new Set([0]);
    f.state.counts.set(BigInt(shadowCommitment(LB_PARTIAL, 0n)), 1n);
    f.state.verified = 1n;
    const shown: unknown[] = [];
    const batch = await f.operations.prepare([SHIELD]);
    shown.push(batch);
    shown.push(await batch.confirm({ feeCeiling: POOL_FEE, onProgress: (progress) => shown.push(progress) }));
    shown.push(await f.operations.checkPlacement());
    // A refusal's error does not carry it either.
    const refused = fixture({ refuse: ['strkworld-lb-s1'] });
    shown.push(await refused.operations.checkPlacement().catch((error: unknown) => String(error)));
    f.state.shadowsFail = true;
    shown.push(await f.operations.checkPlacement().catch((error: unknown) => `${String(error)} ${(error as Error).message}`));

    const needle = BigInt(LB_PARTIAL).toString(16);
    const text = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
    expect(writes).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(logged.filter((args) => text(args).includes(needle))).toEqual([]);
    expect(text(shown)).not.toContain(needle);
  });
});
