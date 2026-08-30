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

function fixture() {
  const invoked: STRK20_ACTION[][] = [];
  const prepared: STRK20_ACTION[][] = [];
  const artifact: STRK20_CALL_AND_PROOF = {
    call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
    proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
  };
  const wallet: WalletStrk20Account = {
    address: '0xabc',
    async strk20Balances(tokens) {
      return tokens.map((token) => ({ token, balance: '0x64' }));
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: '0xshield' };
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
  };
  const gateway: PrivateSubmissionGateway = {
    estimate: vi.fn(async () => ({ token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH })),
    submit: vi.fn(async () => ({ transactionHash: '0xprivate' })),
  };
  const supportedVersions = vi.fn(async () => ['0.9.0', '0.10.3']);
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    submission: gateway,
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

describe('WalletApiPrivacyOperations capability and reads', () => {
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
    const ops = new WalletApiPrivacyOperations({ wallet, pool, submission: gateway, supportedVersions, policy });

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

  it.each([
    ['null', null],
    ['missing transaction hash', {}],
    ['non-string transaction hash', { transactionHash: 42 }],
    ['empty transaction hash', { transactionHash: '' }],
  ] as const)('rejects a %s private submission result as invalid service data', async (_label, response) => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.submit).mockResolvedValue(response as never);
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects inherited or accessor-backed private transaction hashes without reading them', async () => {
    const { ops, gateway } = fixture();
    const inherited = Object.create({ transactionHash: '0xforged' });
    const accessor = {} as { transactionHash?: string };
    Object.defineProperty(accessor, 'transactionHash', {
      configurable: true,
      get() { throw new Error('transaction hash getter must not run'); },
    });
    vi.mocked(gateway.submit)
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
    ['negative fee', { feeAmount: -1n }],
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
    expect(submit).not.toHaveBeenCalled();
    expect(prepared).toHaveLength(0);
    expect(progress).not.toContain('awaiting-approval');
  });

  it('does not publish a private batch after its relay estimate is aborted', async () => {
    const { ops, gateway } = fixture();
    let release!: () => void;
    let started!: () => void;
    const estimateStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(gateway.estimate).mockImplementation(async () => {
      started();
      await pending;
      return { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH };
    });
    const controller = new AbortController();
    const preparing = ops.prepare(
      [{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }],
      controller.signal,
    );

    await estimateStarted;
    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    release();

    await expect(preparing).rejects.toMatchObject({ kind: 'user-rejected' });
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
    const { ops, prepared } = fixture();
    await expect(ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: '0x999' },
    ])).rejects.toMatchObject({ kind: 'not-registered' });
    expect(prepared).toHaveLength(0);
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
  it('owns the live relay quote before wallet proof generation', async () => {
    const { ops, wallet, gateway } = fixture();
    const liveFee = { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH };
    vi.mocked(gateway.estimate)
      .mockResolvedValueOnce({ ...liveFee })
      .mockResolvedValueOnce(liveFee);
    vi.spyOn(wallet, 'strk20PrepareInvoke').mockImplementation(async () => {
      liveFee.authorization = 'mutated-auth';
      return {
        call: { contract_address: '0x123', entry_point: 'apply_actions', calldata: ['0x1'] },
        proof: { data: 'proof', output: ['0x1'], proof_facts: ['0x2'] },
      };
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await batch.confirm({ feeCeiling: POOL_FEE + 1n });

    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      feeAuthorization: AUTH.authorization,
    }));
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
      transactionHash: '0xshield',
    });
    expect(invoked).toEqual([[{ type: 'deposit', token: TOKEN, amount: '0x14' }]]);
  });

  it('publishes an immutable shield settlement result', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'shield', token: TOKEN, amount: 20n }]);

    const result = await batch.confirm({ feeCeiling: POOL_FEE });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'transactionHash', '0xforged')).toBe(false);
    expect(result.transactionHash).toBe('0xshield');
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

  it('proves a private transfer once, includes the validated relay fee, and submits the artifact', async () => {
    const { ops, prepared, gateway, artifact } = fixture();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    expect(batch.totalCost).toBe(POOL_FEE + 1n);
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).resolves.toEqual({
      transactionHash: '0xprivate',
    });
    expect(prepared).toEqual([[
      { type: 'transfer', token: TOKEN, amount: '0x14', recipient: BOB },
      { type: 'withdraw', token: STRK, amount: '0x1', recipient: FEE_RECIPIENT },
    ]]);
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'transfer',
        artifact,
        feeAuthorization: AUTH.authorization,
        proofValidityBlocks: 450,
      }),
    );
  });

  it('rejects a whitespace-only relay authorization before a private transfer reaches the wallet', async () => {
    const { ops, gateway, prepared } = fixture();
    vi.mocked(gateway.estimate).mockResolvedValue({
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      authorization: ' \t\n',
      expiresAtBlock: 1_450,
    });

    await expect(ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]))
      .rejects.toThrow(/fee authorization/i);
    expect(prepared).toEqual([]);
  });

  it('preserves non-whitespace relay authorization bytes when validating', async () => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.estimate).mockResolvedValue({
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      authorization: ' fee-auth ',
      expiresAtBlock: 1_450,
    });
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).resolves.toEqual({
      transactionHash: '0xprivate',
    });
    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({ feeAuthorization: ' fee-auth ' }));
  });

  it.each([STRK_DECIMAL, STRK_UPPER_PREFIX])(
    'rejects a noncanonical relay fee token %s before a private transfer reaches the wallet',
    async (token) => {
      const { ops, gateway, prepared } = fixture();
      vi.mocked(gateway.estimate).mockResolvedValue({
        token,
        recipient: FEE_RECIPIENT,
        amount: 1n,
        ...AUTH,
      });

      await expect(ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]))
        .rejects.toThrow(/fee token/i);
      expect(prepared).toEqual([]);
    },
  );

  it('accepts uppercase hex digits in a canonical relay fee token', async () => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.estimate).mockResolvedValue({
      token: STRK_UPPER_HEX,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      ...AUTH,
    });

    await expect(ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]))
      .resolves.toBeDefined();
  });

  it('returns a private receipt when the gateway throws after reporting acceptance', async () => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.submit).mockImplementation(async (input) => {
      input.onAccepted?.({ transactionHash: '0xsettled-private' });
      throw new Error('response stream failed after acceptance');
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).resolves.toEqual({
      transactionHash: '0xsettled-private',
    });
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).rejects.toThrow(/already confirmed/i);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('allows exactly one confirmation attempt for a prepared batch', async () => {
    const { ops, gateway } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).resolves.toMatchObject({
      transactionHash: '0xprivate',
    });
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).rejects.toThrow(/already confirmed/i);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('publishes an immutable private receipt after confirmation', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    const receipt = await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Reflect.set(receipt, 'transactionHash', '0xforged')).toBe(false);
    expect(receipt).toEqual({ transactionHash: '0xprivate' });
  });

  it('keeps an accepted private receipt immutable when response cleanup fails', async () => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.submit).mockImplementation(async (input) => {
      input.onAccepted?.({ transactionHash: '0xsettled-private' });
      throw new Error('response stream failed after acceptance');
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    const receipt = await batch.confirm({ feeCeiling: POOL_FEE + 2n });

    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Reflect.set(receipt, 'transactionHash', '0xforged')).toBe(false);
    expect(receipt).toEqual({ transactionHash: '0xsettled-private' });
  });

  it('keeps the first accepted receipt when the settled result conflicts', async () => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.submit).mockImplementation(async (input) => {
      input.onAccepted?.({ transactionHash: '0xaccepted' });
      return { transactionHash: '0xdifferent' };
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 2n })).resolves.toEqual({
      transactionHash: '0xaccepted',
    });
  });

  it('does not let a throwing progress observer interrupt a financial operation', async () => {
    const { ops, gateway } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({
      feeCeiling: POOL_FEE + 2n,
      onProgress: () => { throw new Error('render observer failed'); },
    })).resolves.toMatchObject({ transactionHash: '0xprivate' });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
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
    const prepareInvoke = vi.spyOn(wallet, 'strk20PrepareInvoke');
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

  it('does not submit a private transfer discarded after proof generation', async () => {
    const { ops, gateway } = fixture();
    const batch = await ops.prepare([
      { kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB },
    ]);

    await expect(batch.confirm({
      feeCeiling: POOL_FEE + 2n,
      onProgress({ stage }) {
        if (stage === 'submitting') batch.discard();
      },
    })).rejects.toMatchObject({ kind: 'unknown' });
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('rechecks fees and refuses before asking the wallet to prove', async () => {
    const { ops, gateway, prepared } = fixture();
    vi.mocked(gateway.estimate)
      .mockResolvedValueOnce({ token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH })
      .mockResolvedValueOnce({ token: STRK, recipient: FEE_RECIPIENT, amount: 9n, ...AUTH });
    const batch = await ops.prepare([{ kind: 'unshield', token: TOKEN, amount: 20n, recipient: BOB }]);
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 5n })).rejects.toThrow(/ceiling/i);
    expect(prepared).toHaveLength(0);
  });

  it('rejects a mixed public/private batch instead of claiming one result for two transactions', async () => {
    const { ops } = fixture();
    await expect(ops.prepare([
      { kind: 'shield', token: TOKEN, amount: 20n },
      { kind: 'transfer', token: TOKEN, amount: 10n, recipient: BOB },
    ])).rejects.toThrow(/separate/i);
  });

  it('fails closed on disabled or malformed relay routes', async () => {
    const { ops, gateway } = fixture();
    vi.mocked(gateway.estimate).mockResolvedValue({
      token: TOKEN,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      ...AUTH,
    });
    await expect(
      ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]),
    ).rejects.toThrow(/fee token/i);
    await expect(
      ops.prepare([{ kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 10n, minAmountOut: 1n }]),
    ).rejects.toThrow(/disabled/i);
    await expect(
      ops.prepare([{ kind: 'shield', token: '0xdead', amount: 10n }]),
    ).rejects.toThrow(/allowlisted/i);
  });

  it('proves the exact quote-bound AVNU plan and submits it without a second wallet signature', async () => {
    const { wallet, pool, gateway, supportedVersions, prepared, artifact } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
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
    const batch = await ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ]);
    expect(batch.swapReview).toEqual({
      expectedAmountOut: 95n,
      minimumAmountOut: 95n,
      slippageBps: 100,
      expiresAt: 2_000,
    });
    expect(batch.intents).toEqual([{
      kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 95n,
    }]);
    expect(Object.keys(batch.swapReview ?? {}).sort()).toEqual([
      'expectedAmountOut',
      'expiresAt',
      'minimumAmountOut',
      'slippageBps',
    ]);
    expect(batch.swapReview).not.toHaveProperty('quoteId');
    expect(batch.swapReview).not.toHaveProperty('executorAddress');
    expect(batch.swapReview).not.toHaveProperty('executorCalls');
    expect(batch.swapReview).not.toHaveProperty('fee');
    const reviewedOutput = batch.swapReview!.expectedAmountOut;
    expect(Object.isFrozen(batch.swapReview)).toBe(true);
    expect(Reflect.set(batch.swapReview!, 'expectedAmountOut', 1n)).toBe(false);
    expect(batch.swapReview!.expectedAmountOut).toBe(reviewedOutput);
    expect(batch.totalCost).toBe(POOL_FEE + 1n);
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).resolves.toEqual({
      transactionHash: '0xprivate',
    });
    // Exact output of the real, unmocked SDK — no arrayContaining, no
    // objectContaining. The invoke payload is recomputed here with the same
    // pinned `starknet` helpers AVNU itself uses, so this pins the algorithm
    // rather than a transcribed literal.
    expect(prepared[0]).toEqual([
      { type: 'withdraw', token: TOKEN, amount: '0x14', recipient: '0x999' },
      { type: 'withdraw', token: STRK, amount: '0x1', recipient: FEE_RECIPIENT },
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: wallet.address },
      {
        type: 'invoke',
        contract: '0x999',
        calldata: [
          STRK,
          ...transaction.fromCallsToExecuteCalldata_cairo1([
            { contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] },
          ]).map((felt) => num.toHex(felt)),
          '${openNoteIds[0]}',
        ],
      },
    ]);
    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      route: 'swap',
      artifact,
      feeAuthorization: AUTH.authorization,
    }));
  });

  it('canonicalizes the protected minimum with exact bigint truncation', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-rounding',
      buyAmount: 101n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
      now: () => 1_000,
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['swap'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
        swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 333 },
      },
    });
    const batch = await ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 1n },
    ]);
    expect(batch.intents[0]).toMatchObject({ minAmountOut: 98n });
    expect(batch.swapReview).toMatchObject({ expectedAmountOut: 101n, minimumAmountOut: 98n, slippageBps: 333 });
    expect(batch.swapReview?.minimumAmountOut).toBe(batch.intents[0]?.kind === 'swap'
      ? batch.intents[0].minAmountOut
      : undefined);
  });

  it('rejects a requested floor above AVNU’s protected minimum', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-floor',
      buyAmount: 101n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
      now: () => 1_000,
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['swap'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
        swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 333 },
      },
    });
    await expect(ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 99n },
    ])).rejects.toThrow(/protected minimum/i);
  });

  it('returns a swap receipt when the gateway throws after reporting acceptance', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    vi.mocked(gateway.submit).mockImplementation(async (input) => {
      input.onAccepted?.({ transactionHash: '0xsettled-swap' });
      throw new Error('response stream failed after acceptance');
    });
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
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
    const batch = await ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).resolves.toEqual({
      transactionHash: '0xsettled-swap',
    });
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toThrow(/already confirmed/i);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale or wrong-chain private swap before proving', async () => {
    const { wallet, pool, gateway, supportedVersions, prepared } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 999,
      chainId: '0x534e5f5345504f4c4941',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
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
    await expect(ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ])).rejects.toThrow(/wrong network/i);
    expect(prepared).toHaveLength(0);
  });

  it('rejects a malformed expected output before returning a swap review', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: Number.NaN as unknown as bigint,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
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
    await expect(ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ])).rejects.toThrow(/expected output/i);
  });

  it('rejects an expired quote before returning a swap review', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 999,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
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
    await expect(ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ])).rejects.toThrow(/expired/i);
  });

  it('rejects an expected output below the typed minimum before returning a review', async () => {
    const { wallet, pool, gateway, supportedVersions } = fixture();
    gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 89n,
      expiresAt: 2_000,
      chainId: '0x534e5f4d41494e',
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions,
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
    await expect(ops.prepare([
      { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
    ])).rejects.toThrow(/minimum output/i);
  });

  it('does not attach swap review data to a pool-native batch', async () => {
    const { ops } = fixture();
    const batch = await ops.prepare([{ kind: 'transfer', token: TOKEN, amount: 20n, recipient: BOB }]);
    expect(batch.swapReview).toBeUndefined();
  });
});

