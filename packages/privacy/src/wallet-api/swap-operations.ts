import type { STRK20_ACTION } from 'starknet';
import type { BatchWarning, Intent, PoolConfig, PreparedBatch, SwapPriceCheck } from '../operations.js';
import { PrivacyError, type Address, type OperationProgress, type ProgressCallback } from '../types.js';
import { MAINNET_CHAIN_ID, SWAP_DAPP_NAME, SWAP_SHADOW_NONCE, ownSwapQuote, swapActions, type SwapQuote } from '../swap.js';
import { SWAP_MAX_SLIPPAGE_BPS, checkSwapPrice, type PragmaPrice } from '../swap-prices.js';
import { mapShadowWalletError, mapWalletError } from './errors.js';
import { withLedgerTick } from '../leaderboard.js';
import { noticeLeaderboard } from '../leaderboard-notice.js';
import { ShadowAccountResolver } from './shadow-account.js';
import type { SwapPriceReader, SwapQuoteClient, VaultReadClient, WalletRoutePolicy, WalletStrk20Account } from './types.js';
import { freezeActions, submitThroughWallet } from './wallet-submission.js';

/**
 * The private swap on the Wallet API (D-084): the Exchange and the degen
 * floor trade through the player's shadow account for `SWAP_DAPP_NAME`.
 *
 * - The stand-in address is resolved exactly as the Vault's is
 *   (`ShadowAccountResolver`): capability, the wallet's partial commitment,
 *   the anonymizer's view, cross-checked against the Primer derivation.
 * - The quote is avnu's public, keyless one, read through the backend's
 *   thin proxy with the stand-in as taker, and owned by `ownSwapQuote`
 *   before the player sees a price.
 * - The wallet proves **and submits** the swap
 *   (`wallet_strk20InvokeTransaction`) through `wallet-submission.ts`, as it
 *   does the Vault and every pool spend: no relay, no avnu key, no relay fee.
 * - Every quote is held against Pragma's oracle price, read over the
 *   wallet's own RPC (`swap-prices.ts`): a quote worth more than 3% less than
 *   the input is refused, and a pair with no oracle price is reviewed as
 *   unchecked and needs the player's explicit acknowledgement to confirm.
 * - A quote older than `SWAP_QUOTE_TTL_MS` at confirmation is asked for again
 *   before the wallet is: a fresh floor at or above the reviewed one goes
 *   ahead, anything lower stops with nothing sent.
 */

export interface ShadowSwapOptions {
  readonly wallet: WalletStrk20Account;
  readonly walletAddress: Address;
  readonly reads?: Pick<VaultReadClient, 'shadowAccount'>;
  readonly quotes?: SwapQuoteClient;
  /** The independent price reference (D-084). Absent, every swap fails closed. */
  readonly prices?: SwapPriceReader;
  readonly policy: WalletRoutePolicy;
  /** The operations' own capability answer: `supportsShadowAccounts`. */
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  /** The operations' own validated pool config read. */
  readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  /** The operations' own checked clock. */
  readonly now: () => number;
  /** Leaderboard phase 1: the ledger each swap ticks. Absent, nothing is appended. */
  readonly ledger?: Address;
}

type SwapIntent = Extract<Intent, { kind: 'swap' }>;

/** Said when a re-quote at confirmation would lower the floor the player reviewed. */
export const SWAP_FLOOR_MOVED_MESSAGE = 'The swap price moved below the minimum you reviewed. Nothing was sent; review the new quote.';

/** Said when an unchecked swap is confirmed without the player's acknowledgement. */
export const SWAP_UNCHECKED_PRICE_MESSAGE = 'This swap has no independent price check. Acknowledge that before confirming.';

interface CheckedQuote {
  readonly quote: SwapQuote;
  readonly check: SwapPriceCheck;
}

export class ShadowSwap {
  private readonly wallet: WalletStrk20Account;
  private readonly walletAddress: Address;
  private readonly quotes?: SwapQuoteClient;
  private readonly prices?: SwapPriceReader;
  private readonly policy: WalletRoutePolicy;
  private readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  private readonly now: () => number;
  private readonly identity: ShadowAccountResolver;
  private readonly ledger?: Address;

  constructor(options: ShadowSwapOptions) {
    this.wallet = options.wallet;
    this.ledger = options.ledger;
    this.walletAddress = options.walletAddress;
    this.quotes = options.quotes;
    this.prices = options.prices;
    this.policy = options.policy;
    this.poolConfig = options.poolConfig;
    this.now = options.now;
    this.identity = new ShadowAccountResolver({
      wallet: options.wallet,
      dappName: SWAP_DAPP_NAME,
      nonce: SWAP_SHADOW_NONCE,
      ...(options.reads ? { reads: options.reads } : {}),
      supported: options.supported,
      subject: 'Exchange',
    });
  }

