export type PrivateRoute = 'transfer' | 'unshield' | 'swap' | 'stake';
/**
 * The routes the relay still serves (D-082 kept it; the browser calls none
 * of them). A swap is never relayed (D-084): the wallet submits it through
 * the player's swap stand-in, and this service only proxies its quote.
 */
export type RelayRoute = Exclude<PrivateRoute, 'swap'>;

export interface PreparedArtifact {
  call: {
    contract_address: string;
    entry_point: string;
    calldata?: string[];
  };
  proof: {
    data: string;
    output: string[];
    proof_facts: string[];
  };
}

export interface RoutePolicy {
  enabled: boolean;
  maxRelayFee: bigint;
  maxQueueDelayMs: number;
  quoteBound: boolean;
  allowedTokens: readonly string[];
  maxSlippageBps?: number;
}

export interface BackendConfig {
  poolAddress: string;
  feeToken: string;
  maxCalldataItems: number;
  maxProofBytes: number;
  requestTimeoutMs: number;
  globalEnabled: boolean;
  rateLimit: { maxRequests: number; windowMs: number };
  sponsorshipBudget: { maxFeeAmount: bigint; windowMs: number };
  submissionQueue: { maxInFlight: number; maxQueued: number };
  /**
   * Endur staking (D-063) is optional and disabled while absent; every other
   * route is always configured.
   */
  routes: Record<Exclude<PrivateRoute, 'stake'>, RoutePolicy> & { stake?: RoutePolicy };
  /**
   * The degen floor's catalog (D-067): optional, and off while absent. It
   * never enables swap; it only widens what an enabled swap route admits.
   */
  degen?: DegenConfig;
  /**
   * Opt-in debug logs for a test deployment (D-069). Only exactly `true`
   * opens `POST /v1/debug/logs`; absent or false, the path is unknown.
   */
  debugLogsEnabled?: boolean;
  /**
   * Leaderboard phase 1's blind tally, behind `BACKEND_LEADERBOARD_ENABLED`.
   * Absent, its four routes are unknown paths.
   */
  leaderboard?: {
    /** The `ReceiptLedger` contract (`BACKEND_LEADERBOARD_LEDGER`). */
    readonly ledger: string;
    /** `BACKEND_LEADERBOARD_FILE`: a JSON file on a volume, or null for memory only. */
    readonly storePath: string | null;
  };
}

/** avnu's token tags, as its public token API names them. */
export type AvnuTokenTag = 'Unknown' | 'Verified' | 'Community' | 'Unruggable' | 'AVNU';

/** The tags D-067 lets a live token be listed under. `Unknown` never qualifies. */
export type DegenTag = Exclude<AvnuTokenTag, 'Unknown'>;

export interface DegenConfig {
  enabled: boolean;
  /** A live token must carry at least one of these. */
  tags: readonly DegenTag[];
  /** Minimum `lastDailyVolumeUsd`, in whole US dollars, for a live token. */
  minDailyVolumeUsd: number;
  /** How long one fetched list stands before avnu is asked again. */
  cacheTtlMs: number;
}

/** One listed token: the curated core's pinned entry, or avnu's live entry. */
export interface DegenToken {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** avnu's tags, in avnu's own order. */
  readonly tags: readonly AvnuTokenTag[];
  /** Pinned in the curated core (always listed), rather than from avnu's live list. */
  readonly curated: boolean;
}

export interface DegenCatalogSnapshot {
  /** `curated`: avnu could not be reached, so only the curated core is listed. */
  readonly source: 'live' | 'curated';
  readonly tokens: readonly DegenToken[];
}

/** The backend's own degen list; the only thing besides the static allowlist a swap may use. */
export interface DegenCatalogPort {
  snapshot(signal?: AbortSignal): Promise<DegenCatalogSnapshot>;
}

export interface RelayFee {
  token: string;
  recipient: string;
  amount: bigint;
}

export interface PaymasterPort {
  /**
   * False when the relay holds no avnu Portal key (D-070). The API then
   * answers every relayed route RELAY_NOT_CONFIGURED without calling avnu.
   * Absent means configured, so a test double need not say.
   */
  readonly configured?: boolean;
  buildFee(input: {
    route: PrivateRoute;
    poolAddress: string;
    feeToken: string;
    operationToken: string;
    signal?: AbortSignal;
  }): Promise<RelayFee>;
  submit(input: {
    route: PrivateRoute;
    artifact: PreparedArtifact;
    fee: RelayFee;
    signal?: AbortSignal;
  }): Promise<{ transactionHash: string }>;
}

