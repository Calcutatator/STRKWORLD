import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION, STRK20_CALL_AND_PROOF } from 'starknet';
import {
  PrivacyError,
  WalletApiPrivacyOperations,
  mapWalletError,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type WalletStrk20Account,
} from '../index.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TOKEN = '0x123';
const BOB = '0x456';
const FEE_RECIPIENT = '0x789';
const POOL_FEE = 6n * 10n ** 18n;
const AUTH = { authorization: 'fee-auth', expiresAtBlock: 1_450 };

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

  it('marks the maturity split unknown because the Wallet API returns only an aggregate', async () => {
    const { ops } = fixture();
    await expect(ops.balances([TOKEN])).resolves.toEqual([
      { token: TOKEN, total: 100n, spendable: 0n, maturing: 0n, maturityKnown: false },
    ]);
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
});

describe('Wallet API action routes', () => {
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
    expect(batch.totalCost).toBe(POOL_FEE + 1n);
    await expect(batch.confirm({ feeCeiling: POOL_FEE + 1n })).resolves.toEqual({
      transactionHash: '0xprivate',
    });
    expect(prepared[0]).toEqual([
      { type: 'withdraw', token: TOKEN, amount: '0x14', recipient: '0x999' },
      { type: 'withdraw', token: STRK, amount: '0x1', recipient: FEE_RECIPIENT },
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: wallet.address },
      expect.objectContaining({
        type: 'invoke',
        contract: '0x999',
        calldata: expect.arrayContaining([STRK, '0x111', '0xaaa', '${openNoteIds[0]}']),
      }),
    ]);
    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      route: 'swap',
      artifact,
      feeAuthorization: AUTH.authorization,
    }));
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
});

describe('wallet error mapping', () => {
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
