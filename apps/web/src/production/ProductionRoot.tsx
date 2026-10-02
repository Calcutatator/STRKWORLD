import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import type {
  PublicShieldPlanner,
  ReservePublicShieldPlannerOptions,
  WalletRoutePolicy,
  WalletSession,
  WalletSessionSnapshot,
} from '@strkworld/privacy';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { App } from '../App.js';
import type { BridgeRuntimeLoader } from '../bridge/BridgeProvider.js';
import type { DegenCatalogSource } from '../panels/exchange/degen-catalog.js';
import type { PoolStatsSource } from '../plaza/pool-stats.js';
import { STRK_TOKEN } from '../bridge/bridge-machine.js';
import { createConnectFlow, type ConnectFlow, type ConnectState } from '../connect/connect-machine.js';
import { DiscoveryRescan } from '../connect/DiscoveryRescan.js';
import { EntryGate } from '../connect/EntryGate.js';
import { createEntryPassMemory } from '../connect/entry-pass.js';
import { GetAWallet } from '../connect/GetAWallet.js';
import { TitleScreen } from '../connect/TitleScreen.js';
import { selectedWalletName, unsupportedRoomCopy } from '../connect/unsupported-copy.js';
import { COPY } from '../copy.js';
import { sameAddress } from '../format.js';
import type { PresenceController } from '../presence/presence-controller.js';
import { useStore } from '../store/use-store.js';
import {
  WalletSessionProvider,
  useWalletSessionOptional,
} from '../wallet/WalletSessionProvider.js';
import { WalletAttentionCue } from '../wallet/WalletAttentionCue.js';
import { detectEntryGateBypass, detectRoutePolicy } from './config.js';

/**
 * Builds the Bridge's reserve shield planner (D-061). The privacy seam loads
 * lazily, so `main.tsx` supplies this from its dynamic import rather than the
 * shell importing the planner eagerly.
 */
export type ShieldPlannerFactory = (options: ReservePublicShieldPlannerOptions) => PublicShieldPlanner;

export function ProductionRoot({
  session,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
  createShieldPlanner,
  policy = detectRoutePolicy(),
  degenCatalog,
  poolStats,
}: {
  session: WalletSession;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  /** Legacy/test injection. Production supplies createPresence instead. */
  presence?: PresenceController;
  /** Creates a fresh lobby owner for each connected app lifetime. */
  createPresence?: () => PresenceController;
  /** Main-owned lazy Bridge recovery loader. Shield planning arrives separately. */
  bridge: { loadRuntime: BridgeRuntimeLoader };
  /** D-061's reserve planner. Used only while `policy` enables the STRK shield route. */
  createShieldPlanner?: ShieldPlannerFactory;
  /** The route policy this build's session enforces; defaults to the live one. */
  policy?: WalletRoutePolicy | null;
  /** The degen floor's list, read from the same-origin backend (D-067). */
  degenCatalog?: DegenCatalogSource;
  /** The Privacy Plaza's pool stats, read from the same-origin backend (D-076). */
  poolStats?: PoolStatsSource;
}) {
  // A boolean, not the policy object: the default policy is re-parsed on every
  // render, and a new planner per render would reset the Bridge panel.
  const shieldPlanning = shieldPlanningEnabled(policy);
  const shieldPlanner = useMemo(
    () => (shieldPlanning ? buildShieldPlanner(createShieldPlanner, session) : null),
    [shieldPlanning, createShieldPlanner, session],
  );
  return (
    <WalletSessionProvider session={session}>
      <ProductionApp
        session={session}
        worldOut={worldOut}
        shellIn={shellIn}
        presence={presence}
        createPresence={createPresence}
        bridge={bridge}
        shieldPlanner={shieldPlanner}
        degenCatalog={degenCatalog}
        poolStats={poolStats}
        policy={policy}
      />
    </WalletSessionProvider>
  );
}

/**
 * D-061: the Bridge may plan a shield only while this build's route policy
 * admits the STRK shield route (D-056). Without that, whatever else the
 * policy enables, the Bridge stays recovery-only.
 */
export function shieldPlanningEnabled(policy: WalletRoutePolicy | null | undefined): boolean {
  if (!policy) return false;
  try {
    return policy.enabledRoutes.includes('shield')
      && policy.allowedTokens.shield.some((token) => sameAddress(token, STRK_TOKEN));
  } catch {
    return false;
  }
}

