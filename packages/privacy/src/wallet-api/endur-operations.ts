import type {
  EndurAction,
  EndurUnstakePosition,
  PoolConfig,
  PreparedEndurBatch,
  VaultCallOptions,
  VaultStageCallback,
} from '../operations.js';
import { PrivacyError, type Address } from '../types.js';
import {
  ENDUR_DAPP_NAME,
  ENDUR_SHADOW_NONCE,
  MAX_ENDUR_CLAIMS_PER_BATCH,
  classifyEndurRequests,
  endurUnstakeClaimActions,
  endurUnstakeRequestActions,
  type EndurPendingRequest,
  type EndurRequestRecord,
} from '../endur.js';
import {
  ShadowAccountResolver,
  assertAmount,
  emitStage,
  ownCallOptions,
  ownData,
  preparedShadowBatch,
  throwIfAborted,
  type ShadowBatchDeps,
  type ShadowIdentity,
} from './shadow-account.js';
import type { EndurReadClient, PoolReadClient, WalletRoutePolicy, WalletStrk20Account } from './types.js';
import { WALLET_RECEIPT_WAITS_MS, abortableSleep, ownReceiptWaits } from './wallet-submission.js';

/**
 * Endur unstaking on the Wallet API (D-085): xSTRK out of the pool through the
 * player's own unstaking shadow account (`strkworld-endur`, nonce 0), into
 * Endur's withdrawal queue, and the STRK back into the pool once it is paid.
 *
 * The commitment, the address cross-check and the wallet submission are the
 * module the Vault and the Borrow counter share (`shadow-account.ts`:
 * `ShadowAccountResolver` and `preparedShadowBatch`), not a copy; this
 * route holds its own resolver for its own dapp name, so its commitment cache
 * and nonce check are its own. What is Endur's own:
 *
 * - **Request (flow A).** Withdraw the xSTRK to the shadow account, which
 *   calls xSTRK's `redeem` as receiver and owner; the queue mints the request
 *   to it with a plain mint (no receiver hook, checked on mainnet). xSTRK
 *   already on the address returns to the pool in the same batch.
 * - **Claim (flow B).** The shadow account claims each ready request and
 *   every STRK on it lands in one pool note (`collect_policy: all`). Endur's
 *   own service usually claims first, paying the STRK to the address; the
 *   claim then only collects it.
 * - **Reads.** One public read through the backend: the queue's requests for
 *   the address, its balances, and the chain's clock, by which every request
 *   is `waiting` or `ready`.
 */

const MAX_UINT256 = (1n << 256n) - 1n;
/** How messages name this route: "The unstaking reads are not configured." */
const SUBJECT = 'unstaking';
/** More request rows than this is a malformed answer, not a longer list. */
export const MAX_ENDUR_REQUEST_ROWS = 64;

export interface EndurUnstakeOptions {
  readonly wallet: WalletStrk20Account;
  readonly walletAddress: Address;
  readonly pool: PoolReadClient;
  readonly reads?: EndurReadClient;
  readonly policy: WalletRoutePolicy;
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly receiptWaitsMs?: readonly number[];
}

export interface UnstakeRead {
  readonly chainTime: number;
  readonly pending: readonly EndurPendingRequest[];
  readonly strk: bigint;
  readonly xstrk: bigint;
  readonly unlisted: number;
  readonly complete: boolean;
}

export class EndurUnstake {
  private readonly walletAddress: Address;
  private readonly reads?: EndurReadClient;
  private readonly policy: WalletRoutePolicy;
  private readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  private readonly identity: ShadowAccountResolver;
  private readonly batchDeps: ShadowBatchDeps;

  constructor(options: EndurUnstakeOptions) {
    this.walletAddress = options.walletAddress;
    this.reads = options.reads;
    this.policy = options.policy;
    this.poolConfig = options.poolConfig;
    this.identity = new ShadowAccountResolver({
      wallet: options.wallet,
      dappName: ENDUR_DAPP_NAME,
      nonce: ENDUR_SHADOW_NONCE,
      ...(options.reads ? { reads: options.reads } : {}),
      supported: options.supported,
      subject: SUBJECT,
    });
    this.batchDeps = Object.freeze({
      wallet: options.wallet,
      pool: options.pool,
      poolConfig: options.poolConfig,
      sleep: options.sleep ?? abortableSleep,
      receiptWaitsMs: ownReceiptWaits(options.receiptWaitsMs ?? WALLET_RECEIPT_WAITS_MS, 'The unstaking receipt schedule is invalid.'),
      subject: SUBJECT,
    });
  }

  async position(options?: VaultCallOptions): Promise<EndurUnstakePosition> {
    const { signal, onStage } = ownCallOptions(options, SUBJECT);
    throwIfAborted(signal);
    this.assertEnabled();
    const identity = await this.identity.resolve(signal, onStage);
    const read = await this.read(identity, signal, onStage);
    return Object.freeze({
      standIn: identity.address,
      chainTime: read.chainTime,
      requests: Object.freeze(read.pending.map((entry) => Object.freeze({ ...entry }))),
      strkHeld: read.strk,
      xstrkHeld: read.xstrk,
      unlisted: read.unlisted,
      complete: read.complete,
    });
  }

