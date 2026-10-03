import {
  PrivacyError,
  SwapPriceGuardError,
  type Address,
  type OperationProgress,
  type PrivacyErrorKind,
  type PrivateBalance,
  type ProgressCallback,
  type RecipientStatus,
  type TxResult,
} from '../types.js';
import { LEADERBOARD_SEASON, placementFrom, type LeaderboardHistogram } from '../leaderboard.js';
import type { PlacementCheck } from '../wallet-api/leaderboard-operations.js';
import type {
  BatchWarning,
  BorrowAction,
  BorrowAsset,
  BorrowMarket,
  BorrowPair,
  BorrowPosition,
  BorrowPositions,
  BorrowRequest,
  DepositStatus,
  EndurAction,
  EndurRate,
  EndurUnstakePosition,
  Intent,
  PoolConfig,
  PreparedBatch,
  PreparedBorrowBatch,
  PreparedEndurBatch,
  PreparedVaultBatch,
  PrivacyOperations,
  SwapPriceCheck,
  SwapReview,
  VaultAction,
  VaultCallOptions,
  VaultPosition,
  VaultPositions,
  VaultRate,
  VaultStage,
  VaultStageCallback,
  WalletCapability,
} from '../operations.js';
import { protectedMinimumOut } from '../protected-minimum.js';
import { shieldDeposits } from '../shield-deposit.js';
import {
  SWAP_DEGEN_MAX_SLIPPAGE_BPS,
  SWAP_DEGEN_PRICE_BOUND_BPS,
  SWAP_MAX_SLIPPAGE_BPS,
  SWAP_PRICE_BOUND_BPS,
} from '../swap-prices.js';
import {
  ENDUR_OBSERVED_CLAIM_DELAY_SECONDS,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  MAX_ENDUR_CLAIMS_PER_BATCH,
  classifyEndurRequests,
} from '../endur.js';
import { VAULT_MARKETS, VESU_VSTRK_ASSET, vaultMarket, type VaultMarket } from '../vault.js';
import {
  BORROW_PAIRS,
  BORROW_TOKEN_INFO,
  BorrowRefusedError,
  VESU_SCALE,
  assessBorrow,
  borrowHealth,
  borrowPairKey,
  borrowToken,
} from '../borrow.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * DEMO RATE, not Endur's. The fake mints xSTRK at a fixed 1 xSTRK = 1.25 STRK
 * (4 shares per 5 STRK, floored) so demo mode stays deterministic. It is a
 * fixture: it never reads the vault and must never be presented as a live
 * exchange rate. The real share amount is fixed only when the ERC-4626 deposit
 * executes on-chain (D-063).
 */
const DEMO_XSTRK_SHARES_PER_STRK = { numerator: 4n, denominator: 5n } as const;

function demoStakeShares(assets: bigint): bigint {
  return (assets * DEMO_XSTRK_SHARES_PER_STRK.numerator) / DEMO_XSTRK_SHARES_PER_STRK.denominator;
}

/**
 * DEMO RATE, not Vesu's. The fake's Vault (D-077) prices a share of every
 * vault at a fixed 1.02 of its token (51 per 50 shares, in the token's base
 * units, D-079) so demo mode stays deterministic. A fixture that never reads
 * a vault, and must never be presented as a live share price or yield.
 */
const DEMO_VSTRK_ASSETS_PER_SHARE = { numerator: 51n, denominator: 50n } as const;

/**
 * The demo player's stand-in address (D-079): a fixed placeholder, not a
 * shadow account anyone derived. It holds nothing on-chain.
 */
export const DEMO_VAULT_STAND_IN: Address =
  '0x000000000000000000000000000000000000000000000000000000000000de70';

/**
 * The demo player's unstaking stand-in address (D-085): a fixed placeholder,
 * not derived from anything, and not the demo Vault's, as a real player's two
 * stand-ins differ by dapp name.
 */
export const DEMO_ENDUR_STAND_IN: Address =
  '0x000000000000000000000000000000000000000000000000000000000000e5d1';

/**
 * The demo chain's clock for unstaking (D-085), Unix seconds. Fixed so the
 * demo and tests are deterministic; `advanceEndurClock` moves it.
 */
const DEMO_ENDUR_CHAIN_TIME = 1_790_000_000;

/** What demo `shares` xSTRK unstake for, at the stake fixture's DEMO RATE inverted (5 STRK per 4 shares), floored. */
function demoUnstakeAssets(shares: bigint): bigint {
  return (shares * DEMO_XSTRK_SHARES_PER_STRK.denominator) / DEMO_XSTRK_SHARES_PER_STRK.numerator;
}

/** Shares a demo supply of `assets` mints, floored, as an ERC-4626 deposit rounds. */
function demoVaultShares(assets: bigint): bigint {
  return (assets * DEMO_VSTRK_ASSETS_PER_SHARE.denominator) / DEMO_VSTRK_ASSETS_PER_SHARE.numerator;
}

/** What demo `shares` redeem for, floored. */
function demoVaultAssets(shares: bigint): bigint {
  return (shares * DEMO_VSTRK_ASSETS_PER_SHARE.numerator) / DEMO_VSTRK_ASSETS_PER_SHARE.denominator;
}

/** Shares a demo withdrawal of `assets` burns, rounded up, as an ERC-4626 withdraw rounds. */
function demoVaultSharesToWithdraw(assets: bigint): bigint {
  const { numerator, denominator } = DEMO_VSTRK_ASSETS_PER_SHARE;
  return (assets * denominator + numerator - 1n) / numerator;
}

/**
 * The demo player's borrow stand-in address (D-083): a fixed placeholder,
 * not a shadow account anyone derived, and not the Vault's. It holds nothing.
 */
export const DEMO_BORROW_STAND_IN: Address =
  '0x000000000000000000000000000000000000000000000000000000000000b0a0';

/**
 * DEMO PRICES, not Vesu's oracle. USD per whole token × 10^18, for STRK,
 * ETH, USDC, USDT and WBTC, so the demo's borrow counter (D-083) has figures
 * to show. Fixed and never read from anywhere: they must never be presented
 * as live prices.
 */
export const DEMO_BORROW_PRICES: Readonly<Record<Address, bigint>> = Object.freeze({
  [BORROW_TOKEN_INFO[0]!.token]: 40_000_000_000_000_000n, // STRK $0.04
  [BORROW_TOKEN_INFO[1]!.token]: 2_700n * VESU_SCALE, // ETH $2,700
  [BORROW_TOKEN_INFO[2]!.token]: VESU_SCALE, // USDC $1
  [BORROW_TOKEN_INFO[3]!.token]: VESU_SCALE, // USDT $1
  [BORROW_TOKEN_INFO[4]!.token]: 84_000n * VESU_SCALE, // WBTC $84,000
});

/**
 * DEMO PAIR SETTINGS, shaped like Vesu Prime's (max LTV 0.68 to 0.93, a
 * 0.90 liquidation factor) but fixed here: the demo's pairs, not Vesu's.
 * Stablecoin pairs lend at 0.93, anything against STRK at 0.68, the rest at
 * 0.78.
 */
function demoMaxLtv(collateral: string, debt: string): bigint {
  const stable = (token: string) => token === BORROW_TOKEN_INFO[2]!.token || token === BORROW_TOKEN_INFO[3]!.token;
  if (stable(collateral) && stable(debt)) return 930_000_000_000_000_000n;
  if (collateral === BORROW_TOKEN_INFO[0]!.token || debt === BORROW_TOKEN_INFO[0]!.token) return 680_000_000_000_000_000n;
  return 780_000_000_000_000_000n;
}

/**
 * A deterministic, in-memory `PrivacyOperations`.
 *
 * This exists so the Shell and World lanes can build and test every building
 * without a wallet, without mainnet, and without spending 6 STRK per action.
 * It is the thing that makes the mainnet-only decision (D-001) survivable.
 *
 * Deterministic on purpose: no clocks, no randomness, no network. Block height
 * only advances when a test says so. Two runs of the same script produce byte
 * identical results, which is what makes it usable in CI.
 *
 * It models the sharp edges rather than the happy path, because the happy path
 * is not what breaks:
 *   - notes are unspendable until they mature
 *   - operation value and the complete private fee are charged in their own tokens
 *   - the fee can change between prepare and confirm
 *   - nothing is relayed: the wallet prices every network fee, a swap's too (D-082, D-084)
 *   - a shield cannot be batched with the transfer it funds
 *   - deposits are always to self
 */

/**
 * D-094: a DEMO public balance, 1,000 whole units of an 18-decimal token,
 * that the fake's wallet holds of any token `publicBalances` does not list.
 * Never a real account's figure.
 */
export const DEMO_PUBLIC_BALANCE = 1_000n * 10n ** 18n;

