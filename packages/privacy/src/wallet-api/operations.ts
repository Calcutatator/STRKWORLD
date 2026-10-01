import type { STRK20_ACTION } from 'starknet';
import type {
  BatchWarning,
  BorrowMarket,
  BorrowPositions,
  BorrowRequest,
  DepositStatus,
  EndurUnstakePosition,
  Intent,
  PoolConfig,
  PreparedBatch,
  PreparedBorrowBatch,
  PreparedEndurBatch,
  PreparedVaultBatch,
  PrivacyOperations,
  VaultCallOptions,
  VaultPositions,
  VaultRate,
  WalletCapability,
} from '../operations.js';
import { depositStatusFromReceipt } from '../pool.js';
import {
  PrivacyError,
  type Address,
  type OperationProgress,
  type PrivateBalance,
  type ProgressCallback,
  type RecipientStatus,
  type TxResult,
} from '../types.js';
import { ENDUR_DEPOSIT_ANONYMIZER, ENDUR_XSTRK, ENDUR_XSTRK_ASSET } from '../endur.js';
import { mapTransferWalletError, mapWalletError } from './errors.js';
import { compareSemver, highestVersion, parseSemver } from './semver.js';
import { ShadowSwap } from './swap-operations.js';
import { ShadowVault, shadowAccountsSupported } from './vault-operations.js';
import { ShadowBorrow } from './borrow-operations.js';
import { EndurUnstake } from './endur-operations.js';
import { freezeActions, submitThroughWallet } from './wallet-submission.js';
import type {
  BorrowReadClient,
  EndurReadClient,
  PoolNativeRoute,
  PoolReadClient,
  SupportedVersionsReader,
  SwapPriceReader,
  SwapQuoteClient,
  VaultReadClient,
  WalletRoutePolicy,
  WalletStrk20Account,
} from './types.js';

const REQUIRED_WALLET_API = '0.10.3';
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const U128_MASK = (1n << 128n) - 1n;

/**
 * Pool spends the wallet proves and submits itself (D-082), like shield and
 * the Vault: no relay, no avnu key, no relay fee. The swap is wallet-submitted
 * too, through its own shadow account (D-084, `swap-operations.ts`).
 */
type WalletSubmittedRoute = PoolNativeRoute | 'stake';
type StakeIntent = Extract<Intent, { kind: 'stake' }>;

export interface WalletApiPrivacyOperationsOptions {
  wallet: WalletStrk20Account;
  pool: PoolReadClient;
  /**
   * avnu's keyless swap quotes, through the backend (D-084). Absent, every
   * swap fails closed.
   */
  swapQuotes?: SwapQuoteClient;
  /**
   * The swap's independent price reference, Pragma over the wallet's own RPC
   * (D-084). Absent, every swap fails closed.
   */
  swapPrices?: SwapPriceReader;
  supportedVersions: SupportedVersionsReader;
  policy: WalletRoutePolicy;
  now?: () => number;
  /**
   * The Vault's backend reads (D-077, D-079). Absent, every Vault call fails
   * closed, and so does a swap, which resolves its stand-in the same way (D-084).
   */
  vault?: VaultReadClient;
  /** The Borrow counter's backend reads (D-083). Absent, every borrow call fails closed. */
  borrow?: BorrowReadClient;
  /** Endur unstaking's backend reads (D-085). Absent, every unstaking call fails closed. */
  endur?: EndurReadClient;
  /** How the Vault waits between receipt reads; a test passes its own. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The Vault's receipt-read schedule, in ms (`VAULT_RECEIPT_WAITS_MS` by default). */
  vaultReceiptWaitsMs?: readonly number[];
}

export class WalletApiPrivacyOperations implements PrivacyOperations {
  private readonly wallet: WalletStrk20Account;
  private readonly pool: PoolReadClient;
  private readonly supportedVersions: SupportedVersionsReader;
  private readonly policy: WalletRoutePolicy;
  private readonly now: () => number;
  private readonly walletAddress: Address;
  private readonly vault: ShadowVault;
  private readonly borrow: ShadowBorrow;
  private readonly endur: EndurUnstake;
  private readonly swap: ShadowSwap;

