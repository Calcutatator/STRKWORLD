import { COPY } from '../copy.js';
import { usePrivacy } from '../privacy/PrivacyProvider.js';

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
