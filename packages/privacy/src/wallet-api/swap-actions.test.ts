import { describe, expect, it, vi } from 'vitest';
import { hash, num, transaction, type STRK20_ACTION, type STRK20_CALL_AND_PROOF } from 'starknet';
import { buildStrk20Actions } from '@avnu/avnu-sdk';
import {
  WalletApiPrivacyOperations,
  type Intent,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type WalletStrk20Account,
} from '../index.js';

/**
 * The action set handed to the wallet must still describe the reviewed plan.
 *
 * `buildStrk20Actions` is a validation-free array literal
 * (`@avnu/avnu-sdk@4.2.0` `dist/index.mjs:1281-1309`), and the backend's
 * binding check runs in `server-actions.ts` only *after* the wallet has already
 * minted an irrevocable proof. A divergence between the plan this package
 * validated and the actions it actually submits for proving must therefore fail
 * closed here, before `strk20PrepareInvoke`.
 *
 * The four-action shape is recorded project truth — see the 2026-08-16 finding
 * "AVNU private swap output is already a pool note" in `AGENTS.md`.
 */
vi.mock('@avnu/avnu-sdk', () => ({ buildStrk20Actions: vi.fn() }));

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TOKEN = '0x123';
const FEE_RECIPIENT = '0x789';
const EXECUTOR = '0x999';
const TAKER = '0xabc';
const POOL_FEE = 6n * 10n ** 18n;
const SWAP: Intent = { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n };

const CALL = { contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] };
const PLACEHOLDER = '${openNoteIds[0]}';

/**
 * The invoke payload AVNU 4.2.0 builds for this fixture, computed with the same
 * pinned `starknet` helpers rather than hand-written, so the fixture cannot
 * drift from the algorithm under test:
 * `[buyToken, ...fromCallsToExecuteCalldata_cairo1(calls).map(num.toHex), placeholder]`.
 */
const FAITHFUL_CALLDATA: string[] = [
  STRK,
  ...transaction.fromCallsToExecuteCalldata_cairo1([CALL]).map((felt) => num.toHex(felt)),
  PLACEHOLDER,
];

/** The exact set AVNU 4.2.0 builds for this fixture's plan. */
function faithfulActions(): STRK20_ACTION[] {
  return [
    { type: 'withdraw', token: TOKEN, amount: '0x14', recipient: EXECUTOR },
    { type: 'withdraw', token: STRK, amount: '0x1', recipient: FEE_RECIPIENT },
    { type: 'transfer', token: STRK, amount: 'OPEN', recipient: TAKER },
    { type: 'invoke', contract: EXECUTOR, calldata: [...FAITHFUL_CALLDATA] },
  ];
}

/** Replace the invoke calldata, keeping one placeholder in the final slot. */
function withCalldata(actions: STRK20_ACTION[], calldata: string[]): STRK20_ACTION[] {
  (actions[3] as { calldata: string[] }).calldata = calldata;
  return actions;
}

function fixture() {
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
    async strk20InvokeTransaction() {
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
    async publicKey() {
      return '0x99';
    },
  };
  const gateway: PrivateSubmissionGateway = {
    estimate: vi.fn(),
    submit: vi.fn(async () => ({ transactionHash: '0xprivate' })),
    prepareSwap: vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: EXECUTOR,
      // A fresh copy per plan: a test that proves the SDK cannot corrupt the
      // guard's authority must not corrupt the next test's fixture either.
      executorCalls: [{ ...CALL, calldata: [...CALL.calldata] }],
      fee: {
        token: STRK,
        recipient: FEE_RECIPIENT,
        amount: 1n,
        authorization: 'fee-auth',
        expiresAtBlock: 1_450,
      },
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
      enabledRoutes: ['swap'],
      allowedTokens: {
        shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
      },
      swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 100 },
    },
  });
  return { ops, gateway, prepared };
}

async function confirmWith(actions: STRK20_ACTION[]) {
  vi.mocked(buildStrk20Actions).mockReturnValue(actions);
  const { ops, gateway, prepared } = fixture();
  const batch = await ops.prepare([SWAP]);
  return { attempt: batch.confirm({ feeCeiling: POOL_FEE + 1n }), gateway, prepared };
}

