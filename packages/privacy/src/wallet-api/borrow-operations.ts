import type { STRK20_ACTION } from 'starknet';
import {
  BORROW_DAPP_NAME,
  BORROW_PAIRS,
  BORROW_REVIEW_TTL_MS,
  BORROW_SHADOW_NONCE,
  BorrowRefusedError,
  VESU_SCALE,
  assessBorrow,
  borrowHealth,
  borrowAddCollateralActions,
  borrowOpenActions,
  borrowPairOffered,
  borrowRepayActions,
  borrowToken,
  borrowWithdrawCollateralActions,
  vesuDebt,
  type BorrowPairKey,
  type BorrowRefusal,
  type BorrowTokenInfo,
} from '../borrow.js';
import type {
  BorrowAction,
  BorrowAsset,
  BorrowMarket,
  BorrowPair,
  BorrowPosition,
  BorrowPositions,
  BorrowRequest,
  PoolConfig,
  PreparedBorrowBatch,
  VaultCallOptions,
  VaultStageCallback,
} from '../operations.js';
import { PrivacyError, type Address } from '../types.js';
import {
  ShadowAccountResolver,
  emitStage,
  isAbortSignalLike,
  ownCallOptions,
  ownData,
  preparedShadowBatch,
  withPlacementTick,
  sameAddress,
  throwIfAborted,
  type ShadowBatchDeps,
} from './shadow-account.js';
import type { BorrowReadClient, PoolReadClient, WalletRoutePolicy, WalletStrk20Account } from './types.js';
import { WALLET_RECEIPT_WAITS_MS, abortableSleep, ownReceiptWaits } from './wallet-submission.js';

/**
 * The Borrow counter on the Wallet API (D-083): Vesu loans in its Prime pool
 * from the player's second STRK20 shadow account, for `strkworld-borrow` at
 * nonce 0, in every pair of tokens the policy admits that `BORROW_TOKENS`
 * pins.
 *
 * - The stand-in address resolves exactly as the Vault's does
 *   (`shadow-accounts.ts`), for its own dapp name: a different address, so
 *   no loan is linkable on-chain to the player's Vault supply.
 * - Market and positions are public reads through the backend (D-014).
 * - Every action is assessed on fresh reads against Vesu's own rules before
 *   the wallet is asked anything (`assessBorrow`), then proved and submitted
 *   by the wallet as one private transaction: no relay, no avnu key.
 *
 * Nothing here branches on wallet identity.
 */

const SUBJECT = 'borrow counter';

/** A market read, and every admitted pair's max LTV, offered or not, for measuring a loan already open. */
interface MarketRead extends BorrowMarket {
  readonly maxLtv: ReadonlyMap<string, bigint>;
}
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;

export interface ShadowBorrowOptions {
  readonly wallet: WalletStrk20Account;
  readonly walletAddress: Address;
  readonly pool: PoolReadClient;
  readonly reads?: BorrowReadClient;
  readonly policy: WalletRoutePolicy;
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly receiptWaitsMs?: readonly number[];
  /** The clock a prepared batch's two-minute life is measured by; `Date.now` by default. */
  readonly now?: () => number;
  /** Leaderboard phase 1: the ledger each action ticks. Absent, nothing is appended. */
  readonly ledger?: Address;
}

export class ShadowBorrow {
  private readonly walletAddress: Address;
  private readonly reads?: BorrowReadClient;
  private readonly policy: WalletRoutePolicy;
  private readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  private readonly identity: ShadowAccountResolver;
  private readonly batchDeps: ShadowBatchDeps;
  private readonly now: () => number;
  private readonly ledger?: Address;

  constructor(options: ShadowBorrowOptions) {
    this.now = options.now ?? Date.now;
    this.ledger = options.ledger;
    this.walletAddress = options.walletAddress;
    this.reads = options.reads;
    this.policy = options.policy;
    this.poolConfig = options.poolConfig;
    this.identity = new ShadowAccountResolver({
      wallet: options.wallet,
      dappName: BORROW_DAPP_NAME,
      nonce: BORROW_SHADOW_NONCE,
      ...(options.reads ? { reads: options.reads } : {}),
      supported: options.supported,
      subject: SUBJECT,
    });
    this.batchDeps = Object.freeze({
      wallet: options.wallet,
      pool: options.pool,
      poolConfig: options.poolConfig,
      sleep: options.sleep ?? abortableSleep,
      receiptWaitsMs: ownReceiptWaits(options.receiptWaitsMs ?? WALLET_RECEIPT_WAITS_MS, 'The borrow receipt schedule is invalid.'),
      subject: SUBJECT,
    });
  }

