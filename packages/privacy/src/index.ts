/**
 * @strkworld/privacy — the financial seam.
 *
 * The only package that talks to Starknet. See README.md for the boundary
 * rules before changing anything here.
 */

export type {
  Address,
  OperationProgress,
  OperationStage,
  PrivacyErrorKind,
  PrivateBalance,
  PrivateSwapInput,
  ProgressCallback,
  RecipientStatus,
  TxResult,
} from './types.js';

export { PrivacyError } from './types.js';

export type {
  PoolConfig,
  PrivacyOperations,
  WalletCapability,
} from './operations.js';

// Implementation lands in Phase 2. See docs/SPEC.md §8.
// export { WalletApiPrivacyOperations } from './wallet-api/index.js'
