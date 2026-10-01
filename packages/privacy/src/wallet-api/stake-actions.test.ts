import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION, STRK20_CALL_AND_PROOF } from 'starknet';
import {
  BackendPrivacyClient,
  ENDUR_DEPOSIT_ANONYMIZER,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  ENDUR_XSTRK_DECIMALS,
  FakePrivacyOperations,
  PrivacyError,
  WalletApiPrivacyOperations,
  createWalletSession,
  type Intent,
  type PoolReadClient,
  type PreparedBatch,
  type PrivacyOperations,
  type PrivateSubmissionGateway,
  type WalletConnectionPort,
  type WalletDiscoveryPort,
  type WalletHandle,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '../index.js';

/**
 * Endur private staking (D-063): an open-note transfer plus an invoke of
 * Endur's anonymizer, proved and submitted by the wallet like the pool-native
 * spends (D-082). These tests pin the admitted intent shape, fail-closed
 * policy behaviour and the exact action set the wallet is asked to prove.
 */

const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const ANONYMIZER = ENDUR_DEPOSIT_ANONYMIZER;
const TAKER = '0xabc';
const FEE_RECIPIENT = '0x789';
const HASH = '0x5eed';
const OTHER = '0x123';
const BOB = '0x456';
const POOL_FEE = 6n * 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAINNET = '0x534e5f4d41494e';
/** The literal the swap route uses for its one open note (see swap-actions.test.ts). */
const OPEN_NOTE = '${openNoteIds[0]}';
const STAKE: Intent = { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK, amountIn: 5n * 10n ** 18n };

function stakePolicy(overrides: Partial<WalletRoutePolicy> = {}): WalletRoutePolicy {
  return {
    maxIntents: 8,
    maxRelayFee: 10n,
    enabledRoutes: ['stake'],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], stake: [STRK, XSTRK] },
    ...overrides,
  };
}

function fixture(policy: WalletRoutePolicy = stakePolicy()) {
  const invoked: STRK20_ACTION[][] = [];
  const prepared: STRK20_ACTION[][] = [];
  const simulated: (boolean | undefined)[] = [];
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
      return { transaction_hash: HASH };
    },
    async strk20PrepareInvoke(actions, simulate) {
      prepared.push(actions);
      simulated.push(simulate);
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
    async receipt() {
      throw new Error('no receipt read in this fixture');
    },
  };
  let quotes = 0;
  const gateway: PrivateSubmissionGateway = {
    estimate: vi.fn(async () => ({
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      authorization: `fee-auth-${++quotes}`,
      expiresAtBlock: 1_450,
    })),
    submit: vi.fn(async () => ({ transactionHash: '0x5eed' })),
  };
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    submission: gateway,
    supportedVersions: vi.fn(async () => ['0.10.3']),
    policy,
  });
  return { ops, wallet, pool, gateway, invoked, prepared, simulated, artifact };
}

/** The three-action request for `amountIn`, independently written out: no relay-fee leg (D-082). */
function expectedStakeActions(amountIn: bigint, low: string, high: string): STRK20_ACTION[] {
  return [
    { type: 'withdraw', token: STRK, amount: `0x${amountIn.toString(16)}`, recipient: ANONYMIZER },
    { type: 'transfer', token: XSTRK, amount: 'OPEN', recipient: TAKER },
    { type: 'invoke', contract: ANONYMIZER, calldata: [STRK, XSTRK, low, high, OPEN_NOTE] },
  ];
}

async function provedActions(intent: Intent, policy?: WalletRoutePolicy) {
  const harness = fixture(policy);
  const batch = await harness.ops.prepare([intent]);
  await batch.confirm({ feeCeiling: POOL_FEE });
  expect(harness.invoked).toHaveLength(1);
  expect(harness.prepared).toHaveLength(0);
  return { ...harness, actions: harness.invoked[0]! };
}

describe('Endur stake constants (D-063)', () => {
  it('pins the mainnet anonymizer, xSTRK and its STRK asset', () => {
    expect(ANONYMIZER).toBe('0x030dee638065962eb3642ca54aa48e9e2cd98536bc90b64b99bb306c1db30698');
    expect(XSTRK).toBe('0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a');
    expect(STRK).toBe('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d');
    expect(ENDUR_XSTRK_DECIMALS).toBe(18);
  });
});

