import { describe, expect, it, vi } from 'vitest';
import { num, transaction, type STRK20_ACTION, type STRK20_CALL_AND_PROOF } from 'starknet';
import {
  PrivacyError,
  WalletApiPrivacyOperations,
  mapWalletError,
  type Intent,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type WalletStrk20Account,
} from '../index.js';
import { mapTransferWalletError } from './errors.js';
import { SWAP_TEST_PARTIAL, swapTestQuotes, swapTestReads } from '../testing/swap-quotes.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const STRK_DECIMAL = BigInt(STRK).toString();
const STRK_UPPER_PREFIX = `0X${STRK.slice(2)}`;
const STRK_UPPER_HEX = `0x${STRK.slice(2).toUpperCase()}`;
const TOKEN = '0x123';
const BOB = '0x456';
const FEE_RECIPIENT = '0x789';
const POOL_FEE = 6n * 10n ** 18n;
const AUTH = { authorization: 'fee-auth', expiresAtBlock: 1_450 };
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

function fixture() {
  const invoked: STRK20_ACTION[][] = [];
  const prepared: STRK20_ACTION[][] = [];
  const artifact: STRK20_CALL_AND_PROOF = {
    call: { contractAddress: '0x123', entrypoint: 'apply_actions', calldata: ['0x1'] },
    proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
  };
  const wallet: WalletStrk20Account = {
    address: '0xabc',
    async strk20Balances(tokens) {
      return tokens.map((token) => ({ token, balance: '0x64' }));
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: '0x5e1d' };
    },
    async strk20PrepareInvoke(actions, simulate) {
      expect(simulate).toBe(false);
      prepared.push(actions);
      return artifact;
    },
  };
  const pool: PoolReadClient = {
    async config() {
      return {
        feeAmount: POOL_FEE,
        feeToken: STRK,
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      };
    },
    async publicKey(address) {
      return address === BOB ? '0x99' : '0x0';
    },
    async receipt() {
      throw new Error('no receipt read in this fixture');
    },
  };
  const gateway: PrivateSubmissionGateway = {
    estimate: vi.fn(async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH })),
    submit: vi.fn(async () => ({ transactionHash: '0xprivate' })),
  };
  const supportedVersions = vi.fn(async () => ['0.9.0', '0.10.3']);
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions,
    policy: {
      maxIntents: 8,
      maxRelayFee: 10n,
      enabledRoutes: ['shield', 'unshield', 'transfer'],
      allowedTokens: {
        shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
      },
    },
  });
  return { ops, wallet, pool, gateway, supportedVersions, invoked, prepared, artifact };
}

/**
 * Operations with the swap route on (D-084): the wallet answers a
 * shadow-account commitment and reports Wallet API 0.10.4, the backend
 * answers the stand-in address, and avnu's quote comes from the test client.
 */
function swapOperations(wallet: WalletStrk20Account, pool: PoolReadClient) {
  const shadowWallet: WalletStrk20Account = {
    address: wallet.address,
    strk20Balances: (tokens) => wallet.strk20Balances(tokens),
    strk20PrepareInvoke: (actions, simulate) => wallet.strk20PrepareInvoke(actions, simulate),
    strk20InvokeTransaction: (actions) => wallet.strk20InvokeTransaction(actions),
    async strk20ShadowAccountCommitment() { return SWAP_TEST_PARTIAL; },
  };
  return new WalletApiPrivacyOperations({
    wallet: shadowWallet,
    pool,
    swapQuotes: swapTestQuotes([2n]),
    vault: swapTestReads(),
    supportedVersions: async () => ['0.10.4'],
    now: () => 1_000,
    policy: {
      maxIntents: 1, maxRelayFee: 10n, enabledRoutes: ['swap'],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [TOKEN, STRK] },
      swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 100 },
    },
  });
}