  constructor(options: WalletApiPrivacyOperationsOptions) {
    this.wallet = options.wallet;
    assertAddress(options.wallet.address, 'wallet account');
    this.walletAddress = options.wallet.address;
    this.pool = options.pool;
    this.supportedVersions = options.supportedVersions;
    this.policy = ownPolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.vault = new ShadowVault({
      wallet: this.wallet,
      walletAddress: this.walletAddress,
      pool: this.pool,
      ...(options.vault ? { reads: options.vault } : {}),
      policy: this.policy,
      supported: async (signal) => (await this.capability(signal)).supportsShadowAccounts === true,
      poolConfig: (signal) => this.poolConfig(signal),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.vaultReceiptWaitsMs ? { receiptWaitsMs: options.vaultReceiptWaitsMs } : {}),
    });
    // D-083: the Borrow counter, on its own shadow account, with the same
    // capability answer and receipt schedule as the Vault.
    this.borrow = new ShadowBorrow({
      wallet: this.wallet,
      walletAddress: this.walletAddress,
      pool: this.pool,
      ...(options.borrow ? { reads: options.borrow } : {}),
      policy: this.policy,
      supported: async (signal) => (await this.capability(signal)).supportsShadowAccounts === true,
      poolConfig: (signal) => this.poolConfig(signal),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.vaultReceiptWaitsMs ? { receiptWaitsMs: options.vaultReceiptWaitsMs } : {}),
      now: this.now,
    });
    // D-085: Endur unstaking, on its own shadow account too, the same way.
    this.endur = new EndurUnstake({
      wallet: this.wallet,
      walletAddress: this.walletAddress,
      pool: this.pool,
      ...(options.endur ? { reads: options.endur } : {}),
      policy: this.policy,
      supported: async (signal) => (await this.capability(signal)).supportsShadowAccounts === true,
      poolConfig: (signal) => this.poolConfig(signal),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.vaultReceiptWaitsMs ? { receiptWaitsMs: options.vaultReceiptWaitsMs } : {}),
    });
    this.swap = new ShadowSwap({
      wallet: this.wallet,
      walletAddress: this.walletAddress,
      ...(options.vault ? { reads: options.vault } : {}),
      ...(options.swapQuotes ? { quotes: options.swapQuotes } : {}),
      ...(options.swapPrices ? { prices: options.swapPrices } : {}),
      policy: this.policy,
      supported: async (signal) => (await this.capability(signal)).supportsShadowAccounts === true,
      poolConfig: (signal) => this.poolConfig(signal),
      now: () => this.readNow(),
    });
  }

  /** D-083: Vesu's Prime pool for the admitted borrow tokens, read through the backend. See `PrivacyOperations`. */
  borrowMarket(signal?: AbortSignal): Promise<BorrowMarket> {
    return this.borrow.market(signal);
  }

  /** D-083: the loans on the player's borrow shadow account. See `PrivacyOperations`. */
  borrowPositions(options?: VaultCallOptions): Promise<BorrowPositions> {
    return this.borrow.positions(options);
  }

  /** D-083: one borrow-counter action, proved and submitted by the wallet. See `PrivacyOperations`. */
  prepareBorrow(request: BorrowRequest, options?: VaultCallOptions): Promise<PreparedBorrowBatch> {
    return this.borrow.prepare(request, options);
  }

  /** D-085: Endur unstaking on the player's unstaking shadow account. See `PrivacyOperations`. */
  endurUnstakePosition(options?: VaultCallOptions): Promise<EndurUnstakePosition> {
    return this.endur.position(options);
  }

  /** D-085: an unstake request, proved and submitted by the wallet. See `PrivacyOperations`. */
  prepareEndurUnstake(shares: bigint, options?: VaultCallOptions): Promise<PreparedEndurBatch> {
    return this.endur.prepareRequest(shares, options);
  }

  /** D-085: unstaked STRK into the pool, proved and submitted by the wallet. See `PrivacyOperations`. */
  prepareEndurClaim(options?: VaultCallOptions): Promise<PreparedEndurBatch> {
    return this.endur.prepareClaim(options);
  }

  /** D-077, D-079: the Vault positions on the player's shadow account. See `PrivacyOperations`. */
  vaultPositions(options?: VaultCallOptions): Promise<VaultPositions> {
    return this.vault.positions(options);
  }

  /** D-077: a Vault supply, proved and submitted by the wallet. See `PrivacyOperations`. */
  prepareVaultSupply(token: Address, amount: bigint, options?: VaultCallOptions): Promise<PreparedVaultBatch> {
    return this.vault.prepareSupply(token, amount, options);
  }

  /** D-077, D-079: a Vault redeem back into the pool, proved and submitted by the wallet. See `PrivacyOperations`. */
  prepareVaultRedeem(token: Address, amount: bigint | 'all', options?: VaultCallOptions): Promise<PreparedVaultBatch> {
    return this.vault.prepareRedeem(token, amount, options);
  }

  /** D-079: Vesu's supply APY for each admitted Vault token, read through the backend. See `PrivacyOperations`. */
  vaultRates(signal?: AbortSignal): Promise<readonly VaultRate[]> {
    return this.vault.rates(signal);
  }

  async capability(signal?: AbortSignal): Promise<WalletCapability> {
    throwIfAborted(signal);
    try {
      const versions = await this.supportedVersions(signal);
      throwIfAborted(signal);
      const ownedVersions = ownArrayElements(versions, 'capability response');
      const highest = highestVersion(ownedVersions);
      return Object.freeze({
        supportsStrk20: highest !== null && compareSemver(highest.parsed, REQUIRED_VERSION) >= 0,
        walletApiVersion: highest?.raw ?? null,
        registration: 'unknown',
        // D-077: the same version list, plus the account's commitment method.
        supportsShadowAccounts: shadowAccountsSupported(highest, this.wallet),
      });
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async poolConfig(signal?: AbortSignal): Promise<PoolConfig> {
    throwIfAborted(signal);
    try {
      const config = await this.pool.config(signal);
      throwIfAborted(signal);
      return ownPoolConfig(config);
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  async balances(tokens: string[] = [], signal?: AbortSignal): Promise<PrivateBalance[]> {
    throwIfAborted(signal);
    let requestedTokens: string[];
    try {
      const ownedTokens = ownArrayElements(tokens, 'requested balance tokens');
      if (ownedTokens.some((token) => typeof token !== 'string' || !isFelt(token))) {
        throw new Error('invalid requested token');
      }
      requestedTokens = [...ownedTokens] as string[];
    } catch {
      throw new PrivacyError('unknown', 'The requested balance tokens are invalid.');
    }
    try {
      const balances = await this.wallet.strk20Balances(requestedTokens);
      throwIfAborted(signal);
      const seenTokens = new Set<bigint>();
      const published: PrivateBalance[] = [];
      const entries = ownArrayElements(balances, 'balance response');
      for (const entry of entries) {
        let token: unknown;
        let balance: unknown;
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error('invalid balance entry');
          }
          if (Reflect.ownKeys(entry).length !== 2) throw new Error('invalid balance shape');
          const tokenDescriptor = Object.getOwnPropertyDescriptor(entry, 'token');
          const balanceDescriptor = Object.getOwnPropertyDescriptor(entry, 'balance');
          if (
            !tokenDescriptor
            || !('value' in tokenDescriptor)
            || !balanceDescriptor
            || !('value' in balanceDescriptor)
          ) {
            throw new Error('missing balance data property');
          }
          token = tokenDescriptor.value;
          balance = balanceDescriptor.value;
        } catch {
          throw new PrivacyError('unknown', 'The wallet returned an invalid balance.');
        }
        if (typeof token !== 'string' || !isFelt(token) || typeof balance !== 'string' || !isFelt(balance)) {
          throw new PrivacyError('unknown', 'The wallet returned an invalid balance.');
        }
        const tokenIdentity = BigInt(token);
        if (seenTokens.has(tokenIdentity)) {
          throw new PrivacyError('unknown', 'The wallet returned a duplicate balance token.');
        }
        if (requestedTokens.length > 0 && !requestedTokens.some((requested) => sameAddress(requested, token))) {
          throw new PrivacyError('unknown', 'The wallet returned an unrequested balance token.');
        }
        seenTokens.add(tokenIdentity);
        const total = BigInt(balance);
        if (total < 0n) {
          throw new PrivacyError('unknown', 'The wallet returned an invalid balance.');
        }
        published.push(Object.freeze({
          token,
          total,
          spendable: 0n,
          maturing: 0n,
          maturityKnown: false,
        }));
      }
      return Object.freeze(published) as PrivateBalance[];
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  /**
   * D-072's entry check: one `wallet_strk20Balances` call with an empty token
   * list, which the Wallet API answers with every shielded token, reduced to
   * a boolean here so no amount reaches the shell. The aggregate `total`
   * already counts maturing notes. A 118 rejects as `not-registered`.
   */
  async hasPrivateFunds(signal?: AbortSignal): Promise<boolean> {
    const balances = await this.balances([], signal);
    return balances.some((entry) => entry.total > 0n);
  }

  /**
   * D-072: whether this account's shield landed, from the backend's public
   * receipt read. A hash the network has not seen yet comes back `null`, and
   * reads as `pending` like any receipt not yet accepted. A read that failed
   * (the service down, busy, or its node erroring) is not an answer about the
   * deposit, so it rejects `unreachable` rather than pass for "not yet".
   */
  async depositStatus(transactionHash: string, signal?: AbortSignal): Promise<DepositStatus> {
    throwIfAborted(signal);
    if (typeof transactionHash !== 'string' || !isFelt(transactionHash) || BigInt(transactionHash) === 0n) {
      throw new PrivacyError('unknown', 'The deposit transaction hash is invalid.');
    }
    let receipt: unknown;
    try {
      receipt = await this.pool.receipt(transactionHash, signal);
    } catch (error) {
      throwIfAborted(signal);
      throw new PrivacyError('unreachable', 'The network check for this deposit could not be made.', error);
    }
    throwIfAborted(signal);
    return depositStatusFromReceipt(receipt, { transactionHash, account: this.walletAddress });
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
    if (!Array.isArray(intents)) {
      throw new PrivacyError('unknown', 'prepare called with an invalid intent container.');
    }
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
    const warnings = freezeWarnings(await this.warningsFor(reviewed, signal));
    if (hasShield) return this.prepareShield(reviewed, config, warnings);
    if (kinds.has('swap')) {
      if (reviewed.length !== 1 || reviewed[0]?.kind !== 'swap') {
        throw new PrivacyError('unknown', 'A private swap must be prepared one at a time.');
      }
      return this.swap.prepare(reviewed[0], config, warnings, signal);
    }
    if (kinds.has('stake')) {
      const intent = reviewed[0];
      // The pool allows one external invoke per transaction, so one stake each.
      if (reviewed.length !== 1 || intent?.kind !== 'stake') {
        throw new PrivacyError('unknown', 'A private stake must be prepared one at a time.');
      }
      return this.prepareStake(reviewed, intent, config, warnings);
    }

    const route = reviewed[0]!.kind as PoolNativeRoute;
    return this.prepareWalletSubmitted(reviewed, route, config, warnings, () => toActions(reviewed));
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PrivacyError('unknown', 'The private swap clock is invalid.');
    }
    return value;
  }

  /**
   * Endur private staking (D-063). The swap's transfer-OPEN + invoke shape
   * around Endur's anonymizer, proved and submitted by the wallet like the
   * pool-native spends (D-082): there is no quote to bind and no relay fee.
   */
  private prepareStake(
    reviewed: readonly Intent[],
    intent: StakeIntent,
    config: PoolConfig,
    warnings: readonly BatchWarning[],
  ): PreparedBatch {
    const taker = this.walletAddress;
    return this.prepareWalletSubmitted(reviewed, 'stake', config, warnings, () => stakeActions(intent, taker));
  }

  private prepareShield(
    intents: readonly Intent[],
    config: PoolConfig,
    warnings: readonly BatchWarning[],
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
        assertFeeCeilingInput(feeCeiling);
        assertFirstConfirmation(confirmationAttempted);
        confirmationAttempted = true;
        throwIfAborted(signal);
        try {
          const current = ownPoolConfig(await pool.config(signal));
          throwIfAborted(signal);
          assertFeeCeiling(current.feeAmount, feeCeiling);
          assertNotDiscarded(discarded);
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm the shield in your wallet' });
          const result = await wallet.strk20InvokeTransaction(toActions(intents));
          // Once the wallet returns a transaction hash the public deposit may
          // already be on-chain. Do not turn that success into a retryable
          // cancellation merely because the caller aborted while it settled.
          const transactionHash = readWalletTransactionHash(result);
          emitProgress(onProgress, { stage: 'confirming', message: 'Shield submitted' });
          emitProgress(onProgress, { stage: 'done', message: 'Done' });
          return Object.freeze({ transactionHash });
        } catch (error) {
          emitProgress(onProgress, { stage: 'failed', message: 'Shield failed' });
          throw mapWalletError(error);
        }
      },
      discard() { discarded = true; },
    };
  }

  /**
   * A pool spend the wallet proves and submits itself (D-082): unshield,
   * transfer and stake. The actions carry no relay-fee leg; the wallet adds
   * and prices its own network fee when it asks, so `gasEstimate` is zero and
   * `totalCost` is the pool fee, as for shield and the Vault. The pool fee is
   * re-read at confirmation and held to the caller's ceiling before the
   * wallet is asked. The actions are built and frozen once, at prepare, from
   * the frozen intents, and the wallet gets its own copy.
   */
  private prepareWalletSubmitted(
    intents: readonly Intent[],
    route: WalletSubmittedRoute,
    config: PoolConfig,
    warnings: readonly BatchWarning[],
    buildActions: () => STRK20_ACTION[],
  ): PreparedBatch {
    const owner = this;
    const reviewed = freezeActions(buildActions());
    let discarded = false;
    let confirmationAttempted = false;
    return {
      // The frozen snapshot itself — see prepareShield.
      intents,
      poolFee: config.feeAmount,
      gasEstimate: 0n,
      totalCost: config.feeAmount,
      warnings,
      promptCount: 1,
      async confirm({ feeCeiling, onProgress, signal }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFeeCeilingInput(feeCeiling);
        assertFirstConfirmation(confirmationAttempted);
        confirmationAttempted = true;
        throwIfAborted(signal);
        let transactionHash: string;
        try {
          const current = ownPoolConfig(await owner.pool.config(signal));
          throwIfAborted(signal);
          assertFeeCeiling(current.feeAmount, feeCeiling);
          emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm in your wallet' });
          emitProgress(onProgress, { stage: 'proving', message: 'Your wallet is generating a proof' });
          assertNotDiscarded(discarded);
          throwIfAborted(signal);
          transactionHash = await owner.submitSpend(route, reviewed);
        } catch (error) {
          emitProgress(onProgress, { stage: 'failed', message: 'Private operation failed' });
          throw mapWalletError(error);
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

  /**
   * The wallet proves and submits a pool spend. On a transfer a 118 rejects
   * as the recipient's `recipient-not-registered` (D-074), even though
   * `prepare()` read that recipient as registered; on every other route a 118
   * is still this account's own `not-registered`.
   */
  private async submitSpend(route: WalletSubmittedRoute, reviewed: readonly STRK20_ACTION[]): Promise<string> {
    try {
      return await submitThroughWallet(this.wallet, reviewed);
    } catch (error) {
      throw route === 'transfer' ? mapTransferWalletError(error) : error;
    }
  }

  /**
   * Review warnings. Only the two public-edge routes carry a `public-leg`
   * detail. The anonymous routes carry none: a swap never has, and D-064
   * waived the stake route's in-game disclosure, so the seam must not put one
   * back as a warning. What an observer sees of a stake stays recorded in the
   * privacy register's `observable` entry (D-063).
   */
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
          // The recipient's fact, not this account's (D-074).
          throw new PrivacyError(
            'recipient-not-registered',
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

function ownArrayElements(value: unknown, label: string): readonly unknown[] {
  try {
    if (!Array.isArray(value)) throw new Error(`invalid ${label} container`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
    ) {
      throw new Error(`invalid ${label} shape`);
    }
    const owned: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error(`missing ${label} item`);
      owned.push(descriptor.value);
    }
    return Object.freeze(owned);
  } catch {
    throw new PrivacyError('unknown', `The wallet returned an invalid ${label}.`);
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

function freezeWarnings(warnings: readonly BatchWarning[]): readonly BatchWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({ ...warning })));
}

function assertNotDiscarded(discarded: boolean): void {
  if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
}

function validateIntents(intents: readonly Intent[], policy: WalletRoutePolicy): void {
  if (intents.length === 0) throw new PrivacyError('unknown', 'prepare called with no intents');
  if (intents.length > policy.maxIntents) throw new PrivacyError('unknown', 'Too many intents in one batch.');
  for (const intent of intents) {
    // D-089: a swap may carry the player's own slippage, as an own data property.
    const swapSlippage = intent.kind === 'swap' && Object.getOwnPropertyDescriptor(intent, 'slippageBps') !== undefined;
    const expectedKeys = intent.kind === 'shield'
      ? ['kind', 'token', 'amount']
      : intent.kind === 'swap'
        ? ['kind', 'tokenIn', 'tokenOut', 'amountIn', 'minAmountOut', ...(swapSlippage ? ['slippageBps'] : [])]
        : intent.kind === 'stake'
          ? ['kind', 'tokenIn', 'tokenOut', 'amountIn']
          : ['kind', 'token', 'amount', 'recipient'];
    if (
      !hasOwnDataProperties(intent, expectedKeys)
      || Reflect.ownKeys(intent).length !== expectedKeys.length
    ) {
      throw new PrivacyError('unknown', 'The intent has an invalid shape.');
    }
    if (!policy.enabledRoutes.includes(intent.kind)) {
      throw new PrivacyError('unknown', `The ${intent.kind} route is disabled.`);
    }
    const twoSided = intent.kind === 'swap' || intent.kind === 'stake';
    const amount = twoSided ? intent.amountIn : intent.amount;
    if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
      throw new PrivacyError('unknown', 'Amounts must be positive u256 values.');
    }
    if (
      intent.kind === 'swap' &&
      (typeof intent.minAmountOut !== 'bigint' || intent.minAmountOut <= 0n || intent.minAmountOut > MAX_UINT256)
    ) {
      throw new PrivacyError('unknown', 'Minimum output must be a positive u256 value.');
    }
    if (intent.kind === 'swap' && swapSlippage) {
      const ceiling = policy.swap?.slippageBps;
      const chosen = intent.slippageBps;
      if (
        typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen <= 0
        || typeof ceiling !== 'number' || chosen > ceiling
      ) {
        throw new PrivacyError('unknown', "The swap's slippage is outside what this build allows.");
      }
    }
    const inputToken = twoSided ? intent.tokenIn : intent.token;
    assertAddress(inputToken, 'token');
    // Absent stake tokens admit nothing: an enabled stake route with no
    // allowlist still fails closed (D-063).
    const allowed = policy.allowedTokens[intent.kind] ?? [];
    // D-067, D-084: with the degen floor on, the backend's quote route admits
    // a swap's tokens (its allowlist or its own degen list); a token it does
    // not admit gets no quote, so no swap.
    const degenSwap = intent.kind === 'swap' && policy.swap?.degen === true;
    const admitted = (candidate: string) => degenSwap || allowed.some((token) => sameAddress(token, candidate));
    if (!admitted(inputToken)) {
      throw new PrivacyError('unknown', `The ${intent.kind} input token is not allowlisted.`);
    }
    if (twoSided) {
      assertAddress(intent.tokenOut, 'output token');
      if (!admitted(intent.tokenOut)) {
        throw new PrivacyError('unknown', `The ${intent.kind} output token is not allowlisted.`);
      }
    }
    if (
      intent.kind === 'stake'
      && (!sameAddress(intent.tokenIn, ENDUR_XSTRK_ASSET) || !sameAddress(intent.tokenOut, ENDUR_XSTRK))
    ) {
      // The anonymizer pins no pair itself, so an allowlist broader than
      // STRK/xSTRK must not widen what it is asked to do.
      throw new PrivacyError('unknown', 'The stake route accepts only STRK in and xSTRK out.');
    }
    if (intent.kind === 'unshield' || intent.kind === 'transfer') {
      assertAddress(intent.recipient, 'recipient');
    }
  }
}

/**
 * Only the first open note is addressable, so AVNU emits exactly this literal;
 * the stake route reuses it for its one xSTRK note as the anonymizer's
 * `note_id`.
 */
const OPEN_NOTE_PLACEHOLDER = '${openNoteIds[0]}';

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
      case 'swap': throw new PrivacyError('unknown', 'Swap actions require the shadow-account route.');
      case 'stake': throw new PrivacyError('unknown', 'Stake actions require the Endur anonymizer route.');
    }
  });
}

