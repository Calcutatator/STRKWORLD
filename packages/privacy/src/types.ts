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
 * immediately spendable. Any "max" affordance must use `spendable` only.
 */
export interface PrivateBalance {
  token: Address;
  /** Total held, spendable + maturing. */
  total: bigint;
  /** Usable right now. */
  spendable: bigint;
  /** Arriving once the maturity window elapses. */
  maturing: bigint;
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
  /** 118 — not registered in the pool. Wallet-side action required. */
  | 'not-registered'
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