  /**
   * Quote and build one swap, already admitted by `validateIntents`. The
   * intent's `minAmountOut` is the floor the caller asks for at least; the
   * published intent carries the quote's own floor, which the chain enforces.
   */
  async prepare(
    intent: SwapIntent,
    config: PoolConfig,
    warnings: readonly BatchWarning[],
    signal?: AbortSignal,
  ): Promise<PreparedBatch> {
    const swapPolicy = this.policy.swap;
    if (!swapPolicy || !this.quotes) {
      throw new PrivacyError('unknown', 'The private swap quotes are not configured.');
    }
    if (!Number.isSafeInteger(swapPolicy.slippageBps) || swapPolicy.slippageBps <= 0 || swapPolicy.slippageBps > SWAP_MAX_SLIPPAGE_BPS) {
      throw new PrivacyError('unknown', 'The private swap slippage policy is invalid.');
    }
    if (!sameAddress(swapPolicy.expectedChainId, MAINNET_CHAIN_ID)) {
      throw new PrivacyError('unknown', 'The private swap runs on mainnet only.');
    }
    if (sameAddress(intent.tokenIn, intent.tokenOut)) {
      throw new PrivacyError('unknown', 'A swap needs two different tokens.');
    }
    // D-090: the player's slippage, at or below the build's ceiling, or the ceiling itself.
    const slippageBps = intent.slippageBps ?? swapPolicy.slippageBps;
    if (!Number.isSafeInteger(slippageBps) || slippageBps <= 0 || slippageBps > swapPolicy.slippageBps) {
      throw new PrivacyError('unknown', "The swap's slippage is outside what this build allows.");
    }
    const identity = await this.identity.resolve(signal, undefined);
    throwIfAborted(signal);
    const { quote, check } = await this.quote(intent, identity.address, slippageBps, signal);
    if (quote.minAmountOut < intent.minAmountOut) {
      throw new PrivacyError('unknown', 'The requested swap floor exceeds the protected minimum.');
    }
    // Frozen: published on the batch, and the floor a re-quote must meet.
    const canonicalIntent: SwapIntent = Object.freeze({ ...intent, minAmountOut: quote.minAmountOut });
    // Leaderboard phase 1 (DeFi mode): the stand-in's commitment, from the
    // partial `resolve` already asked for. Null with the leaderboard off.
    const tick = this.ledger ? await this.identity.fullCommitment() : null;
    const reviewed = freezeActions(this.actions(quote, identity.address, tick));
    // D-069: reported once for the prepare, not again for a re-quote's rebuild.
    noticeLeaderboard(tick ? { event: 'tick', feature: 'swap' } : { event: 'receipt', attached: false, reason: 'no-ledger' });
    const owner = this;
    let discarded = false;
    let attempted = false;
    return {
      intents: Object.freeze([canonicalIntent]),
      poolFee: config.feeAmount,
      gasEstimate: 0n,
      totalCost: config.feeAmount,
      warnings,
      promptCount: 1,
      ...(tick ? { countsTowardPlacement: true as const } : {}),
      swapReview: Object.freeze({
        expectedAmountOut: quote.buyAmount,
        minimumAmountOut: quote.minAmountOut,
        slippageBps: quote.slippageBps,
        expiresAt: quote.expiresAt,
        priceCheck: check,
      }),
      async confirm(opts) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        const { feeCeiling, onProgress, signal: confirmSignal, acknowledged } = ownConfirmOptions(opts);
        if (attempted) {
          throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
        }
        if (check.status === 'unchecked' && !acknowledged) {
          throw new PrivacyError('unknown', SWAP_UNCHECKED_PRICE_MESSAGE);
        }
        attempted = true;
        throwIfAborted(confirmSignal);
        let transactionHash: string;
        try {
          const current = await owner.poolConfig(confirmSignal);
          throwIfAborted(confirmSignal);
          if (current.feeAmount > feeCeiling) {
            throw new PrivacyError('unknown', `The current fee ${current.feeAmount} is above the ceiling ${feeCeiling}.`);
          }
          let actions = reviewed;
          if (quote.expiresAt <= owner.now()) {
            // A stale quote is asked for again before the wallet is. The
            // floor may only hold or rise: the player reviewed this one.
            // The fresh quote passes the same oracle check, or it throws.
            const fresh = await owner.quote(canonicalIntent, identity.address, quote.slippageBps, confirmSignal);
            if (fresh.quote.minAmountOut < canonicalIntent.minAmountOut) {
              throw new PrivacyError('unknown', SWAP_FLOOR_MOVED_MESSAGE);
            }
            actions = freezeActions(owner.actions(fresh.quote, identity.address, tick));
          }
          if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
          throwIfAborted(confirmSignal);
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm the private swap in your wallet' });
          emitProgress(onProgress, { stage: 'proving', message: 'Your wallet is generating a proof' });
          try {
            transactionHash = await submitThroughWallet(owner.wallet, actions);
          } catch (error) {
            // A wallet that answers the shadow-account action as an API
            // version or method it lacks cannot swap here; that must not read
            // as the wallet lacking STRK20, which would close the city.
            throw mapShadowWalletError(error);
          }
        } catch (error) {
          emitProgress(onProgress, { stage: 'failed', message: 'Private swap failed' });
          throw error instanceof PrivacyError ? error : mapWalletError(error);
        }
        // The wallet has submitted: nothing below may turn that into a
        // failure, and an abort or a discard now cannot unsend it.
        emitProgress(onProgress, { stage: 'submitting', message: 'Your wallet submitted it' });
        emitProgress(onProgress, { stage: 'done', message: 'Done' });
        return Object.freeze({ transactionHash });
      },
      discard() { discarded = true; },
    };
  }

  /** Ask the backend for avnu's quote for the stand-in, own it, and hold it against the oracle. */
  private async quote(intent: SwapIntent, taker: Address, slippageBps: number, signal?: AbortSignal): Promise<CheckedQuote> {
    const quotes = this.quotes;
    if (!quotes) throw new PrivacyError('unknown', 'The private swap quotes are not configured.');
    const request = Object.freeze({
      sellToken: intent.tokenIn,
      buyToken: intent.tokenOut,
      sellAmount: intent.amountIn,
      taker,
      slippageBps,
    });
    let answer: unknown;
    try {
      answer = await quotes.quoteSwap({ ...request, ...(signal ? { signal } : {}) });
    } catch (error) {
      throwIfAborted(signal);
      throw error instanceof PrivacyError
        ? error
        : new PrivacyError('unreachable', 'The swap quote could not be read.', error);
    }
    throwIfAborted(signal);
    const quote = ownSwapQuote(answer, request, this.now());
    const reader = this.prices;
    if (!reader) throw new PrivacyError('unknown', 'The swap price reference is not configured.');
    let prices: readonly PragmaPrice[] | null;
    try {
      prices = await reader.read(signal);
    } catch {
      throwIfAborted(signal);
      prices = null;
    }
    throwIfAborted(signal);
    const check = checkSwapPrice({
      sellToken: quote.sellToken,
      buyToken: quote.buyToken,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      minAmountOut: quote.minAmountOut,
      slippageBps: quote.slippageBps,
      prices,
      nowMs: this.now(),
    });
    return Object.freeze({ quote, check });
  }

  private actions(quote: SwapQuote, shadowAccount: Address, tick: string | null): STRK20_ACTION[] {
    const built = swapActions({ quote, shadowAccount, player: this.walletAddress });
    return tick && this.ledger ? withLedgerTick(built, this.ledger, tick) : built;
  }

  /** Leaderboard phase 1: the swap stand-in's commitment, whose ledger ticks count toward the placement. */
  ledgerCommitment(): Promise<string> {
    return this.identity.fullCommitment();
  }

  /** Leaderboard phase 1: this counter's partial commitment, sent to the tally only when it ranks DeFi. */
  ledgerPartial(): Promise<string> {
    return this.identity.partial();
  }
}

