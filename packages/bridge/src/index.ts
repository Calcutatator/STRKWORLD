/**
 * @strkworld/bridge — cross-chain value in and out, via NEAR Intents.
 *
 * PUBLIC BY NATURE. A bridge-in lands a public ERC-20 on Starknet with a
 * visible amount and recipient; shielding is a separate, later step at the
 * Bank. Never imply this building provides privacy — see README.md.
 *
 * Implementation is largely a port of shieldup's src/bridge/ orchestration.
 * See README.md for the module-by-module reuse table.
 */

export type { BridgeDirection, BridgeLeg, BridgeQuote, BridgeStatus, DepositMode } from './types.js';
