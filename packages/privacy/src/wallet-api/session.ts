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
  const policy = ownPolicy(options.policy);
  const listeners = new Map<() => void, symbol>();
  const keys = new WeakMap<object, string>();
  let nextKey = 0;
  let wallets = [...dependencies.discovery.getWallets()];
  let generation = 0;
  let selectedKey: string | null = null;
  let connection: WalletConnectionPort | null = null;
  let operations: PrivacyOperations | null = null;
  let connectionCleanup: (() => void) | null = null;
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

  function retireConnection(): void {
    operations = null;
    connectionCleanup?.();
    connectionCleanup = null;
    connection?.destroy();
    connection = null;
  }

  function selectedWallet(): WalletHandle | null {
    return wallets.find((wallet) => keyFor(wallet) === selectedKey) ?? null;
  }

  const discoveryCleanup = dependencies.discovery.subscribe((nextWallets) => {
    if (destroyed) return;
    wallets = [...nextWallets];
    if (selectedKey && !selectedWallet()) {
      generation += 1;
      connectFlight = null;
      selectedKey = null;
      retireConnection();
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
      retireConnection();
      selectedKey = null;
      publish('selection-required', null);
      await owned?.disconnect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      connectFlight = null;
      discoveryCleanup();
      retireConnection();
      selectedKey = null;
      publish('selection-required', null);
      listeners.clear();
    },
  };

  async function connectOwned(key: string): Promise<WalletSessionSnapshot> {
      if (destroyed) throw new PrivacyError('unknown', 'The wallet session has ended.');
      const wallet = wallets.find((candidate) => keyFor(candidate) === key);
      if (!wallet) throw new PrivacyError('unreachable', 'The selected wallet is no longer available.');

      const attempt = ++generation;
      selectedKey = key;
      retireConnection();
      publish('connecting', null);
      let attemptedConnection: WalletConnectionPort | null = null;
      try {
        const connected = await dependencies.connectWallet(wallet);
        attemptedConnection = connected;
        if (destroyed || attempt !== generation) {
          connected.destroy();
          return snapshot;
        }
        const next = connected.getSnapshot();
        assertAddress(next.account);
        connection = connected;
        connectionCleanup = connected.subscribe(() => {
          if (destroyed || connection !== connected) return;
          let changed: WalletConnectionSnapshot;
          try {
            changed = connected.getSnapshot();
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
            retireConnection();
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
        if (destroyed || attempt !== generation || connection !== connected) {
          if (connection !== connected) connected.destroy();
          return snapshot;
        }
        const current = connected.getSnapshot();
        assertAddress(current.account);
        if (!sameFelt(current.chainId, expectedChainId)) {
          publish('wrong-network', null);
          return snapshot;
        }
        operations = connected.createOperations(policy);
        publish('connected', current.account);
        return snapshot;
      } catch (error) {
        if (attemptedConnection && attemptedConnection !== connection) attemptedConnection.destroy();
        if (attempt === generation) {
          retireConnection();
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
  return Object.freeze({
    maxIntents: policy.maxIntents,
    maxRelayFee: policy.maxRelayFee,
    enabledRoutes: Object.freeze([...policy.enabledRoutes]),
    allowedTokens: Object.freeze({
      shield: Object.freeze([...policy.allowedTokens.shield]),
      unshield: Object.freeze([...policy.allowedTokens.unshield]),
      transfer: Object.freeze([...policy.allowedTokens.transfer]),
      swap: Object.freeze([...policy.allowedTokens.swap]),
    }),
    ...(policy.swap
      ? { swap: Object.freeze({
          expectedChainId: policy.swap.expectedChainId,
          slippageBps: policy.swap.slippageBps,
        }) }
      : {}),
  });
}

function ownPreparedBatch(
  prepared: PreparedBatch,
  isCurrent: () => boolean,
  changedSessionError: () => PrivacyError,
): PreparedBatch {
  let discarded = false;
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
    intents: prepared.intents,
    poolFee: prepared.poolFee,
    gasEstimate: prepared.gasEstimate,
    totalCost: prepared.totalCost,
    warnings: prepared.warnings,
    promptCount: prepared.promptCount,
    ...(prepared.swapReview ? { swapReview: prepared.swapReview } : {}),
    async confirm(options: Parameters<PreparedBatch['confirm']>[0]) {
      if (!isCurrent()) {
        retire();
        throw changedSessionError();
      }
      let result: Awaited<ReturnType<PreparedBatch['confirm']>>;
      try {
        result = await prepared.confirm(options);
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
      return result;
    },
    discard,
  });
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

function sameFelt(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}