function buildShieldPlanner(
  factory: ShieldPlannerFactory | undefined,
  session: WalletSession,
): PublicShieldPlanner | null {
  if (!factory) return null;
  try {
    return factory({
      // The Bank's own pool-configuration path: the session's operations read
      // the backend-proxied PoolReadClient.config(), so the Bridge reserve and
      // the Bank's fee ceiling see the same live fee.
      pool: { config: (signal) => session.operations.poolConfig(signal) },
      readAccount: () => session.readAccount(),
    });
  } catch {
    // Planning is optional. A failed composition leaves the Bridge
    // recovery-only; it never blocks wallet admission or the city.
    return null;
  }
}

function ProductionApp({
  session,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
  shieldPlanner,
  degenCatalog,
  poolStats,
  policy,
}: {
  session: WalletSession;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence?: PresenceController;
  createPresence?: () => PresenceController;
  bridge: { loadRuntime: BridgeRuntimeLoader };
  shieldPlanner: PublicShieldPlanner | null;
  degenCatalog?: DegenCatalogSource;
  poolStats?: PoolStatsSource;
  policy: WalletRoutePolicy | null;
}) {
  const wallet = useWalletSessionOptional();
  if (!wallet) throw new Error('ProductionApp needs a WalletSessionProvider.');

  if (!isConnectedWallet(wallet.snapshot)) {
    return (
      <TitleScreen>
        <WalletEntryGate snapshot={wallet.snapshot} connect={wallet.connect} refreshDiscovery={wallet.refreshDiscovery} />
      </TitleScreen>
    );
  }

  return (
    <WalletCapabilityGate
      session={session}
      snapshot={wallet.snapshot}
      worldOut={worldOut}
      shellIn={shellIn}
      presence={presence}
      createPresence={createPresence}
      bridge={bridge}
      shieldPlanner={shieldPlanner}
      degenCatalog={degenCatalog}
      poolStats={poolStats}
      policy={policy}
    />
  );
}

function WalletCapabilityGate({
  session,
  snapshot,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
  shieldPlanner,
  degenCatalog,
  poolStats,
  policy,
}: {
  session: WalletSession;
  snapshot: WalletSessionSnapshot;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence?: PresenceController;
  createPresence?: () => PresenceController;
  bridge: { loadRuntime: BridgeRuntimeLoader };
  shieldPlanner: PublicShieldPlanner | null;
  degenCatalog?: DegenCatalogSource;
  poolStats?: PoolStatsSource;
  policy: WalletRoutePolicy | null;
}) {
  const connect = useMemo(
    () => createConnectFlow(session.operations),
    [session.operations, snapshot.generation, snapshot.account],
  );
  const state = useStore(connect.store);
  const capabilityEffect = useRef<{ token: symbol; connect: ConnectFlow } | null>(null);
  const capabilityController = useRef<AbortController | null>(null);

  useEffect(() => {
    const previous = capabilityEffect.current;
    const controller = previous?.connect === connect && capabilityController.current
      ? capabilityController.current
      : new AbortController();
    capabilityController.current = controller;
    const token = Symbol();
    capabilityEffect.current = { token, connect };
    void connect.connect(controller.signal);
    return () => {
      // React StrictMode probes cleanup and setup synchronously with the same
      // flow. Let that probe keep sharing the in-flight query, while aborting
      // a real retirement or a replacement flow on the next microtask.
      queueMicrotask(() => {
        const owner = capabilityEffect.current;
        if (owner?.token === token || owner?.connect !== connect) {
          controller.abort();
          if (capabilityController.current === controller) capabilityController.current = null;
        }
      });
    };
  }, [connect]);

  if (capabilityAdmits(state)) {
    // D-072: a supported wallet reaches the entry gate, not the city. The
    // presence owner, the World, the HUD and the lobby connection all live
    // below it, so none of them exists until this account passes. Keyed by
    // account generation, so another account starts the gate over; the gate
    // also re-reads the session's account (no wallet prompt) before an
    // answer counts, so one that races that replacement is dropped.
    if (detectEntryGateBypass()) {
      // Temporary testing switch (VITE_ENTRY_GATE_BYPASS): skip D-072's
      // pool-balance check and go straight into the city.
      return (
        <ConnectedProductionApp
          key={`${snapshot.generation}:${snapshot.account ?? ''}`}
          session={session}
          initialConnectState={state}
          worldOut={worldOut}
          shellIn={shellIn}
          presence={presence}
          createPresence={createPresence}
          bridge={bridge}
          shieldPlanner={shieldPlanner}
          degenCatalog={degenCatalog}
          poolStats={poolStats}
        />
      );
    }
    return (
      <EntryGate
        key={`${snapshot.generation}:${snapshot.account ?? ''}`}
        operations={session.operations}
        account={snapshot.account}
        readAccount={session.readAccount}
        policy={policy}
      >
        <ConnectedProductionApp
          session={session}
          initialConnectState={state}
          worldOut={worldOut}
          shellIn={shellIn}
          presence={presence}
          createPresence={createPresence}
          bridge={bridge}
          shieldPlanner={shieldPlanner}
          degenCatalog={degenCatalog}
          poolStats={poolStats}
        />
      </EntryGate>
    );
  }

  return (
    <TitleScreen>
      <WalletCapabilityGateView
        state={state}
        walletName={selectedWalletName(snapshot)}
        onRetry={() => void connect.recheck()}
      />
    </TitleScreen>
  );
}

