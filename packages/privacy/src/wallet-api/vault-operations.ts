import type { STRK20_ACTION } from 'starknet';
import type {
  PoolConfig,
  PreparedVaultBatch,
  VaultAction,
  VaultCallOptions,
  VaultOutcome,
  VaultPositions,
  VaultRate,
  VaultStage,
  VaultStageCallback,
  VaultTxResult,
} from '../operations.js';
import { PrivacyError, type Address, type OperationProgress, type ProgressCallback, type TxResult } from '../types.js';
import {
  MAX_VAULT_MARKETS,
  SHADOW_ACCOUNTS_WALLET_API,
  VAULT_DAPP_NAME,
  isContractAddress,
  shadowAccountAddress,
  vaultMarket,
  vaultOutcomeFromReceipt,
  vaultRedeemActions,
  vaultSupplyActions,
  type VaultMarket,
} from '../vault.js';
import { mapShadowWalletError, mapWalletError, walletErrorCode } from './errors.js';
import { compareSemver, parseSemver, type Semver } from './semver.js';
import type { PoolReadClient, VaultReadClient, WalletRoutePolicy, WalletStrk20Account } from './types.js';
import {
  WALLET_RECEIPT_WAITS_MS,
  abortableSleep,
  freezeActions,
  ownReceiptWaits,
  submitThroughWallet,
  waitForReceipt,
} from './wallet-submission.js';

/**
 * The Vault on the Wallet API (D-077): Vesu lending from the player's STRK20
 * shadow account, in every token the policy admits that `VAULT_MARKETS` pins
 * a vault for, in Prime or a curated pool (D-079, D-081).
 *
 * - The wallet derives the partial commitment for `VAULT_DAPP_NAME` locally;
 *   no transaction is sent and no key leaves it.
 * - The address comes from the canonical anonymizer's own view, read through
 *   the backend, and must equal the address the anonymizer derives from that
 *   commitment. A mismatch fails closed before anything is proved, so neither
 *   a relay nor a node can redirect the supply's withdraw leg.
 * - Supply and redeem are proved **and submitted by the wallet**
 *   (`wallet_strk20InvokeTransaction`), exactly like shield: no STRKWORLD
 *   relay, no avnu key, no relay fee. The submission and receipt wait are
 *   `wallet-submission.ts`'s, shared with the pool spends (D-082).
 *
 * Nothing here branches on wallet identity: support is the version query and
 * the account's own method, then whatever the wallet answers.
 */

