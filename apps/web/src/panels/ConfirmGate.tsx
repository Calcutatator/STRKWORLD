import { COPY } from '../copy.js';
import type { ReactNode } from 'react';

/**
 * The commit point, and the only place a confirm button exists.
 *
 * `disclosures` holds the register's pre-commit lines for the batch being
 * committed, if any, rendered immediately above the button so a line about
 * what is being signed sits with the button rather than with whichever tab
 * was touched last. The lines are product copy and optional (D-118): an empty
 * list is not an error and never blocks the button.
 */
export function ConfirmGate({
  disclosures,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  /** The register's pre-commit lines for the routes in the batch, if any. */
  disclosures: readonly string[];
  /** True while the submission is in flight. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Immutable review figures belong at the same commit point as the button. */
  children?: ReactNode;
}) {
  return (
    <div className="confirm-gate">
      {children}
      {disclosures.length > 0 ? (
        <ul className="commit-disclosures" data-testid="commit-disclosures">
          {disclosures.map((disclosure) => (
            <li key={disclosure}>{disclosure}</li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        className="confirm"
        onClick={onConfirm}
        disabled={busy}
      >
        {COPY.flow.confirm}
      </button>
      <button type="button" className="cancel" onClick={onCancel} disabled={busy}>
        {COPY.flow.cancel}
      </button>
    </div>
  );
}