/**
 * The stake request the wallet proves (D-063): the swap's transfer-OPEN +
 * invoke pattern around Endur's anonymizer, in AVNU's proven action order.
 *
 * 1. Withdraw the staked STRK to the anonymizer — the public "pool paid the
 *    helper" leg every anonymizer route has (D-018).
 * 2. Open the xSTRK note the minted shares are credited into, owned by the
 *    connected account so the output cannot be credited anywhere else.
 * 3. Invoke the anonymizer, last as Ready requires.
 *
 * There is no relay-fee leg: the wallet submits it and adds its own network
 * fee (D-082). The pool calls
 *    `privacy_invoke(in_token, out_token, assets: u256, note_id)` through its
 *    fixed invoke selector, so the calldata is exactly that signature: the u256
 *    as (low, high), then the same wallet-resolved placeholder the swap uses
 *    for its one open note.
 *
 * Tokens come from the validated intent, already pinned to STRK → xSTRK; the
 * target is the pinned constant, never caller input.
 */
function stakeActions(intent: StakeIntent, taker: Address): STRK20_ACTION[] {
  const assets = splitU256(intent.amountIn);
  return [
    {
      type: 'withdraw',
      token: intent.tokenIn,
      amount: toFelt(intent.amountIn),
      recipient: ENDUR_DEPOSIT_ANONYMIZER,
    },
    { type: 'transfer', token: intent.tokenOut, amount: 'OPEN', recipient: taker },
    {
      type: 'invoke',
      contract: ENDUR_DEPOSIT_ANONYMIZER,
      calldata: [
        intent.tokenIn,
        intent.tokenOut,
        toFelt(assets.low),
        toFelt(assets.high),
        OPEN_NOTE_PLACEHOLDER,
      ],
    },
  ];
}

