// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  LEADERBOARD_DAPP_NAME,
  WalletApiPrivacyOperations,
  createWalletSession,
  setLeaderboardNoticeSink,
  type Intent,
  type LeaderboardNotice,
  type LeaderboardReadClient,
  type LeaderboardShadowRow,
  type PoolReadClient,
  type WalletConnectionPort,
  type WalletDiscoveryPort,
  type WalletHandle,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '@strkworld/privacy';
import { parseProductionWalletConfig, withLeaderboardProbe } from './config.js';
import { detectLeaderboardProbe, leaderboardProbe, resetLeaderboardProbe } from './leaderboard-probe.js';
import { describeLeaderboardStep } from '../debug/debug-format.js';

/**
 * The production wiring of the private placement (D-122, amended 2026-10-02),
 * reproduced as the lead's own probe runs it: a tab opened with `?lb=1`, the
 * Railway build's own variables, `parseProductionWalletConfig`, and the real
 * `createWalletSession` the shell builds — the step that was dropping the
 * ledger before a single action was ever composed.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const LEDGER = '0x1517eeedc0d7a352e841a87a55312e2e19d28e6d09247822b28d044541766f8';
const PLAYER = '0xabc';
const BOB = '0xb0b';
const POOL_FEE = 6n * 10n ** 18n;
const ONE = 10n ** 18n;
const TX = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** The season partial commitment: the one secret, never written anywhere. */
const LB_PARTIAL = '0x1b5eed51de';
const SHADOW_PAGE = 128;

/** The three actions that pay the pool fee from the player's own account. */
const FEE_PAYING_INTENTS: readonly Intent[] = Object.freeze([
  { kind: 'shield', token: STRK, amount: 20n * ONE },
  { kind: 'unshield', token: STRK, amount: 5n * ONE, recipient: BOB },
  { kind: 'transfer', token: STRK, amount: 2n * ONE, recipient: BOB },
]);

/** Exactly what Railway sets for the probe deploy. */
const RAILWAY_ENV = Object.freeze({
  PROD: true,
  VITE_WALLET_MODE: 'real',
  VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
  VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
  VITE_BACKEND_BASE_URL: '/api',
  VITE_STRK20_SHIELD_ENABLED: 'true',
  VITE_STRK20_SHIELD_MAX_INTENTS: '1',
  VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
  VITE_STRK20_UNSHIELD_ENABLED: 'true',
  VITE_STRK20_UNSHIELD_MAX_INTENTS: '1',
  VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '5000000000000000000',
  VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: STRK,
  VITE_STRK20_TRANSFER_ENABLED: 'true',
  VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
  VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '5000000000000000000',
  VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK,
  VITE_STRK20_LEADERBOARD_ENABLED: 'true',
  VITE_STRK20_LEADERBOARD_LEDGER: LEDGER,
});

function leaderboardReads(): LeaderboardReadClient {
  return {
    async leaderboardShadows(_partial, page) {
      return Array.from({ length: SHADOW_PAGE }, (_, index): LeaderboardShadowRow => ({
        nonce: BigInt(page * SHADOW_PAGE + index),
        address: '0x1',
        deployed: false,
      }));
    },
    async leaderboardCounts(commitments) {
      return commitments.map(() => 0n);
    },
    async leaderboardCheckIn() {
      return { count: 0n };
    },
    async leaderboardHistogram() {
      return { season: 's1', total: 0, buckets: [] };
    },
  };
}

/**
 * The production session, built the way `createProductionWalletSession` builds
 * it: the parsed config's policy through `createWalletSession`, and the Wallet
 * API operations with the same backend behind the placement's reads.
 */
