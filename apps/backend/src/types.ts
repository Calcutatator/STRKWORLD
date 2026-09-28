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
  getReceipt(transactionHash: string, signal?: AbortSignal): Promise<unknown>;
  getBlockNumber(signal?: AbortSignal): Promise<number>;
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