describe('WalletApiPrivacyOperations capability and reads', () => {
  it.each([
    ['shield amount', { kind: 'shield', token: TOKEN, amount: MAX_UINT256 + 1n }],
    ['transfer amount', { kind: 'transfer', token: TOKEN, amount: MAX_UINT256 + 1n, recipient: BOB }],
    ['unshield amount', { kind: 'unshield', token: TOKEN, amount: MAX_UINT256 + 1n, recipient: BOB }],
    ['swap input', { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: MAX_UINT256 + 1n, minAmountOut: 1n }],
    ['swap minimum output', { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 1n, minAmountOut: MAX_UINT256 + 1n }],
  ] as const)('rejects an out-of-u256 %s before any dependency call', async (_label, intent) => {
    const { ops, pool, wallet, gateway } = fixture();
    const config = vi.spyOn(pool, 'config');
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const prepare = vi.spyOn(wallet, 'strk20PrepareInvoke');

    await expect(ops.prepare([intent as Intent])).rejects.toMatchObject({ kind: 'unknown' });
    expect(config).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('preserves the exact u256 maximum intent boundary', async () => {
    const { ops, pool } = fixture();
    const config = vi.spyOn(pool, 'config');

    await expect(ops.prepare([{ kind: 'shield', token: TOKEN, amount: MAX_UINT256 }]))
      .resolves.toMatchObject({ intents: [{ amount: MAX_UINT256 }] });
    expect(config).toHaveBeenCalledOnce();
  });

  it('owns its route policy before caller mutation can enable a financial route', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    const policy = {
      maxIntents: 1,
      maxRelayFee: 0n,
      enabledRoutes: [] as ('shield')[],
      allowedTokens: {
        shield: [] as string[], unshield: [] as string[], transfer: [] as string[], swap: [] as string[],
      },
    };
    const ops = new WalletApiPrivacyOperations({ wallet, pool, supportedVersions, policy });

    policy.enabledRoutes.push('shield');
    policy.allowedTokens.shield.push(TOKEN);

    await expect(ops.prepare([{ kind: 'shield', token: TOKEN, amount: 1n }]))
      .rejects.toThrow(/route is disabled/i);
  });

  it('detects support by version query without reading balances', async () => {
    const { ops, wallet, supportedVersions } = fixture();
    const balances = vi.spyOn(wallet, 'strk20Balances');
    await expect(ops.capability()).resolves.toMatchObject({
      supportsStrk20: true,
      walletApiVersion: '0.10.3',
    });
    expect(supportedVersions).toHaveBeenCalledOnce();
    expect(balances).not.toHaveBeenCalled();
  });

  it('publishes an immutable wallet capability snapshot', async () => {
    const { ops } = fixture();

    const capability = await ops.capability();

    expect(Object.isFrozen(capability)).toBe(true);
    expect(Reflect.set(capability, 'supportsStrk20', false)).toBe(false);
    expect(capability.supportsStrk20).toBe(true);
  });

  it.each([
    ['null token container', null],
    ['object token container', {}],
    ['malformed token', ['not-a-felt']],
  ] as const)('rejects a %s before asking the wallet for balances', async (_label, tokens) => {
    const { ops, wallet } = fixture();
    const balances = vi.spyOn(wallet, 'strk20Balances');

    await expect(ops.balances(tokens as never)).rejects.toMatchObject({ kind: 'unknown' });
    expect(balances).not.toHaveBeenCalled();
  });

  it('snapshots requested balance tokens before handing them to the wallet', async () => {
    const { ops, wallet } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let handed: string[] | undefined;
    vi.spyOn(wallet, 'strk20Balances').mockImplementation(async (tokens) => {
      await pending;
      handed = tokens;
      return tokens.map((token) => ({ token, balance: '0x64' }));
    });
    const requested = [TOKEN];

    const reading = ops.balances(requested);
    requested[0] = 'not-a-felt';
    requested.push(STRK);
    release();

    await expect(reading).resolves.toEqual([
      { token: TOKEN, total: 100n, spendable: 0n, maturing: 0n, maturityKnown: false },
    ]);
    expect(handed).toEqual([TOKEN]);
    expect(handed).not.toBe(requested);
  });

  it('owns requested token descriptors before a caller proxy can substitute them', async () => {
    const { ops, wallet } = fixture();
    const source = [TOKEN];
    const reads: PropertyKey[] = [];
    const requested = new Proxy(source, {
      get(target, key, receiver) {
        reads.push(key);
        if (key === '0') return STRK;
        return Reflect.get(target, key, receiver);
      },
    });
    let handed: string[] | undefined;
    vi.spyOn(wallet, 'strk20Balances').mockImplementation(async (tokens) => {
      handed = tokens;
      return [{ token: tokens[0]!, balance: '0x64' }];
    });

    await expect(ops.balances(requested)).resolves.toEqual([
      { token: TOKEN, total: 100n, spendable: 0n, maturing: 0n, maturityKnown: false },
    ]);
    expect(handed).toEqual([TOKEN]);
    expect(reads).toEqual([]);
  });

  it('rejects balance fields supplied only by the object prototype', async () => {
    const { ops, wallet } = fixture();
    const inherited = Object.create({ token: TOKEN, balance: '0x64' });
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([inherited as never]);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not invoke an accessor-backed balance field', async () => {
    const { ops, wallet } = fixture();
    const accessor = { token: TOKEN, balance: '0x64' } as { token: string; balance: string };
    Object.defineProperty(accessor, 'balance', {
      configurable: true,
      get() { throw new Error('balance getter must not run'); },
    });
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([accessor as never]);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('owns balance descriptor values before a stateful proxy can substitute them', async () => {
    const { ops, wallet } = fixture();
    const source = { token: TOKEN, balance: '0x64' };
    let reads = 0;
    const entry = new Proxy(source, {
      get(target, key, receiver) {
        if (key === 'balance') {
          reads += 1;
          return '0x32';
        }
        return Reflect.get(target, key, receiver);
      },
    });
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([entry]);

    await expect(ops.balances([TOKEN])).resolves.toEqual([
      { token: TOKEN, total: 100n, spendable: 0n, maturing: 0n, maturityKnown: false },
    ]);
    expect(reads).toBe(0);
  });

  it('owns the balance result array without invoking element or length proxy reads', async () => {
    const { ops, wallet } = fixture();
    const source = [{ token: TOKEN, balance: '0x64' }];
    const reads: PropertyKey[] = [];
    const balances = new Proxy(source, {
      get(target, key, receiver) {
        reads.push(key);
        if (key === '0') return { token: TOKEN, balance: '0x32' };
        return Reflect.get(target, key, receiver);
      },
    });
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue(balances);

    await expect(ops.balances([TOKEN])).resolves.toEqual([
      { token: TOKEN, total: 100n, spendable: 0n, maturing: 0n, maturityKnown: false },
    ]);
    // Promise resolution performs the language-mandated thenable probe before
    // this method receives the wallet result. The decoder itself must perform
    // no length or indexed reads.
    expect(reads).toEqual(['then']);
  });

  it.each([
    ['null', null],
    ['missing transaction hash', {}],
    ['non-string transaction hash', { transaction_hash: 42 }],
    ['empty transaction hash', { transaction_hash: '' }],
  ] as const)('rejects a %s wallet submission result as an invalid wallet result', async (_label, response) => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockResolvedValue(response as never);
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects inherited or accessor-backed private transaction hashes without reading them', async () => {
    const { ops, wallet } = fixture();
    const inherited = Object.create({ transaction_hash: '0xf0' });
    const accessor = {} as { transaction_hash?: string };
    Object.defineProperty(accessor, 'transaction_hash', {
      configurable: true,
      get() { throw new Error('transaction hash getter must not run'); },
    });
    vi.spyOn(wallet, 'strk20InvokeTransaction')
      .mockResolvedValueOnce(inherited as never)
      .mockResolvedValueOnce(accessor as never);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
      await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toMatchObject({ kind: 'unknown' });
    }
  });

  it('marks the maturity split unknown because the Wallet API returns only an aggregate', async () => {
    const { ops } = fixture();
    await expect(ops.balances([TOKEN])).resolves.toEqual([
      { token: TOKEN, total: 100n, spendable: 0n, maturing: 0n, maturityKnown: false },
    ]);
  });

  it('publishes immutable live balance snapshots', async () => {
    const { ops } = fixture();

    const balances = await ops.balances([TOKEN]);

    expect(Object.isFrozen(balances)).toBe(true);
    expect(balances.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(balances[0]!, 'total', 0n)).toBe(false);
    expect(balances[0]?.total).toBe(100n);
  });

  it('rejects duplicate numeric token identities in a wallet balance response', async () => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([
      { token: TOKEN, balance: '0x64' },
      { token: `0x0${TOKEN.slice(2)}`, balance: '0x32' },
    ]);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects an unrequested token disclosed by the wallet', async () => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([
      { token: TOKEN, balance: '0x64' },
      { token: STRK, balance: '0x32' },
    ]);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('publishes an immutable live pool snapshot distinct from the backend owner', async () => {
    const { ops, pool } = fixture();
    const source = {
      feeAmount: POOL_FEE,
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 10,
    };
    vi.spyOn(pool, 'config').mockResolvedValue(source);

    const config = await ops.poolConfig();

    expect(config).not.toBe(source);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Reflect.set(config, 'feeAmount', 0n)).toBe(false);
    expect(config.feeAmount).toBe(POOL_FEE);
  });

  it.each([
    ['inherited fields', Object.assign(Object.create({
      feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
    }), {})],
    ['accessor fields', Object.defineProperty({
      feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
    }, 'feeAmount', { enumerable: true, get() { throw new Error('must not run'); } })],
  ])('rejects pool config with %s without publishing it', async (_label, response) => {
    const { ops, pool } = fixture();
    vi.spyOn(pool, 'config').mockResolvedValue(response as never);

    await expect(ops.poolConfig()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['descriptor trap', new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('descriptor trap'); } })],
    ['ownKeys trap', new Proxy({
      feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
    }, { ownKeys() { throw new Error('own keys trap'); } })],
  ])('contains a pool config %s as an invalid provider result', async (_label, response) => {
    const { ops, pool } = fixture();
    vi.spyOn(pool, 'config').mockResolvedValue(response as never);

    await expect(ops.poolConfig()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['extra string field', {
      feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10, extra: true,
    }],
    ['extra symbol field', Object.assign({
      feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
    }, { [Symbol('provider')]: true })],
  ])('rejects pool config with an %s', async (_label, response) => {
    const { ops, pool } = fixture();
    vi.spyOn(pool, 'config').mockResolvedValue(response as never);

    await expect(ops.poolConfig()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each(['shield', 'transfer', 'swap'] as const)(
    'rejects malformed live %s config before confirmation authority',
    async (route) => {
      let { ops, pool, wallet } = fixture();
      const intent: Intent = route === 'shield'
        ? { kind: 'shield', token: TOKEN, amount: 1n }
        : route === 'transfer'
          ? { kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB }
          : { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 1n, minAmountOut: 1n };
      if (route === 'swap') ops = swapOperations(wallet, pool);
      const batch = await ops.prepare([intent]);
      vi.spyOn(pool, 'config').mockResolvedValue({
        feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 0, noteMaturityBlocks: 10,
      });
      const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
      const prepare = vi.spyOn(wallet, 'strk20PrepareInvoke');

      await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toMatchObject({ kind: 'unknown' });
      expect(invoke).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['negative fee', { feeAmount: -1n }],
    ['fee above u256', { feeAmount: MAX_UINT256 + 1n }],
    ['number fee', { feeAmount: 1 }],
    ['zero fee token', { feeToken: '0x0' }],
    ['decimal fee token', { feeToken: '123' }],
    ['zero proof validity', { proofValidityBlocks: 0 }],
    ['fractional proof validity', { proofValidityBlocks: 1.5 }],
    ['negative maturity', { noteMaturityBlocks: -1 }],
    ['unsafe maturity', { noteMaturityBlocks: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)('rejects a pool config with %s', async (_label, patch) => {
    const { ops, pool } = fixture();
    vi.spyOn(pool, 'config').mockResolvedValue({
      feeAmount: POOL_FEE,
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 10,
      ...patch,
    } as never);

    await expect(ops.poolConfig()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('costs a wallet-submitted spend at the pool fee alone, with no relay quote (D-082)', async () => {
    const { ops, pool, gateway } = fixture();
    vi.spyOn(pool, 'config').mockResolvedValue({
      feeAmount: MAX_UINT256,
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 10,
    });

    for (const intent of [
      { kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB },
      { kind: 'unshield', token: TOKEN, amount: 1n, recipient: BOB },
    ] as const) {
      await expect(ops.prepare([intent])).resolves.toMatchObject({
        poolFee: MAX_UINT256, gasEstimate: 0n, totalCost: MAX_UINT256,
      });
    }
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('holds a live pool fee above the ceiling before wallet confirmation', async () => {
    const { ops, pool, wallet } = fixture();
    let reads = 0;
    vi.spyOn(pool, 'config').mockImplementation(async () => ({
      feeAmount: reads++ === 0 ? POOL_FEE : POOL_FEE + 1n,
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 10,
    }));
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/ceiling/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['object', {}],
    ['primitive', 42],
  ] as const)('rejects a non-array %s Wallet API balance response as an invalid wallet result', async (_label, response) => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue(response as never);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects a negative wallet balance instead of publishing impossible funds', async () => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([
      { token: TOKEN, balance: '-1' },
    ]);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['a malformed token', { token: 'not-a-felt', balance: '0x64' }],
    ['a malformed balance', { token: TOKEN, balance: 'not-a-felt' }],
  ])('rejects %s from the Wallet API balance response', async (_label, entry) => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([entry]);

    await expect(ops.balances([TOKEN])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not return pool config after its read is aborted', async () => {
    const { ops, pool } = fixture();
    let release!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(pool, 'config').mockImplementation(async () => {
      started();
      await pending;
      return {
        feeAmount: POOL_FEE,
        feeToken: STRK,
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      };
    });
    const controller = new AbortController();
    const reading = ops.poolConfig(controller.signal);

    await readStarted;
    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    release();

    await expect(reading).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('does not hand an aborted shield confirmation to the wallet after its fee read', async () => {
    const { ops, pool, wallet } = fixture();
    let configCalls = 0;
    let release!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(pool, 'config').mockImplementation(async () => {
      configCalls += 1;
      if (configCalls === 1) {
        return {
          feeAmount: POOL_FEE,
          feeToken: STRK,
          proofValidityBlocks: 450,
          noteMaturityBlocks: 10,
        };
      }
      started();
      await pending;
      return {
        feeAmount: POOL_FEE,
        feeToken: STRK,
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      };
    });
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);
    const controller = new AbortController();
    const progress: string[] = [];
    const confirming = batch.confirm({
      feeCeiling: POOL_FEE,
      signal: controller.signal,
      onProgress: ({ stage }) => progress.push(stage),
    });

    await readStarted;
    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    release();

    await expect(confirming).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(invoke).not.toHaveBeenCalled();
    expect(progress).not.toContain('awaiting-approval');
  });

  it('does not hand an aborted private confirmation to the wallet after its fee read', async () => {
    const { ops, pool, wallet, prepared, gateway } = fixture();
    let configCalls = 0;
    let release!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(pool, 'config').mockImplementation(async () => {
      configCalls += 1;
      const config = {
        feeAmount: POOL_FEE,
        feeToken: STRK,
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      };
      if (configCalls === 1) return config;
      started();
      await pending;
      return config;
    });
    const walletPrepare = vi.spyOn(wallet, 'strk20PrepareInvoke');
    const walletInvoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const submit = vi.spyOn(gateway, 'submit');
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    const controller = new AbortController();
    const progress: string[] = [];
    const confirming = batch.confirm({
      feeCeiling: POOL_FEE + 1n,
      signal: controller.signal,
      onProgress: ({ stage }) => progress.push(stage),
    });

    await readStarted;
    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    release();

    await expect(confirming).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(walletPrepare).not.toHaveBeenCalled();
    expect(walletInvoke).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(prepared).toHaveLength(0);
    expect(progress).not.toContain('awaiting-approval');
  });

  it('does not publish a private batch after its pool read is aborted', async () => {
    const { ops, pool, gateway } = fixture();
    let release!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(pool, 'config').mockImplementation(async () => {
      started();
      await pending;
      return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    });
    const controller = new AbortController();
    const preparing = ops.prepare(
      [{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }],
      controller.signal,
    );

    await readStarted;
    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    release();

    await expect(preparing).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('preflights recipient registration through the pool read port', async () => {
    const { ops } = fixture();
    await expect(ops.recipientStatus(BOB)).resolves.toBe('registered');
    await expect(ops.recipientStatus('0x999')).resolves.toBe('unregistered');
  });

  it('rejects values outside the Stark field before an RPC or wallet call', async () => {
    const { ops, pool } = fixture();
    const publicKey = vi.spyOn(pool, 'publicKey');
    await expect(ops.recipientStatus(`0x${'f'.repeat(64)}`)).rejects.toThrow(/invalid recipient/i);
    expect(publicKey).not.toHaveBeenCalled();
  });

  it('blocks an unregistered transfer during prepare instead of proving a doomed action', async () => {
    const { ops, gateway, prepared } = fixture();
    // The recipient's fact, never this account's own `not-registered` (D-074).
    await expect(ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: '0x999' },
    ])).rejects.toMatchObject({
      kind: 'recipient-not-registered',
      message: 'The recipient is not registered with the privacy pool.',
    });
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(prepared).toHaveLength(0);
  });

  it('maps a 118 from the wallet proving a transfer to the recipient, never to this account (D-074)', async () => {
    const { ops, gateway, wallet } = fixture();
    const refusal = { code: 118, message: 'An error occurred (NOT_REGISTERED)' };
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockRejectedValue(refusal);
    // BOB passes the pool preflight, so the 118 comes from the wallet's proving
    // and submitting call (D-082).
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    const stages: string[] = [];

    const failure = await batch.confirm({
      feeCeiling: POOL_FEE + 1n,
      onProgress: ({ stage }) => stages.push(stage),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PrivacyError);
    expect(failure).toMatchObject({
      kind: 'recipient-not-registered',
      message: 'The recipient is not registered with the privacy pool.',
    });
    // The wallet's own answer stays on the cause, for the D-069 debug line.
    expect((failure as PrivacyError).cause).toBe(refusal);
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(stages.at(-1)).toBe('failed');
  });

  it('keeps a 118 on an unshield as this account\'s own not-registered', async () => {
    const { ops, gateway, wallet } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockRejectedValue({ code: 118, message: 'An error occurred (NOT_REGISTERED)' });
    // A withdrawal names a public address, which no registration governs.
    const batch = await ops.prepare([{ kind: 'unshield', token: TOKEN, amount: 20n, recipient: '0x999' }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toMatchObject({ kind: 'not-registered' });
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it.each([
    [113, 'user-rejected'],
    [119, 'insufficient-balance'],
    [120, 'privacy-leak'],
    [163, 'unknown'],
  ] as const)('keeps a transfer proof\'s %s as %s', async (code, kind) => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockRejectedValue({ code, message: 'wallet error' });
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toMatchObject({ kind });
  });

  it.each([
    ['a negative decimal key', '-1'],
    ['a non-0x decimal key', '123'],
    ['a malformed hex string', '0xnot-a-felt'],
    ['a whitespace-padded key', ' 0x1'],
    ['an uppercase 0X-prefixed key', '0X1'],
    ['the field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
    ['a value above the field', `0x${(STARK_FIELD_PRIME + 1n).toString(16)}`],
  ])('fails closed for %s and blocks transfer preparation', async (_label, key) => {
    const { ops, pool, gateway, prepared } = fixture();
    vi.spyOn(pool, 'publicKey').mockResolvedValue(key);
    const estimate = vi.spyOn(gateway, 'estimate');

    await expect(ops.recipientStatus(BOB)).resolves.toBe('unknown');
    await expect(ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ])).rejects.toMatchObject({ kind: 'unreachable' });
    expect(estimate).not.toHaveBeenCalled();
    expect(prepared).toHaveLength(0);
  });

  it('preserves zero and leading-zero semantics from the existing felt validator', async () => {
    const zero = fixture();
    vi.spyOn(zero.pool, 'publicKey').mockResolvedValue('0x00');
    await expect(zero.ops.recipientStatus(BOB)).resolves.toBe('unregistered');

    const nonzero = fixture();
    vi.spyOn(nonzero.pool, 'publicKey').mockResolvedValue('0x0001');
    await expect(nonzero.ops.recipientStatus(BOB)).resolves.toBe('registered');
  });
});

describe('Wallet API action routes', () => {
  it.each(['shield', 'transfer', 'swap'] as const)(
    'rejects an out-of-u256 fee ceiling on %s before live reads or handoff',
    async (route) => {
      let { ops, pool, wallet } = fixture();
      const intent: Intent = route === 'shield'
        ? { kind: 'shield', token: TOKEN, amount: 1n }
        : route === 'transfer'
          ? { kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB }
          : { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 1n, minAmountOut: 1n };
      if (route === 'swap') ops = swapOperations(wallet, pool);
      const batch = await ops.prepare([intent]);
      const config = vi.spyOn(pool, 'config');
      const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
      const prepare = vi.spyOn(wallet, 'strk20PrepareInvoke');

      await expect(batch.confirm({ feeCeiling: MAX_UINT256 + 1n })).rejects.toMatchObject({ kind: 'unknown' });
      expect(config).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it('preserves the exact u256 maximum fee ceiling', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 1n }]);

    await expect(batch.confirm({ feeCeiling: MAX_UINT256 })).resolves.toEqual({
      transactionHash: '0x5e1d',
    });
  });

  it.each([
    ['shield', { kind: 'shield', token: TOKEN, amount: 1n, recipient: BOB }],
    ['transfer', { kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB, memo: 'private' }],
  ] as const)('rejects an intent with extra fields on the %s route', async (_label, intent) => {
    const { ops } = fixture();

    await expect(ops.prepare([intent as never])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not hand a discarded shield batch to the wallet after its fee read', async () => {
    const { ops, pool, wallet } = fixture();
    const originalConfig = pool.config;
    let configCalls = 0;
    let release!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(pool, 'config').mockImplementation(async (signal) => {
      configCalls += 1;
      if (configCalls === 1) return originalConfig(signal);
      started();
      await pending;
      return originalConfig(signal);
    });
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);

    const confirming = batch.confirm({ feeCeiling: POOL_FEE });
    await readStarted;
    batch.discard();
    release();

    await expect(confirming).rejects.toThrow(/discarded/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['negative bigint', -1n],
    ['number', 1],
    ['string', '1'],
  ] as const)('rejects an invalid %s fee ceiling before live reads or wallet handoff', async (_label, feeCeiling) => {
    const { ops, pool, wallet, gateway } = fixture();
    const poolRead = vi.spyOn(pool, 'config');
    const invoke = vi.spyOn(wallet, 'strk20PrepareInvoke');
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);
    poolRead.mockClear();

    await expect(batch.confirm({ feeCeiling: feeCeiling as never })).rejects.toMatchObject({
      kind: 'unknown',
    });
    expect(poolRead).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('freezes prepared warnings so disclosure cannot be removed before confirmation', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);

    expect(Object.isFrozen(batch.warnings)).toBe(true);
    expect(Object.isFrozen(batch.warnings[0])).toBe(true);
    expect(() => {
      (batch.warnings as unknown[]).pop();
    }).toThrow(TypeError);
    expect(() => {
      (batch.warnings[0] as unknown as { kind: string }).kind = 'safe';
    }).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['object', {}],
    ['primitive', 42],
  ] as const)('rejects a non-array %s intent container at the privacy boundary', async (_label, intents) => {
    const { ops } = fixture();

    await expect(ops.prepare(intents as never)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['a number shield amount', { kind: 'shield', token: TOKEN, amount: 20 }],
    ['a string shield amount', { kind: 'shield', token: TOKEN, amount: '20' }],
  ] as const)('rejects %s before publishing a prepared batch', async (_label, intent) => {
    const { ops } = fixture();

    await expect(ops.prepare([intent as never])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['null', null],
    ['missing transaction hash', {}],
    ['non-string transaction hash', { transaction_hash: 42 }],
    ['empty transaction hash', { transaction_hash: '' }],
  ] as const)('rejects a %s shield response as invalid wallet data', async (_label, response) => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockResolvedValue(response as never);
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects an inherited or accessor-backed shield transaction hash without reading it', async () => {
    const { ops, wallet } = fixture();
    const inherited = Object.create({ transaction_hash: '0xforged' });
    const accessor = {} as { transaction_hash?: string };
    Object.defineProperty(accessor, 'transaction_hash', {
      configurable: true,
      get() { throw new Error('transaction hash getter must not run'); },
    });
    vi.spyOn(wallet, 'strk20InvokeTransaction')
      .mockResolvedValueOnce(inherited as never)
      .mockResolvedValueOnce(accessor as never);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);
      await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    }
  });

  it('submits a shield through the wallet as one deposit action', async () => {
    const { ops, invoked } = fixture();
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);
    expect(batch.promptCount).toBe(1);
    expect(batch.warnings).toEqual([
      expect.objectContaining({ kind: 'public-leg' }),
    ]);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({
      transactionHash: '0x5e1d',
    });
    expect(invoked).toEqual([[{ type: 'deposit', token: TOKEN, amount: '0x14' }]]);
  });

  it('publishes an immutable shield settlement result', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);

    const result = await batch.confirm({ feeCeiling: POOL_FEE });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'transactionHash', '0xforged')).toBe(false);
    expect(result.transactionHash).toBe('0x5e1d');
  });

  it('reports a returned shield hash even if cancellation races with wallet settlement', async () => {
    const { ops, wallet } = fixture();
    const controller = new AbortController();
    wallet.strk20InvokeTransaction = vi.fn(async () => {
      controller.abort();
      return { transaction_hash: '0xalready-submitted' };
    });
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);

    await expect(batch.confirm({
      feeCeiling: POOL_FEE,
      signal: controller.signal,
    })).resolves.toEqual({ transactionHash: '0xalready-submitted' });
  });

  it('has the wallet prove and submit a private transfer, with no relay-fee leg and no relay (D-082)', async () => {
    const { ops, prepared, invoked, gateway } = fixture();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    expect(batch.gasEstimate).toBe(0n);
    expect(batch.totalCost).toBe(POOL_FEE);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({
      transactionHash: '0x5e1d',
    });
    expect(invoked).toEqual([[
      { type: 'transfer', token: TOKEN, amount: '0x14', recipient: BOB },
    ]]);
    expect(prepared).toEqual([]);
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('has the wallet prove and submit an unshield as one withdrawal (D-082)', async () => {
    const { ops, prepared, invoked, gateway } = fixture();
    const batch = await ops.prepare([{ kind: 'unshield', token: STRK, amount: 20n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({ transactionHash: '0x5e1d' });
    expect(invoked).toEqual([[{ type: 'withdraw', token: STRK, amount: '0x14', recipient: BOB }]]);
    expect(prepared).toEqual([]);
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('hands the wallet its own copy, so a mutating wallet cannot reach the reviewed actions', async () => {
    const { ops, wallet, invoked } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockImplementation(async (actions) => {
      invoked.push(structuredClone(actions));
      (actions[0] as { amount: string }).amount = '0xdead';
      actions.push({ type: 'withdraw', token: STRK, amount: '0x1', recipient: '0x999' });
      return { transaction_hash: '0x5e1d' };
    });
    const batch = await ops.prepare([{ kind: 'unshield', token: STRK, amount: 20n, recipient: BOB }]);
    await batch.confirm({ feeCeiling: POOL_FEE });

    expect(batch.intents).toEqual([{ kind: 'unshield', token: STRK, amount: 20n, recipient: BOB }]);
    expect(invoked).toEqual([[{ type: 'withdraw', token: STRK, amount: '0x14', recipient: BOB }]]);
  });

  it.each([
    ['a missing hash', {}],
    ['a non-felt hash', { transaction_hash: 'not-a-felt' }],
    ['a zero hash', { transaction_hash: '0x0' }],
  ])('rejects a wallet answer with %s as unknown', async (_label, answer) => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockResolvedValue(answer as never);
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    const stages: string[] = [];

    await expect(batch.confirm({ feeCeiling: POOL_FEE, onProgress: ({ stage }) => stages.push(stage) }))
      .rejects.toMatchObject({ kind: 'unknown' });
    expect(stages.at(-1)).toBe('failed');
  });

  it('reports the progress stages the shell drives its copy from, in order', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    const stages: string[] = [];

    await batch.confirm({ feeCeiling: POOL_FEE, onProgress: ({ stage }) => stages.push(stage) });

    expect(stages).toEqual(['awaiting-approval', 'proving', 'submitting', 'done']);
  });

  it('returns the wallet hash even when an abort lands while the wallet settles', async () => {
    const { ops, wallet } = fixture();
    const controller = new AbortController();
    vi.spyOn(wallet, 'strk20InvokeTransaction').mockImplementation(async () => {
      controller.abort();
      return { transaction_hash: '0xa11' };
    });
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE, signal: controller.signal })).resolves.toEqual({
      transactionHash: '0xa11',
    });
  });

  it('allows exactly one confirmation attempt for a prepared batch', async () => {
    const { ops, wallet } = fixture();
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).resolves.toMatchObject({
      transactionHash: '0x5e1d',
    });
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).rejects.toThrow(/already confirmed/i);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('publishes an immutable private receipt after confirmation', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    const receipt = await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Reflect.set(receipt, 'transactionHash', '0xforged')).toBe(false);
    expect(receipt).toEqual({ transactionHash: '0x5e1d' });
  });

  it('does not let a throwing progress observer interrupt a financial operation', async () => {
    const { ops, wallet } = fixture();
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({
      feeCeiling: POOL_FEE + 2n,
      onProgress: () => { throw new Error('render observer failed'); },
    })).resolves.toMatchObject({ transactionHash: '0x5e1d' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('publishes immutable progress snapshots to observers', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);
    const progress: Array<{ stage: string; message: string }> = [];

    await batch.confirm({
      feeCeiling: POOL_FEE + 2n,
      onProgress(update) { progress.push(update); },
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(Object.isFrozen)).toBe(true);
    const first = progress[0]!;
    const original = { ...first };
    expect(Reflect.set(first, 'stage', 'failed')).toBe(false);
    expect(first).toEqual(original);
  });

  it('does not prove a private transfer discarded from its progress callback', async () => {
    const { ops, wallet, gateway } = fixture();
    const prepareInvoke = vi.spyOn(wallet, 'strk20InvokeTransaction');
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({
      feeCeiling: POOL_FEE + 2n,
      onProgress({ stage }) {
        if (stage === 'proving') batch.discard();
      },
    })).rejects.toMatchObject({ kind: 'unknown' });
    expect(prepareInvoke).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('keeps the wallet hash when the batch is discarded after the wallet submitted it', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({
      feeCeiling: POOL_FEE + 2n,
      onProgress({ stage }) {
        if (stage === 'submitting') batch.discard();
      },
    })).resolves.toEqual({ transactionHash: '0x5e1d' });
  });

  it('rechecks the pool fee and refuses before asking the wallet to prove', async () => {
    const { ops, pool, invoked, gateway } = fixture();
    const batch = await ops.prepare([{ kind: 'unshield', token: TOKEN, amount: 20n, recipient: BOB }]);
    vi.spyOn(pool, 'config').mockResolvedValue({
      feeAmount: POOL_FEE + 5n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10,
    });
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 4n })).rejects.toThrow(/ceiling/i);
    expect(invoked).toHaveLength(0);
    expect(gateway.estimate).not.toHaveBeenCalled();
  });

  it('rejects a mixed public/private batch instead of claiming one result for two transactions', async () => {
    const { ops } = fixture();
    await expect(ops.prepare([
      { kind: 'shield', token: TOKEN, amount: 20n },
      { kind: 'transfer', token: TOKEN, amount: 10n, recipient: BOB },
    ])).rejects.toThrow(/separate/i);
  });

  it('fails closed on disabled or unallowlisted routes', async () => {
    const { ops } = fixture();
    await expect(
      ops.prepare([{ kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 10n, minAmountOut: 1n }]),
    ).rejects.toThrow(/disabled/i);
    await expect(
      ops.prepare([{ kind: 'shield', token: '0xdead', amount: 10n }]),
    ).rejects.toThrow(/allowlisted/i);
  });

  it('does not attach swap review data to a pool-native batch', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    expect(batch.swapReview).toBeUndefined();
  });
});