const SHADOW_VERSION = parseSemver(SHADOW_ACCOUNTS_WALLET_API)!;
const MAX_UINT256 = (1n << 256n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
/** D-079, D-081: more rows than the Vault can pin markets is a malformed answer. */
const MAX_VAULT_ROWS = MAX_VAULT_MARKETS;
/** D-079: a rate's decimal places; Vesu states 18. */
const MAX_RATE_DECIMALS = 36;

/** The Vault's receipt-read schedule: the shared wallet-submission one (D-082). */
export const VAULT_RECEIPT_WAITS_MS: readonly number[] = WALLET_RECEIPT_WAITS_MS;

/**
 * Whether a wallet can run a shadow account: a reported Wallet API of
 * 0.10.4 or later, and an account that exposes the commitment method. The
 * method is read without running an accessor, and a hostile object reads as
 * unsupported.
 */
export function shadowAccountsSupported(
  highest: { readonly parsed: Semver } | null,
  wallet: WalletStrk20Account,
): boolean {
  if (highest === null || compareSemver(highest.parsed, SHADOW_VERSION) < 0) return false;
  return hasCommitmentMethod(wallet);
}

export interface ShadowVaultOptions {
  readonly wallet: WalletStrk20Account;
  readonly walletAddress: Address;
  readonly pool: PoolReadClient;
  readonly reads?: VaultReadClient;
  readonly policy: WalletRoutePolicy;
  /** The operations' own capability answer: `supportsShadowAccounts`. */
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  /** The operations' own validated pool config read. */
  readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly receiptWaitsMs?: readonly number[];
}

interface ShadowIdentity {
  readonly address: Address;
  readonly deployed: boolean;
}

interface PositionRead {
  readonly shares: bigint;
  readonly assets: bigint;
  readonly maxWithdraw: bigint;
  readonly maxRedeem: bigint;
}

export class ShadowVault {
  private readonly wallet: WalletStrk20Account;
  private readonly walletAddress: Address;
  private readonly pool: PoolReadClient;
  private readonly reads?: VaultReadClient;
  private readonly policy: WalletRoutePolicy;
  private readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  private readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly receiptWaitsMs: readonly number[];
  /**
   * The partial commitment, once the wallet has given it. Deterministic for
   * this account and dapp name, so it is asked for once per connection; it
   * never leaves this object.
   */
  private commitment: Promise<string> | null = null;

  constructor(options: ShadowVaultOptions) {
    this.wallet = options.wallet;
    this.walletAddress = options.walletAddress;
    this.pool = options.pool;
    this.reads = options.reads;
    this.policy = options.policy;
    this.supported = options.supported;
    this.poolConfig = options.poolConfig;
    this.sleep = options.sleep ?? abortableSleep;
    this.receiptWaitsMs = ownReceiptWaits(
      options.receiptWaitsMs ?? VAULT_RECEIPT_WAITS_MS,
      'The Vault receipt schedule is invalid.',
    );
  }

  /**
   * Every admitted token's position, and the stand-in address they sit on:
   * one commitment (asked once per connection), one address read, one
   * position read.
   */
  async positions(options?: VaultCallOptions): Promise<VaultPositions> {
    const { signal, onStage } = ownCallOptions(options);
    throwIfAborted(signal);
    const markets = this.admittedMarkets();
    const identity = await this.resolve(signal, onStage);
    const reads = await this.readPositions(identity.address, markets, signal, onStage);
    return Object.freeze({
      standIn: identity.address,
      positions: Object.freeze(reads.map(({ market, read }) => Object.freeze({
        token: market.token,
        shares: read.shares,
        assets: read.assets,
        redeemable: redeemableOf(read),
      }))),
    });
  }

  async prepareSupply(token: Address, amount: bigint, options?: VaultCallOptions): Promise<PreparedVaultBatch> {
    const { signal, onStage } = ownCallOptions(options);
    throwIfAborted(signal);
    const market = this.admittedMarket(token);
    // D-081: a collateral-only market pays no supply interest, so nothing is
    // supplied into it until borrowing ships. A position already there still
    // reads and redeems.
    if (!market.lendable) {
      throw new PrivacyError('unknown', 'Vesu lends none of that token out, so the Vault does not supply it.');
    }
    assertAmount(amount);
    const identity = await this.resolve(signal, onStage);
    const config = await this.poolConfig(signal);
    throwIfAborted(signal);
    const action: VaultAction = Object.freeze({ kind: 'supply', token: market.token, amount });
    return this.prepared(action, vaultSupplyActions({ market, shadowAccount: identity.address, amount }), config);
  }

  async prepareRedeem(token: Address, amount: bigint | 'all', options?: VaultCallOptions): Promise<PreparedVaultBatch> {
    const { signal, onStage } = ownCallOptions(options);
    throwIfAborted(signal);
    const market = this.admittedMarket(token);
    if (amount !== 'all') assertAmount(amount);
    const identity = await this.resolve(signal, onStage);
    const [entry] = await this.readPositions(identity.address, [market], signal, onStage);
    if (!entry) throw new PrivacyError('unknown', 'The Vault position read is invalid.');
    const { read } = entry;
    let action: VaultAction;
    let actions: STRK20_ACTION[];
    if (amount === 'all') {
      if (read.shares === 0n) throw new PrivacyError('unknown', 'There is nothing in the Vault to redeem.');
      if (read.maxRedeem < read.shares) {
        throw new PrivacyError('unknown', 'The vault cannot pay out the whole position right now.');
      }
      action = Object.freeze({ kind: 'redeem', token: market.token, amount: read.assets, all: true });
      actions = vaultRedeemActions({
        market,
        shadowAccount: identity.address,
        player: this.walletAddress,
        redeem: { shares: read.shares },
      });
    } else {
      if (amount > redeemableOf(read)) {
        throw new PrivacyError('unknown', 'That is more than the vault lets this position withdraw now.');
      }
      action = Object.freeze({ kind: 'redeem', token: market.token, amount, all: false });
      actions = vaultRedeemActions({
        market,
        shadowAccount: identity.address,
        player: this.walletAddress,
        redeem: { assets: amount },
      });
    }
    const config = await this.poolConfig(signal);
    throwIfAborted(signal);
    return this.prepared(action, actions, config);
  }

  /**
   * Vesu's supply APY for each admitted token (D-079), from the backend's
   * read of Vesu's public API. No wallet is asked and nothing about the
   * player is sent. A token Vesu states no rate for is left out.
   */
  async rates(signal?: AbortSignal): Promise<readonly VaultRate[]> {
    if (signal !== undefined && !isAbortSignalLike(signal)) {
      throw new PrivacyError('unknown', 'The Vault call options are invalid.');
    }
    throwIfAborted(signal);
    const markets = this.admittedMarkets();
    const reads = this.reads;
    if (!reads) throw new PrivacyError('unknown', 'The Vault reads are not configured.');
    let answer: unknown;
    try {
      answer = await reads.vaultRates(signal);
    } catch (error) {
      throwIfAborted(signal);
      throw error instanceof PrivacyError
        ? error
        : new PrivacyError('unreachable', "The Vault could not read Vesu's rates.", error);
    }
    throwIfAborted(signal);
    const rows = ownRows(answer, "The Vault rates read is invalid.");
    const rates: VaultRate[] = [];
    for (const market of markets) {
      const row = rowFor(rows, market, "The Vault rates read is invalid.", false);
      if (row === undefined) continue;
      const apy = ownData(row, 'supplyApy');
      const value = ownData(apy, 'value');
      const decimals = ownData(apy, 'decimals');
      // A yearly rate of 100 (10,000%) or more is not a supply rate: the
      // backend drops one, and so does this, whoever sent it.
      if (
        typeof value !== 'bigint' || value < 0n
        || typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_RATE_DECIMALS
        || value >= 100n * 10n ** BigInt(decimals)
      ) {
        throw new PrivacyError('unknown', 'The Vault rates read is invalid.');
      }
      rates.push(Object.freeze({ token: market.token, supplyApy: Object.freeze({ value, decimals }) }));
    }
    return Object.freeze(rates);
  }

  /**
   * Resolve the stand-in address: capability, then the wallet's partial
   * commitment (once), then the anonymizer's view, cross-checked.
   */
  private async resolve(signal: AbortSignal | undefined, onStage: VaultStageCallback | undefined): Promise<ShadowIdentity> {
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
      throw new PrivacyError('unknown', 'The Vault reads are not configured.');
    }
    let resolved: unknown;
    try {
      resolved = await reads.shadowAccount(partial, signal);
    } catch (error) {
      emitStage(onStage, { stage: 'address', resolved: false });
      throwIfAborted(signal);
      throw error instanceof PrivacyError
        ? error
        : new PrivacyError('unreachable', 'The Vault could not read its stand-in address.', error);
    }
    throwIfAborted(signal);
    const address = ownData(resolved, 'address');
    const deployed = ownData(resolved, 'deployed');
    if (!isContractAddress(address) || typeof deployed !== 'boolean' || !sameAddress(shadowAccountAddress(partial), address)) {
      emitStage(onStage, { stage: 'address', resolved: false });
      throw new PrivacyError('unknown', 'The Vault could not verify its stand-in address, so nothing was sent.');
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
        answer = await this.wallet.strk20ShadowAccountCommitment!(VAULT_DAPP_NAME);
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

  /**
   * One public read of every pinned vault's row for `address`, and each of
   * `markets`' rows out of it, in order. A row missing, repeated or malformed
   * for any of them fails the whole read, and one the backend could not read
   * fails it as unreachable: nothing half-read is returned. Rows for other
   * vaults are ignored, whatever they say, so a vault this call does not
   * need can never block it.
   */
  private async readPositions(
    address: Address,
    markets: readonly VaultMarket[],
    signal: AbortSignal | undefined,
    onStage: VaultStageCallback | undefined,
  ): Promise<Array<{ readonly market: VaultMarket; readonly read: PositionRead }>> {
    const reads = this.reads;
    if (!reads) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw new PrivacyError('unknown', 'The Vault reads are not configured.');
    }
    let answer: unknown;
    try {
      answer = await reads.vaultPositions(address, signal);
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throwIfAborted(signal);
      throw error instanceof PrivacyError
        ? error
        : new PrivacyError('unreachable', 'The Vault could not read its position.', error);
    }
    throwIfAborted(signal);
    const positions: Array<{ readonly market: VaultMarket; readonly read: PositionRead }> = [];
    try {
      const rows = ownRows(answer, 'The Vault position read is invalid.');
      for (const market of markets) {
        const row = rowFor(rows, market, 'The Vault position read is invalid.', true)!;
        const ok = ownData(row, 'ok');
        if (ok === false) throw new PrivacyError('unreachable', 'The Vault could not read its position.');
        if (ok !== true) throw new PrivacyError('unknown', 'The Vault position read is invalid.');
        const values = ['shares', 'assets', 'maxWithdraw', 'maxRedeem'].map((key) => ownData(row, key));
        if (values.some((value) => typeof value !== 'bigint' || value < 0n || value > MAX_UINT256)) {
          throw new PrivacyError('unknown', 'The Vault position read is invalid.');
        }
        const [shares, assets, maxWithdraw, maxRedeem] = values as [bigint, bigint, bigint, bigint];
        if (maxRedeem > shares) throw new PrivacyError('unknown', 'The Vault position read is invalid.');
        positions.push(Object.freeze({ market, read: Object.freeze({ shares, assets, maxWithdraw, maxRedeem }) }));
      }
    } catch (error) {
      emitStage(onStage, { stage: 'position', ok: false });
      throw error instanceof PrivacyError ? error : new PrivacyError('unknown', 'The Vault position read is invalid.');
    }
    emitStage(onStage, { stage: 'position', ok: true });
    return positions;
  }

  private prepared(action: VaultAction, built: STRK20_ACTION[], config: PoolConfig): PreparedVaultBatch {
    // The reviewed actions, frozen. The wallet gets its own copy at confirm,
    // so nothing it does to its argument reaches this snapshot.
    const reviewed = freezeActions(built);
    const owner = this;
    let discarded = false;
    let attempted = false;
    return Object.freeze({
      action,
      poolFee: config.feeAmount,
      gasEstimate: 0n,
      totalCost: config.feeAmount,
      warnings: Object.freeze([]),
      promptCount: 1,
      async confirm(opts: Parameters<PreparedVaultBatch['confirm']>[0]): Promise<VaultTxResult> {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        const { feeCeiling, onProgress, onStage, onSubmitted, signal } = ownConfirmOptions(opts);
        if (attempted) {
          throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
        }
        attempted = true;
        throwIfAborted(signal);
        const current = await owner.poolConfig(signal);
        throwIfAborted(signal);
        if (current.feeAmount > feeCeiling) {
          throw new PrivacyError('unknown', `The current fee ${current.feeAmount} is above the ceiling ${feeCeiling}.`);
        }
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm the Vault action in your wallet' });
        let transactionHash: string;
        try {
          transactionHash = await submitThroughWallet(owner.wallet, reviewed);
        } catch (error) {
          emitStage(onStage, { stage: 'submit', ok: false, code: walletErrorCode(error) });
          emitProgress(onProgress, { stage: 'failed', message: 'The Vault action failed' });
          // A wallet that answers the shadow-account action as an API version
          // or method it does not support cannot run the Vault; that must not
          // read as the wallet lacking STRK20 altogether, which would close
          // the city (the connect flow escalates `unsupported-wallet`).
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
        const outcome = await owner.waitForReceipt(transactionHash, signal, onStage);
        emitProgress(onProgress, { stage: 'done', message: 'Done' });
        return Object.freeze({ transactionHash, outcome });
      },
      discard() { discarded = true; },
    });
  }

  /** Read the receipt on the schedule until it settles, the schedule ends, or the caller stops waiting. */
  private async waitForReceipt(
    transactionHash: string,
    signal: AbortSignal | undefined,
    onStage: VaultStageCallback | undefined,
  ): Promise<VaultOutcome> {
    const { outcome, readable } = await waitForReceipt({
      pool: this.pool,
      transactionHash,
      waits: this.receiptWaitsMs,
      sleep: this.sleep,
      ...(signal ? { signal } : {}),
      classify: (receipt) => vaultOutcomeFromReceipt(receipt, transactionHash),
    });
    emitStage(onStage, { stage: 'receipt', status: outcome !== 'pending' || readable ? outcome : 'unreadable' });
    return outcome;
  }

  /**
   * The pinned markets the policy admits, in its order (D-079). The route
   * must be on and its list non-empty, and every token on it must have a
   * pinned vault and appear once: a list with anything else keeps the whole
   * Vault shut, as the build's own parser does. Absent admits nothing (D-077).
   */
  private admittedMarkets(): readonly VaultMarket[] {
    const tokens = this.policy.allowedTokens.vault;
    if (!this.policy.enabledRoutes.includes('vault') || !Array.isArray(tokens) || tokens.length === 0) {
      throw new PrivacyError('unknown', 'The vault route is disabled.');
    }
    const markets: VaultMarket[] = [];
    for (const token of tokens) {
      const market = vaultMarket(token);
      if (!market || markets.includes(market)) throw new PrivacyError('unknown', 'The vault route is disabled.');
      markets.push(market);
    }
    return Object.freeze(markets);
  }

  /** The admitted market for `token`, or a refusal before anything is asked of the wallet. */
  private admittedMarket(token: unknown): VaultMarket {
    const markets = this.admittedMarkets();
    const market = typeof token === 'string' ? markets.find((candidate) => sameAddress(candidate.token, token)) : undefined;
    if (!market) throw new PrivacyError('unknown', 'The Vault does not lend that token in this build.');
    return market;
  }
}

/** A read's rows, copied by index: an array of own data items, and not too many. */
function ownRows(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new PrivacyError('unknown', message);
  let length: number;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value)) throw new Error();
    length = descriptor.value as number;
  } catch {
    throw new PrivacyError('unknown', message);
  }
  if (length > MAX_VAULT_ROWS) throw new PrivacyError('unknown', message);
  const rows: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new PrivacyError('unknown', message);
    }
    if (!descriptor || !('value' in descriptor)) throw new PrivacyError('unknown', message);
    rows.push(descriptor.value);
  }
  return rows;
}