export interface FakeConfig {
  /**
   * Starting shielded balances, token → amount. Omitted, the fake starts with
   * nothing in the pool, like a fresh player at D-072's entry gate; any
   * positive balance starts it funded.
   */
  balances?: Record<Address, bigint>;
  /**
   * What `depositStatus` reports for each shield this fake confirms, until
   * `setDepositStatus` changes it (D-072). `landed` by default.
   */
  deposits?: DepositStatus;
  /**
   * D-094: the demo wallet's PUBLIC balances, token → amount, which a shield
   * draws on. A listed token's shield is refused when its deposit (the
   * amount plus the pool fee in the fee token) exceeds it, and debited when
   * it confirms. An unlisted token reads `DEMO_PUBLIC_BALANCE` and is
   * neither checked nor debited.
   */
  publicBalances?: Record<Address, bigint>;
  /** Addresses registered in the pool and able to receive. */
  registered?: Address[];
  poolConfig?: Partial<PoolConfig>;
  capability?: Partial<WalletCapability>;
  /** Simulated latency in ms. Tests usually want 0. */
  latencyMs?: number;
  /** Explicit deterministic swap review inputs; never generated by the fake. */
  swapReview?: FakeSwapReview;
  /**
   * DEMO RATES, not market prices: explicit per-token rates the demo's degen
   * floor quotes from (D-067). A swap between two rated tokens is quoted from
   * them alone; any other swap falls back to `swapReview`.
   */
  demoSwapRates?: FakeDemoSwapRates;
  /**
   * The demo Vault (D-077): vSTRK shares the demo stand-in address starts
   * with, and `liquidity`, the most STRK the demo vault pays out at once.
   * Omitted, the position starts empty and the vault pays out in full.
   * `markets` (D-079) sets the same for any pinned token's vault, by token;
   * for STRK it overrides `shares` and `liquidity`. `rates` are DEMO supply
   * APYs by token, never Vesu's; omitted, `vaultRates` states none.
   */
  vault?: {
    shares?: bigint;
    liquidity?: bigint;
    markets?: Readonly<Record<Address, { shares?: bigint; liquidity?: bigint }>>;
    rates?: Readonly<Record<Address, { value: bigint; decimals: number }>>;
  };
  /**
   * The demo Borrow counter (D-083). `positions` are the demo stand-in's
   * loans by pair (collateral and debt in base units; the demo counts one
   * share per base unit and accrues no interest), `prices` override the DEMO
   * prices by token, and `stalePrices` lists tokens whose demo price reads
   * invalid, as a stale Vesu feed does.
   */
  borrow?: {
    positions?: ReadonlyArray<{ collateral: Address; debt: Address; collateralAmount: bigint; debtAmount: bigint }>;
    prices?: Readonly<Record<Address, bigint>>;
    stalePrices?: readonly Address[];
  };
  /**
   * Demo Endur unstaking (D-085): requests already on the demo stand-in
   * address, each with the STRK it owes, the seconds until it is past its
   * wait (zero or less: past it), and whether demo Endur has funded it
   * (`funded`, true by default; unfunded, a past-due request awaits funds),
   * and STRK or xSTRK already sitting there.
   * At the DEMO RATE and the demo clock, never Endur's.
   */
  endur?: {
    requests?: readonly { assets: bigint; shares: bigint; claimableInSeconds: number; funded?: boolean }[];
    strkHeld?: bigint;
    xstrkHeld?: bigint;
  };
  /**
   * Leaderboard phase 1 (D-122, amended 2026-10-02): mark every prepared batch
   * as carrying a receipt or a DeFi tick, the way the Wallet API adapter does
   * in a probing tab with a ledger configured. Off by default, so a build
   * without the leaderboard reads exactly as it did. It only sets the review
   * flag; the demo composes no ledger call and writes nothing on chain.
   */
  placementReceipts?: boolean;
}

/**
 * DEMO RATES, not market prices. Explicit inputs the caller supplies, from
 * which the fake quotes a swap between two rated tokens by exact bigint
 * arithmetic: `expected = floor(amountIn × perStrk[out] / perStrk[in])`. The
 * fake never reads a market, a clock or a random source for them, and they must
 * never be presented as a live price or exchange rate. The protected minimum
 * is still AVNU's formula over `slippageBps` (D-042).
 */
export interface FakeDemoSwapRates {
  /** Base units of each token counted as worth one whole STRK. List STRK as 10^18. */
  readonly perStrk: Readonly<Record<Address, bigint>>;
  readonly slippageBps: number;
  /** Absolute quote expiry, Unix epoch milliseconds; fixed, never clock-derived. */
  readonly expiresAt: number;
}

/**
 * The fake's deterministic swap review inputs. `priceCheck` (D-084) defaults
 * to a `checked` result with nothing below the reference; pass an `unchecked`
 * one to model a pair with no oracle price, which then needs
 * `acknowledgeUncheckedPrice` to confirm, as in the adapter.
 */
export type FakeSwapReview = Omit<SwapReview, 'minimumAmountOut' | 'priceCheck'> & { readonly priceCheck?: SwapPriceCheck };

/** DEMO: the fake has no oracle; its default check says the quote matched its own fixture. */
const FAKE_PRICE_CHECK: SwapPriceCheck = Object.freeze({
  status: 'checked', boundBps: 300, shortfallBps: 0, sellUsd: 0n, expectedBuyUsd: 0n,
});

/** The largest demo rate accepted: comfortably inside u256 for any u128 input. */
const MAX_DEMO_RATE = (1n << 128n) - 1n;

const DEFAULT_POOL: PoolConfig = {
  feeAmount: 6_000000000000000000n, // 6 STRK — the live mainnet value
  feeToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  proofValidityBlocks: 450,
  noteMaturityBlocks: 10,
};

/** A fault the next matching call will raise. Consumed on use unless `sticky`. */
export interface Fault {
  kind: PrivacyErrorKind;
  /**
   * Limit to one method. Omit to affect the next call of any kind.
   * `hasPrivateFunds` is one balance read, so a `balances` fault reaches it.
   */
  on?:
    | 'capability'
    | 'poolConfig'
    | 'balances'
    | 'recipientStatus'
    | 'prepare'
    | 'confirm'
    | 'depositStatus'
    /** D-077: the Vault's position read, its two prepares, and its confirm. */
    | 'vaultPosition'
    | 'vaultPrepare'
    | 'vaultConfirm'
    /** D-079: the Vault's rates read. */
    | 'vaultRates'
    /** D-083: the Borrow counter's market read, loans read, prepare and confirm. */
    | 'borrowMarket'
    | 'borrowPositions'
    | 'borrowPrepare'
    | 'borrowConfirm'
    /** D-085: unstaking's read, its two prepares, and its confirm. */
    | 'endurPosition'
    | 'endurPrepare'
    | 'endurConfirm'
    /** D-091: xSTRK's exchange-rate read. */
    | 'endurRate'
    /** D-094: the public balance read a shield draws on. */
    | 'publicBalance'
    /** Leaderboard phase 1: the private placement check. */
    | 'checkPlacement';
  message?: string;
  sticky?: boolean;
}

interface MaturingNote {
  token: Address;
  amount: bigint;
  matureAtBlock: number;
}

/**
 * The demo season's histogram: 310 players, the demo player's 15 receipts
 * ranking 37th. Invented, and labelled demo wherever it shows.
 */
const DEMO_PLACEMENT_HISTOGRAM: LeaderboardHistogram = Object.freeze({
  season: LEADERBOARD_SEASON,
  total: 310,
  buckets: Object.freeze([
    { count: 1, players: 113 },
    { count: 2, players: 64 },
    { count: 3, players: 33 },
    { count: 5, players: 30 },
    { count: 8, players: 13 },
    { count: 12, players: 12 },
    { count: 15, players: 9 },
    { count: 19, players: 22 },
    { count: 27, players: 9 },
    { count: 41, players: 4 },
    { count: 66, players: 1 },
  ].map((bucket) => Object.freeze(bucket))),
});

export class FakePrivacyOperations implements PrivacyOperations {
  private spendable = new Map<Address, bigint>();
  /** D-094: the demo wallet's public balances, by normalised token. */
  private readonly publicHeld = new Map<string, bigint>();
  private maturing: MaturingNote[] = [];
  private registeredAddrs: Set<string>;
  private pool: PoolConfig;
  private cap: WalletCapability;
  private faults: Fault[] = [];
  private latency: number;
  private block = 0;
  private txCounter = 0;
  /** Every confirmed batch's hash and what its receipt says of a deposit (D-072). */
  private readonly receipts = new Map<string, DepositStatus>();
  private readonly newDepositStatus: DepositStatus;
  private configuredSwapReview?: FakeSwapReview;
  private demoRates?: {
    readonly perStrk: ReadonlyMap<bigint, bigint>;
    readonly slippageBps: number;
    readonly expiresAt: number;
  };

  /** Every confirmed batch, in order. Assert against this in tests. */
  readonly submitted: Intent[][] = [];
  /** Every confirmed Vault action, in order (D-077). */
  readonly vaultSubmitted: VaultAction[] = [];
  /** The demo stand-in address's shares in each pinned vault, and each demo vault's payout limit (D-079). */
  private readonly vaultHoldings = new Map<VaultMarket, { shares: bigint; liquidity?: bigint }>(
    VAULT_MARKETS.map((market) => [market, { shares: 0n }]),
  );
  /** Whether the demo stand-in address has run a Vault call yet, as a real one deploys on first use. */
  private vaultDeployed = false;
  /** Whether the demo wallet has answered the commitment request yet: it is asked once. */
  private vaultCommitted = false;
  /** DEMO supply APYs by pinned market (D-079). */
  private readonly vaultRatesByMarket = new Map<VaultMarket, { value: bigint; decimals: number }>();
  /** Every confirmed Borrow-counter action, in order (D-083). */
  readonly borrowSubmitted: BorrowAction[] = [];
  /** The demo borrow stand-in's loans, by pinned pair (D-083). */
  private readonly borrowLoans = new Map<string, { collateral: bigint; debt: bigint }>();
  private readonly borrowPrices = new Map<string, bigint>(Object.entries(DEMO_BORROW_PRICES));
  private readonly borrowStale = new Set<string>();
  private borrowDeployed = false;
  private borrowCommitted = false;
  /** Every confirmed unstaking action, in order (D-085). */
  readonly endurSubmitted: EndurAction[] = [];
  /** The demo unstaking stand-in address's unpaid requests (D-085). */
  private endurRequests: { requestId: bigint; assets: bigint; shares: bigint; requestedAt: number; claimableAt: number; funded: boolean }[] = [];
  private endurNextId = 10_000n;
  private endurStrkHeld = 0n;
  private endurXstrkHeld = 0n;
  private endurNow = DEMO_ENDUR_CHAIN_TIME;
  private endurDeployed = false;
  private endurCommitted = false;
  /** D-122: whether every prepared batch claims a placement receipt. */
  private readonly placementReceipts: boolean;