describe('wallet error mapping', () => {
  it('does not leak a throwing error accessor from wallet failure mapping', () => {
    const error = {};
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('wallet-internal error accessor');
      },
    });

    expect(() => mapWalletError(error)).not.toThrow();
    expect(mapWalletError(error)).toMatchObject({ kind: 'unreachable' });
  });

  it.each([
    [113, 'user-rejected'],
    [118, 'not-registered'],
    [119, 'insufficient-balance'],
    [120, 'privacy-leak'],
    [162, 'unsupported-wallet'],
    [163, 'unknown'],
  ] as const)('maps code %s to %s', (code, kind) => {
    expect(mapWalletError({ code, message: 'wallet error' })).toMatchObject({ kind });
  });

  it('does not remap an existing PrivacyError', () => {
    const error = new PrivacyError('unreachable', 'offline');
    expect(mapWalletError(error)).toBe(error);
  });

  describe('while proving a transfer (D-074)', () => {
    it('maps a 118 to the recipient, keeping the wallet answer as its cause', () => {
      const refusal = { code: 118, message: 'An error occurred (NOT_REGISTERED)' };
      const mapped = mapTransferWalletError(refusal);
      expect(mapped).toMatchObject({
        kind: 'recipient-not-registered',
        message: 'The recipient is not registered with the privacy pool.',
      });
      expect(mapped.cause).toBe(refusal);
      // A code nested under `error`, which `mapWalletError` also reads.
      expect(mapTransferWalletError({ error: refusal })).toMatchObject({ kind: 'recipient-not-registered' });
    });

    it('scopes an already-mapped not-registered too, keeping its original cause', () => {
      const raw = { code: 118 };
      const mapped = mapTransferWalletError(new PrivacyError('not-registered', 'mapped upstream', raw));
      expect(mapped).toMatchObject({ kind: 'recipient-not-registered' });
      expect(mapped.cause).toBe(raw);
    });

    it.each([
      [113, 'user-rejected'],
      [119, 'insufficient-balance'],
      [120, 'privacy-leak'],
      [162, 'unsupported-wallet'],
      [163, 'unknown'],
    ] as const)('maps code %s exactly as any other wallet call does, to %s', (code, kind) => {
      const refusal = { code, message: 'wallet error' };
      expect(mapTransferWalletError(refusal)).toMatchObject({ kind, message: mapWalletError(refusal).message });
    });

    it('passes every other PrivacyError through untouched, and an abort stays a cancellation', () => {
      const error = new PrivacyError('unreachable', 'offline');
      expect(mapTransferWalletError(error)).toBe(error);
      expect(mapTransferWalletError(new DOMException('aborted', 'AbortError'))).toMatchObject({ kind: 'user-rejected' });
    });
  });

  it('never exposes a raw wallet or RPC message to the player', () => {
    const mapped = mapWalletError({ code: 163, message: 'RPC https://secret.example failed with internal trace' });
    expect(mapped.kind).toBe('unknown');
    expect(mapped.message).toBe('The privacy operation failed.');
    expect(mapped.message).not.toContain('secret.example');
  });

  it('maps abort-shaped wallet failures to cancellation rather than an outage', () => {
    expect(mapWalletError(new DOMException('aborted', 'AbortError'))).toMatchObject({
      kind: 'user-rejected',
      message: 'The wallet request was declined.',
    });
  });
});

