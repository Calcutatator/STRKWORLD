import type { STRK20_ACTION } from 'starknet';
import type {
  BorrowAsset,
  BorrowHealth,
  BorrowMarket,
  BorrowPair,
  BorrowPosition,
  BorrowRequest,
} from './operations.js';
import type { Address } from './types.js';
export { BorrowRefusedError } from './types.js';
import { VAULT_MARKETS, VESU_PRIME_POOL, isContractAddress, shadowAccountAddress } from './vault.js';

/**
 * Borrowing on Vesu from a second STRK20 shadow account (D-083).
 *
 * Protocol constants and pure builders, like `vault.ts`. The shell names a
 * pair and amounts; this file pins the pool, the tokens and the dapp name and
 * builds every call from them (D-018). Mainnet only (D-001).
 *
 * The account is the player's own shadow account for `strkworld-borrow` at
 * nonce 0: a different address from the Vault's, so a loan is not linkable
 * on-chain to the player's supply positions. Like every shadow account, its
 * balances, calls and positions are public, and a Vesu position on it can be
 * liquidated by anyone exactly like any other; only which wallet controls it
 * is hidden.
 *
 * Every figure follows Vesu V2's own contracts (`vesuxyz/vesu-v2`
 * `src/pool.cairo` and `src/common.cairo`, matched to the deployed Prime pool
 * class's ABI on 2026-10-01):
 *
 * - `modify_position(ModifyPositionParams)`, where `ModifyPositionParams` is
 *   `{ collateral_asset, debt_asset, user, collateral: Amount, debt: Amount }`,
 *   `Amount` is `{ denomination: Native | Assets, value: i257 }` and `i257`
 *   is `{ abs: u256, is_negative: bool }`. Positive collateral is supplied
 *   from the caller, negative paid to it; positive debt is borrowed to the
 *   caller, negative repaid from it. `Native` counts collateral shares or
 *   nominal debt, and a negative `Native` past the position is clamped to it,
 *   which is how "all" is said exactly.
 * - The caller must own the position (`assert_ownership`): the shadow
 *   account is the caller of every call it runs, and `user` is that account,
 *   so no delegation is needed.
 * - A position is collateralised while `collateral_value × max_ltv ≥
 *   debt_value × SCALE`; anything that adds debt or removes collateral must
 *   keep it so, and keep the asset under its `max_utilization`. Every call
 *   needs both oracle prices valid, a nonzero debt worth more than the debt
 *   asset's `floor`, and, with any debt, collateral worth more than the
 *   collateral asset's floor. New debt must fit the pair's `debt_cap`
 *   (zero there means uncapped to Vesu; the counter offers no such pair,
 *   D-083).
 */

/** Vesu's fixed-point unit: prices, values, LTVs and utilizations are × 10^18. */
export const VESU_SCALE = 10n ** 18n;

/**
 * The borrow counter's `dapp_name` (D-083). Part of every player's borrow
 * stand-in address, so it is fixed for good, like `VAULT_DAPP_NAME`, and it
 * is not the Vault's: supply and loans sit on different addresses.
 */
export const BORROW_DAPP_NAME = 'strkworld-borrow';

/** The one borrow account per player (D-083): nonce 0 of its own dapp name. */
export const BORROW_SHADOW_NONCE = '0x0';

/** The one pool the counter borrows in (D-083): Vesu's own Prime pool. */
export const BORROW_POOL = VESU_PRIME_POOL;

/**
 * The tokens the counter lends against and borrows (D-083), in its order:
 * the five Prime markets that are both collateral and debt in every pair
 * among themselves. Each is the Vault's own pinned Prime market for the
 * token (`borrow.test.ts` checks), so its symbol and decimals come from one
 * place.
 */
export const BORROW_TOKENS: readonly Address[] = Object.freeze([
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', // STRK
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', // ETH
  '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', // USDC
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', // USDT
  '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', // WBTC
]);

