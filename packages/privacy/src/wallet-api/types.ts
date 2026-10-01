import type {
  STRK20_ACTION,
  STRK20_BALANCE_ENTRY,
  STRK20_CALL_AND_PROOF,
} from 'starknet';
import type { PoolConfig } from '../operations.js';
import type { Address, TxResult } from '../types.js';
import type { PragmaPrice } from '../swap-prices.js';

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
   * redeem for now in its token, and the vault's two limits, or `ok: false`
   * for a vault the backend could not read. The caller picks the vaults it
   * admits by address, and needs good rows for those alone.
   */
  vaultPositions(account: Address, signal?: AbortSignal): Promise<readonly VaultPositionRow[]>;
  /**
   * Vesu's supply APY for each vault the backend pins, from Vesu's public
   * API as the backend last read it. A vault Vesu states no rate for is
   * absent.
   */
  vaultRates(signal?: AbortSignal): Promise<readonly VaultRateRow[]>;
}

/**
 * Unstaking's public reads (D-085), through the same backend for the same
 * reason (D-014). The address read is the Vault's own: the anonymizer
 * resolves any partial commitment at nonce 0, whatever its dapp name.
 */
export interface EndurReadClient {
  shadowAccount(partialCommitment: string, signal?: AbortSignal): Promise<{ address: Address; deployed: boolean }>;
  /**
   * What a stand-in address holds at Endur: the withdrawal requests the queue
   * emitted for it within the backend's scan window, each as the queue's
   * `get_request_info` records it, its STRK and xSTRK balances, how many
   * queue NFTs it holds (unpaid requests, listed or not), and the latest
   * block's timestamp.
   */
  endurUnstake(account: Address, signal?: AbortSignal): Promise<EndurUnstakeRead>;
  /**
   * D-091: xSTRK's `convert_to_assets(10^18)` at the latest block, the STRK
   * one whole xSTRK converts to now. The request names nobody.
   */
  endurRate(signal?: AbortSignal): Promise<{ readonly strkPerXstrk: bigint }>;
}

/** One unstaking read, as the backend answers it (D-085). */
export interface EndurUnstakeRead {
  readonly chainTime: number;
  readonly strk: bigint;
  readonly xstrk: bigint;
  /** The queue NFTs the address holds: every unpaid request, listed or not. */
  readonly outstanding: bigint;
  /** False when the backend's event scan ran out of pages: some requests may be missing. */
  readonly complete: boolean;
  readonly requests: readonly {
    readonly requestId: bigint;
    readonly assets: bigint;
    readonly shares: bigint;
    readonly claimed: boolean;
    readonly requestedAt: number;
    readonly claimableAt: number;
    /** A read-only `claim_withdrawal` dry run succeeded: unpaid, past its wait, and funded. */
    readonly claimableNow: boolean;
  }[];
}

/** One vault's row in a position read (D-079): its figures, or a read that failed. */
export type VaultPositionRow =
  | {
      readonly vault: Address;
      readonly ok: true;
      readonly shares: bigint;
      readonly assets: bigint;
      readonly maxWithdraw: bigint;
      readonly maxRedeem: bigint;
    }
  | { readonly vault: Address; readonly ok: false };

/** One vault's supply APY, `value / 10^decimals` as a yearly fraction (D-079). */
export interface VaultRateRow {
  readonly vault: Address;
  readonly supplyApy: { readonly value: bigint; readonly decimals: number };
}

/**
 * The Borrow counter's public reads (D-083), through the backend for the
 * same reason as the Vault's (D-014). The backend pins the pool, the tokens
 * and the pairs itself; a request names only the stand-in address, or
 * nothing. The stand-in address itself resolves through the Vault's
 * `shadowAccount` read: the same anonymizer view at the same nonce, for the
 * borrow counter's own partial commitment.
 */
export interface BorrowReadClient extends Pick<VaultReadClient, 'shadowAccount'> {
  /** Vesu's Prime pool now: one row per pinned token, then one per pinned pair, raw from the pool. */
  borrowMarket(signal?: AbortSignal): Promise<BorrowMarketRead>;
  /** A stand-in address's position in every pinned pair, one row each, in base units. */
  borrowPositions(account: Address, signal?: AbortSignal): Promise<readonly BorrowPositionRow[]>;
}

/** One pinned token's row in a market read (D-083), raw from Vesu's `price` and `asset_config`. */
export type BorrowAssetRow =
  | {
      readonly token: Address;
      readonly ok: true;
      readonly price: bigint;
      readonly priceValid: boolean;
      readonly scale: bigint;
      readonly floor: bigint;
      readonly reserve: bigint;
      readonly totalNominalDebt: bigint;
      readonly rateAccumulator: bigint;
      readonly maxUtilization: bigint;
    }
  | { readonly token: Address; readonly ok: false };

/** One pinned pair's row in a market read (D-083), raw from Vesu's `pair_config` and `pairs`. */
export type BorrowPairRow =
  | {
      readonly collateral: Address;
      readonly debt: Address;
      readonly ok: true;
      readonly maxLtv: bigint;
      readonly liquidationFactor: bigint;
      readonly debtCap: bigint;
      readonly totalNominalDebt: bigint;
    }
  | { readonly collateral: Address; readonly debt: Address; readonly ok: false };

export interface BorrowMarketRead {
  readonly assets: readonly BorrowAssetRow[];
  readonly pairs: readonly BorrowPairRow[];
}

