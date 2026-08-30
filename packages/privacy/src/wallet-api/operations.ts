import { buildStrk20Actions, type PrivateSwapPlan } from '@avnu/avnu-sdk';
import { num, transaction, type STRK20_ACTION } from 'starknet';
import type {
  BatchWarning,
  Intent,
  PoolConfig,
  PreparedBatch,
  PrivacyOperations,
  WalletCapability,
} from '../operations.js';
import {
  PrivacyError,
  type Address,
  type OperationProgress,
  type PrivateBalance,
  type ProgressCallback,
  type RecipientStatus,
  type TxResult,
} from '../types.js';
import { protectedMinimumOut } from '../protected-minimum.js';
import { mapWalletError } from './errors.js';
import type {
  PoolNativeRoute,
  PoolReadClient,
  PrivateSubmissionGateway,
  PreparedPrivateSwap,
  RelayFeeQuote,
  SupportedVersionsReader,
  WalletRoutePolicy,
  WalletStrk20Account,
} from './types.js';

const REQUIRED_WALLET_API = '0.10.3';
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface WalletApiPrivacyOperationsOptions {
  wallet: WalletStrk20Account;
  pool: PoolReadClient;
  submission: PrivateSubmissionGateway;
  supportedVersions: SupportedVersionsReader;
  policy: WalletRoutePolicy;
  now?: () => number;
}

export class WalletApiPrivacyOperations implements PrivacyOperations {
  private readonly wallet: WalletStrk20Account;
  private readonly pool: PoolReadClient;
  private readonly submission: PrivateSubmissionGateway;
  private readonly supportedVersions: SupportedVersionsReader;
  private readonly policy: WalletRoutePolicy;
  private readonly now: () => number;

  constructor(options: WalletApiPrivacyOperationsOptions) {
    this.wallet = options.wallet;
    this.pool = options.pool;
    this.submission = options.submission;
    this.supportedVersions = options.supportedVersions;
    this.policy = options.policy;
    this.now = options.now ?? Date.now;
  }