/** Cairo serializes a u256 as two felts, low 128 bits first. */
function splitU256(value: bigint): { low: bigint; high: bigint } {
  return { low: value & U128_MASK, high: value >> 128n };
}

function ownPolicy(policy: WalletRoutePolicy): WalletRoutePolicy {
  const stakeTokens = policy.allowedTokens.stake;
  const vaultTokens = policy.allowedTokens.vault;
  const borrowTokens = policy.allowedTokens.borrow;
  return Object.freeze({
    maxIntents: policy.maxIntents,
    maxRelayFee: policy.maxRelayFee,
    enabledRoutes: Object.freeze([...policy.enabledRoutes]),
    allowedTokens: Object.freeze({
      shield: Object.freeze([...policy.allowedTokens.shield]),
      unshield: Object.freeze([...policy.allowedTokens.unshield]),
      transfer: Object.freeze([...policy.allowedTokens.transfer]),
      swap: Object.freeze([...policy.allowedTokens.swap]),
      ...(stakeTokens ? { stake: Object.freeze([...stakeTokens]) } : {}),
      ...(vaultTokens ? { vault: Object.freeze([...vaultTokens]) } : {}),
      ...(borrowTokens ? { borrow: Object.freeze([...borrowTokens]) } : {}),
    }),
    ...(policy.swap ? { swap: Object.freeze({ ...policy.swap }) } : {}),
  });
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function readWalletTransactionHash(value: unknown): string {
  return readTransactionHash(value, 'transaction_hash', 'wallet');
}

function readTransactionHash(value: unknown, field: string, source: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrivacyError('unknown', `The ${source} returned an invalid transaction result.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (
    !descriptor ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'string' ||
    descriptor.value.length === 0 ||
    /\s/.test(descriptor.value)
  ) {
    throw new PrivacyError('unknown', `The ${source} returned an invalid transaction result.`);
  }
  return descriptor.value;
}

function hasOwnDataProperties(value: unknown, keys: readonly PropertyKey[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor);
  });
}

function assertAddress(address: string, label: string): void {
  if (!isFelt(address) || BigInt(address) === 0n) {
    throw new PrivacyError('unknown', `Invalid ${label} address.`);
  }
}

function ownPoolConfig(value: unknown): PoolConfig {
  let feeAmount: unknown;
  let feeToken: unknown;
  let proofValidityBlocks: unknown;
  let noteMaturityBlocks: unknown;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 4) {
      throw new Error('invalid config container');
    }
    const read = (key: PropertyKey): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('missing data property');
      return descriptor.value;
    };
    feeAmount = read('feeAmount');
    feeToken = read('feeToken');
    proofValidityBlocks = read('proofValidityBlocks');
    noteMaturityBlocks = read('noteMaturityBlocks');
  } catch {
    throw new PrivacyError('unknown', 'The pool returned an invalid configuration.');
  }
  if (
    typeof feeAmount !== 'bigint'
    || feeAmount < 0n
    || feeAmount > MAX_UINT256
    || typeof feeToken !== 'string'
    || !isFelt(feeToken)
    || BigInt(feeToken) === 0n
    || !Number.isSafeInteger(proofValidityBlocks)
    || (proofValidityBlocks as number) <= 0
    || !Number.isSafeInteger(noteMaturityBlocks)
    || (noteMaturityBlocks as number) < 0
  ) {
    throw new PrivacyError('unknown', 'The pool returned an invalid configuration.');
  }
  return Object.freeze({
    feeAmount,
    feeToken,
    proofValidityBlocks: proofValidityBlocks as number,
    noteMaturityBlocks: noteMaturityBlocks as number,
  });
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

function assertFeeCeilingInput(ceiling: unknown): asserts ceiling is bigint {
  if (typeof ceiling !== 'bigint' || ceiling < 0n || ceiling > MAX_UINT256) {
    throw new PrivacyError('unknown', 'The fee ceiling must be a u256 bigint.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
}

const REQUIRED_VERSION = parseSemver(REQUIRED_WALLET_API)!;

function assertFirstConfirmation(attempted: boolean): void {
  if (attempted) {
    throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
  }
}

function emitProgress(callback: ProgressCallback | undefined, progress: OperationProgress): void {
  try {
    callback?.(Object.freeze({ ...progress }));
  } catch {
    /* Observers cannot alter a financial operation. */
  }
}
