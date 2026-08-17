import type { ReactNode } from 'react';
import { COPY } from '../copy.js';

/**
 * The chrome every building panel sits in.
 *
 * The disclosure slot is the reason this is a shared frame rather than a
 * per-panel layout. Approved disclosure copy is rendered here, verbatim, from
 * the string the caller read out of the privacy register (D-024) — a panel
 * cannot forget to show one, and cannot quietly reword the one it shows.
 */
export function PanelFrame({
  title,
  disclosure,
  onClose,
  closingNote = null,
  children,
  footer,
}: {
  title: string;
  /** Canonical approved copy, or null for a route graded `private`. */
  disclosure: string | null;
  onClose: () => void;
  /**
   * Shown next to the close control when closing has a consequence worth
   * stating — a wallet mid-signature, for instance.
   *
   * The control stays enabled on purpose. A disabled close traps the player
   * behind a wallet that may never answer, and it would be theatre anyway: the
   * world can unmount this panel without asking. The receipt ledger is what
   * actually makes closing safe; this is the sentence that says so.
   */
  closingNote?: string | null;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="panel" aria-label={title}>
      <header className="panel-header">
        <h2>{title}</h2>
        <button type="button" className="panel-close" onClick={onClose}>
          {COPY.flow.close}
        </button>
        {closingNote ? (
          <p className="panel-closing-note" role="note">
            {closingNote}
          </p>
        ) : null}
      </header>

      {disclosure ? (
        <p className="panel-disclosure" data-testid="disclosure" role="note">
          {disclosure}
        </p>
      ) : null}

      <div className="panel-body">{children}</div>

      {footer ? <footer className="panel-footer">{footer}</footer> : null}
    </section>
  );
}