/**
 * The one row naming `market`'s vault. Two is malformed; none is malformed
 * when `required`, and otherwise means the answer has nothing for it.
 */
function rowFor(rows: readonly unknown[], market: VaultMarket, message: string, required: boolean): unknown {
  const matching = rows.filter((row) => {
    const vault = ownData(row, 'vault');
    return typeof vault === 'string' && sameAddress(vault, market.vault);
  });
  if (matching.length > 1 || (required && matching.length === 0)) throw new PrivacyError('unknown', message);
  return matching[0];
}

function redeemableOf(read: PositionRead): bigint {
  return read.maxWithdraw < read.assets ? read.maxWithdraw : read.assets;
}

/**
 * Whether the account exposes `strk20ShadowAccountCommitment` as a method: an
 * own or inherited data property holding a function, as `WalletAccountV6`
 * declares it on its prototype. An accessor is refused without being run, and
 * a throwing trap reads as absent.
 */
function hasCommitmentMethod(wallet: WalletStrk20Account): boolean {
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

function assertAmount(amount: unknown): asserts amount is bigint {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new PrivacyError('unknown', 'Amounts must be positive u256 values.');
  }
}

function ownCallOptions(options: VaultCallOptions | undefined): {
  signal: AbortSignal | undefined;
  onStage: VaultStageCallback | undefined;
} {
  if (options === undefined) return { signal: undefined, onStage: undefined };
  const signal = ownOptional(options, 'signal');
  const onStage = ownOptional(options, 'onStage');
  if ((signal !== undefined && !isAbortSignalLike(signal)) || (onStage !== undefined && typeof onStage !== 'function')) {
    throw new PrivacyError('unknown', 'The Vault call options are invalid.');
  }
  return { signal: signal as AbortSignal | undefined, onStage: onStage as VaultStageCallback | undefined };
}

