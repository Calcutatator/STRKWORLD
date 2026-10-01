import { describe, expect, it } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  ENDUR_DAPP_NAME,
  ENDUR_DEPOSIT_ANONYMIZER,
  ENDUR_WITHDRAWAL_QUEUE,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  MAX_ENDUR_CLAIMS_PER_BATCH,
  VAULT_DAPP_NAME,
  WalletApiPrivacyOperations,
  type EndurReadClient,
  type EndurUnstakeRead,
  type Intent,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '../index.js';
import {
  ENDUR_OBSERVED_CLAIM_DELAY_SECONDS,
  classifyEndurRequests,
  endurUnstakeClaimActions,
  endurUnstakeRequestActions,
} from '../endur.js';
import { shadowAccountAddress } from '../vault.js';
import { parseUnstakeRead } from './endur-operations.js';

/**
 * Endur staking switched on and private unstaking through a shadow account
 * (D-085), on the Wallet API adapter: the exact actions the wallet is handed
 * for a stake, an unstake request and a claim, the reads that classify each
 * request by the chain's clock, and the refusals.
 */

const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const QUEUE = ENDUR_WITHDRAWAL_QUEUE;
const PLAYER = '0xabc';
const PARTIAL = '0x7e11d';
const SHADOW = shadowAccountAddress(PARTIAL, '0x0');
const POOL_FEE = 6n * 10n ** 18n;
const TX = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ONE = 10n ** 18n;
const NOW = 1_790_854_217;

function policy(routes: WalletRoutePolicy['enabledRoutes'] = ['stake', 'unstake']): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 10n * ONE,
    enabledRoutes: routes,
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], stake: [STRK, XSTRK] },
  };
}

function read(overrides: Partial<EndurUnstakeRead> = {}): EndurUnstakeRead {
  return {
    chainTime: NOW,
    strk: 0n,
    xstrk: 0n,
    outstanding: 2n,
    complete: true,
    requests: [
      { requestId: 10_590n, assets: 12n * ONE, shares: 10n * ONE, claimed: false, requestedAt: NOW - 3_600, claimableAt: NOW - 3_600 + ENDUR_OBSERVED_CLAIM_DELAY_SECONDS, claimableNow: false },
      { requestId: 10_589n, assets: 15n * ONE, shares: 13n * ONE, claimed: false, requestedAt: NOW - ENDUR_OBSERVED_CLAIM_DELAY_SECONDS - 60, claimableAt: NOW - 60, claimableNow: true },
      { requestId: 10_582n, assets: 9n * ONE, shares: 8n * ONE, claimed: true, requestedAt: NOW - 900_000, claimableAt: NOW - 295_200, claimableNow: false },
    ],
    ...overrides,
  };
}

function fixture(options: { routes?: WalletRoutePolicy['enabledRoutes']; shadowAddress?: string } = {}) {
  const invoked: STRK20_ACTION[][] = [];
  const commitments: string[] = [];
  const unstakeReads: string[] = [];
  const state = { read: read() as unknown };
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    async strk20Balances(tokens) {
      return tokens.map((token) => ({ token, balance: '0x64' }));
    },
    async strk20PrepareInvoke() {
      throw new Error('nothing here is relayed');
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: TX };
    },
    async strk20ShadowAccountCommitment(dappName: string) {
      commitments.push(dappName);
      return PARTIAL;
    },
  };
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
  const endur: EndurReadClient = {
    async shadowAccount() {
      return { address: options.shadowAddress ?? SHADOW, deployed: true };
    },
    async endurUnstake(account) {
      unstakeReads.push(account);
      return state.read as EndurUnstakeRead;
    },
  };
  const submission: PrivateSubmissionGateway = {
    async estimate() {
      throw new Error('nothing here is relayed');
    },
    async submit() {
      throw new Error('nothing here is relayed');
    },
  };
  const operations = new WalletApiPrivacyOperations({
    wallet,
    pool,
    submission,
    supportedVersions: async () => ['0.10.3', '0.10.4'],
    policy: policy(options.routes),
    endur,
    sleep: async () => undefined,
  });
  return { operations, invoked, commitments, unstakeReads, state };
}

