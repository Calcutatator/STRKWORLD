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
  BridgeRecord,
  BridgeStatus,
  DepositMode,
  SourceAsset,
  SourceChain,
} from './types.js';

export { validateSourceAddress, validateStarknetAddress } from './address-validation.js';
export { OneClickSdkClient, type OneClickClient } from './client.js';
export {
  LocalBridgeStore,
  MAX_RESUME_RECORD_BYTES,
  MemoryBridgeStore,
  deserializeBridgeRecord,
  serializeBridgeRecord,
  type BridgeStore,
} from './persistence.js';
export { loadSourceAssets, STRK_ON_STARKNET_ASSET_ID } from './source-assets.js';
export {
  BridgeService,
  DEFAULT_SLIPPAGE_BPS,
  MANUAL_POLL_INTERVAL_MS,
  MAX_ACTIVE_POLLING_MS,
  QUOTE_DEADLINE_MS,
  type CreateDepositInput,
  type CreateManualDepositInput,
  type WatchDepositOptions,
} from './service.js';
