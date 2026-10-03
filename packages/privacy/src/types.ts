/**
 * Public types for the financial seam.
 *
 * Amounts are always `bigint`. Token amounts routinely exceed
 * Number.MAX_SAFE_INTEGER and a silent precision loss here is a lost-funds
 * bug — there is no `number` in this file by design.
 */

/** A Starknet address. Compare normalised, never with `===`. */
export type Address = string;

/** Result of a submitted privacy operation. */
export interface TxResult {
  transactionHash: string;
}

/**
 * A shielded balance for one token.
 *
 * `spendable` and `maturing` are split because freshly created notes are not
 * immediately spendable. A "max" affordance uses `spendable` when the split
 * is known, and otherwise `total` (D-090, amending D-022).
 */
export interface PrivateBalance {
  token: Address;
  /** Total held, spendable + maturing. */
  total: bigint;
  /** Usable right now. */
  spendable: bigint;
  /** Arriving once the maturity window elapses. */
  maturing: bigint;
  /**
   * False when the wallet exposes only one aggregate balance per token. In
   * that case `spendable` and `maturing` are conservative zeroes, never a
   * MAX; a MAX uses `total` (D-090). The wallet remains authoritative at
   * proof time.
   */
  maturityKnown: boolean;
}

/**
 * Whether an address can receive a private transfer.
 *
 * Resolved by reading the pool's `get_public_key(address)` over ordinary RPC
 * — the Wallet API has no method for this. Unregistered returns `0x0`.
 *
 * `unknown` means the check itself failed (RPC error), which is distinct
 * from a confirmed `unregistered` and must be presented differently: one is
 * "they can't receive this", the other is "we couldn't tell".
 */
export type RecipientStatus = 'registered' | 'unregistered' | 'unknown';

/**
 * Progress for a long-running operation.
 *
 * Wallet-side proof generation means these take seconds, not frames. The
 * spec is explicit that a dapp "must tolerate long-running calls", so every
 * operation reports progress rather than blocking.
 */
export type OperationStage =
  | 'composing'
  | 'awaiting-approval'
  | 'proving'
  | 'submitting'
  | 'confirming'
  | 'done'
  | 'failed';

export interface OperationProgress {
  stage: OperationStage;
  message: string;
}

export type ProgressCallback = (progress: OperationProgress) => void;

/**
 * Failure classes the UI must distinguish. Mapped from wallet error codes
 * plus transport failures — a player seeing a raw RPC error is a defect.
 */
export type PrivacyErrorKind =
  /**
   * 118 — this account is not registered in the pool. Wallet-side action
   * required. A 118 met while proving a transfer is reported as the
   * recipient's instead (D-074).
   */
  | 'not-registered'
  /**
   * The transfer's recipient is not registered in the pool, so it cannot
   * receive a private transfer (D-074). The pool's `get_public_key` preflight
   * read zero, or the wallet answered 118 while proving the transfer. Nothing
   * was sent. A fact about the recipient, never about this account: only the
   * recipient can register, inside their own wallet.
   */
  | 'recipient-not-registered'
  /** 119 — insufficient shielded balance. Remember the pool fee. */
  | 'insufficient-balance'
  /** 120 — wallet refused on anonymity grounds. Trigger conditions undocumented. */
  | 'privacy-leak'
  /** 162 — wallet does not support the required API version. */
  | 'unsupported-wallet'
  /** Player declined in the wallet. Not an error state. */
  | 'user-rejected'
  /** Network or wallet unreachable. Retryable. */
  | 'unreachable'
  /** Private submit was dispatched, but no validated receipt returned. Never retry blindly. */
  | 'submission-uncertain'
  /**
   * This deployment's private relay has no avnu key, or avnu rejected it
   * (D-070). Nothing was sent, and retrying cannot help until the operator
   * sets one. Shield is unaffected: the wallet submits it.
   */
  | 'relay-not-configured'
  /**
   * The connected wallet cannot run a STRK20 shadow account yet (D-077): it
   * reports no Wallet API 0.10.4, its account lacks the commitment method, or
   * it answered the commitment request as unsupported. Nothing was sent. Only
   * the Vault needs one; every other route is unaffected.
   */
  | 'shadow-accounts-unsupported'
  /**
   * D-126: the swap's oracle guard refused the quote before the wallet was
   * asked. avnu's expected output, or the floor the chain would enforce, sits
   * further below Pragma's price than the floor allows (3% on the Exchange,
   * the degen floor's wider cap upstairs). Nothing was sent, and no wallet was
   * prompted. The throw is a `SwapPriceGuardError`, which carries the figures
   * the counter needs to say so in plain words.
   */
  | 'price-guard'
  /** Anything unmapped. Log it, then add a case. */
  | 'unknown';

export class PrivacyError extends Error {
  constructor(
    readonly kind: PrivacyErrorKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PrivacyError';
  }
}

/**
 * D-126: the swap's oracle guard refused a quote before the wallet was asked.
 * A `PrivacyError` of kind `price-guard`, with the two figures a counter needs
 * to explain itself: how far below Pragma's price the quote sits, and the cap
 * that floor allows. Both are own data properties, so a shell that holds no
 * value import of this package can still read them off the throw.
 *
 * It carries no address, no amount and no token: the counter already knows
 * which pair it asked about.
 */
export class SwapPriceGuardError extends PrivacyError {
  readonly shortfallBps: number;
  readonly boundBps: number;

  constructor(message: string, figures: { shortfallBps: number; boundBps: number }) {
    super('price-guard', message);
    this.name = 'SwapPriceGuardError';
    this.shortfallBps = figures.shortfallBps;
    this.boundBps = figures.boundBps;
  }
}

/**
 * Why the Borrow counter refuses an action before asking the wallet (D-083),
 * by the Vesu rule it would break. `borrow.ts`'s `assessBorrow` decides it.
 */
export type BorrowRefusal =
  | 'amount'
  | 'unknown-pair'
  | 'pair-not-offered'
  | 'stale-price'
  | 'above-max-ltv'
  /** The loan would end with health under `BORROW_MIN_HEALTH_AFTER`: too close to liquidation to send. */
  | 'too-close-to-liquidation'
  /** The prepared review is older than `BORROW_REVIEW_TTL_MS`: interest and prices may have moved. */
  | 'review-expired'
  | 'debt-below-floor'
  | 'collateral-below-floor'
  | 'debt-cap'
  | 'utilization'
  | 'nothing-to-repay'
  | 'repay-exceeds-debt'
  | 'withdraw-exceeds-collateral'
  | 'withdraw-all-with-debt';

/**
 * A prepare the Borrow counter refused before asking the wallet (D-083). A
 * `PrivacyError` of kind `unknown`, so anything that only knows the seam's
 * kinds treats it as an ordinary failure, with an own `refusal` naming the
 * rule. It carries no amount, address or figure.
 */
export class BorrowRefusedError extends PrivacyError {
  readonly refusal: BorrowRefusal;

  constructor(refusal: BorrowRefusal, message: string) {
    super('unknown', message);
    this.name = 'BorrowRefusedError';
    this.refusal = refusal;
  }
}
