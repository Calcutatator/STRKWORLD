/**
 * @strkworld/bridge — one path in: any chain → STRK → the STRK20 pool.
 *
 * PUBLIC ARRIVAL. The solver delivers STRK to the player's address with a
 * visible amount and recipient, and the shield that follows is a separate
 * signed transaction with its own public leg. Privacy begins after the funds
 * are in the pool, not on the way in. Never imply otherwise — see README.md.
 *
 * The shell sequences bridge → shield. This package never imports
 * @strkworld/privacy, and CI enforces that.
 */

export type {
  BridgeLeg,
  BridgeQuote,
  BridgeStatus,
  DepositMode,
  SourceAsset,
} from './types.js';