  /** Vesu's Prime pool now, for the admitted tokens and pairs. No wallet, no prompt. */
  async market(signal?: AbortSignal): Promise<BorrowMarket> {
    if (signal !== undefined && !isAbortSignalLike(signal)) {
      throw new PrivacyError('unknown', `The ${SUBJECT} call options are invalid.`);
    }
    throwIfAborted(signal);
    const tokens = this.admittedTokens();
    const { assets, pairs } = await this.readMarket(tokens, signal);
    return Object.freeze({ assets, pairs });
  }

  /** The loans on the borrow stand-in address, and the address. */
  async positions(options?: VaultCallOptions): Promise<BorrowPositions> {
    const { signal, onStage } = ownCallOptions(options, SUBJECT);
    throwIfAborted(signal);
    const tokens = this.admittedTokens();
    const identity = await this.identity.resolve(signal, onStage);
    const market = await this.readMarket(tokens, signal, onStage);
    const positions = await this.readPositions(identity.address, pairsOf(tokens), signal, onStage, market);
    return Object.freeze({
      standIn: identity.address,
      positions: Object.freeze(positions.filter((entry) => entry.collateralShares > 0n || entry.nominalDebt > 0n)),
    });
  }

  async prepare(request: BorrowRequest, options?: VaultCallOptions): Promise<PreparedBorrowBatch> {
    const { signal, onStage } = ownCallOptions(options, SUBJECT);
    throwIfAborted(signal);
    const tokens = this.admittedTokens();
    const owned = ownRequest(request);
    const pair = pairsOf(tokens).find((entry) => sameAddress(entry.collateral, owned.collateral) && sameAddress(entry.debt, owned.debt));
    if (!pair) throw new PrivacyError('unknown', 'The borrow counter does not offer that pair in this build.');
    const identity = await this.identity.resolve(signal, onStage);
    const market = await this.readMarket(tokens, signal, onStage);
    const [position] = await this.readPositions(identity.address, [pair], signal, onStage, market);
    if (!position) throw new PrivacyError('unknown', 'The borrow position read is invalid.');
    const assessed = assessBorrow(owned, market, position, market.maxLtv.get(`${pair.collateral}:${pair.debt}`));
    if (!assessed.ok) throw new BorrowRefusedError(assessed.reason, refusalMessage(assessed.reason));

    let action: BorrowAction;
    let actions: STRK20_ACTION[];
    const base = { pair, shadowAccount: identity.address } as const;
    switch (owned.kind) {
      case 'borrow':
        action = Object.freeze({
          kind: 'borrow',
          collateral: pair.collateral,
          debt: pair.debt,
          collateralAmount: owned.collateralAmount,
          borrowAmount: owned.borrowAmount,
        });
        actions = borrowOpenActions({
          ...base,
          player: this.walletAddress,
          collateralAmount: owned.collateralAmount,
          borrowAmount: owned.borrowAmount,
        });
        break;
      case 'add-collateral':
        action = Object.freeze({ kind: 'add-collateral', collateral: pair.collateral, debt: pair.debt, amount: owned.amount });
        actions = borrowAddCollateralActions({ ...base, amount: owned.amount });
        break;
      case 'repay': {
        const all = owned.amount === 'all';
        action = Object.freeze({
          kind: 'repay',
          collateral: pair.collateral,
          debt: pair.debt,
          amount: assessed.fromPool,
          all,
          buffer: assessed.buffer,
        });
        actions = borrowRepayActions({
          ...base,
          player: this.walletAddress,
          repay: all ? { nominalDebt: position.nominalDebt, withdraw: assessed.fromPool } : { amount: assessed.fromPool },
        });
        break;
      }
      case 'withdraw-collateral': {
        const all = owned.amount === 'all';
        const amount = all ? position.collateralAmount : (owned.amount as bigint);
        action = Object.freeze({ kind: 'withdraw-collateral', collateral: pair.collateral, debt: pair.debt, amount, all });
        actions = borrowWithdrawCollateralActions({
          ...base,
          player: this.walletAddress,
          withdraw: all ? { collateralShares: position.collateralShares } : { amount },
        });
        break;
      }
    }
    const config = await this.poolConfig(signal);
    throwIfAborted(signal);
    // D-083: a review older than two minutes is refused at confirm, before the
    // wallet is asked: interest may have outgrown a repay-all's buffer, and
    // prices may have moved under a borrow.
    const preparedAt = this.now();
    const guard = (): void => {
      if (this.now() - preparedAt > BORROW_REVIEW_TTL_MS) {
        throw new BorrowRefusedError('review-expired', refusalMessage('review-expired'));
      }
    };
    const ticked = await withPlacementTick(actions, this.ledger, this.identity);
    return preparedShadowBatch(this.batchDeps, action, ticked.actions, config, { after: assessed.after, ...ticked.extra }, guard);
  }