describe('stake intent validation', () => {
  it('admits STRK in, xSTRK out and one positive amount, with no review field', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([STAKE]);

    expect(batch.intents).toEqual([STAKE]);
    expect(Object.isFrozen(batch.intents)).toBe(true);
    expect(Object.isFrozen(batch.intents[0])).toBe(true);
    expect(batch.promptCount).toBe(1);
    expect(batch.swapReview).toBeUndefined();
    expect('swapReview' in batch).toBe(false);
  });

  it('admits other felt spellings of the pinned pair', async () => {
    const { ops } = fixture();
    const unpadded: Intent = {
      kind: 'stake',
      tokenIn: `0x${BigInt(STRK).toString(16)}`,
      tokenOut: `0x${BigInt(XSTRK).toString(16).toUpperCase()}`,
      amountIn: 1n,
    };

    await expect(ops.prepare([unpadded])).resolves.toMatchObject({ intents: [unpadded] });
  });

  it('preserves the exact u256 maximum amount boundary', async () => {
    const { ops } = fixture();
    await expect(ops.prepare([{ ...STAKE, amountIn: MAX_UINT256 }]))
      .resolves.toMatchObject({ intents: [{ amountIn: MAX_UINT256 }] });
  });

  const nonEnumerableAmount = Object.defineProperty(
    { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK },
    'amountIn',
    { value: 1n, enumerable: false },
  );

  it.each([
    ['a minimum-out field', { ...STAKE, minAmountOut: 1n }],
    ['a recipient field', { ...STAKE, recipient: BOB }],
    ['a pool-native amount field', { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK, amount: 1n }],
    ['a missing output token', { kind: 'stake', tokenIn: STRK, amountIn: 1n }],
    ['a missing input token', { kind: 'stake', tokenOut: XSTRK, amountIn: 1n }],
    ['an inherited amount', Object.assign(Object.create({ amountIn: 1n }), {
      kind: 'stake', tokenIn: STRK, tokenOut: XSTRK,
    })],
    ['a non-enumerable amount', nonEnumerableAmount],
    ['a symbol-keyed extra field', { ...STAKE, [Symbol('extra')]: 1n }],
  ])('rejects %s before any dependency call', async (_label, intent) => {
    const { ops, pool, wallet, gateway } = fixture();
    const config = vi.spyOn(pool, 'config');
    const prove = vi.spyOn(wallet, 'strk20PrepareInvoke');

    await expect(ops.prepare([intent as Intent])).rejects.toThrow(/invalid shape/);
    expect(config).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0n],
    ['negative', -1n],
    ['above u256', MAX_UINT256 + 1n],
    ['a number', 1],
    ['a string', '1'],
  ])('rejects an amount that is %s before any dependency call', async (_label, amountIn) => {
    const { ops, pool, gateway } = fixture();
    const config = vi.spyOn(pool, 'config');

    await expect(ops.prepare([{ ...STAKE, amountIn } as Intent])).rejects.toThrow(/positive u256/);
    expect(config).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it.each([
    ['a zero input token', { tokenIn: '0x0' }, /Invalid token address/],
    ['a decimal input token', { tokenIn: '123' }, /Invalid token address/],
    ['a field-prime output token', { tokenOut: `0x${STARK_FIELD_PRIME.toString(16)}` }, /Invalid output token address/],
  ])('rejects %s', async (_label, patch, message) => {
    const { ops, gateway } = fixture();
    await expect(ops.prepare([{ ...STAKE, ...patch } as Intent])).rejects.toThrow(message);
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it.each([
    ['another input token', { tokenIn: OTHER }],
    ['another output token', { tokenOut: OTHER }],
    ['the reversed pair', { tokenIn: XSTRK, tokenOut: STRK }],
  ])('pins the pair: rejects %s even when the policy allowlists it', async (_label, patch) => {
    const policy = stakePolicy({
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], stake: [STRK, XSTRK, OTHER] },
    });
    const { ops, gateway } = fixture(policy);

    await expect(ops.prepare([{ ...STAKE, ...patch } as Intent]))
      .rejects.toThrow('The stake route accepts only STRK in and xSTRK out.');
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it.each([
    ['omits xSTRK', [STRK], 'The stake output token is not allowlisted.'],
    ['omits STRK', [XSTRK], 'The stake input token is not allowlisted.'],
    ['is empty', [], 'The stake input token is not allowlisted.'],
  ])('fails closed when the stake allowlist %s', async (_label, stake, message) => {
    const { ops, gateway } = fixture(stakePolicy({
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], stake },
    }));

    await expect(ops.prepare([STAKE])).rejects.toThrow(message);
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('fails closed on a policy with the route enabled but no stake allowlist at all', async () => {
    const { ops, pool, gateway } = fixture(stakePolicy({
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    }));
    const config = vi.spyOn(pool, 'config');

    await expect(ops.prepare([STAKE])).rejects.toThrow('The stake input token is not allowlisted.');
    expect(config).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('prepares one stake at a time and never beside another route', async () => {
    const policy = stakePolicy({
      enabledRoutes: ['stake', 'transfer', 'shield'],
      allowedTokens: { shield: [STRK], unshield: [], transfer: [STRK], swap: [], stake: [STRK, XSTRK] },
    });
    const { ops, wallet } = fixture(policy);
    const prove = vi.spyOn(wallet, 'strk20PrepareInvoke');

    await expect(ops.prepare([STAKE, STAKE])).rejects.toThrow('A private stake must be prepared one at a time.');
    await expect(ops.prepare([STAKE, { kind: 'transfer', token: STRK, amount: 1n, recipient: BOB }]))
      .rejects.toThrow('A private batch may contain only one approved route type.');
    await expect(ops.prepare([{ kind: 'shield', token: STRK, amount: 1n }, STAKE]))
      .rejects.toMatchObject({ kind: 'privacy-leak' });
    expect(prove).not.toHaveBeenCalled();
  });
});

describe('disabled stake route', () => {
  it('denies a stake exactly as any disabled route, before any dependency call', async () => {
    const { ops, pool, wallet, gateway } = fixture(stakePolicy({ enabledRoutes: ['transfer'] }));
    const config = vi.spyOn(pool, 'config');
    const prove = vi.spyOn(wallet, 'strk20PrepareInvoke');

    const attempt = ops.prepare([STAKE]);
    await expect(attempt).rejects.toBeInstanceOf(PrivacyError);
    await expect(attempt).rejects.toMatchObject({ kind: 'unknown', message: 'The stake route is disabled.' });
    expect(config).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it('enables nothing else when stake is enabled', async () => {
    const policy = stakePolicy({
      allowedTokens: { shield: [STRK], unshield: [STRK], transfer: [STRK], swap: [STRK, XSTRK], stake: [STRK, XSTRK] },
    });
    const { ops } = fixture(policy);

    await expect(ops.prepare([{ kind: 'shield', token: STRK, amount: 1n }])).rejects.toThrow('The shield route is disabled.');
    await expect(ops.prepare([{ kind: 'unshield', token: STRK, amount: 1n, recipient: BOB }]))
      .rejects.toThrow('The unshield route is disabled.');
    await expect(ops.prepare([{ kind: 'transfer', token: STRK, amount: 1n, recipient: BOB }]))
      .rejects.toThrow('The transfer route is disabled.');
    await expect(ops.prepare([{ kind: 'swap', tokenIn: STRK, tokenOut: XSTRK, amountIn: 1n, minAmountOut: 1n }]))
      .rejects.toThrow('The swap route is disabled.');
  });
});

describe('stake prepare request construction', () => {
  it('has the wallet prove and submit the withdrawal, open note and anonymizer invoke exactly, with no relay', async () => {
    const { ops, gateway, invoked, prepared } = fixture();
    const batch = await ops.prepare([STAKE]);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({ transactionHash: HASH });

    // 5 STRK = 5e18 = 0x4563918244f40000, entirely in the low limb.
    expect(invoked).toEqual([expectedStakeActions(5n * 10n ** 18n, '0x4563918244f40000', '0x0')]);
    expect(prepared).toEqual([]);
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('targets the pinned anonymizer with no selector of its own, as the last and only invoke', async () => {
    const { actions } = await provedActions(STAKE);
    const invokes = actions.filter((action) => action.type === 'invoke');
    const invoke = actions.at(-1)!;

    expect(invokes).toHaveLength(1);
    expect(invoke.type).toBe('invoke');
    // The pool calls privacy_invoke through its fixed invoke selector; the
    // action cannot name another entry point.
    expect(Reflect.ownKeys(invoke)).toEqual(['type', 'contract', 'calldata']);
    expect(invoke.type === 'invoke' && invoke.contract).toBe(ANONYMIZER);
    // The staked STRK reaches the anonymizer before it is invoked.
    expect(actions[0]).toEqual({ type: 'withdraw', token: STRK, amount: '0x4563918244f40000', recipient: ANONYMIZER });
  });

  it.each([
    ['one base unit', 1n, '0x1', '0x0'],
    ['the largest u128', (1n << 128n) - 1n, `0x${'f'.repeat(32)}`, '0x0'],
    ['exactly 2^128', 1n << 128n, '0x0', '0x1'],
    ['2^128 + 7', (1n << 128n) + 7n, '0x7', '0x1'],
    ['the largest u256', MAX_UINT256, `0x${'f'.repeat(32)}`, `0x${'f'.repeat(32)}`],
  ])('serializes privacy_invoke(in_token, out_token, assets, note_id) with %s as (low, high)', async (_label, amountIn, low, high) => {
    const { actions } = await provedActions({ ...STAKE, amountIn } as Intent);

    expect(actions).toEqual(expectedStakeActions(amountIn, low, high));
    const invoke = actions[2]!;
    expect(invoke.type === 'invoke' && invoke.calldata).toEqual([STRK, XSTRK, low, high, OPEN_NOTE]);
  });

  it('takes note_id from the same wallet-resolved placeholder the swap uses, for the one xSTRK note owned by the account', async () => {
    const { actions } = await provedActions(STAKE);
    const openNotes = actions.filter((action) => action.type === 'transfer' && action.amount === 'OPEN');
    const invoke = actions[2]!;

    expect(openNotes).toEqual([{ type: 'transfer', token: XSTRK, amount: 'OPEN', recipient: TAKER }]);
    expect(invoke.type === 'invoke' && invoke.calldata.at(-1)).toBe(OPEN_NOTE);
  });

  it('publishes the pool fee alone, and no public-leg warning (D-064)', async () => {
    const { ops, gateway } = fixture();
    const batch = await ops.prepare([STAKE]);

    expect(batch.poolFee).toBe(POOL_FEE);
    // The wallet adds and prices its own network fee (D-082).
    expect(batch.gasEstimate).toBe(0n);
    expect(batch.totalCost).toBe(POOL_FEE);
    expect(gateway.estimate).not.toHaveBeenCalled();
    // The lead waived the stake disclosure (D-064), and a swap carries no
    // public-leg warning either: the seam must not reintroduce one as review copy.
    expect(batch.warnings).toEqual([]);
    expect(batch.warnings.some((warning) => warning.kind === 'public-leg')).toBe(false);
    expect(Object.isFrozen(batch.warnings)).toBe(true);
  });

  it('refuses before proving when the confirm-time pool fee exceeds the ceiling', async () => {
    const { ops, pool, invoked } = fixture();
    const batch = await ops.prepare([STAKE]);
    vi.spyOn(pool, 'config').mockResolvedValue({
      feeAmount: POOL_FEE + 1n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
    });

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/above the ceiling/);
    expect(invoked).toEqual([]);
  });

  it('keeps a 118 while proving a stake as this account\'s own not-registered (D-074)', async () => {
    const { ops, wallet, gateway } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockRejectedValue({ code: 118, message: 'An error occurred (NOT_REGISTERED)' });
    const batch = await ops.prepare([STAKE]);

    // Only a transfer's 118 names another account; a stake's output note is the player's own.
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'not-registered' });
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('needs no relay-fee authority: a zero relay ceiling still stakes (D-082)', async () => {
    const { ops, gateway } = fixture(stakePolicy({ maxRelayFee: 0n }));

    await expect(ops.prepare([STAKE])).resolves.toMatchObject({ totalCost: POOL_FEE });
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('returns the wallet hash once and allows a single confirmation attempt', async () => {
    const { ops, invoked } = fixture();
    const batch = await ops.prepare([STAKE]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({ transactionHash: HASH });
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/already confirmed or attempted/);
    expect(invoked).toHaveLength(1);
  });

  it('matches the deterministic fake on the published warning', async () => {
    const fake = new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n } });
    const { ops } = fixture();

    const [real, demo] = await Promise.all([ops.prepare([STAKE]), fake.prepare([STAKE])]);
    expect(demo.warnings).toEqual(real.warnings);
  });
});

describe('existing intents under a stake-enabled policy', () => {
  const everything = stakePolicy({
    enabledRoutes: ['shield', 'unshield', 'transfer', 'stake'],
    allowedTokens: { shield: [STRK], unshield: [STRK], transfer: [STRK], swap: [], stake: [STRK, XSTRK] },
  });

  it('keeps the private transfer action set, now wallet-submitted', async () => {
    const { actions, gateway } = await provedActions(
      { kind: 'transfer', token: STRK, amount: 2n, recipient: BOB },
      everything,
    );

    expect(actions).toEqual([{ type: 'transfer', token: STRK, amount: '0x2', recipient: BOB }]);
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('keeps the unshield action set, now wallet-submitted', async () => {
    const { actions, gateway } = await provedActions(
      { kind: 'unshield', token: STRK, amount: 3n, recipient: BOB },
      everything,
    );

    expect(actions).toEqual([{ type: 'withdraw', token: STRK, amount: '0x3', recipient: BOB }]);
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('keeps the shield on the wallet-submitted deposit path', async () => {
    const { ops, wallet, gateway } = fixture(everything);
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 4n }]);

    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(invoke).toHaveBeenCalledWith([{ type: 'deposit', token: STRK, amount: '0x4' }]);
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });
});

describe('session admission of the stake policy', () => {
  function sessionWith(policy: WalletRoutePolicy, operations: PrivacyOperations = new FakePrivacyOperations()) {
    const handle: WalletHandle = { name: 'Ready', icon: 'data:image/svg+xml,Ready' };
    const discovery: WalletDiscoveryPort = {
      getWallets: vi.fn(() => [handle]),
      subscribe: () => () => undefined,
      refresh: () => undefined,
    };
    const owned: WalletRoutePolicy[] = [];
    const port: WalletConnectionPort = {
      getSnapshot: () => ({ account: '0x111', chainId: MAINNET }),
      createOperations(policyForOperations) {
        owned.push(policyForOperations);
        return operations;
      },
      subscribe: () => () => undefined,
      disconnect: async () => undefined,
      destroy: () => undefined,
    };
    const create = () => createWalletSession(
      { rpcUrl: 'https://rpc.example', backendBaseUrl: '/api', expectedChainId: MAINNET, policy },
      { discovery, connectWallet: async () => port },
    );
    return { create, discovery, owned };
  }

  it('admits the stake route and snapshots its allowlist before a caller can widen it', async () => {
    const stake = [STRK, XSTRK];
    const enabledRoutes: WalletRoutePolicy['enabledRoutes'][number][] = ['stake'];
    const policy = stakePolicy({
      enabledRoutes,
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], stake },
    });
    const { create, owned } = sessionWith(policy);
    const session = create();

    stake.push(OTHER);
    enabledRoutes.push('swap');
    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(owned).toHaveLength(1);
    expect(owned[0]!.enabledRoutes).toEqual(['stake']);
    expect(owned[0]!.allowedTokens.stake).toEqual([STRK, XSTRK]);
    expect(Object.isFrozen(owned[0]!.allowedTokens.stake)).toBe(true);
  });

  it('keeps a policy without a stake allowlist valid, with nothing admitted', async () => {
    const { create, owned } = sessionWith({
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    });
    const session = create();
    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(owned[0]!.allowedTokens.stake).toBeUndefined();
    expect('stake' in owned[0]!.allowedTokens).toBe(false);
  });

  const accessorStake = Object.defineProperty(
    { shield: [], unshield: [], transfer: [], swap: [] },
    'stake',
    { enumerable: true, get: () => [STRK, XSTRK] },
  );

  it.each([
    ['a zero stake token', { shield: [], unshield: [], transfer: [], swap: [], stake: ['0x0'] }],
    ['a decimal stake token', { shield: [], unshield: [], transfer: [], swap: [], stake: ['123'] }],
    ['numerically duplicate stake tokens', {
      shield: [], unshield: [], transfer: [], swap: [], stake: [STRK, `0x${BigInt(STRK).toString(16)}`],
    }],
    ['an accessor-backed stake allowlist', accessorStake],
  ])('rejects %s before discovery', (_label, allowedTokens) => {
    const { create, discovery } = sessionWith(stakePolicy({ allowedTokens: allowedTokens as never }));

    expect(create).toThrow(PrivacyError);
    expect(discovery.getWallets).not.toHaveBeenCalled();
  });

  function batchWith(intent: unknown, discard = vi.fn()): PreparedBatch {
    return {
      intents: [intent as Intent],
      poolFee: 0n,
      gasEstimate: 0n,
      totalCost: 0n,
      warnings: [],
      promptCount: 1,
      confirm: vi.fn(async () => ({ transactionHash: '0x1' })),
      discard,
    };
  }

  function operationsReturning(prepared: PreparedBatch): PrivacyOperations {
    return {
      capability: async () => ({ supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unknown' }),
      poolConfig: async () => ({ feeAmount: 0n, feeToken: '0x1', proofValidityBlocks: 1, noteMaturityBlocks: 1 }),
      balances: async () => [],
      recipientStatus: async () => 'registered',
      prepare: async () => prepared,
      hasPrivateFunds: async () => false,
      depositStatus: async () => 'pending',
      // D-077, D-079: not exercised here.
      vaultPositions: async () => { throw new Error('unused'); },
      prepareVaultSupply: async () => { throw new Error('unused'); },
      prepareVaultRedeem: async () => { throw new Error('unused'); },
      vaultRates: async () => { throw new Error('unused'); },
      // D-083: not exercised here.
      borrowMarket: async () => { throw new Error('unused'); },
      borrowPositions: async () => { throw new Error('unused'); },
      prepareBorrow: async () => { throw new Error('unused'); },
    };
  }

  it('publishes a well-formed prepared stake intent as an owned snapshot', async () => {
    const { create } = sessionWith(stakePolicy(), operationsReturning(batchWith({ ...STAKE })));
    const session = create();
    await session.connect(session.getSnapshot().wallets[0]!.key);

    const published = await session.operations.prepare([STAKE]);
    expect(published.intents).toEqual([STAKE]);
    expect(Object.isFrozen(published.intents[0])).toBe(true);
  });

  it.each([
    ['a zero amount', { ...STAKE, amountIn: 0n }],
    ['a zero output token', { ...STAKE, tokenOut: '0x0' }],
    ['a missing input token', { kind: 'stake', tokenOut: XSTRK, amountIn: 1n }],
  ])('rejects and retires a prepared stake with %s', async (_label, intent) => {
    const discard = vi.fn();
    const { create } = sessionWith(stakePolicy(), operationsReturning(batchWith(intent, discard)));
    const session = create();
    await session.connect(session.getSnapshot().wallets[0]!.key);

    await expect(session.operations.prepare([STAKE])).rejects.toThrow('The wallet returned an invalid prepared intent.');
    expect(discard).toHaveBeenCalledOnce();
  });
});

describe('backend client stake route', () => {
  function recordingClient(body: unknown) {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { client: new BackendPrivacyClient('https://backend.example', fetcher), requests, fetcher };
  }

  it('requests a stake relay quote from the fee endpoint', async () => {
    const { client, requests } = recordingClient({
      token: STRK, recipient: FEE_RECIPIENT, amount: '7', authorization: 'auth', expiresAtBlock: 1_450,
    });

    await expect(client.estimate({ route: 'stake', feeToken: STRK, operationToken: STRK }))
      .resolves.toMatchObject({ amount: 7n, authorization: 'auth' });
    expect(requests).toEqual([{
      url: 'https://backend.example/v1/private/fees',
      body: { v: 1, route: 'stake', feeToken: STRK, operationToken: STRK },
    }]);
  });

  it('submits a proved stake artifact on the stake route', async () => {
    const { client, requests } = recordingClient({ transactionHash: '0x5eed' });
    const artifact = {
      call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
      proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
    };

    await expect(client.submit({ route: 'stake', artifact, feeAuthorization: 'auth', proofValidityBlocks: 450 }))
      .resolves.toEqual({ transactionHash: '0x5eed' });
    expect(requests[0]).toMatchObject({
      url: 'https://backend.example/v1/private/submissions',
      body: { v: 1, route: 'stake', feeAuthorization: 'auth', proofValidityBlocks: 450 },
    });
  });

  it('still rejects an unknown route before transport', async () => {
    const { client, fetcher } = recordingClient({});

    await expect(client.estimate({ route: 'vault', feeToken: STRK, operationToken: STRK } as never))
      .rejects.toMatchObject({ kind: 'unknown' });
    await expect(client.submit({
      route: 'vault', artifact: {}, feeAuthorization: 'auth', proofValidityBlocks: 450,
    } as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