describe('Endur staking, switched on (D-085)', () => {
  it('hands the wallet the D-063 stake actions exactly, wallet-submitted', async () => {
    const f = fixture();
    const stake: Intent = { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK, amountIn: 5n * ONE };
    const batch = await f.operations.prepare([stake]);
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([[
      { type: 'withdraw', token: STRK, amount: '0x4563918244f40000', recipient: ENDUR_DEPOSIT_ANONYMIZER },
      { type: 'transfer', token: XSTRK, amount: 'OPEN', recipient: PLAYER },
      { type: 'invoke', contract: ENDUR_DEPOSIT_ANONYMIZER, calldata: [STRK, XSTRK, '0x4563918244f40000', '0x0', '${openNoteIds[0]}'] },
    ]]);
    // Staking never touches a shadow account.
    expect(f.commitments).toEqual([]);
  });
});

describe('unstake request, flow A (D-085)', () => {
  it('withdraws the xSTRK to the shadow account, which redeems it as receiver and owner, collecting nothing', async () => {
    const f = fixture();
    const batch = await f.operations.prepareEndurUnstake(10n * ONE);
    expect(batch.action).toEqual({ kind: 'request', shares: 10n * ONE, leftover: 0n });
    expect(batch.totalCost).toBe(POOL_FEE);
    expect(batch.gasEstimate).toBe(0n);
    const result = await batch.confirm({ feeCeiling: POOL_FEE });
    expect(result).toEqual({ transactionHash: TX, outcome: 'succeeded' });
    expect(f.invoked).toEqual([[
      { type: 'withdraw', token: XSTRK, amount: '0x8ac7230489e80000', recipient: SHADOW },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-endur',
        nonce: '0x0',
        calls: [{ contractAddress: XSTRK, entrypoint: 'redeem', calldata: ['0x8ac7230489e80000', '0x0', SHADOW, SHADOW] }],
        collect_policy: { type: 'exact', amount: '0x0' },
      },
    ]]);
    // Its own dapp name, never the Vault's: the two stand-ins are not linked.
    expect(f.commitments).toEqual([ENDUR_DAPP_NAME]);
    expect(ENDUR_DAPP_NAME).not.toBe(VAULT_DAPP_NAME);
    expect(f.unstakeReads).toEqual([SHADOW]);
  });

  it('returns xSTRK already on the stand-in to the pool in an open note (collect all)', async () => {
    const f = fixture();
    f.state.read = read({ xstrk: 3n * ONE });
    const batch = await f.operations.prepareEndurUnstake(ONE);
    expect(batch.action).toEqual({ kind: 'request', shares: ONE, leftover: 3n * ONE });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked[0]).toEqual([
      { type: 'transfer', token: XSTRK, amount: 'OPEN', recipient: PLAYER },
      { type: 'withdraw', token: XSTRK, amount: '0xde0b6b3a7640000', recipient: SHADOW },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-endur',
        nonce: '0x0',
        calls: [{ contractAddress: XSTRK, entrypoint: 'redeem', calldata: ['0xde0b6b3a7640000', '0x0', SHADOW, SHADOW] }],
        collect_policy: { type: 'all' },
      },
    ]);
  });

  it('refuses a non-positive amount, a disabled route and an unverified stand-in before the wallet proves anything', async () => {
    await expect(fixture().operations.prepareEndurUnstake(0n)).rejects.toThrow('Amounts must be positive u256 values.');
    await expect(fixture({ routes: ['stake'] }).operations.prepareEndurUnstake(ONE)).rejects.toThrow('The unstake route is disabled.');
    const moved = fixture({ shadowAddress: '0x1234' });
    await expect(moved.operations.prepareEndurUnstake(ONE)).rejects.toThrow('could not verify its stand-in address');
    expect(moved.invoked).toEqual([]);
  });
});

