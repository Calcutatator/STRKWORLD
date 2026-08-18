import { COPY } from '../copy.js';
import type { ReactNode } from 'react';

/**
 * The commit point, and the only place a confirm button exists.
 *
 * `disclosures` is a required prop rendered immediately above the button, so
 * the approved copy for what is being signed cannot be off screen at the moment
 * it is signed. The earlier arrangement put the disclosure in the panel header,
 * keyed to whichever control the player last touched — queue a shield, click
 * the transfer tab, and the header disclosure unmounted while the shield stayed
 * queued and confirmable. The player then committed a public deposit with the
 * approved copy nowhere on screen, which is precisely the silent downgrade
 * D-020 and D-024 exist to prevent.
 *
 * Anything that needs a confirm button renders this. That is the enforcement:
 * a new panel cannot ship a confirm button without passing the disclosures for
 * what it is about to commit.
 */
export function ConfirmGate({
  disclosures,
  requiresDisclosure,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  /** Approved copy for the routes in the batch being committed, verbatim. */
  disclosures: readonly string[];
  /**
   * Whether the batch contains a below-private route. With no disclosures for
   * such a batch, this gate refuses to enable the button: the register already
   * makes an undisclosed deviation unplayable, so arriving here means something
   * between the register and the screen dropped the copy, and confirming would
   * be the silent downgrade with extra steps.
   */
  requiresDisclosure: boolean;
  /** True while the submission is in flight. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Immutable review figures belong at the same commit point as the button. */
  children?: ReactNode;
}) {
  const missingDisclosure = requiresDisclosure && disclosures.length === 0;

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

      {missingDisclosure ? (
        <p className="confirm-blocked" role="alert">
          {COPY.notices.disclosureMissing}
        </p>
      ) : null}

      <button
        type="button"
        className="confirm"
        onClick={onConfirm}
        disabled={busy || missingDisclosure}
      >
        {COPY.flow.confirm}
      </button>
      <button type="button" className="cancel" onClick={onCancel} disabled={busy}>
        {COPY.flow.cancel}
      </button>
    </div>
  );
}