describe('Wallet API capability versions', () => {
  it('owns supported-version array elements before capability admission', async () => {
    const { wallet, pool, gateway } = fixture();
    const source = ['0.9.0'];
    const reads: PropertyKey[] = [];
    const versions = new Proxy(source, {
      get(target, key, receiver) {
        reads.push(key);
        if (key === '0') return '0.10.3';
        return Reflect.get(target, key, receiver);
      },
    });
    const ops = new WalletApiPrivacyOperations({
      wallet, pool, supportedVersions: async () => versions,
      policy: {
        maxIntents: 8, maxRelayFee: 10n, enabledRoutes: ['transfer'],
        allowedTokens: { shield: [TOKEN], unshield: [TOKEN], transfer: [TOKEN], swap: [TOKEN] },
      },
    });

    await expect(ops.capability()).resolves.toMatchObject({
      supportsStrk20: false,
      walletApiVersion: '0.9.0',
    });
    expect(reads).toEqual(['then']);
  });

  it.each([
    ['null', null],
    ['object', {}],
    ['primitive', 42],
  ] as const)('rejects a non-array %s supported-version response as invalid wallet data', async (_label, response) => {
    const { ops, supportedVersions } = fixture();
    vi.mocked(supportedVersions).mockResolvedValue(response as never);

    await expect(ops.capability()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not treat malformed versions or a 0.10.3 prerelease as stable support', async () => {
    const { wallet, pool, gateway } = fixture();
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
        supportedVersions: async () => ['not-a-version', '0.10.3-rc.1'],
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['transfer'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
      },
    });

    await expect(ops.capability()).resolves.toEqual({
      supportsStrk20: false,
      walletApiVersion: '0.10.3-rc.1',
      registration: 'unknown',
      supportsShadowAccounts: false,
    });
  });

  it('ignores non-string capability versions from the wallet', async () => {
    const { wallet, pool, gateway } = fixture();
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
        supportedVersions: async () => [{ toString: () => '0.10.3' }] as never,
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['shield', 'unshield', 'transfer'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
      },
    });

    await expect(ops.capability()).resolves.toEqual({
      supportsStrk20: false,
      walletApiVersion: null,
      registration: 'unknown',
      supportsShadowAccounts: false,
    });
  });

  it('rejects empty, zero-padded, and malformed semantic-version identifiers', async () => {
    const { wallet, pool, gateway } = fixture();
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
        supportedVersions: async () => ['00.10.3', '0.10.3-alpha..1', '0.10.3-01'],
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['transfer'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
      },
    });

    await expect(ops.capability()).resolves.toEqual({
      supportsStrk20: false,
      walletApiVersion: null,
      registration: 'unknown',
      supportsShadowAccounts: false,
    });
  });
});

