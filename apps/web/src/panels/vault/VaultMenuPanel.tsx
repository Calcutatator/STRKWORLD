import type { WalletRoutePolicy } from '@strkworld/privacy';
import { detectRoutePolicy } from '../../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { BorrowPanel } from '../borrow/BorrowPanel.js';
import { menuCounters, useMenuCounter } from '../MenuCounters.js';
import { VaultPanel } from './VaultPanel.js';

/**
 * The Vault's Menu Mode (D-088): the SUPPLY / REDEEM window it always had
 * (D-077), and the BORROW window (D-083) beside it whenever this build would
 * open the BORROW counter in Game Mode. Both are the counters' own windows
 * and machines, unchanged; this only chooses which one is mounted. With
 * borrowing off, the Vault's Menu Mode is exactly the one window it was.
 */
export function VaultMenuPanel({
  onClose,
  register = PRIVACY_REGISTER,
  policy = detectRoutePolicy(),
}: {
  onClose: () => void;
  register?: readonly RouteGrade[];
  /** The build's route policy; tests pass one, production reads the build's. */
  policy?: WalletRoutePolicy | null;
}) {
  const counters = menuCounters('vault', ['vault:lending', 'vault:borrow'], register, policy);
  const { active, tabs } = useMenuCounter(counters);
  if (active === 'vault:borrow') {
    return <BorrowPanel experience="menu" register={register} onClose={onClose} counters={tabs} />;
  }
  return <VaultPanel experience="menu" register={register} onClose={onClose} counters={tabs} />;
}