function ConnectedProductionApp({
  session,
  initialConnectState,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
  shieldPlanner,
  degenCatalog,
  poolStats,
}: {
  session: WalletSession;
  initialConnectState: ConnectState;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence?: PresenceController;
  createPresence?: () => PresenceController;
  bridge: { loadRuntime: BridgeRuntimeLoader };
  shieldPlanner: PublicShieldPlanner | null;
  degenCatalog?: DegenCatalogSource;
  poolStats?: PoolStatsSource;
}) {
  const [activePresence, setActivePresence] = useState<PresenceController | null>(presence ?? null);
  const owner = useRef<PresenceController | null>(presence ?? null);
  const ownerGeneration = useRef(0);

  useEffect(() => {
    const next = owner.current ?? createPresence?.();
    if (!next) throw new Error('ProductionApp needs a PresenceController.');
    owner.current = next;
    setActivePresence(next);
    const generation = ++ownerGeneration.current;
    return () => {
      // StrictMode probes effect cleanup and immediately re-runs the effect.
      // Deferring destruction lets the replacement setup retain the same owner,
      // while a real account-loss unmount still tears it down.
      queueMicrotask(() => {
        if (ownerGeneration.current !== generation) return;
        ownerGeneration.current += 1;
        owner.current = null;
        void next.destroy().catch(() => {});
      });
    };
  }, [createPresence]);

  // D-120: the wallet pill's "Disconnect & return to menu". Disconnecting the
  // session is the whole teardown: it forgets the account at once, so
  // ProductionApp renders the D-115 title screen in place of this subtree,
  // and unmounting it destroys the presence owner (the effect above, which
  // leaves the lobby), releases the World and its three.js engine
  // (WorldHost), and drops the capability flow and the providers. Connecting
  // again builds every one of them fresh, in the same tab, with no reload.
  const signOut = useCallback(async () => {
    const pass = createEntryPassMemory({ account: session.getSnapshot().account });
    // A logout: the next connection of this account checks the gate again.
    const forgetting = pass?.forget();
    try {
      // Forgets the account and its operations first, then asks the wallet to
      // disconnect where it supports that; a wallet that refuses has still
      // been forgotten here.
      await session.disconnect();
    } finally {
      await forgetting;
    }
  }, [session]);

  if (!activePresence) {
    return (
      <TitleScreen>
        <div className="shell-boot" role="status">Starting the city…</div>
      </TitleScreen>
    );
  }

  return (
    <App
      worldOut={worldOut}
      shellIn={shellIn}
      presence={activePresence}
      operations={session.operations}
      walletSession={session}
      initialConnectState={initialConnectState}
      bridge={{
        loadRuntime: bridge.loadRuntime,
        account: session.getSnapshot().account,
        readAccount: session.readAccount,
        // D-061: a reserve planner only while shield is enabled; otherwise
        // null keeps the Bridge recovery-only.
        planner: shieldPlanner,
      }}
      degenCatalog={degenCatalog}
      poolStats={poolStats}
      onSignOut={signOut}
    />
  );
}

function isConnectedWallet(snapshot: WalletSessionSnapshot): boolean {
  return snapshot.phase === 'connected' && snapshot.account !== null;
}