/**
 * The swap route's remaining fail-closed guards.
 *
 * These branches were already implemented but carried no test, while the
 * executor and its serialized calls end up inside proved calldata. WORKPLAN's
 * "Done when" asks for a *tested* allowlisted private route, so each guard is
 * pinned to reject before the wallet is asked to prove anything.
 */
describe('quote-bound swap plan admission', () => {
  it.each([
    ['a number minimum output', 90],
    ['a string minimum output', '90'],
  ] as const)('rejects %s before accepting a swap review', async (_label, minAmountOut) => {
    const { ops } = swapFixture();

    await expect(ops.prepare([{ ...SWAP, minAmountOut } as never]))
      .rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects executor call fields supplied only by the object prototype', async () => {
    const inheritedCall = Object.create({
      contractAddress: '0x111',
      entrypoint: 'swap',
      calldata: ['0xaaa'],
    });
    const { ops } = swapFixture(undefined, { executorCalls: [inheritedCall] });

    await expect(ops.prepare([SWAP])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not invoke an accessor-backed executor call field', async () => {
    const accessorCall = { contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] } as {
      contractAddress: string;
      entrypoint: string;
      calldata: string[];
    };
    Object.defineProperty(accessorCall, 'entrypoint', {
      configurable: true,
      get() { throw new Error('executor call getter must not run'); },
    });
    const { ops } = swapFixture(undefined, { executorCalls: [accessorCall] });

    await expect(ops.prepare([SWAP])).rejects.toMatchObject({ kind: 'unknown' });
  });

  const CHAIN = '0x534e5f4d41494e';
  const MAX_U256 = (1n << 256n) - 1n;
  const SWAP: Intent = { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n };

  it('owns the gateway swap plan before publishing its review', async () => {
    const base = fixture();
    const plan = {
      quoteId: 'quote-owned',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: CHAIN,
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    };
    base.gateway.prepareSwap = vi.fn(async () => plan);
    const ops = new WalletApiPrivacyOperations({
      wallet: base.wallet,
      pool: base.pool,
      submission: base.gateway,
      supportedVersions: base.supportedVersions,
      now: () => 1_000,
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['swap'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
        swap: { expectedChainId: CHAIN, slippageBps: 100 },
      },
    });
    const batch = await ops.prepare([SWAP]);
    plan.executorAddress = '0x888';
    plan.executorCalls[0]!.contractAddress = '0x777';
    plan.fee.authorization = 'mutated-auth';

    await batch.confirm({ feeCeiling: POOL_FEE + 1n });

    expect(base.gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      feeAuthorization: AUTH.authorization,
    }));
    expect(base.prepared[0]?.[0]).toMatchObject({ recipient: '0x999' });
  });

  function swapFixture(
    swapPolicy: unknown = { expectedChainId: CHAIN, slippageBps: 100 },
    planOverrides: Record<string, unknown> = {},
  ) {
    const base = fixture();
    base.gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: CHAIN,
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
      ...planOverrides,
    }) as never);
    const ops = new WalletApiPrivacyOperations({
      wallet: base.wallet,
      pool: base.pool,
      submission: base.gateway,
      supportedVersions: base.supportedVersions,
      now: () => 1_000,
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['swap'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
        ...(swapPolicy === null ? {} : { swap: swapPolicy }),
      } as never,
    });
    return { ...base, ops };
  }

  it('binds a private swap to the account owned at operation construction', async () => {
    const { ops, wallet, prepared } = swapFixture();
    (wallet as { address: string }).address = '0xdef';

    const batch = await ops.prepare([SWAP]);
    await batch.confirm({ feeCeiling: POOL_FEE + 1n });

    expect(prepared[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'transfer', recipient: '0xabc' }),
    ]));
  });

  it('does not hand a discarded swap batch to the wallet after its fee read', async () => {
    const { ops, pool, wallet, gateway } = swapFixture();
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
    const walletPrepare = vi.spyOn(wallet, 'strk20PrepareInvoke');
    const batch = await ops.prepare([SWAP]);

    const confirming = batch.confirm({ feeCeiling: POOL_FEE + 1n });
    await readStarted;
    batch.discard();
    release();

    await expect(confirming).rejects.toThrow(/discarded/i);
    expect(walletPrepare).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('does not hand an aborted swap confirmation to the wallet after its fee read', async () => {
    const { ops, pool, wallet, gateway } = swapFixture();
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
    const walletPrepare = vi.spyOn(wallet, 'strk20PrepareInvoke');
    const submit = vi.spyOn(gateway, 'submit');
    const batch = await ops.prepare([SWAP]);
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
    expect(submit).not.toHaveBeenCalled();
    expect(progress).not.toContain('awaiting-approval');
  });

  it('does not submit a swap quote that expires while the wallet is proving', async () => {
    const base = fixture();
    let now = 1_000;
    base.gateway.prepareSwap = vi.fn(async () => ({
      quoteId: 'quote-1',
      buyAmount: 95n,
      expiresAt: 2_000,
      chainId: CHAIN,
      executorAddress: '0x999',
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0xaaa'] }],
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }));
    vi.spyOn(base.wallet, 'strk20PrepareInvoke').mockImplementation(async () => {
      now = 2_000;
      return base.artifact;
    });
    const ops = new WalletApiPrivacyOperations({
      wallet: base.wallet,
      pool: base.pool,
      submission: base.gateway,
      supportedVersions: base.supportedVersions,
      now: () => now,
      policy: {
        maxIntents: 8,
        maxRelayFee: 10n,
        enabledRoutes: ['swap'],
        allowedTokens: {
          shield: [STRK, TOKEN], unshield: [STRK, TOKEN], transfer: [STRK, TOKEN], swap: [STRK, TOKEN],
        },
        swap: { expectedChainId: CHAIN, slippageBps: 100 },
      },
    });
    const batch = await ops.prepare([SWAP]);

    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).rejects.toThrow(/expired/i);
    expect(base.gateway.submit).not.toHaveBeenCalled();
  });

  it('accepts the maximum uint256 swap output', async () => {
    const { ops } = swapFixture(undefined, { buyAmount: MAX_U256 });

    await expect(ops.prepare([SWAP])).resolves.toBeDefined();
  });

  it('rejects a swap output above uint256 before returning a review', async () => {
    const { ops } = swapFixture(undefined, { buyAmount: MAX_U256 + 1n });

    await expect(ops.prepare([SWAP])).rejects.toThrow(/expected output/i);
  });

  it('rejects inherited swap relay fee fields before returning a review', async () => {
    const inheritedFee = Object.create({
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      ...AUTH,
    });
    const { ops } = swapFixture(undefined, { fee: inheritedFee });

    await expect(ops.prepare([SWAP])).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not publish a swap batch after its quote read is aborted', async () => {
    const { ops, gateway } = swapFixture();
    const originalPrepareSwap = gateway.prepareSwap!;
    let release!: () => void;
    let started!: () => void;
    const quoteStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    gateway.prepareSwap = vi.fn(async (input) => {
      started();
      await pending;
      return originalPrepareSwap(input);
    });
    const controller = new AbortController();
    const preparing = ops.prepare([SWAP], controller.signal);

    await quoteStarted;
    controller.abort(new DOMException('Caller disconnected.', 'AbortError'));
    release();

    await expect(preparing).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('locks the route when the swap policy is absent', async () => {
    const { ops, gateway } = swapFixture(null);
    await expect(ops.prepare([SWAP])).rejects.toThrow(/not configured/i);
    expect(gateway.prepareSwap).not.toHaveBeenCalled();
  });

  it('locks the route when the gateway offers no swap preparation', async () => {
    const { ops, gateway } = swapFixture();
    delete (gateway as { prepareSwap?: unknown }).prepareSwap;
    await expect(ops.prepare([SWAP])).rejects.toThrow(/not configured/i);
  });

  it.each([[0], [-100], [1.5]])(
    'rejects a configured slippage of %s before requesting a quote',
    async (slippageBps) => {
      const { ops, gateway } = swapFixture({ expectedChainId: CHAIN, slippageBps });
      await expect(ops.prepare([SWAP])).rejects.toThrow(/slippage/i);
      expect(gateway.prepareSwap).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['no executor calls', { executorCalls: [] }, /executor calls/i],
    ['a non-array executor call container', { executorCalls: null }, /executor calls/i],
    ['a call with a non-array calldata container', {
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: null }],
    }, /malformed executor calls/i],
    ['a zero call target', {
      executorCalls: [{ contractAddress: '0x0', entrypoint: 'swap', calldata: [] }],
    }, /call target/i],
    ['an unnamed entry point', {
      executorCalls: [{ contractAddress: '0x111', entrypoint: '', calldata: [] }],
    }, /malformed executor calls/i],
    ['a whitespace-only entry point', {
      executorCalls: [{ contractAddress: '0x111', entrypoint: ' \t\n', calldata: [] }],
    }, /malformed executor calls/i],
    ['a non-string entry point', {
      executorCalls: [{ contractAddress: '0x111', entrypoint: 7, calldata: [] }],
    }, /malformed executor calls/i],
    ['non-felt call data', {
      executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['not-a-felt'] }],
    }, /malformed executor calls/i],
    ['a relay fee above the route ceiling', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 11n, ...AUTH },
    }, /route policy/i],
    ['a nonpositive relay fee', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 0n, ...AUTH },
    }, /route policy/i],
    ['a string relay fee amount', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: '1', ...AUTH },
    }, /route policy/i],
    ['a numeric relay fee amount', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1, ...AUTH },
    }, /route policy/i],
    ['a coercible relay fee amount', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: { valueOf: (): bigint => 1n }, ...AUTH },
    }, /route policy/i],
    ['a zero fee recipient', {
      fee: { token: STRK, recipient: '0x0', amount: 1n, ...AUTH },
    }, /fee recipient/i],
    ['an unsigned relay fee', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, authorization: '', expiresAtBlock: 1_450 },
    }, /fee authorization/i],
    ['a whitespace-only relay fee authorization', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, authorization: ' \t\n', expiresAtBlock: 1_450 },
    }, /fee authorization/i],
    ['a decimal relay fee token', {
      fee: { token: STRK_DECIMAL, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }, /fee token/i],
    ['an uppercase-prefix relay fee token', {
      fee: { token: STRK_UPPER_PREFIX, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }, /fee token/i],
    ['a coercible object relay fee token', {
      fee: { token: { toString: (): string => STRK }, recipient: FEE_RECIPIENT, amount: 1n, ...AUTH },
    }, /fee token/i],
    ['an unbounded relay fee', {
      fee: { token: STRK, recipient: FEE_RECIPIENT, amount: 1n, authorization: 'fee-auth', expiresAtBlock: 0 },
    }, /fee authorization/i],
    ['a zero executor', { executorAddress: '0x0' }, /executor/i],
  ])('rejects a quote-bound plan with %s before proving', async (_label, overrides, message) => {
    const { ops, prepared } = swapFixture({ expectedChainId: CHAIN, slippageBps: 100 }, overrides);
    await expect(ops.prepare([SWAP])).rejects.toThrow(message);
    expect(prepared).toEqual([]);
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
      submission: gateway,
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
    });
  });

  it('ignores non-string capability versions from the wallet', async () => {
    const { wallet, pool, gateway } = fixture();
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
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
    });
  });

  it('rejects empty, zero-padded, and malformed semantic-version identifiers', async () => {
    const { wallet, pool, gateway } = fixture();
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
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
    });
  });
});
