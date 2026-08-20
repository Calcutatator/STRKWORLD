import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION, STRK20_CALL_AND_PROOF } from 'starknet';
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

/** The exact set AVNU 4.2.0 builds for this fixture's plan. */
function faithfulActions(): STRK20_ACTION[] {
  return [
    { type: 'withdraw', token: TOKEN, amount: '0x14', recipient: EXECUTOR },
    { type: 'withdraw', token: STRK, amount: '0x1', recipient: FEE_RECIPIENT },
    { type: 'transfer', token: STRK, amount: 'OPEN', recipient: TAKER },
    { type: 'invoke', contract: EXECUTOR, calldata: [STRK, '0xaaa', '${openNoteIds[0]}'] },
  ];
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
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
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
    ['no open-note placeholder', (a: STRK20_ACTION[]) => {
      (a[3] as { calldata: string[] }).calldata = [STRK, '0xaaa'];
      return a;
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