describe('claim, flow B (D-085)', () => {
  it('claims each payable request through the shadow account and collects all its STRK into one note', async () => {
    const f = fixture();
    const batch = await f.operations.prepareEndurClaim();
    expect(batch.action).toEqual({ kind: 'claim', requestIds: [10_589n], owed: 15n * ONE, held: 0n });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([[
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: PLAYER },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-endur',
        nonce: '0x0',
        calls: [{ contractAddress: QUEUE, entrypoint: 'claim_withdrawal', calldata: ['0x295d'] }],
        collect_policy: { type: 'all' },
      },
    ]]);
  });

  it('only collects when Endur has already paid every ready request to the stand-in', async () => {
    const f = fixture();
    f.state.read = read({ strk: 15n * ONE, requests: [read().requests[0]!] });
    const batch = await f.operations.prepareEndurClaim();
    expect(batch.action).toEqual({ kind: 'claim', requestIds: [], owed: 0n, held: 15n * ONE });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked[0]![1]).toEqual({
      type: 'shadow_account_invoke',
      dapp_name: 'strkworld-endur',
      nonce: '0x0',
      calls: [{ contractAddress: STRK, entrypoint: 'balance_of', calldata: [SHADOW] }],
      collect_policy: { type: 'all' },
    });
  });

  it('never claims a request past its wait that Endur has not funded: one would revert the batch', async () => {
    const f = fixture();
    const unfunded = { ...read().requests[1]!, claimableNow: false };
    f.state.read = read({ requests: [read().requests[0]!, unfunded, read().requests[2]!] });
    const position = await f.operations.endurUnstakePosition();
    expect(position.requests.map(({ requestId, status }) => [requestId, status])).toEqual([[10_589n, 'awaiting-funds'], [10_590n, 'waiting']]);
    await expect(f.operations.prepareEndurClaim()).rejects.toThrow('Nothing has finished unstaking yet.');
    // STRK already on the stand-in is still collected, unfunded request or not.
    f.state.read = read({ strk: 2n * ONE, requests: [unfunded] });
    const batch = await f.operations.prepareEndurClaim();
    expect(batch.action).toEqual({ kind: 'claim', requestIds: [], owed: 0n, held: 2n * ONE });
  });

  it('only collects when the stand-in holds STRK, even with a payable request, so a relayer claim cannot revert it', async () => {
    const f = fixture();
    f.state.read = read({ strk: 2n * ONE });
    const batch = await f.operations.prepareEndurClaim();
    expect(batch.action).toEqual({ kind: 'claim', requestIds: [], owed: 0n, held: 2n * ONE });
    await batch.confirm({ feeCeiling: POOL_FEE });
    const invoke = f.invoked[0]![1] as Extract<STRK20_ACTION, { type: 'shadow_account_invoke' }>;
    expect(invoke.calls).toEqual([{ contractAddress: STRK, entrypoint: 'balance_of', calldata: [SHADOW] }]);
  });

  it('refuses when nothing is ready and nothing was paid', async () => {
    const f = fixture();
    f.state.read = read({ requests: [read().requests[0]!] });
    await expect(f.operations.prepareEndurClaim()).rejects.toThrow('Nothing has finished unstaking yet.');
    expect(f.invoked).toEqual([]);
  });

  it(`claims at most ${MAX_ENDUR_CLAIMS_PER_BATCH} requests at once, oldest first`, async () => {
    const f = fixture();
    const requests = Array.from({ length: 10 }, (_unused, index) => ({
      requestId: 20_000n - BigInt(index), assets: ONE, shares: ONE, claimed: false, requestedAt: NOW - 700_000, claimableAt: NOW - 1, claimableNow: true,
    }));
    f.state.read = read({ requests, outstanding: 10n });
    const batch = await f.operations.prepareEndurClaim();
    expect(batch.action.kind === 'claim' && batch.action.requestIds).toEqual(
      Array.from({ length: MAX_ENDUR_CLAIMS_PER_BATCH }, (_unused, index) => 19_991n + BigInt(index)),
    );
  });
});

