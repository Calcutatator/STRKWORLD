import type {
  Address,
  PrivateBalance,
  ProgressCallback,
  RecipientStatus,
  TxResult,
} from './types.js';

/**
 * The financial seam.
 *
 * Everything the rest of STRKWORLD knows about money goes through this
 * interface. Nothing outside `@strkworld/privacy` imports `starknet`.
 *
 * Revised 2026-08-16 (D-015). The previous version offered only single-shot
 * operations and could not express batching, fee validation before signing, or
 * cancellation — all of which the design depends on.
 *
 * ⚠ Still PROVISIONAL pending the Phase 0 wallet spike, which may change
 * `WalletCapability` and the prompt-count assumptions. Do not freeze until
 * then.
 *
 * Implementations must not branch on wallet identity. Capability is determined
 * at runtime, which is what keeps web wallets possible later without a rewrite.
 */

// ---------------------------------------------------------------------------
// Intents — what the game asks for
// ---------------------------------------------------------------------------

/**
 * A single thing the player wants to do, in game terms.
 *
 * The shell accumulates intents during a building visit; this package
 * translates them into a `STRK20_ACTION[]`. **The shell never constructs a
 * protocol action** — that ownership was ambiguous before D-015 and is now
 * explicit.
 */
export type Intent =
  | { kind: 'shield'; token: Address; amount: bigint }
  | { kind: 'unshield'; token: Address; amount: bigint; recipient: Address }
  | { kind: 'transfer'; token: Address; amount: bigint; recipient: Address }
  | {
      kind: 'swap';
      tokenIn: Address;
      tokenOut: Address;
      amountIn: bigint;
      minAmountOut: bigint;
    };

/**
 * Something the player should know before confirming.
 *
 * Warnings are not errors — the batch is valid. They exist because several of
 * this protocol's sharp edges are only visible at prepare time, and a player
 * who hits one afterwards experiences it as the app breaking.
 */
export type BatchWarning =
  /** Confirming leaves too little to cover a future fee — the stranding trap. */
  | { kind: 'leaves-below-fee'; remaining: bigint; feeEstimate: bigint }
  /** A recipient is not registered in the pool and cannot receive. */
  | { kind: 'recipient-unregistered'; recipient: Address }
  /** Part of the balance is still maturing and is not spendable yet. */
  | { kind: 'funds-maturing'; maturingAmount: bigint; blocksRemaining: number }
  /** This batch reveals something on-chain. Say precisely what. */
  | { kind: 'public-leg'; detail: string }
  /** The wallet prompts more than once for what reads as one action. */
  | { kind: 'multiple-prompts'; count: number };

// ---------------------------------------------------------------------------
// Prepared batch — the estimate half of estimate-then-confirm
// ---------------------------------------------------------------------------

/**
 * A costed, not-yet-submitted batch.
 *
 * The split exists because D-013 requires validating the paymaster's returned
 * fee against a ceiling **before signing**. A one-shot method cannot do that:
 * by the time it returns, the player has already paid.
 */
export interface PreparedBatch {
  readonly intents: readonly Intent[];
  /** Protocol fee, read live. Never hardcode — it is governance-settable. */
  readonly poolFee: bigint;
  /** Network gas estimate. */
  readonly gasEstimate: bigint;
  /** Everything the player pays, in the fee token. */
  readonly totalCost: bigint;
  /** Surface all of these before confirming. */
  readonly warnings: readonly BatchWarning[];
  /** Expected prompts from shipped wallet source; funded UI verification is still pending. */
  readonly promptCount: number;

  /**
   * Submit. Rejects with `PrivacyError`; never throws a raw wallet error.
   *
   * `feeCeiling` is a hard guard: if the fee moved above it since prepare,
   * this rejects rather than signing. Always pass one.
   */
  confirm(opts: {
    feeCeiling: bigint;
    onProgress?: ProgressCallback;
    signal?: AbortSignal;
  }): Promise<TxResult>;

  /** Release any held quote or reservation. Safe to call twice. */
  discard(): void;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export interface PrivacyOperations {
  /**
   * Can this wallet do STRK20 at all?
   *
   * Determined by a **version query**, never by reading balances — a balance
   * read prompts the player for consent to data the app has no reason to see.
   */
  capability(signal?: AbortSignal): Promise<WalletCapability>;

  /** Live pool parameters. Read at runtime; the fee has already moved once. */
  poolConfig(signal?: AbortSignal): Promise<PoolConfig>;

  /** Shielded balances. Omit `tokens` for everything held. */
  balances(tokens?: Address[], signal?: AbortSignal): Promise<PrivateBalance[]>;

  /**
   * Whether an address can receive a private transfer.
   *
   * Read from the pool contract, not the Wallet API — no wallet method exists.
   * Call before offering a send; otherwise it fails late with no explanation.
   */
  recipientStatus(address: Address, signal?: AbortSignal): Promise<RecipientStatus>;

  /**
   * Cost a batch of intents without submitting.
   *
   * One intent or twenty — batching is how the pool fee is amortised across a
   * session rather than paid per move, so this is the normal entry point, not
   * an optimisation.
   *
   * It will **not** batch a shield with the transfer it funds: a deposit
   * carries a public leg naming the depositor, and bundling publishes exactly
   * the link the pool exists to break. Such a batch is rejected; the shell
   * prepares and confirms the shield first, then creates a later private batch.
   */
  prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch>;
}

// ---------------------------------------------------------------------------
// Supporting shapes
// ---------------------------------------------------------------------------

export interface PoolConfig {
  /** Per-transaction protocol fee, smallest unit. Live value. */
  feeAmount: bigint;
  /** Fee token. STRK today — see D-013. */
  feeToken: Address;
  /** Blocks a prepared proof stays valid. Past this, re-prepare. */
  proofValidityBlocks: number;
  /** Blocks before a new note is spendable. */
  noteMaturityBlocks: number;
}

export interface WalletCapability {
  supportsStrk20: boolean;
  /** Highest supported wallet-API version, or null if none reported. */
  walletApiVersion: string | null;
  /**
   * Whether the account is registered in the pool.
   *
   * `unknown` until something has been called — there is no probe that cannot
   * trigger a consent prompt. Phase 0 must establish whether wallets
   * auto-register on first use, which would make this mostly moot.
   */
  registration: 'registered' | 'unregistered' | 'unknown';
}