  /** Leaderboard phase 1: this counter's shadow commitment, whose ledger ticks count toward the placement. */
  ledgerCommitment(): Promise<string> {
    return this.identity.fullCommitment();
  }

  /**
   * One public read of the pool, and the admitted tokens' and pairs' rows
   * out of it, each exactly once. A failed row for anything admitted fails
   * the read as unreachable and a malformed one as invalid: nothing half-read
   * is returned. Pairs not offered (D-083) are left out.
   */
  private async readMarket(
    tokens: readonly BorrowTokenInfo[],
    signal: AbortSignal | undefined,
    onStage?: VaultStageCallback,
  ): Promise<MarketRead> {
    const reads = this.reads;
    if (!reads) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw new PrivacyError('unknown', 'The borrow reads are not configured.');
    }
    let answer: unknown;
    try {
      answer = await reads.borrowMarket(signal);
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throwIfAborted(signal);
      throw error instanceof PrivacyError ? error : new PrivacyError('unreachable', "The borrow counter could not read Vesu's market.", error);
    }
    throwIfAborted(signal);
    try {
      const assetRows = ownRows(ownData(answer, 'assets'));
      const pairRows = ownRows(ownData(answer, 'pairs'));
      const assets: BorrowAsset[] = [];
      // Vesu's `asset_config` view brings the rate accumulator up to the
      // block it was read at, so these totals are current as of the read.
      const rates = new Map<Address, bigint>();
      for (const info of tokens) {
        const row = onlyRow(assetRows, (candidate) => sameData(candidate, 'token', info.token));
        okRow(row);
        const price = u256(row, 'price');
        const priceValid = ownData(row, 'priceValid');
        const scale = u256(row, 'scale');
        const floor = u256(row, 'floor');
        const reserve = u256(row, 'reserve');
        const totalNominalDebt = u256(row, 'totalNominalDebt');
        const rateAccumulator = u256(row, 'rateAccumulator');
        const maxUtilization = u256(row, 'maxUtilization');
        // Vesu's scale is 10^decimals: anything else is not the pinned token.
        if (typeof priceValid !== 'boolean' || scale !== 10n ** BigInt(info.decimals) || maxUtilization > VESU_SCALE) throw invalid();
        rates.set(info.token, rateAccumulator);
        assets.push(Object.freeze({
          token: info.token,
          price,
          priceValid,
          scale,
          floor,
          reserve,
          totalDebt: vesuDebt(totalNominalDebt, rateAccumulator, scale, false),
          maxUtilization,
        }));
      }
      const pairs: BorrowPair[] = [];
      const maxLtvs = new Map<string, bigint>();
      for (const key of pairsOf(tokens)) {
        const row = onlyRow(pairRows, (candidate) => sameData(candidate, 'collateral', key.collateral) && sameData(candidate, 'debt', key.debt));
        okRow(row);
        const maxLtv = u256(row, 'maxLtv');
        const liquidationFactor = u256(row, 'liquidationFactor');
        const debtCap = u256(row, 'debtCap');
        const totalNominalDebt = u256(row, 'totalNominalDebt');
        if (maxLtv > VESU_SCALE || liquidationFactor > VESU_SCALE || debtCap > MAX_U128) throw invalid();
        const debtAsset = assets.find((asset) => asset.token === key.debt)!;
        const pair: BorrowPair = Object.freeze({
          collateral: key.collateral,
          debt: key.debt,
          maxLtv,
          liquidationFactor,
          debtCap,
          totalDebt: vesuDebt(totalNominalDebt, rates.get(key.debt)!, debtAsset.scale, true),
        });
        maxLtvs.set(`${key.collateral}:${key.debt}`, maxLtv);
        if (borrowPairOffered(pair)) pairs.push(pair);
      }
      return Object.freeze({ assets: Object.freeze(assets), pairs: Object.freeze(pairs), maxLtv: maxLtvs });
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw error instanceof PrivacyError ? error : invalid();
    }
  }

  /** One public read of every pinned pair's position for `address`, and `pairs`' rows out of it, in order. */
  private async readPositions(
    address: Address,
    pairs: readonly BorrowPairKey[],
    signal: AbortSignal | undefined,
    onStage: VaultStageCallback | undefined,
    market: MarketRead,
  ): Promise<BorrowPosition[]> {
    const reads = this.reads;
    if (!reads) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw new PrivacyError('unknown', 'The borrow reads are not configured.');
    }
    let answer: unknown;
    try {
      answer = await reads.borrowPositions(address, signal);
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throwIfAborted(signal);
      throw error instanceof PrivacyError ? error : new PrivacyError('unreachable', 'The borrow counter could not read its loans.', error);
    }
    throwIfAborted(signal);
    const positions: BorrowPosition[] = [];
    try {
      const rows = ownRows(answer);
      for (const key of pairs) {
        const row = onlyRow(rows, (candidate) => sameData(candidate, 'collateral', key.collateral) && sameData(candidate, 'debt', key.debt));
        okRow(row);
        const collateralAmount = u256(row, 'collateralAmount');
        const debtAmount = u256(row, 'debtAmount');
        positions.push(Object.freeze({
          collateral: key.collateral,
          debt: key.debt,
          collateralShares: u256(row, 'collateralShares'),
          nominalDebt: u256(row, 'nominalDebt'),
          collateralAmount,
          debtAmount,
          health: borrowHealth({
            collateralAmount,
            debtAmount,
            collateral: market.assets.find((asset) => asset.token === key.collateral)!,
            debt: market.assets.find((asset) => asset.token === key.debt)!,
            // Every pinned pair's own setting, offered or not: a loan in a
            // pair Vesu stopped offering is still measured by its own max LTV.
            maxLtv: market.maxLtv.get(`${key.collateral}:${key.debt}`) ?? 0n,
          }),
        }));
      }
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw error instanceof PrivacyError ? error : invalid();
    }
    emitStage(onStage, { stage: 'position', ok: true });
    return positions;
  }

  /**
   * The pinned tokens the policy admits, in its order. The route must be on
   * and its list non-empty, every token on it pinned and listed once: a list
   * with anything else keeps the whole counter shut. Absent admits nothing.
   */
  private admittedTokens(): readonly BorrowTokenInfo[] {
    const listed = this.policy.allowedTokens.borrow;
    if (!this.policy.enabledRoutes.includes('borrow') || !Array.isArray(listed) || listed.length === 0) {
      throw new PrivacyError('unknown', 'The borrow route is disabled.');
    }
    const tokens: BorrowTokenInfo[] = [];
    for (const token of listed) {
      const info = borrowToken(token);
      if (!info || tokens.includes(info)) throw new PrivacyError('unknown', 'The borrow route is disabled.');
      tokens.push(info);
    }
    return Object.freeze(tokens);
  }
}

