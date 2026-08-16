/**
 * Public types for the Bridge building.
 *
 * Amounts are `bigint` throughout, as everywhere else that touches value.
 */

/**
 * IN and OUT are different flows, not mirror images.
 *
 * IN  — some chain's asset lands as STRK on Starknet; reaching the player's
 *       chosen token needs an AVNU swap leg afterwards.
 * OUT — a Starknet asset goes out as any registry asset; the solver delivers
 *       directly and there is no swap leg.
 */
export type BridgeDirection = 'in' | 'out';

/**
 * How the player funds the origin side.
 *
 * `signed` — the player signs a deposit in a connected wallet.
 * `manual` — the player goes off to an exchange withdrawal screen and we poll
 *            for arrival. This is the common case for funding from a
 *            centralised exchange, so design for it first rather than treating
 *            it as an edge case.
 */
export type DepositMode = 'signed' | 'manual';

export interface BridgeQuote {
  direction: BridgeDirection;
  depositMode: DepositMode;
  originAssetId: string;
  destinationAssetId: string;
  amountIn: bigint;
  /** Solver's estimate. Not a guarantee — surface it as an estimate. */
  amountOutEstimate: bigint;
  /** Where the player sends funds on the origin chain. */
  depositAddress: string;
  /** Quote expiry. Past this, re-quote rather than submitting. */
  expiresAt: number;
  slippageBps: number;
}

/**
 * A bridge is multi-leg and takes minutes. Each leg is persisted so the flow
 * survives a reload, a tab close or a crash — a player who loses the tab
 * mid-bridge must be able to come back and find it.
 */
export type BridgeLeg =
  | 'quoted'
  | 'awaiting-deposit'
  | 'deposit-detected'
  | 'solver-settling'
  | 'swap-leg'
  | 'complete'
  | 'failed'
  | 'expired';

export interface BridgeStatus {
  leg: BridgeLeg;
  /** Present once the origin-side deposit is on chain. */
  depositTxHash?: string;
  /** Present once the destination side has settled. */
  settlementTxHash?: string;
  /** Human-readable, already mapped from solver states. Never surface raw. */
  message: string;
  /**
   * True once we have stopped actively polling. The flow is not necessarily
   * dead — the player can leave and return. Distinguish this from `failed` in
   * the UI: one is "still working", the other is "this will not complete".
   */
  pollingStopped: boolean;
}
