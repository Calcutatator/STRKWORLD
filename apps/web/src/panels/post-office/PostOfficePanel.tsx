import { COPY } from '../../copy.js';
import { BankPanel } from '../bank/BankPanel.js';
import type { RouteGrade } from '../../privacy/register.js';

type PostOfficePanelProps = { onClose: () => void; register?: readonly RouteGrade[] };

/**
 * The Post Office's Menu Mode surface is intentionally a semantic adapter,
 * not another financial state machine. It narrows the existing Bank machine
 * to the one approved Post Office route while retaining its recipient
 * preflight, commit gate, receipts and uncertainty handling. Since D-099 the
 * Post Office is the one place to send privately: the Bank has no transfer.
 */
export function PostOfficePanel({ onClose, register }: PostOfficePanelProps) {
  return (
    <BankPanel
      onClose={onClose}
      experience="menu"
      mode="transfer"
      register={register}
      title={COPY.buildings['post-office']}
      building="post-office"
      intro={COPY.postOffice.intro}
    />
  );
}