  constructor(config: FakeConfig = {}) {
    this.placementReceipts = config.placementReceipts === true;
    const balances = config.balances ?? {};
    for (const token of Object.keys(balances)) {
      const descriptor = Object.getOwnPropertyDescriptor(balances, token);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new PrivacyError('unknown', 'The fake starting balance is invalid.');
      }
      const amount = descriptor.value;
      try {
        if (BigInt(token) === 0n) throw new Error();
        normalise(token);
      } catch {
        throw new PrivacyError('unknown', 'The fake starting balance token is invalid.');
      }
      if (typeof amount !== 'bigint' || amount < 0n) {
        throw new PrivacyError('unknown', 'The fake starting balance amount must be a non-negative bigint.');
      }
      this.spendable.set(token, amount);
    }
    for (const [token, amount] of Object.entries(config.publicBalances ?? {})) {
      if (typeof amount !== 'bigint' || amount < 0n) {
        throw new PrivacyError('unknown', 'The fake public balance amount must be a non-negative bigint.');
      }
      this.publicHeld.set(normalise(token), amount);
    }
    this.registeredAddrs = new Set((config.registered ?? []).map((address) => {
      assertAddress(address, 'fake registered recipient');
      return normalise(address);
    }));
    this.pool = { ...DEFAULT_POOL, ...config.poolConfig };
    let feeTokenValue: bigint;
    try {
      feeTokenValue = BigInt(this.pool.feeToken);
    } catch {
      throw new PrivacyError('unknown', 'The fake pool fee configuration is invalid.');
    }
    if (
      typeof this.pool.feeAmount !== 'bigint'
      || this.pool.feeAmount < 0n
      || feeTokenValue <= 0n
    ) {
      throw new PrivacyError('unknown', 'The fake pool fee configuration is invalid.');
    }
    if (
      !Number.isSafeInteger(this.pool.noteMaturityBlocks)
      || this.pool.noteMaturityBlocks < 0
      || !Number.isSafeInteger(this.pool.proofValidityBlocks)
      || this.pool.proofValidityBlocks <= 0
    ) {
      throw new PrivacyError('unknown', 'The fake pool config has invalid lifecycle block windows.');
    }
    this.cap = {
      supportsStrk20: true,
      walletApiVersion: '0.10.4',
      registration: 'registered',
      // D-077: the demo wallet can run the Vault's shadow account.
      supportsShadowAccounts: true,
      ...config.capability,
    };
    if (
      typeof this.cap.supportsStrk20 !== 'boolean'
      || (this.cap.walletApiVersion !== null && typeof this.cap.walletApiVersion !== 'string')
      || !['registered', 'unregistered', 'unknown'].includes(this.cap.registration)
    ) {
      throw new PrivacyError('unknown', 'The fake capability configuration is invalid.');
    }
    const latency = config.latencyMs ?? 0;
    if (!Number.isSafeInteger(latency) || latency < 0) {
      throw new PrivacyError('unknown', 'The fake latency must be a non-negative safe integer.');
    }
    this.latency = latency;
    this.newDepositStatus = ownDepositStatus(config.deposits ?? 'landed');
    if (config.swapReview !== undefined) this.configuredSwapReview = ownSwapReview(config.swapReview);
    if (config.demoSwapRates !== undefined) this.demoRates = ownDemoSwapRates(config.demoSwapRates);
    if (config.vault !== undefined) this.ownVaultConfig(config.vault);
    if (config.borrow !== undefined) this.ownBorrowConfig(config.borrow);
    if (config.endur !== undefined) this.ownEndurConfig(config.endur);
  }

  /** Own the demo unstaking's starting requests and balances (D-085). */
  private ownEndurConfig(endur: NonNullable<FakeConfig['endur']>): void {
    const invalid = () => new PrivacyError('unknown', 'The fake unstaking configuration is invalid.');
    const amount = (value: unknown): bigint => {
      if (value === undefined) return 0n;
      if (typeof value !== 'bigint' || value < 0n) throw invalid();
      return value;
    };
    this.endurStrkHeld = amount(ownField(endur, 'strkHeld'));
    this.endurXstrkHeld = amount(ownField(endur, 'xstrkHeld'));
    const requests = ownField(endur, 'requests');
    if (requests !== undefined) {
      if (!Array.isArray(requests)) throw invalid();
      for (const entry of requests) {
        const assets = amount(ownField(entry, 'assets'));
        const shares = amount(ownField(entry, 'shares'));
        const claimableIn = ownField(entry, 'claimableInSeconds');
        const funded = ownField(entry, 'funded');
        if (typeof claimableIn !== 'number' || !Number.isSafeInteger(claimableIn)) throw invalid();
        if (funded !== undefined && typeof funded !== 'boolean') throw invalid();
        const claimableAt = this.endurNow + claimableIn;
        this.endurRequests.push({
          requestId: this.endurNextId++,
          assets,
          shares,
          requestedAt: claimableAt - ENDUR_OBSERVED_CLAIM_DELAY_SECONDS,
          claimableAt,
          funded: funded ?? true,
        });
      }
    }
    this.endurDeployed = this.endurRequests.length > 0 || this.endurStrkHeld > 0n || this.endurXstrkHeld > 0n;
  }

  /** Move the demo unstaking clock forward by `seconds` (tests and the demo). */
  advanceEndurClock(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new PrivacyError('unknown', 'The fake clock only moves forward.');
    this.endurNow += seconds;
  }

  /** Own the demo Borrow counter's loans and prices, every token a pinned borrow token's (D-083). */
  private ownBorrowConfig(borrow: NonNullable<FakeConfig['borrow']>): void {
    const invalid = () => new PrivacyError('unknown', 'The fake borrow configuration is invalid.');
    for (const entry of borrow.positions ?? []) {
      const key = borrowPairKey(ownField(entry, 'collateral'), ownField(entry, 'debt'));
      const collateral = ownField(entry, 'collateralAmount');
      const debt = ownField(entry, 'debtAmount');
      if (!key || typeof collateral !== 'bigint' || collateral < 0n || typeof debt !== 'bigint' || debt < 0n) throw invalid();
      this.borrowLoans.set(`${key.collateral}:${key.debt}`, { collateral, debt });
    }
    for (const [token, price] of ownRecordEntries(borrow.prices, invalid)) {
      const info = borrowToken(token);
      if (!info || typeof price !== 'bigint' || price <= 0n) throw invalid();
      this.borrowPrices.set(info.token, price);
    }
    for (const token of borrow.stalePrices ?? []) {
      const info = borrowToken(token);
      if (!info) throw invalid();
      this.borrowStale.add(info.token);
    }
    this.borrowDeployed = this.borrowLoans.size > 0;
  }

  /** Own the demo Vault's starting positions and rates, every token a pinned market's (D-077, D-079). */
  private ownVaultConfig(vault: NonNullable<FakeConfig['vault']>): void {
    const invalid = () => new PrivacyError('unknown', 'The fake Vault configuration is invalid.');
    const holding = (shares: unknown, liquidity: unknown): { shares: bigint; liquidity?: bigint } => {
      const owned = shares ?? 0n;
      if (typeof owned !== 'bigint' || owned < 0n || (liquidity !== undefined && (typeof liquidity !== 'bigint' || liquidity < 0n))) {
        throw invalid();
      }
      return liquidity === undefined ? { shares: owned } : { shares: owned, liquidity: liquidity as bigint };
    };
    const strk = vaultMarket(VESU_VSTRK_ASSET)!;
    this.vaultHoldings.set(strk, holding(vault.shares, vault.liquidity));
    for (const [token, entry] of ownRecordEntries(vault.markets, invalid)) {
      const market = vaultMarket(token);
      if (!market || !entry || typeof entry !== 'object') throw invalid();
      this.vaultHoldings.set(market, holding(ownField(entry, 'shares'), ownField(entry, 'liquidity')));
    }
    for (const [token, rate] of ownRecordEntries(vault.rates, invalid)) {
      const market = vaultMarket(token);
      const value = ownField(rate, 'value');
      const decimals = ownField(rate, 'decimals');
      if (
        !market || typeof value !== 'bigint' || value < 0n
        || typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36
      ) {
        throw invalid();
      }
      this.vaultRatesByMarket.set(market, { value, decimals });
    }
    this.vaultDeployed = [...this.vaultHoldings.values()].some((entry) => entry.shares > 0n);
  }

  // -- test controls --------------------------------------------------------

  /** Make the next matching call fail. */
  injectFault(fault: Fault): void {
    this.faults.push(Object.freeze({ ...fault }));
  }

  /** Advance the chain. Matures any notes whose time has come. */
  advanceBlocks(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new PrivacyError('unknown', 'The block advance must be a non-negative safe integer.');
    }
    this.block += n;
    const stillMaturing: MaturingNote[] = [];
    for (const note of this.maturing) {
      if (note.matureAtBlock <= this.block) {
        this.credit(note.token, note.amount);
      } else {
        stillMaturing.push(note);
      }
    }
    this.maturing = stillMaturing;
  }

  /**
   * Change the pool fee mid-flight.
   *
   * The real fee is governance-settable and has already moved once, so a
   * batch prepared at one fee can be confirmed at another. `confirm` must
   * reject when that breaches the ceiling — this is how you test it.
   */
  setPoolFee(feeAmount: bigint): void {
    if (typeof feeAmount !== 'bigint' || feeAmount < 0n) {
      throw new PrivacyError('unknown', 'The fake pool fee must be a non-negative bigint.');
    }
    this.pool = { ...this.pool, feeAmount };
  }

  get currentBlock(): number {
    return this.block;
  }

  /**
   * Change what a confirmed transaction's receipt says (D-072): hold a shield
   * at `pending`, land it later, or make it `failed` as a revert would.
   */
  setDepositStatus(transactionHash: string, status: DepositStatus): void {
    if (!this.receipts.has(transactionHash)) {
      throw new PrivacyError('unknown', 'The fake has not confirmed that transaction.');
    }
    this.receipts.set(transactionHash, ownDepositStatus(status));
  }

  /**
   * Quote the next swaps differently (D-084): what avnu would answer once a
   * quote has expired and the swap asks again. Deterministic, like every
   * input here; a field left out keeps its current value.
   */
  setSwapQuote(quote: { swapReview?: FakeSwapReview; demoSwapRates?: FakeDemoSwapRates }): void {
    if (quote.swapReview !== undefined) this.configuredSwapReview = ownSwapReview(quote.swapReview);
    if (quote.demoSwapRates !== undefined) this.demoRates = ownDemoSwapRates(quote.demoSwapRates);
  }

  // -- PrivacyOperations ----------------------------------------------------

  async capability(signal?: AbortSignal): Promise<WalletCapability> {
    await this.tick('capability', signal);
    return Object.freeze({ ...this.cap });
  }

  async poolConfig(signal?: AbortSignal): Promise<PoolConfig> {
    await this.tick('poolConfig', signal);
    return Object.freeze({ ...this.pool });
  }

  async balances(tokens?: Address[], signal?: AbortSignal): Promise<PrivateBalance[]> {
    const requestedTokens = tokens === undefined ? undefined : [...tokens];
    await this.tick('balances', signal);
    const keys = requestedTokens?.length
      ? requestedTokens
      : [...new Set([...this.spendable.keys(), ...this.maturing.map((n) => n.token)])];
    return Object.freeze(keys.map((token) => {
      const spendable = this.spendable.get(token) ?? 0n;
      const maturing = this.maturing
        .filter((n) => sameAddress(n.token, token))
        .reduce((sum, n) => sum + n.amount, 0n);
      return Object.freeze({ token, spendable, maturing, total: spendable + maturing, maturityKnown: true });
    })) as PrivateBalance[];
  }

  /** D-094: the demo wallet's public balance of one token; `DEMO_PUBLIC_BALANCE` when unlisted. */
  async publicBalance(token: Address, signal?: AbortSignal): Promise<bigint> {
    assertAddress(token, 'fake public balance token');
    await this.tick('publicBalance', signal);
    return this.publicHeld.get(normalise(token)) ?? DEMO_PUBLIC_BALANCE;
  }

  async recipientStatus(address: Address, signal?: AbortSignal): Promise<RecipientStatus> {
    assertAddress(address, 'fake recipient');
    await this.tick('recipientStatus', signal);
    return this.registeredAddrs.has(normalise(address)) ? 'registered' : 'unregistered';
  }

  /** D-072: one balance read of every token, as the adapter makes it, reduced to a boolean. */
  async hasPrivateFunds(signal?: AbortSignal): Promise<boolean> {
    const balances = await this.balances(undefined, signal);
    return balances.some((entry) => entry.total > 0n);
  }

  /** D-072: the fake is its own chain, so it knows every receipt it produced. */
  async depositStatus(transactionHash: string, signal?: AbortSignal): Promise<DepositStatus> {
    await this.tick('depositStatus', signal);
    // A hash this fake never confirmed has no receipt yet, as on the network.
    return this.receipts.get(transactionHash) ?? 'pending';
  }

  async prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch> {
    // Own the intents synchronously, before the first await, exactly as the
    // Wallet API implementation does — its own capture sits after a sync
    // `throwIfAborted` and before anything awaited. `tick()` is async, so
    // awaiting it first would yield a microtask even at zero latency and let a
    // caller mutate its array between the unawaited `prepare()` call and the
    // settled promise. A double that captures later grants a freedom
    // production does not.
    const reviewed = freezeIntents(intents);
    await this.tick('prepare', signal);
    if (reviewed.length === 0) {
      throw new PrivacyError('unknown', 'prepare called with no intents');
    }
    for (const intent of reviewed) {
      const twoSided = intent.kind === 'swap' || intent.kind === 'stake';
      const amount = twoSided ? intent.amountIn : intent.amount;
      if (amount <= 0n) throw new PrivacyError('unknown', 'Amounts must be positive.');
      assertAddress(twoSided ? intent.tokenIn : intent.token, 'fake intent token');
      if (intent.kind === 'swap' && intent.minAmountOut <= 0n) {
        throw new PrivacyError('unknown', 'Minimum output must be positive.');
      }
      // D-126: the degen floor's ceiling upstairs, the Exchange's downstairs.
      const slippageCeiling = intent.kind === 'swap' && intent.degen === true
        ? SWAP_DEGEN_MAX_SLIPPAGE_BPS
        : SWAP_MAX_SLIPPAGE_BPS;
      if (
        intent.kind === 'swap' && intent.slippageBps !== undefined
        && (!Number.isSafeInteger(intent.slippageBps) || intent.slippageBps <= 0 || intent.slippageBps > slippageCeiling)
      ) {
        throw new PrivacyError('unknown', "The swap's slippage is outside what this build allows.");
      }
      if (twoSided) assertAddress(intent.tokenOut, `fake ${intent.kind} output token`);
      // Production pins the pair (the anonymizer pins none); so does the fake.
      if (
        intent.kind === 'stake'
        && (!sameAddress(intent.tokenIn, ENDUR_XSTRK_ASSET) || !sameAddress(intent.tokenOut, ENDUR_XSTRK))
      ) {
        throw new PrivacyError('unknown', 'The stake route accepts only STRK in and xSTRK out.');
      }
      if (intent.kind === 'unshield' || intent.kind === 'transfer') {
        assertAddress(intent.recipient, 'fake intent recipient');
      }
    }

    const warnings: BatchWarning[] = [];
    const feeAtPrepare = this.pool.feeAmount;

    // A shield cannot ride along with the transfer it funds: the deposit's
    // public leg names the depositor, so bundling publishes the link.
    const hasShield = reviewed.some((i) => i.kind === 'shield');
    const hasSpend = reviewed.some((i) => i.kind !== 'shield');
    if (hasShield && hasSpend) {
      throw new PrivacyError(
        'privacy-leak',
        'Shielding and private spending must be prepared as separate operations.',
      );
    }
    const kinds = new Set(reviewed.map((intent) => intent.kind));
    if (!hasShield && kinds.size > 1) {
      throw new PrivacyError('unknown', 'A private batch may contain only one approved route type.');
    }
    if (kinds.has('swap') && reviewed.length > 1) {
      throw new PrivacyError('unknown', 'A private swap must be prepared one at a time.');
    }
    // D-084: a swap runs through the player's shadow account, so a wallet
    // without shadow accounts cannot swap, as in the adapter.
    if (kinds.has('swap') && this.cap.supportsShadowAccounts !== true) {
      throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
    }
    if (kinds.has('stake') && reviewed.length > 1) {
      throw new PrivacyError('unknown', 'A private stake must be prepared one at a time.');
    }
    const promptCount = 1;

    // D-094: a shield deposits its amount plus the pool fee, as in the adapter.
    const deposits = shieldDeposits(reviewed, { feeToken: this.pool.feeToken, feeAmount: feeAtPrepare });
    for (const [index, intent] of reviewed.entries()) {
      if (intent.kind === 'shield') {
        warnings.push({
          kind: 'public-leg',
          detail: `Depositing ${deposits.at(index)} is public: the amount and your address are visible on-chain.`,
        });
      }
      if (intent.kind === 'unshield') {
        warnings.push({
          kind: 'public-leg',
          detail: `Withdrawing reveals the amount and ${intent.recipient} on-chain.`,
        });
      }
      // A stake carries no public-leg warning, matching the Wallet API adapter:
      // D-064 waived its in-game disclosure, and a swap carries none either.
      if (intent.kind === 'transfer' && !this.registeredAddrs.has(normalise(intent.recipient))) {
        // The recipient's fact, not this account's, as in the adapter (D-074).
        throw new PrivacyError(
          'recipient-not-registered',
          'The recipient is not registered with the privacy pool.',
        );
      }
    }

    // Charge spends in their own token and both private fees in the fee token.
    const spendByToken = new Map<string, bigint>();
    for (const intent of reviewed) {
      if (intent.kind === 'shield') continue;
      const twoSided = intent.kind === 'swap' || intent.kind === 'stake';
      const token = twoSided ? intent.tokenIn : intent.token;
      const amount = twoSided ? intent.amountIn : intent.amount;
      spendByToken.set(normalise(token), (spendByToken.get(normalise(token)) ?? 0n) + amount);
    }
    if (hasSpend) {
      const feeToken = normalise(this.pool.feeToken);
      spendByToken.set(
        feeToken,
        (spendByToken.get(feeToken) ?? 0n) + feeAtPrepare,
      );
    }
    for (const [token, required] of spendByToken) {
      const have = this.spendable.get(token) ?? this.lookupLoose(token);
      const remaining = have - required;
      if (remaining < 0n) {
        throw new PrivacyError(
          'insufficient-balance',
          `Needs ${required}, has ${have}. Remember the pool fee is paid in ${this.pool.feeToken}.`,
        );
      }
      if (sameAddress(token, this.pool.feeToken) && remaining < feeAtPrepare) {
        warnings.push({ kind: 'leaves-below-fee', remaining, feeEstimate: feeAtPrepare });
      }
    }

    // The warning names no token and the shell shows it in the fee token, so it
    // counts the fee token's maturing notes alone: summing a USDC deposit or a
    // swap's output with STRK would add base units of different tokens (D-072).
    const maturingFeeNotes = this.maturing.filter((n) => sameAddress(n.token, this.pool.feeToken));
    const maturingTotal = maturingFeeNotes.reduce((s, n) => s + n.amount, 0n);
    if (maturingTotal > 0n) {
      const soonest = Math.min(...maturingFeeNotes.map((n) => n.matureAtBlock));
      warnings.push({
        kind: 'funds-maturing',
        maturingAmount: maturingTotal,
        blocksRemaining: Math.max(0, soonest - this.block),
      });
    }

    // The wallet prices its own network fee for every route (D-082, D-084).
    const gasEstimate = 0n;
    const { intents: canonicalIntents, swapReview } = this.canonicalizeIntents(reviewed);
    const publishedWarnings = freezeWarnings(warnings);
    const self = this;
    let discarded = false;
    let confirmationAttempted = false;

    return {
      // The frozen snapshot itself: one owner for the published view, the
      // recorded submission and the balance arithmetic.
      intents: canonicalIntents,
      poolFee: feeAtPrepare,
      gasEstimate,
      totalCost: feeAtPrepare + gasEstimate,
      warnings: publishedWarnings,
      promptCount,
      ...(swapReview === undefined ? {} : { swapReview }),
      ...(this.placementReceipts ? { countsTowardPlacement: true as const } : {}),
      async confirm({ feeCeiling, onProgress, signal: sig, acknowledgeUncheckedPrice }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFeeCeilingInput(feeCeiling);
        // D-084: an unchecked swap price needs the player's acknowledgement, as in the adapter.
        if (swapReview?.priceCheck.status === 'unchecked' && acknowledgeUncheckedPrice !== true) {
          throw new PrivacyError('unknown', 'This swap has no independent price check. Acknowledge that before confirming.');
        }
        if (confirmationAttempted) {
          throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
        }
        confirmationAttempted = true;
        await self.tick('confirm', sig);
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');

        // The fee can move between prepare and confirm. This is the guard.
        const currentFee = self.pool.feeAmount;
        if (currentFee > feeCeiling) {
          throw new PrivacyError(
            'unknown',
            `Private fee is now ${currentFee}, above the ceiling of ${feeCeiling}. Re-prepare.`,
          );
        }

        emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm in your wallet' });
        emitProgress(onProgress, { stage: 'proving', message: 'Your wallet is generating a proof' });
        emitProgress(onProgress, { stage: 'submitting', message: 'Submitting' });

        // D-094: the deposits leave the demo wallet's public balance.
        if (hasShield) self.debitPublic(canonicalIntents, feeAtPrepare);
        self.applyIntents(canonicalIntents, currentFee);
        self.submitted.push([...canonicalIntents]);
        const transactionHash = `0xfake${(++self.txCounter).toString(16).padStart(4, '0')}`;
        // A spend's receipt carries no deposit, as on the network.
        self.receipts.set(transactionHash, hasShield ? self.newDepositStatus : 'failed');
        emitProgress(onProgress, { stage: 'done', message: 'Done' });
        return { transactionHash };
      },
      discard() {
        discarded = true;
      },
    };
  }

  // -- The Vault (D-077, D-079) ----------------------------------------------

  /**
   * The demo stand-in address's position in every pinned vault, at the DEMO
   * share rate, and the demo stand-in address. Reports the stages the Wallet
   * API adapter reports, in the same order, so the Shell's probe logging is
   * exercised in demo mode too. The fake has no build policy: it answers for
   * every token `VAULT_MARKETS` pins, in that order.
   */
  async vaultPositions(options?: VaultCallOptions): Promise<VaultPositions> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('vaultPosition', signal);
    this.vaultIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    return Object.freeze({
      standIn: DEMO_VAULT_STAND_IN,
      positions: Object.freeze(VAULT_MARKETS.map((market) => this.vaultPositionNow(market))),
    });
  }

  async prepareVaultSupply(token: Address, amount: bigint, options?: VaultCallOptions): Promise<PreparedVaultBatch> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('vaultPrepare', signal);
    const market = vaultMarket(token);
    if (!market) throw new PrivacyError('unknown', 'The Vault does not lend that token in this build.');
    // D-081: as the adapter, nothing is supplied into a collateral-only market.
    if (!market.lendable) throw new PrivacyError('unknown', 'Vesu lends none of that token out, so the Vault does not supply it.');
    if (typeof amount !== 'bigint' || amount <= 0n) throw new PrivacyError('unknown', 'Amounts must be positive.');
    this.vaultIdentity(onStage);
    this.assertVaultFunds(market, amount);
    const action: VaultAction = Object.freeze({ kind: 'supply', token: market.token, amount });
    return this.vaultBatch(action, () => {
      this.assertVaultFunds(market, amount);
      this.debit(market.token, amount);
      this.debit(this.pool.feeToken, this.pool.feeAmount);
      this.vaultHolding(market).shares += demoVaultShares(amount);
      this.vaultDeployed = true;
    });
  }

  async prepareVaultRedeem(token: Address, amount: bigint | 'all', options?: VaultCallOptions): Promise<PreparedVaultBatch> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('vaultPrepare', signal);
    const market = vaultMarket(token);
    if (!market) throw new PrivacyError('unknown', 'The Vault does not lend that token in this build.');
    if (amount !== 'all' && (typeof amount !== 'bigint' || amount <= 0n)) {
      throw new PrivacyError('unknown', 'Amounts must be positive.');
    }
    this.vaultIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    const position = this.vaultPositionNow(market);
    this.assertVaultFunds(market, 0n);
    if (amount === 'all') {
      if (position.shares === 0n) throw new PrivacyError('unknown', 'There is nothing in the Vault to redeem.');
      if (position.redeemable < position.assets) {
        throw new PrivacyError('unknown', 'The vault cannot pay out the whole position right now.');
      }
      const action: VaultAction = Object.freeze({ kind: 'redeem', token: market.token, amount: position.assets, all: true });
      return this.vaultBatch(action, () => {
        this.assertVaultFunds(market, 0n);
        const holding = this.vaultHolding(market);
        const assets = demoVaultAssets(holding.shares);
        this.debit(this.pool.feeToken, this.pool.feeAmount);
        holding.shares = 0n;
        if (assets > 0n) this.mintNote(market.token, assets);
      });
    }
    if (amount > position.redeemable) {
      throw new PrivacyError('unknown', 'That is more than the vault lets this position withdraw now.');
    }
    const action: VaultAction = Object.freeze({ kind: 'redeem', token: market.token, amount, all: false });
    return this.vaultBatch(action, () => {
      this.assertVaultFunds(market, 0n);
      const holding = this.vaultHolding(market);
      const burned = demoVaultSharesToWithdraw(amount);
      if (burned > holding.shares) throw new PrivacyError('unknown', 'That is more than the vault lets this position withdraw now.');
      this.debit(this.pool.feeToken, this.pool.feeAmount);
      holding.shares -= burned;
      this.mintNote(market.token, amount);
    });
  }

  /**
   * The DEMO supply APYs this fake was configured with, in `VAULT_MARKETS`
   * order (D-079). Not Vesu's figures: a demo seam states none by default.
   */
  async vaultRates(signal?: AbortSignal): Promise<readonly VaultRate[]> {
    await this.tick('vaultRates', signal);
    const rates: VaultRate[] = [];
    for (const market of VAULT_MARKETS) {
      const rate = this.vaultRatesByMarket.get(market);
      if (rate) rates.push(Object.freeze({ token: market.token, supplyApy: Object.freeze({ ...rate }) }));
    }
    return Object.freeze(rates);
  }

  // -- The Borrow counter (D-083) --------------------------------------------

  /**
   * The demo market: every pinned token at its DEMO price, an ample demo
   * reserve and no other borrower, and every pinned pair at its DEMO max
   * LTV. Vesu's 0.95 utilization ceiling is kept; its $10 floor is a DEMO
   * $1, so a demo player's 250 practice STRK can open a loan at all.
   */
  async borrowMarket(signal?: AbortSignal): Promise<BorrowMarket> {
    await this.tick('borrowMarket', signal);
    return this.demoBorrowMarket();
  }

  async borrowPositions(options?: VaultCallOptions): Promise<BorrowPositions> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('borrowPositions', signal);
    this.borrowIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    return Object.freeze({
      standIn: DEMO_BORROW_STAND_IN,
      positions: Object.freeze(BORROW_PAIRS
        .map((pair) => this.demoLoan(pair.collateral, pair.debt))
        .filter((loan) => loan.collateralShares > 0n || loan.nominalDebt > 0n)),
    });
  }

  async prepareBorrow(request: BorrowRequest, options?: VaultCallOptions): Promise<PreparedBorrowBatch> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('borrowPrepare', signal);
    const key = borrowPairKey(ownField(request, 'collateral'), ownField(request, 'debt'));
    if (!key) throw new PrivacyError('unknown', 'The borrow counter does not offer that pair in this build.');
    this.borrowIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    const loan = this.demoLoan(key.collateral, key.debt);
    const assessed = assessBorrow(request, this.demoBorrowMarket(), loan, demoMaxLtv(key.collateral, key.debt));
    if (!assessed.ok) throw new BorrowRefusedError(assessed.reason, `The demo borrow counter refuses this: ${assessed.reason}.`);
    const id = `${key.collateral}:${key.debt}`;
    const holding = () => {
      let entry = this.borrowLoans.get(id);
      if (!entry) {
        entry = { collateral: 0n, debt: 0n };
        this.borrowLoans.set(id, entry);
      }
      return entry;
    };
    let action: BorrowAction;
    let fromPool: { token: Address; amount: bigint } | null = null;
    let apply: () => void;
    switch (request.kind) {
      case 'borrow': {
        const { collateralAmount, borrowAmount } = request;
        action = Object.freeze({ kind: 'borrow', collateral: key.collateral, debt: key.debt, collateralAmount, borrowAmount });
        if (collateralAmount > 0n) fromPool = { token: key.collateral, amount: collateralAmount };
        apply = () => {
          const entry = holding();
          if (collateralAmount > 0n) this.debit(key.collateral, collateralAmount);
          entry.collateral += collateralAmount;
          entry.debt += borrowAmount;
          this.mintNote(key.debt, borrowAmount);
        };
        break;
      }
      case 'add-collateral': {
        const { amount } = request;
        action = Object.freeze({ kind: 'add-collateral', collateral: key.collateral, debt: key.debt, amount });
        fromPool = { token: key.collateral, amount };
        apply = () => {
          this.debit(key.collateral, amount);
          holding().collateral += amount;
        };
        break;
      }
      case 'repay': {
        const all = request.amount === 'all';
        const { fromPool: amount, buffer } = assessed;
        action = Object.freeze({ kind: 'repay', collateral: key.collateral, debt: key.debt, amount, all, buffer });
        fromPool = { token: key.debt, amount };
        apply = () => {
          const entry = holding();
          this.debit(key.debt, amount);
          // The demo accrues no interest, so a repay-all's whole buffer comes back.
          if (all) {
            entry.debt = 0n;
            if (buffer > 0n) this.mintNote(key.debt, buffer);
          } else {
            entry.debt -= amount;
          }
        };
        break;
      }
      case 'withdraw-collateral': {
        const all = request.amount === 'all';
        const amount = all ? loan.collateralAmount : (request.amount as bigint);
        action = Object.freeze({ kind: 'withdraw-collateral', collateral: key.collateral, debt: key.debt, amount, all });
        apply = () => {
          const entry = holding();
          entry.collateral -= amount;
          this.mintNote(key.collateral, amount);
        };
        break;
      }
    }
    const funds = () => this.assertBorrowFunds(fromPool);
    funds();
    const self = this;
    const vault = this.vaultBatch(action as unknown as VaultAction, () => {
      funds();
      apply();
      self.debit(self.pool.feeToken, self.pool.feeAmount);
      self.borrowDeployed = true;
    }, { record: (submitted) => self.borrowSubmitted.push(submitted as unknown as BorrowAction), fault: 'borrowConfirm', subject: 'borrow' });
    return Object.freeze({ ...vault, action, after: assessed.after }) as PreparedBorrowBatch;
  }

  private demoBorrowMarket(): BorrowMarket {
    const assets: BorrowAsset[] = BORROW_TOKEN_INFO.map((info) => {
      const scale = 10n ** BigInt(info.decimals);
      return Object.freeze({
        token: info.token,
        price: this.borrowPrices.get(info.token) ?? VESU_SCALE,
        priceValid: !this.borrowStale.has(info.token),
        scale,
        floor: VESU_SCALE,
        reserve: 10_000_000n * scale,
        totalDebt: 0n,
        maxUtilization: 950_000_000_000_000_000n,
      });
    });
    const pairs: BorrowPair[] = BORROW_PAIRS.map((pair) => {
      const debt = BORROW_TOKEN_INFO.find((info) => info.token === pair.debt)!;
      return Object.freeze({
        collateral: pair.collateral,
        debt: pair.debt,
        maxLtv: demoMaxLtv(pair.collateral, pair.debt),
        liquidationFactor: 900_000_000_000_000_000n,
        debtCap: 1_000_000n * 10n ** BigInt(debt.decimals),
        totalDebt: 0n,
      });
    });
    return Object.freeze({ assets: Object.freeze(assets), pairs: Object.freeze(pairs) });
  }

  private demoLoan(collateral: Address, debt: Address): BorrowPosition {
    const entry = this.borrowLoans.get(`${collateral}:${debt}`) ?? { collateral: 0n, debt: 0n };
    const market = this.demoBorrowMarket();
    return Object.freeze({
      collateral,
      debt,
      collateralShares: entry.collateral,
      nominalDebt: entry.debt,
      collateralAmount: entry.collateral,
      debtAmount: entry.debt,
      health: borrowHealth({
        collateralAmount: entry.collateral,
        debtAmount: entry.debt,
        collateral: market.assets.find((asset) => asset.token === collateral)!,
        debt: market.assets.find((asset) => asset.token === debt)!,
        maxLtv: demoMaxLtv(collateral, debt),
      }),
    });
  }

  /** Capability, then the commitment (asked once), then the address: the adapter's order. */
  private borrowIdentity(onStage: VaultStageCallback | undefined): void {
    const supported = this.cap.supportsShadowAccounts === true;
    emitVaultStage(onStage, { stage: 'capability', supported });
    if (!supported) {
      throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
    }
    if (this.cap.registration === 'unregistered') {
      emitVaultStage(onStage, { stage: 'commitment', ok: false, code: 118 });
      throw new PrivacyError('not-registered', 'This wallet is not registered with the privacy pool.');
    }
    if (!this.borrowCommitted) {
      this.borrowCommitted = true;
      emitVaultStage(onStage, { stage: 'commitment', ok: true });
    }
    emitVaultStage(onStage, { stage: 'address', resolved: true, deployed: this.borrowDeployed });
  }

  /** The shielded balance must cover what leaves the pool and the pool fee, as the wallet checks at proof time. */
  private assertBorrowFunds(fromPool: { token: Address; amount: bigint } | null): void {
    const have = (token: Address) => this.spendable.get(token) ?? this.lookupLoose(token);
    const feeToken = this.pool.feeToken;
    const needed: Array<[Address, bigint]> = [];
    if (fromPool && sameAddress(fromPool.token, feeToken)) {
      needed.push([feeToken, fromPool.amount + this.pool.feeAmount]);
    } else {
      if (fromPool) needed.push([fromPool.token, fromPool.amount]);
      needed.push([feeToken, this.pool.feeAmount]);
    }
    for (const [token, required] of needed) {
      const held = have(token);
      if (held < required) {
        throw new PrivacyError('insufficient-balance', `Needs ${required}, has ${held}. Remember the pool fee is paid in ${feeToken}.`);
      }
    }
  }

  // -- Endur unstaking (D-085) -----------------------------------------------

  /**
   * The demo unstaking stand-in address: its unpaid requests by the demo
   * clock, and what sits there. The same stages as the Wallet API adapter, in
   * the same order.
   */
  /**
   * D-091: the stake fixture's DEMO RATE, 1 xSTRK = 1.25 STRK, marked `demo`
   * so the shell labels it. It is the same fixed rate the fake stakes and
   * unstakes at, never Endur's.
   */
  async endurRate(signal?: AbortSignal): Promise<EndurRate> {
    await this.tick('endurRate', signal);
    return Object.freeze({ strkPerXstrk: demoUnstakeAssets(10n ** 18n), origin: 'demo' as const });
  }

  /**
   * Leaderboard phase 1: a DEMO placement, the same every time, so the stand's
   * panel can be seen without a wallet. Nothing here is anybody's count.
   */
  async checkPlacement(signal?: AbortSignal): Promise<PlacementCheck> {
    await this.tick('checkPlacement', signal);
    return Object.freeze({
      season: LEADERBOARD_SEASON,
      receipts: 15,
      defi: 3,
      verified: 15,
      histogram: DEMO_PLACEMENT_HISTOGRAM,
      ranked: 15,
      placement: placementFrom(DEMO_PLACEMENT_HISTOGRAM, 15, true),
      rankDefi: false,
    });
  }

  async endurUnstakePosition(options?: VaultCallOptions): Promise<EndurUnstakePosition> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('endurPosition', signal);
    this.endurIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    return this.endurPositionNow();
  }

  async prepareEndurUnstake(shares: bigint, options?: VaultCallOptions): Promise<PreparedEndurBatch> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('endurPrepare', signal);
    if (typeof shares !== 'bigint' || shares <= 0n) throw new PrivacyError('unknown', 'Amounts must be positive.');
    this.endurIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    this.assertEndurFunds(shares);
    const action: EndurAction = Object.freeze({ kind: 'request', shares, leftover: this.endurXstrkHeld });
    const batch = this.vaultBatch(action as unknown as VaultAction, () => {
      this.assertEndurFunds(shares);
      this.debit(ENDUR_XSTRK, shares);
      this.debit(this.pool.feeToken, this.pool.feeAmount);
      if (this.endurXstrkHeld > 0n) this.mintNote(ENDUR_XSTRK, this.endurXstrkHeld);
      this.endurXstrkHeld = 0n;
      this.endurRequests.push({
        requestId: this.endurNextId++,
        assets: demoUnstakeAssets(shares),
        shares,
        requestedAt: this.endurNow,
        claimableAt: this.endurNow + ENDUR_OBSERVED_CLAIM_DELAY_SECONDS,
        funded: true,
      });
      this.endurDeployed = true;
    }, { record: (submitted) => this.endurSubmitted.push(submitted as unknown as EndurAction), fault: 'endurConfirm', subject: 'unstaking' });
    return Object.freeze({ ...batch, action }) as unknown as PreparedEndurBatch;
  }

  async prepareEndurClaim(options?: VaultCallOptions): Promise<PreparedEndurBatch> {
    const { signal, onStage } = ownVaultOptions(options);
    await this.tick('endurPrepare', signal);
    this.endurIdentity(onStage);
    emitVaultStage(onStage, { stage: 'position', ok: true });
    // As the adapter: STRK already held is collected alone; otherwise only
    // requests whose claim would pay now are claimed.
    const ready = this.endurStrkHeld > 0n
      ? []
      : this.endurPositionNow().requests.filter((entry) => entry.status === 'ready').slice(0, MAX_ENDUR_CLAIMS_PER_BATCH);
    if (ready.length === 0 && this.endurStrkHeld === 0n) {
      throw new PrivacyError('unknown', 'Nothing has finished unstaking yet.');
    }
    this.assertEndurFunds(0n);
    const requestIds = Object.freeze(ready.map((entry) => entry.requestId));
    const owed = ready.reduce((sum, entry) => sum + entry.assets, 0n);
    const action: EndurAction = Object.freeze({ kind: 'claim', requestIds, owed, held: this.endurStrkHeld });
    const batch = this.vaultBatch(action as unknown as VaultAction, () => {
      this.assertEndurFunds(0n);
      const paying = this.endurRequests.filter((entry) => requestIds.includes(entry.requestId));
      if (paying.length !== requestIds.length) throw new PrivacyError('unknown', 'A request was already paid. Read again.');
      const total = paying.reduce((sum, entry) => sum + entry.assets, 0n) + this.endurStrkHeld;
      this.debit(this.pool.feeToken, this.pool.feeAmount);
      this.endurRequests = this.endurRequests.filter((entry) => !requestIds.includes(entry.requestId));
      this.endurStrkHeld = 0n;
      if (total > 0n) this.mintNote(ENDUR_XSTRK_ASSET, total);
    }, { record: (submitted) => this.endurSubmitted.push(submitted as unknown as EndurAction), fault: 'endurConfirm', subject: 'unstaking' });
    return Object.freeze({ ...batch, action }) as unknown as PreparedEndurBatch;
  }

  /**
   * Demo Endur's own service paying every ready request to the stand-in
   * address, as the real one does once the queue is funded (D-085).
   */
  fundEndurRequests(): void {
    for (const entry of this.endurRequests) entry.funded = true;
  }

  /**
   * Demo Endur's own service paying every ready, funded request to the
   * stand-in address (see `payReadyEndurRequests`); `fundEndurRequests` funds
   * every request first, as the real one funds and claims together.
   */
  payReadyEndurRequests(): void {
    const payable = (entry: { claimableAt: number; funded: boolean }) => entry.funded && entry.claimableAt <= this.endurNow;
    this.endurStrkHeld += this.endurRequests.filter(payable).reduce((sum, entry) => sum + entry.assets, 0n);
    this.endurRequests = this.endurRequests.filter((entry) => !payable(entry));
  }

  private endurPositionNow(): EndurUnstakePosition {
    const requests = classifyEndurRequests(
      this.endurRequests.map(({ funded, ...entry }) => ({
        ...entry,
        claimed: false,
        claimableNow: funded && entry.claimableAt <= this.endurNow,
      })),
      this.endurNow,
    );
    return Object.freeze({
      standIn: DEMO_ENDUR_STAND_IN,
      chainTime: this.endurNow,
      requests: Object.freeze(requests),
      strkHeld: this.endurStrkHeld,
      xstrkHeld: this.endurXstrkHeld,
      unlisted: 0,
      complete: true,
    });
  }

  /** Capability, then the commitment (asked once), then the address: the adapter's order. */
  private endurIdentity(onStage: VaultStageCallback | undefined): void {
    const supported = this.cap.supportsShadowAccounts === true;
    emitVaultStage(onStage, { stage: 'capability', supported });
    if (!supported) {
      throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
    }
    if (this.cap.registration === 'unregistered') {
      emitVaultStage(onStage, { stage: 'commitment', ok: false, code: 118 });
      throw new PrivacyError('not-registered', 'This wallet is not registered with the privacy pool.');
    }
    if (!this.endurCommitted) {
      this.endurCommitted = true;
      emitVaultStage(onStage, { stage: 'commitment', ok: true });
    }
    emitVaultStage(onStage, { stage: 'address', resolved: true, deployed: this.endurDeployed });
  }

  /** `shares` xSTRK and the pool fee in STRK, as the wallet checks at proof time. */
  private assertEndurFunds(shares: bigint): void {
    const have = (token: Address) => this.spendable.get(token) ?? this.lookupLoose(token);
    const needed: Array<[Address, bigint]> = [[ENDUR_XSTRK, shares], [this.pool.feeToken, this.pool.feeAmount]];
    for (const [token, required] of needed) {
      const held = have(token);
      if (held < required) {
        throw new PrivacyError('insufficient-balance', `Needs ${required}, has ${held}. Remember the pool fee is paid in ${this.pool.feeToken}.`);
      }
    }
  }

  private vaultHolding(market: VaultMarket): { shares: bigint; liquidity?: bigint } {
    let holding = this.vaultHoldings.get(market);
    if (!holding) {
      holding = { shares: 0n };
      this.vaultHoldings.set(market, holding);
    }
    return holding;
  }

  private vaultPositionNow(market: VaultMarket): VaultPosition {
    const { shares, liquidity } = this.vaultHolding(market);
    const assets = demoVaultAssets(shares);
    const redeemable = liquidity !== undefined && liquidity < assets ? liquidity : assets;
    return Object.freeze({ token: market.token, shares, assets, redeemable });
  }

  /** Capability, then the commitment (asked once), then the address: the adapter's order. */
  private vaultIdentity(onStage: VaultStageCallback | undefined): void {
    const supported = this.cap.supportsShadowAccounts === true;
    emitVaultStage(onStage, { stage: 'capability', supported });
    if (!supported) {
      throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
    }
    if (this.cap.registration === 'unregistered') {
      emitVaultStage(onStage, { stage: 'commitment', ok: false, code: 118 });
      throw new PrivacyError('not-registered', 'This wallet is not registered with the privacy pool.');
    }
    if (!this.vaultCommitted) {
      this.vaultCommitted = true;
      emitVaultStage(onStage, { stage: 'commitment', ok: true });
    }
    emitVaultStage(onStage, { stage: 'address', resolved: true, deployed: this.vaultDeployed });
  }

  /**
   * The shielded balance must cover `amount` of the market's token and the
   * pool fee, as the wallet checks at proof time. The fake takes the fee in
   * the pool's fee token (STRK) whatever the Vault moves: the conservative
   * case of D-079, since a real wallet chooses the token that pays it and may
   * take it in the moved token instead.
   */
  private assertVaultFunds(market: VaultMarket, amount: bigint): void {
    const have = (token: Address) => this.spendable.get(token) ?? this.lookupLoose(token);
    const feeToken = this.pool.feeToken;
    const sameToken = sameAddress(market.token, feeToken);
    const needed: Array<[Address, bigint]> = sameToken
      ? [[market.token, amount + this.pool.feeAmount]]
      : [[market.token, amount], [feeToken, this.pool.feeAmount]];
    for (const [token, required] of needed) {
      const held = have(token);
      if (held < required) {
        throw new PrivacyError(
          'insufficient-balance',
          `Needs ${required}, has ${held}. Remember the pool fee is paid in ${feeToken}.`,
        );
      }
    }
  }

  private vaultBatch(
    action: VaultAction,
    apply: () => void,
    route: {
      record: (action: VaultAction) => void;
      fault: Fault['on'];
      subject: string;
    } = { record: (submitted) => this.vaultSubmitted.push(submitted), fault: 'vaultConfirm', subject: 'Vault' },
  ): PreparedVaultBatch {
    const self = this;
    const feeAtPrepare = this.pool.feeAmount;
    let discarded = false;
    let confirmationAttempted = false;
    return Object.freeze({
      action,
      poolFee: feeAtPrepare,
      gasEstimate: 0n,
      totalCost: feeAtPrepare,
      warnings: Object.freeze([]),
      promptCount: 1,
      ...(this.placementReceipts ? { countsTowardPlacement: true as const } : {}),
      async confirm({ feeCeiling, onProgress, onStage, onSubmitted, signal }: Parameters<PreparedVaultBatch['confirm']>[0]) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        assertFeeCeilingInput(feeCeiling);
        if (confirmationAttempted) {
          throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
        }
        confirmationAttempted = true;
        if (self.pool.feeAmount > feeCeiling) {
          throw new PrivacyError(
            'unknown',
            `Private fee is now ${self.pool.feeAmount}, above the ceiling of ${feeCeiling}. Re-prepare.`,
          );
        }
        emitProgress(onProgress, { stage: 'awaiting-approval', message: `Confirm the ${route.subject} action in your wallet` });
        try {
          await self.tick(route.fault, signal);
          if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
          apply();
        } catch (error) {
          const kind = error instanceof PrivacyError ? error.kind : 'unknown';
          emitVaultStage(onStage, { stage: 'submit', ok: false, code: kind === 'user-rejected' ? 113 : kind === 'insufficient-balance' ? 119 : null });
          emitProgress(onProgress, { stage: 'failed', message: `The ${route.subject} action failed` });
          throw error;
        }
        route.record(action);
        const transactionHash = `0xfake${(++self.txCounter).toString(16).padStart(4, '0')}`;
        // A Vault receipt carries no deposit naming this account.
        self.receipts.set(transactionHash, 'failed');
        emitVaultStage(onStage, { stage: 'submit', ok: true });
        try {
          onSubmitted?.(Object.freeze({ transactionHash }));
        } catch {
          // An observer cannot turn a submitted transaction into a failure.
        }
        emitProgress(onProgress, { stage: 'confirming', message: 'Waiting for the network' });
        emitVaultStage(onStage, { stage: 'receipt', status: 'succeeded' });
        emitProgress(onProgress, { stage: 'done', message: 'Done' });
        return Object.freeze({ transactionHash, outcome: 'succeeded' as const });
      },
      discard() {
        discarded = true;
      },
    });
  }

  // -- internals ------------------------------------------------------------

  private canonicalizeIntents(intents: readonly Intent[]): {
    intents: readonly Intent[];
    swapReview?: SwapReview;
  } {
    const intent = intents.length === 1 && intents[0]?.kind === 'swap' ? intents[0] : undefined;
    const configured = intent ? this.demoQuote(intent) ?? this.configuredSwapReview : undefined;
    if (!configured || !intent) return { intents };
    if (!Number.isSafeInteger(configured.expiresAt) || configured.expiresAt <= 0) {
      throw new PrivacyError('unknown', 'The deterministic swap review is invalid.');
    }
    // D-090: the player's own slippage when the intent carries one, as the adapter does.
    const slippageBps = intent.slippageBps ?? configured.slippageBps;
    const protectedMinimum = protectedMinimumOut(configured.expectedAmountOut, slippageBps);
    if (protectedMinimum < intent.minAmountOut) {
      throw new PrivacyError('unknown', 'The requested swap floor exceeds the protected minimum.');
    }
    const canonicalIntent: Intent = Object.freeze({ ...intent, minAmountOut: protectedMinimum });
    // D-126: the bound in the review is the floor's own — the degen floor's
    // wider 12% upstairs, the Exchange's 3% downstairs — and a fixture may
    // only widen it further, never narrow it, so no fixture can pretend the
    // Exchange allows more than it does.
    const fixture = configured.priceCheck ?? FAKE_PRICE_CHECK;
    const floorBoundBps = intent.degen === true ? SWAP_DEGEN_PRICE_BOUND_BPS : SWAP_PRICE_BOUND_BPS;
    const priceCheck: SwapPriceCheck = Object.freeze({
      ...fixture,
      boundBps: Math.max(fixture.boundBps, floorBoundBps),
    });
    // The fake has no oracle, but it refuses exactly where the adapter does —
    // a fixture whose shortfall passes its floor's bound never reaches a
    // review, so a counter's refusal path is exercised the same way here.
    if (priceCheck.status === 'checked' && (priceCheck.shortfallBps ?? 0) > priceCheck.boundBps) {
      const shortfallBps = priceCheck.shortfallBps ?? 0;
      throw new SwapPriceGuardError(
        `avnu's quote is ${(shortfallBps / 100).toFixed(2)}% below the oracle price, more than the ${priceCheck.boundBps / 100}% allowed, so it was refused.`,
        { shortfallBps, boundBps: priceCheck.boundBps },
      );
    }
    return {
      intents: Object.freeze([canonicalIntent]),
      swapReview: Object.freeze({
        expectedAmountOut: configured.expectedAmountOut,
        minimumAmountOut: canonicalIntent.minAmountOut,
        slippageBps,
        expiresAt: configured.expiresAt,
        priceCheck,
      }),
    };
  }

  /**
   * A DEMO quote from the explicit rates, for a swap between two rated tokens
   * only. Exact bigint arithmetic, floored; the same inputs always give the
   * same figures.
   */
  private demoQuote(intent: Extract<Intent, { kind: 'swap' }>): FakeSwapReview | undefined {
    const rates = this.demoRates;
    if (!rates) return undefined;
    const rateIn = rates.perStrk.get(BigInt(intent.tokenIn));
    const rateOut = rates.perStrk.get(BigInt(intent.tokenOut));
    if (rateIn === undefined || rateOut === undefined) return undefined;
    const expectedAmountOut = (intent.amountIn * rateOut) / rateIn;
    if (expectedAmountOut <= 0n) {
      throw new PrivacyError('unknown', 'The demo quote rounds to nothing for this amount.');
    }
    return { expectedAmountOut, slippageBps: rates.slippageBps, expiresAt: rates.expiresAt };
  }

  /**
   * A new note: spendable once it matures. With a zero-block maturity window it
   * is due at the current block, so it is spendable at once, exactly as
   * `advanceBlocks(0)` would leave it.
   */
  private mintNote(token: Address, amount: bigint): void {
    if (this.pool.noteMaturityBlocks === 0) {
      this.credit(token, amount);
      return;
    }
    this.maturing.push({ token, amount, matureAtBlock: this.block + this.pool.noteMaturityBlocks });
  }

  private applyIntents(intents: readonly Intent[], fee: bigint): void {
    let feeCharged = false;
    for (const intent of intents) {
      switch (intent.kind) {
        case 'shield':
          // Always to self, and not spendable until it matures.
          this.mintNote(intent.token, intent.amount);
          break;
        case 'unshield':
        case 'transfer':
          this.debit(intent.token, intent.amount);
          break;
        case 'swap':
          this.debit(intent.tokenIn, intent.amountIn);
          this.mintNote(intent.tokenOut, intent.minAmountOut);
          break;
        case 'stake': {
          // The minted xSTRK lands in an open note, which matures like any other.
          this.debit(intent.tokenIn, intent.amountIn);
          const shares = demoStakeShares(intent.amountIn);
          if (shares > 0n) this.mintNote(intent.tokenOut, shares);
          break;
        }
      }
      if (!feeCharged && intent.kind !== 'shield') {
        this.debit(this.pool.feeToken, fee);
        feeCharged = true;
      }
    }
  }

  private lookupLoose(token: string): bigint {
    for (const [key, value] of this.spendable) {
      if (sameAddress(key, token)) return value;
    }
    return 0n;
  }

  /** D-094: refuse a shield a listed public balance cannot pay for, else debit it. */
  private debitPublic(intents: readonly Intent[], fee: bigint): void {
    const deposits = shieldDeposits(intents, { feeToken: this.pool.feeToken, feeAmount: fee });
    const byToken = new Map<string, bigint>();
    intents.forEach((intent, index) => {
      if (intent.kind !== 'shield') return;
      const key = normalise(intent.token);
      byToken.set(key, (byToken.get(key) ?? 0n) + deposits.at(index)!);
    });
    for (const [token, deposit] of byToken) {
      const held = this.publicHeld.get(token);
      if (held !== undefined && deposit > held) {
        throw new PrivacyError('insufficient-balance', `Needs ${deposit} public, has ${held}.`);
      }
    }
    for (const [token, deposit] of byToken) {
      const held = this.publicHeld.get(token);
      if (held !== undefined) this.publicHeld.set(token, held - deposit);
    }
  }

  private credit(token: Address, amount: bigint): void {
    for (const key of this.spendable.keys()) {
      if (sameAddress(key, token)) {
        this.spendable.set(key, (this.spendable.get(key) ?? 0n) + amount);
        return;
      }
    }
    this.spendable.set(token, amount);
  }

  private debit(token: Address, amount: bigint): void {
    for (const key of this.spendable.keys()) {
      if (sameAddress(key, token)) {
        this.spendable.set(key, (this.spendable.get(key) ?? 0n) - amount);
        return;
      }
    }
    this.spendable.set(token, -amount);
  }

  private async tick(method: Fault['on'], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new PrivacyError('user-rejected', 'aborted');
    if (this.latency > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latency));
      if (signal?.aborted) throw new PrivacyError('user-rejected', 'aborted');
    }
    const index = this.faults.findIndex((f) => !f.on || f.on === method);
    if (index >= 0) {
      const fault = this.faults[index]!;
      if (!fault.sticky) this.faults.splice(index, 1);
      throw new PrivacyError(fault.kind, fault.message ?? `injected fault: ${fault.kind}`);
    }
  }
}

