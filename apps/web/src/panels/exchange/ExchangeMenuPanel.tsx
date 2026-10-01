import type { WalletRoutePolicy } from '@strkworld/privacy';
import { detectRoutePolicy } from '../../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { menuCounters, useMenuCounter } from '../MenuCounters.js';
import { ExchangePanel } from './ExchangePanel.js';

/**
 * The Exchange's Menu Mode (D-088): the ground floor's swap (D-042) and the
 * degen floor's (D-067), whenever this build would open the DEGEN SWAP
 * counter. One `ExchangePanel` either way, with the same machine, quote
 * review, price check and unpriced-token acknowledgement (D-084), and the
 * same `exchange.swap` disclosure; only the list and the look differ, as
 * upstairs. Still one swap at a time, with no batch vocabulary (D-042).
 */
export function ExchangeMenuPanel({
  onClose,
  register = PRIVACY_REGISTER,
  policy = detectRoutePolicy(),
}: {
  onClose: () => void;
  register?: readonly RouteGrade[];
  /** The build's route policy; tests pass one, production reads the build's. */
  policy?: WalletRoutePolicy | null;
}) {
  const counters = menuCounters('exchange', ['exchange:swap', 'exchange:degen'], register, policy);
  const { active, tabs } = useMenuCounter(counters);
  // Keyed by floor: the degen floor's machine is built over its own list, so
  // a switch mounts a fresh window rather than reusing the other's machine.
  const mode = active === 'exchange:degen' ? 'degen' : 'ground';
  return <ExchangePanel key={mode} experience="menu" mode={mode} register={register} onClose={onClose} counters={tabs} />;
}
