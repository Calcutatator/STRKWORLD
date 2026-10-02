import type {
  Address,
  PrivateBalance,
  ProgressCallback,
  RecipientStatus,
  TxResult,
} from './types.js';
import type { PlacementCheck } from './wallet-api/leaderboard-operations.js';

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
 * takes a token, and `vaultRates` reads Vesu's supply APY) and D-083
 * (borrowing on Vesu from a second shadow account: `borrowMarket`,
 * `borrowPositions` and `prepareBorrow`, with their shapes below) and D-085
 * (Endur unstaking through a shadow account: `endurUnstakePosition`,
 * `prepareEndurUnstake` and `prepareEndurClaim`), D-090 (the swap
 * intent's optional `slippageBps`) and D-091 (`endurRate`, xSTRK's live
 * exchange rate, a public read); every other method and shape is
 * unchanged.
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
      /**
       * D-090: the player's slippage for this swap, in bps, from the
       * Exchange's slippage cog. A whole number from 1 to the build's
       * ceiling (`WalletRoutePolicy.swap.slippageBps`, at most 300); anything
       * else is refused. Absent, the swap uses the build's ceiling, as before.
       */
      slippageBps?: number;
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
  /** D-084: the quote held against an independent oracle price, or why it could not be. */
  readonly priceCheck: SwapPriceCheck;
}

/**
 * D-084: the swap's independent price check. `checked`: both tokens have an
 * oracle price and the expected output is worth no more than `boundBps` below
 * the input (a worse quote is refused before review). `unchecked`: a token has
 * no oracle price, so nothing independent vouches for the quote, and
 * confirming needs `acknowledgeUncheckedPrice`. USD values carry 8 decimals
 * and are present for each side that has a price.
 */
export interface SwapPriceCheck {
  readonly status: 'checked' | 'unchecked';
  readonly boundBps: number;
  readonly sellUsd?: bigint;
  readonly expectedBuyUsd?: bigint;
  /** How far below the input's value the expected output sits, in bps (negative: above). Checked only. */
  readonly shortfallBps?: number;
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
   * Present, and `true`, only when this transaction carries a private
   * placement receipt or ledger tick (leaderboard phase 1). Absent otherwise,
   * including whenever the leaderboard is switched off.
   */
  readonly countsTowardPlacement?: true;

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
    /**
     * D-084: the player acknowledged that this swap has no independent price
     * check. Required, exactly `true`, to confirm a swap whose
     * `swapReview.priceCheck.status` is `unchecked`; ignored otherwise.
     */
    acknowledgeUncheckedPrice?: boolean;
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
   * D-094: the connected account's PUBLIC balance of `token`, in base units:
   * what a shield draws on. An ERC-20 `balance_of` over the wallet's own RPC,
   * never STRKWORLD's backend or the lobby, and no wallet is asked, so it
   * raises no prompt and may be read when the Shield control opens. It is a
   * public chain fact, unlike `balances`, which only the wallet can answer.
   */
  publicBalance(token: Address, signal?: AbortSignal): Promise<bigint>;

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

  /**
   * The Borrow counter's market (D-083): Vesu's Prime pool as it stands now
   * for every token this build admits for borrowing, and every pair of them
   * live on-chain. One public read through the backend (D-014): no wallet,
   * no prompt, nothing about the player. Prices are Vesu's own oracle's; a
   * price its oracle calls invalid is reported as such, never hidden. A pair
   * whose max LTV or debt cap reads zero is left out (D-083). A read that
   * could not be made rejects `unreachable`.
   */
  borrowMarket(signal?: AbortSignal): Promise<BorrowMarket>;

  /**
   * The player's Vesu loans (D-083): every position the borrow counter's
   * own shadow account holds in an admitted pair, and that account's
   * address. The account is the player's second stand-in, for the dapp name
   * `strkworld-borrow` at nonce 0, so no loan is linkable on-chain to the
   * Vault's supply positions. Resolved and cross-checked exactly as
   * `vaultPositions` resolves the Vault's: the wallet's partial commitment
   * never leaves this package, and the address is public, to be shown and
   * linked on the player's request only, never stored, logged or sent
   * anywhere else. Call this from a player action: a wallet may ask first.
   */
  borrowPositions(options?: VaultCallOptions): Promise<BorrowPositions>;

