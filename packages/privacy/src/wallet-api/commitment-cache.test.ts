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
import { LEADERBOARD_SHADOW_PAGE, shadowCommitment } from '../leaderboard.js';
import { shadowAccountAddress } from '../vault.js';
import { WalletCommitmentCache } from './commitment-cache.js';
import { createReceiptNonceStore } from './receipt-nonce-store.js';

/**
 * One wallet prompt at most per placement check (D-122, amended 2026-10-03).
 *
 * The lead shielded in a `?lb=1` tab and then checked their placement, and the
 * wallet asked to share a commitment several times: a check asked for the
 * season commitment and then, route by route, for all four feature
 * commitments. The fix is one in-memory cache per wallet connection, shared by
 * every route, so each dapp name is asked for once per connection and a check
 * sends only what that session already holds.
 *
 * `strk20ShadowAccountCommitment` is counted here as a prompt, because every
 * call may raise one in the wallet. These tests count calls.
 */

const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const PLAYER = '0xabc';
const BOB = '0xb0b';
const LEDGER = '0x1ed6e7';
const POOL_FEE = 6n * 10n ** 18n;
const ONE = 10n ** 18n;
const TX = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const LB_PARTIAL = '0x1b5eed51de';
const PARTIALS: Record<string, string> = {
  'strkworld-lb-s1': LB_PARTIAL,
  'strkworld-vault': '0x5f2e1d',
  'strkworld-borrow': '0x7a11b0',
  'strkworld-endur': '0x7e11d',
  'strkworld-swap': '0x5aa9',
};
const STRK_MARKET = VAULT_MARKETS.find((market) => market.symbol === 'STRK')!;

const SHIELD: Intent = { kind: 'shield', token: STRK, amount: 20n * ONE };
const SEND: Intent = { kind: 'transfer', token: STRK, amount: 3n * ONE, recipient: BOB };

function policy(): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 10n * ONE,
    enabledRoutes: ['shield', 'unshield', 'transfer', 'stake', 'vault', 'unstake'],
    allowedTokens: { shield: [STRK], unshield: [STRK], transfer: [STRK], swap: [], stake: [STRK, XSTRK], vault: [STRK] },
    leaderboard: { ledger: LEDGER },
  };
}

function endurRead(): EndurUnstakeRead {
  return { chainTime: 1_790_000_000, strk: 0n, xstrk: 0n, outstanding: 0n, complete: true, requests: [] };
}

function fixture(options: { rankDefi?: boolean } = {}) {
  /** Every dapp name the wallet was asked for, in order: one entry is one possible prompt. */
  const prompts: string[] = [];
  const state = { deployed: new Set<number>(), counts: new Map<bigint, bigint>(), rankDefi: options.rankDefi === true };
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    async strk20Balances(tokens) { return tokens.map((token) => ({ token, balance: '0x64' })); },
    async strk20PrepareInvoke() { throw new Error('nothing here is relayed'); },
    async strk20InvokeTransaction() { return { transaction_hash: TX }; },
    async strk20ShadowAccountCommitment(dappName: string) {
      prompts.push(dappName);
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
  const vault: VaultReadClient = { shadowAccount, async vaultPositions() { return []; }, async vaultRates() { return []; } };
  const endur: EndurReadClient = {
    shadowAccount,
    async endurUnstake() { return endurRead(); },
    async endurRate() { return { strkPerXstrk: ONE }; },
  };
  const checkIns: Array<readonly string[] | undefined> = [];
  const leaderboard: LeaderboardReadClient = {
    async leaderboardShadows(partial, page) {
      return Array.from({ length: LEADERBOARD_SHADOW_PAGE }, (_, index): LeaderboardShadowRow => {
        const nonce = page * LEADERBOARD_SHADOW_PAGE + index;
        return {
          nonce: BigInt(nonce),
          address: nonce === Math.max(-1, ...state.deployed) ? shadowAccountAddress(partial, `0x${nonce.toString(16)}`) : '0x1',
          deployed: state.deployed.has(nonce),
        };
      });
    },
    async leaderboardCounts(commitments) {
      return commitments.map((commitment) => state.counts.get(BigInt(commitment)) ?? 0n);
    },
    async leaderboardCheckIn(_season, _partial, _signal, featurePartials) {
      checkIns.push(featurePartials === undefined ? undefined : [...featurePartials]);
      return { count: 1n };
    },
    async leaderboardHistogram() {
      return { season: 's1', total: 1, buckets: [{ count: 1, players: 1 }], ...(state.rankDefi ? { rankDefi: true } : {}) };
    },
  };
  const operations = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions: async () => ['0.10.3', '0.10.4'],
    policy: policy(),
    vault,
    endur,
    leaderboard,
    receiptNonces: createReceiptNonceStore(() => {
      const store = new Map<string, string>();
      return { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
    }),
    sleep: async () => undefined,
  });
  return { operations, prompts, state, checkIns, wallet };
}

