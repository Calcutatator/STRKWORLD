import { COPY } from '../copy.js';

/**
 * The pool does not know this account yet (error 118), and only the wallet
 * can fix that: registration happens inside it, and STRKWORLD cannot do it
 * for the player (SPEC §6).
 *
 * One card for every place the game meets it, folded into the entry gate by
 * D-072. The gate shows it when the deposit itself answers 118, with the
 * balance check, because registering in the wallet often makes a first
 * deposit too and a retry of the deposit could send a second; a building
 * shows it when a later operation answers 118, with the connect flow's
 * recheck. The copy is the same in both.
 */
export function NotRegisteredNotice({ action, onRetry }: { action: string; onRetry: () => void }) {
  return (
    <section className="room room-not-registered" data-testid="not-registered">
      <h2>{COPY.notRegistered.title}</h2>
      <p>{COPY.notRegistered.body}</p>
      <p className="room-detail">{COPY.notRegistered.hint}</p>
      <button type="button" onClick={onRetry}>
        {action}
      </button>
    </section>
  );
}
