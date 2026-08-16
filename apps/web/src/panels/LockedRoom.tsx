import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { PanelFrame } from './PanelFrame.js';
import type { LockReason } from './routes.js';

/**
 * A locked door.
 *
 * This is the designed outcome when a route is missing, unapproved or
 * undisclosed — not a failure and not a degraded version of the room. There is
 * deliberately nothing on this screen that offers a public way to do the same
 * thing: an unshield-and-call fallback is exactly what D-018 forbids, and a
 * "continue anyway" link is how a privacy claim gets broken by accident.
 */
export function LockedRoom({
  building,
  reason,
  message,
  onClose,
}: {
  building: BuildingId;
  reason: LockReason;
  message: string;
  onClose: () => void;
}) {
  return (
    <PanelFrame title={COPY.buildings[building]} disclosure={null} onClose={onClose}>
      <p className="room-locked" data-lock-reason={reason}>
        {message}
      </p>
    </PanelFrame>
  );
}

/** A building that is graded and approved, but whose room is not written yet. */
export function UnbuiltRoom({
  building,
  message,
  onClose,
}: {
  building: BuildingId;
  message: string;
  onClose: () => void;
}) {
  return (
    <PanelFrame title={COPY.buildings[building]} disclosure={null} onClose={onClose}>
      <p className="room-unbuilt">{message}</p>
    </PanelFrame>
  );
}
