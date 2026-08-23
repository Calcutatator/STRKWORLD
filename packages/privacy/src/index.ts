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
  SwapReview,
  WalletCapability,
} from './operations.js';

// Test double. Safe to import from any lane — no network, no wallet, no chain.
export { FakePrivacyOperations, type FakeConfig, type Fault } from './testing/fake.js';
export { FakePublicShieldPlanner, type FakePublicShieldPlannerConfig } from './testing/public-shield.js';

export {
  WalletApiPrivacyOperations,
  BackendPrivacyClient,
  createSupportedVersionsReader,
  createWalletDiscovery,
  createProductionWalletSession,
  createWalletSession,
  mapWalletError,
  type PoolNativeRoute,
  type PrivateRoute,
  type PoolReadClient,
  type PublicShieldPlan,
  type PublicShieldPlanInput,
  type PublicShieldPlanner,
  type PrivateSubmissionGateway,
  type PreparedPrivateSwap,
  type RelayFeeQuote,
  type SupportedVersionsReader,
  type WalletApiPrivacyOperationsOptions,
  type WalletRoutePolicy,
  type WalletChoice,
  type WalletConnectionPort,
  type WalletConnectionSnapshot,
  type WalletDiscoveryPort,
  type WalletHandle,
  type WalletSession,
  type WalletSessionDependencies,
  type WalletSessionOptions,
  type WalletSessionPhase,
  type WalletSessionSnapshot,
  type WalletStrk20Account,
} from './wallet-api/index.js';
