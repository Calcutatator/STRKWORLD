import { COPY } from '../copy.js';
import { isRouteOpen } from '../panels/routes.js';

/**
 * The "first route" steps this build can actually walk.
 *
 * The guide never sends a player to a door this build keeps shut: each step
 * appears only while its route is open under the privacy register and the
 * build's wallet policy — the same rule the next-step prompts follow. The
 * Bridge step needs the Bank's shield too, because a Bridge arrival only leads
 * anywhere once it can be shielded (D-021, D-061).
 */
export function guideRouteSteps(open: (routeId: string) => boolean = (routeId) => isRouteOpen(routeId)): readonly string[] {
  const steps: string[] = [];
  const shield = open('bank.shield');
  if (shield && open('bridge.deposit')) steps.push(COPY.guide.route.bridge);
  if (shield) steps.push(COPY.guide.route.bank);
  const swap = open('exchange.swap');
  const send = open('post-office.transfer');
  if (swap && send) steps.push(COPY.guide.route.swapOrSend);
  else if (swap) steps.push(COPY.guide.route.swap);
  else if (send) steps.push(COPY.guide.route.send);
  return steps;
}
