export type PrivateRoute = 'transfer' | 'unshield' | 'swap';

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
  /** Required for swap; ignored by pool-native routes. */
  allowedTokens?: readonly string[];
  maxSlippageBps?: number;
}

export interface BackendConfig {
  poolAddress: string;
  feeToken: string;
  maxCalldataItems: number;
  maxProofBytes: number;
  globalEnabled: boolean;
  rateLimit: { maxRequests: number; windowMs: number };
  routes: Record<PrivateRoute, RoutePolicy>;
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
  }): Promise<RelayFee>;
  submit(input: {
    route: PrivateRoute;
    artifact: PreparedArtifact;
    fee: RelayFee;
  }): Promise<{ transactionHash: string }>;
}

export interface PoolRpcPort {
  getPoolConfig(): Promise<{
    feeAmount: bigint;
    feeToken: string;
    proofValidityBlocks: number;
    noteMaturityBlocks: number;
  }>;
  getPublicKey(address: string): Promise<string>;
  getReceipt(transactionHash: string): Promise<unknown>;
  getBlockNumber(): Promise<number>;
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
}

export interface ApiResponse {
  status: number;
  body: unknown;
}