describe('the unstaking read and its timing (D-085)', () => {
  it('lists unpaid requests oldest first, each waiting or ready by the chain clock, and counts the unlisted', async () => {
    const f = fixture();
    f.state.read = read({ outstanding: 3n, strk: 5n, xstrk: 7n });
    const position = await f.operations.endurUnstakePosition();
    expect(position).toEqual({
      standIn: SHADOW,
      chainTime: NOW,
      requests: [
        { requestId: 10_589n, assets: 15n * ONE, shares: 13n * ONE, requestedAt: NOW - ENDUR_OBSERVED_CLAIM_DELAY_SECONDS - 60, claimableAt: NOW - 60, status: 'ready', secondsLeft: 0 },
        { requestId: 10_590n, assets: 12n * ONE, shares: 10n * ONE, requestedAt: NOW - 3_600, claimableAt: NOW - 3_600 + ENDUR_OBSERVED_CLAIM_DELAY_SECONDS, status: 'waiting', secondsLeft: ENDUR_OBSERVED_CLAIM_DELAY_SECONDS - 3_600 },
      ],
      strkHeld: 5n,
      xstrkHeld: 7n,
      unlisted: 1,
      complete: true,
    });
  });

  it('reads a request past its wait exactly at its claim time, ready only if its claim would pay, and never by the browser clock', () => {
    const record = { requestId: 1n, assets: 1n, shares: 1n, claimed: false, requestedAt: 100, claimableAt: 200 };
    expect(classifyEndurRequests([{ ...record, claimableNow: true }], 200)[0]).toMatchObject({ status: 'ready', secondsLeft: 0 });
    expect(classifyEndurRequests([{ ...record, claimableNow: false }], 200)[0]).toMatchObject({ status: 'awaiting-funds', secondsLeft: 0 });
    expect(classifyEndurRequests([{ ...record, claimableNow: true }], 199)[0]).toMatchObject({ status: 'waiting', secondsLeft: 1 });
  });

  it('passes on an incomplete scan', async () => {
    const f = fixture();
    f.state.read = read({ complete: false });
    await expect(f.operations.endurUnstakePosition()).resolves.toMatchObject({ complete: false });
  });

  it.each([
    ['a repeated request', { requests: [read().requests[0]!, read().requests[0]!] }],
    ['a claim time before the request', { requests: [{ ...read().requests[0]!, claimableAt: 1 }] }],
    ['a negative clock', { chainTime: -1 }],
    ['a non-bigint balance', { strk: 1 as unknown as bigint }],
    ['no completeness flag', { complete: undefined as unknown as boolean }],
    ['no claim dry run', { requests: [{ ...read().requests[0]!, claimableNow: undefined as unknown as boolean }] }],
    ['too many rows', { requests: Array.from({ length: 65 }, (_u, i) => ({ ...read().requests[0]!, requestId: BigInt(i) })) }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => parseUnstakeRead(read(overrides as Partial<EndurUnstakeRead>))).toThrow();
  });

  it('fails the read as invalid, not as an empty list, when the backend answers malformed', async () => {
    const f = fixture();
    f.state.read = { chainTime: NOW };
    await expect(f.operations.endurUnstakePosition()).rejects.toThrow('The unstaking read is invalid.');
  });
});

describe('the action builders refuse what they cannot build (D-085)', () => {
  it.each([
    ['a zero amount', () => endurUnstakeRequestActions({ shadowAccount: SHADOW, player: PLAYER, shares: 0n, leftover: 0n })],
    ['a negative leftover', () => endurUnstakeRequestActions({ shadowAccount: SHADOW, player: PLAYER, shares: 1n, leftover: -1n })],
    ['a zero address', () => endurUnstakeRequestActions({ shadowAccount: '0x0', player: PLAYER, shares: 1n, leftover: 0n })],
    ['a repeated request', () => endurUnstakeClaimActions({ shadowAccount: SHADOW, player: PLAYER, requestIds: [1n, 1n] })],
    ['too many requests', () => endurUnstakeClaimActions({
      shadowAccount: SHADOW, player: PLAYER, requestIds: Array.from({ length: MAX_ENDUR_CLAIMS_PER_BATCH + 1 }, (_u, i) => BigInt(i)),
    })],
  ])('%s', (_label, build) => {
    expect(build).toThrow();
  });
});
