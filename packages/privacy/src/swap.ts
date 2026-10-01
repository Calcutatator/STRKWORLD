import type { STRK20_ACTION } from 'starknet';
import { protectedMinimumOut } from './protected-minimum.js';
import { PrivacyError, type Address } from './types.js';
import { VAULT_SHADOW_NONCE, isContractAddress } from './vault.js';

/**
 * The private swap on a shadow account (D-084): the Exchange and the degen
 * floor trade through the player's STRK20 shadow account for `SWAP_DAPP_NAME`,
 * against avnu's public exchange contract, with a quote from avnu's public,
 * keyless swap API. No avnu key, no paymaster and no STRKWORLD relay: the
 * wallet proves and submits, as it does the Vault (D-077) and every pool
 * spend (D-082).
 *
 * Protocol constants, not configuration, like `vault.ts`. The shell never
 * supplies a target, selector or calldata (D-018): this file pins the
 * exchange, the entry point and the dapp name, builds the approve and the
 * swap's fixed head itself, and takes only avnu's route encoding from the
 * quote, after checking every field it can. Mainnet only (D-001).
 */

/**
 * avnu's exchange contract (`AVNU_EXCHANGE` in avnu's own SDK, and the
 * contract its public `/swap/v3/build` endpoint targets). Read over mainnet
 * RPC at block 15,726,513, 2026-10-01: class
 * `0x2ce861096e127f07859a9377472eb4855853b544422d1860e449dcb2ea7d236`, whose
 * ABI declares `multi_route_swap` exactly as `AVNU_EXCHANGE_SWAP_SHAPE` says
 * (D-084). Its source (avnu-labs/avnu-contracts-v2, `exchange.cairo`) checks
 * only that the beneficiary is the caller and pulls exactly the sell amount
 * with `transferFrom`; it asks the caller for no signature, so a keyless
 * shadow account can call it. avnu's own `PrivacySwapHelper`, a contract
 * with no account entry points, swapped through it at block 15,724,143.
 */
export const AVNU_EXCHANGE =
  '0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f';

/** The exchange's class at the D-084 read. It is upgradeable by its owner; see D-084. */
export const AVNU_EXCHANGE_CLASS_HASH =
  '0x2ce861096e127f07859a9377472eb4855853b544422d1860e449dcb2ea7d236';

/** The one entry point the swap calls. */
export const AVNU_SWAP_ENTRYPOINT = 'multi_route_swap';

/**
 * The swap's `dapp_name`, a Cairo short string the wallet hashes into the
 * shadow account's commitment. Its own name, neither the Vault's nor the
 * Borrow counter's: reusing either would put every swap on that counter's
 * stand-in address and link the two publicly. Part of every player's swap stand-in address, so it
 * is fixed for good (D-084).
 */
export const SWAP_DAPP_NAME = 'strkworld-swap';

/** The one swap shadow account per player (D-084), nonce 0 like the Vault's. */
export const SWAP_SHADOW_NONCE = VAULT_SHADOW_NONCE;

/**
 * How long a quote stands before the swap asks avnu again (D-084). avnu's
 * public quote carries no expiry of its own (`expiry: null`), and its routes
 * follow the chain block by block, so STRKWORLD sets one. The on-chain floor
 * is what protects the player; this only keeps the reviewed price fresh.
 */
export const SWAP_QUOTE_TTL_MS = 30_000;

/** Starknet mainnet's chain id, `SN_MAIN`. */
export const MAINNET_CHAIN_ID = '0x534e5f4d41494e';

/**
 * `multi_route_swap(sell_token_address, sell_token_amount: u256,
 * buy_token_address, buy_token_amount: u256, buy_token_min_amount: u256,
 * beneficiary, integrator_fee_amount_bps: u128, integrator_fee_recipient,
 * routes: Array<Route>)`: eleven fixed felts, then the routes array.
 */
const SWAP_HEAD_FELTS = 11;
/** The most calldata a swap call may carry: a long multi-hop route is a few dozen felts. */
export const MAX_SWAP_CALLDATA = 512;
const MAX_ROUTES = 64;
const MAX_QUOTE_ID_LENGTH = 128;
const U128_BOUND = 1n << 128n;
const U128_MASK = U128_BOUND - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/** What the swap asks avnu for, from the canonical intent and the resolved stand-in. */
export interface SwapQuoteRequest {
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  /** The swap stand-in address: avnu's taker, and the swap's beneficiary. */
  readonly taker: Address;
  readonly slippageBps: number;
}

