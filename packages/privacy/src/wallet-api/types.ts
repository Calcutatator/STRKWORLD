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
  /**
   * `wallet_strk20ShadowAccountCommitment` (Wallet API 0.10.4, D-077). The
   * partial commitment when `nonce` is omitted. Optional: an account object
   * without it cannot run the Vault, which is detected at runtime, never by
   * wallet identity.
   */
  strk20ShadowAccountCommitment?(dappName: string, nonce?: string): Promise<string>;
}

/**
 * The Vault's public reads (D-077, D-079), through the backend so the
 * player's IP never reaches a third party next to their commitment or
 * stand-in address (D-014). The backend pins every contract, and the
 * vaults, itself: a request names only the value to look up.
 */
export interface VaultReadClient {
  /** The anonymizer's view: the shadow account at the Vault's nonce, and whether it is deployed. */
  shadowAccount(partialCommitment: string, signal?: AbortSignal): Promise<{ address: Address; deployed: boolean }>;
  /**
   * A stand-in address's position in every vault the backend pins, one row
   * per vault in its order, in base units: the vault's shares, what they
   * redeem for now in its token, and the vault's two limits. The caller picks
   * the vaults it admits by address.
   */
  vaultPositions(account: Address, signal?: AbortSignal): Promise<readonly VaultPositionRow[]>;
  /**
   * Vesu's supply APY for each vault the backend pins, from Vesu's public
   * API as the backend last read it. A vault Vesu states no rate for is
   * absent.
   */
  vaultRates(signal?: AbortSignal): Promise<readonly VaultRateRow[]>;
}

/** One vault's row in a position read (D-079). */
export interface VaultPositionRow {
  readonly vault: Address;
  readonly shares: bigint;
  readonly assets: bigint;
  readonly maxWithdraw: bigint;
  readonly maxRedeem: bigint;
}

/** One vault's supply APY, `value / 10^decimals` as a yearly fraction (D-079). */
export interface VaultRateRow {
  readonly vault: Address;
  readonly supplyApy: { readonly value: bigint; readonly decimals: number };
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
  /**
   * A transaction's receipt, exactly as the chain returned it (D-072). Public
   * data, read through the backend so the player's IP never reaches a
   * third-party RPC with the hash (D-014). Callers own its validation.
   */
  receipt(transactionHash: string, signal?: AbortSignal): Promise<unknown>;
}

export type PoolNativeRoute = 'unshield' | 'transfer';
/**
 * Every route the backend relays. `swap` is quote-bound and prepared through
 * `prepareSwap`; `stake` (D-063) is relayed like a pool-native route but
 * invokes Endur's anonymizer.
 */
export type PrivateRoute = PoolNativeRoute | 'swap' | 'stake';

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
  /** A relay fee quote for every non-quote-bound route; swaps quote in `prepareSwap`. */
  estimate(input: {
    route: Exclude<PrivateRoute, 'swap'>;
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
  /**
   * `vault` (D-077) admits the Vault's supply and redeem, which the wallet
   * submits itself, like shield: no relay fee and no intent bound.
   */
  enabledRoutes: readonly ('shield' | 'unshield' | 'transfer' | 'swap' | 'stake' | 'vault')[];
  /**
   * Every token crossing an enabled route must be explicitly admitted.
   *
   * `stake` (D-063) is optional so every existing policy stays valid; absent
   * admits no stake token, so the route fails closed even when enabled. When
   * present it must list both STRK (in) and xSTRK (out), as a swap lists both
   * of its sides. `vault` (D-077) is optional the same way; since D-079 it
   * may name any tokens the Vault pins a vault for (`VAULT_MARKETS`), each
   * once. A list with any other token, or a repeat, keeps the whole Vault
   * shut, as the build's own parser does.
   */
  allowedTokens: Readonly<Record<'shield' | 'unshield' | 'transfer' | 'swap', readonly Address[]>> & {
    readonly stake?: readonly Address[];
    readonly vault?: readonly Address[];
  };
  swap?: {
    expectedChainId: string;
    slippageBps: number;
  };
}

export type SupportedVersionsReader = (signal?: AbortSignal) => Promise<readonly string[]>;
