import type { STRK20_ACTION } from 'starknet';
import type {
  BatchWarning,
  PoolConfig,
  PreparedVaultBatch,
  VaultCallOptions,
  VaultOutcome,
  VaultStage,
  VaultStageCallback,
  VaultTxResult,
} from '../operations.js';
import { PrivacyError, type Address, type OperationProgress, type ProgressCallback, type TxResult } from '../types.js';
import { isContractAddress, shadowAccountAddress, vaultOutcomeFromReceipt } from '../vault.js';
import { mapShadowWalletError, mapWalletError, walletErrorCode } from './errors.js';
import type { PoolReadClient, VaultReadClient, WalletStrk20Account } from './types.js';
import { freezeActions, submitThroughWallet, waitForReceipt } from './wallet-submission.js';

/**
 * What every STRK20 shadow-account counter shares (D-077, D-083): resolving
 * the player's stand-in address for one dapp name and nonce, and the
 * prepared batch the wallet proves and submits. The Vault
 * (`vault-operations.ts`) and the Borrow counter (`borrow-operations.ts`)
 * each hold one resolver for their own dapp name, so the two addresses are
 * different and nothing here links them.
 *
 * - The wallet derives the partial commitment for the dapp name locally; no
 *   transaction is sent and no key leaves it. It is asked once per
 *   connection and never leaves the resolver.
 * - The address comes from the canonical anonymizer's own view, through the
 *   backend, and must equal the address derived here from that commitment
 *   at the nonce. A mismatch fails closed before anything is proved.
 * - A batch is proved **and submitted by the wallet**
 *   (`wallet_strk20InvokeTransaction`): no STRKWORLD relay, no avnu key.
 *
 * Nothing here branches on wallet identity.
 */

export interface ShadowIdentity {
  readonly address: Address;
  readonly deployed: boolean;
}

export interface ShadowAccountResolverOptions {
  readonly wallet: WalletStrk20Account;
  readonly dappName: string;
  readonly nonce: string;
  /** The backend's anonymizer view; absent, every call fails closed. */
  readonly reads?: Pick<VaultReadClient, 'shadowAccount'>;
  /** The operations' own capability answer: `supportsShadowAccounts`. */
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  /** How errors name the counter: "The Vault could not…". */
  readonly subject: string;
}

export class ShadowAccountResolver {
  private readonly wallet: WalletStrk20Account;
  private readonly dappName: string;
  private readonly nonce: string;
  private readonly reads?: Pick<VaultReadClient, 'shadowAccount'>;
  private readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  private readonly subject: string;
  /** The partial commitment once given: deterministic for this account and dapp name, so asked once. */
  private commitment: Promise<string> | null = null;

  constructor(options: ShadowAccountResolverOptions) {
    this.wallet = options.wallet;
    this.dappName = options.dappName;
    this.nonce = options.nonce;
    this.reads = options.reads;
    this.supported = options.supported;
    this.subject = options.subject;
  }

  /**
   * Resolve the stand-in address: capability, then the wallet's partial
   * commitment (once), then the anonymizer's view, cross-checked.
   */
  async resolve(signal: AbortSignal | undefined, onStage: VaultStageCallback | undefined): Promise<ShadowIdentity> {
    let supported: boolean;
    try {
      supported = await this.supported(signal);
    } catch (error) {
      throw mapWalletError(error);
    }
    emitStage(onStage, { stage: 'capability', supported });
    if (!supported) {
      throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
    }
    throwIfAborted(signal);
    const partial = await this.partialCommitment(onStage);
    throwIfAborted(signal);
    const reads = this.reads;
    if (!reads) {
      emitStage(onStage, { stage: 'address', resolved: false });
      throw new PrivacyError('unknown', `The ${this.subject} reads are not configured.`);
    }
    let resolved: unknown;
    try {
      resolved = await reads.shadowAccount(partial, signal);
    } catch (error) {
      emitStage(onStage, { stage: 'address', resolved: false });
      throwIfAborted(signal);
      throw error instanceof PrivacyError
        ? error
        : new PrivacyError('unreachable', `The ${this.subject} could not read its stand-in address.`, error);
    }
    throwIfAborted(signal);
    const address = ownData(resolved, 'address');
    const deployed = ownData(resolved, 'deployed');
    if (
      !isContractAddress(address)
      || typeof deployed !== 'boolean'
      || !sameAddress(shadowAccountAddress(partial, this.nonce), address)
    ) {
      emitStage(onStage, { stage: 'address', resolved: false });
      throw new PrivacyError('unknown', `The ${this.subject} could not verify its stand-in address, so nothing was sent.`);
    }
    emitStage(onStage, { stage: 'address', resolved: true, deployed });
    return Object.freeze({ address: `0x${BigInt(address).toString(16)}`, deployed });
  }

