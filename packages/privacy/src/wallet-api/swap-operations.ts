import type { STRK20_ACTION } from 'starknet';
import type { BatchWarning, Intent, PoolConfig, PreparedBatch } from '../operations.js';
import { PrivacyError, type Address, type OperationProgress, type ProgressCallback } from '../types.js';
import { MAINNET_CHAIN_ID, SWAP_DAPP_NAME, SWAP_SHADOW_NONCE, ownSwapQuote, swapActions, type SwapQuote } from '../swap.js';
import { mapShadowWalletError, mapWalletError } from './errors.js';
import { ShadowAccountResolver } from './shadow-account.js';
import type { SwapQuoteClient, VaultReadClient, WalletRoutePolicy, WalletStrk20Account } from './types.js';
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
 * - A quote older than `SWAP_QUOTE_TTL_MS` at confirmation is asked for again
 *   before the wallet is: a fresh floor at or above the reviewed one goes
 *   ahead, anything lower stops with nothing sent.
 */

export interface ShadowSwapOptions {
  readonly wallet: WalletStrk20Account;
  readonly walletAddress: Address;
  readonly reads?: Pick<VaultReadClient, 'shadowAccount'>;
  readonly quotes?: SwapQuoteClient;
  readonly policy: WalletRoutePolicy;
  /** The operations' own capability answer: `supportsShadowAccounts`. */
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  /** The operations' own validated pool config read. */
  readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  /** The operations' own checked clock. */
  readonly now: () => number;
}

type SwapIntent = Extract<Intent, { kind: 'swap' }>;

/** Said when a re-quote at confirmation would lower the floor the player reviewed. */
export const SWAP_FLOOR_MOVED_MESSAGE = 'The swap price moved below the minimum you reviewed. Nothing was sent; review the new quote.';

export class ShadowSwap {
  private readonly wallet: WalletStrk20Account;
  private readonly walletAddress: Address;
  private readonly quotes?: SwapQuoteClient;
  private readonly policy: WalletRoutePolicy;
  private readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  private readonly now: () => number;
  private readonly identity: ShadowAccountResolver;

  constructor(options: ShadowSwapOptions) {
    this.wallet = options.wallet;
    this.walletAddress = options.walletAddress;
    this.quotes = options.quotes;
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
    if (!Number.isSafeInteger(swapPolicy.slippageBps) || swapPolicy.slippageBps <= 0 || swapPolicy.slippageBps > 10_000) {
      throw new PrivacyError('unknown', 'The private swap slippage policy is invalid.');
    }
    if (!sameAddress(swapPolicy.expectedChainId, MAINNET_CHAIN_ID)) {
      throw new PrivacyError('unknown', 'The private swap runs on mainnet only.');
    }
    if (sameAddress(intent.tokenIn, intent.tokenOut)) {
      throw new PrivacyError('unknown', 'A swap needs two different tokens.');
    }
    const identity = await this.identity.resolve(signal, undefined);
    throwIfAborted(signal);
    const quote = await this.quote(intent, identity.address, swapPolicy.slippageBps, signal);
    if (quote.minAmountOut < intent.minAmountOut) {
      throw new PrivacyError('unknown', 'The requested swap floor exceeds the protected minimum.');
    }
    // Frozen: published on the batch, and the floor a re-quote must meet.
    const canonicalIntent: SwapIntent = Object.freeze({ ...intent, minAmountOut: quote.minAmountOut });
    const reviewed = freezeActions(this.actions(quote, identity.address));
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
      swapReview: Object.freeze({
        expectedAmountOut: quote.buyAmount,
        minimumAmountOut: quote.minAmountOut,
        slippageBps: quote.slippageBps,
        expiresAt: quote.expiresAt,
      }),
      async confirm(opts) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        const { feeCeiling, onProgress, signal: confirmSignal } = ownConfirmOptions(opts);
        if (attempted) {
          throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
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
            const fresh = await owner.quote(canonicalIntent, identity.address, quote.slippageBps, confirmSignal);
            if (fresh.minAmountOut < canonicalIntent.minAmountOut) {
              throw new PrivacyError('unknown', SWAP_FLOOR_MOVED_MESSAGE);
            }
            actions = freezeActions(owner.actions(fresh, identity.address));
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

  /** Ask the backend for avnu's quote for the stand-in, and own it. */
  private async quote(intent: SwapIntent, taker: Address, slippageBps: number, signal?: AbortSignal): Promise<SwapQuote> {
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
    return ownSwapQuote(answer, request, this.now());
  }

  private actions(quote: SwapQuote, shadowAccount: Address): STRK20_ACTION[] {
    return swapActions({ quote, shadowAccount, player: this.walletAddress });
  }
}

function ownConfirmOptions(options: unknown): {
  feeCeiling: bigint;
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
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
  return { feeCeiling, onProgress: onProgress as ProgressCallback | undefined, signal: signal as AbortSignal | undefined };
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
