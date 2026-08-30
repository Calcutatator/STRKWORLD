import { COPY } from '../../copy.js';
import { BankPanel } from '../bank/BankPanel.js';
import type { BankMode } from '../bank/bank-machine.js';
import type { RouteGrade } from '../../privacy/register.js';

type PostOfficePanelProps = { onClose: () => void; register?: readonly RouteGrade[] };
const POST_OFFICE_MENU_MODES: readonly BankMode[] = ['transfer'];

/**
 * The Post Office's Menu Mode surface is intentionally a semantic adapter,
 * not another financial state machine. It narrows the existing Bank machine
 * to the one approved Post Office route while retaining its batching,
 * recipient preflight, commit gate, receipts and uncertainty handling.
 */
export function PostOfficePanel({ onClose, register }: PostOfficePanelProps) {
  return (
    <BankPanel
      onClose={onClose}
      experience="menu"
      allowedModes={POST_OFFICE_MENU_MODES}
      initialMode="transfer"
      register={register}
      title={COPY.buildings['post-office']}
      building="post-office"
    />
  );
}