function ownConfirmOptions(options: unknown): {
  feeCeiling: bigint;
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
  acknowledged: boolean;
} {
  const read = (key: string): unknown => {
    if (!options || typeof options !== 'object') throw invalidOptions();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(options, key);
    } catch {
      throw invalidOptions();
    }
    if (descriptor === undefined) return undefined;
    if (!('value' in descriptor)) throw invalidOptions();
    return descriptor.value;
  };
  const feeCeiling = read('feeCeiling');
  if (typeof feeCeiling !== 'bigint' || feeCeiling < 0n || feeCeiling >= 1n << 256n) {
    throw new PrivacyError('unknown', 'The fee ceiling must be a u256 bigint.');
  }
  const onProgress = read('onProgress');
  const signal = read('signal');
  if ((onProgress !== undefined && typeof onProgress !== 'function') || (signal !== undefined && !isAbortSignalLike(signal))) {
    throw invalidOptions();
  }
  const acknowledge = read('acknowledgeUncheckedPrice');
  if (acknowledge !== undefined && typeof acknowledge !== 'boolean') throw invalidOptions();
  return {
    feeCeiling,
    onProgress: onProgress as ProgressCallback | undefined,
    signal: signal as AbortSignal | undefined,
    acknowledged: acknowledge === true,
  };
}

function invalidOptions(): PrivacyError {
  return new PrivacyError('unknown', 'The confirmation options are invalid.');
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return true;
  return Boolean(value && typeof value === 'object' && typeof (value as { aborted?: unknown }).aborted === 'boolean');
}

function emitProgress(callback: ProgressCallback | undefined, progress: OperationProgress): void {
  try {
    callback?.(Object.freeze({ ...progress }));
  } catch {
    /* Observers cannot alter a financial operation. */
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
}

function sameAddress(a: unknown, b: unknown): boolean {
  try { return typeof a === 'string' && typeof b === 'string' && BigInt(a) === BigInt(b); } catch { return false; }
}