/** One pinned token's display metadata, from the Vault's market list. */
export interface BorrowTokenInfo {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/** The pinned tokens with their symbols and decimals, in order. */
export const BORROW_TOKEN_INFO: readonly BorrowTokenInfo[] = Object.freeze(BORROW_TOKENS.map((token) => {
  const market = VAULT_MARKETS.find((entry) => BigInt(entry.token) === BigInt(token) && BigInt(entry.pool) === BigInt(BORROW_POOL));
  if (!market) throw new Error('A borrow token has no pinned Prime market.');
  return Object.freeze({ token: market.token, symbol: market.symbol, decimals: market.decimals });
}));

/** A pinned (collateral, debt) pair. */
export interface BorrowPairKey {
  readonly collateral: Address;
  readonly debt: Address;
}

/** Every ordered pair of pinned tokens, collateral-major: the twenty the backend reads, in its order. */
export const BORROW_PAIRS: readonly BorrowPairKey[] = Object.freeze(
  BORROW_TOKENS.flatMap((collateral) => BORROW_TOKENS
    .filter((debt) => debt !== collateral)
    .map((debt) => Object.freeze({ collateral, debt }))),
);

/**
 * Health below this, × 10^18, is the warning band near liquidation (D-083):
 * at 1.15 the collateral can lose about 13% of its price against the debt
 * before the loan turns liquidatable.
 */
export const BORROW_WARNING_HEALTH = 1_150_000_000_000_000_000n;

/**
 * Repay-all's buffer (D-083): 0.1% of the debt read at prepare time, plus two
 * base units for Vesu's rounding in its own favour. Interest accrues every
 * second until the transaction runs, so the exact amount is Vesu's to fix;
 * whatever of the buffer it does not take returns to the pool balance.
 */
export const BORROW_REPAY_ALL_BUFFER_BPS = 10n;
export const BORROW_REPAY_ALL_BUFFER_UNITS = 2n;

/** The buffer added to a repay-all of `debt`. */
export function repayAllBuffer(debt: bigint): bigint {
  if (typeof debt !== 'bigint' || debt < 0n) throw new Error('Invalid debt.');
  return ceilDiv(debt * BORROW_REPAY_ALL_BUFFER_BPS, 10_000n) + BORROW_REPAY_ALL_BUFFER_UNITS;
}

/** The pinned token, compared by value, or undefined. */
export function borrowToken(token: unknown): BorrowTokenInfo | undefined {
  if (typeof token !== 'string' || !isContractAddress(token)) return undefined;
  const value = BigInt(token);
  return BORROW_TOKEN_INFO.find((entry) => BigInt(entry.token) === value);
}

/** The pinned pair for two tokens, compared by value, or undefined. */
export function borrowPairKey(collateral: unknown, debt: unknown): BorrowPairKey | undefined {
  const c = borrowToken(collateral);
  const d = borrowToken(debt);
  if (!c || !d || c === d) return undefined;
  return BORROW_PAIRS.find((pair) => pair.collateral === c.token && pair.debt === d.token);
}

/**
 * Where the borrow counter's shadow account sits for a partial commitment
 * (the wallet's, for `BORROW_DAPP_NAME`), derived as the anonymizer derives
 * it: the independent check on the anonymizer's own answer.
 */
export function borrowShadowAccountAddress(partialCommitment: string): Address {
  return shadowAccountAddress(partialCommitment, BORROW_SHADOW_NONCE);
}

// ---------------------------------------------------------------------------
// Vesu's arithmetic, in bigints
// ---------------------------------------------------------------------------

/** Vesu's `calculate_debt`: nominal debt to the asset's base units at a rate accumulator. */
export function vesuDebt(nominalDebt: bigint, rateAccumulator: bigint, scale: bigint, roundUp: boolean): bigint {
  if (rateAccumulator === 0n) return 0n;
  const numerator = nominalDebt * rateAccumulator * scale;
  const denominator = VESU_SCALE * VESU_SCALE;
  return roundUp ? ceilDiv(numerator, denominator) : numerator / denominator;
}

/** Collateral's USD value × 10^18, rounded down as Vesu values collateral. */
export function collateralValue(amount: bigint, asset: Pick<BorrowAsset, 'price' | 'scale'>): bigint {
  return (amount * asset.price) / asset.scale;
}

/** Debt's USD value × 10^18, rounded up as Vesu values debt. */
export function debtValue(amount: bigint, asset: Pick<BorrowAsset, 'price' | 'scale'>): bigint {
  return ceilDiv(amount * asset.price, asset.scale);
}

/** Whether a loan of these values is collateralised by Vesu's rule. */
export function isCollateralized(collateralUsd: bigint, debtUsd: bigint, maxLtv: bigint): boolean {
  return collateralUsd * maxLtv >= debtUsd * VESU_SCALE;
}

/** Vesu's utilization of an asset, × 10^18. */
export function utilization(reserve: bigint, totalDebt: bigint): bigint {
  const total = reserve + totalDebt;
  return total === 0n ? 0n : (totalDebt * VESU_SCALE) / total;
}

/**
 * Whether a pair is offered for borrowing (D-083): a max LTV above zero and
 * a debt cap above zero. Vesu reads a zero cap as uncapped; the counter reads
 * it as not ramped and leaves the pair out, which can only ever hide a pair.
 */
export function borrowPairOffered(pair: Pick<BorrowPair, 'maxLtv' | 'debtCap'>): boolean {
  return pair.maxLtv > 0n && pair.debtCap > 0n;
}

/**
 * A loan's health at Vesu's prices now (D-083). Pure: the same reads always
 * give the same figures.
 */
export function borrowHealth(input: {
  readonly collateralAmount: bigint;
  readonly debtAmount: bigint;
  readonly collateral: Pick<BorrowAsset, 'price' | 'priceValid' | 'scale'>;
  readonly debt: Pick<BorrowAsset, 'price' | 'priceValid' | 'scale'>;
  readonly maxLtv: bigint;
}): BorrowHealth {
  const { collateralAmount, debtAmount, collateral, debt, maxLtv } = input;
  if (!collateral.priceValid || !debt.priceValid) {
    return Object.freeze({
      status: 'stale-price',
      collateralValue: 0n,
      debtValue: 0n,
      ltv: null,
      maxLtv,
      healthFactor: null,
      liquidationPrice: null,
      band: 'unknown',
    });
  }
  const cv = collateralValue(collateralAmount, collateral);
  const dv = debtValue(debtAmount, debt);
  if (dv === 0n) {
    return Object.freeze({
      status: 'no-debt',
      collateralValue: cv,
      debtValue: 0n,
      ltv: null,
      maxLtv,
      healthFactor: null,
      liquidationPrice: null,
      band: 'none',
    });
  }
  const ltv = cv > 0n ? ceilDiv(dv * VESU_SCALE, cv) : null;
  const healthFactor = (cv * maxLtv) / dv;
  const liquidationPrice = collateralAmount > 0n && maxLtv > 0n
    ? ceilDiv(dv * collateral.scale * VESU_SCALE, collateralAmount * maxLtv)
    : null;
  const band = !isCollateralized(cv, dv, maxLtv)
    ? 'liquidatable'
    : healthFactor < BORROW_WARNING_HEALTH ? 'warning' : 'safe';
  return Object.freeze({ status: 'priced', collateralValue: cv, debtValue: dv, ltv, maxLtv, healthFactor, liquidationPrice, band });
}

// ---------------------------------------------------------------------------
// Assessing an action before the wallet is asked
// ---------------------------------------------------------------------------

/** Why the counter refuses an action before asking the wallet (D-083): see `types.ts`. */
export type { BorrowRefusal } from './types.js';
import type { BorrowRefusal } from './types.js';

/** The amounts an assessed action moves, as its review states them. */
export type AssessedBorrow =
  | {
      readonly ok: true;
      /** The loan after the action, at Vesu's prices now. */
      readonly after: BorrowHealth;
      /** What leaves the pool balance (collateral or repayment), in its token's base units; zero for none. */
      readonly fromPool: bigint;
      /** For a repay-all, the buffer inside `fromPool`. */
      readonly buffer: bigint;
      /** What the position holds after, by this estimate: collateral and debt in base units. */
      readonly collateralAfter: bigint;
      readonly debtAfter: bigint;
    }
  | { readonly ok: false; readonly reason: BorrowRefusal };

/**
 * Whether Vesu would accept `request` against the position and market as
 * read, and the loan's health after it (D-083). The seam runs it on fresh
 * reads before asking the wallet anything; the counter runs it on its last
 * reads to say early what will be refused. It estimates conservatively (a
 * base unit more debt on a borrow, a base unit less collateral on a
 * withdrawal): the chain stays the authority.
 *
 * `position` is undefined for a pair with no position yet.
 */
export function assessBorrow(
  request: BorrowRequest,
  market: BorrowMarket,
  position: Pick<BorrowPosition, 'collateralShares' | 'nominalDebt' | 'collateralAmount' | 'debtAmount'> | undefined,
): AssessedBorrow {
  const refuse = (reason: BorrowRefusal): AssessedBorrow => Object.freeze({ ok: false, reason });
  const key = borrowPairKey(request.collateral, request.debt);
  if (!key) return refuse('unknown-pair');
  const collateral = market.assets.find((asset) => sameAddress(asset.token, key.collateral));
  const debt = market.assets.find((asset) => sameAddress(asset.token, key.debt));
  if (!collateral || !debt) return refuse('unknown-pair');
  const pair = market.pairs.find((entry) => sameAddress(entry.collateral, key.collateral) && sameAddress(entry.debt, key.debt));
  if (!collateral.priceValid || !debt.priceValid) return refuse('stale-price');
  const held = {
    shares: position?.collateralShares ?? 0n,
    nominal: position?.nominalDebt ?? 0n,
    collateral: position?.collateralAmount ?? 0n,
    debt: position?.debtAmount ?? 0n,
  };
  // A pair left out of the market (not offered) still has its position to
  // unwind; its max LTV is then unknown here, so only actions that need none
  // pass (repay, add collateral, withdrawing all with no debt).
  const maxLtv = pair?.maxLtv ?? 0n;
  const health = (collateralAfter: bigint, debtAfter: bigint): BorrowHealth => borrowHealth({
    collateralAmount: collateralAfter,
    debtAmount: debtAfter,
    collateral,
    debt,
    maxLtv,
  });
  const accept = (fromPool: bigint, buffer: bigint, collateralAfter: bigint, debtAfter: bigint): AssessedBorrow => Object.freeze({
    ok: true,
    after: health(collateralAfter, debtAfter),
    fromPool,
    buffer,
    collateralAfter,
    debtAfter,
  });
  // Vesu's floor rule, on the position after the action.
  const floorRefusal = (collateralAfter: bigint, debtAfter: bigint): BorrowRefusal | null => {
    const dv = debtValue(debtAfter, debt);
    if (dv !== 0n && dv <= debt.floor) return 'debt-below-floor';
    if (debtAfter > 0n && collateralValue(collateralAfter, collateral) <= collateral.floor) return 'collateral-below-floor';
    return null;
  };

  switch (request.kind) {
    case 'borrow': {
      const { collateralAmount, borrowAmount } = request;
      if (!isAmount(collateralAmount, true) || !isAmount(borrowAmount, false)) return refuse('amount');
      if (!pair || !borrowPairOffered(pair)) return refuse('pair-not-offered');
      const collateralAfter = held.collateral + collateralAmount;
      // Vesu rounds new nominal debt up: count a base unit more.
      const debtAfter = held.debt + borrowAmount + 1n;
      if (!isCollateralized(collateralValue(collateralAfter, collateral), debtValue(debtAfter, debt), pair.maxLtv)) {
        return refuse('above-max-ltv');
      }
      const floor = floorRefusal(collateralAfter, debtAfter);
      if (floor) return refuse(floor);
      if (pair.totalDebt + borrowAmount + 1n > pair.debtCap) return refuse('debt-cap');
      if (borrowAmount > debt.reserve) return refuse('utilization');
      if (utilization(debt.reserve - borrowAmount, debt.totalDebt + borrowAmount) > debt.maxUtilization) return refuse('utilization');
      return accept(collateralAmount, 0n, collateralAfter, debtAfter);
    }
    case 'add-collateral': {
      const { amount } = request;
      if (!isAmount(amount, false)) return refuse('amount');
      const collateralAfter = held.collateral + amount;
      const floor = floorRefusal(collateralAfter, held.debt);
      if (floor) return refuse(floor);
      return accept(amount, 0n, collateralAfter, held.debt);
    }
    case 'repay': {
      if (held.nominal === 0n || held.debt === 0n) return refuse('nothing-to-repay');
      if (request.amount === 'all') {
        const buffer = repayAllBuffer(held.debt);
        return accept(held.debt + buffer, buffer, held.collateral, 0n);
      }
      const { amount } = request;
      if (!isAmount(amount, false)) return refuse('amount');
      if (amount >= held.debt) return refuse('repay-exceeds-debt');
      const debtAfter = held.debt - amount;
      const floor = floorRefusal(held.collateral, debtAfter);
      if (floor) return refuse(floor);
      return accept(amount, 0n, held.collateral, debtAfter);
    }
    case 'withdraw-collateral': {
      if (held.shares === 0n || held.collateral === 0n) return refuse('withdraw-exceeds-collateral');
      if (request.amount === 'all') {
        if (held.nominal !== 0n) return refuse('withdraw-all-with-debt');
        if (held.collateral > collateral.reserve) return refuse('utilization');
        if (utilization(collateral.reserve - held.collateral, collateral.totalDebt) > collateral.maxUtilization) {
          return refuse('utilization');
        }
        return accept(0n, 0n, 0n, 0n);
      }
      const { amount } = request;
      if (!isAmount(amount, false)) return refuse('amount');
      if (amount > held.collateral) return refuse('withdraw-exceeds-collateral');
      // Vesu rounds the shares burned up: count a base unit less collateral.
      const collateralAfter = held.collateral - amount > 0n ? held.collateral - amount - 1n : 0n;
      if (held.nominal !== 0n) {
        if (!pair || !isCollateralized(collateralValue(collateralAfter, collateral), debtValue(held.debt, debt), pair.maxLtv)) {
          return refuse('above-max-ltv');
        }
      }
      const floor = floorRefusal(collateralAfter, held.debt);
      if (floor) return refuse(floor);
      if (amount > collateral.reserve) return refuse('utilization');
      if (utilization(collateral.reserve - amount, collateral.totalDebt) > collateral.maxUtilization) return refuse('utilization');
      return accept(0n, 0n, collateralAfter, held.debt);
    }
  }
}

// ---------------------------------------------------------------------------
// The actions the wallet proves
// ---------------------------------------------------------------------------

/** A signed `Amount`: Vesu's denomination, and a value whose sign is the direction. */
export interface VesuAmount {
  readonly denomination: 'native' | 'assets';
  readonly value: bigint;
}

const NO_CHANGE: VesuAmount = Object.freeze({ denomination: 'native', value: 0n });

/**
 * `modify_position`'s calldata, serialized as Cairo serializes
 * `ModifyPositionParams`: three addresses, then each `Amount` as its
 * denomination's variant index (`Native` 0, `Assets` 1) and its `i257` as
 * `abs` (a u256: low, high) and `is_negative` (0 or 1, never 1 for zero).
 */
export function modifyPositionCalldata(input: {
  readonly collateral: Address;
  readonly debt: Address;
  readonly user: Address;
  readonly collateralAmount: VesuAmount;
  readonly debtAmount: VesuAmount;
}): string[] {
  return [
    canonicalAddress(input.collateral),
    canonicalAddress(input.debt),
    canonicalAddress(input.user),
    ...amountFelts(input.collateralAmount),
    ...amountFelts(input.debtAmount),
  ];
}

interface BuildInput {
  readonly pair: BorrowPairKey;
  readonly shadowAccount: Address;
}

/**
 * Open a loan, or add to one (D-083):
 *
 * 1. with collateral, withdraw it from the pool to the borrow account: the
 *    public leg;
 * 2. open one note of the debt token for the player, which the invoke fills;
 * 3. through the account, approve the pool for the collateral (if any), then
 *    one `modify_position` adding both, the account as `user`;
 * 4. collect only what the call gained (`diff`): the borrowed token. A public
 *    balance of it the account already held stays where it is.
 */
export function borrowOpenActions(input: BuildInput & {
  readonly player: Address;
  readonly collateralAmount: bigint;
  readonly borrowAmount: bigint;
}): STRK20_ACTION[] {
  const pair = pinnedPair(input.pair);
  const shadow = canonicalAddress(input.shadowAccount);
  const collateralAmount = nonNegative(input.collateralAmount);
  const borrowAmount = positive(input.borrowAmount);
  const calls = [];
  if (collateralAmount > 0n) calls.push(approveCall(pair.collateral, collateralAmount));
  calls.push(modifyCall(pair, shadow, { denomination: 'assets', value: collateralAmount }, { denomination: 'assets', value: borrowAmount }));
  return [
    ...(collateralAmount > 0n ? [withdrawLeg(pair.collateral, collateralAmount, shadow)] : []),
    openNote(pair.debt, input.player),
    invoke(calls, { type: 'diff' }),
  ];
}

/**
 * Add collateral (D-083), the shape of a Vault supply against the pool:
 * withdraw it to the account, approve the pool, `modify_position` adding it
 * with no change to the debt, and collect nothing (`exact 0`).
 */
export function borrowAddCollateralActions(input: BuildInput & { readonly amount: bigint }): STRK20_ACTION[] {
  const pair = pinnedPair(input.pair);
  const shadow = canonicalAddress(input.shadowAccount);
  const amount = positive(input.amount);
  return [
    withdrawLeg(pair.collateral, amount, shadow),
    invoke(
      [approveCall(pair.collateral, amount), modifyCall(pair, shadow, { denomination: 'assets', value: amount }, NO_CHANGE)],
      { type: 'exact', amount: '0x0' },
    ),
  ];
}

/**
 * Repay (D-083).
 *
 * - Partial: withdraw exactly `amount` of the debt token to the account,
 *   approve the pool for it, and `modify_position` repaying that many base
 *   units (`Assets`, negative). Vesu takes exactly that, so nothing returns
 *   and nothing is collected (`exact 0`).
 * - All: withdraw the debt read at prepare time plus `buffer`, approve the
 *   pool for that, and repay the whole nominal debt (`Native`, negative), so
 *   Vesu, not a stale quote, fixes the amount when it runs. One note of the
 *   debt token collects what is left on the account (`all`): the unused
 *   buffer. `diff` cannot say it: the buffer reaches the account before the
 *   invoke, so the invoke itself only ever loses that token. The borrow
 *   account holds no other balance of it that is not the player's own.
 */
export function borrowRepayActions(input: BuildInput & {
  readonly player: Address;
  readonly repay: { readonly amount: bigint } | { readonly nominalDebt: bigint; readonly withdraw: bigint };
}): STRK20_ACTION[] {
  const pair = pinnedPair(input.pair);
  const shadow = canonicalAddress(input.shadowAccount);
  if ('amount' in input.repay) {
    const amount = positive(input.repay.amount);
    return [
      withdrawLeg(pair.debt, amount, shadow),
      invoke(
        [approveCall(pair.debt, amount), modifyCall(pair, shadow, NO_CHANGE, { denomination: 'assets', value: -amount })],
        { type: 'exact', amount: '0x0' },
      ),
    ];
  }
  const nominal = positive(input.repay.nominalDebt);
  const withdraw = positive(input.repay.withdraw);
  return [
    withdrawLeg(pair.debt, withdraw, shadow),
    openNote(pair.debt, input.player),
    invoke(
      [approveCall(pair.debt, withdraw), modifyCall(pair, shadow, NO_CHANGE, { denomination: 'native', value: -nominal })],
      { type: 'all' },
    ),
  ];
}

/**
 * Withdraw collateral (D-083), the shape of a Vault redeem against the pool:
 * one note of the collateral token for the player, then `modify_position`
 * paying `amount` out (`Assets`, negative) or, for all of it with no debt,
 * every collateral share (`Native`, negative), and collect what the call
 * gained (`diff`). Nothing is pulled from the account, so nothing is approved.
 */
export function borrowWithdrawCollateralActions(input: BuildInput & {
  readonly player: Address;
  readonly withdraw: { readonly amount: bigint } | { readonly collateralShares: bigint };
}): STRK20_ACTION[] {
  const pair = pinnedPair(input.pair);
  const shadow = canonicalAddress(input.shadowAccount);
  const collateralAmount: VesuAmount = 'amount' in input.withdraw
    ? { denomination: 'assets', value: -positive(input.withdraw.amount) }
    : { denomination: 'native', value: -positive(input.withdraw.collateralShares) };
  return [
    openNote(pair.collateral, input.player),
    invoke([modifyCall(pair, shadow, collateralAmount, NO_CHANGE)], { type: 'diff' }),
  ];
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const U128_MASK = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

type CollectPolicy = { type: 'diff' } | { type: 'all' } | { type: 'exact'; amount: string };

function withdrawLeg(token: Address, amount: bigint, shadow: Address): STRK20_ACTION {
  return { type: 'withdraw', token, amount: toFelt(amount), recipient: shadow };
}

function openNote(token: Address, player: Address): STRK20_ACTION {
  return { type: 'transfer', token, amount: 'OPEN', recipient: canonicalAddress(player) };
}

function invoke(calls: Array<{ contractAddress: string; entrypoint: string; calldata: string[] }>, policy: CollectPolicy): STRK20_ACTION {
  return {
    type: 'shadow_account_invoke',
    dapp_name: BORROW_DAPP_NAME,
    nonce: BORROW_SHADOW_NONCE,
    calls,
    collect_policy: policy,
  };
}

function approveCall(token: Address, amount: bigint): { contractAddress: string; entrypoint: string; calldata: string[] } {
  return { contractAddress: token, entrypoint: 'approve', calldata: [BORROW_POOL, ...u256Felts(amount)] };
}

function modifyCall(
  pair: BorrowPairKey,
  shadow: Address,
  collateralAmount: VesuAmount,
  debtAmount: VesuAmount,
): { contractAddress: string; entrypoint: string; calldata: string[] } {
  return {
    contractAddress: BORROW_POOL,
    entrypoint: 'modify_position',
    calldata: modifyPositionCalldata({ collateral: pair.collateral, debt: pair.debt, user: shadow, collateralAmount, debtAmount }),
  };
}

function amountFelts(amount: VesuAmount): [string, string, string, string] {
  if (amount.denomination !== 'native' && amount.denomination !== 'assets') throw new Error('Invalid Vesu amount.');
  if (typeof amount.value !== 'bigint') throw new Error('Invalid Vesu amount.');
  const negative = amount.value < 0n;
  const abs = negative ? -amount.value : amount.value;
  const [low, high] = u256Felts(abs);
  return [amount.denomination === 'native' ? '0x0' : '0x1', low, high, negative ? '0x1' : '0x0'];
}

/** The pinned pair a key names, or a throw: no action is built against an unpinned pair. */
function pinnedPair(pair: unknown): BorrowPairKey {
  const collateral = ownData(pair, 'collateral');
  const debt = ownData(pair, 'debt');
  const pinned = borrowPairKey(collateral, debt);
  if (!pinned) throw new Error('Invalid borrow pair.');
  return pinned;
}

function canonicalAddress(address: Address): Address {
  if (!isContractAddress(address)) throw new Error('Invalid borrow address.');
  return toFelt(BigInt(address));
}

function positive(value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_UINT256) throw new Error('Invalid borrow amount.');
  return value;
}

function nonNegative(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) throw new Error('Invalid borrow amount.');
  return value;
}

function isAmount(value: unknown, zeroAllowed: boolean): value is bigint {
  return typeof value === 'bigint' && (zeroAllowed ? value >= 0n : value > 0n) && value <= MAX_UINT256;
}

function u256Felts(value: bigint): [string, string] {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) throw new Error('Invalid borrow amount.');
  return [toFelt(value & U128_MASK), toFelt(value >> 128n)];
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}

function sameAddress(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
