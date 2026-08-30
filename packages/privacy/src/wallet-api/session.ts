import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-wallet-standard/features';
import { WalletAccountV6, walletV6 } from 'starknet';
import type { PreparedBatch, PrivacyOperations } from '../operations.js';
import { PrivacyError, type Address } from '../types.js';
import { BackendPrivacyClient } from './backend-client.js';
import { createSupportedVersionsReader, createWalletDiscovery } from './discovery.js';
import { mapWalletError } from './errors.js';
import { WalletApiPrivacyOperations } from './operations.js';
import type { WalletRoutePolicy } from './types.js';

const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export interface WalletHandle {
  readonly name: string;
  readonly icon: string;
}

export interface WalletChoice {
  readonly key: string;
  readonly name: string;
  readonly icon: string;
}

export interface WalletDiscoveryPort {
  getWallets(): readonly WalletHandle[];
  subscribe(listener: (wallets: readonly WalletHandle[]) => void): () => void;
  refresh(): void;
}

export interface WalletConnectionSnapshot {
  readonly account: Address;
  readonly chainId: string;
}

export interface WalletConnectionPort {
  getSnapshot(): WalletConnectionSnapshot;
  createOperations(policy: WalletRoutePolicy): PrivacyOperations;
  subscribe(listener: () => void): () => void;
  disconnect(): Promise<void>;
  destroy(): void;
}

export interface WalletSessionOptions {
  readonly rpcUrl: string;
  readonly backendBaseUrl: string;
  readonly policy: WalletRoutePolicy;
  readonly expectedChainId?: string;
}

export interface WalletSessionDependencies {
  readonly discovery: WalletDiscoveryPort;
  readonly connectWallet: (wallet: WalletHandle) => Promise<WalletConnectionPort>;
}

export type WalletSessionPhase =
  | 'selection-required'
  | 'connecting'
  | 'connected'
  | 'wrong-network'
  | 'failed';

export interface WalletSessionSnapshot {
  readonly phase: WalletSessionPhase;
  readonly wallets: readonly WalletChoice[];
  readonly selectedKey: string | null;
  readonly account: Address | null;
  readonly generation: number;
}

export interface WalletSession {
  readonly operations: PrivacyOperations;
  getSnapshot(): WalletSessionSnapshot;
  subscribe(listener: () => void): () => void;
  connect(key: string): Promise<WalletSessionSnapshot>;
  refreshDiscovery(): void;
  readAccount(): Address | null;
  disconnect(): Promise<void>;
  destroy(): void;
}

