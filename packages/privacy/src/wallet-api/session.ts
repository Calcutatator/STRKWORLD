import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-wallet-standard/features';
import { WalletAccountV6, walletV6 } from 'starknet';
import type {
  BorrowAction,
  BorrowHealth,
  EndurAction,
  PreparedBatch,
  PreparedBorrowBatch,
  PreparedEndurBatch,
  PreparedVaultBatch,
  PrivacyOperations,
  VaultAction,
} from '../operations.js';
import { PrivacyError, type Address } from '../types.js';
import { BackendPrivacyClient } from './backend-client.js';
import { PragmaPriceReader } from './pragma-prices.js';
import { createSupportedVersionsReader, createWalletDiscovery } from './discovery.js';
import { mapWalletError } from './errors.js';
import { WalletApiPrivacyOperations } from './operations.js';
import type { WalletRoutePolicy } from './types.js';

const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * When a session looks for wallets again, in milliseconds after it starts
 * (D-073). The discovery store scans the page's legacy `window.starknet*`
 * globals once, as it is built, so a wallet that injects its global later
 * stayed missing until the player pressed "Look again". Four more looks in
 * the first five seconds, then none. A look only ever adds a wallet to the
 * list; it never selects or connects one (D-054).
 */
const DISCOVERY_RESCAN_DELAYS_MS: readonly number[] = [250, 1_000, 2_500, 5_000];

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
    const result: WalletChoice[] = [];
    for (const wallet of wallets) {
      try {
        const name = walletDisplayField(wallet, 'name');
        const icon = walletDisplayField(wallet, 'icon');
        if (name === null || icon === null) continue;
        result.push(Object.freeze({
          key: keyFor(wallet),
          name,
          icon,
        }));
      } catch {
        // A malformed discovery object must not escape through the snapshot.
      }
    }
    return Object.freeze(result);
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
    // D-072. A read answered for a retired account is refused like any other.
    hasPrivateFunds: (signal) => ownedResult((owned) => owned.hasPrivateFunds(signal)),
    depositStatus: (transactionHash, signal) => ownedResult((owned) => owned.depositStatus(transactionHash, signal)),
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
    // D-077: the Vault, owned like every other call. A position read for a
    // retired account is refused; a batch prepared for one never confirms.
    // D-079: positions for every admitted token, a redeem names its token,
    // and the rates read is owned the same way.
    vaultPositions: (options) => ownedResult((owned) => owned.vaultPositions(options)),
    prepareVaultSupply: (token, amount, options) => ownedVaultBatch((owned) => owned.prepareVaultSupply(token, amount, options)),
    prepareVaultRedeem: (token, amount, options) => ownedVaultBatch((owned) => owned.prepareVaultRedeem(token, amount, options)),
    vaultRates: (signal) => ownedResult((owned) => owned.vaultRates(signal)),
    // D-083: the Borrow counter, owned the same way: a read for a retired
    // account is refused, and a batch prepared for one never confirms.
    borrowMarket: (signal) => ownedResult((owned) => owned.borrowMarket(signal)),
    borrowPositions: (options) => ownedResult((owned) => owned.borrowPositions(options)),
    prepareBorrow: (request, options) => ownedBorrowBatch((owned) => owned.prepareBorrow(request, options)),
    // D-085: Endur unstaking, owned the same way as the Vault.
    endurUnstakePosition: (options) => ownedResult((owned) => owned.endurUnstakePosition(options)),
    prepareEndurUnstake: (shares, options) => ownedEndurBatch((owned) => owned.prepareEndurUnstake(shares, options)),
    prepareEndurClaim: (options) => ownedEndurBatch((owned) => owned.prepareEndurClaim(options)),
  };

  async function ownedBorrowBatch(
    run: (owned: PrivacyOperations) => Promise<PreparedBorrowBatch>,
  ): Promise<PreparedBorrowBatch> {
    const owner = currentOwner();
    let prepared: PreparedBorrowBatch;
    try {
      prepared = await run(owner.operations);
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
    return ownPreparedBorrowBatch(prepared, () => isCurrent(owner), changedSessionError);
  }

  async function ownedEndurBatch(
    run: (owned: PrivacyOperations) => Promise<PreparedEndurBatch>,
  ): Promise<PreparedEndurBatch> {
    const owner = currentOwner();
    let prepared: PreparedEndurBatch;
    try {
      prepared = await run(owner.operations);
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
    return ownPreparedShadowBatch(prepared, ownEndurAction, {}, 'unstaking', () => isCurrent(owner), changedSessionError);
  }

  async function ownedVaultBatch(
    run: (owned: PrivacyOperations) => Promise<PreparedVaultBatch>,
  ): Promise<PreparedVaultBatch> {
    const owner = currentOwner();
    let prepared: PreparedVaultBatch;
    try {
      prepared = await run(owner.operations);
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
    return ownPreparedVaultBatch(prepared, () => isCurrent(owner), changedSessionError);
  }

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
    wallets = keepListedOrder(wallets, ownDiscoveredWallets(nextWallets));
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

  /** One best-effort look: a throwing scan leaves the list as it was. */
  function lookAgain(): void {
    if (destroyed) return;
    try {
      dependencies.discovery.refresh();
    } catch {
      // Discovery reads page globals the session does not own. A failed look
      // must not escape a timer or a render; the next look may still succeed.
    }
  }

  // D-073: look again on a short, bounded schedule, so a wallet that injects
  // after the store was built is listed without a click. Destroy stops it.
  const rescanTimers = new Set<ReturnType<typeof setTimeout>>();
  for (const delay of DISCOVERY_RESCAN_DELAYS_MS) {
    const timer = setTimeout(() => {
      rescanTimers.delete(timer);
      lookAgain();
    }, delay);
    rescanTimers.add(timer);
  }

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
    refreshDiscovery: lookAgain,
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
      for (const timer of rescanTimers) clearTimeout(timer);
      rescanTimers.clear();
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
  // D-084: the swap's oracle check reads Pragma over the wallet's own RPC,
  // never through the backend that also relays avnu's quote.
  const swapPrices = new PragmaPriceReader(options.rpcUrl);
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
          // D-084: avnu's keyless swap quotes, through the same backend, and
          // their independent check: Pragma over the wallet's own RPC.
          swapQuotes: backend,
          swapPrices,
          supportedVersions: createSupportedVersionsReader(wallet),
          policy,
          // D-077: the Vault's two public reads, through the same backend; the
          // swap resolves its own stand-in address through the first (D-084).
          vault: backend,
          // D-083: the Borrow counter's reads, through the same backend.
          borrow: backend,
          // D-085: unstaking's reads, through the same backend.
          endur: backend,
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

/**
 * A discovered wallet's display `name` or `icon`, or null.
 *
 * - An own data property is used as it stands, without invoking any trap —
 *   the 2026-08-30 finding: a descriptor-valid proxy must not be able to throw
 *   out of session construction.
 * - An own accessor is refused without being invoked: nothing legitimate
 *   defines one per instance, and running it is exactly what that finding
 *   ruled out.
 * - With no own property at all, the field comes from the prototype, which is
 *   how Wallet Standard wallets normally expose it. get-starknet's own
 *   `StarknetInjectedWallet`, which wraps every legacy `window.starknet_*`
 *   wallet, uses class getters, so it is read once, guarded. Requiring own
 *   data properties alone silently dropped such wallets from the picker.
 *
 * Any throw, from a trap or a getter, drops the field and so the wallet; it
 * never escapes.
 */
function walletDisplayField(wallet: object, key: 'name' | 'icon'): string | null {
  try {
    const own = Object.getOwnPropertyDescriptor(wallet, key);
    if (own) return 'value' in own && typeof own.value === 'string' ? own.value : null;
    const value: unknown = Reflect.get(wallet, key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function ownDiscoveredWallets(value: unknown): WalletHandle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<object>();
  return value.filter((wallet): wallet is WalletHandle => {
    if ((typeof wallet !== 'object' && typeof wallet !== 'function') || wallet === null) return false;
    if (walletDisplayField(wallet, 'name') === null || walletDisplayField(wallet, 'icon') === null) return false;
    if (seen.has(wallet)) return false;
    seen.add(wallet);
    return true;
  });
}

/**
 * The picker's next list (D-073). Every wallet already listed keeps its
 * place, and a newly discovered one joins the end. The discovery store puts
 * its newest wallet first, so taking its order as it stands would move the
 * button a player is about to press. Wallets are told apart by object alone,
 * never by name or id.
 */
function keepListedOrder(listed: readonly WalletHandle[], next: readonly WalletHandle[]): WalletHandle[] {
  const present = new Set<object>(next);
  const kept = listed.filter((wallet) => present.has(wallet));
  const known = new Set<object>(kept);
  return [...kept, ...next.filter((wallet) => !known.has(wallet))];
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
  const maxIntents = readPolicyValue<WalletRoutePolicy['maxIntents']>(policy, 'maxIntents');
  const maxRelayFee = readPolicyValue<WalletRoutePolicy['maxRelayFee']>(policy, 'maxRelayFee');
  const enabledRoutes = copyPolicyCollection(
    readPolicyValue<WalletRoutePolicy['enabledRoutes']>(policy, 'enabledRoutes'),
  );
  const allowedTokens = readPolicyValue<WalletRoutePolicy['allowedTokens']>(policy, 'allowedTokens');
  if (!hasOwnDataProperties(allowedTokens, ['shield', 'unshield', 'transfer', 'swap'])) {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
  const shield = copyPolicyCollection(
    readPolicyValue<WalletRoutePolicy['allowedTokens']['shield']>(allowedTokens, 'shield'),
  );
  const unshield = copyPolicyCollection(
    readPolicyValue<WalletRoutePolicy['allowedTokens']['unshield']>(allowedTokens, 'unshield'),
  );
  const transfer = copyPolicyCollection(
    readPolicyValue<WalletRoutePolicy['allowedTokens']['transfer']>(allowedTokens, 'transfer'),
  );
  const swapTokens = copyPolicyCollection(
    readPolicyValue<WalletRoutePolicy['allowedTokens']['swap']>(allowedTokens, 'swap'),
  );
  // Optional (D-063): an existing policy without it admits no stake token.
  const stakeValue = readOptionalPolicyValue<NonNullable<WalletRoutePolicy['allowedTokens']['stake']>>(
    allowedTokens,
    'stake',
  );
  const stakeTokens = stakeValue === undefined ? undefined : copyPolicyCollection(stakeValue);
  // Optional (D-077) the same way: a policy without it admits no Vault token.
  const vaultValue = readOptionalPolicyValue<NonNullable<WalletRoutePolicy['allowedTokens']['vault']>>(
    allowedTokens,
    'vault',
  );
  const vaultTokens = vaultValue === undefined ? undefined : copyPolicyCollection(vaultValue);
  // Optional (D-083) the same way: a policy without it admits no borrow token.
  const borrowValue = readOptionalPolicyValue<NonNullable<WalletRoutePolicy['allowedTokens']['borrow']>>(
    allowedTokens,
    'borrow',
  );
  const borrowTokens = borrowValue === undefined ? undefined : copyPolicyCollection(borrowValue);
  const swap = readOptionalPolicyValue<NonNullable<WalletRoutePolicy['swap']>>(policy, 'swap');
  if (swap !== undefined && !hasOwnDataProperties(swap, ['expectedChainId', 'slippageBps'])) {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
  if (!Number.isSafeInteger(maxIntents) || maxIntents < 0 || typeof maxRelayFee !== 'bigint' || maxRelayFee < 0n) {
    throw invalidPolicy();
  }
  const knownRoutes = new Set(['shield', 'unshield', 'transfer', 'swap', 'stake', 'vault', 'borrow', 'unstake']);
  if (
    enabledRoutes.some((route) => typeof route !== 'string' || !knownRoutes.has(route))
    || new Set(enabledRoutes).size !== enabledRoutes.length
  ) {
    throw invalidPolicy();
  }
  for (const tokens of [shield, unshield, transfer, swapTokens, stakeTokens ?? [], vaultTokens ?? [], borrowTokens ?? []]) {
    validatePolicyTokens(tokens);
  }
  if (enabledRoutes.includes('swap') && swap === undefined) throw invalidPolicy();
  let ownedSwap: NonNullable<WalletRoutePolicy['swap']> | undefined;
  if (swap !== undefined) {
    const expectedChainId = readPolicyValue<NonNullable<WalletRoutePolicy['swap']>['expectedChainId']>(swap, 'expectedChainId');
    const slippageBps = readPolicyValue<NonNullable<WalletRoutePolicy['swap']>['slippageBps']>(swap, 'slippageBps');
    // Optional (D-084): only exactly `true` opens the degen floor's tokens.
    const degen = readOptionalPolicyValue<NonNullable<WalletRoutePolicy['swap']>['degen']>(swap, 'degen');
    if (
      !isNonzeroFelt(expectedChainId) || !Number.isSafeInteger(slippageBps) || slippageBps <= 0 || slippageBps > 10_000
      || (degen !== undefined && typeof degen !== 'boolean')
    ) {
      throw invalidPolicy();
    }
    ownedSwap = Object.freeze({ expectedChainId, slippageBps, ...(degen === true ? { degen: true } : {}) });
  }
  return Object.freeze({
    maxIntents,
    maxRelayFee,
    enabledRoutes: Object.freeze(enabledRoutes),
    allowedTokens: Object.freeze({
      shield: Object.freeze(shield),
      unshield: Object.freeze(unshield),
      transfer: Object.freeze(transfer),
      swap: Object.freeze(swapTokens),
      ...(stakeTokens ? { stake: Object.freeze(stakeTokens) } : {}),
      ...(vaultTokens ? { vault: Object.freeze(vaultTokens) } : {}),
      ...(borrowTokens ? { borrow: Object.freeze(borrowTokens) } : {}),
    }),
    ...(ownedSwap
      ? { swap: ownedSwap }
      : {}),
  });
}

function validatePolicyTokens(tokens: unknown[]): void {
  const seen = new Set<bigint>();
  for (const token of tokens) {
    if (typeof token !== 'string' || !isNonzeroFelt(token)) throw invalidPolicy();
    const canonical = BigInt(token);
    if (seen.has(canonical)) throw invalidPolicy();
    seen.add(canonical);
  }
}

function invalidPolicy(): PrivacyError {
  return new PrivacyError('unknown', 'The wallet route policy is invalid.');
}

function readPolicyValue<T>(value: object, key: PropertyKey): T {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('missing data property');
    return descriptor.value as T;
  } catch {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
}

function readOptionalPolicyValue<T>(value: object, key: PropertyKey): T | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) throw new Error('accessor property');
    return descriptor.value as T;
  } catch {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
}

function copyPolicyCollection<T>(value: Iterable<T>): T[] {
  try {
    return [...value];
  } catch {
    throw new PrivacyError('unknown', 'The wallet route policy is invalid.');
  }
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
  if (!prepared.intents.every(validIntent)) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared intent.');
  }
  if (new Set(prepared.intents.map((intent) => intent.kind)).size > 1) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned mixed prepared route kinds.');
  }
  const swapIntents = prepared.intents.filter((intent) => intent.kind === 'swap');
  if ((swapReview !== undefined && (prepared.intents.length !== 1 || swapIntents.length !== 1))) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned incoherent prepared swap review metadata.');
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
      for (const optional of ['onProgress', 'signal', 'acknowledgeUncheckedPrice'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(options, optional);
        if (descriptor && !('value' in descriptor)) {
          throw new PrivacyError('unknown', 'The confirmation options are invalid.');
        }
      }
      const ownedOptions = {
        feeCeiling: options.feeCeiling,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        // D-084: only exactly `true` acknowledges an unchecked swap price.
        ...(options.acknowledgeUncheckedPrice === true ? { acknowledgeUncheckedPrice: true } : {}),
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

/**
 * The session's own copy of a prepared Vault batch (D-077), checked like
 * `ownPreparedBatch`: costs that add up, an action this package could have
 * built, frozen review data, and a confirm that refuses a retired account.
 *
 * One difference, from the Vault's contract: once the wallet has returned a
 * transaction hash, the result is returned even if the account changed while
 * the receipt was awaited. The transaction exists either way, and a failure
 * here would only invite a second submission.
 */
function ownPreparedVaultBatch(
  prepared: PreparedVaultBatch,
  isCurrent: () => boolean,
  changedSessionError: () => PrivacyError,
): PreparedVaultBatch {
  return ownPreparedShadowBatch(prepared, ownVaultAction, {}, 'Vault', isCurrent, changedSessionError);
}

/**
 * The session's own copy of a prepared Borrow-counter batch (D-083): the
 * Vault's checks, plus an action and a health figure this package could have
 * built.
 */
function ownPreparedBorrowBatch(
  prepared: PreparedBorrowBatch,
  isCurrent: () => boolean,
  changedSessionError: () => PrivacyError,
): PreparedBorrowBatch {
  let after: BorrowHealth | null = null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prepared, 'after');
    after = descriptor && 'value' in descriptor ? ownBorrowHealth(descriptor.value) : null;
  } catch {
    after = null;
  }
  if (after === null) {
    try {
      prepared.discard();
    } catch {
      // The invalid batch is refused either way.
    }
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared borrow health.');
  }
  return ownPreparedShadowBatch(prepared, ownBorrowAction, { after }, 'borrow', isCurrent, changedSessionError);
}

/**
 * The shared checks of a prepared shadow-account batch (D-077, D-083).
 */
function ownPreparedShadowBatch<A, B extends { readonly action: A } & Omit<PreparedVaultBatch, 'action'>, E extends object>(
  prepared: B,
  ownAction: (value: unknown) => A | null,
  extra: E,
  subject: string,
  isCurrent: () => boolean,
  changedSessionError: () => PrivacyError,
): Omit<PreparedVaultBatch, 'action'> & { readonly action: A } & E {
  const required = ['action', 'poolFee', 'gasEstimate', 'totalCost', 'warnings', 'promptCount', 'confirm', 'discard'] as const;
  const invalid = (message: string): PrivacyError => {
    try {
      prepared.discard();
    } catch {
      // The invalid batch is refused either way.
    }
    return new PrivacyError('unknown', message);
  };
  if (!hasOwnDataProperties(prepared, required)) throw invalid(`The wallet returned an invalid prepared ${subject} batch.`);
  if (
    typeof prepared.poolFee !== 'bigint'
    || prepared.poolFee < 0n
    || typeof prepared.gasEstimate !== 'bigint'
    || prepared.gasEstimate < 0n
    || typeof prepared.totalCost !== 'bigint'
    || prepared.totalCost !== prepared.poolFee + prepared.gasEstimate
  ) {
    throw invalid('The wallet returned invalid prepared costs.');
  }
  if (!Number.isSafeInteger(prepared.promptCount) || prepared.promptCount < 0) {
    throw invalid('The wallet returned an invalid prepared prompt count.');
  }
  if (!denseDataArray(prepared.warnings) || !prepared.warnings.every(validWarning)) {
    throw invalid('The wallet returned an invalid prepared warning.');
  }
  const action = ownAction(prepared.action);
  if (action === null) throw invalid(`The wallet returned an invalid prepared ${subject} action.`);
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
    ...extra,
    action,
    poolFee: prepared.poolFee,
    gasEstimate: prepared.gasEstimate,
    totalCost: prepared.totalCost,
    warnings,
    promptCount: prepared.promptCount,
    async confirm(options: Parameters<PreparedVaultBatch['confirm']>[0]) {
      if (!hasOwnDataProperties(options, ['feeCeiling'])) {
        throw new PrivacyError('unknown', 'The confirmation options are invalid.');
      }
      for (const optional of ['onProgress', 'onStage', 'onSubmitted', 'signal'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(options, optional);
        if (descriptor && !('value' in descriptor)) {
          throw new PrivacyError('unknown', 'The confirmation options are invalid.');
        }
      }
      const ownedOptions = {
        feeCeiling: options.feeCeiling,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onStage ? { onStage: options.onStage } : {}),
        ...(options.onSubmitted ? { onSubmitted: options.onSubmitted } : {}),
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
      let result: Awaited<ReturnType<PreparedVaultBatch['confirm']>>;
      try {
        result = await prepared.confirm(ownedOptions);
      } catch (error) {
        if (!isCurrent()) {
          retire();
          throw changedSessionError();
        }
        throw error;
      }
      if (
        !hasOwnDataProperties(result, ['transactionHash', 'outcome'])
        || typeof result.transactionHash !== 'string'
        || !isNonzeroFelt(result.transactionHash)
        || (result.outcome !== 'succeeded' && result.outcome !== 'reverted' && result.outcome !== 'pending')
      ) {
        retire();
        throw new PrivacyError('unknown', 'The wallet returned an invalid transaction receipt.');
      }
      return Object.freeze({ transactionHash: result.transactionHash, outcome: result.outcome });
    },
    discard,
  }) as Omit<PreparedVaultBatch, 'action'> & { readonly action: A } & E;
}

/** A Vault action as this package builds one, owned and frozen, or null. */
function ownVaultAction(value: unknown): VaultAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const kind = read('kind');
  const token = read('token');
  const amount = read('amount');
  if (typeof token !== 'string' || !isNonzeroFelt(token) || typeof amount !== 'bigint' || amount < 0n) return null;
  if (kind === 'supply' && Reflect.ownKeys(value).length === 3 && amount > 0n) {
    return Object.freeze({ kind, token, amount });
  }
  const all = read('all');
  if (kind === 'redeem' && Reflect.ownKeys(value).length === 4 && typeof all === 'boolean' && (all || amount > 0n)) {
    return Object.freeze({ kind, token, amount, all });
  }
  return null;
}

/** An unstaking action as this package builds one (D-085), owned and frozen, or null. */
function ownEndurAction(value: unknown): EndurAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const kind = read('kind');
  if (kind === 'request' && Reflect.ownKeys(value).length === 3) {
    const shares = read('shares');
    const leftover = read('leftover');
    if (typeof shares !== 'bigint' || shares <= 0n || typeof leftover !== 'bigint' || leftover < 0n) return null;
    return Object.freeze({ kind, shares, leftover });
  }
  if (kind === 'claim' && Reflect.ownKeys(value).length === 4) {
    const ids = read('requestIds');
    const owed = read('owed');
    const held = read('held');
    if (!denseDataArray(ids) || typeof owed !== 'bigint' || owed < 0n || typeof held !== 'bigint' || held < 0n) return null;
    const requestIds = (ids as unknown[]).map((id) => id);
    if (!requestIds.every((id): id is bigint => typeof id === 'bigint' && id >= 0n)) return null;
    return Object.freeze({ kind, requestIds: Object.freeze(requestIds), owed, held });
  }
  return null;
}

/** A Borrow-counter action as this package builds one (D-083), owned and frozen, or null. */
function ownBorrowAction(value: unknown): BorrowAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const kind = read('kind');
  const collateral = read('collateral');
  const debt = read('debt');
  if (typeof collateral !== 'string' || !isNonzeroFelt(collateral) || typeof debt !== 'string' || !isNonzeroFelt(debt)) return null;
  const keys = Reflect.ownKeys(value).length;
  const positive = (entry: unknown): entry is bigint => typeof entry === 'bigint' && entry > 0n;
  const nonNegative = (entry: unknown): entry is bigint => typeof entry === 'bigint' && entry >= 0n;
  if (kind === 'borrow') {
    const collateralAmount = read('collateralAmount');
    const borrowAmount = read('borrowAmount');
    if (keys !== 5 || !nonNegative(collateralAmount) || !positive(borrowAmount)) return null;
    return Object.freeze({ kind, collateral, debt, collateralAmount, borrowAmount });
  }
  const amount = read('amount');
  if (kind === 'add-collateral') {
    if (keys !== 4 || !positive(amount)) return null;
    return Object.freeze({ kind, collateral, debt, amount });
  }
  const all = read('all');
  if (typeof all !== 'boolean') return null;
  if (kind === 'repay') {
    const buffer = read('buffer');
    if (keys !== 6 || !positive(amount) || !nonNegative(buffer) || (!all && buffer !== 0n) || buffer >= amount) return null;
    return Object.freeze({ kind, collateral, debt, amount, all, buffer });
  }
  if (kind === 'withdraw-collateral') {
    if (keys !== 5 || !positive(amount)) return null;
    return Object.freeze({ kind, collateral, debt, amount, all });
  }
  return null;
}

