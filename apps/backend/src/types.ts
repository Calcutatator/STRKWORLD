export type PrivateRoute = 'transfer' | 'unshield' | 'swap' | 'stake';

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
 * The Privacy Plaza's public pool stats (D-076): aggregates only, each null
 * until the background scan has produced it once.
 */
export interface PoolStatsSnapshot {
  /** The pool's `ViewingKeySet` events since its first block: accounts registered. */
  readonly accounts: number | null;
  /** The pool's `Deposit` events in the last day of blocks. */
  readonly deposits24h: number | null;
  /** `balance_of(pool)` for each pinned token, in base units. */
  readonly held: readonly { readonly token: string; readonly amount: bigint }[] | null;
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
export interface PoolStatsRpcPort {
  getHead(signal?: AbortSignal): Promise<ChainHead>;
  /** The pool's own events whose first key is `key`, in `[fromBlock, toBlock]`. Block numbers only. */
  getPoolEvents(filter: PoolEventsFilter, signal?: AbortSignal): Promise<PoolEventsPage>;
  /** `balance_of(pool)` on a token contract, as its u256. */
  getPoolBalance(token: string, signal?: AbortSignal): Promise<bigint>;
}

export interface FeeAuthorizationClaims extends RelayFee {
  v: 1;
  route: PrivateRoute;
  feeToken: string;
  operationToken: string;
  issuedAtBlock: number;
  expiresAtBlock: number;
  swap?: SwapAuthorizationBinding;
}

export interface SwapAuthorizationBinding {
  executor: string;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  quoteExpiresAt: number;
  /** Invoke calldata excluding the wallet-resolved open-note id at the end. */
  invokePrefix: string[];
}

export interface SwapPlan {
  quoteId: string;
  buyAmount: bigint;
  expiresAt: number;
  chainId: string;
  executorAddress: string;
  executorCalls: Array<{
    contractAddress: string;
    entrypoint: string;
    selector: string;
    calldata: string[];
  }>;
}

export interface SwapPlannerPort {
  prepare(input: {
    sellToken: string;
    buyToken: string;
    sellAmount: bigint;
    minAmountOut: bigint;
    slippageBps: number;
    signal?: AbortSignal;
  }): Promise<SwapPlan>;
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
}

export interface ApiResponse {
  status: number;
  body: unknown;
}