  private partialCommitment(onStage: VaultStageCallback | undefined): Promise<string> {
    if (this.commitment) return this.commitment;
    const request = (async () => {
      let answer: unknown;
      try {
        if (!hasCommitmentMethod(this.wallet)) {
          throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
        }
        answer = await this.wallet.strk20ShadowAccountCommitment!(this.dappName);
      } catch (error) {
        emitStage(onStage, { stage: 'commitment', ok: false, code: walletErrorCode(error) });
        throw mapShadowWalletError(error);
      }
      if (typeof answer !== 'string' || !isFelt(answer) || BigInt(answer) === 0n) {
        emitStage(onStage, { stage: 'commitment', ok: false, code: null });
        throw new PrivacyError('unknown', 'The wallet returned an invalid shadow-account commitment.');
      }
      emitStage(onStage, { stage: 'commitment', ok: true });
      return answer;
    })();
    this.commitment = request;
    // A refused or failed request is asked again next time.
    request.catch(() => {
      if (this.commitment === request) this.commitment = null;
    });
    return request;
  }
}

/** What a shadow-account batch needs from its counter to confirm. */
export interface ShadowBatchDeps {
  readonly wallet: WalletStrk20Account;
  readonly pool: PoolReadClient;
  readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  readonly receiptWaitsMs: readonly number[];
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** How progress names the action: "Confirm the Vault action in your wallet". */
  readonly subject: string;
}

/**
 * A prepared shadow-account batch (D-077, D-083): the reviewed actions
 * frozen, the pool fee as the whole cost (the wallet adds and prices its own
 * network fee), and a confirm that checks the live fee against the ceiling,
 * hands the batch to the wallet once, and then never rejects: a missing
 * receipt resolves `pending`. `extra` carries the counter's own review data.
 */
export function preparedShadowBatch<A, E extends object>(
  deps: ShadowBatchDeps,
  action: A,
  built: STRK20_ACTION[],
  config: PoolConfig,
  extra: E,
  /** Runs at confirm before the fee check and the wallet; a throw refuses the confirm (D-083's expiry). */
  guard?: () => void,
): Omit<PreparedVaultBatch, 'action'> & { readonly action: A } & E {
  // The wallet gets its own copy at confirm, so nothing it does to its
  // argument reaches this snapshot.
  const reviewed = freezeActions(built);
  let discarded = false;
  let attempted = false;
  const warnings: readonly BatchWarning[] = Object.freeze([]);
  return Object.freeze({
    ...extra,
    action,
    poolFee: config.feeAmount,
    gasEstimate: 0n,
    totalCost: config.feeAmount,
    warnings,
    promptCount: 1,
    async confirm(opts: Parameters<PreparedVaultBatch['confirm']>[0]): Promise<VaultTxResult> {
      if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
      const { feeCeiling, onProgress, onStage, onSubmitted, signal } = ownConfirmOptions(opts, deps.subject);
      if (attempted) {
        throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
      }
      attempted = true;
      throwIfAborted(signal);
      guard?.();
      const current = await deps.poolConfig(signal);
      throwIfAborted(signal);
      if (current.feeAmount > feeCeiling) {
        throw new PrivacyError('unknown', `The current fee ${current.feeAmount} is above the ceiling ${feeCeiling}.`);
      }
      if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
      emitProgress(onProgress, { stage: 'awaiting-approval', message: `Confirm the ${deps.subject} action in your wallet` });
      let transactionHash: string;
      try {
        transactionHash = await submitThroughWallet(deps.wallet, reviewed);
      } catch (error) {
        emitStage(onStage, { stage: 'submit', ok: false, code: walletErrorCode(error) });
        emitProgress(onProgress, { stage: 'failed', message: `The ${deps.subject} action failed` });
        // A wallet that answers the shadow-account action as an API version
        // or method it does not support cannot run a shadow account; that
        // must not read as the wallet lacking STRK20 altogether, which would
        // close the city (the connect flow escalates `unsupported-wallet`).
        throw mapShadowWalletError(error);
      }
      // From here a transaction exists: nothing below may reject.
      emitStage(onStage, { stage: 'submit', ok: true });
      const submitted: TxResult = Object.freeze({ transactionHash });
      try {
        onSubmitted?.(submitted);
      } catch {
        // An observer cannot turn a submitted transaction into a failure.
      }
      emitProgress(onProgress, { stage: 'confirming', message: 'Waiting for the network' });
      const outcome = await waitForShadowReceipt(deps, transactionHash, signal, onStage);
      emitProgress(onProgress, { stage: 'done', message: 'Done' });
      return Object.freeze({ transactionHash, outcome });
    },
    discard() { discarded = true; },
  }) as Omit<PreparedVaultBatch, 'action'> & { readonly action: A } & E;
}