export function createWalletSession(
  options: WalletSessionOptions,
  dependencies: WalletSessionDependencies,
): WalletSession {
  const expectedChainId = options.expectedChainId ?? MAINNET_CHAIN_ID;
  assertChainId(expectedChainId);
  const policy = ownPolicy(options.policy);
  const listeners = new Map<() => void, symbol>();
  const keys = new WeakMap<object, string>();
  let nextKey = 0;
  const initialWallets = dependencies.discovery.getWallets();
  let wallets = ownDiscoveredWallets(initialWallets);
  let generation = 0;
  let selectedKey: string | null = null;
  let connection: WalletConnectionPort | null = null;
  let operations: PrivacyOperations | null = null;
  let connectionCleanup: (() => void) | null = null;
  const retiredConnections = new WeakSet<object>();
  let connectFlight: { key: string; promise: Promise<WalletSessionSnapshot> } | null = null;
  let destroyed = false;
  let snapshot = buildSnapshot('selection-required', null);

  function keyFor(wallet: WalletHandle): string {
    const object = wallet as object;
    const existing = keys.get(object);
    if (existing) return existing;
    const key = `wallet-${++nextKey}`;
    keys.set(object, key);
    return key;
  }

  function choices(): readonly WalletChoice[] {
    return Object.freeze(wallets.map((wallet) => Object.freeze({
      key: keyFor(wallet),
      name: wallet.name,
      icon: wallet.icon,
    })));
  }

  function buildSnapshot(
    phase: WalletSessionPhase,
    account: Address | null,
  ): WalletSessionSnapshot {
    return Object.freeze({
      phase,
      wallets: choices(),
      selectedKey,
      account,
      generation,
    });
  }

  function publish(phase: WalletSessionPhase, account: Address | null): void {
    snapshot = buildSnapshot(phase, account);
    for (const [listener, token] of [...listeners]) {
      if (listeners.get(listener) !== token) continue;
      try {
        listener();
      } catch (error) {
        console.error('wallet session: subscriber threw', error);
      }
    }
  }

  function currentOperations(): PrivacyOperations {
    if (!operations) {
      throw new PrivacyError('user-rejected', 'Connect a supported mainnet wallet first.');
    }
    return operations;
  }

  function currentOwner(): { generation: number; operations: PrivacyOperations } {
    return { generation, operations: currentOperations() };
  }

  function isCurrent(owner: { generation: number; operations: PrivacyOperations }): boolean {
    return owner.generation === generation && owner.operations === operations;
  }

  function changedSessionError(): PrivacyError {
    return new PrivacyError('user-rejected', 'The connected wallet account changed. Review again.');
  }

  async function ownedResult<T>(
    run: (owned: PrivacyOperations) => Promise<T>,
  ): Promise<T> {
    const owner = currentOwner();
    let result: T;
    try {
      result = await run(owner.operations);
    } catch (error) {
      if (!isCurrent(owner)) throw changedSessionError();
      throw error;
    }
    if (!isCurrent(owner)) throw changedSessionError();
    return result;
  }

  const stableOperations: PrivacyOperations = {
    capability: (signal) => ownedResult((owned) => owned.capability(signal)),
    poolConfig: (signal) => ownedResult((owned) => owned.poolConfig(signal)),
    balances: (tokens, signal) => ownedResult((owned) => owned.balances(tokens, signal)),
    recipientStatus: (address, signal) => ownedResult((owned) => owned.recipientStatus(address, signal)),
    async prepare(intents, signal) {
      const owner = currentOwner();
      let prepared: PreparedBatch;
      try {
        prepared = await owner.operations.prepare(intents, signal);
      } catch (error) {
        if (!isCurrent(owner)) throw changedSessionError();
        throw error;
      }
      if (!isCurrent(owner)) {
        try {
          prepared.discard();
        } catch {
          // Automatic stale cleanup cannot mask the changed-session result.
        }
        throw changedSessionError();
      }
      return ownPreparedBatch(prepared, () => isCurrent(owner), changedSessionError);
    },
  };

  function destroyConnection(owned: WalletConnectionPort, suppressErrors: boolean): void {
    if (retiredConnections.has(owned)) return;
    retiredConnections.add(owned);
    try {
      owned.destroy();
    } catch (error) {
      if (!suppressErrors) throw error;
    }
  }

  function retireConnectionBestEffort(): void {
    operations = null;
    const cleanup = connectionCleanup;
    const owned = connection;
    connectionCleanup = null;
    connection = null;
    try {
      cleanup?.();
    } catch {
      // Automatic cleanup cannot mask the transition that retired it.
    }
    if (owned) destroyConnection(owned, true);
  }

  function retireConnectionExplicit(): void {
    operations = null;
    const cleanup = connectionCleanup;
    const owned = connection;
    connectionCleanup = null;
    connection = null;
    let firstError: unknown;
    let hasError = false;
    try {
      cleanup?.();
    } catch (error) {
      firstError = error;
      hasError = true;
    }
    if (owned) {
      try {
        destroyConnection(owned, false);
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }
    if (hasError) throw firstError;
  }

  function selectedWallet(): WalletHandle | null {
    return wallets.find((wallet) => keyFor(wallet) === selectedKey) ?? null;
  }

  const discoveryCleanup = dependencies.discovery.subscribe((nextWallets) => {
    if (destroyed) return;
    if (!Array.isArray(nextWallets)) {
      wallets = [];
      generation += 1;
      connectFlight = null;
      selectedKey = null;
      retireConnectionBestEffort();
      publish('selection-required', null);
      return;
    }
    wallets = ownDiscoveredWallets(nextWallets);
    if (selectedKey && !selectedWallet()) {
      generation += 1;
      connectFlight = null;
      selectedKey = null;
      retireConnectionBestEffort();
      publish('selection-required', null);
      return;
    }
    publish(snapshot.phase, snapshot.account);
  });

  return {
    operations: stableOperations,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      const token = Symbol();
      listeners.set(listener, token);
      return () => {
        if (listeners.get(listener) === token) listeners.delete(listener);
      };
    },
    connect(key) {
      if (connectFlight?.key === key) return connectFlight.promise;
      const promise = connectOwned(key);
      connectFlight = { key, promise };
      void promise.finally(() => {
        if (connectFlight?.promise === promise) connectFlight = null;
      }).catch(() => undefined);
      return promise;
    },
    refreshDiscovery: () => dependencies.discovery.refresh(),
    readAccount: () => snapshot.account,
    async disconnect() {
      generation += 1;
      connectFlight = null;
      const owned = connection;
      let retirementError: unknown;
      let hasRetirementError = false;
      try {
        retireConnectionExplicit();
      } catch (error) {
        retirementError = error;
        hasRetirementError = true;
      }
      selectedKey = null;
      publish('selection-required', null);
      if (hasRetirementError) throw retirementError;
      await owned?.disconnect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      connectFlight = null;
      let teardownError: unknown;
      let hasTeardownError = false;
      try {
        discoveryCleanup();
      } catch (error) {
        teardownError = error;
        hasTeardownError = true;
      }
      try {
        retireConnectionExplicit();
      } catch (error) {
        if (!hasTeardownError) {
          teardownError = error;
          hasTeardownError = true;
        }
      }
      selectedKey = null;
      publish('selection-required', null);
      listeners.clear();
      if (hasTeardownError) throw teardownError;
    },
  };

  async function connectOwned(key: string): Promise<WalletSessionSnapshot> {
      if (destroyed) throw new PrivacyError('unknown', 'The wallet session has ended.');
      const wallet = wallets.find((candidate) => keyFor(candidate) === key);
      if (!wallet) throw new PrivacyError('unreachable', 'The selected wallet is no longer available.');

      const attempt = ++generation;
      selectedKey = key;
      retireConnectionBestEffort();
      publish('connecting', null);
      let attemptedConnection: WalletConnectionPort | null = null;
      try {
        const connected = await dependencies.connectWallet(wallet);
        attemptedConnection = connected;
        if (destroyed || attempt !== generation) {
          destroyConnection(connected, true);
          return snapshot;
        }
        const next = readConnectionSnapshot(connected.getSnapshot());
        assertAddress(next.account);
        connection = connected;
        const cleanup = connected.subscribe(() => {
          if (destroyed || connection !== connected) return;
          let changed: WalletConnectionSnapshot;
          try {
            changed = readConnectionSnapshot(connected.getSnapshot());
          } catch {
            generation += 1;
            operations = null;
            publish('failed', null);
            return;
          }
          if (changed.account) {
            try {
              assertAddress(changed.account);
            } catch {
              generation += 1;
              operations = null;
              publish('failed', null);
              return;
            }
          }
          if (
            operations &&
            snapshot.phase === 'connected' &&
            snapshot.account &&
            sameFelt(changed.account, snapshot.account) &&
            sameFelt(changed.chainId, expectedChainId)
          ) {
            return;
          }
          generation += 1;
          operations = null;
          if (!changed.account) {
            selectedKey = null;
            retireConnectionBestEffort();
            publish('selection-required', null);
            return;
          }
          try {
            if (!sameFelt(changed.chainId, expectedChainId)) {
              publish('wrong-network', null);
              return;
            }
            operations = connected.createOperations(policy);
            publish('connected', changed.account);
          } catch {
            operations = null;
            publish('failed', null);
          }
        });
        // A WalletConnectionPort may replay an account/chain change while
        // subscribe() is registering the listener. In that case the
        // callback above has already advanced this session's authority and
        // built the replacement state (or retired it); the continuation
        // must not publish the stale pre-subscribe snapshot.
        if (connection === connected) connectionCleanup = cleanup;
        if (destroyed || attempt !== generation || connection !== connected) {
          return snapshot;
        }
        const current = readConnectionSnapshot(connected.getSnapshot());
        assertAddress(current.account);
        if (!sameFelt(current.chainId, expectedChainId)) {
          publish('wrong-network', null);
          return snapshot;
        }
        operations = connected.createOperations(policy);
        publish('connected', current.account);
        return snapshot;
      } catch (error) {
        if (attemptedConnection && attemptedConnection !== connection) {
          destroyConnection(attemptedConnection, true);
        }
        if (attempt === generation) {
          retireConnectionBestEffort();
          publish('failed', null);
        }
        throw mapWalletError(error);
      }
  }
}