async function run(f: ReturnType<typeof fixture>, intent: Intent) {
  const batch = await f.operations.prepare([intent]);
  await batch.confirm({ feeCeiling: POOL_FEE });
}

describe('a placement check makes at most one wallet prompt', () => {
  it('asks once on the first check of a session', async () => {
    const f = fixture();
    await f.operations.checkPlacement();
    expect(f.prompts).toEqual(['strkworld-lb-s1']);
  });

  it('asks nothing on a second check in the same session', async () => {
    const f = fixture();
    await f.operations.checkPlacement();
    f.prompts.length = 0;
    await f.operations.checkPlacement();
    await f.operations.checkPlacement();
    expect(f.prompts).toEqual([]);
  });

  it('asks nothing when a receipt already shared the season commitment', async () => {
    const f = fixture();
    await run(f, SHIELD);
    expect(f.prompts).toEqual(['strkworld-lb-s1']);
    f.prompts.length = 0;
    await f.operations.checkPlacement();
    expect(f.prompts).toEqual([]);
  });

  it('asks each dapp name once across receipts, DeFi and two checks together', async () => {
    const f = fixture({ rankDefi: true });
    await run(f, SHIELD);
    await run(f, SEND);
    await (await f.operations.prepareVaultSupply(STRK, 2n * ONE)).confirm({ feeCeiling: POOL_FEE });
    await (await f.operations.prepareVaultSupply(STRK, ONE)).confirm({ feeCeiling: POOL_FEE });
    await (await f.operations.prepareEndurUnstake(ONE)).confirm({ feeCeiling: POOL_FEE });
    await f.operations.checkPlacement();
    await f.operations.checkPlacement();
    // Every flow that needed one, and no dapp name twice.
    expect(f.prompts).toEqual(['strkworld-lb-s1', 'strkworld-vault', 'strkworld-endur']);
    expect(new Set(f.prompts).size).toBe(f.prompts.length);
  });

  it('two routes asking for the same name at once make one prompt', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.operations.prepare([SHIELD]),
      f.operations.prepare([SEND]),
    ]);
    first.discard();
    second.discard();
    expect(f.prompts).toEqual(['strkworld-lb-s1']);
  });

  it('says whether the next check will prompt, and stops saying so once it has', async () => {
    const f = fixture();
    expect(f.operations.placementWillPrompt()).toBe(true);
    await f.operations.checkPlacement();
    expect(f.operations.placementWillPrompt()).toBe(false);
  });
});

describe('the feature partials a check sends', () => {
  it('sends only the counters used this session, and never prompts to collect them', async () => {
    const f = fixture({ rankDefi: true });
    await (await f.operations.prepareVaultSupply(STRK, 2n * ONE)).confirm({ feeCeiling: POOL_FEE });
    f.prompts.length = 0;
    await f.operations.checkPlacement();
    expect(f.checkIns).toEqual([[PARTIALS['strkworld-vault']]]);
    expect(f.prompts).toEqual(['strkworld-lb-s1']);
  });

  it('sends none, and asks for none, when no counter was used', async () => {
    const f = fixture({ rankDefi: true });
    await f.operations.checkPlacement();
    expect(f.checkIns).toEqual([undefined]);
    expect(f.prompts).toEqual(['strkworld-lb-s1']);
  });

  it('counts on-chain ticks only for the cached counters', async () => {
    const f = fixture();
    f.state.counts.set(BigInt(shadowCommitment(PARTIALS['strkworld-vault']!, '0x0')), 5n);
    f.state.counts.set(BigInt(shadowCommitment(PARTIALS['strkworld-borrow']!, '0x0')), 7n);
    await (await f.operations.prepareVaultSupply(STRK, 2n * ONE)).confirm({ feeCeiling: POOL_FEE });
    const check = await f.operations.checkPlacement();
    expect(check.defi).toBe(5);
  });
});

