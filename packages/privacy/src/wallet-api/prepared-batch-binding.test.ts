import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION, STRK20_CALL_AND_PROOF } from 'starknet';
import {
  WalletApiPrivacyOperations,
  type Intent,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type WalletStrk20Account,
} from '../index.js';

/**
 * A prepared batch must prove the intents that were reviewed.
 *
 * `prepare()` is where every admission check lives: the route policy and token
 * allowlist, positive amounts, the `maxIntents` bound, recipient registration,
 * the shield/spend separation that D-004 requires, and the warnings the player
 * reads before confirming. All of it is worthless if `confirm()` reads intent
 * state the caller still owns — the transaction proved would then be a
 * different transaction from the one admitted, and the wallet's proof is
 * irrevocable by the time anything downstream could notice.
 *
 * Two separate ways that ownership used to leak, both closed by one immutable
 * snapshot taken before validation:
 *
 * - The array. `prepare(intents)` handed its own parameter down to the route
 *   builders, whose `confirm()` re-read it at confirmation time, so anything
 *   the caller appended afterwards was proved and signed.
 * - The elements. `intents: [...intents]` is a shallow copy, so the published
 *   `readonly Intent[]` held the caller's own objects. `readonly` is erased at
 *   runtime; writing a field reached `confirm()`.
 *
 * The swap route needed this most, not least. Its action-binding guard
 * recomputes the expected action set from the canonical intent, so publishing
 * that same mutable object let a caller move the guard's authority and the
 * action it checks together — the tautology the executor-call snapshot already
 * avoids one level in, reintroduced one level out.
 *
 * Every case below runs through the public `prepare(...)`/`confirm(...)` seam
 * against test doubles. No wallet, network, RPC, proof, signature or
 * submission is involved; the only real code exercised is the pinned
 * `@avnu/avnu-sdk` action builder and `starknet` serialization, both pure.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TOKEN = '0x123';
const BOB = '0x456';
const FEE_RECIPIENT = '0x789';
const EXECUTOR = '0x999';
const TAKER = '0xabc';
const POOL_FEE = 6n * 10n ** 18n;
const AUTH = { authorization: 'fee-auth', expiresAtBlock: 1_450 };
const CALL = { contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] };

/** An amount no reviewed batch in this file authorises. */
const HOSTILE = 10n ** 30n;

function seam() {
  const invoked: STRK20_ACTION[][] = [];
  const prepared: STRK20_ACTION[][] = [];
  const artifact: STRK20_CALL_AND_PROOF = {
    call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
    proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
  };
  const wallet: WalletStrk20Account = {
    address: TAKER,
    async strk20Balances(tokens) {
      return tokens.map((token) => ({ token, balance: '0x64' }));
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: '0xshield' };
    },
    async strk20PrepareInvoke(actions) {
      prepared.push(actions);
      return artifact;
    },
  };
  const pool: PoolReadClient = {
    async config() {
      return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async publicKey(address) {
      return address === BOB ? '0x99' : '0x0';
    },
  };
  const gateway: PrivateSubmissionGateway = {
    estimate: vi.fn(async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH })),
    submit: vi.fn(async () => ({ transactionHash: '0xprivate' })),
    prepareSwap: vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: EXECUTOR,
      // A fresh copy per plan, matching swap-actions.test.ts: a fixture shared
      // across cases lets one case corrupt the next case's expectation.
      executorCalls: [{ ...CALL, calldata: [...CALL.calldata] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    })),
  };
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    submission: gateway,
    supportedVersions: vi.fn(async () => ['0.10.3']),
    now: () => 1_000,
    policy: {
      maxIntents: 8,
      maxRelayFee: 10n,
      enabledRoutes: ['shield', 'unshield', 'transfer', 'swap'],
      allowedTokens: {
        shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
      },
      swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 100 },
    },
  });
  return { ops, invoked, prepared };
}

const SWAP: Intent = { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n };

