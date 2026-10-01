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
  BorrowAction,
  BorrowAsset,
  BorrowHealth,
  BorrowMarket,
  BorrowPair,
  BorrowPosition,
  BorrowPositions,
  BorrowRequest,
  DepositStatus,
  EndurAction,
  EndurRate,
  EndurUnstakePosition,
  EndurWithdrawalRequest,
  Intent,
  PoolConfig,
  PreparedBatch,
  PreparedBorrowBatch,
  PreparedEndurBatch,
  PreparedVaultBatch,
  PrivacyOperations,
  SwapPriceCheck,
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

// Endur private staking (D-063): the pinned mainnet contracts the stake route
// admits; and unstaking through a shadow account (D-085).
export {
  ENDUR_DAPP_NAME,
  ENDUR_DEPOSIT_ANONYMIZER,
  ENDUR_OBSERVED_CLAIM_DELAY_SECONDS,
  ENDUR_SHADOW_NONCE,
  ENDUR_WITHDRAWAL_QUEUE,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  ENDUR_XSTRK_DECIMALS,
  MAX_ENDUR_CLAIMS_PER_BATCH,
} from './endur.js';

// The Vault on shadow accounts (D-077): the pinned anonymizer and dapp name,
// and the token -> vault map it lends through (D-079), across Vesu's Prime
// and curated pools (D-081).
export {
  MAX_VAULT_MARKETS,
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
  type VaultPoolCuration,
} from './vault.js';

// Borrowing on Vesu from a second shadow account (D-083): the pinned pool,
// tokens and pairs, the dapp name, Vesu's arithmetic and the action builders.
export {
  BORROW_DAPP_NAME,
  BORROW_MIN_HEALTH_AFTER,
  BORROW_REVIEW_TTL_MS,
  BORROW_PAIRS,
  BORROW_POOL,
  BORROW_REPAY_ALL_BUFFER_BPS,
  BORROW_REPAY_ALL_BUFFER_UNITS,
  BORROW_SHADOW_NONCE,
  BORROW_TOKENS,
  BORROW_TOKEN_INFO,
  BORROW_WARNING_HEALTH,
  BorrowRefusedError,
  VESU_SCALE,
  assessBorrow,
  borrowHealth,
  borrowPairOffered,
  type AssessedBorrow,
  type BorrowPairKey,
  type BorrowRefusal,
  type BorrowTokenInfo,
} from './borrow.js';

// The private swap on a shadow account (D-084): the pinned exchange, entry
// point and dapp name, and the quote lifetime.
export {
  AVNU_EXCHANGE,
  AVNU_SWAP_ENTRYPOINT,
  SWAP_DAPP_NAME,
  SWAP_QUOTE_TTL_MS,
  SWAP_SHADOW_NONCE,
} from './swap.js';
// D-084: the swap's independent price check against Pragma's oracle.
export { PRAGMA_ORACLE, PRICE_FEEDS, SWAP_MAX_SLIPPAGE_BPS, SWAP_PRICE_BOUND_BPS, USD_DECIMALS, type PriceFeed } from './swap-prices.js';

// Test double. Safe to import from any lane — no network, no wallet, no chain.
export {
  DEMO_BORROW_PRICES,
  DEMO_BORROW_STAND_IN,
  DEMO_ENDUR_STAND_IN,
  DEMO_VAULT_STAND_IN,
  FakePrivacyOperations,
  type FakeConfig,
  type FakeDemoSwapRates,
  type FakeSwapReview,
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
  type RelayFeeQuote,
  type SupportedVersionsReader,
  type EndurReadClient,
  type EndurUnstakeRead,
  type SwapQuoteAnswer,
  type SwapQuoteClient,
  type VaultPositionRow,
  type VaultRateRow,
  type VaultReadClient,
  type BorrowAssetRow,
  type BorrowMarketRead,
  type BorrowPairRow,
  type BorrowPositionRow,
  type BorrowReadClient,
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