export interface PoolRpcPort {
  getPoolConfig(signal?: AbortSignal): Promise<{
    feeAmount: bigint;
    feeToken: string;
    proofValidityBlocks: number;
    noteMaturityBlocks: number;
  }>;
  getPublicKey(address: string, signal?: AbortSignal): Promise<string>;
  /**
   * The receipt as the chain gives it, or `null` for a hash the node has not
   * seen (D-072). Any other failed read rejects.
   */
  getReceipt(transactionHash: string, signal?: AbortSignal): Promise<unknown>;
  getBlockNumber(signal?: AbortSignal): Promise<number>;
}

/**
 * The Privacy Plaza's public pool stats (D-076, value fields D-080):
 * aggregates only, each null until the background scan or fetch has
 * produced it once.
 */
export interface PoolStatsSnapshot {
  /** The pool's `ViewingKeySet` events since its first block: accounts registered. */
  readonly accounts: number | null;
  /** The pool's `Deposit` events in the last day of blocks. */
  readonly deposits24h: number | null;
  /** D-080: the pool's total USD value, read from Voyager through strkprice.com. */
  readonly valueUsd: number | null;
  /** D-080: the highest-value tokens the pool holds, most valuable first. */
  readonly topHoldings: readonly PoolTokenValue[] | null;
  /** D-080: when `valueUsd`/`topHoldings` were last refreshed, as an ISO timestamp. */
  readonly valueAsOf: string | null;
  /** D-080: how many distinct tokens the pool holds, priced or not. */
  readonly tokenCount: number | null;
}

/** D-080: one token's share of the pool's value. */
export interface PoolTokenValue {
  readonly symbol: string;
  readonly usd: number;
}

/** D-080: the pool's value, read fresh from the external aggregate. */
export interface PoolValueRead {
  readonly usd: number;
  /** Capped and sorted by usd, most valuable first. */
  readonly topHoldings: readonly PoolTokenValue[];
  readonly tokenCount: number | null;
}

/**
 * D-080: the external, public, no-key aggregate of the pool's USD value
 * (strkprice.com's proxy over Voyager). Fetched server-side only: its CORS
 * allows strkprice origins alone.
 */
export interface PoolValueSourcePort {
  load(signal?: AbortSignal): Promise<PoolValueRead>;
}

/** The cached stats the route serves. Reading never waits on the chain. */
export interface PoolStatsPort {
  snapshot(): PoolStatsSnapshot;
  /** Start the background refresh with no request waiting (the server's boot). */
  warm?(): void;
}

/** One page of the pool's events: the block of each match, and where the next page starts. */
export interface PoolEventsPage {
  readonly blocks: readonly number[];
  readonly continuationToken: string | null;
}

/** The latest block: its number, and its hash, which a scan ending there names it by. */
export interface ChainHead {
  readonly number: number;
  readonly hash: string;
}

/** Which of the pool's events one page asks for. */
export interface PoolEventsFilter {
  /** The event's selector, its first key. */
  readonly key: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  /**
   * `toBlock`'s hash, when the caller has it. A node that has not reached a
   * block named by hash refuses the read; one named only by number past its
   * tip is answered short, with no error.
   */
  readonly toBlockHash?: string | null;
  readonly continuationToken?: string | null;
}

/**
 * The narrow chain reads the pool stats need. Every read targets the pool or
 * a pinned token; nothing a request carries reaches one.
 */
/**
 * The Vault's public chain reads (D-077, D-079), each pinned: the canonical
 * shadow-account anonymizer, and every Vesu vault in `VESU_VAULTS`
 * (`vault.ts`). A caller supplies the value to look up, never a target or a
 * selector.
 */
export interface VaultRpcPort {
  /**
   * `get_shadow_accounts(partial, 0, 1, false)` on the anonymizer: the one
   * shadow account at nonce 0 for this partial commitment, and whether it is
   * deployed yet. It is deployed lazily, on its first invoke.
   */
  getShadowAccount(partialCommitment: string, signal?: AbortSignal): Promise<ShadowAccountRead>;
  /**
   * `account`'s position in every pinned vault, one row each in
   * `VESU_VAULTS` order, in base units. A vault whose read fails answers
   * `ok: false` rather than failing the others (D-079).
   */
  getVaultPositions(account: string, signal?: AbortSignal): Promise<readonly VaultPositionRead[]>;
}