/**
 * A quote that has passed every check here, with the floor the player
 * reviews and the chain enforces. Only `routes` comes from avnu unrebuilt.
 */
export interface SwapQuote {
  readonly quoteId: string;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  /**
   * `buy_token_min_amount`, STRKWORLD's own: the protected minimum for the
   * policy's slippage. The exchange reverts the whole swap below it.
   */
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
  readonly taker: Address;
  /** The serialized `routes` array, its length first. */
  readonly routes: readonly string[];
  /** Unix epoch ms: `SWAP_QUOTE_TTL_MS` after the quote was read. */
  readonly expiresAt: number;
}

/**
 * Own and check avnu's answer, as the backend relayed it, against the request
 * it answers. Anything off rejects `unknown` before the player sees a price:
 *
 * - the chain is mainnet, and the quote's sell token, sell amount and buy
 *   token are the request's;
 * - the build holds exactly one call, `multi_route_swap` on the pinned
 *   exchange, whose head names the same tokens and amounts, the quote's buy
 *   amount, the stand-in as beneficiary and no integrator fee;
 * - the output fits a pool note (u128), and avnu's own floor is no more than
 *   the expected output. That floor is not used: the swap sets its own, the
 *   protected minimum for the policy's slippage (D-042's formula, which
 *   truncates the slippage down, so it can sit one base unit above avnu's);
 * - the routes are a nonempty array of felts that starts from the sell token.
 *
 * avnu's routes are not re-derived: the exchange itself refuses a route that
 * does not start at the sell token or end at the buy token, refuses residue,
 * and reverts below the floor, which this file sets.
 */
