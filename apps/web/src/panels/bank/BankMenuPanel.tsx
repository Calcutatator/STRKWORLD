import type { WalletRoutePolicy } from '@strkworld/privacy';
import { detectRoutePolicy } from '../../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { stationDefinition } from '../../visits/station-registry.js';
import { CounterWindow } from '../CounterWindow.js';
import { menuCounters, useMenuCounter } from '../MenuCounters.js';

/** The Bank's four counters (D-099), in the room's order, west to east. */
export const BANK_COUNTERS = Object.freeze(['bank:shielding', 'bank:unshielding', 'bank:staking', 'bank:unstaking'] as const);

/**
 * The Bank's Menu Mode (D-088, D-099): the four counters of its Game Mode
 * room as tabs, SHIELD · UNSHIELD · STAKE · UNSTAKE. SHIELD is always offered
 * (its window still shows its own locked door); each other tab only while its
 * counter would open in this build, so a counter the build leaves off is
 * hidden, as D-088 hides it in every room. Each tab is that counter's own
 * window and machine, one action each; only the chosen one is mounted, so
 * only one confirm is ever on screen. There is no private transfer here: the
 * Post Office is the one place to send privately.
 */
export function BankMenuPanel({
  onClose,
  register = PRIVACY_REGISTER,
  policy = detectRoutePolicy(),
}: {
  onClose: () => void;
  register?: readonly RouteGrade[];
  /** The build's route policy; tests pass one, production reads the build's. */
  policy?: WalletRoutePolicy | null;
}) {
  const counters = menuCounters('bank', BANK_COUNTERS, register, policy);
  const { active, tabs } = useMenuCounter(counters);
  const definition = stationDefinition('bank', active);
  if (!definition) return null;
  return <CounterWindow definition={definition} experience="menu" register={register} onClose={onClose} counters={tabs} />;
}
