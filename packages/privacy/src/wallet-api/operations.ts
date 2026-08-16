import type { STRK20_ACTION } from 'starknet';
import type {
  BatchWarning,
  Intent,
  PoolConfig,
  PreparedBatch,
  PrivacyOperations,
  WalletCapability,
} from '../operations.js';
import { PrivacyError, type PrivateBalance, type RecipientStatus } from '../types.js';
import { mapWalletError } from './errors.js';
import type {
  PoolNativeRoute,
  PoolReadClient,
  PrivateSubmissionGateway,
  RelayFeeQuote,
  SupportedVersionsReader,
  WalletRoutePolicy,
  WalletStrk20Account,
} from './types.js';

const REQUIRED_WALLET_API = '0.10.3';

export interface WalletApiPrivacyOperationsOptions {
  wallet: WalletStrk20Account;
  pool: PoolReadClient;
  submission: PrivateSubmissionGateway;
  supportedVersions: SupportedVersionsReader;
  policy: WalletRoutePolicy;
}

export class WalletApiPrivacyOperations implements PrivacyOperations {
  private readonly wallet: WalletStrk20Account;
  private readonly pool: PoolReadClient;
  private readonly submission: PrivateSubmissionGateway;
  private readonly supportedVersions: SupportedVersionsReader;
  private readonly policy: WalletRoutePolicy;

  constructor(options: WalletApiPrivacyOperationsOptions) {
    this.wallet = options.wallet;
    this.pool = options.pool;
    this.submission = options.submission;
    this.supportedVersions = options.supportedVersions;
    this.policy = options.policy;
  }

  async capability(signal?: AbortSignal): Promise<WalletCapability> {
    throwIfAborted(signal);
    try {
      const versions = await this.supportedVersions(signal);
      throwIfAborted(signal);
      const highest = [...versions].sort(compareSemver).at(-1) ?? null;
      return {
        supportsStrk20: highest !== null && compareSemver(highest, REQUIRED_WALLET_API) >= 0,
        walletApiVersion: highest,
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
    if (kinds.has('swap')) {
      throw new PrivacyError('unknown', 'The swap route is disabled until its private gateway is configured.');
    }
    if (!hasShield && kinds.size > 1) {
      throw new PrivacyError('unknown', 'A private batch may contain only one approved route type.');
    }

    const config = await this.poolConfig(signal);
    const warnings = await this.warningsFor(intents, signal);
    if (hasShield) return this.prepareShield(intents, config, warnings);

    const route = intents[0]!.kind as PoolNativeRoute;
    const operationToken = tokenFor(intents[0]!);
    const fee = await this.estimateRelay(route, operationToken, config, signal);
    return this.preparePrivate(intents, route, operationToken, config, fee, warnings);
  }

  private prepareShield(
    intents: Intent[],
    config: PoolConfig,
    warnings: BatchWarning[],
  ): PreparedBatch {
    const wallet = this.wallet;
    const pool = this.pool;
    let discarded = false;
    return {
      intents: [...intents],
      poolFee: config.feeAmount,
      gasEstimate: 0n,
      totalCost: config.feeAmount,
      warnings,
      promptCount: 1,
      async confirm({ feeCeiling, onProgress, signal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        throwIfAborted(signal);
        try {
          const current = await pool.config(signal);
          assertFeeCeiling(current.feeAmount, feeCeiling);
          onProgress?.({ stage: 'awaiting-approval', message: 'Confirm the shield in your wallet' });
          const result = await wallet.strk20InvokeTransaction(toActions(intents));
          throwIfAborted(signal);
          onProgress?.({ stage: 'confirming', message: 'Shield submitted' });
          onProgress?.({ stage: 'done', message: 'Done' });
          return { transactionHash: result.transaction_hash };
        } catch (error) {
          onProgress?.({ stage: 'failed', message: 'Shield failed' });
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
    return {
      intents: [...intents],
      poolFee: config.feeAmount,
      gasEstimate: feeAtPrepare.amount,
      totalCost: config.feeAmount + feeAtPrepare.amount,
      warnings,
      promptCount: 1,
      async confirm({ feeCeiling, onProgress, signal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
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
          onProgress?.({ stage: 'awaiting-approval', message: 'Confirm in your wallet' });
          onProgress?.({ stage: 'proving', message: 'Your wallet is generating a proof' });
          const artifact = await owner.wallet.strk20PrepareInvoke(actions, false);
          throwIfAborted(signal);
          onProgress?.({ stage: 'submitting', message: 'Queued for private submission' });
          const result = await owner.submission.submit({
            route,
            artifact,
            proofValidityBlocks: current.proofValidityBlocks,
            signal,
          });
          onProgress?.({ stage: 'done', message: 'Done' });
          return result;
        } catch (error) {
          onProgress?.({ stage: 'failed', message: 'Private operation failed' });
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
    if (!sameAddress(fee.token, config.feeToken)) {
      throw new PrivacyError('unknown', 'The relay returned an unexpected fee token.');
    }
    assertAddress(fee.recipient, 'relay fee recipient');
    if (fee.amount < 0n || fee.amount > this.policy.maxRelayFee) {
      throw new PrivacyError('unknown', 'The relay fee exceeds the route policy.');
    }
    return fee;
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
          warnings.push({ kind: 'recipient-unregistered', recipient: intent.recipient });
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
    if (intent.kind === 'swap') assertAddress(intent.tokenOut, 'output token');
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
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    throw new PrivacyError('unknown', `Invalid ${label} address.`);
  }
}

function sameAddress(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

function assertFeeCeiling(actual: bigint, ceiling: bigint): void {
  if (actual > ceiling) {
    throw new PrivacyError('unknown', `The current fee ${actual} is above the ceiling ${ceiling}.`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
}

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
