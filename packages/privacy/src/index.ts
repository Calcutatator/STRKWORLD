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
  ProgressCallback,
  RecipientStatus,
  TxResult,
} from './types.js';

export { PrivacyError } from './types.js';

export type {
  BatchWarning,
  Intent,
  PoolConfig,
  PreparedBatch,
  PrivacyOperations,
  WalletCapability,
} from './operations.js';

// Test double. Safe to import from any lane — no network, no wallet, no chain.
export { FakePrivacyOperations, type FakeConfig, type Fault } from './testing/fake.js';

export {
  WalletApiPrivacyOperations,
  BackendPrivacyClient,
  createSupportedVersionsReader,
  createWalletDiscovery,
  mapWalletError,
  type PoolNativeRoute,
  type PrivateRoute,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type PreparedPrivateSwap,
  type RelayFeeQuote,
  type SupportedVersionsReader,
  type WalletApiPrivacyOperationsOptions,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from './wallet-api/index.js';