/**
 * Own the caller's demo rates atomically at construction: own data entries
 * only, each token a valid address listed once, each rate a positive bounded
 * bigint, plus a valid slippage and a fixed positive expiry.
 */
function ownSwapReview(review: FakeSwapReview): FakeSwapReview {
  if (!Number.isSafeInteger(review.expiresAt) || review.expiresAt <= 0) {
    throw new PrivacyError('unknown', 'The deterministic swap review is invalid.');
  }
  try {
    protectedMinimumOut(review.expectedAmountOut, review.slippageBps);
  } catch {
    throw new PrivacyError('unknown', 'The deterministic swap review is invalid.');
  }
  return Object.freeze({ ...review });
}

function ownDemoSwapRates(config: FakeDemoSwapRates): {
  readonly perStrk: ReadonlyMap<bigint, bigint>;
  readonly slippageBps: number;
  readonly expiresAt: number;
} {
  const invalid = () => new PrivacyError('unknown', 'The demo swap rates are invalid.');
  let table: unknown;
  let slippageBps: unknown;
  let expiresAt: unknown;
  try {
    table = ownData(config, 'perStrk');
    slippageBps = ownData(config, 'slippageBps');
    expiresAt = ownData(config, 'expiresAt');
  } catch {
    throw invalid();
  }
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw invalid();
  const perStrk = new Map<bigint, bigint>();
  for (const key of Reflect.ownKeys(table)) {
    if (typeof key !== 'string') throw invalid();
    const rate = ownData(table, key);
    try {
      assertAddress(key, 'demo rate token');
    } catch {
      throw invalid();
    }
    const token = BigInt(key);
    if (perStrk.has(token) || typeof rate !== 'bigint' || rate <= 0n || rate > MAX_DEMO_RATE) throw invalid();
    perStrk.set(token, rate);
  }
  if (perStrk.size === 0 || typeof slippageBps !== 'number' || typeof expiresAt !== 'number') throw invalid();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw invalid();
  try {
    protectedMinimumOut(10n ** 18n, slippageBps);
  } catch {
    throw invalid();
  }
  return Object.freeze({ perStrk, slippageBps, expiresAt });
}