describe('the cache is memory only, and dies with the connection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('forgets everything on disconnect, so the next connection asks again', async () => {
    const f = fixture();
    await (await f.operations.prepareVaultSupply(STRK, 2n * ONE)).confirm({ feeCeiling: POOL_FEE });
    await f.operations.checkPlacement();
    expect(f.prompts).toEqual(['strkworld-vault', 'strkworld-lb-s1']);
    f.operations.forgetCommitments();
    expect(f.operations.placementWillPrompt()).toBe(true);
    f.prompts.length = 0;
    await f.operations.checkPlacement();
    expect(f.prompts).toEqual(['strkworld-lb-s1']);
  });

  it('a second account gets its own cache, so it never reads the first one\'s', async () => {
    const first = fixture();
    await first.operations.checkPlacement();
    // An account change builds new operations over the same wallet object.
    const second = new WalletApiPrivacyOperations({
      wallet: first.wallet,
      pool: { async config() { return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }; }, async publicKey() { return '0x99'; }, async receipt() { return { transaction_hash: TX, finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }; } },
      supportedVersions: async () => ['0.10.3', '0.10.4'],
      policy: policy(),
    });
    expect(second.placementWillPrompt()).toBe(true);
  });

  it('writes nothing to storage and logs nothing while it caches', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
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
    const f = fixture({ rankDefi: true });
    await (await f.operations.prepareVaultSupply(STRK, 2n * ONE)).confirm({ feeCeiling: POOL_FEE });
    await f.operations.checkPlacement();
    await f.operations.checkPlacement();

    const written = JSON.stringify([
      ...storage.setItem.mock.calls,
      ...logged,
    ]);
    for (const secret of Object.values(PARTIALS)) {
      expect(written, secret).not.toContain(secret);
      expect(written, secret).not.toContain(secret.slice(2));
    }
  });

  it('keeps a refused answer out of the cache, so the next flow may ask again', async () => {
    let refuse = true;
    const cache = new WalletCommitmentCache({
      address: PLAYER,
      async strk20Balances() { return []; },
      async strk20PrepareInvoke() { throw new Error('no'); },
      async strk20InvokeTransaction() { return { transaction_hash: TX }; },
      async strk20ShadowAccountCommitment() {
        if (refuse) throw { code: 113, message: 'USER_REFUSED_OP' };
        return LB_PARTIAL;
      },
    } as WalletStrk20Account);
    await expect(cache.commitment('strkworld-lb-s1')).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(cache.cached('strkworld-lb-s1')).toBeNull();
    expect(cache.willAsk('strkworld-lb-s1')).toBe(true);
    refuse = false;
    await expect(cache.commitment('strkworld-lb-s1')).resolves.toBe(LB_PARTIAL);
    expect(cache.willAsk('strkworld-lb-s1')).toBe(false);
    cache.clear();
    expect(cache.cached('strkworld-lb-s1')).toBeNull();
  });

  it('refuses a wallet with no commitment method, and an answer that is not a felt', async () => {
    const without = new WalletCommitmentCache({ address: PLAYER } as WalletStrk20Account);
    await expect(without.commitment('strkworld-lb-s1')).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
    const junk = new WalletCommitmentCache({
      address: PLAYER,
      async strk20ShadowAccountCommitment() { return 'nope' as string; },
    } as unknown as WalletStrk20Account);
    await expect(junk.commitment('strkworld-lb-s1')).rejects.toThrow('invalid shadow-account commitment');
    const zero = new WalletCommitmentCache({
      address: PLAYER,
      async strk20ShadowAccountCommitment() { return '0x0'; },
    } as unknown as WalletStrk20Account);
    await expect(zero.commitment('strkworld-lb-s1')).rejects.toThrow('invalid shadow-account commitment');
  });
});