describe('prepared private swap action verification', () => {
  it('proves the faithful action set AVNU builds for the reviewed plan', async () => {
    const { attempt, prepared } = await confirmWith(faithfulActions());
    await expect(attempt).resolves.toEqual({ transactionHash: '0xprivate' });
    expect(prepared).toEqual([faithfulActions()]);
  });

  it('refuses to prove when the SDK rewrites the executor calls it was handed', async () => {
    // A buggy SDK that mutates its input would otherwise corrupt both the action
    // and the authority the guard recomputes from, making the check tautological.
    vi.mocked(buildStrk20Actions).mockImplementation((plan) => {
      (plan.executorCalls[0] as { contractAddress: string }).contractAddress = '0xdead';
      return [
        ...faithfulActions().slice(0, 3),
        {
          type: 'invoke',
          contract: EXECUTOR,
          calldata: [
            STRK,
            ...transaction.fromCallsToExecuteCalldata_cairo1(plan.executorCalls)
              .map((felt) => num.toHex(felt)),
            PLACEHOLDER,
          ],
        },
      ];
    });
    const { ops, gateway, prepared } = fixture();
    const batch = await ops.prepare([SWAP]);
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toThrow(/reviewed plan/i);
    expect(prepared).toEqual([]);
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['a redirected sell leg', (a: STRK20_ACTION[]) => {
      (a[0] as { recipient: string }).recipient = '0xdead';
      return a;
    }],
    ['an altered sell amount', (a: STRK20_ACTION[]) => {
      (a[0] as { amount: string }).amount = '0x15';
      return a;
    }],
    ['a substituted sell token', (a: STRK20_ACTION[]) => {
      (a[0] as { token: string }).token = STRK;
      return a;
    }],
    ['a redirected fee leg', (a: STRK20_ACTION[]) => {
      (a[1] as { recipient: string }).recipient = '0xdead';
      return a;
    }],
    ['an inflated fee amount', (a: STRK20_ACTION[]) => {
      (a[1] as { amount: string }).amount = '0x9';
      return a;
    }],
    ['an output note credited elsewhere', (a: STRK20_ACTION[]) => {
      (a[2] as { recipient: string }).recipient = '0xdead';
      return a;
    }],
    ['an output note in the wrong token', (a: STRK20_ACTION[]) => {
      (a[2] as { token: string }).token = TOKEN;
      return a;
    }],
    ['a closed output note', (a: STRK20_ACTION[]) => {
      (a[2] as { amount: string }).amount = '0x5f';
      return a;
    }],
    ['a retargeted invoke', (a: STRK20_ACTION[]) => {
      (a[3] as { contract: string }).contract = '0xdead';
      return a;
    }],
    ['no open-note placeholder', (a: STRK20_ACTION[]) =>
      withCalldata(a, FAITHFUL_CALLDATA.slice(0, -1))],
    ['a placeholder moved off the final slot', (a: STRK20_ACTION[]) =>
      withCalldata(a, [PLACEHOLDER, ...FAITHFUL_CALLDATA.slice(0, -1)])],

    // Each of the following keeps exactly one placeholder in the final slot, so
    // only binding the calldata to the validated executor calls can catch them.
    ['a substituted buy-token prefix', (a: STRK20_ACTION[]) =>
      withCalldata(a, [TOKEN, ...FAITHFUL_CALLDATA.slice(1)])],
    ['a retargeted inner call', (a: STRK20_ACTION[]) => {
      const corrupted = [...FAITHFUL_CALLDATA];
      corrupted[2] = '0xdead';
      return withCalldata(a, corrupted);
    }],
    ['a substituted selector', (a: STRK20_ACTION[]) => {
      const corrupted = [...FAITHFUL_CALLDATA];
      corrupted[3] = num.toHex(hash.getSelectorFromName('transfer'));
      return withCalldata(a, corrupted);
    }],
    ['altered inner calldata', (a: STRK20_ACTION[]) => {
      const corrupted = [...FAITHFUL_CALLDATA];
      corrupted[corrupted.length - 2] = '0xbbb';
      return withCalldata(a, corrupted);
    }],
    ['an appended felt', (a: STRK20_ACTION[]) =>
      withCalldata(a, [...FAITHFUL_CALLDATA.slice(0, -1), '0x1', PLACEHOLDER])],
    // Only the exact-length check rejects this: every reviewed slot still
    // matches, including the placeholder, and the extra felt trails it.
    ['a felt trailing a correctly placed placeholder', (a: STRK20_ACTION[]) =>
      withCalldata(a, [...FAITHFUL_CALLDATA, '0x1'])],
    // Only pinning the placeholder rejects this: the length and every other
    // slot are right, and the final slot is a well-formed felt.
    ['a felt substituted into the placeholder slot', (a: STRK20_ACTION[]) =>
      withCalldata(a, [...FAITHFUL_CALLDATA.slice(0, -1), '0x0'])],
    ['reordered felts', (a: STRK20_ACTION[]) => {
      const corrupted = [...FAITHFUL_CALLDATA];
      const [target, selector] = [corrupted[2]!, corrupted[3]!];
      corrupted[2] = selector;
      corrupted[3] = target;
      return withCalldata(a, corrupted);
    }],
    ['an extra action', (a: STRK20_ACTION[]) => [
      ...a,
      { type: 'withdraw', token: STRK, amount: '0x64', recipient: '0xdead' } as STRK20_ACTION,
    ]],
    ['a dropped action', (a: STRK20_ACTION[]) => a.slice(0, 3)],
    ['a public deposit leg', (a: STRK20_ACTION[]) => [
      { type: 'deposit', token: TOKEN, amount: '0x14' } as STRK20_ACTION,
      ...a.slice(1),
    ]],
  ])('refuses to prove %s', async (_label, corrupt) => {
    const { attempt, prepared, gateway } = await confirmWith(corrupt(faithfulActions()));
    await expect(attempt).rejects.toThrow(/reviewed plan/i);
    expect(prepared).toEqual([]);
    expect(gateway.submit).not.toHaveBeenCalled();
  });
});
