import { useEffect, useState, type ReactNode } from 'react';
import { COPY } from '../../copy.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { PanelFrame } from '../PanelFrame.js';
import { useEndurRate } from './endur-rate.js';
import { UnstakeCounter } from './UnstakeCounter.js';

/**
 * The Bank's UNSTAKE counter (D-103): Endur's unstaking (D-085), its request,
 * the pending requests and the claim, in a window of its own and in Endur's
 * look, as the STAKE counter beside it is.
 *
 * `UnstakeCounter` is unchanged: its own machine, route doors, review and
 * `ConfirmGate`. This window only gives it what the staking view used to
 * hand it: xSTRK's live rate (one public read while it is open, D-091) and
 * the pool fee for the preview row, read once from the pool's config, an
 * ordinary chain read that asks no wallet. Like the stake route's, the header
 * carries no disclosure: the unstake routes' approved disclosures are at the
 * commit point, inside `ConfirmGate`.
 */
export function UnstakePanel({
  onClose,
  register = PRIVACY_REGISTER,
  experience = 'menu',
  counters = null,
}: {
  onClose: () => void;
  register?: readonly RouteGrade[];
  /** Presentation only: the counter and Menu Mode render the same window. */
  experience?: 'menu' | 'station';
  /** Menu Mode's counter tabs (D-088, D-103); presentation only. */
  counters?: ReactNode;
}) {
  const { operations } = usePrivacy();
  const rate = useEndurRate(operations, true);
  const [poolFee, setPoolFee] = useState<bigint | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    operations.poolConfig(controller.signal).then(
      (pool) => {
        if (!controller.signal.aborted) setPoolFee(pool.feeAmount);
      },
      () => {
        // No fee row rather than a guessed one; the review shows the exact fee.
      },
    );
    return () => controller.abort();
  }, [operations]);

  return (
    <div className="bank-experience" data-experience={experience} data-mode="unstake">
      <PanelFrame title={COPY.bank.title} building="bank" brand="endur" disclosure={null} onClose={onClose} counters={counters}>
        <UnstakeCounter register={register} rate={rate} poolFee={poolFee} />
      </PanelFrame>
    </div>
  );
}