  async prepareRequest(shares: bigint, options?: VaultCallOptions): Promise<PreparedEndurBatch> {
    const { signal, onStage } = ownCallOptions(options, SUBJECT);
    throwIfAborted(signal);
    this.assertEnabled();
    assertAmount(shares);
    const identity = await this.identity.resolve(signal, onStage);
    const read = await this.read(identity, signal, onStage);
    const config = await this.poolConfig(signal);
    throwIfAborted(signal);
    const action: EndurAction = Object.freeze({ kind: 'request', shares, leftover: read.xstrk });
    return preparedShadowBatch(this.batchDeps, action, endurUnstakeRequestActions({
      shadowAccount: identity.address,
      player: this.walletAddress,
      shares,
      leftover: read.xstrk,
    }), config, {});
  }

  async prepareClaim(options?: VaultCallOptions): Promise<PreparedEndurBatch> {
    const { signal, onStage } = ownCallOptions(options, SUBJECT);
    throwIfAborted(signal);
    this.assertEnabled();
    const identity = await this.identity.resolve(signal, onStage);
    const read = await this.read(identity, signal, onStage);
    // STRK already on the stand-in: collect only. A claim beside it could
    // revert the whole batch if Endur's relayer claims that request while the
    // wallet proves ("ERC721: invalid token ID"), stranding what is held.
    // Otherwise claim only requests whose claim a dry run found payable now:
    // one unfunded request would revert the batch ("Insufficient funds").
    const ready = read.strk > 0n
      ? []
      : read.pending.filter((entry) => entry.status === 'ready').slice(0, MAX_ENDUR_CLAIMS_PER_BATCH);
    const owed = ready.reduce((sum, entry) => sum + entry.assets, 0n);
    if (ready.length === 0 && read.strk === 0n) {
      throw new PrivacyError('unknown', 'Nothing has finished unstaking yet.');
    }
    const config = await this.poolConfig(signal);
    throwIfAborted(signal);
    const requestIds = Object.freeze(ready.map((entry) => entry.requestId));
    const action: EndurAction = Object.freeze({ kind: 'claim', requestIds, owed, held: read.strk });
    return preparedShadowBatch(this.batchDeps, action, endurUnstakeClaimActions({
      shadowAccount: identity.address,
      player: this.walletAddress,
      requestIds,
    }), config, {});
  }

  /** The one public read, validated and classified by the chain's clock. */
  private async read(
    identity: ShadowIdentity,
    signal: AbortSignal | undefined,
    onStage: VaultStageCallback | undefined,
  ): Promise<UnstakeRead> {
    const reads = this.reads;
    if (!reads) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw new PrivacyError('unknown', 'The unstaking reads are not configured.');
    }
    let answer: unknown;
    try {
      answer = await reads.endurUnstake(identity.address, signal);
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throwIfAborted(signal);
      throw error instanceof PrivacyError
        ? error
        : new PrivacyError('unreachable', 'Unstaking could not read Endur.', error);
    }
    throwIfAborted(signal);
    try {
      const parsed = parseUnstakeRead(answer);
      emitStage(onStage, { stage: 'position', ok: true });
      return parsed;
    } catch {
      emitStage(onStage, { stage: 'position', ok: false });
      throw new PrivacyError('unknown', 'The unstaking read is invalid.');
    }
  }

  private assertEnabled(): void {
    if (!this.policy.enabledRoutes.includes('unstake')) {
      throw new PrivacyError('unknown', 'The unstake route is disabled.');
    }
  }
}

/**
 * An unstaking read, checked field by field (own data only), then classified:
 * unpaid requests by the chain's clock, oldest first, and how many unpaid
 * requests the address holds beyond those listed. Throws on anything
 * malformed.
 */
export function parseUnstakeRead(answer: unknown): UnstakeRead {
  const chainTime = ownData(answer, 'chainTime');
  const strk = ownData(answer, 'strk');
  const xstrk = ownData(answer, 'xstrk');
  const outstanding = ownData(answer, 'outstanding');
  const complete = ownData(answer, 'complete');
  const rows = ownData(answer, 'requests');
  if (
    typeof chainTime !== 'number' || !Number.isSafeInteger(chainTime) || chainTime < 0
    || !isU256(strk) || !isU256(xstrk) || !isU256(outstanding) || typeof complete !== 'boolean'
    || !Array.isArray(rows) || rows.length > MAX_ENDUR_REQUEST_ROWS
  ) {
    throw new Error('Invalid unstaking read.');
  }
  const records: EndurRequestRecord[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = ownData(rows, String(index));
    records.push({
      requestId: ownData(row, 'requestId') as bigint,
      assets: ownData(row, 'assets') as bigint,
      shares: ownData(row, 'shares') as bigint,
      claimed: ownData(row, 'claimed') as boolean,
      requestedAt: ownData(row, 'requestedAt') as number,
      claimableAt: ownData(row, 'claimableAt') as number,
      claimableNow: ownData(row, 'claimableNow') as boolean,
    });
  }
  const pending = classifyEndurRequests(records, chainTime);
  const listed = BigInt(pending.length);
  const unlisted = outstanding > listed ? outstanding - listed : 0n;
  return Object.freeze({
    chainTime,
    pending: Object.freeze(pending),
    strk,
    xstrk,
    unlisted: unlisted > BigInt(MAX_ENDUR_REQUEST_ROWS) ? MAX_ENDUR_REQUEST_ROWS : Number(unlisted),
    complete,
  });
}

function isU256(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256;
}