/**
 * Endur unstaking's public chain reads (D-085), each pinned: the withdrawal
 * queue's events and views, and the STRK and xSTRK balances of the address
 * asked about. A caller supplies the address, never a target or a selector.
 */
export interface EndurRpcPort {
  getEndurUnstake(account: string, signal?: AbortSignal): Promise<EndurUnstakeRead>;
  /**
   * D-091: xSTRK's `convert_to_assets(10^18)` at the latest block: the STRK,
   * in base units, one whole xSTRK converts to now. Positive.
   */
  getEndurRate(signal?: AbortSignal): Promise<bigint>;
}

export interface EndurUnstakeRead {
  /** The latest block's timestamp, Unix seconds. */
  readonly chainTime: number;
  /** STRK `balance_of(account)`. */
  readonly strk: bigint;
  /** xSTRK `balance_of(account)`. */
  readonly xstrk: bigint;
  /** The queue's ERC-721 `balance_of(account)`: its unpaid requests. */
  readonly outstanding: bigint;
  /** Each request the queue emitted for the address in the scan window, by `get_request_info`. */
  readonly requests: readonly EndurRequestRead[];
  /** False when the event scan ran out of pages with more left: some requests may be missing. */
  readonly complete: boolean;
}

export interface EndurRequestRead {
  readonly requestId: bigint;
  readonly assets: bigint;
  readonly shares: bigint;
  readonly claimed: boolean;
  readonly requestedAt: number;
  readonly claimableAt: number;
  /**
   * Whether `claim_withdrawal(requestId)` would succeed now, by a read-only
   * dry run: unpaid, past its wait, and funded. False for every request not
   * dry-run (paid, early, or beyond `MAX_ENDUR_CLAIM_DRY_RUNS`) and for one
   * whose dry run reverted or could not be made.
   */
  readonly claimableNow: boolean;
}

export interface ShadowAccountRead {
  readonly address: string;
  readonly deployed: boolean;
}

export type VaultPositionRead = VaultPositionFigures | { readonly vault: string; readonly ok: false };

export interface VaultPositionFigures {
  /** The pinned vault this row reads. */
  readonly vault: string;
  readonly ok: true;
  /** `balance_of(account)`: the vault's shares. */
  readonly shares: bigint;
  /** `preview_redeem(shares)`: what those shares redeem for now, in the vault's token. Zero with no shares. */
  readonly assets: bigint;
  /** `max_withdraw(account)`: the most of its token the vault lets it withdraw now. */
  readonly maxWithdraw: bigint;
  /** `max_redeem(account)`: the most shares the vault lets it redeem now. */
  readonly maxRedeem: bigint;
}

/**
 * The Borrow counter's public chain reads (D-083), each pinned: Vesu's Prime
 * pool, every token in `BORROW_TOKENS` and every pair in `BORROW_PAIRS`
 * (`borrow.ts`). A caller supplies at most the account to look up, never a
 * target, a token or a selector.
 */
export interface BorrowRpcPort {
  /**
   * `price` and `asset_config` for every pinned token, one row each in
   * `BORROW_TOKENS` order, and `pair_config` and `pairs` for every pinned
   * pair, one row each in `BORROW_PAIRS` order. A row whose reads fail
   * answers `ok: false` rather than failing the others.
   */
  getBorrowMarket(signal?: AbortSignal): Promise<BorrowMarketRead>;
  /**
   * `position(collateral, debt, account)` for every pinned pair, one row each
   * in `BORROW_PAIRS` order. A pair whose read fails answers `ok: false`.
   */
  getBorrowPositions(account: string, signal?: AbortSignal): Promise<readonly BorrowPositionRead[]>;
}

export interface BorrowMarketRead {
  readonly assets: readonly BorrowAssetRead[];
  readonly pairs: readonly BorrowPairRead[];
}

export type BorrowAssetRead = BorrowAssetFigures | { readonly token: string; readonly ok: false };