function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) throw new PrivacyError('unknown', 'The demo swap rates are invalid.');
  return descriptor.value;
}

function ownDepositStatus(status: unknown): DepositStatus {
  if (status !== 'landed' && status !== 'pending' && status !== 'failed') {
    throw new PrivacyError('unknown', 'The fake deposit status is invalid.');
  }
  return status;
}

/**
 * Take ownership of the intents a caller asked for; see the identically named
 * helper in `wallet-api/operations.ts`. `Intent` is flat, so one level of
 * copy-and-freeze is a full deep freeze.
 */
function freezeIntents(intents: readonly Intent[]): readonly Intent[] {
  return Object.freeze(intents.map((intent) => Object.freeze({ ...intent })));
}

/** Match production's immutable review disclosure boundary. */
function freezeWarnings(warnings: readonly BatchWarning[]): readonly BatchWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({ ...warning })));
}

/**
 * Addresses arrive padded and unpadded. Never compare with `===`.
 *
 * Keeps the `0x` prefix so the result is still parseable by `BigInt` — an
 * earlier version returned a bare hex string, which made every downstream
 * comparison silently fall back to string equality.
 */
function normalise(address: string): string {
  return `0x${BigInt(address).toString(16)}`;
}

function assertAddress(address: unknown, label: string): asserts address is Address {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]+$/.test(address)) {
    throw new PrivacyError('unknown', `Invalid ${label} address.`);
  }
  let value: bigint;
  try { value = BigInt(address); } catch { throw new PrivacyError('unknown', `Invalid ${label} address.`); }
  if (value <= 0n || value >= STARK_FIELD_PRIME) {
    throw new PrivacyError('unknown', `Invalid ${label} address.`);
  }
}