function ownConfirmOptions(options: unknown): {
  feeCeiling: bigint;
  onProgress: ProgressCallback | undefined;
  onStage: VaultStageCallback | undefined;
  onSubmitted: ((result: TxResult) => void) | undefined;
  signal: AbortSignal | undefined;
} {
  const feeCeiling = ownOptional(options, 'feeCeiling');
  if (typeof feeCeiling !== 'bigint' || feeCeiling < 0n || feeCeiling > MAX_UINT256) {
    throw new PrivacyError('unknown', 'The fee ceiling must be a u256 bigint.');
  }
  const onProgress = ownOptional(options, 'onProgress');
  const onStage = ownOptional(options, 'onStage');
  const onSubmitted = ownOptional(options, 'onSubmitted');
  const signal = ownOptional(options, 'signal');
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
function ownOptional(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    throw new PrivacyError('unknown', 'The Vault call options are invalid.');
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new PrivacyError('unknown', 'The Vault call options are invalid.');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new PrivacyError('unknown', 'The Vault call options are invalid.');
  return descriptor.value;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return true;
  return Boolean(value && typeof value === 'object' && typeof (value as { aborted?: unknown }).aborted === 'boolean');
}

/** An own data property, never a getter or an inherited value. */
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function emitStage(callback: VaultStageCallback | undefined, stage: VaultStage): void {
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
}

function sameAddress(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}
