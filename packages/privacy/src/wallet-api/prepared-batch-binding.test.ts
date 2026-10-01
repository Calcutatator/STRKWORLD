import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION, STRK20_CALL_AND_PROOF } from 'starknet';
import {
  WalletApiPrivacyOperations,
  type Intent,
  type PoolReadClient,
  type WalletStrk20Account,
} from '../index.js';
import { SWAP_TEST_PARTIAL, SWAP_TEST_SHADOW, swapTestPrices, swapTestQuotes, swapTestReads } from '../testing/swap-quotes.js';

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
 * The swap route (D-084) builds its actions once, at prepare, from the
 * canonical intent and the owned quote, so a caller writing to the published
 * intent can move neither the floor nor the actions.
 *
 * Every case below runs through the public `prepare(...)`/`confirm(...)` seam
 * against test doubles. No wallet, network, RPC, proof, signature or
 * submission is involved.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TOKEN = '0x123';
const BOB = '0x456';
const TAKER = '0xabc';
const POOL_FEE = 6n * 10n ** 18n;

/** An amount no reviewed batch in this file authorises. */
const HOSTILE = 10n ** 30n;

function seam() {
  const invoked: STRK20_ACTION[][] = [];
  const prepared: STRK20_ACTION[][] = [];
  const artifact: STRK20_CALL_AND_PROOF = {
    call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
    proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
  };
  const wallet: WalletStrk20Account = {
    address: TAKER,
    async strk20Balances(tokens) {
      return tokens.map((token) => ({ token, balance: '0x64' }));
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: '0x5e1d' };
    },
    async strk20PrepareInvoke(actions) {
      prepared.push(actions);
      return artifact;
    },
    async strk20ShadowAccountCommitment() {
      return SWAP_TEST_PARTIAL;
    },
  };
  const pool: PoolReadClient = {
    async config() {
      return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async publicKey(address) {
      return address === BOB ? '0x99' : '0x0';
    },
    async receipt() {
      throw new Error('no receipt read in this fixture');
    },
  };
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    swapQuotes: swapTestQuotes([95n]),
    swapPrices: swapTestPrices(1_000),
    vault: swapTestReads(),
    supportedVersions: vi.fn(async () => ['0.10.4']),
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
      transactionHash: '0x5e1d',
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
    const { ops, invoked } = seam();
    const mine: Intent[] = [{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }];
    const batch = await ops.prepare(mine);

    // Never admitted: `0xdeadbeef` is on no allowlist and `0xbad` was never
    // registration-checked, because neither existed at prepare time.
    mine.push({ kind: 'unshield', token: '0xdeadbeef', amount: 5n, recipient: '0xbad' });
    await batch.confirm({ feeCeiling: POOL_FEE });

    // The wallet proves and submits the reviewed transfer alone (D-082).
    expect(invoked).toEqual([[
      { type: 'transfer', token: TOKEN, amount: '0x14', recipient: BOB },
    ]]);
  });

  it('D. proves the reviewed amount after the published intent is written to on the pool-native route', async () => {
    const { ops, invoked } = seam();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    expect(Reflect.set(batch.intents[0]!, 'amount', HOSTILE)).toBe(false);
    // TOKEN has no oracle price, so the swap is unchecked (D-084).
    await batch.confirm({ feeCeiling: POOL_FEE, acknowledgeUncheckedPrice: true });

    expect(invoked[0]?.[0]).toEqual({ type: 'transfer', token: TOKEN, amount: '0x14', recipient: BOB });
  });

  /**
   * Ownership has to be taken before the first `await`, not merely before the
   * promise settles.
   *
   * `prepare()` is async, so everything up to its first suspension point runs
   * in the caller's own tick: `throwIfAborted` is synchronous, the snapshot
   * follows it, and only `poolConfig()` awaits. Capture the intents any later
   * and a caller that mutates between the unawaited call and the settled
   * promise wins the race — which is exactly how the test double got this
   * wrong while looking correct, since awaiting anything yields a microtask
   * even at zero latency.
   */
  it('E. captures the intents synchronously, before its first await', async () => {
    const { ops, invoked } = seam();
    // Held at the narrow variant so the write needs no `Intent`-union cast.
    const shield: Extract<Intent, { kind: 'shield' }> = { kind: 'shield', token: TOKEN, amount: 1n };
    const mine: Intent[] = [shield];

    const preparing = ops.prepare(mine);
    // Same tick as the call, before anything is awaited. Both leak shapes at
    // once: a rewritten field and an appended intent.
    shield.amount = HOSTILE;
    mine.push({ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB });
    const batch = await preparing;

    expect(batch.intents).toEqual([{ kind: 'shield', token: TOKEN, amount: 1n }]);
    expect(batch.warnings).toEqual([{
      kind: 'public-leg',
      detail: 'Depositing 1 is public: the amount and your address are visible on-chain.',
    }]);

    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(invoked).toEqual([[{ type: 'deposit', token: TOKEN, amount: '0x1' }]]);
  });

  it('F. keeps the reviewed sell amount when the published swap intent is written to', async () => {
    const { ops, invoked } = seam();
    const batch = await ops.prepare([{ ...SWAP }]);
    // 95 less 1% slippage: what the player actually reviewed.
    expect(batch.swapReview).toMatchObject({ expectedAmountOut: 95n, minimumAmountOut: 95n - 95n / 100n });

    // The actions were built from this object at prepare; it must not move.
    expect(Reflect.set(batch.intents[0]!, 'amountIn', HOSTILE)).toBe(false);
    // TOKEN has no oracle price, so the swap is unchecked (D-084).
    await batch.confirm({ feeCeiling: POOL_FEE, acknowledgeUncheckedPrice: true });

    expect(invoked[0]?.[0]).toEqual({ type: 'withdraw', token: TOKEN, amount: '0x14', recipient: SWAP_TEST_SHADOW });
  });

  it('G. keeps the allowlisted sell token when the published swap intent is written to', async () => {
    const { ops, invoked } = seam();
    const batch = await ops.prepare([{ ...SWAP }]);

    expect(Reflect.set(batch.intents[0]!, 'tokenIn', '0xdeadbeef')).toBe(false);
    // TOKEN has no oracle price, so the swap is unchecked (D-084).
    await batch.confirm({ feeCeiling: POOL_FEE, acknowledgeUncheckedPrice: true });

    expect(invoked[0]?.[0]).toEqual({ type: 'withdraw', token: TOKEN, amount: '0x14', recipient: SWAP_TEST_SHADOW });
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