/** Build the real browser session without exposing wallet libraries to Web. */
export function createProductionWalletSession(
  options: WalletSessionOptions,
  injectedDiscovery?: WalletDiscoveryPort,
): WalletSession {
  const discovery = injectedDiscovery ?? productionDiscovery();
  const backend = new BackendPrivacyClient(options.backendBaseUrl);
  return createWalletSession(options, {
    discovery,
    async connectWallet(handle) {
      const wallet = handle as WalletWithStarknetFeatures;
      // The exact direct pins still install two structurally equivalent v6
      // wallet-standard copies. Keep that packaging mismatch at this boundary.
      const connected = await WalletAccountV6.connect(
        { nodeUrl: options.rpcUrl },
        wallet as Parameters<typeof WalletAccountV6.connect>[1],
      );
      let current: WalletConnectionSnapshot = {
        account: connected.address,
        chainId: '',
      };
      const portListeners = new Set<() => void>();
      connected.onChange((change) => {
        if (change.accounts === undefined) return;
        const account = change.accounts[0];
        current = {
          account: account?.address ?? '',
          chainId: chainIdOf(account?.chains[0]) ?? current.chainId,
        };
        portListeners.forEach((listener) => listener());
      });
      try {
        const requestedChainId = await walletV6.requestChainId(
          wallet as Parameters<typeof walletV6.requestChainId>[0],
        );
        if (!current.chainId) current = { ...current, chainId: requestedChainId };
      } catch (error) {
        connected.unsubscribeChange();
        throw error;
      }
      return {
        getSnapshot: () => current,
        createOperations: (policy) => new WalletApiPrivacyOperations({
          wallet: connected,
          pool: backend,
          submission: backend,
          supportedVersions: createSupportedVersionsReader(wallet),
          policy,
        }),
        subscribe(listener) {
          portListeners.add(listener);
          return () => portListeners.delete(listener);
        },
        async disconnect() {
          await wallet.features['standard:disconnect'].disconnect();
        },
        destroy() {
          portListeners.clear();
          connected.unsubscribeChange();
        },
      };
    },
  });
}