describe('a prepared batch does not read intent state the caller still owns', () => {
  it('A. ignores an intent appended to the caller array after a shield was prepared', async () => {
    const { ops, invoked } = seam();
    // The caller keeps its own reference, as any composing panel would.
    const mine: Intent[] = [{ kind: 'shield', token: TOKEN, amount: 1n }];
    const batch = await ops.prepare(mine);

    // `prepare` refuses shield+spend outright, so appending is the only way to
    // reach a batch that publishes the depositor *and* spends privately.
    mine.push({ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB });
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({
      transactionHash: '0xshield',
    });

    expect(invoked).toEqual([[{ type: 'deposit', token: TOKEN, amount: '0x1' }]]);
  });

  it('B. signs the reviewed deposit amount after the published intent is written to', async () => {
    const { ops, invoked } = seam();
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 1n }]);
    expect(batch.warnings).toEqual([{
      kind: 'public-leg',
      detail: 'Depositing 1 is public: the amount and your address are visible on-chain.',
    }]);

    expect(Reflect.set(batch.intents[0]!, 'amount', HOSTILE)).toBe(false);
    await batch.confirm({ feeCeiling: POOL_FEE });

    expect(invoked).toEqual([[{ type: 'deposit', token: TOKEN, amount: '0x1' }]]);
  });

  it('C. ignores an unallowlisted withdraw appended after a private transfer was prepared', async () => {
    const { ops, prepared } = seam();
    const mine: Intent[] = [{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }];
    const batch = await ops.prepare(mine);

    // Never admitted: `0xdeadbeef` is on no allowlist and `0xbad` was never
    // registration-checked, because neither existed at prepare time.
    mine.push({ kind: 'unshield', token: '0xdeadbeef', amount: 5n, recipient: '0xbad' });
    await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(prepared).toEqual([[
      { type: 'transfer', token: TOKEN, amount: '0x14', recipient: BOB },
      { type: 'withdraw', token: STRK, amount: '0x1', recipient: FEE_RECIPIENT },
    ]]);
  });

  it('D. proves the reviewed amount after the published intent is written to on the pool-native route', async () => {
    const { ops, prepared } = seam();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    expect(Reflect.set(batch.intents[0]!, 'amount', HOSTILE)).toBe(false);
    await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(prepared[0]?.[0]).toEqual({ type: 'transfer', token: TOKEN, amount: '0x14', recipient: BOB });
  });

  it('F. keeps the reviewed sell amount when the published swap intent is written to', async () => {
    const { ops, prepared } = seam();
    const batch = await ops.prepare([{ ...SWAP }]);
    // 95 less 1% slippage: what the player actually reviewed.
    expect(batch.swapReview).toMatchObject({ expectedAmountOut: 95n, minimumAmountOut: 95n - 95n / 100n });

    // The binding guard recomputes from this object. If a caller can move it,
    // the guard agrees with the corruption instead of catching it.
    expect(Reflect.set(batch.intents[0]!, 'amountIn', HOSTILE)).toBe(false);
    await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(prepared[0]?.[0]).toEqual({ type: 'withdraw', token: TOKEN, amount: '0x14', recipient: EXECUTOR });
  });

  it('G. keeps the allowlisted sell token when the published swap intent is written to', async () => {
    const { ops, prepared } = seam();
    const batch = await ops.prepare([{ ...SWAP }]);

    expect(Reflect.set(batch.intents[0]!, 'tokenIn', '0xdeadbeef')).toBe(false);
    await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(prepared[0]?.[0]).toEqual({ type: 'withdraw', token: TOKEN, amount: '0x14', recipient: EXECUTOR });
  });
});

describe('the published batch is frozen on every route', () => {
  it.for([
    ['shield', [{ kind: 'shield', token: TOKEN, amount: 1n }] as Intent[]],
    ['pool-native', [{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }] as Intent[]],
    ['swap', [{ ...SWAP }] as Intent[]],
  ] as const)('freezes the array and its elements on the %s route', async ([, intents]) => {
    const { ops } = seam();
    const batch = await ops.prepare(intents);

    expect(Object.isFrozen(batch.intents)).toBe(true);
    expect(Object.isFrozen(batch.intents[0])).toBe(true);
    // A replaced slot is refused too, not merely a rewritten field.
    expect(Reflect.set(batch.intents, '0', { kind: 'shield', token: TOKEN, amount: 7n })).toBe(false);
  });

  it('hands the caller a snapshot, never its own array or objects', async () => {
    const { ops } = seam();
    const mine: Intent[] = [{ kind: 'shield', token: TOKEN, amount: 1n }];
    const batch = await ops.prepare(mine);

    expect(batch.intents).not.toBe(mine);
    expect(batch.intents[0]).not.toBe(mine[0]);
    expect(batch.intents).toEqual(mine);
    // The caller's own objects stay writable; only the seam's copy is owned.
    expect(Object.isFrozen(mine[0])).toBe(false);
  });
});