/** Why a refusal stops a prepare, said plainly (D-083). No figure, address or amount. */
export function refusalMessage(reason: BorrowRefusal): string {
  switch (reason) {
    case 'amount': return 'Amounts must be positive u256 values.';
    case 'unknown-pair': return 'The borrow counter does not offer that pair in this build.';
    case 'pair-not-offered': return 'Vesu does not offer new loans in that pair right now.';
    case 'stale-price': return "Vesu's price feed for that pair is stale, so Vesu refuses every change to it until the feed updates.";
    case 'above-max-ltv': return "That would take the loan above the pair's max LTV, so Vesu would refuse it.";
    case 'too-close-to-liquidation': return 'That would leave the loan too close to liquidation to send safely.';
    case 'review-expired': return 'This review is more than two minutes old. Prepare it again.';
    case 'debt-below-floor': return "The debt left would be below Vesu's minimum. Repay it all instead, or borrow more.";
    case 'collateral-below-floor': return "The collateral left would be below Vesu's minimum for a loan.";
    case 'debt-cap': return "That would pass the pair's debt cap.";
    case 'utilization': return 'Vesu cannot lend or release that much of the token right now.';
    case 'nothing-to-repay': return 'There is no debt to repay in that pair.';
    case 'repay-exceeds-debt': return 'That is the whole debt or more. Repay it all instead.';
    case 'withdraw-exceeds-collateral': return 'That is more collateral than the loan holds.';
    case 'withdraw-all-with-debt': return 'Repay the debt before withdrawing all the collateral.';
  }
}

