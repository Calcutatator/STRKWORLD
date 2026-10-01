import { describe, expect, it } from 'vitest';
import {
  AVNU_EXCHANGE,
  MAX_SWAP_CALLDATA,
  SWAP_DAPP_NAME,
  SWAP_QUOTE_TTL_MS,
  ownSwapQuote,
  swapActions,
  type SwapQuoteRequest,
} from './swap.js';
import { SWAP_TEST_ROUTE_EXCHANGE, SWAP_TEST_SHADOW, avnuAnswer } from './testing/swap-quotes.js';
import { BORROW_DAPP_NAME } from './borrow.js';
import { VAULT_DAPP_NAME } from './vault.js';

/**
 * The shadow-account swap's pure half (D-084): owning avnu's quote against
 * the request it answers, and the exact actions the wallet proves.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const PLAYER = '0xabc';
const NOW = 1_000_000;
const hex = (value: string) => `0x${BigInt(value).toString(16)}`;

const REQUEST: SwapQuoteRequest = Object.freeze({
  sellToken: STRK,
  buyToken: USDC,
  sellAmount: 10n ** 19n,
  taker: SWAP_TEST_SHADOW,
  slippageBps: 100,
});

/** avnu's answer for REQUEST with 431,000 base units out, as a plain mutable copy. */
function answer(buyAmount = 431_000n): { -readonly [K in keyof ReturnType<typeof avnuAnswer>]: unknown } & { calls: Array<{ contractAddress: string; entrypoint: string; calldata: string[] }> } {
  const built = avnuAnswer({ ...REQUEST }, buyAmount);
  return {
    ...built,
    calls: built.calls.map((call) => ({ ...call, calldata: [...call.calldata] })),
  } as never;
}

describe('ownSwapQuote', () => {
  it('owns a well-formed quote: the floor is the protected minimum, and the quote stands for the TTL', () => {
    const quote = ownSwapQuote(answer(), REQUEST, NOW);
    expect(quote).toEqual({
      quoteId: 'quote-1',
      sellToken: hex(STRK),
      buyToken: hex(USDC),
      sellAmount: 10n ** 19n,
      buyAmount: 431_000n,
      // 431,000 less 1%: exact bigint truncation, avnu's own formula.
      minAmountOut: 426_690n,
      slippageBps: 100,
      taker: hex(SWAP_TEST_SHADOW),
      routes: ['0x1', hex(STRK), hex(USDC), SWAP_TEST_ROUTE_EXCHANGE, '0xe8d4a51000', '0x1', '0x1'],
      expiresAt: NOW + SWAP_QUOTE_TTL_MS,
    });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.routes)).toBe(true);
  });

  it('sets its own floor, the protected minimum with exact truncation, whatever floor avnu built', () => {
    expect(ownSwapQuote(answer(99n), REQUEST, NOW).minAmountOut).toBe(99n);
    const halfPercent = { ...REQUEST, slippageBps: 50 };
    expect(ownSwapQuote(avnuAnswer(halfPercent, 10_001n), halfPercent, NOW).minAmountOut).toBe(9_951n);
    // avnu's live build of 2026-10-01: 430,588 out at 1% carried a floor of
    // 426,282 (it rounds the slippage up); the protected minimum is 426,283.
    const live = answer(430_588n);
    live.calls[0]!.calldata[6] = '0x6812a';
    expect(ownSwapQuote(live, REQUEST, NOW).minAmountOut).toBe(426_283n);
    const stricter = answer(10_000n);
    stricter.calls[0]!.calldata[6] = '0x26fc';
    expect(ownSwapQuote(stricter, REQUEST, NOW).minAmountOut).toBe(9_900n);
  });

  type Mutation = (value: ReturnType<typeof answer>) => void;
  it.each<[string, Mutation]>([
    ['a missing quote id', (value) => { value.quoteId = ''; }],
    ['a quote id with odd characters', (value) => { value.quoteId = 'quote 1'; }],
    ['another chain', (value) => { value.chainId = '0x534e5f5345504f4c4941'; }],
    ['another sell token', (value) => { value.sellToken = USDC; }],
    ['another buy token', (value) => { value.buyToken = STRK; }],
    ['another sell amount', (value) => { value.sellAmount = 1n; }],
    ['a zero buy amount', (value) => { value.buyAmount = 0n; }],
    ['a buy amount no pool note can hold', (value) => { value.buyAmount = 1n << 128n; }],
    ['a string buy amount', (value) => { value.buyAmount = '431000'; }],
    ['two calls', (value) => { value.calls.push({ ...value.calls[0]!, calldata: [...value.calls[0]!.calldata] }); }],
    ['no call', (value) => { value.calls.length = 0; }],
    ['another exchange', (value) => { value.calls[0]!.contractAddress = '0x123'; }],
    ['another entry point', (value) => { value.calls[0]!.entrypoint = 'swap_exact_token_to'; }],
    ['calldata naming another sell token', (value) => { value.calls[0]!.calldata[0] = USDC; }],
    ['calldata selling another amount', (value) => { value.calls[0]!.calldata[1] = '0x1'; }],
    ['calldata buying another token', (value) => { value.calls[0]!.calldata[3] = STRK; }],
    ['calldata expecting another amount', (value) => { value.calls[0]!.calldata[4] = '0x1'; }],
    ['a zero floor', (value) => { value.calls[0]!.calldata[6] = '0x0'; }],
    ['a floor above the expected output', (value) => { value.calls[0]!.calldata[6] = '0xfffff'; }],
    ['a floor with a high word', (value) => { value.calls[0]!.calldata[7] = '0x1'; }],
    ['another beneficiary', (value) => { value.calls[0]!.calldata[8] = PLAYER; }],
    ['an integrator fee', (value) => { value.calls[0]!.calldata[9] = '0xa'; }],
    ['an integrator fee recipient', (value) => { value.calls[0]!.calldata[10] = '0x99'; }],
    ['no routes', (value) => { value.calls[0]!.calldata.splice(11); value.calls[0]!.calldata.push('0x0'); }],
    ['a route from another token', (value) => { value.calls[0]!.calldata[12] = USDC; }],
    ['a non-felt calldata item', (value) => { value.calls[0]!.calldata[14] = 'route'; }],
    ['a felt above the field', (value) => { value.calls[0]!.calldata[14] = `0x${(1n << 252n).toString(16)}`; }],
    ['calldata past the bound', (value) => {
      value.calls[0]!.calldata.push(...Array.from({ length: MAX_SWAP_CALLDATA }, () => '0x1'));
    }],
    ['a sparse calldata array', (value) => { value.calls[0]!.calldata = new Array(20); }],
  ])('rejects a quote with %s', (_label, mutate) => {
    const value = answer();
    mutate(value);
    expect(() => ownSwapQuote(value, REQUEST, NOW)).toThrow(expect.objectContaining({ kind: 'unknown' }));
  });

  it('rejects a quote for a taker other than the stand-in it asked for', () => {
    expect(() => ownSwapQuote(answer(), { ...REQUEST, taker: '0x5ad0' }, NOW))
      .toThrow(expect.objectContaining({ kind: 'unknown' }));
  });

  it('reads no accessor and no inherited field', () => {
    let read = false;
    const value = answer();
    Object.defineProperty(value, 'quoteId', { get() { read = true; return 'quote-1'; } });
    expect(() => ownSwapQuote(value, REQUEST, NOW)).toThrow();
    expect(read).toBe(false);
    const inherited = Object.create(answer()) as object;
    expect(() => ownSwapQuote(inherited, REQUEST, NOW)).toThrow();
  });

  it('refuses a broken clock', () => {
    expect(() => ownSwapQuote(answer(), REQUEST, Number.NaN)).toThrow(/clock/);
  });
});