/** A health figure as `borrow.ts` computes one (D-083), owned and frozen, or null. */
function ownBorrowHealth(value: unknown): BorrowHealth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const status = read('status');
  const band = read('band');
  const collateralValue = read('collateralValue');
  const debtValue = read('debtValue');
  const maxLtv = read('maxLtv');
  const optional = (entry: unknown): entry is bigint | null => entry === null || (typeof entry === 'bigint' && entry >= 0n);
  const ltv = read('ltv');
  const healthFactor = read('healthFactor');
  const liquidationPrice = read('liquidationPrice');
  if (
    Reflect.ownKeys(value).length !== 8
    || (status !== 'no-debt' && status !== 'stale-price' && status !== 'priced')
    || (band !== 'none' && band !== 'safe' && band !== 'warning' && band !== 'liquidatable' && band !== 'unknown')
    || typeof collateralValue !== 'bigint' || collateralValue < 0n
    || typeof debtValue !== 'bigint' || debtValue < 0n
    || typeof maxLtv !== 'bigint' || maxLtv < 0n
    || !optional(ltv) || !optional(healthFactor) || !optional(liquidationPrice)
  ) {
    return null;
  }
  return Object.freeze({ status, collateralValue, debtValue, ltv, maxLtv, healthFactor, liquidationPrice, band });
}

function validIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind || !('value' in kind) || typeof kind.value !== 'string') return false;
  if (kind.value === 'shield') {
    const token = Object.getOwnPropertyDescriptor(value, 'token');
    const amount = Object.getOwnPropertyDescriptor(value, 'amount');
    return Boolean(
      token && 'value' in token && typeof token.value === 'string' && isNonzeroFelt(token.value)
      && amount && 'value' in amount && typeof amount.value === 'bigint' && amount.value > 0n
    );
  }
  if (kind.value === 'transfer' || kind.value === 'unshield') {
    const token = Object.getOwnPropertyDescriptor(value, 'token');
    const recipient = Object.getOwnPropertyDescriptor(value, 'recipient');
    const amount = Object.getOwnPropertyDescriptor(value, 'amount');
    return Boolean(
      token && 'value' in token && typeof token.value === 'string' && isNonzeroFelt(token.value)
      && recipient && 'value' in recipient && typeof recipient.value === 'string' && isNonzeroFelt(recipient.value)
      && amount && 'value' in amount && typeof amount.value === 'bigint' && amount.value > 0n
    );
  }
  if (kind.value === 'swap') {
    const tokenIn = Object.getOwnPropertyDescriptor(value, 'tokenIn');
    const tokenOut = Object.getOwnPropertyDescriptor(value, 'tokenOut');
    const amountIn = Object.getOwnPropertyDescriptor(value, 'amountIn');
    const minimum = Object.getOwnPropertyDescriptor(value, 'minAmountOut');
    return Boolean(
      tokenIn && 'value' in tokenIn && typeof tokenIn.value === 'string' && isNonzeroFelt(tokenIn.value)
      && tokenOut && 'value' in tokenOut && typeof tokenOut.value === 'string' && isNonzeroFelt(tokenOut.value)
      && amountIn && 'value' in amountIn && typeof amountIn.value === 'bigint' && amountIn.value > 0n
      && minimum && 'value' in minimum && typeof minimum.value === 'bigint' && minimum.value > 0n
    );
  }
  if (kind.value === 'stake') {
    const tokenIn = Object.getOwnPropertyDescriptor(value, 'tokenIn');
    const tokenOut = Object.getOwnPropertyDescriptor(value, 'tokenOut');
    const amountIn = Object.getOwnPropertyDescriptor(value, 'amountIn');
    return Boolean(
      tokenIn && 'value' in tokenIn && typeof tokenIn.value === 'string' && isNonzeroFelt(tokenIn.value)
      && tokenOut && 'value' in tokenOut && typeof tokenOut.value === 'string' && isNonzeroFelt(tokenOut.value)
      && amountIn && 'value' in amountIn && typeof amountIn.value === 'bigint' && amountIn.value > 0n
    );
  }
  return true;
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
  if (!hasOwnDataProperties(value, ['expectedAmountOut', 'minimumAmountOut', 'slippageBps', 'expiresAt', 'priceCheck'])) {
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
    || !validPriceCheck(review.priceCheck)
  ) {
    retireInvalidPrepared(prepared);
    throw new PrivacyError('unknown', 'The wallet returned an invalid prepared swap review.');
  }
  return Object.freeze({ ...review, priceCheck: Object.freeze({ ...review.priceCheck }) });
}

/** D-084: a price check is `checked` with both USD values and a shortfall within its bound, or `unchecked`. */
function validPriceCheck(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const check = value as Record<string, unknown>;
  const usd = (amount: unknown) => amount === undefined || (typeof amount === 'bigint' && amount >= 0n);
  if (!Number.isSafeInteger(check.boundBps) || (check.boundBps as number) <= 0 || !usd(check.sellUsd) || !usd(check.expectedBuyUsd)) return false;
  if (check.status === 'unchecked') return check.shortfallBps === undefined;
  return check.status === 'checked'
    && typeof check.sellUsd === 'bigint' && typeof check.expectedBuyUsd === 'bigint'
    && Number.isSafeInteger(check.shortfallBps) && (check.shortfallBps as number) <= (check.boundBps as number);
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
  try {
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && 'value' in descriptor);
    });
  } catch {
    return false;
  }
}
