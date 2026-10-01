import type { STRK20_ACTION } from 'starknet';
import type {
  PoolConfig,
  PreparedVaultBatch,
  VaultAction,
  VaultCallOptions,
  VaultPositions,
  VaultRate,
  VaultStageCallback,
} from '../operations.js';
import { PrivacyError, type Address } from '../types.js';
import {
  MAX_VAULT_MARKETS,
  SHADOW_ACCOUNTS_WALLET_API,
  VAULT_DAPP_NAME,
  VAULT_SHADOW_NONCE,
  vaultMarket,
  vaultRedeemActions,
  vaultSupplyActions,
  type VaultMarket,
} from '../vault.js';
import { compareSemver, parseSemver, type Semver } from './semver.js';
import {
  ShadowAccountResolver,
  emitStage,
  hasCommitmentMethod,
  isAbortSignalLike,
  ownCallOptions as ownShadowCallOptions,
  ownData,
  preparedShadowBatch,
  sameAddress,
  throwIfAborted,
  type ShadowBatchDeps,
  type ShadowIdentity,
} from './shadow-account.js';
import type { PoolReadClient, VaultReadClient, WalletRoutePolicy, WalletStrk20Account } from './types.js';
import { WALLET_RECEIPT_WAITS_MS, abortableSleep, ownReceiptWaits } from './wallet-submission.js';

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

interface PositionRead {
  readonly shares: bigint;
  readonly assets: bigint;
  readonly maxWithdraw: bigint;
  readonly maxRedeem: bigint;
}

export class ShadowVault {
  private readonly walletAddress: Address;
  private readonly reads?: VaultReadClient;
  private readonly policy: WalletRoutePolicy;
  private readonly poolConfig: (signal?: AbortSignal) => Promise<PoolConfig>;
  /** The Vault's stand-in address for `VAULT_DAPP_NAME`, shared logic with the borrow counter (D-083). */
  private readonly identity: ShadowAccountResolver;
  private readonly batchDeps: ShadowBatchDeps;

  constructor(options: ShadowVaultOptions) {
    this.walletAddress = options.walletAddress;
    this.reads = options.reads;
    this.policy = options.policy;
    this.poolConfig = options.poolConfig;
    this.identity = new ShadowAccountResolver({
      wallet: options.wallet,
      dappName: VAULT_DAPP_NAME,
      nonce: VAULT_SHADOW_NONCE,
      ...(options.reads ? { reads: options.reads } : {}),
      supported: options.supported,
      subject: 'Vault',
    });
    this.batchDeps = Object.freeze({
      wallet: options.wallet,
      pool: options.pool,
      poolConfig: options.poolConfig,
      sleep: options.sleep ?? abortableSleep,
      receiptWaitsMs: ownReceiptWaits(
        options.receiptWaitsMs ?? VAULT_RECEIPT_WAITS_MS,
        'The Vault receipt schedule is invalid.',
      ),
      subject: 'Vault',
    });
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

  /** The stand-in address, resolved and cross-checked (`shadow-account.ts`). */
  private resolve(signal: AbortSignal | undefined, onStage: VaultStageCallback | undefined): Promise<ShadowIdentity> {
    return this.identity.resolve(signal, onStage);
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
    return preparedShadowBatch(this.batchDeps, action, built, config, {});
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

function assertAmount(amount: unknown): asserts amount is bigint {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new PrivacyError('unknown', 'Amounts must be positive u256 values.');
  }
}

function ownCallOptions(options: VaultCallOptions | undefined): {
  signal: AbortSignal | undefined;
  onStage: VaultStageCallback | undefined;
} {
  return ownShadowCallOptions(options, 'Vault');
}