  /**
   * Cost one borrow-counter action (D-083) as one private transaction the
   * wallet proves and submits itself (`wallet_strk20InvokeTransaction`): no
   * relay, no avnu key. Reads the market and the position first, and refuses,
   * before the wallet is asked anything, an action Vesu would revert: a
   * stale price, a pair not offered for new debt, a result above the pair's
   * max LTV, a debt or collateral below Vesu's floor, the debt cap, the
   * asset's utilization ceiling, or more than the position holds. Such a
   * refusal rejects with a `PrivacyError` of kind `unknown` that carries an
   * own `refusal` property naming the rule (`BorrowRefusal`), so the counter
   * can say which, in its own words.
   */
  prepareBorrow(request: BorrowRequest, options?: VaultCallOptions): Promise<PreparedBorrowBatch>;

  /**
   * The player's Endur unstaking (D-085): the unpaid withdrawal requests on
   * their unstaking shadow account (dapp name `strkworld-endur`, nonce 0, not
   * the Vault's), each `waiting` or `ready` by the chain's own clock, the
   * STRK Endur has already paid to that address, and the address itself.
   *
   * Resolved like the Vault's stand-in address (a commitment the wallet
   * derives, the anonymizer's view, the same cross-check), then one public
   * read through the backend (D-014). The commitment never leaves this
   * package; the address is public and the shell may show it, never store,
   * log or send it (D-079's rule). Call it from a player action: the wallet
   * may ask first.
   */
  endurUnstakePosition(options?: VaultCallOptions): Promise<EndurUnstakePosition>;

  /**
   * Cost an unstake request of `shares` xSTRK from the shielded balance
   * (D-085, flow A). The prepared batch withdraws the xSTRK to the unstaking
   * shadow account, a public leg, and has it call xSTRK's `redeem`, which
   * queues the STRK at Endur and mints the request to that address. Nothing
   * returns now; xSTRK already left on the address returns to the pool.
   * The wallet proves and submits it (`wallet_strk20InvokeTransaction`).
   */
  prepareEndurUnstake(shares: bigint, options?: VaultCallOptions): Promise<PreparedEndurBatch>;

  /**
   * Cost moving unstaked STRK into the shielded balance (D-085, flow B). When
   * the stand-in already holds STRK (Endur paid it there), the batch only
   * collects it: a claim in the same batch could revert if Endur's relayer
   * claims first. Otherwise the shadow account claims each request a dry run
   * found payable now (at most `MAX_ENDUR_CLAIMS_PER_BATCH`). Either way every
   * STRK on it lands in one pool note for this account. Refuses when nothing
   * is held and nothing is payable.
   */
  prepareEndurClaim(options?: VaultCallOptions): Promise<PreparedEndurBatch>;

  /**
   * The private placement (leaderboard phase 1): count this player's receipts
   * on-chain, refresh their anonymous entry at the blind tally, and read the
   * season's histogram. The wallet's season commitment stays inside this
   * package; the answer is counts only. Rejects when the leaderboard is
   * switched off: the Shell offers it only when its own flag is on.
   */
  checkPlacement(signal?: AbortSignal): Promise<PlacementCheck>;

  /**
   * xSTRK's live exchange rate (D-091): what one xSTRK converts to in STRK
   * now, by xSTRK's own `convert_to_assets`, read through the backend
   * (D-014). A public read about Endur's vault, naming nobody, and no wallet
   * is asked. It is an estimate for the staking counter's preview rows: a
   * stake or an unstake request is priced by Endur's vault when it runs, so
   * no review shows a figure from it (D-063, D-041). Open while the stake
   * or the unstake route is.
   */
  endurRate(signal?: AbortSignal): Promise<EndurRate>;
}

// ---------------------------------------------------------------------------
// Endur unstaking — D-085
// ---------------------------------------------------------------------------