function productionSession(
  policy: WalletRoutePolicy,
  options: {
    /** Omit the wallet's shadow-account method, as a wallet on the public route does. */
    readonly shadowAccounts?: false;
    /** Leave the placement's backend reads unconfigured. */
    readonly reads?: false;
  } = {},
) {
  const invoked: STRK20_ACTION[][] = [];
  const base = {
    address: PLAYER,
    async strk20Balances(tokens: readonly string[]) {
      return tokens.map((token) => ({ token, balance: '0x3635c9adc5dea00000' }));
    },
    async strk20PrepareInvoke() {
      throw new Error('nothing here is relayed');
    },
    async strk20InvokeTransaction(actions: readonly STRK20_ACTION[]) {
      invoked.push(structuredClone(actions) as STRK20_ACTION[]);
      return { transaction_hash: TX };
    },
  };
  const wallet: WalletStrk20Account = options.shadowAccounts === false
    ? (base as WalletStrk20Account)
    : ({
      ...base,
      async strk20ShadowAccountCommitment(dappName: string) {
        if (dappName !== LEADERBOARD_DAPP_NAME) throw new Error(`unexpected dapp name ${dappName}`);
        return LB_PARTIAL;
      },
    } as WalletStrk20Account);
  const pool: PoolReadClient = {
    async config() {
      return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async publicKey() {
      return '0x99';
    },
    async receipt() {
      return { transaction_hash: TX, finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' };
    },
  };
  const seen: WalletRoutePolicy[] = [];
  const handle: WalletHandle = { name: 'Ready', icon: 'data:image/svg+xml,Ready' };
  const discovery: WalletDiscoveryPort = {
    getWallets: () => [handle],
    subscribe: () => () => undefined,
    refresh: () => undefined,
  };
  const connection = (given: WalletRoutePolicy): WalletConnectionPort => ({
    getSnapshot: () => ({ account: PLAYER, chainId: '0x534e5f4d41494e' }),
    createOperations: (admitted) => {
      seen.push(admitted);
      return new WalletApiPrivacyOperations({
        wallet,
        pool,
        supportedVersions: async () => ['0.10.3', '0.10.4'],
        policy: admitted,
        ...(options.reads === false ? {} : { leaderboard: leaderboardReads() }),
        receiptNonces: { read: () => null, write: () => undefined },
        sleep: async () => undefined,
      });
    },
    subscribe: () => () => undefined,
    disconnect: async () => undefined,
    destroy: () => undefined,
  });
  void connection;
  const session = createWalletSession(
    { rpcUrl: 'https://rpc.example/rpc', backendBaseUrl: '/api', policy, expectedChainId: '0x534e5f4d41494e' },
    { discovery, connectWallet: async () => connection(policy) },
  );
  return { session, invoked, seen };
}

beforeEach(() => {
  sessionStorage.clear();
  resetLeaderboardProbe();
  window.history.replaceState(null, '', '/');
});

describe('the production wiring of a probing tab carries receipts', () => {
  it('keeps the ledger in the policy the session admits, and attaches a receipt to shield and unshield', async () => {
    window.history.replaceState(null, '', '/?lb=1');
    const config = parseProductionWalletConfig(
      withLeaderboardProbe(RAILWAY_ENV as never, detectLeaderboardProbe()),
    );
    expect(config.policy.leaderboard?.ledger).toBe(LEDGER);

    const wiring = productionSession(config.policy);
    const snapshot = await wiring.session.connect(wiring.session.getSnapshot().wallets[0]!.key);
    expect(snapshot.phase).toBe('connected');
    // The session's own copy of the policy is what the operations are built on.
    expect(wiring.seen[0]?.leaderboard?.ledger).toBe(LEDGER);

    for (const intent of FEE_PAYING_INTENTS) {
      const batch = await wiring.session.operations.prepare([intent]);
      expect(batch.countsTowardPlacement, intent.kind).toBe(true);
      await batch.confirm({ feeCeiling: POOL_FEE });
    }
    for (const [index, actions] of wiring.invoked.entries()) {
      const receipt = actions.at(-1);
      expect(receipt?.type, `transaction ${index}`).toBe('shadow_account_invoke');
    }
    expect(wiring.invoked).toHaveLength(FEE_PAYING_INTENTS.length);
  });

  it('carries nothing in a tab that never asked, with the same build', async () => {
    const config = parseProductionWalletConfig(
      withLeaderboardProbe(RAILWAY_ENV as never, detectLeaderboardProbe()),
    );
    expect(Object.keys(config.policy)).not.toContain('leaderboard');

    const wiring = productionSession(config.policy);
    await wiring.session.connect(wiring.session.getSnapshot().wallets[0]!.key);
    expect(Object.keys(wiring.seen[0] ?? {})).not.toContain('leaderboard');
    const batch = await wiring.session.operations.prepare([FEE_PAYING_INTENTS[0]!]);
    expect(Object.keys(batch)).not.toContain('countsTowardPlacement');
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(wiring.invoked[0]?.some((action) => action.type === 'shadow_account_invoke')).toBe(false);
  });
});

/**
 * The probe is a property of the tab, not of the page's URL at any one moment:
 * it is resolved once per page load and remembered in `sessionStorage`. So the
 * title screen, the connect step and the entry gate — any of which may rewrite
 * the URL, and D-069's logger does drop its own `debug` parameter — cannot lose
 * it, and neither can a reload.
 */
describe('the probe survives the title screen, connect and the entry gate', () => {
  it('holds through a URL rewritten after the first read, and through a reload', () => {
    window.history.replaceState(null, '', '/?lb=1&debug=1');
    expect(detectLeaderboardProbe()).toBe(true);

    // D-069's `forgetDebugParameter`, then a navigation that keeps no query.
    window.history.replaceState(null, '', '/?lb=1');
    expect(detectLeaderboardProbe()).toBe(true);
    window.history.replaceState(null, '', '/');
    expect(detectLeaderboardProbe()).toBe(true);
    expect(parseProductionWalletConfig(
      withLeaderboardProbe(RAILWAY_ENV as never, detectLeaderboardProbe()),
    ).policy.leaderboard?.ledger).toBe(LEDGER);

    // A reload: this page load's answer is gone, the tab's note is not.
    resetLeaderboardProbe();
    expect(leaderboardProbe()).toEqual({ on: true, reason: 'remembered' });
  });

  it('is still off in a tab that only ever saw the plain root', () => {
    expect(leaderboardProbe()).toEqual({ on: false, reason: 'not-asked' });
    window.history.replaceState(null, '', '/?lb=0');
    resetLeaderboardProbe();
    expect(leaderboardProbe()).toEqual({ on: false, reason: 'url-off' });
  });
});

/**
 * D-069's channel, as the probe deploy needed it: every decision says itself,
 * and says nothing else. The season partial commitment `p` is the one secret
 * here, so the sink is read raw and then formatted, and neither may carry it.
 */
describe('what the placement writes to the debug channel', () => {
  const notices: LeaderboardNotice[] = [];
  const lines = () => notices.map((notice) => describeLeaderboardStep(notice));

  beforeEach(() => {
    notices.length = 0;
    setLeaderboardNoticeSink((notice) => void notices.push(notice));
  });
  afterEach(() => {
    setLeaderboardNoticeSink(null);
  });

  /** The probing build's policy, and a connected session on it. */
  async function probing(options: Parameters<typeof productionSession>[1] = {}) {
    window.history.replaceState(null, '', '/?lb=1');
    const config = parseProductionWalletConfig(
      withLeaderboardProbe(RAILWAY_ENV as never, detectLeaderboardProbe()),
    );
    const wiring = productionSession(config.policy, options);
    await wiring.session.connect(wiring.session.getSnapshot().wallets[0]!.key);
    return wiring;
  }

  it('reports the probe switch and its reason, never the season value', () => {
    window.history.replaceState(null, '', '/?lb=1');
    const probe = leaderboardProbe();
    expect(describeLeaderboardStep({ event: 'probe', ...probe, build: true })).toEqual({
      level: 'info',
      event: 'leaderboard.probe',
      detail: 'on=true reason=url-on build=on',
    });
    resetLeaderboardProbe();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    expect(describeLeaderboardStep({ event: 'probe', ...leaderboardProbe(), build: false })).toEqual({
      level: 'info',
      event: 'leaderboard.probe',
      detail: 'on=false reason=not-asked build=off',
    });
  });

  it('reports one attached receipt per fee-paying action, and no secret with it', async () => {
    const wiring = await probing();
    for (const intent of FEE_PAYING_INTENTS) {
      await (await wiring.session.operations.prepare([intent])).confirm({ feeCeiling: POOL_FEE });
    }
    expect(notices).toEqual(FEE_PAYING_INTENTS.map(() => ({ event: 'receipt', attached: true })));
    expect(lines()).toEqual(FEE_PAYING_INTENTS.map(() => ({
      level: 'info',
      event: 'leaderboard.receipt',
      detail: 'attached=true',
    })));
    expectNoSecret();
  });

  it.each([
    { name: 'a build with the leaderboard off', probe: false, options: {}, reason: 'no-ledger', level: 'info' },
    { name: 'a wallet on the public route', probe: true, options: { shadowAccounts: false as const }, reason: 'unsupported-route', level: 'warn' },
    { name: 'a backend with no placement reads', probe: true, options: { reads: false as const }, reason: 'no-reads', level: 'warn' },
  ])('skips with reason=$reason for $name', async ({ probe, options, reason, level }) => {
    const wiring = probe
      ? await probing(options)
      : await (async () => {
        const config = parseProductionWalletConfig(withLeaderboardProbe(RAILWAY_ENV as never, false));
        const built = productionSession(config.policy, options);
        await built.session.connect(built.session.getSnapshot().wallets[0]!.key);
        return built;
      })();
    const batch = await wiring.session.operations.prepare([FEE_PAYING_INTENTS[0]!]);
    expect(Object.keys(batch)).not.toContain('countsTowardPlacement');
    expect(notices).toEqual([{ event: 'receipt', attached: false, reason }]);
    expect(lines()).toEqual([{ level, event: 'leaderboard.receipt', detail: `attached=false reason=${reason}` }]);
    expectNoSecret();
  });

  // The DeFi ticks are reported by `wallet-api/shadow-account.ts` and covered
  // against the real counters in the privacy package's own
  // `leaderboard-operations.test.ts`; what matters here is that the formatter
  // writes a counter's name and refuses anything else.
  it('names a DeFi counter, and drops anything not on the list', () => {
    expect(describeLeaderboardStep({ event: 'tick', feature: 'vault' }))
      .toEqual({ level: 'info', event: 'leaderboard.tick', detail: 'feature=vault' });

    // The formatter admits each field from a fixed list, so a caller that
    // reached for something else writes no line at all.
    expect(describeLeaderboardStep({ event: 'tick', feature: LB_PARTIAL })).toBeNull();
    expect(describeLeaderboardStep({ event: 'receipt', attached: false, reason: LB_PARTIAL })).toBeNull();
    expect(describeLeaderboardStep({ event: 'probe', on: true, reason: 'because', build: true })).toBeNull();
    expect(describeLeaderboardStep({ event: 'commitment', value: LB_PARTIAL })).toBeNull();
  });

  /** Neither the raw notices nor the formatted lines may hold `p` or the account. */
  function expectNoSecret(): void {
    const written = JSON.stringify([notices, lines()]);
    for (const secret of [LB_PARTIAL, LB_PARTIAL.slice(2), PLAYER, LEDGER, TX]) {
      expect(written, secret).not.toContain(secret);
    }
  }
});
