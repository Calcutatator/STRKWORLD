import type {
  Address,
  PrivateBalance,
  PrivateSwapInput,
  ProgressCallback,
  RecipientStatus,
  TxResult,
} from './types.js';

/**
 * The financial seam.
 *
 * ⚠ PROVISIONAL — NOT FROZEN. This interface was frozen prematurely and is
 * known to be incomplete: it has no batched-intent entry point (the batch
 * accumulator is the core economic mechanism), no PoolConfig or capability
 * getter, no estimate-then-confirm split (D-013 requires validating the
 * paymaster's fee before signing), and no AbortSignal. Revise it after the
 * Phase 0 wallet spike, then freeze. See docs/DECISIONS.md D-015.
 *
 * Everything the rest of STRKWORLD knows about money goes through this
 * interface. Nothing outside `@strkworld/privacy` imports `starknet`.
 *
 * Implementations must not branch on wallet identity. Capability is
 * determined at runtime, which is what keeps web wallets and email login
 * possible later without a rewrite.
 */
export interface PrivacyOperations {
  /** Shielded balances. Empty/omitted `tokens` returns everything held. */
  balances(tokens?: Address[]): Promise<PrivateBalance[]>;

  /**
   * Move public tokens into the pool.
   *
   * Always to self — the protocol has no recipient field on deposit, so the
   * game cannot fund a player's shielded balance for them.
   */
  shield(token: Address, amount: bigint, onProgress?: ProgressCallback): Promise<TxResult>;

  /**
   * Move tokens out of the pool to a public address.
   *
   * Note: the exit is public. Token, amount and recipient are visible
   * on-chain, and withdrawing the same amount to the same address shortly
   * after shielding is publicly linkable.
   */
  unshield(
    token: Address,
    amount: bigint,
    recipient: Address,
    onProgress?: ProgressCallback,
  ): Promise<TxResult>;

  /**
   * Whether an address can receive a private transfer.
   *
   * Read from the pool contract, not the Wallet API. Call before offering a
   * send; a transfer to an unregistered recipient otherwise fails late with
   * no explanation.
   */
  recipientStatus(address: Address): Promise<RecipientStatus>;

  /** Private transfer inside the pool. Preflight with `recipientStatus` first. */
  transfer(
    token: Address,
    amount: bigint,
    recipient: Address,
    onProgress?: ProgressCallback,
  ): Promise<TxResult>;

  /**
   * Swap via an anonymizer.
   *
   * Unlinkable but *not* amount-confidential — the AMM leg is public. Never
   * present this to a player as hiding the amount.
   */
  privateSwap(input: PrivateSwapInput, onProgress?: ProgressCallback): Promise<TxResult>;
}

/**
 * Runtime pool configuration.
 *
 * Read live, never hardcoded. The fee is governance-settable and has already
 * changed once; a prepared proof anchors to a block and expires.
 */
export interface PoolConfig {
  /** Per-transaction protocol fee, in the fee token's smallest unit. */
  feeAmount: bigint;
  /** Blocks a prepared proof stays valid for. */
  proofValidityBlocks: number;
  /** Blocks before a new note becomes spendable. */
  noteMaturityBlocks: number;
}

/** Capability probe. Runs before any building offers an action. */
export interface WalletCapability {
  supportsStrk20: boolean;
  walletApiVersion: string | null;
}
