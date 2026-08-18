import type {
  STRK20_ACTION,
  STRK20_BALANCE_ENTRY,
  STRK20_CALL_AND_PROOF,
} from 'starknet';
import type { PoolConfig } from '../operations.js';
import type { Address, TxResult } from '../types.js';

/** Structural slice of WalletAccountV6 used by STRKWORLD. */
export interface WalletStrk20Account {
  readonly address: Address;
  strk20Balances(tokens: Address[]): Promise<STRK20_BALANCE_ENTRY[]>;
  strk20PrepareInvoke(
    actions: STRK20_ACTION[],
    simulate?: boolean,
  ): Promise<STRK20_CALL_AND_PROOF>;
  strk20InvokeTransaction(actions: STRK20_ACTION[]): Promise<{ transaction_hash: string }>;
}

/**
 * Input to the optional public-shield planner.
 *
 * Bridge v1 is public STRK only: `token` identifies the denomination for
 * every amount in this port, and a planner must reject any fee/gas estimate
 * that is not denominated in that same token.
 */
export interface PublicShieldPlanInput {
  /** Bridge public-STRK token; all amounts below use this denomination. */
  token: Address;
  /** Available public STRK, in the `token` denomination. */
  available: bigint;
  /** Optional signed-quote recipient gate; comparisons are field-element based. */
  expectedRecipient?: Address;
}

/** A fresh, wallet-specific maximum public shield plan. */
export interface PublicShieldPlan {
  /** Bridge public-STRK token; every monetary field uses this denomination. */
  token: Address;
  recipient: Address;
  /** Available public STRK, in the `token` denomination. */
  available: bigint;
  /** Deposit action amount, in the same `token` denomination as the reserve. */
  amountToShield: bigint;
  /** Pool fee in the input-token denomination; governance may set this to zero. */
  poolFee: bigint;
  /** Positive public gas estimate in the input-token denomination. */
  gasEstimate: bigint;
  /**
   * `poolFee + gasEstimate`, in the same denomination; strictly positive
   * because `gasEstimate` must be positive. `amountToShield + plannedReserve`
   * must be <= `available`.
   */
  plannedReserve: bigint;
}

/** Optional capability; it is deliberately not part of PrivacyOperations. */
export interface PublicShieldPlanner {
  planMax(input: PublicShieldPlanInput, signal?: AbortSignal): Promise<PublicShieldPlan>;
}

/** Backend-proxied pool reads. No viewing key or private state crosses it. */
export interface PoolReadClient {
  config(signal?: AbortSignal): Promise<PoolConfig>;
  publicKey(address: Address, signal?: AbortSignal): Promise<string>;
}

export type PoolNativeRoute = 'unshield' | 'transfer';
export type PrivateRoute = PoolNativeRoute | 'swap';

export interface RelayFeeQuote {
  token: Address;
  recipient: Address;
  amount: bigint;
  /** Stateless server authorization binding this exact fee and route. */
  authorization: string;
  expiresAtBlock: number;
}

export interface PreparedPrivateSwap {
  quoteId: string;
  buyAmount: bigint;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  chainId: string;
  executorAddress: Address;
  executorCalls: Array<{
    contractAddress: Address;
    entrypoint: string;
    calldata: string[];
  }>;
  fee: RelayFeeQuote;
}

export interface PrivateSubmissionGateway {
  estimate(input: {
    route: PoolNativeRoute;
    feeToken: Address;
    operationToken: Address;
    signal?: AbortSignal;
  }): Promise<RelayFeeQuote>;
  submit(input: {
    route: PrivateRoute;
    artifact: STRK20_CALL_AND_PROOF;
    feeAuthorization: string;
    proofValidityBlocks: number;
    signal?: AbortSignal;
    /**
     * Report acceptance as soon as a transaction hash is known, before any
     * fallible response cleanup. `confirm()` preserves this receipt if the
     * gateway subsequently throws.
     */
    onAccepted?: (result: TxResult) => void;
  }): Promise<TxResult>;
  /** Quote-bound AVNU route. Missing means swaps fail closed. */
  prepareSwap?(input: {
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
    minAmountOut: bigint;
    slippageBps: number;
    signal?: AbortSignal;
  }): Promise<PreparedPrivateSwap>;
}

export interface WalletRoutePolicy {
  maxIntents: number;
  maxRelayFee: bigint;
  enabledRoutes: readonly ('shield' | 'unshield' | 'transfer' | 'swap')[];
  /** Every token crossing an enabled route must be explicitly admitted. */
  allowedTokens: Readonly<Record<'shield' | 'unshield' | 'transfer' | 'swap', readonly Address[]>>;
  swap?: {
    expectedChainId: string;
    slippageBps: number;
  };
}

export type SupportedVersionsReader = (signal?: AbortSignal) => Promise<readonly string[]>;