  async capability(signal?: AbortSignal): Promise<WalletCapability> {
    throwIfAborted(signal);
    try {
      const versions = await this.supportedVersions(signal);
      throwIfAborted(signal);
      const supported = versions
        .map((raw) => ({ raw, parsed: parseSemver(raw) }))
        .filter((version): version is { raw: string; parsed: Semver } => version.parsed !== null)
        .sort((left, right) => compareSemver(left.parsed, right.parsed));
      const highest = supported.at(-1) ?? null;
      return {
        supportsStrk20: highest !== null && compareSemver(highest.parsed, REQUIRED_VERSION) >= 0,
        walletApiVersion: highest?.raw ?? null,
        registration: 'unknown',
      };
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async poolConfig(signal?: AbortSignal): Promise<PoolConfig> {
    throwIfAborted(signal);
    try {
      const config = await this.pool.config(signal);
      throwIfAborted(signal);
      return config;
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async balances(tokens: string[] = [], signal?: AbortSignal): Promise<PrivateBalance[]> {
    throwIfAborted(signal);
    try {
      const balances = await this.wallet.strk20Balances(tokens);
      throwIfAborted(signal);
      if (!Array.isArray(balances)) {
        throw new PrivacyError('unknown', 'The wallet returned an invalid balance response.');
      }
      return balances.map(({ token, balance }) => {
        if (typeof token !== 'string' || !isFelt(token) || typeof balance !== 'string' || !isFelt(balance)) {
          throw new PrivacyError('unknown', 'The wallet returned an invalid balance.');
        }
        const total = BigInt(balance);
        if (total < 0n) {
          throw new PrivacyError('unknown', 'The wallet returned an invalid balance.');
        }
        return {
          token,
          total,
          spendable: 0n,
          maturing: 0n,
          maturityKnown: false,
        };
      });
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async recipientStatus(address: string, signal?: AbortSignal): Promise<RecipientStatus> {
    throwIfAborted(signal);
    assertAddress(address, 'recipient');
    try {
      const key = await this.pool.publicKey(address, signal);
      throwIfAborted(signal);
      if (!isFelt(key)) return 'unknown';
      return BigInt(key) === 0n ? 'unregistered' : 'registered';
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      return 'unknown';
    }
  }

  async prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch> {
    throwIfAborted(signal);
    // Take ownership before validating, not after. Everything downstream — the
    // admission checks, the costing, the warnings the player reads, the
    // published batch and the actions `confirm()` finally proves — reads this
    // one frozen graph, so there is no window in which the reviewed batch and
    // the proved batch can differ, and no handle with which a caller could
    // open one.
    const reviewed = freezeIntents(intents);
    validateIntents(reviewed, this.policy);
    const kinds = new Set(reviewed.map((intent) => intent.kind));
    const hasShield = kinds.has('shield');
    if (hasShield && kinds.size > 1) {
      throw new PrivacyError(
        'privacy-leak',
        'Shielding and private spending must be prepared as separate operations.',
      );
    }
    if (!hasShield && kinds.size > 1) {
      throw new PrivacyError('unknown', 'A private batch may contain only one approved route type.');
    }

    const config = await this.poolConfig(signal);
    const warnings = await this.warningsFor(reviewed, signal);
    if (hasShield) return this.prepareShield(reviewed, config, warnings);
    if (kinds.has('swap')) {
      if (reviewed.length !== 1 || reviewed[0]?.kind !== 'swap') {
        throw new PrivacyError('unknown', 'A private swap must be prepared one at a time.');
      }
      return this.prepareSwap(reviewed[0], config, warnings, signal);
    }

    const route = reviewed[0]!.kind as PoolNativeRoute;
    const operationToken = tokenFor(reviewed[0]!);
    const fee = await this.estimateRelay(route, operationToken, config, signal);
    return this.preparePrivate(reviewed, route, operationToken, config, fee, warnings);
  }

  private async prepareSwap(
    intent: Extract<Intent, { kind: 'swap' }>,
    config: PoolConfig,
    warnings: BatchWarning[],
    signal?: AbortSignal,
  ): Promise<PreparedBatch> {
    const swapPolicy = this.policy.swap;
    const prepareSwap = this.submission.prepareSwap?.bind(this.submission);
    if (!swapPolicy || !prepareSwap) {
      throw new PrivacyError('unknown', 'The private swap gateway is not configured.');
    }
    if (!Number.isSafeInteger(swapPolicy.slippageBps) || swapPolicy.slippageBps <= 0) {
      throw new PrivacyError('unknown', 'The private swap slippage policy is invalid.');
    }
    const plan = await prepareSwap({
      sellToken: intent.tokenIn,
      buyToken: intent.tokenOut,
      sellAmount: intent.amountIn,
      minAmountOut: intent.minAmountOut,
      slippageBps: swapPolicy.slippageBps,
      signal,
    });
    throwIfAborted(signal);
    this.validateSwapPlan(intent, config, plan, swapPolicy.expectedChainId);
    const protectedMinimum = protectedMinimumOut(plan.buyAmount, swapPolicy.slippageBps);
    if (protectedMinimum < intent.minAmountOut) {
      throw new PrivacyError(
        'unknown',
        'The requested swap floor exceeds AVNU’s protected minimum.',
      );
    }
    // Frozen because this object is both published on the batch and the sole
    // authority `assertPreparedSwapActions` recomputes the expected action set
    // from. A writable published copy would let a caller move the guard's
    // comparands and the action together, so the guard would confirm the
    // corruption instead of catching it.
    const canonicalIntent: Extract<Intent, { kind: 'swap' }> = Object.freeze({
      ...intent,
      minAmountOut: protectedMinimum,
    });

    const owner = this;
    let discarded = false;
    let confirmationAttempted = false;
    return {
      intents: Object.freeze([canonicalIntent]),
      poolFee: config.feeAmount,
      gasEstimate: plan.fee.amount,
      totalCost: config.feeAmount + plan.fee.amount,
      warnings,
      promptCount: 1,
      swapReview: {
        expectedAmountOut: plan.buyAmount,
        minimumAmountOut: canonicalIntent.minAmountOut,
        slippageBps: swapPolicy.slippageBps,
        expiresAt: plan.expiresAt,
      },
      async confirm({ feeCeiling, onProgress, signal: confirmSignal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFirstConfirmation(confirmationAttempted);
        confirmationAttempted = true;
        throwIfAborted(confirmSignal);
        let acceptedResult: TxResult | undefined;
        try {
          const current = await owner.pool.config(confirmSignal);
          throwIfAborted(confirmSignal);
          owner.validateSwapPlan(canonicalIntent, current, plan, swapPolicy.expectedChainId);
          assertFeeCeiling(current.feeAmount + plan.fee.amount, feeCeiling);
          // Snapshot the freshly validated calls, then hand the SDK its own
          // separate copy. Sharing one array would let an input-mutating SDK
          // corrupt the action *and* the authority the guard recomputes from,
          // making the comparison tautological.
          const reviewedCalls = snapshotExecutorCalls(plan.executorCalls);
          const avnuPlan: PrivateSwapPlan = {
            sellTokenAddress: canonicalIntent.tokenIn,
            sellAmount: canonicalIntent.amountIn,
            buyTokenAddress: canonicalIntent.tokenOut,
            executorAddress: plan.executorAddress,
            executorCalls: copyExecutorCalls(plan.executorCalls),
            fee: {
              token: plan.fee.token,
              recipient: plan.fee.recipient,
              amount: plan.fee.amount,
            },
            takerAddress: owner.wallet.address,
          };
          const actions = buildStrk20Actions(avnuPlan);
          assertPreparedSwapActions(actions, {
            sellToken: canonicalIntent.tokenIn,
            sellAmount: canonicalIntent.amountIn,
            buyToken: canonicalIntent.tokenOut,
            taker: owner.wallet.address,
            executor: plan.executorAddress,
            executorCalls: reviewedCalls,
            fee: plan.fee,
          });
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm the private swap in your wallet' });
          emitProgress(onProgress, { stage: 'proving', message: 'Your wallet is generating a proof' });
          const artifact = await owner.wallet.strk20PrepareInvoke(actions, false);
          throwIfAborted(confirmSignal);
          emitProgress(onProgress, { stage: 'submitting', message: 'Submitting the quote-bound private swap' });
          const result = await owner.submission.submit({
            route: 'swap',
            artifact,
            feeAuthorization: plan.fee.authorization,
            proofValidityBlocks: current.proofValidityBlocks,
            signal: confirmSignal,
            onAccepted(result) { acceptedResult = result; },
          });
          emitProgress(onProgress, { stage: 'done', message: 'Done' });
          return result;
        } catch (error) {
          if (acceptedResult) {
            emitProgress(onProgress, { stage: 'done', message: 'Done' });
            return acceptedResult;
          }
          emitProgress(onProgress, { stage: 'failed', message: 'Private swap failed' });
          throw mapWalletError(error);
        }
      },
      discard() { discarded = true; },
    };
  }

  private validateSwapPlan(
    intent: Extract<Intent, { kind: 'swap' }>,
    config: PoolConfig,
    plan: PreparedPrivateSwap,
    expectedChainId: string,
  ): void {
    if (plan.chainId !== expectedChainId) {
      throw new PrivacyError('unknown', 'The private swap quote is for the wrong network.');
    }
    if (typeof plan.buyAmount !== 'bigint' || plan.buyAmount <= 0n || plan.buyAmount > MAX_UINT256) {
      throw new PrivacyError('unknown', 'The private swap expected output is malformed.');
    }
    if (!Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= this.now()) {
      throw new PrivacyError('unknown', 'The private swap quote has expired.');
    }
    if (plan.buyAmount < intent.minAmountOut) {
      throw new PrivacyError('unknown', 'The private swap no longer meets the minimum output.');
    }
    assertAddress(plan.executorAddress, 'private swap executor');
    if (plan.executorCalls.length === 0) {
      throw new PrivacyError('unknown', 'The private swap contains no executor calls.');
    }
    for (const call of plan.executorCalls) {
      assertAddress(call.contractAddress, 'private swap call target');
      if (typeof call.entrypoint !== 'string' || call.entrypoint.trim().length === 0 || call.calldata.some((felt) => !isFelt(felt))) {
        throw new PrivacyError('unknown', 'The private swap contains malformed executor calls.');
      }
    }
    this.validateRelayFee(plan.fee, config);
  }

  private prepareShield(
    intents: readonly Intent[],
    config: PoolConfig,
    warnings: BatchWarning[],
  ): PreparedBatch {
    const wallet = this.wallet;
    const pool = this.pool;
    let discarded = false;
    let confirmationAttempted = false;
    return {
      // The frozen snapshot itself, not a copy of it: one owner, so the
      // published view and the actions built at confirmation cannot diverge.
      intents,
      poolFee: config.feeAmount,
      gasEstimate: 0n,
      totalCost: config.feeAmount,
      warnings,
      promptCount: 1,
      async confirm({ feeCeiling, onProgress, signal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFirstConfirmation(confirmationAttempted);
        confirmationAttempted = true;
        throwIfAborted(signal);
        try {
          const current = await pool.config(signal);
          throwIfAborted(signal);
          assertFeeCeiling(current.feeAmount, feeCeiling);
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm the shield in your wallet' });
          const result = await wallet.strk20InvokeTransaction(toActions(intents));
          // Once the wallet returns a transaction hash the public deposit may
          // already be on-chain. Do not turn that success into a retryable
          // cancellation merely because the caller aborted while it settled.
          emitProgress(onProgress, { stage: 'confirming', message: 'Shield submitted' });
          emitProgress(onProgress, { stage: 'done', message: 'Done' });
          return { transactionHash: result.transaction_hash };
        } catch (error) {
          emitProgress(onProgress, { stage: 'failed', message: 'Shield failed' });
          throw mapWalletError(error);
        }
      },
      discard() { discarded = true; },
    };
  }

  private preparePrivate(
    intents: readonly Intent[],
    route: PoolNativeRoute,
    operationToken: string,
    config: PoolConfig,
    feeAtPrepare: RelayFeeQuote,
    warnings: BatchWarning[],
  ): PreparedBatch {
    const owner = this;
    let discarded = false;
    let confirmationAttempted = false;
    return {
      // The frozen snapshot itself — see prepareShield.
      intents,
      poolFee: config.feeAmount,
      gasEstimate: feeAtPrepare.amount,
      totalCost: config.feeAmount + feeAtPrepare.amount,
      warnings,
      promptCount: 1,
      async confirm({ feeCeiling, onProgress, signal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFirstConfirmation(confirmationAttempted);
        confirmationAttempted = true;
        throwIfAborted(signal);
        let acceptedResult: TxResult | undefined;
        try {
          const current = await owner.pool.config(signal);
          throwIfAborted(signal);
          const relayFee = await owner.estimateRelay(route, operationToken, current, signal);
          assertFeeCeiling(current.feeAmount + relayFee.amount, feeCeiling);
          const actions = [
            ...toActions(intents),
            {
              type: 'withdraw' as const,
              token: relayFee.token,
              amount: toFelt(relayFee.amount),
              recipient: relayFee.recipient,
            },
          ];
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm in your wallet' });
          emitProgress(onProgress, { stage: 'proving', message: 'Your wallet is generating a proof' });
          const artifact = await owner.wallet.strk20PrepareInvoke(actions, false);
          throwIfAborted(signal);
          emitProgress(onProgress, { stage: 'submitting', message: 'Queued for private submission' });
          const result = await owner.submission.submit({
            route,
            artifact,
            feeAuthorization: relayFee.authorization,
            proofValidityBlocks: current.proofValidityBlocks,
            signal,
            onAccepted(result) { acceptedResult = result; },
          });
          emitProgress(onProgress, { stage: 'done', message: 'Done' });
          return result;
        } catch (error) {
          if (acceptedResult) {
            emitProgress(onProgress, { stage: 'done', message: 'Done' });
            return acceptedResult;
          }
          emitProgress(onProgress, { stage: 'failed', message: 'Private operation failed' });
          throw mapWalletError(error);
        }
      },
      discard() { discarded = true; },
    };
  }

  private async estimateRelay(
    route: PoolNativeRoute,
    operationToken: string,
    config: PoolConfig,
    signal?: AbortSignal,
  ): Promise<RelayFeeQuote> {
    const fee = await this.submission.estimate({
      route,
      feeToken: config.feeToken,
      operationToken,
      signal,
    });
    throwIfAborted(signal);
    this.validateRelayFee(fee, config);
    return fee;
  }

  private validateRelayFee(fee: RelayFeeQuote, config: PoolConfig): void {
    if (!isFelt(fee.token) || !sameAddress(fee.token, config.feeToken)) {
      throw new PrivacyError('unknown', 'The relay returned an unexpected fee token.');
    }
    assertAddress(fee.recipient, 'relay fee recipient');
    if (fee.amount <= 0n || fee.amount > this.policy.maxRelayFee) {
      throw new PrivacyError('unknown', 'The relay fee exceeds the route policy.');
    }
    if (
      typeof fee.authorization !== 'string'
      || fee.authorization.trim().length === 0
      || !Number.isSafeInteger(fee.expiresAtBlock)
      || fee.expiresAtBlock <= 0
    ) {
      throw new PrivacyError('unknown', 'The relay returned no valid fee authorization.');
    }
  }

  private async warningsFor(intents: readonly Intent[], signal?: AbortSignal): Promise<BatchWarning[]> {
    const warnings: BatchWarning[] = [];
    for (const intent of intents) {
      if (intent.kind === 'shield') {
        warnings.push({
          kind: 'public-leg',
          detail: `Depositing ${intent.amount} is public: the amount and your address are visible on-chain.`,
        });
      } else if (intent.kind === 'unshield') {
        warnings.push({
          kind: 'public-leg',
          detail: `Withdrawing reveals the amount and ${intent.recipient} on-chain.`,
        });
      } else if (intent.kind === 'transfer') {
        const status = await this.recipientStatus(intent.recipient, signal);
        if (status === 'unregistered') {
          throw new PrivacyError(
            'not-registered',
            'The recipient is not registered with the privacy pool.',
          );
        }
        if (status === 'unknown') {
          throw new PrivacyError(
            'unreachable',
            'The recipient registration check could not be completed.',
          );
        }
      }
    }
    return warnings;
  }
}

/**
 * Take exclusive ownership of the intents a caller asked for.
 *
 * `Intent` is a flat union of strings and bigints, so freezing each copied
 * object and the array around them is a full deep freeze — the same reasoning
 * that makes `copyExecutorCalls` a deep copy at one level. `PreparedBatch`
 * already declares `readonly Intent[]`, but that modifier is erased at
 * runtime: without this, the published array held the caller's own objects and
 * `confirm()` re-read the caller's own array.
 */
function freezeIntents(intents: readonly Intent[]): readonly Intent[] {
  return Object.freeze(intents.map((intent) => Object.freeze({ ...intent })));
}

function validateIntents(intents: readonly Intent[], policy: WalletRoutePolicy): void {
  if (intents.length === 0) throw new PrivacyError('unknown', 'prepare called with no intents');
  if (intents.length > policy.maxIntents) throw new PrivacyError('unknown', 'Too many intents in one batch.');
  for (const intent of intents) {
    if (!policy.enabledRoutes.includes(intent.kind)) {
      throw new PrivacyError('unknown', `The ${intent.kind} route is disabled.`);
    }
    const amount = intent.kind === 'swap' ? intent.amountIn : intent.amount;
    if (amount <= 0n) throw new PrivacyError('unknown', 'Amounts must be positive.');
    if (intent.kind === 'swap' && intent.minAmountOut <= 0n) {
      throw new PrivacyError('unknown', 'Minimum output must be positive.');
    }
    assertAddress(intent.kind === 'swap' ? intent.tokenIn : intent.token, 'token');
    const allowed = policy.allowedTokens[intent.kind];
    const inputToken = intent.kind === 'swap' ? intent.tokenIn : intent.token;
    if (!allowed.some((token) => sameAddress(token, inputToken))) {
      throw new PrivacyError('unknown', `The ${intent.kind} input token is not allowlisted.`);
    }
    if (intent.kind === 'swap') {
      assertAddress(intent.tokenOut, 'output token');
      if (!allowed.some((token) => sameAddress(token, intent.tokenOut))) {
        throw new PrivacyError('unknown', 'The swap output token is not allowlisted.');
      }
    }
    if (intent.kind === 'unshield' || intent.kind === 'transfer') {
      assertAddress(intent.recipient, 'recipient');
    }
  }
}

/** Only the first open note is addressable, so AVNU emits exactly this literal. */
const OPEN_NOTE_PLACEHOLDER = '${openNoteIds[0]}';

/** What the wallet must be asked to prove, taken from validated sources only. */
interface ReviewedSwap {
  /** From the canonical intent, not from the object handed to the SDK. */
  sellToken: Address;
  sellAmount: bigint;
  buyToken: Address;
  /** The connected account, so the output note cannot be credited elsewhere. */
  taker: Address;
  /** From the validated plan. */
  executor: Address;
  /** From the validated plan; the only authority for the invoke payload. */
  executorCalls: readonly PreparedPrivateSwap['executorCalls'][number][];
  fee: RelayFeeQuote;
}

/**
 * Deep-copy the validated executor calls. Every field is a string or an array of
 * strings, so copying one array level is a full deep copy.
 */
function copyExecutorCalls(
  calls: readonly PreparedPrivateSwap['executorCalls'][number][],
): PreparedPrivateSwap['executorCalls'] {
  return calls.map((call) => ({
    contractAddress: call.contractAddress,
    entrypoint: call.entrypoint,
    calldata: [...call.calldata],
  }));
}

/**
 * The guard's authority, read-only by construction.
 *
 * Deliberately applied only to the snapshot the guard recomputes from, never to
 * the copy handed to the SDK: freezing the SDK's input would turn a mutating SDK
 * into a thrown `TypeError`, which `mapWalletError` would report as an
 * unreachable network. A mutating SDK is a plan mismatch, not an outage.
 */
function snapshotExecutorCalls(
  calls: readonly PreparedPrivateSwap['executorCalls'][number][],
): PreparedPrivateSwap['executorCalls'] {
  const copied = copyExecutorCalls(calls);
  for (const call of copied) {
    Object.freeze(call.calldata);
    Object.freeze(call);
  }
  return Object.freeze(copied) as PreparedPrivateSwap['executorCalls'];
}

/**
 * Independently serialize the invoke payload the reviewed plan implies.
 *
 * AVNU builds it as `[buyToken, ...fromCallsToExecuteCalldata_cairo1(calls)
 * .map(num.toHex), '${openNoteIds[0]}']`. Recomputing it from the *validated*
 * calls with the same pinned `starknet` helpers is what turns the invoke action
 * from "some call to the right contract" into the exact reviewed transaction —
 * the entry point lives inside this calldata, because `STRK20_INVOKE_ACTION`
 * carries no selector field.
 */
function reviewedInvokeCalldata(reviewed: ReviewedSwap): readonly string[] {
  const serialized = transaction.fromCallsToExecuteCalldata_cairo1(
    reviewed.executorCalls.map((call) => ({
      contractAddress: call.contractAddress,
      entrypoint: call.entrypoint,
      calldata: call.calldata,
    })),
  );
  return [reviewed.buyToken, ...serialized.map((felt) => num.toHex(felt)), OPEN_NOTE_PLACEHOLDER];
}

/**
 * Check that the actions about to be proved still describe the reviewed swap.
 *
 * `buildStrk20Actions` is a validation-free array literal, and the relay's
 * binding check runs only after the wallet has already minted an irrevocable
 * proof. Verifying here keeps a divergence cheap: the sell leg must fund the
 * quoted executor and nobody else, the fee leg must match the authorized quote,
 * the bought asset must land in an open note owned by this account, and the one
 * external call must carry exactly the reviewed payload to that same executor.
 * Anything else — a reordering, a dropped leg, an extra action, a public deposit,
 * a retargeted or re-encoded inner call — is a mismatch, not a variant.
 *
 * Comparands are the canonical intent, the validated plan and the connected
 * account, never the intermediate plan object the SDK was fed, so a mistake in
 * this package's own mapping fails closed too.
 *
 * The four-action shape is source-derived from the exact pinned SDK; an approved
 * upgrade that changes it must fail closed here rather than silently prove a
 * different transaction. This is self-consistency only — a hostile plan's
 * actions match it faithfully.
 */
function assertPreparedSwapActions(
  actions: readonly STRK20_ACTION[],
  reviewed: ReviewedSwap,
): void {
  const [sell, feeLeg, openNote, invoke] = actions;
  let faithful = actions.length === 4 &&
    isWithdrawal(sell, reviewed.sellToken, reviewed.sellAmount, reviewed.executor) &&
    isWithdrawal(feeLeg, reviewed.fee.token, reviewed.fee.amount, reviewed.fee.recipient) &&
    openNote?.type === 'transfer' &&
    openNote.amount === 'OPEN' &&
    sameAddress(openNote.token, reviewed.buyToken) &&
    sameAddress(openNote.recipient, reviewed.taker) &&
    invoke?.type === 'invoke' &&
    sameAddress(invoke.contract, reviewed.executor);
  if (faithful && invoke?.type === 'invoke') {
    // A serialization failure is itself a mismatch, not a transport problem.
    try {
      faithful = sameCalldata(invoke.calldata, reviewedInvokeCalldata(reviewed));
    } catch {
      faithful = false;
    }
  }
  if (!faithful) {
    throw new PrivacyError(
      'unknown',
      'The private swap action set does not match the reviewed plan.',
    );
  }
}

/**
 * Exact length and order, with the open-note placeholder pinned to the final
 * slot. Every other slot is a felt, so it is compared by value: producers differ
 * in zero padding, and a placeholder appearing anywhere but last fails to parse
 * and therefore fails the comparison.
 */
function sameCalldata(actual: readonly string[], reviewed: readonly string[]): boolean {
  if (actual.length !== reviewed.length) return false;
  const placeholderAt = reviewed.length - 1;
  return reviewed.every((expected, index) => index === placeholderAt
    ? actual[index] === OPEN_NOTE_PLACEHOLDER
    : sameAmount(actual[index]!, BigInt(expected)));
}

function isWithdrawal(
  action: STRK20_ACTION | undefined,
  token: string,
  amount: bigint,
  recipient: string,
): boolean {
  return action?.type === 'withdraw' &&
    sameAddress(action.token, token) &&
    sameAmount(action.amount, amount) &&
    sameAddress(action.recipient, recipient);
}

/** Felt amounts differ in padding between producers; compare the values. */
function sameAmount(felt: string, amount: bigint): boolean {
  try { return BigInt(felt) === amount; } catch { return false; }
}

function toActions(intents: readonly Intent[]): STRK20_ACTION[] {
  return intents.map((intent): STRK20_ACTION => {
    switch (intent.kind) {
      case 'shield': return { type: 'deposit', token: intent.token, amount: toFelt(intent.amount) };
      case 'unshield': return {
        type: 'withdraw', token: intent.token, amount: toFelt(intent.amount), recipient: intent.recipient,
      };
      case 'transfer': return {
        type: 'transfer', token: intent.token, amount: toFelt(intent.amount), recipient: intent.recipient,
      };
      case 'swap': throw new PrivacyError('unknown', 'Swap actions require the AVNU route.');
    }
  });
}

function tokenFor(intent: Intent): string {
  return intent.kind === 'swap' ? intent.tokenIn : intent.token;
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function assertAddress(address: string, label: string): void {
  if (!isFelt(address) || BigInt(address) === 0n) {
    throw new PrivacyError('unknown', `Invalid ${label} address.`);
  }
}

function sameAddress(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

function isFelt(value: string): boolean {
  return typeof value === 'string'
    && /^0x[0-9a-fA-F]{1,64}$/.test(value)
    && BigInt(value) < STARK_FIELD_PRIME;
}

function assertFeeCeiling(actual: bigint, ceiling: bigint): void {
  if (actual > ceiling) {
    throw new PrivacyError('unknown', `The current fee ${actual} is above the ceiling ${ceiling}.`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
}

interface Semver {
  core: [number, number, number];
  prerelease: string[] | null;
}

const REQUIRED_VERSION = parseSemver(REQUIRED_WALLET_API)!;

function parseSemver(value: string): Semver | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as Semver['core'];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((identifier) =>
    identifier.length === 0 ||
    !/^[0-9A-Za-z-]+$/.test(identifier) ||
    (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))
  )) return null;
  return { core, prerelease };
}

function compareSemver(left: Semver, right: Semver): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? BigInt(a) : null;
    const bNumber = /^\d+$/.test(b) ? BigInt(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber < bNumber ? -1 : 1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a.localeCompare(b);
  }
  return 0;
}

function assertFirstConfirmation(attempted: boolean): void {
  if (attempted) {
    throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
  }
}

function emitProgress(callback: ProgressCallback | undefined, progress: OperationProgress): void {
  try { callback?.(progress); } catch { /* Observers cannot alter a financial operation. */ }
}