/** One unpaid Endur withdrawal request on the unstaking stand-in address. */
export interface EndurWithdrawalRequest {
  /** Endur's request id, the queue NFT's token id. */
  readonly requestId: bigint;
  /** The STRK Endur owes for it, fixed when it was requested. */
  readonly assets: bigint;
  /** The xSTRK it burned. */
  readonly shares: bigint;
  /** Unix seconds, from the chain. */
  readonly requestedAt: number;
  /** Unix seconds after which Endur lets it be claimed (`claimTime`). */
  readonly claimableAt: number;
  /**
   * `waiting` before `claimableAt` by the chain's clock; then
   * `awaiting-funds` while a dry run of its claim reverts (Endur has not
   * funded its queue yet); `ready` once that dry run succeeds, until paid.
   */
  readonly status: 'waiting' | 'awaiting-funds' | 'ready';
  /** Seconds left by the chain's clock; zero once past its wait. */
  readonly secondsLeft: number;
}

/** xSTRK's exchange rate at the latest block (D-091). */
export interface EndurRate {
  /**
   * STRK base units (18 decimals) that one whole xSTRK, `10^18` shares,
   * converts to now. Positive; it grows as Endur's staking earns.
   */
  readonly strkPerXstrk: bigint;
  /**
   * `chain` for xSTRK's own answer; `demo` for the demo fake's fixed DEMO
   * RATE, which the shell must label as such and never pass off as Endur's.
   */
  readonly origin: 'chain' | 'demo';
}

/** What one unstaking read answers (D-085). */
export interface EndurUnstakePosition {
  /** The unstaking shadow account: public on-chain, never stored, logged or sent anywhere unasked. */
  readonly standIn: Address;
  /** The latest block's timestamp, the clock every `status` is read by. */
  readonly chainTime: number;
  /** Unpaid requests, oldest first. */
  readonly requests: readonly EndurWithdrawalRequest[];
  /** STRK on the stand-in address: requests already paid out there, not yet moved to the pool. */
  readonly strkHeld: bigint;
  /** xSTRK on the stand-in address, which the next request returns to the pool. */
  readonly xstrkHeld: bigint;
  /** Unpaid requests the address holds that the read could not list, being older than its window. */
  readonly unlisted: number;
  /** False when the read's scan ran out of pages, so the list may be missing requests. */
  readonly complete: boolean;
}

/** What a prepared unstaking batch does, for the review (D-085). */
export type EndurAction =
  /** Queue `shares` xSTRK at Endur; `leftover` xSTRK already on the stand-in returns to the pool. */
  | { readonly kind: 'request'; readonly shares: bigint; readonly leftover: bigint }
  /**
   * Claim `requestIds` (each ready and unpaid at prepare time; empty when
   * Endur had paid them all) and collect every STRK on the stand-in: `owed`
   * from those requests plus `held` already there. The exact amount is
   * whatever the address holds when it runs.
   */
  | { readonly kind: 'claim'; readonly requestIds: readonly bigint[]; readonly owed: bigint; readonly held: bigint };

/**
 * A costed unstaking batch (D-085), with the Vault's prepare-then-confirm
 * contract: the wallet proves and submits it and adds its own network fee,
 * so `gasEstimate` is zero and `totalCost` is the pool fee.
 */