function ownDiscoveredWallets(value: unknown): WalletHandle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<object>();
  return value.filter((wallet): wallet is WalletHandle => {
    if ((typeof wallet !== 'object' && typeof wallet !== 'function') || wallet === null) return false;
    const name = Object.getOwnPropertyDescriptor(wallet, 'name');
    const icon = Object.getOwnPropertyDescriptor(wallet, 'icon');
    if (
      !name || !('value' in name) || typeof name.value !== 'string'
      || !icon || !('value' in icon) || typeof icon.value !== 'string'
    ) return false;
    if (seen.has(wallet)) return false;
    seen.add(wallet);
    return true;
  });
}

function productionDiscovery(): WalletDiscoveryPort {
  const store = createWalletDiscovery();
  return {
    getWallets: () => store.getWallets(),
    subscribe: (listener) => store.subscribe(listener),
    refresh: () => store._refreshInjectedWallets(),
  };
}

function chainIdOf(chain: string | undefined): string | null {
  return chain?.startsWith('starknet:') ? chain.slice('starknet:'.length) : null;
}

function ownPolicy(policy: WalletRoutePolicy): WalletRoutePolicy {
  if (!hasOwnDataProperties(policy, ['maxIntents', 'maxRelayFee', 'enabledRoutes', 'allowedTokens'])) {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
  const allowedTokens = Object.getOwnPropertyDescriptor(policy, 'allowedTokens')!.value;
  if (!hasOwnDataProperties(allowedTokens, ['shield', 'unshield', 'transfer', 'swap'])) {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
  const swapDescriptor = Object.getOwnPropertyDescriptor(policy, 'swap');
  if (swapDescriptor && !('value' in swapDescriptor)) {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
  const swap = swapDescriptor?.value;
  if (swap !== undefined && !hasOwnDataProperties(swap, ['expectedChainId', 'slippageBps'])) {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
  return Object.freeze({
    maxIntents: policy.maxIntents,
    maxRelayFee: policy.maxRelayFee,
    enabledRoutes: Object.freeze([...policy.enabledRoutes]),
    allowedTokens: Object.freeze({
      shield: Object.freeze([...allowedTokens.shield]),
      unshield: Object.freeze([...allowedTokens.unshield]),
      transfer: Object.freeze([...allowedTokens.transfer]),
      swap: Object.freeze([...allowedTokens.swap]),
    }),
    ...(swap
      ? { swap: Object.freeze({
          expectedChainId: swap.expectedChainId,
          slippageBps: swap.slippageBps,
        }) }
      : {}),
  });
}

function ownPreparedBatch(
  prepared: PreparedBatch,
  isCurrent: () => boolean,
  changedSessionError: () => PrivacyError,
): PreparedBatch {
  const required = ['intents', 'poolFee', 'gasEstimate', 'totalCost', 'warnings', 'promptCount', 'confirm', 'discard'] as const;
  if (!hasOwnDataProperties(prepared, required)) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared batch.');
  }
  const swapReviewDescriptor = Object.getOwnPropertyDescriptor(prepared, 'swapReview');
  if (swapReviewDescriptor && !('value' in swapReviewDescriptor)) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared batch.');
  }
  const swapReview = swapReviewDescriptor?.value === undefined
    ? undefined
    : ownSwapReview(swapReviewDescriptor.value, prepared);
  if (
    typeof prepared.poolFee !== 'bigint'
    || prepared.poolFee < 0n
    || typeof prepared.gasEstimate !== 'bigint'
    || prepared.gasEstimate < 0n
    || typeof prepared.totalCost !== 'bigint'
    || prepared.totalCost !== prepared.poolFee + prepared.gasEstimate
  ) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned invalid prepared costs.');
  }
  if (!Number.isSafeInteger(prepared.promptCount) || prepared.promptCount < 0) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared prompt count.');
  }
  if (!denseDataArray(prepared.intents) || !denseDataArray(prepared.warnings)) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned invalid prepared review collections.');
  }
  if (!prepared.warnings.every(validWarning)) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared warning.');
  }
  const intents = Object.freeze(prepared.intents.map((intent) => Object.freeze({ ...intent })));
  const warnings = Object.freeze(prepared.warnings.map((warning) => Object.freeze({ ...warning })));
  let discarded = false;
  let confirmationAttempted = false;
  const discard = (): void => {
    if (discarded) return;
    discarded = true;
    prepared.discard();
  };
  const retire = (): void => {
    try {
      discard();
    } catch {
      // Automatic cleanup cannot replace the authoritative settlement result.
    }
  };
  return Object.freeze({
    intents,
    poolFee: prepared.poolFee,
    gasEstimate: prepared.gasEstimate,
    totalCost: prepared.totalCost,
    warnings,
    promptCount: prepared.promptCount,
    ...(swapReview ? { swapReview } : {}),
    async confirm(options: Parameters<PreparedBatch['confirm']>[0]) {
      if (!hasOwnDataProperties(options, ['feeCeiling'])) {
        throw new PrivacyError('unknown', 'The confirmation options are invalid.');
      }
      for (const optional of ['onProgress', 'signal'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(options, optional);
        if (descriptor && !('value' in descriptor)) {
          throw new PrivacyError('unknown', 'The confirmation options are invalid.');
        }
      }
      const ownedOptions = {
        feeCeiling: options.feeCeiling,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (discarded) {
        throw new PrivacyError('unknown', 'This prepared batch was discarded. Prepare a new batch.');
      }
      if (confirmationAttempted) {
        throw new PrivacyError('unknown', 'This prepared batch was already confirmed or attempted. Prepare a new batch.');
      }
      if (!isCurrent()) {
        retire();
        throw changedSessionError();
      }
      confirmationAttempted = true;
      let result: Awaited<ReturnType<PreparedBatch['confirm']>>;
      try {
        result = await prepared.confirm(ownedOptions);
      } catch (error) {
        if (!isCurrent()) {
          retire();
          // A lost post-submit response remains non-retryable even when the
          // wallet account changes while the uncertainty is settling.
          if (error instanceof PrivacyError && error.kind === 'submission-uncertain') {
            throw error;
          }
          throw changedSessionError();
        }
        throw error;
      }
      if (!isCurrent()) {
        retire();
        throw changedSessionError();
      }
      if (
        !hasOwnDataProperties(result, ['transactionHash'])
        || typeof result.transactionHash !== 'string'
        || !isNonzeroFelt(result.transactionHash)
      ) {
        retire();
        throw new PrivacyError('unknown', 'The wallet returned an invalid transaction receipt.');
      }
      return Object.freeze({ transactionHash: result.transactionHash });
    },
    discard,
  });
}

function isNonzeroFelt(value: string): boolean {
  try {
    return /^0x[0-9a-f]+$/i.test(value)
      && BigInt(value) > 0n
      && BigInt(value) < STARK_FIELD_PRIME;
  } catch {
    return false;
  }
}

function validWarning(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind || !('value' in kind) || typeof kind.value !== 'string') return false;
  switch (kind.value) {
    case 'multiple-prompts': {
      const count = Object.getOwnPropertyDescriptor(value, 'count');
      return Boolean(count && 'value' in count && Number.isSafeInteger(count.value) && count.value > 1);
    }
    case 'funds-maturing': {
      const amount = Object.getOwnPropertyDescriptor(value, 'maturingAmount');
      const blocks = Object.getOwnPropertyDescriptor(value, 'blocksRemaining');
      return Boolean(
        amount && 'value' in amount && typeof amount.value === 'bigint' && amount.value > 0n
        && blocks && 'value' in blocks && Number.isSafeInteger(blocks.value) && blocks.value >= 0
      );
    }
    case 'leaves-below-fee': {
      const remaining = Object.getOwnPropertyDescriptor(value, 'remaining');
      const estimate = Object.getOwnPropertyDescriptor(value, 'feeEstimate');
      return Boolean(
        remaining && 'value' in remaining && typeof remaining.value === 'bigint' && remaining.value >= 0n
        && estimate && 'value' in estimate && typeof estimate.value === 'bigint' && estimate.value > 0n
        && remaining.value < estimate.value
      );
    }
    case 'public-leg': {
      const detail = Object.getOwnPropertyDescriptor(value, 'detail');
      return Boolean(
        detail && 'value' in detail
        && typeof detail.value === 'string'
        && detail.value.trim().length > 0
      );
    }
    case 'recipient-unregistered': {
      const recipient = Object.getOwnPropertyDescriptor(value, 'recipient');
      return Boolean(
        recipient && 'value' in recipient
        && typeof recipient.value === 'string'
        && isNonzeroFelt(recipient.value)
      );
    }
    default:
      return true;
  }
}

