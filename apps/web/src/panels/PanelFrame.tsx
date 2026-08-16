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
  children,
  footer,
}: {
  title: string;
  /** Canonical approved copy, or null for a route graded `private`. */
  disclosure: string | null;
  onClose: () => void;
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
