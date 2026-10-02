import type { WalletRoutePolicy } from '@strkworld/privacy';
import { detectRoutePolicy } from '../../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { stationDefinition } from '../../visits/station-registry.js';
import { CounterWindow } from '../CounterWindow.js';
import { menuCounters, useMenuCounter } from '../MenuCounters.js';

/** The Vault's four counters (D-099), in the room's order, west to east. */
export const VAULT_COUNTERS = Object.freeze(['vault:supply', 'vault:redeem', 'vault:borrow', 'vault:repay'] as const);

/**
 * The Vault's Menu Mode (D-088, D-099): the four counters of its Game Mode
 * room as tabs, SUPPLY · REDEEM · BORROW · REPAY. SUPPLY is always offered
 * (D-077: the Vault's own window); each other tab only while its counter
 * would open in this build, so with borrowing off BORROW and REPAY are
 * hidden. Each is the counter's own window and machine, unchanged; only the
 * chosen one is mounted, so only one confirm is ever on screen.
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
  const counters = menuCounters('vault', VAULT_COUNTERS, register, policy);
  const { active, tabs } = useMenuCounter(counters);
  const definition = stationDefinition('vault', active);
  if (!definition) return null;
  return <CounterWindow definition={definition} experience="menu" register={register} onClose={onClose} counters={tabs} />;
}