describe('swapActions', () => {
  it('builds the exact shadow-account swap: withdraw to the stand-in, open the output note, approve and swap, collect the gain', () => {
    const quote = ownSwapQuote(answer(), REQUEST, NOW);
    const shadow = hex(SWAP_TEST_SHADOW);
    const exchange = hex(AVNU_EXCHANGE);
    expect(swapActions({ quote, shadowAccount: SWAP_TEST_SHADOW, player: PLAYER })).toEqual([
      { type: 'withdraw', token: hex(STRK), amount: '0x8ac7230489e80000', recipient: shadow },
      { type: 'transfer', token: hex(USDC), amount: 'OPEN', recipient: PLAYER },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-swap',
        nonce: '0x0',
        calls: [
          // Exactly the sell amount: the exchange pulls all of it or reverts.
          { contractAddress: hex(STRK), entrypoint: 'approve', calldata: [exchange, '0x8ac7230489e80000', '0x0'] },
          {
            contractAddress: exchange,
            entrypoint: 'multi_route_swap',
            calldata: [
              hex(STRK), '0x8ac7230489e80000', '0x0',
              hex(USDC), '0x69398', '0x0',
              '0x682c2', '0x0',
              shadow, '0x0', '0x0',
              '0x1', hex(STRK), hex(USDC), SWAP_TEST_ROUTE_EXCHANGE, '0xe8d4a51000', '0x1', '0x1',
            ],
          },
        ],
        collect_policy: { type: 'diff' },
      },
    ]);
  });

  it('opens one note only, for the bought token: a second, empty note would make the anonymizer revert', () => {
    const quote = ownSwapQuote(answer(), REQUEST, NOW);
    const actions = swapActions({ quote, shadowAccount: SWAP_TEST_SHADOW, player: PLAYER });
    expect(actions.filter((action) => action.type === 'transfer')).toHaveLength(1);
    expect(actions.filter((action) => action.type === 'shadow_account_invoke')).toHaveLength(1);
  });

  it('uses its own dapp name, never the Vault\'s or the Borrow counter\'s, so each sits on its own stand-in', () => {
    expect(SWAP_DAPP_NAME).toBe('strkworld-swap');
    expect(SWAP_DAPP_NAME).not.toBe(VAULT_DAPP_NAME);
    expect(SWAP_DAPP_NAME).not.toBe(BORROW_DAPP_NAME);
  });

  it('refuses to build for a stand-in other than the quote\'s taker', () => {
    const quote = ownSwapQuote(answer(), REQUEST, NOW);
    expect(() => swapActions({ quote, shadowAccount: '0x5ad0', player: PLAYER })).toThrow(/stand-in/);
  });
});