/**
 * Whether the capability verdict admits this wallet past the connect rooms:
 * a supported `connected` state, or `not-registered`. Since D-072 that
 * admits the player to the entry gate, not to the city: the gate's own reads
 * meet a 118 and answer it with the deposit card, or with the not-registered
 * card when the deposit itself answers 118.
 */
export function capabilityAdmits(state: ConnectState): boolean {
  if (typeof state !== 'object' || state === null) return false;
  try {
    const name = ownData(state, 'name');
    if (name === 'not-registered') return true;
    if (name !== 'connected') return false;

    const capability = ownData(state, 'capability');
    if (typeof capability !== 'object' || capability === null) return false;
    const supportsStrk20 = ownData(capability, 'supportsStrk20');
    const walletApiVersion = ownData(capability, 'walletApiVersion');
    const registration = ownData(capability, 'registration');
    const registrationConfirmed = ownData(state, 'registrationConfirmed');
    return supportsStrk20 === true &&
      typeof walletApiVersion === 'string' && walletApiVersion.length > 0 &&
      (registration === 'registered' || registration === 'unknown') &&
      registrationConfirmed === (registration === 'registered');
  } catch {
    return false;
  }
}

function ownData(record: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function WalletEntryGate({
  snapshot,
  connect,
  refreshDiscovery,
}: {
  snapshot: WalletSessionSnapshot;
  connect: (key: string) => Promise<void>;
  refreshDiscovery: () => void;
}) {
  if (snapshot.phase === 'connecting') {
    return (
      <>
        <WalletAttentionCue active kind="connect" />
        <section className="room room-connect" aria-busy="true">
          <h2>{COPY.connect.title}</h2>
          <p>{COPY.connect.connecting}</p>
        </section>
      </>
    );
  }

  // A line only when something needs saying: the wrong network, an
  // unreachable wallet, or no wallet found. A plain wallet list has none.
  const body = snapshot.phase === 'wrong-network'
    ? COPY.connect.wrongNetwork
    : snapshot.phase === 'failed'
      ? COPY.unreachable.body
      : snapshot.wallets.length === 0
        ? COPY.connect.none
        : null;
  // The title screen's menu (D-115): "Connect wallet", then the choices.
  const title = snapshot.wallets.length === 0 ? COPY.connect.title : COPY.connect.action;

  return (
    <section className="room room-connect" data-testid="wallet-entry-gate">
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {snapshot.wallets.length === 0 ? <GetAWallet /> : null}
      {snapshot.wallets.map((choice) => (
        <button
          type="button"
          key={choice.key}
          onClick={() => void connect(choice.key).catch(() => {})}
        >
          {choice.name}
        </button>
      ))}
      <button type="button" onClick={refreshDiscovery}>
        {COPY.connect.refreshWallets}
      </button>
      <DiscoveryRescan refresh={refreshDiscovery} />
    </section>
  );
}

function WalletCapabilityGateView({
  state,
  walletName,
  onRetry,
}: {
  state: ConnectState;
  /** The picker's display-only name for the connected wallet (D-073). */
  walletName: string | null;
  onRetry: () => void;
}) {
  if (state.name === 'detecting') {
    return (
      <section className="room room-connect" aria-busy="true" data-testid="wallet-capability-gate">
        <h2>{COPY.connect.title}</h2>
        <p>{COPY.connect.connecting}</p>
      </section>
    );
  }
  if (state.name === 'disconnected') {
    return (
      <section className="room room-connect" data-testid="wallet-capability-gate">
        <h2>{COPY.connect.title}</h2>
        <button type="button" onClick={onRetry}>{COPY.connect.retry}</button>
      </section>
    );
  }
  if (state.name === 'unsupported-wallet') {
    const copy = unsupportedRoomCopy(walletName, state);
    return (
      <section className="room room-unsupported" data-testid="wallet-capability-gate">
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        {copy.detail ? <p className="room-detail">{copy.detail}</p> : null}
        <button type="button" onClick={onRetry}>{COPY.unsupported.action}</button>
      </section>
    );
  }
  return (
    <section className="room room-unreachable" data-testid="wallet-capability-gate">
      <h2>{COPY.unreachable.title}</h2>
      <p>{COPY.unreachable.body}</p>
      <button type="button" onClick={onRetry}>{COPY.unreachable.action}</button>
    </section>
  );
}
