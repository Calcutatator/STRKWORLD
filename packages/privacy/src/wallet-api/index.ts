export { createSupportedVersionsReader, createWalletDiscovery } from './discovery.js';
export { BackendPrivacyClient } from './backend-client.js';
export { mapWalletError } from './errors.js';
export {
  WalletApiPrivacyOperations,
  type WalletApiPrivacyOperationsOptions,
} from './operations.js';
export {
  createProductionWalletSession,
  createWalletSession,
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
} from './session.js';
export type {
  PoolNativeRoute,
  PrivateRoute,
  PoolReadClient,
  PublicShieldPlan,
  PublicShieldPlanInput,
  PublicShieldPlanner,
  PrivateSubmissionGateway,
  PreparedPrivateSwap,
  RelayFeeQuote,
  SupportedVersionsReader,
  WalletRoutePolicy,
  WalletStrk20Account,
} from './types.js';
