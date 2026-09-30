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
 * FROZEN 2026-08-18 under D-036 on source-derived evidence. Any change to this
 * interface or its transitive public shapes needs a decision entry and a
 * heads-up to dependent lanes before implementation. Funded prompt behavior,
 * latency and live-paymaster artifact acceptance remain pre-launch checks.
 * Narrowly extended by D-041/D-042 (`SwapReview`), D-063 (the `stake`
 * intent), D-072 (the entry gate's `hasPrivateFunds` and `depositStatus`),
 * D-077 (the Vault's position read, `prepareVaultSupply` and
 * `prepareVaultRedeem`, and the `supportsShadowAccounts` capability) and
 * D-079 (the Vault in several tokens: `vaultPositions` replaces
 * `vaultPosition` and returns the stand-in address, `prepareVaultRedeem`
 * takes a token, and `vaultRates` reads Vesu's supply APY); every other
 * method and shape is unchanged.
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
    }
  /**
   * Endur private staking (D-063): shielded STRK in, shielded xSTRK out,
   * through Endur's STRK20 anonymizer. `tokenIn` must be STRK and `tokenOut`
   * xSTRK (`ENDUR_XSTRK_ASSET` / `ENDUR_XSTRK`); anything else fails closed.
   *
   * No minimum output, deliberately. The anonymizer's `privacy_invoke` takes no
   * floor, and the ERC-4626 share amount is fixed only at execution, so a
   * minimum here could never be enforced on-chain. D-041/D-042 forbid
   * reviewing a floor that nothing protects.
   */
  | {
      kind: 'stake';
      tokenIn: Address;
      tokenOut: Address;
      amountIn: bigint;
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

/** Display-only review data for one prepared AVNU swap. */
export interface SwapReview {
  readonly expectedAmountOut: bigint;
  readonly minimumAmountOut: bigint;
  readonly slippageBps: number;
  readonly expiresAt: number;
}

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
  /** Sanitized display-only review data, present only for a prepared single swap. */
  readonly swapReview?: SwapReview;

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
   * `prepare()` reads it again for every transfer, and a transfer to an
   * `unregistered` address rejects with `recipient-not-registered`, never
   * with this account's own `not-registered` (D-074).
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

  /**
   * Whether this account holds anything in the pool (D-072).
   *
   * One balance read for every shielded token, answered as a boolean: true
   * when any token's total, maturing included, is above zero. The amounts
   * never leave this package. The wallet asks the player before sharing, as
   * for `balances()`, so call this only from a player action. An account the
   * pool has never seen rejects with `not-registered`.
   */
  hasPrivateFunds(signal?: AbortSignal): Promise<boolean>;

  /**
   * Whether a shield this account submitted has landed in the pool (D-072).
   *
   * A public read of the transaction's receipt through the backend (D-014),
   * never a wallet prompt, and it returns no amount. See `DepositStatus`. A
   * read that could not be made (the service down, busy, or its node
   * erroring) rejects `unreachable`, so a caller can tell a slow chain from a
   * check it cannot make; it says nothing about the deposit either way.
   */
  depositStatus(transactionHash: string, signal?: AbortSignal): Promise<DepositStatus>;

  /**
   * The player's Vault positions (D-077, D-079): what their STRK20 shadow
   * account holds in Vesu's vault for each token this build admits, and the
   * shadow account's address, the "stand-in" address.
   *
   * The wallet derives the shadow account's partial commitment for the
   * Vault's fixed dapp name, without a transaction and without the viewing key
   * leaving it. The address comes from the canonical anonymizer's own view,
   * cross-checked here against the address the anonymizer derives, and the
   * positions are one public read through the backend (D-014). The commitment
   * never leaves this package. The address is public on-chain, so the shell
   * may show it and link to it on the player's request, and must never store,
   * log or send it anywhere else (D-079). Call this from a player action: a
   * wallet may ask before it answers. Rejects `shadow-accounts-unsupported`
   * for a wallet without shadow accounts, and `not-registered` for an account
   * the pool does not know.
   */
  vaultPositions(options?: VaultCallOptions): Promise<VaultPositions>;

  /**
   * Cost a Vault supply of `amount` of `token` (a token this build admits
   * and the Vault pins a vault for, D-079) from the shielded balance into
   * Vesu, held by the player's shadow account (D-077).
   *
   * The prepared batch withdraws `amount` of `token` from the pool to the
   * shadow account, a public leg, then runs `approve` and the vault's
   * `deposit` through it. The vault shares stay on that address, whose
   * balance and activity are public; only its link to the player's wallet is
   * hidden. `confirm()` asks the wallet to prove and submit it itself
   * (`wallet_strk20InvokeTransaction`): no STRKWORLD relay is involved.
   */
  prepareVaultSupply(token: Address, amount: bigint, options?: VaultCallOptions): Promise<PreparedVaultBatch>;

  /**
   * Cost a Vault redeem of `token` back into the shielded balance (D-077,
   * D-079): `amount` in the token's base units, withdrawn from the position
   * by the vault's `withdraw`, or `'all'`, every share by `redeem`. What the
   * call gains returns to a pool note of `token` owned by this account
   * (`collect_policy: diff`), so a public balance the shadow account already
   * held stays where it is. Reads the position first and refuses more than
   * the vault lets it take now.
   */
  prepareVaultRedeem(token: Address, amount: bigint | 'all', options?: VaultCallOptions): Promise<PreparedVaultBatch>;

  /**
   * Vesu's current supply APY for each token this build's Vault admits
   * (D-079), from Vesu's public API through the backend (D-014): no wallet,
   * no prompt, and nothing about the player in the request. Vesu's own
   * figure, not STRKWORLD's and no promise of a return. A token Vesu states
   * no rate for is absent; a read that could not be made rejects
   * `unreachable`.
   */
  vaultRates(signal?: AbortSignal): Promise<readonly VaultRate[]>;
}

// ---------------------------------------------------------------------------
// The Vault — D-077
// ---------------------------------------------------------------------------

/**
 * Options every Vault call takes. `onStage` observes where the call got to,
 * for D-069's probe logs; it can never change what the call does.
 */
export interface VaultCallOptions {
  readonly signal?: AbortSignal;
  readonly onStage?: VaultStageCallback;
}

/**
 * One step of a Vault call, as the probe logs it (D-077, D-069). Codes and
 * yes/no answers only: never an amount, a balance, an address, a commitment
 * or a transaction hash. `code` is the wallet's own error code, or null when
 * the failure carried none.
 */
export type VaultStage =
  /**
   * The version query's answer, before anything is asked of the wallet: with
   * `supported: false` nothing was asked of it, and the call stops here.
   */
  | { readonly stage: 'capability'; readonly supported: boolean }
  /** The wallet answered, or refused, the commitment request. */
  | { readonly stage: 'commitment'; readonly ok: true }
  | { readonly stage: 'commitment'; readonly ok: false; readonly code: number | null }
  /** The shadow account's address was resolved and cross-checked, or was not. */
  | { readonly stage: 'address'; readonly resolved: true; readonly deployed: boolean }
  | { readonly stage: 'address'; readonly resolved: false }
  /** The public position read answered, or failed. */
  | { readonly stage: 'position'; readonly ok: boolean }
  /** The wallet returned a transaction hash, or refused to submit. */
  | { readonly stage: 'submit'; readonly ok: true }
  | { readonly stage: 'submit'; readonly ok: false; readonly code: number | null }
  /** What the transaction's receipt said by the time the call stopped waiting. */
  | { readonly stage: 'receipt'; readonly status: VaultOutcome | 'unreadable' };

export type VaultStageCallback = (stage: VaultStage) => void;

/**
 * One token's Vault position, in base units of `token`. Read on request,
 * never polled.
 */
export interface VaultPosition {
  /** A token the Vault lends (D-079): the vault's asset. */
  readonly token: Address;
  /**
   * Vault shares (the vToken) the shadow account holds. A vToken has 18
   * decimals whatever the token's own, so shares are not the token's units:
   * show `assets`, never this.
   */
  readonly shares: bigint;
  /** What those shares redeem for now, in `token`, by the vault's own preview. */
  readonly assets: bigint;
  /** The most the vault lets the position withdraw now; at most `assets`. */
  readonly redeemable: bigint;
}

/**
 * What one position read answers (D-079): the stand-in address and one
 * position per admitted token, in the build's allowlist order.
 */
export interface VaultPositions {
  /**
   * The player's shadow account for the Vault: public on-chain, with every
   * balance and call on it, and linked to each of their Vault actions. The
   * shell may show it and offer a link to a block explorer; it must never
   * persist it, log it, or send it anywhere unasked.
   */
  readonly standIn: Address;
  readonly positions: readonly VaultPosition[];
}

/** Vesu's supply APY for one token's vault (D-079). */
export interface VaultRate {
  readonly token: Address;
  /**
   * The yearly rate as a fraction, `value / 10^decimals` (0.0273 is 2.73%),
   * exactly as Vesu's API states it. Vesu's figure: it moves with the
   * vault's use and promises no return.
   */
  readonly supplyApy: { readonly value: bigint; readonly decimals: number };
}

/** What a prepared Vault batch does, for the review. */
export type VaultAction =
  | { readonly kind: 'supply'; readonly token: Address; readonly amount: bigint }
  /**
   * `amount` is exact for a partial redeem, in base units of `token`. For
   * `all` it is the vault's preview at prepare time: the exact amount is
   * fixed when the redeem runs.
   */
  | { readonly kind: 'redeem'; readonly token: Address; readonly amount: bigint; readonly all: boolean };

/**
 * A costed Vault supply or redeem (D-077), with the same prepare-then-confirm
 * contract as `PreparedBatch`.
 *
 * The wallet proves and submits it (`wallet_strk20InvokeTransaction`) and
 * adds its own network fee there, so `gasEstimate` is zero and `totalCost` is
 * the pool fee: the network fee is the wallet's to state when it asks.
 *
 * The pool fee is set in the pool's fee token, STRK, whatever token the
 * action moves (D-013, D-079). The wallet adds one withdrawal from the
 * player's shielded balance to cover it, in a token the wallet chooses, which
 * need not be the action's: its prompt is where the player sees which.
 */
export interface PreparedVaultBatch {
  readonly action: VaultAction;
  /** Protocol fee, read live, in the pool's fee token (STRK). */
  readonly poolFee: bigint;
  /** Zero: the wallet adds and prices its own network fee. */
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  readonly warnings: readonly BatchWarning[];
  readonly promptCount: number;

  /**
   * Hand the batch to the wallet to prove and submit, then wait a bounded
   * time for its receipt. `onSubmitted` reports the hash as soon as the
   * wallet returns it, before the wait. Once a hash exists this never
   * rejects: a receipt still missing when the wait ends, or a cancelled
   * wait, resolves `pending`.
   */
  confirm(opts: {
    feeCeiling: bigint;
    onProgress?: ProgressCallback;
    onStage?: VaultStageCallback;
    onSubmitted?: (result: TxResult) => void;
    signal?: AbortSignal;
  }): Promise<VaultTxResult>;

  /** Release the batch. Safe to call twice. */
  discard(): void;
}

/**
 * - `succeeded`: accepted, and executed.
 * - `reverted`: accepted, and reverted: nothing in it happened.
 * - `pending`: no accepted receipt yet. Never evidence of failure.
 */
export type VaultOutcome = 'succeeded' | 'reverted' | 'pending';

export interface VaultTxResult extends TxResult {
  readonly outcome: VaultOutcome;
}

/**
 * What a shield's receipt says (D-072).
 *
 * - `landed`: the transaction succeeded, was accepted, and the pool emitted a
 *   `Deposit` naming this account.
 * - `failed`: it reverted, or it was accepted without such a deposit.
 * - `pending`: there is no accepted receipt yet, including for a hash the
 *   network has not seen. Ask again later; this is never evidence that the
 *   deposit failed.
 */
export type DepositStatus = 'landed' | 'pending' | 'failed';

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
   * Whether this wallet can run a STRK20 shadow account, which only the Vault
   * needs (D-077): it reports Wallet API 0.10.4 or later and its account
   * exposes the commitment method. From the same version query as the rest,
   * never a prompt. The wallet can still refuse the commitment itself, which
   * a Vault call reports as `shadow-accounts-unsupported`. Absent reads as
   * false.
   */
  supportsShadowAccounts?: boolean;
  /**
   * Whether the account is registered in the pool.
   *
   * `unknown` until something has been called — there is no silent dapp probe.
   * Ready 5.33.8 rejects its dapp-facing STRK20 calls when registration is
   * absent; onboarding must hand the player to the wallet's own registration
   * flow rather than pretending the dapp can perform it.
   */
  registration: 'registered' | 'unregistered' | 'unknown';
}