/** Every admitted ordered pair, collateral-major in the pinned order. */
function pairsOf(tokens: readonly BorrowTokenInfo[]): readonly BorrowPairKey[] {
  return BORROW_PAIRS.filter((pair) => tokens.some((info) => info.token === pair.collateral) && tokens.some((info) => info.token === pair.debt));
}

/** The request as own data, in one of its four shapes, or a refusal before anything is asked of anyone. */
function ownRequest(request: unknown): BorrowRequest {
  const bad = (): PrivacyError => new PrivacyError('unknown', 'The borrow request is invalid.');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw bad();
  const kind = ownData(request, 'kind');
  const collateral = ownData(request, 'collateral');
  const debt = ownData(request, 'debt');
  if (typeof collateral !== 'string' || typeof debt !== 'string') throw bad();
  const amountOrAll = (value: unknown): bigint | 'all' => {
    if (value === 'all') return 'all';
    if (typeof value !== 'bigint' || value <= 0n || value > MAX_UINT256) throw new PrivacyError('unknown', 'Amounts must be positive u256 values.');
    return value;
  };
  switch (kind) {
    case 'borrow': {
      const collateralAmount = ownData(request, 'collateralAmount');
      const borrowAmount = ownData(request, 'borrowAmount');
      if (
        typeof collateralAmount !== 'bigint' || collateralAmount < 0n || collateralAmount > MAX_UINT256
        || typeof borrowAmount !== 'bigint' || borrowAmount <= 0n || borrowAmount > MAX_UINT256
      ) {
        throw new PrivacyError('unknown', 'Amounts must be positive u256 values.');
      }
      return Object.freeze({ kind, collateral, debt, collateralAmount, borrowAmount });
    }
    case 'add-collateral': {
      const amount = amountOrAll(ownData(request, 'amount'));
      if (amount === 'all') throw bad();
      return Object.freeze({ kind, collateral, debt, amount });
    }
    case 'repay':
      return Object.freeze({ kind, collateral, debt, amount: amountOrAll(ownData(request, 'amount')) });
    case 'withdraw-collateral':
      return Object.freeze({ kind, collateral, debt, amount: amountOrAll(ownData(request, 'amount')) });
    default:
      throw bad();
  }
}

function invalid(): PrivacyError {
  return new PrivacyError('unknown', 'The borrow read is invalid.');
}

/** A read's rows, copied by index: an array of own data items, and not too many. */
function ownRows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid();
  let length: number;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value)) throw new Error();
    length = descriptor.value as number;
  } catch {
    throw invalid();
  }
  if (length > BORROW_PAIRS.length) throw invalid();
  const rows: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw invalid();
    }
    if (!descriptor || !('value' in descriptor)) throw invalid();
    rows.push(descriptor.value);
  }
  return rows;
}

/** The one row matching; none or two is malformed. */
function onlyRow(rows: readonly unknown[], matches: (row: unknown) => boolean): unknown {
  const matching = rows.filter(matches);
  if (matching.length !== 1) throw invalid();
  return matching[0];
}

/** A row the backend read: `ok: false` is unreachable, anything else but `true` malformed. */
function okRow(row: unknown): void {
  const ok = ownData(row, 'ok');
  if (ok === false) throw new PrivacyError('unreachable', "The borrow counter could not read Vesu's pool.");
  if (ok !== true) throw invalid();
}

function sameData(row: unknown, key: string, expected: string): boolean {
  const value = ownData(row, key);
  return typeof value === 'string' && sameAddress(value, expected);
}

function u256(row: unknown, key: string): bigint {
  const value = ownData(row, key);
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) throw invalid();
  return value;
}