describe('the D-072 entry reads', () => {
  const ACCOUNT = '0xabc';
  const POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';
  const DEPOSIT = '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2';
  const HASH = '0x5eed';

  function landedReceipt(account = ACCOUNT, execution = 'SUCCEEDED') {
    return {
      transaction_hash: HASH,
      execution_status: execution,
      finality_status: 'ACCEPTED_ON_L2',
      events: [{ from_address: POOL, keys: [DEPOSIT, account, STRK], data: ['0x1'] }],
    };
  }

  it('asks the wallet once for every shielded token and answers only yes or no', async () => {
    const { ops, wallet } = fixture();
    const balances = vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([
      { token: STRK, balance: '0x0' },
      { token: TOKEN, balance: '0x2a' },
    ]);

    const funded = await ops.hasPrivateFunds();

    expect(funded).toBe(true);
    expect(balances).toHaveBeenCalledOnce();
    expect(balances).toHaveBeenCalledWith([]);
  });

  it('answers no for an empty pool and for every balance at zero', async () => {
    const { ops, wallet } = fixture();
    const balances = vi.spyOn(wallet, 'strk20Balances').mockResolvedValueOnce([]);
    await expect(ops.hasPrivateFunds()).resolves.toBe(false);
    balances.mockResolvedValueOnce([{ token: STRK, balance: '0x0' }, { token: TOKEN, balance: '0x00' }]);
    await expect(ops.hasPrivateFunds()).resolves.toBe(false);
    expect(balances).toHaveBeenCalledTimes(2);
  });

  it('maps a 118 to not-registered and a declined share to user-rejected', async () => {
    const { ops, wallet } = fixture();
    const balances = vi.spyOn(wallet, 'strk20Balances');
    balances.mockRejectedValueOnce({ code: 118, message: 'NOT_REGISTERED' });
    await expect(ops.hasPrivateFunds()).rejects.toMatchObject({ kind: 'not-registered' });
    balances.mockRejectedValueOnce({ code: 113, message: 'USER_REFUSED_OP' });
    await expect(ops.hasPrivateFunds()).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('refuses a malformed balance answer rather than guessing', async () => {
    const { ops, wallet } = fixture();
    vi.spyOn(wallet, 'strk20Balances').mockResolvedValue([{ token: STRK, balance: 'lots' }]);
    await expect(ops.hasPrivateFunds()).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('reads the deposit receipt through the pool client and never the wallet', async () => {
    const { ops, pool, wallet } = fixture();
    const receipt = vi.spyOn(pool, 'receipt').mockResolvedValue(landedReceipt());
    const balances = vi.spyOn(wallet, 'strk20Balances');
    const invoke = vi.spyOn(wallet, 'strk20InvokeTransaction');

    await expect(ops.depositStatus(HASH)).resolves.toBe('landed');
    expect(receipt).toHaveBeenCalledWith(HASH, undefined);
    expect(balances).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('checks the deposit names the connected account, and reports a revert as failed', async () => {
    const { ops, pool } = fixture();
    const receipt = vi.spyOn(pool, 'receipt');
    receipt.mockResolvedValueOnce(landedReceipt('0xdef'));
    await expect(ops.depositStatus(HASH)).resolves.toBe('failed');
    receipt.mockResolvedValueOnce({ ...landedReceipt(), execution_status: 'REVERTED', events: [] });
    await expect(ops.depositStatus(HASH)).resolves.toBe('failed');
  });

  it('treats a receipt the network does not have yet as pending, not failed', async () => {
    const { ops, pool } = fixture();
    const receipt = vi.spyOn(pool, 'receipt');
    // The backend answers a hash its node has not seen with null.
    receipt.mockResolvedValueOnce(null);
    await expect(ops.depositStatus(HASH)).resolves.toBe('pending');
    receipt.mockResolvedValueOnce({ ...landedReceipt(), finality_status: 'PRE_CONFIRMED' });
    await expect(ops.depositStatus(HASH)).resolves.toBe('pending');
  });

  it.each([
    ['a busy service', new PrivacyError('unknown', 'Service is busy. Try again shortly.')],
    ['a failed node read', new PrivacyError('unknown', 'A private service dependency failed.')],
    ['a switched-off service', new PrivacyError('unreachable', 'Private operations are temporarily disabled.')],
    ['a lost connection', new TypeError('Failed to fetch')],
  ])('reports a receipt read that failed on %s as unreachable, never as pending', async (_label, failure) => {
    const { ops, pool } = fixture();
    vi.spyOn(pool, 'receipt').mockRejectedValue(failure);
    await expect(ops.depositStatus(HASH)).rejects.toMatchObject({ kind: 'unreachable', cause: failure });
  });

  it('warns once per shield, in intent order, the contract the shell pairs its figures with', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([
      { kind: 'shield', token: STRK, amount: 5n },
      { kind: 'shield', token: TOKEN, amount: 7n },
    ]);
    expect(batch.intents.map((intent) => intent.kind === 'shield' && intent.amount)).toEqual([5n, 7n]);
    expect(batch.warnings).toEqual([
      { kind: 'public-leg', detail: expect.stringMatching(/^Depositing 5 is public/) },
      { kind: 'public-leg', detail: expect.stringMatching(/^Depositing 7 is public/) },
    ]);
  });

  it('rejects a malformed hash before any read, and a cancelled read as user-rejected', async () => {
    const { ops, pool } = fixture();
    const receipt = vi.spyOn(pool, 'receipt');
    for (const bad of ['', '0x0', 'shield', `0x${'f'.repeat(65)}`]) {
      await expect(ops.depositStatus(bad)).rejects.toMatchObject({ kind: 'unknown' });
    }
    expect(receipt).not.toHaveBeenCalled();

    const controller = new AbortController();
    receipt.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(ops.depositStatus(HASH, controller.signal)).rejects.toMatchObject({ kind: 'user-rejected' });
  });
});
