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
  DepositStatus,
  Intent,
  PoolConfig,
  PreparedBatch,
  PreparedVaultBatch,
  PrivacyOperations,
  SwapReview,
  VaultAction,
  VaultCallOptions,
  VaultOutcome,
  VaultPosition,
  VaultPositions,
  VaultRate,
  VaultStage,
  VaultStageCallback,
  VaultTxResult,
  WalletCapability,
} from './operations.js';

// D-072: the pool and its Deposit event, which `depositStatus` reads from a receipt.
export { POOL_DEPOSIT_EVENT, STRK20_POOL } from './pool.js';

// Endur private staking (D-063): the pinned mainnet contracts the stake route admits.
export {
  ENDUR_DEPOSIT_ANONYMIZER,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  ENDUR_XSTRK_DECIMALS,
} from './endur.js';

// The Vault on shadow accounts (D-077): the pinned anonymizer and dapp name,
// and the token -> vault map it lends through (D-079).
export {
  SHADOW_ACCOUNT_ANONYMIZER,
  SHADOW_ACCOUNT_PRIMER_CLASS_HASH,
  SHADOW_ACCOUNTS_WALLET_API,
  VAULT_DAPP_NAME,
  VAULT_MARKETS,
  VAULT_SHADOW_NONCE,
  VESU_PRIME_POOL,
  VESU_VSTRK,
  VESU_VSTRK_ASSET,
  VESU_VSTRK_DECIMALS,
  VESU_VTOKEN_CLASS_HASH,
  vaultMarket,
  type VaultMarket,
} from './vault.js';

// Test double. Safe to import from any lane — no network, no wallet, no chain.
export {
  DEMO_VAULT_STAND_IN,
  FakePrivacyOperations,
  type FakeConfig,
  type FakeDemoSwapRates,
  type Fault,
} from './testing/fake.js';
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
  type VaultPositionRow,
  type VaultRateRow,
  type VaultReadClient,
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
