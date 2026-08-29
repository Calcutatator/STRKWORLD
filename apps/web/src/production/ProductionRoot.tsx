import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import type { WalletSession, WalletSessionSnapshot } from '@strkworld/privacy';
import { useEffect, useMemo, useState, useRef } from 'react';
import { App } from '../App.js';
import type { BridgeRuntimeLoader } from '../bridge/BridgeProvider.js';
import { createConnectFlow, type ConnectState } from '../connect/connect-machine.js';
import { COPY } from '../copy.js';
import type { PresenceController } from '../presence/presence-controller.js';
import { useStore } from '../store/use-store.js';
import {
  WalletSessionProvider,
  useWalletSessionOptional,
} from '../wallet/WalletSessionProvider.js';
import { WalletAttentionCue } from '../wallet/WalletAttentionCue.js';

export function ProductionRoot({
  session,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
}: {
  session: WalletSession;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  /** Legacy/test injection. Production supplies createPresence instead. */
  presence?: PresenceController;
  /** Creates a fresh lobby owner for each connected app lifetime. */
  createPresence?: () => PresenceController;
  /** Main-owned lazy Bridge recovery loader; no shield planner capability. */
  bridge: { loadRuntime: BridgeRuntimeLoader };
}) {
  return (
    <WalletSessionProvider session={session}>
      <ProductionApp
        session={session}
        worldOut={worldOut}
        shellIn={shellIn}
        presence={presence}
        createPresence={createPresence}
        bridge={bridge}
      />
    </WalletSessionProvider>
  );
}

function ProductionApp({
  session,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
}: {
  session: WalletSession;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence?: PresenceController;
  createPresence?: () => PresenceController;
  bridge: { loadRuntime: BridgeRuntimeLoader };
}) {
  const wallet = useWalletSessionOptional();
  if (!wallet) throw new Error('ProductionApp needs a WalletSessionProvider.');

  if (!isConnectedWallet(wallet.snapshot)) {
    return <WalletEntryGate snapshot={wallet.snapshot} connect={wallet.connect} refreshDiscovery={wallet.refreshDiscovery} />;
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
}: {
  session: WalletSession;
  snapshot: WalletSessionSnapshot;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence?: PresenceController;
  createPresence?: () => PresenceController;
  bridge: { loadRuntime: BridgeRuntimeLoader };
}) {
  const connect = useMemo(
    () => createConnectFlow(session.operations),
    [session.operations, snapshot.generation, snapshot.account],
  );
  const state = useStore(connect.store);

  useEffect(() => {
    void connect.connect();
  }, [connect]);

  if (capabilityAdmits(state)) {
    return (
      <ConnectedProductionApp
        session={session}
        initialConnectState={state}
        worldOut={worldOut}
        shellIn={shellIn}
        presence={presence}
        createPresence={createPresence}
        bridge={bridge}
      />
    );
  }

  return <WalletCapabilityGateView state={state} onRetry={() => void connect.recheck()} />;
}

function ConnectedProductionApp({
  session,
  initialConnectState,
  worldOut,
  shellIn,
  presence,
  createPresence,
  bridge,
}: {
  session: WalletSession;
  initialConnectState: ConnectState;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence?: PresenceController;
  createPresence?: () => PresenceController;
  bridge: { loadRuntime: BridgeRuntimeLoader };
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

  if (!activePresence) {
    return <div className="shell-boot" role="status">Starting the city…</div>;
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
        planner: null,
      }}
    />
  );
}

function isConnectedWallet(snapshot: WalletSessionSnapshot): boolean {
  return snapshot.phase === 'connected' && snapshot.account !== null;
}

export function capabilityAdmits(state: ConnectState): boolean {
  return state.name === 'connected' || state.name === 'not-registered';
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

  const body = snapshot.phase === 'wrong-network'
    ? COPY.connect.wrongNetwork
    : snapshot.phase === 'failed'
      ? COPY.unreachable.body
      : snapshot.wallets.length === 0
        ? COPY.connect.none
        : COPY.connect.body;
  const title = snapshot.wallets.length === 0 ? COPY.connect.title : COPY.connect.choose;

  return (
    <section className="room room-connect" data-testid="wallet-entry-gate">
      <h2>{title}</h2>
      <p>{body}</p>
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
    </section>
  );
}

function WalletCapabilityGateView({
  state,
  onRetry,
}: {
  state: ConnectState;
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
        <p>{COPY.connect.body}</p>
        <button type="button" onClick={onRetry}>{COPY.connect.retry}</button>
      </section>
    );
  }
  if (state.name === 'unsupported-wallet') {
    return (
      <section className="room room-unsupported" data-testid="wallet-capability-gate">
        <h2>{COPY.unsupported.title}</h2>
        <p>{COPY.unsupported.body}</p>
        {state.walletApiVersion ? <p className="room-detail">Wallet API {state.walletApiVersion}</p> : null}
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
