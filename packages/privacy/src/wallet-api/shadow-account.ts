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
import { shadowCommitment, withLedgerTick } from '../leaderboard.js';
import { noticeLeaderboard, type LeaderboardFeature } from '../leaderboard-notice.js';
import { WalletCommitmentCache } from './commitment-cache.js';
import { mapShadowWalletError, mapWalletError, walletErrorCode } from './errors.js';
import type { PoolReadClient, VaultReadClient, WalletStrk20Account } from './types.js';

export { hasCommitmentMethod, isFelt } from './commitment-cache.js';
import { freezeActions, submitThroughWallet, waitForReceipt } from './wallet-submission.js';

/**
 * What every STRK20 shadow-account counter shares (D-077, D-083, D-085): resolving
 * the player's stand-in address for one dapp name and nonce, and the
 * prepared batch the wallet proves and submits. The Vault
 * (`vault-operations.ts`), the Borrow counter (`borrow-operations.ts`) and
 * Endur unstaking (`endur-operations.ts`) each hold one resolver for their
 * own dapp name and nonce check, so the three addresses are different and
 * nothing here links them. The commitments themselves are cached once for the
 * whole connection, keyed by dapp name only (`commitment-cache.ts`).
 *
 * - The wallet derives the partial commitment for the dapp name locally; no
 *   transaction is sent and no key leaves it. It is asked once per
 *   connection — through the connection's one `WalletCommitmentCache`, shared
 *   with every other route and with the placement (D-122, amended
 *   2026-10-03) — and never leaves this package.
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
  /**
   * The connection's one commitment cache, shared with every other route and
   * with the placement, so no dapp name is asked for twice per connection
   * (D-122, amended 2026-10-03). Absent, this resolver keeps its own.
   */
  readonly commitments?: WalletCommitmentCache;
}

export class ShadowAccountResolver {
  private readonly dappName: string;
  private readonly nonce: string;
  private readonly reads?: Pick<VaultReadClient, 'shadowAccount'>;
  private readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  private readonly subject: string;
  private readonly commitments: WalletCommitmentCache;

  constructor(options: ShadowAccountResolverOptions) {
    this.dappName = options.dappName;
    this.nonce = options.nonce;
    this.reads = options.reads;
    this.supported = options.supported;
    this.subject = options.subject;
    this.commitments = options.commitments ?? new WalletCommitmentCache(options.wallet);
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

  /**
   * The full commitment `C = h(p, nonce)` of this counter's shadow account,
   * for the private placement's ledger tick (DeFi mode). It reuses the
   * partial commitment `resolve` already asked for, so after a resolve it
   * costs no wallet request. `C` is public once the account is deployed (it
   * is the deploy salt), so handing it to the ledger adds no link.
   */
  async fullCommitment(): Promise<string> {
    const partial = await this.partialCommitment(undefined);
    return shadowCommitment(partial, this.nonce);
  }

  /**
   * The partial commitment itself, for the placement check only when the
   * tally ranks DeFi (`rankDefi`): it proves this account owns the feature
   * shadow, which its public commitment alone would not. Cached like the rest.
   */
  partial(): Promise<string> {
    return this.partialCommitment(undefined);
  }

  /**
   * This counter's full commitment `C` only if its partial is already in the
   * connection's cache, and null otherwise. Never asks the wallet, so it can
   * never prompt: a placement check reads this, so it counts and claims only
   * the feature shadows the player's own session has already used.
   */
  cachedFullCommitment(): string | null {
    const partial = this.commitments.cached(this.dappName);
    return partial === null ? null : shadowCommitment(partial, this.nonce);
  }

  /** The cached partial commitment, or null. Never asks the wallet. */
  cachedPartial(): string | null {
    return this.commitments.cached(this.dappName);
  }

  private partialCommitment(onStage: VaultStageCallback | undefined): Promise<string> {
    return this.commitments.commitment(this.dappName, (ok, error) => {
      emitStage(onStage, ok
        ? { stage: 'commitment', ok: true }
        : { stage: 'commitment', ok: false, code: error === undefined ? null : walletErrorCode(error) });
    });
  }
}

/**
 * Leaderboard phase 1, DeFi mode: the counter's built actions with
 * `ledger.tick(C_feature)` appended to its shadow account's calls, and the
 * review flag, when the build names a ledger. Without one the actions come
 * back untouched and the flag is absent: byte-for-byte what they were.
 */
export async function withPlacementTick(
  built: STRK20_ACTION[],
  ledger: Address | undefined,
  identity: Pick<ShadowAccountResolver, 'fullCommitment'>,
  /** Which counter this is, for D-069's debug line. The route's name, nothing more. */
  feature: LeaderboardFeature,
): Promise<{ readonly actions: STRK20_ACTION[]; readonly extra: { readonly countsTowardPlacement?: true } }> {
  if (!ledger) {
    noticeLeaderboard({ event: 'receipt', attached: false, reason: 'no-ledger' });
    return { actions: built, extra: {} };
  }
  const commitment = await identity.fullCommitment();
  const actions = withLedgerTick(built, ledger, commitment);
  noticeLeaderboard({ event: 'tick', feature });
  return { actions, extra: { countsTowardPlacement: true } };
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

/** A shadow-account action's amount: a positive u256 (D-077, D-085). */
export function assertAmount(amount: unknown): asserts amount is bigint {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new PrivacyError('unknown', 'Amounts must be positive u256 values.');
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
