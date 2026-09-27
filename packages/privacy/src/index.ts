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

// Endur private staking (D-063): the pinned mainnet contracts the stake route admits.
export {
  ENDUR_DEPOSIT_ANONYMIZER,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  ENDUR_XSTRK_DECIMALS,
} from './endur.js';

// Test double. Safe to import from any lane — no network, no wallet, no chain.
export { FakePrivacyOperations, type FakeConfig, type Fault } from './testing/fake.js';
export { FakePublicShieldPlanner, type FakePublicShieldPlannerConfig } from './testing/public-shield.js';

// Production Bridge reserve planner (D-061). Composed only while shield is enabled.
export {
  ReservePublicShieldPlanner,
  RESERVE_SHIELD_FLOOR,
  RESERVE_SHIELD_GAS_ALLOWANCE,
  type ReservePublicShieldPlannerOptions,
} from './wallet-api/reserve-shield-planner.js';

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