function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/** A Vault stage for the observer, frozen; an observer that throws changes nothing. */
function emitVaultStage(callback: VaultStageCallback | undefined, stage: VaultStage): void {
  try {
    callback?.(Object.freeze({ ...stage }) as VaultStage);
  } catch {
    /* Observers cannot alter a financial operation. */
  }
}

/**
 * A config record's own data entries, keys and values, or `[]` when absent:
 * an accessor, a symbol key or a non-object record is refused (D-079).
 */
function ownRecordEntries(record: unknown, invalid: () => Error): Array<[string, unknown]> {
  if (record === undefined) return [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid();
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !('value' in descriptor)) throw invalid();
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/** An own data field, or undefined; an accessor is never run. */
function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function ownVaultOptions(options: VaultCallOptions | undefined): {
  signal: AbortSignal | undefined;
  onStage: VaultStageCallback | undefined;
} {
  if (options === undefined) return { signal: undefined, onStage: undefined };
  const signal = Object.getOwnPropertyDescriptor(options, 'signal')?.value as AbortSignal | undefined;
  const onStage = Object.getOwnPropertyDescriptor(options, 'onStage')?.value as VaultStageCallback | undefined;
  if (onStage !== undefined && typeof onStage !== 'function') {
    throw new PrivacyError('unknown', 'The Vault call options are invalid.');
  }
  return { signal, onStage };
}

function emitProgress(callback: ProgressCallback | undefined, progress: OperationProgress): void {
  try {
    callback?.(Object.freeze({ ...progress }));
  } catch {
    /* Observers cannot alter a financial operation. */
  }
}

function assertFeeCeilingInput(ceiling: unknown): asserts ceiling is bigint {
  if (typeof ceiling !== 'bigint' || ceiling < 0n) {
    throw new PrivacyError('unknown', 'The fee ceiling must be a non-negative bigint.');
  }
}