export interface BorrowAssetFigures {
  /** The pinned token this row reads. */
  readonly token: string;
  readonly ok: true;
  /** `price(token).value`: the oracle price, scaled by 1e18. */
  readonly price: bigint;
  /** `price(token).is_valid`. */
  readonly priceValid: boolean;
  /** `asset_config(token).scale`: 10^decimals. */
  readonly scale: bigint;
  /** `asset_config(token).floor`: the least debt value a position may hold, scaled by 1e18. */
  readonly floor: bigint;
  /** `asset_config(token).reserve`: what the pool holds of the token, in base units. */
  readonly reserve: bigint;
  /** `asset_config(token).total_nominal_debt`. */
  readonly totalNominalDebt: bigint;
  /** `asset_config(token).last_rate_accumulator`. */
  readonly rateAccumulator: bigint;
  /** `asset_config(token).max_utilization`, scaled by 1e18. */
  readonly maxUtilization: bigint;
}

export type BorrowPairRead = BorrowPairFigures | { readonly collateral: string; readonly debt: string; readonly ok: false };

export interface BorrowPairFigures {
  readonly collateral: string;
  readonly debt: string;
  readonly ok: true;
  /** `pair_config(collateral, debt).max_ltv`, scaled by 1e18. */
  readonly maxLtv: bigint;
  /** `pair_config(collateral, debt).liquidation_factor`, scaled by 1e18. */
  readonly liquidationFactor: bigint;
  /** `pair_config(collateral, debt).debt_cap`. */
  readonly debtCap: bigint;
  /** `pairs(collateral, debt).total_nominal_debt`. */
  readonly totalNominalDebt: bigint;
}

export type BorrowPositionRead = BorrowPositionFigures | { readonly collateral: string; readonly debt: string; readonly ok: false };

export interface BorrowPositionFigures {
  readonly collateral: string;
  readonly debt: string;
  readonly ok: true;
  /** `position(...).0.collateral_shares`. */
  readonly collateralShares: bigint;
  /** `position(...).0.nominal_debt`. */
  readonly nominalDebt: bigint;
  /** `position(...).1`: the collateral, in the collateral token's base units. */
  readonly collateralAmount: bigint;
  /** `position(...).2`: the debt, in the debt token's base units. */
  readonly debtAmount: bigint;
}

/**
 * Vesu's supply APY for the pinned vaults (D-079), from Vesu's public API,
 * fetched by this service and cached: no request reaches Vesu, and nothing a
 * request carries reaches the fetch.
 */
export interface VaultRatesPort {
  rates(signal?: AbortSignal): Promise<readonly VaultRateRead[]>;
}

export interface VaultRateRead {
  readonly vault: string;
  /** The yearly rate as a fraction, `value / 10^decimals`, as Vesu states it. */
  readonly supplyApy: { readonly value: bigint; readonly decimals: number };
}

export interface PoolStatsRpcPort {
  getHead(signal?: AbortSignal): Promise<ChainHead>;
  /** The pool's own events whose first key is `key`, in `[fromBlock, toBlock]`. Block numbers only. */
  getPoolEvents(filter: PoolEventsFilter, signal?: AbortSignal): Promise<PoolEventsPage>;
}

export interface FeeAuthorizationClaims extends RelayFee {
  v: 1;
  route: RelayRoute;
  feeToken: string;
  operationToken: string;
  issuedAtBlock: number;
  expiresAtBlock: number;
}

/**
 * avnu's public swap quote and built call for a swap stand-in (D-084), as
 * this service relays it to the browser, which checks every field again.
 */
export interface SwapQuote {
  quoteId: string;
  chainId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  calls: ReadonlyArray<{ contractAddress: string; entrypoint: string; calldata: readonly string[] }>;
}

/** avnu's keyless quote and build (D-084). No key, no integrator fee. */
export interface SwapQuotePort {
  quote(input: {
    sellToken: string;
    buyToken: string;
    sellAmount: bigint;
    taker: string;
    slippageBps: number;
    signal?: AbortSignal;
  }): Promise<SwapQuote>;
}

export interface AuthorizationCodec {
  issue(claims: FeeAuthorizationClaims): Promise<string>;
  verify(token: string): Promise<FeeAuthorizationClaims | null>;
}

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
  signal?: AbortSignal;
  /**
   * D-084: a salted, unlinkable key for the requesting client
   * (`client-key.ts`), used only for per-client rate limits. Never logged.
   */
  client?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}