export interface PreparedEndurBatch {
  readonly action: EndurAction;
  readonly poolFee: bigint;
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  readonly warnings: readonly BatchWarning[];
  readonly promptCount: number;
  /**
   * Present, and `true`, only when this transaction carries a private
   * placement receipt or ledger tick (leaderboard phase 1). Absent otherwise,
   * including whenever the leaderboard is switched off.
   */
  readonly countsTowardPlacement?: true;
  confirm(opts: {
    feeCeiling: bigint;
    onProgress?: ProgressCallback;
    onStage?: VaultStageCallback;
    onSubmitted?: (result: TxResult) => void;
    signal?: AbortSignal;
  }): Promise<VaultTxResult>;
  discard(): void;
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
   * Present, and `true`, only when this transaction carries a private
   * placement receipt or ledger tick (leaderboard phase 1). Absent otherwise,
   * including whenever the leaderboard is switched off.
   */
  readonly countsTowardPlacement?: true;

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

// ---------------------------------------------------------------------------
// Borrowing on Vesu — D-083
// ---------------------------------------------------------------------------

/**
 * One admitted token as Vesu's Prime pool stands now (D-083). Values in USD
 * are Vesu's own: scaled by 10^18, its `SCALE`.
 */
export interface BorrowAsset {
  readonly token: Address;
  /** Vesu's oracle price, USD per whole token × 10^18. */
  readonly price: bigint;
  /**
   * Whether Vesu's oracle calls the price valid now. When it does not, Vesu
   * reverts every action on any pair with this token, repay included, so the
   * counter shows no health figure and offers nothing.
   */
  readonly priceValid: boolean;
  /** 10^decimals: Vesu's asset scale. */
  readonly scale: bigint;
  /** The least value a debt in this token may have, or a collateral backing any debt, USD × 10^18. */
  readonly floor: bigint;
  /** What the pool holds of the token now, in its base units. */
  readonly reserve: bigint;
  /** Everything borrowed of it now, interest included, in its base units. */
  readonly totalDebt: bigint;
  /** The most of it Vesu lets be borrowed, as a fraction of all supplied × 10^18. */
  readonly maxUtilization: bigint;
}

/** One pair Vesu offers for borrowing now (D-083): `debt` borrowed against `collateral`. */
export interface BorrowPair {
  readonly collateral: Address;
  readonly debt: Address;
  /** The most a position may owe against its collateral's value, × 10^18. Liquidatable above it. */
  readonly maxLtv: bigint;
  /** Vesu's liquidation factor, × 10^18: what a liquidator pays for the collateral it takes. */
  readonly liquidationFactor: bigint;
  /** The most of `debt` the whole pair may owe, in its base units. Above zero for every offered pair. */
  readonly debtCap: bigint;
  /** What the whole pair owes now, interest included, in `debt`'s base units. */
  readonly totalDebt: bigint;
}

/** What one market read answers (D-083). */
export interface BorrowMarket {
  /** One per admitted token, in the build's order. */
  readonly assets: readonly BorrowAsset[];
  /** The admitted pairs live on-chain (max LTV and debt cap above zero), collateral-major. */
  readonly pairs: readonly BorrowPair[];
}

/** One loan: a position in one pair, in base units of each token. */
export interface BorrowPosition {
  readonly collateral: Address;
  readonly debt: Address;
  /** Vesu's collateral shares. Not the token's units: show `collateralAmount`. */
  readonly collateralShares: bigint;
  /** Vesu's nominal debt. Not the token's units: show `debtAmount`. */
  readonly nominalDebt: bigint;
  /** What the collateral is worth now in its token, by Vesu's own view. */
  readonly collateralAmount: bigint;
  /** What is owed now, interest included, by Vesu's own view. */
  readonly debtAmount: bigint;
  /** The loan's health at Vesu's prices as read with it, by Vesu's own rule. */
  readonly health: BorrowHealth;
}

/** What one loans read answers (D-083). */
export interface BorrowPositions {
  /**
   * The borrow counter's shadow account: public on-chain, with every
   * balance, loan and call on it, and liquidatable like any Vesu position.
   * Not the Vault's. Shown and linked on request only; never persisted,
   * logged or sent anywhere unasked.
   */
  readonly standIn: Address;
  /** Every admitted pair the account holds collateral or debt in, collateral-major. */
  readonly positions: readonly BorrowPosition[];
}

/**
 * One borrow-counter action, in game terms (D-083). The shell names pairs
 * and amounts; this package builds every call.
 *
 * - `borrow` opens a loan or adds to one: `collateralAmount` (zero for none)
 *   leaves the pool balance as collateral and `borrowAmount` returns to it.
 * - `repay` takes `amount` from the pool balance, or `'all'`: the whole debt
 *   by Vesu's own count when the transaction runs, with a small buffer
 *   whose unused part returns to the pool balance.
 * - `withdraw-collateral` returns `amount` (or `'all'`, with no debt left)
 *   to the pool balance.
 */
export type BorrowRequest =
  | {
      readonly kind: 'borrow';
      readonly collateral: Address;
      readonly debt: Address;
      readonly collateralAmount: bigint;
      readonly borrowAmount: bigint;
    }
  | { readonly kind: 'add-collateral'; readonly collateral: Address; readonly debt: Address; readonly amount: bigint }
  | { readonly kind: 'repay'; readonly collateral: Address; readonly debt: Address; readonly amount: bigint | 'all' }
  | {
      readonly kind: 'withdraw-collateral';
      readonly collateral: Address;
      readonly debt: Address;
      readonly amount: bigint | 'all';
    };

/** What a prepared borrow-counter batch does, for the review (D-083). */
export type BorrowAction =
  | {
      readonly kind: 'borrow';
      readonly collateral: Address;
      readonly debt: Address;
      readonly collateralAmount: bigint;
      readonly borrowAmount: bigint;
    }
  | { readonly kind: 'add-collateral'; readonly collateral: Address; readonly debt: Address; readonly amount: bigint }
  /**
   * `amount` is what leaves the pool balance. For `all` it is the debt at
   * prepare time plus `buffer`; the unused part of the buffer returns. A
   * partial repay has a zero buffer.
   */
  | {
      readonly kind: 'repay';
      readonly collateral: Address;
      readonly debt: Address;
      readonly amount: bigint;
      readonly all: boolean;
      readonly buffer: bigint;
    }
  /** For `all`, `amount` is the collateral at prepare time: Vesu fixes the exact figure when it runs. */
  | {
      readonly kind: 'withdraw-collateral';
      readonly collateral: Address;
      readonly debt: Address;
      readonly amount: bigint;
      readonly all: boolean;
    };

/**
 * A loan's health by Vesu's own rule (D-083): it is collateralised while
 * `collateralValue × maxLtv ≥ debtValue × 10^18`, and liquidatable by anyone
 * once it is not. Every figure × 10^18.
 *
 * - `no-debt`: nothing owed, nothing to liquidate.
 * - `stale-price`: Vesu's oracle calls a price invalid; no figure is honest.
 * - `priced`: the figures below hold, at Vesu's prices now.
 */
export interface BorrowHealth {
  readonly status: 'no-debt' | 'stale-price' | 'priced';
  /** USD × 10^18; zero when stale. */
  readonly collateralValue: bigint;
  readonly debtValue: bigint;
  /** Debt over collateral value, × 10^18; null with no debt or a stale price. */
  readonly ltv: bigint | null;
  readonly maxLtv: bigint;
  /** `collateralValue × maxLtv / debtValue`, × 10^18: below 1 is liquidatable. Null with no debt or a stale price. */
  readonly healthFactor: bigint | null;
  /** The collateral price, USD per whole token × 10^18, at which the loan turns liquidatable if the debt token holds its price. */
  readonly liquidationPrice: bigint | null;
  /** `warning` is the band near liquidation (`BORROW_WARNING_HEALTH`); `unknown` with a stale price. */
  readonly band: 'none' | 'safe' | 'warning' | 'liquidatable' | 'unknown';
}

/**
 * A costed borrow-counter action (D-083), with the Vault's prepare-then-
 * confirm contract: the wallet proves and submits it and adds its own network
 * fee, so `gasEstimate` is zero and `totalCost` is the pool fee, set in STRK.
 */
export interface PreparedBorrowBatch {
  readonly action: BorrowAction;
  /** The loan's health once this runs, by this package's own fresh reads at prepare time. */
  readonly after: BorrowHealth;
  readonly poolFee: bigint;
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  readonly warnings: readonly BatchWarning[];
  readonly promptCount: number;
  /**
   * Present, and `true`, only when this transaction carries a private
   * placement receipt or ledger tick (leaderboard phase 1). Absent otherwise,
   * including whenever the leaderboard is switched off.
   */
  readonly countsTowardPlacement?: true;
  confirm(opts: Parameters<PreparedVaultBatch['confirm']>[0]): Promise<VaultTxResult>;
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