function ownSwapReview(value: unknown, prepared: PreparedBatch): NonNullable<PreparedBatch['swapReview']> {
  if (!hasOwnDataProperties(value, ['expectedAmountOut', 'minimumAmountOut', 'slippageBps', 'expiresAt'])) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared swap review.');
  }
  const review = value as NonNullable<PreparedBatch['swapReview']>;
  if (
    typeof review.expectedAmountOut !== 'bigint'
    || review.expectedAmountOut <= 0n
    || typeof review.minimumAmountOut !== 'bigint'
    || review.minimumAmountOut <= 0n
    || review.minimumAmountOut > review.expectedAmountOut
    || !Number.isSafeInteger(review.slippageBps)
    || review.slippageBps <= 0
    || !Number.isSafeInteger(review.expiresAt)
    || review.expiresAt <= 0
  ) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared swap review.');
  }
  return Object.freeze({ ...review });
}

function denseDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return false;
  }
  return true;
}

function retireInvalidPrepared(prepared: PreparedBatch): void {
  const descriptor = Object.getOwnPropertyDescriptor(prepared, 'discard');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return;
  try {
    descriptor.value.call(prepared);
  } catch {
    // Malformed work must not escape solely because best-effort retirement fails.
  }
}

function assertAddress(address: string): void {
  try {
    const value = BigInt(address);
    if (!/^0x[0-9a-f]+$/i.test(address) || value === 0n || value >= STARK_FIELD_PRIME) {
      throw new Error();
    }
  } catch {
    throw new PrivacyError('unknown', 'The wallet returned an invalid account.');
  }
}

function assertChainId(chainId: string): void {
  try {
    const value = BigInt(chainId);
    if (!/^0x[0-9a-f]+$/i.test(chainId) || value === 0n || value >= STARK_FIELD_PRIME) {
      throw new Error();
    }
  } catch {
    throw new PrivacyError('unknown', 'The configured wallet chain is invalid.');
  }
}

function sameFelt(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

function readConnectionSnapshot(value: unknown): WalletConnectionSnapshot {
  if (!hasOwnDataProperties(value, ['account', 'chainId'])) {
    throw new PrivacyError('unknown', 'The wallet returned an invalid connection snapshot.');
  }
  const { account, chainId } = value as WalletConnectionSnapshot;
  if (typeof account !== 'string' || typeof chainId !== 'string') {
    throw new PrivacyError('unknown', 'The wallet returned an invalid connection snapshot.');
  }
  return { account, chainId };
}

function hasOwnDataProperties(value: unknown, keys: readonly PropertyKey[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor);
  });
}