/** Read the receipt on the schedule until it settles, the schedule ends, or the caller stops waiting. */
async function waitForShadowReceipt(
  deps: ShadowBatchDeps,
  transactionHash: string,
  signal: AbortSignal | undefined,
  onStage: VaultStageCallback | undefined,
): Promise<VaultOutcome> {
  const { outcome, readable } = await waitForReceipt({
    pool: deps.pool,
    transactionHash,
    waits: deps.receiptWaitsMs,
    sleep: deps.sleep,
    ...(signal ? { signal } : {}),
    classify: (receipt) => vaultOutcomeFromReceipt(receipt, transactionHash),
  });
  emitStage(onStage, { stage: 'receipt', status: outcome !== 'pending' || readable ? outcome : 'unreadable' });
  return outcome;
}

/**
 * Whether the account exposes `strk20ShadowAccountCommitment` as a method: an
 * own or inherited data property holding a function, as `WalletAccountV6`
 * declares it on its prototype. An accessor is refused without being run, and
 * a throwing trap reads as absent.
 */
export function hasCommitmentMethod(wallet: WalletStrk20Account): boolean {
  try {
    let current: object | null = wallet;
    for (let hops = 0; current !== null && hops < 16; hops += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'strk20ShadowAccountCommitment');
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function';
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  } catch {
    return false;
  }
}

export function ownCallOptions(options: VaultCallOptions | undefined, subject: string): {
  signal: AbortSignal | undefined;
  onStage: VaultStageCallback | undefined;
} {
  if (options === undefined) return { signal: undefined, onStage: undefined };
  const signal = ownOptional(options, 'signal', subject);
  const onStage = ownOptional(options, 'onStage', subject);
  if ((signal !== undefined && !isAbortSignalLike(signal)) || (onStage !== undefined && typeof onStage !== 'function')) {
    throw new PrivacyError('unknown', `The ${subject} call options are invalid.`);
  }
  return { signal: signal as AbortSignal | undefined, onStage: onStage as VaultStageCallback | undefined };
}

function ownConfirmOptions(options: unknown, subject: string): {
  feeCeiling: bigint;
  onProgress: ProgressCallback | undefined;
  onStage: VaultStageCallback | undefined;
  onSubmitted: ((result: TxResult) => void) | undefined;
  signal: AbortSignal | undefined;
} {
  const feeCeiling = ownOptional(options, 'feeCeiling', subject);
  if (typeof feeCeiling !== 'bigint' || feeCeiling < 0n || feeCeiling > MAX_UINT256) {
    throw new PrivacyError('unknown', 'The fee ceiling must be a u256 bigint.');
  }
  const onProgress = ownOptional(options, 'onProgress', subject);
  const onStage = ownOptional(options, 'onStage', subject);
  const onSubmitted = ownOptional(options, 'onSubmitted', subject);
  const signal = ownOptional(options, 'signal', subject);
  if (
    (onProgress !== undefined && typeof onProgress !== 'function')
    || (onStage !== undefined && typeof onStage !== 'function')
    || (onSubmitted !== undefined && typeof onSubmitted !== 'function')
    || (signal !== undefined && !isAbortSignalLike(signal))
  ) {
    throw new PrivacyError('unknown', 'The confirmation options are invalid.');
  }
  return {
    feeCeiling,
    onProgress: onProgress as ProgressCallback | undefined,
    onStage: onStage as VaultStageCallback | undefined,
    onSubmitted: onSubmitted as ((result: TxResult) => void) | undefined,
    signal: signal as AbortSignal | undefined,
  };
}

/** An own data property, or undefined; an accessor or a throwing trap is refused. */
function ownOptional(value: unknown, key: string, subject: string): unknown {
  if (!value || typeof value !== 'object') {
    throw new PrivacyError('unknown', `The ${subject} call options are invalid.`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new PrivacyError('unknown', `The ${subject} call options are invalid.`);
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new PrivacyError('unknown', `The ${subject} call options are invalid.`);
  return descriptor.value;
}

export function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return true;
  return Boolean(value && typeof value === 'object' && typeof (value as { aborted?: unknown }).aborted === 'boolean');
}

/** An own data property, never a getter or an inherited value. */
export function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function emitStage(callback: VaultStageCallback | undefined, stage: VaultStage): void {
  try {
    callback?.(Object.freeze({ ...stage }) as VaultStage);
  } catch {
    /* Observers cannot alter a financial operation. */
  }
}

function emitProgress(callback: ProgressCallback | undefined, progress: OperationProgress): void {
  try {
    callback?.(Object.freeze({ ...progress }));
  } catch {
    /* Observers cannot alter a financial operation. */
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
}

export function sameAddress(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

const MAX_UINT256 = (1n << 256n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}