/** One pinned pair's row in a position read (D-083), from Vesu's `position`. */
export type BorrowPositionRow =
  | {
      readonly collateral: Address;
      readonly debt: Address;
      readonly ok: true;
      readonly collateralShares: bigint;
      readonly nominalDebt: bigint;
      readonly collateralAmount: bigint;
      readonly debtAmount: bigint;
    }
  | { readonly collateral: Address; readonly debt: Address; readonly ok: false };

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
 * Every route the backend can still relay: the pool-native spends and
 * `stake` (D-063). Since D-082 the browser relays none of them, and since
 * D-084 a swap is never relayed: the wallet submits every route itself.
 */
export type PrivateRoute = PoolNativeRoute | 'stake';

export interface RelayFeeQuote {
  token: Address;
  recipient: Address;
  amount: bigint;
  /** Stateless server authorization binding this exact fee and route. */
  authorization: string;
  expiresAtBlock: number;
}

/**
 * avnu's public, keyless swap quote for the swap stand-in address (D-084),
 * fetched through the STRKWORLD backend so the player's IP never reaches avnu
 * next to that address and the amounts (D-014). Typed but untrusted: the
 * caller checks every field against what it asked for.
 */
export interface SwapQuoteAnswer {
  readonly quoteId: string;
  readonly chainId: string;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  /** avnu's built calls for the taker, without an approve. */
  readonly calls: ReadonlyArray<{
    readonly contractAddress: Address;
    readonly entrypoint: string;
    readonly calldata: readonly string[];
  }>;
}

/**
 * Pragma's spot prices for every pinned feed (`PRICE_FEEDS`, D-084), read by
 * the browser over the wallet's own RPC, never through STRKWORLD's backend or
 * avnu, so neither can vouch for its own quote. It always asks for the whole
 * fixed set, so the read names no pair and nothing about the player.
 */
export interface SwapPriceReader {
  read(signal?: AbortSignal): Promise<readonly PragmaPrice[]>;
}

/**
 * D-094: an account's public ERC-20 balance of one token, read over the
 * wallet's own RPC (`RpcPublicBalanceReader`), never STRKWORLD's backend:
 * what a shield draws on. No wallet is asked.
 */
export interface PublicBalanceReader {
  read(token: Address, account: Address, signal?: AbortSignal): Promise<bigint>;
}

/** The backend's keyless quote proxy (D-084). */
export interface SwapQuoteClient {
  quoteSwap(input: {
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
    /** The swap stand-in address: avnu's taker and the swap's beneficiary. */
    taker: Address;
    slippageBps: number;
    signal?: AbortSignal;
  }): Promise<SwapQuoteAnswer>;
}

export interface PrivateSubmissionGateway {
  /**
   * A relay fee quote for a relayed route. Since D-082 the Wallet API adapter
   * asks for none, and since D-084 no route the browser enables is relayed:
   * the backend relay stays, and this client still speaks to it.
   */
  estimate(input: {
    route: PrivateRoute;
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
}

export interface WalletRoutePolicy {
  maxIntents: number;
  maxRelayFee: bigint;
  /**
   * `vault` (D-077) admits the Vault's supply and redeem, which the wallet
   * submits itself, like shield: no relay fee and no intent bound. `borrow`
   * (D-083) admits the Borrow counter's four actions, submitted the same way.
   * `unstake` (D-085) admits Endur unstaking through a shadow account, the
   * same way; its tokens are pinned (xSTRK in, STRK out), so it takes no
   * token list.
   */
  enabledRoutes: readonly ('shield' | 'unshield' | 'transfer' | 'swap' | 'stake' | 'vault' | 'borrow' | 'unstake')[];
  /**
   * Every token crossing an enabled route must be explicitly admitted.
   *
   * `stake` (D-063) is optional so every existing policy stays valid; absent
   * admits no stake token, so the route fails closed even when enabled. When
   * present it must list both STRK (in) and xSTRK (out), as a swap lists both
   * of its sides. `vault` (D-077) is optional the same way; since D-079 it
   * may name any tokens the Vault pins a vault for (`VAULT_MARKETS`), each
   * once. A list with any other token, or a repeat, keeps the whole Vault
   * shut, as the build's own parser does. `borrow` (D-083) is optional the
   * same way and may name only tokens `BORROW_TOKENS` pins, each once; a pair
   * is admitted when both of its tokens are listed.
   */
  allowedTokens: Readonly<Record<'shield' | 'unshield' | 'transfer' | 'swap', readonly Address[]>> & {
    readonly stake?: readonly Address[];
    readonly vault?: readonly Address[];
    readonly borrow?: readonly Address[];
  };
  swap?: {
    expectedChainId: string;
    /**
     * The widest slippage a swap may use, in bps (1 to 300), and the one a
     * swap intent without its own `slippageBps` uses. Since D-090 the
     * Exchange's slippage cog chooses at or below it.
     */
    slippageBps: number;
    /**
     * D-067's degen floor (D-084): when true, a swap may name tokens beyond
     * `allowedTokens.swap`, and the backend's quote route is their admission
     * authority (its own allowlist or its own degen list): a token it does
     * not admit gets no quote, so no swap. Absent or false admits only the
     * static list.
     */
    degen?: boolean;
  };
}

export type SupportedVersionsReader = (signal?: AbortSignal) => Promise<readonly string[]>;
