import type { ReactNode } from 'react';
import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../copy.js';

/**
 * The chrome every building panel sits in.
 *
 * It carries one optional note slot: the route's pre-commit line from the
 * privacy register, when it has one. That line is product copy (D-118).
 */
export function PanelFrame({
  title,
  building,
  brand,
  disclosure,
  onClose,
  closingNote = null,
  children,
  footer,
  counters = null,
}: {
  title: string;
  /**
   * Presentation only: picks this window's visual theme in `styles.css`
   * (`.panel[data-building]`). It never gates a route or changes a control.
   */
  building?: BuildingId;
  /**
   * Presentation only: a look worn by one counter inside a building, over the
   * building's own theme (`.panel[data-brand]`) — the Bank's Endur staking
   * counter (D-063) and the Exchange's degen floor (D-067). It never gates a
   * route or changes a control.
   */
  brand?: 'endur' | 'degen';
  /** The route's pre-commit line from the register, or null for none. */
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
  /**
   * Presentation only: Menu Mode's row of counter tabs (D-088), shown above
   * the window's disclosure so the disclosure always reads as the chosen
   * counter's own. It never gates a route or changes a control.
   */
  counters?: ReactNode;
}) {
  return (
    <section className="panel" aria-label={title} data-building={building} data-brand={brand}>
      <div className="panel-card">
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

        {counters ? <div className="panel-counters">{counters}</div> : null}

        {disclosure ? (
          <p className="panel-disclosure" data-testid="disclosure" role="note">
            {disclosure}
          </p>
        ) : null}

        <div className="panel-body">{children}</div>

        {footer ? <footer className="panel-footer">{footer}</footer> : null}
      </div>
    </section>
  );
}