export function ownSwapQuote(answer: unknown, request: SwapQuoteRequest, now: number): SwapQuote {
  const invalid = () => new PrivacyError('unknown', 'avnu returned an invalid swap quote.');
  const quoteId = ownData(answer, 'quoteId');
  const chainId = ownData(answer, 'chainId');
  const sellToken = ownData(answer, 'sellToken');
  const buyToken = ownData(answer, 'buyToken');
  const sellAmount = ownData(answer, 'sellAmount');
  const buyAmount = ownData(answer, 'buyAmount');
  const calls = ownList(ownData(answer, 'calls'));
  if (
    typeof quoteId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(quoteId) || quoteId.length > MAX_QUOTE_ID_LENGTH
    || !sameFelt(chainId, MAINNET_CHAIN_ID)
    || !sameFelt(sellToken, request.sellToken)
    || !sameFelt(buyToken, request.buyToken)
    || sellAmount !== request.sellAmount
    || typeof buyAmount !== 'bigint' || buyAmount <= 0n || buyAmount >= U128_BOUND
    || calls === null || calls.length !== 1
  ) {
    throw invalid();
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new PrivacyError('unknown', 'The swap clock is invalid.');
  const call = calls.at(0);
  const calldata = ownList(ownData(call, 'calldata'));
  if (
    !sameFelt(ownData(call, 'contractAddress'), AVNU_EXCHANGE)
    || ownData(call, 'entrypoint') !== AVNU_SWAP_ENTRYPOINT
    || calldata === null
    || calldata.length <= SWAP_HEAD_FELTS + 1
    || calldata.length > MAX_SWAP_CALLDATA
    || calldata.some((felt) => typeof felt !== 'string' || !isFelt(felt))
  ) {
    throw invalid();
  }
  const felts = calldata as string[];
  const value = (index: number) => BigInt(felts.at(index)!);
  const u256At = (index: number) => {
    const low = value(index);
    const high = value(index + 1);
    if (low >= U128_BOUND || high >= U128_BOUND) throw invalid();
    return low + (high << 128n);
  };
  const avnuFloor = u256At(6);
  const minAmountOut = protectedMinimumOut(buyAmount, request.slippageBps);
  const routeCount = value(SWAP_HEAD_FELTS);
  if (
    !sameFelt(felts.at(0), request.sellToken)
    || u256At(1) !== request.sellAmount
    || !sameFelt(felts.at(3), request.buyToken)
    || u256At(4) !== buyAmount
    || avnuFloor === 0n || avnuFloor > buyAmount
    || !sameFelt(felts.at(8), request.taker)
    || value(9) !== 0n
    || value(10) !== 0n
    || routeCount === 0n || routeCount > BigInt(MAX_ROUTES)
    || !sameFelt(felts.at(SWAP_HEAD_FELTS + 1), request.sellToken)
  ) {
    throw invalid();
  }
  return Object.freeze({
    quoteId,
    sellToken: canonicalAddress(request.sellToken),
    buyToken: canonicalAddress(request.buyToken),
    sellAmount: request.sellAmount,
    buyAmount,
    minAmountOut,
    slippageBps: request.slippageBps,
    taker: canonicalAddress(request.taker),
    routes: Object.freeze(felts.slice(SWAP_HEAD_FELTS).map((felt) => toFelt(BigInt(felt)))),
    expiresAt: now + SWAP_QUOTE_TTL_MS,
  });
}

/**
 * The swap the wallet proves (D-084), in the shape the Wallet API documents
 * for a shadow-account interaction:
 *
 * 1. withdraw the sell amount from the pool to the stand-in: the public leg;
 * 2. open one note of the buy token for the player, which the invoke fills;
 * 3. through the stand-in, approve the exchange for exactly the sell amount
 *    and call `multi_route_swap` with the stand-in as beneficiary and the
 *    reviewed floor, collecting only what the swap gained (`diff`), so a
 *    balance the stand-in already held stays where it is.
 *
 * Nothing of the sell token is left behind: the exchange pulls exactly the
 * approved amount or the swap reverts, and a reverted swap reverts the
 * withdraw with it. No second note is opened for the sell token, since the
 * anonymizer refuses to settle an open note with nothing in it.
 */
export function swapActions(input: { quote: SwapQuote; shadowAccount: Address; player: Address }): STRK20_ACTION[] {
  const { quote } = input;
  const shadow = canonicalAddress(input.shadowAccount);
  const player = canonicalAddress(input.player);
  if (BigInt(shadow) !== BigInt(quote.taker)) throw new PrivacyError('unknown', 'The swap quote names another stand-in.');
  if (quote.sellAmount <= 0n || quote.sellAmount >= U128_BOUND) {
    throw new PrivacyError('unknown', 'Invalid swap amount.');
  }
  const sellAmount = u256Felts(quote.sellAmount);
  const exchange = canonicalAddress(AVNU_EXCHANGE);
  return [
    { type: 'withdraw', token: quote.sellToken, amount: toFelt(quote.sellAmount), recipient: shadow },
    { type: 'transfer', token: quote.buyToken, amount: 'OPEN', recipient: player },
    {
      type: 'shadow_account_invoke',
      dapp_name: SWAP_DAPP_NAME,
      nonce: SWAP_SHADOW_NONCE,
      calls: [
        { contractAddress: quote.sellToken, entrypoint: 'approve', calldata: [exchange, ...sellAmount] },
        {
          contractAddress: exchange,
          entrypoint: AVNU_SWAP_ENTRYPOINT,
          calldata: [
            quote.sellToken,
            ...sellAmount,
            quote.buyToken,
            ...u256Felts(quote.buyAmount),
            ...u256Felts(quote.minAmountOut),
            shadow,
            '0x0',
            '0x0',
            ...quote.routes,
          ],
        },
      ],
      collect_policy: { type: 'diff' },
    },
  ];
}

/** `0x` and lowercase hex without padding: one spelling per address. */
function canonicalAddress(address: unknown): Address {
  if (!isContractAddress(address)) throw new PrivacyError('unknown', 'Invalid swap address.');
  return toFelt(BigInt(address));
}

/** Cairo serializes a u256 as two felts, low 128 bits first. */
function u256Felts(value: bigint): [string, string] {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) throw new PrivacyError('unknown', 'Invalid swap amount.');
  return [toFelt(value & U128_MASK), toFelt(value >> 128n)];
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}

function sameFelt(value: unknown, expected: unknown): boolean {
  return typeof value === 'string' && isFelt(value) && typeof expected === 'string' && isFelt(expected)
    && BigInt(value) === BigInt(expected);
}

/** An array's items as own data properties, or null for anything else. */
function ownList(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value > MAX_SWAP_CALLDATA) {
      return null;
    }
    const items: unknown[] = [];
    for (let index = 0; index < (length.value as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) return null;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

/** An own data property, never a getter or an inherited value. */
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
