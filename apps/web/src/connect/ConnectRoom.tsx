import { COPY } from '../copy.js';
import { useEffect, useRef } from 'react';
import { usePrivacy } from '../privacy/PrivacyProvider.js';
import type { ConnectFlow, ConnectState } from './connect-machine.js';
import { useWalletSessionOptional, type WalletSessionRuntime } from '../wallet/WalletSessionProvider.js';

/**
 * The connect flow, and the two rooms that are not errors.
 *
 * A wallet that cannot do STRK20, and an account the pool has never seen, are
 * both designed screens with a next step. Neither is a toast: one is a fact
 * about the player's wallet and the other is a task only they can perform,
 * and both survive longer than four seconds.
 */
export function ConnectRoom() {
  const { connect, connectState } = usePrivacy();
  const wallet = useWalletSessionOptional();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return ConnectRoomView({ connect, connectState, wallet, isMounted: () => mounted.current });
}

export function ConnectRoomView({
  connect,
  connectState,
  wallet,
  isMounted,
}: {
  connect: Pick<ConnectFlow, 'connect' | 'recheck'>;
  connectState: ConnectState;
  wallet: Pick<WalletSessionRuntime, 'snapshot' | 'connect' | 'refreshDiscovery'> | null;
  /** Optional lifecycle owner supplied by the mounted production component. */
  isMounted?: () => boolean;
}) {

  switch (connectState.name) {
    case 'detecting':
      return (
        <section className="room room-connect" aria-busy="true">
          <h2>{COPY.connect.title}</h2>
          <p>{COPY.connect.connecting}</p>
        </section>
      );

    case 'unsupported-wallet':
      return (
        <section className="room room-unsupported">
          <h2>{COPY.unsupported.title}</h2>
          <p>{COPY.unsupported.body}</p>
          {connectState.walletApiVersion ? (
            <p className="room-detail">Wallet API {connectState.walletApiVersion}</p>
          ) : null}
          <button type="button" onClick={() => void connect.recheck()}>
            {COPY.unsupported.action}
          </button>
        </section>
      );

    case 'not-registered':
      return (
        <section className="room room-not-registered">
          <h2>{COPY.notRegistered.title}</h2>
          <p>{COPY.notRegistered.body}</p>
          <p className="room-detail">{COPY.notRegistered.hint}</p>
          <button type="button" onClick={() => void connect.recheck()}>
            {COPY.notRegistered.action}
          </button>
        </section>
      );

    case 'unreachable':
      return (
        <section className="room room-unreachable">
          <h2>{COPY.unreachable.title}</h2>
          <p>{COPY.unreachable.body}</p>
          <button type="button" onClick={() => void connect.recheck()}>
            {COPY.unreachable.action}
          </button>
        </section>
      );

    case 'connected':
      return null;

    case 'disconnected':
      if (wallet) return WalletSelection({ wallet, detect: () => connect.connect(), isMounted });
      return (
        <section className="room room-connect">
          <h2>{COPY.connect.title}</h2>
          <p>{COPY.connect.body}</p>
          <button type="button" onClick={() => void connect.connect()}>
            {COPY.connect.action}
          </button>
        </section>
      );
  }
}

function WalletSelection({
  wallet,
  detect,
  isMounted,
}: {
  wallet: Pick<WalletSessionRuntime, 'snapshot' | 'connect' | 'refreshDiscovery'>;
  detect: ConnectFlow['connect'];
  isMounted?: () => boolean;
}) {
  const { snapshot } = wallet;
  if (snapshot.phase === 'connecting' || snapshot.phase === 'connected') {
    return (
      <section className="room room-connect" aria-busy="true">
        <h2>{COPY.connect.title}</h2>
        <p>{COPY.connect.connecting}</p>
      </section>
    );
  }
  const body = snapshot.phase === 'wrong-network'
    ? COPY.connect.wrongNetwork
    : snapshot.wallets.length === 0
      ? COPY.connect.none
      : COPY.connect.body;
  return (
    <section className="room room-connect">
      <h2>{COPY.connect.choose}</h2>
      <p>{body}</p>
      {snapshot.wallets.map((choice) => (
        <button
          type="button"
          key={choice.key}
          onClick={async () => {
            try {
              await wallet.connect(choice.key);
              if (isMounted && !isMounted()) return;
              await detect();
            } catch {
              // The session publishes a sanitized failed/wrong-network state.
            }
          }}
        >
          {choice.name}
        </button>
      ))}
      <button type="button" onClick={() => wallet.refreshDiscovery()}>
        {COPY.connect.refreshWallets}
      </button>
    </section>
  );
}
