import { buildStrk20Actions, type PrivateSwapPlan } from '@avnu/avnu-sdk';
import type { STRK20_ACTION } from 'starknet';
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
  type OperationProgress,
  type PrivateBalance,
  type ProgressCallback,
  type RecipientStatus,
} from '../types.js';
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
      return await this.pool.config(signal);
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async balances(tokens: string[] = [], signal?: AbortSignal): Promise<PrivateBalance[]> {
    throwIfAborted(signal);
    try {
      const balances = await this.wallet.strk20Balances(tokens);
      throwIfAborted(signal);
      return balances.map(({ token, balance }) => ({
        token,
        total: BigInt(balance),
        spendable: 0n,
        maturing: 0n,
        maturityKnown: false,
      }));
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
      return BigInt(key) === 0n ? 'unregistered' : 'registered';
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      return 'unknown';
    }
  }

  async prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch> {
    throwIfAborted(signal);
    validateIntents(intents, this.policy);
    const kinds = new Set(intents.map((intent) => intent.kind));
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
    const warnings = await this.warningsFor(intents, signal);
    if (hasShield) return this.prepareShield(intents, config, warnings);
    if (kinds.has('swap')) {
      if (intents.length !== 1 || intents[0]?.kind !== 'swap') {
        throw new PrivacyError('unknown', 'A private swap must be prepared one at a time.');
      }
      return this.prepareSwap(intents[0], config, warnings, signal);
    }

    const route = intents[0]!.kind as PoolNativeRoute;
    const operationToken = tokenFor(intents[0]!);
    const fee = await this.estimateRelay(route, operationToken, config, signal);
    return this.preparePrivate(intents, route, operationToken, config, fee, warnings);
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
    this.validateSwapPlan(intent, config, plan, swapPolicy.expectedChainId);

    const owner = this;
    let discarded = false;
    let confirmationAttempted = false;
    return {
      intents: [intent],
      poolFee: config.feeAmount,
      gasEstimate: plan.fee.amount,
      totalCost: config.feeAmount + plan.fee.amount,
      warnings,
      promptCount: 1,
      async confirm({ feeCeiling, onProgress, signal: confirmSignal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFirstConfirmation(confirmationAttempted);
        confirmationAttempted = true;
        throwIfAborted(confirmSignal);
        try {
          const current = await owner.pool.config(confirmSignal);
          owner.validateSwapPlan(intent, current, plan, swapPolicy.expectedChainId);
          assertFeeCeiling(current.feeAmount + plan.fee.amount, feeCeiling);
          const avnuPlan: PrivateSwapPlan = {
            sellTokenAddress: intent.tokenIn,
            sellAmount: intent.amountIn,
            buyTokenAddress: intent.tokenOut,
            executorAddress: plan.executorAddress,
            executorCalls: plan.executorCalls,
            fee: {
              token: plan.fee.token,
              recipient: plan.fee.recipient,
              amount: plan.fee.amount,
            },
            takerAddress: owner.wallet.address,
          };
          const actions = buildStrk20Actions(avnuPlan);
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
          });
          emitProgress(onProgress, { stage: 'done', message: 'Done' });
          return result;
        } catch (error) {
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
      if (!call.entrypoint || call.calldata.some((felt) => !isFelt(felt))) {
        throw new PrivacyError('unknown', 'The private swap contains malformed executor calls.');
      }
    }
    this.validateRelayFee(plan.fee, config);
  }

  private prepareShield(
    intents: Intent[],
    config: PoolConfig,
    warnings: BatchWarning[],
  ): PreparedBatch {
    const wallet = this.wallet;
    const pool = this.pool;
    let discarded = false;
    let confirmationAttempted = false;
    return {
      intents: [...intents],
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
          assertFeeCeiling(current.feeAmount, feeCeiling);
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm the shield in your wallet' });
          const result = await wallet.strk20InvokeTransaction(toActions(intents));
          throwIfAborted(signal);
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
    intents: Intent[],
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
      intents: [...intents],
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
        try {
          const current = await owner.pool.config(signal);
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
          });
          emitProgress(onProgress, { stage: 'done', message: 'Done' });
          return result;
        } catch (error) {
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
    this.validateRelayFee(fee, config);
    return fee;
  }

  private validateRelayFee(fee: RelayFeeQuote, config: PoolConfig): void {
    if (!sameAddress(fee.token, config.feeToken)) {
      throw new PrivacyError('unknown', 'The relay returned an unexpected fee token.');
    }
    assertAddress(fee.recipient, 'relay fee recipient');
    if (fee.amount <= 0n || fee.amount > this.policy.maxRelayFee) {
      throw new PrivacyError('unknown', 'The relay fee exceeds the route policy.');
    }
    if (!fee.authorization || !Number.isSafeInteger(fee.expiresAtBlock) || fee.expiresAtBlock <= 0) {
      throw new PrivacyError('unknown', 'The relay returned no valid fee authorization.');
    }
  }

  private async warningsFor(intents: Intent[], signal?: AbortSignal): Promise<BatchWarning[]> {
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

function validateIntents(intents: Intent[], policy: WalletRoutePolicy): void {
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

function toActions(intents: Intent[]): STRK20_ACTION[] {
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
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
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
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as Semver['core'];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return { core, prerelease: match[4]?.split('.') ?? null };
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
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber - bNumber;
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
