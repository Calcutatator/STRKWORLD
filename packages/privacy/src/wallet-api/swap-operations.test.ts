import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import { WalletApiPrivacyOperations, type Intent, type PoolReadClient, type WalletRoutePolicy, type WalletStrk20Account } from '../index.js';
import { SWAP_QUOTE_TTL_MS } from '../swap.js';
import { SWAP_TEST_PARTIAL, SWAP_TEST_SHADOW, swapTestPrices, swapTestQuotes, swapTestReads } from '../testing/swap-quotes.js';
import { SWAP_FLOOR_MOVED_MESSAGE, SWAP_UNCHECKED_PRICE_MESSAGE } from './swap-operations.js';
import type { SwapPriceReader } from './types.js';

/**
 * The shadow-account swap through the Wallet API seam (D-084): the stand-in
 * resolved as the Vault resolves one, avnu's keyless quote owned before the
 * review, the wallet proving and submitting, and a stale quote asked for
 * again before the wallet is.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const DEGEN = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
const PLAYER = '0xabc';
const POOL_FEE = 6n * 10n ** 18n;
const SWAP: Intent = { kind: 'swap', tokenIn: STRK, tokenOut: USDC, amountIn: 10n ** 19n, minAmountOut: 1n };

function policy(overrides: Partial<NonNullable<WalletRoutePolicy['swap']>> = {}): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 0n,
    enabledRoutes: ['swap'],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [STRK, USDC] },
    swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 100, ...overrides },
  };
}

function seam(options: {
  buyAmounts?: readonly bigint[];
  edit?: Parameters<typeof swapTestQuotes>[1];
  versions?: readonly string[];
  standIn?: string;
  policy?: WalletRoutePolicy;
  invoke?: (actions: STRK20_ACTION[]) => Promise<{ transaction_hash: string }>;
  prices?: SwapPriceReader | null;
} = {}) {
  let clock = 1_000_000;
  const invoked: STRK20_ACTION[][] = [];
  const commitments: string[] = [];
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    async strk20Balances() { return []; },
    async strk20PrepareInvoke() { throw new Error('a swap is never proved for a relay'); },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return options.invoke ? options.invoke(actions) : { transaction_hash: '0x5a9' };
    },
    async strk20ShadowAccountCommitment(dappName) {
      commitments.push(dappName);
      return SWAP_TEST_PARTIAL;
    },
  };
  const pool: PoolReadClient = {
    config: vi.fn(async () => ({ feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 })),
    async publicKey() { return '0x0'; },
    async receipt() { throw new Error('a swap waits for no receipt here'); },
  };
  const quotes = swapTestQuotes(options.buyAmounts ?? [431_000n], options.edit);
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    swapQuotes: quotes,
    ...(options.prices === null ? {} : { swapPrices: options.prices ?? swapTestPrices(1_000_000) }),
    vault: swapTestReads(options.standIn),
    supportedVersions: async () => [...(options.versions ?? ['0.10.4'])],
    policy: options.policy ?? policy(),
    now: () => clock,
  });
  return {
    ops, pool, quotes, invoked, commitments,
    advance(ms: number) { clock += ms; },
  };
}

describe('preparing a shadow-account swap', () => {
  it('reviews avnu\'s quote for the stand-in: expected output, the protected floor, no relay cost', async () => {
    const { ops, quotes, commitments } = seam();
    const batch = await ops.prepare([SWAP]);

    expect(commitments).toEqual(['strkworld-swap']);
    expect(quotes.requests).toEqual([{
      sellToken: STRK, buyToken: USDC, sellAmount: 10n ** 19n, taker: `0x${BigInt(SWAP_TEST_SHADOW).toString(16)}`, slippageBps: 100,
    }]);
    expect(batch.swapReview).toEqual({
      expectedAmountOut: 431_000n,
      minimumAmountOut: 426_690n,
      slippageBps: 100,
      expiresAt: 1_000_000 + SWAP_QUOTE_TTL_MS,
      // 10 STRK at $0.0431 and 0.431 USDC at $1: exactly the oracle value.
      priceCheck: { status: 'checked', boundBps: 300, sellUsd: 43_100_000n, expectedBuyUsd: 43_100_000n, shortfallBps: 0 },
    });
    // The published intent carries the floor the chain enforces.
    expect(batch.intents).toEqual([{ ...SWAP, minAmountOut: 426_690n }]);
    expect(batch.gasEstimate).toBe(0n);
    expect(batch.totalCost).toBe(POOL_FEE);
    expect(batch.promptCount).toBe(1);
    expect(Object.isFrozen(batch.swapReview)).toBe(true);
  });

  it('quotes at the player\'s own slippage, at or below the build\'s ceiling (D-089)', async () => {
    const { ops, quotes } = seam();
    const batch = await ops.prepare([{ ...SWAP, slippageBps: 50 }]);

    expect(quotes.requests.map((request) => request.slippageBps)).toEqual([50]);
    // 431,000 less 0.5%, floored.
    expect(batch.swapReview).toMatchObject({ slippageBps: 50, minimumAmountOut: 428_845n });
    expect(batch.intents).toEqual([{ ...SWAP, slippageBps: 50, minAmountOut: 428_845n }]);
  });

  it.each([
    ['above the build\'s ceiling', 101],
    ['zero', 0],
    ['fractional', 12.5],
    ['not a number', '50'],
  ])('refuses a player slippage %s before anything is asked', async (_label, slippageBps) => {
    const { ops, quotes, commitments } = seam();
    await expect(ops.prepare([{ ...SWAP, slippageBps } as unknown as Intent])).rejects.toThrow(/slippage is outside/);
    expect(quotes.requests).toEqual([]);
    expect(commitments).toEqual([]);
  });

  it('refuses a requested floor above the quote\'s protected minimum', async () => {
    const { ops, invoked } = seam();
    await expect(ops.prepare([{ ...SWAP, minAmountOut: 426_691n }])).rejects.toThrow(/protected minimum/);
    expect(invoked).toEqual([]);
  });

  it.each([
    ['another taker', (answer: { calls: Array<{ calldata: string[] }> }) => {
      answer.calls[0]!.calldata[8] = PLAYER;
      return answer;
    }],
    ['another bought token', (answer: Record<string, unknown>) => ({ ...answer, buyToken: STRK })],
    ['a malformed body', () => ({ quoteId: 'quote-1' })],
  ])('refuses a quote naming %s before the player sees a price', async (_label, edit) => {
    const { ops, invoked } = seam({ edit: edit as never });
    await expect(ops.prepare([SWAP])).rejects.toMatchObject({ kind: 'unknown' });
    expect(invoked).toEqual([]);
  });

  it('fails closed when the backend names a stand-in the anonymizer would not derive', async () => {
    const { ops, quotes } = seam({ standIn: '0x5ad0' });
    await expect(ops.prepare([SWAP])).rejects.toThrow(/could not verify its stand-in address/);
    expect(quotes.requests).toEqual([]);
  });

  it('is shadow-accounts-unsupported on a wallet below Wallet API 0.10.4, and asks avnu nothing', async () => {
    const { ops, quotes } = seam({ versions: ['0.10.3'] });
    await expect(ops.prepare([SWAP])).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
    expect(quotes.requests).toEqual([]);
  });

  it('admits only the static allowlist unless the degen floor is on', async () => {
    const closed = seam();
    await expect(closed.ops.prepare([{ ...SWAP, tokenOut: DEGEN }])).rejects.toThrow(/not allowlisted/);
    expect(closed.quotes.requests).toEqual([]);

    const degen = seam({ policy: policy({ degen: true }) });
    await expect(degen.ops.prepare([{ ...SWAP, tokenOut: '0x0666' }])).resolves.toMatchObject({
      swapReview: { expectedAmountOut: 431_000n },
    });
    expect(degen.quotes.requests[0]).toMatchObject({ buyToken: '0x0666' });

  });

  it('refuses a policy slippage above the 3% cap before asking avnu (D-084)', async () => {
    const { ops, quotes } = seam({ policy: policy({ slippageBps: 301 }) });
    await expect(ops.prepare([SWAP])).rejects.toThrow(/slippage policy is invalid/);
    expect(quotes.requests).toEqual([]);
  });

  it('refuses a swap of a token for itself', async () => {
    const { ops, quotes } = seam();
    await expect(ops.prepare([{ ...SWAP, tokenOut: STRK }])).rejects.toThrow(/two different tokens/);
    expect(quotes.requests).toEqual([]);
  });

  it('fails closed without a quote client', async () => {
    const wallet = {
      address: PLAYER,
      async strk20Balances() { return []; },
      async strk20PrepareInvoke(): Promise<never> { throw new Error('unused'); },
      async strk20InvokeTransaction() { return { transaction_hash: '0x1' }; },
      async strk20ShadowAccountCommitment() { return SWAP_TEST_PARTIAL; },
    };
    const { pool } = seam();
    const ops = new WalletApiPrivacyOperations({
      wallet, pool, vault: swapTestReads(), supportedVersions: async () => ['0.10.4'], policy: policy(),
    });
    await expect(ops.prepare([SWAP])).rejects.toThrow(/quotes are not configured/);
  });
});

describe('confirming a shadow-account swap', () => {
  it('has the wallet prove and submit the reviewed actions, once', async () => {
    const { ops, invoked, quotes } = seam();
    const batch = await ops.prepare([SWAP]);
    const stages: string[] = [];

    await expect(batch.confirm({ feeCeiling: POOL_FEE, onProgress: ({ stage }) => stages.push(stage) }))
      .resolves.toEqual({ transactionHash: '0x5a9' });
    expect(stages).toEqual(['awaiting-approval', 'proving', 'submitting', 'done']);
    expect(quotes.requests).toHaveLength(1);
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.map((action) => action.type)).toEqual(['withdraw', 'transfer', 'shadow_account_invoke']);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/already confirmed/);
  });

  it('holds a pool fee above the ceiling before the wallet is asked', async () => {
    const { ops, pool, invoked } = seam();
    const batch = await ops.prepare([SWAP]);
    vi.mocked(pool.config).mockResolvedValueOnce({ feeAmount: POOL_FEE + 1n, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 });
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/above the ceiling/);
    expect(invoked).toEqual([]);
  });

  it('re-quotes an expired quote before the wallet prompt and goes ahead when the floor holds', async () => {
    const { ops, invoked, quotes, advance } = seam({ buyAmounts: [431_000n, 440_000n] });
    const batch = await ops.prepare([SWAP]);
    advance(SWAP_QUOTE_TTL_MS);

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).resolves.toEqual({ transactionHash: '0x5a9' });
    expect(quotes.requests).toHaveLength(2);
    const swap = invoked[0]![2] as Extract<STRK20_ACTION, { type: 'shadow_account_invoke' }>;
    // The fresh quote's own amounts: 440,000 out, floor 435,600.
    expect((swap.calls[1]!.calldata as string[]).slice(4, 8)).toEqual(['0x6b6c0', '0x0', '0x6a590', '0x0']);
  });

  it('stops with nothing sent when the re-quote would lower the reviewed floor', async () => {
    // 428,000 is within the oracle bound, but its floor (423,720) is below the reviewed 426,690.
    const { ops, invoked, advance } = seam({ buyAmounts: [431_000n, 428_000n] });
    const batch = await ops.prepare([SWAP]);
    advance(SWAP_QUOTE_TTL_MS + 1);

    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({
      kind: 'unknown', message: SWAP_FLOOR_MOVED_MESSAGE,
    });
    expect(invoked).toEqual([]);
  });

  it('does not re-quote a quote still fresh at confirmation', async () => {
    const { ops, quotes, advance } = seam();
    const batch = await ops.prepare([SWAP]);
    advance(SWAP_QUOTE_TTL_MS - 1);
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(quotes.requests).toHaveLength(1);
  });

  it('maps a wallet that cannot run the shadow-account action to shadow-accounts-unsupported, not a closed city', async () => {
    const { ops } = seam({ invoke: async () => { throw Object.assign(new Error('unsupported'), { code: 162 }); } });
    const batch = await ops.prepare([SWAP]);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
  });

  it('keeps a rejection the player made in the wallet as user-rejected', async () => {
    const { ops } = seam({ invoke: async () => { throw Object.assign(new Error('rejected'), { code: 113 }); } });
    const batch = await ops.prepare([SWAP]);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('does not hand a discarded batch to the wallet', async () => {
    const { ops, invoked } = seam();
    const batch = await ops.prepare([SWAP]);
    batch.discard();
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/discarded/);
    expect(invoked).toEqual([]);
  });

  it('asks the wallet for the commitment once per connection', async () => {
    const { ops, commitments } = seam();
    await ops.prepare([SWAP]);
    await ops.prepare([SWAP]);
    expect(commitments).toEqual(['strkworld-swap']);
  });
});

describe('the independent price check (D-084)', () => {
  it('refuses a quote worth more than 3% less than the oracle says, before the player sees it', async () => {
    const { ops, invoked } = seam({ buyAmounts: [400_000n] });
    await expect(ops.prepare([SWAP])).rejects.toThrow(/7\.19% below the oracle price/);
    expect(invoked).toEqual([]);
  });

  it('accepts a quote within the bound, and reports how far below the oracle it sits', async () => {
    const { ops } = seam({ buyAmounts: [420_000n] });
    const batch = await ops.prepare([SWAP]);
    expect(batch.swapReview?.priceCheck).toMatchObject({ status: 'checked', shortfallBps: 255, boundBps: 300 });
  });

  it('refuses when a pinned feed is missing, stale or thinly sourced, never leaving it unchecked', async () => {
    for (const override of [null, { updatedAt: 1_000 - 1_801 }, { sources: 2 }, { price: 0n }]) {
      const { ops } = seam({ prices: swapTestPrices(1_000_000, { 'USDC/USD': override }) });
      await expect(ops.prepare([SWAP]), JSON.stringify(override, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
        .rejects.toThrow(/USDC\/USD is missing or stale/);
    }
  });

  it('refuses as unreachable when the oracle cannot be read for a pair it prices, and fails closed without a reader', async () => {
    const down = seam({ prices: { async read() { throw new Error('rpc down'); } } });
    await expect(down.ops.prepare([SWAP])).rejects.toMatchObject({ kind: 'unreachable' });
    const none = seam({ prices: null });
    await expect(none.ops.prepare([SWAP])).rejects.toThrow(/price reference is not configured/);
  });

  it('reviews a pair with no oracle price as unchecked, and confirms it only with the acknowledgement', async () => {
    const unpriced = seam({ policy: policy({ degen: true }) });
    const blind = await unpriced.ops.prepare([{ ...SWAP, tokenOut: '0x0666' }]);
    expect(blind.swapReview?.priceCheck).toEqual({ status: 'unchecked', boundBps: 300, sellUsd: 43_100_000n });
    await expect(blind.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(SWAP_UNCHECKED_PRICE_MESSAGE);
    expect(unpriced.invoked).toEqual([]);
    // The refusal did not spend the batch's one attempt.
    await expect(blind.confirm({ feeCeiling: POOL_FEE, acknowledgeUncheckedPrice: true })).resolves.toEqual({ transactionHash: '0x5a9' });
    expect(unpriced.invoked).toHaveLength(1);
  });

  it('checks a degen token that has a feed, such as LORDS, like any other', async () => {
    // 10 STRK ($0.431) for 21.5 LORDS at $0.02: within the bound.
    const { ops } = seam({ policy: policy({ degen: true }), buyAmounts: [215n * 10n ** 17n] });
    const batch = await ops.prepare([{ ...SWAP, tokenOut: DEGEN }]);
    expect(batch.swapReview?.priceCheck).toMatchObject({ status: 'checked', shortfallBps: 23 });
  });

  it('holds a re-quote at confirmation to the same oracle check', async () => {
    const { ops, invoked, advance } = seam({ buyAmounts: [431_000n, 431_000n * 9n / 10n] });
    const batch = await ops.prepare([SWAP]);
    advance(SWAP_QUOTE_TTL_MS);
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toThrow(/below the oracle price/);
    expect(invoked).toEqual([]);
  });
});
