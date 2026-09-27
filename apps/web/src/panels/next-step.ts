import type { Intent } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { catalogAsset } from './exchange/catalog.js';
import { ROUTE_BY_INTENT_KIND, isRouteOpen, routeReturnsToPool } from './routes.js';

/**
 * What to suggest once a receipt has settled.
 *
 * D-021's hook comes first: a route whose register entry has `returnToPool`
 * leaves value sitting in public, so its only next step is the way back into
 * the pool — a prompt, never an automation. Every other suggestion points
 * onward, and only at a route whose door is open, so a prompt never walks the
 * player up to a locked door.
 *
 * Silence beats a half-truth. A mixed batch gets no suggestion (the Bank can
 * settle a private transfer and a public unshield together, and a wrap-up for
 * one would misdescribe the other). An unshield gets none: the player chose
 * to leave the pool. A swap is sent on from the Post Office only when it
 * bought STRK, because the Post Office sends the pool's own STRK and nothing
 * else (`bank-machine.ts` composes every transfer in the pool's fee token).
 */
export function nextStepAfterIntents(
  intents: readonly Intent[],
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): string | null {
  const routes = new Set<string>();
  for (const intent of intents) {
    const route = routeFor(intent);
    // An intent the register cannot name says nothing about what comes next.
    if (!route) return null;
    routes.add(route);
  }
  if (routes.size !== 1) return null;
  const [route] = [...routes] as [string];

  if (routeReturnsToPool(route, register)) {
    return isRouteOpen('bank.shield', register) ? COPY.next.shieldAtBank : null;
  }

  switch (route) {
    case 'bank.shield': {
      const swap = isRouteOpen('exchange.swap', register);
      const send = isRouteOpen('post-office.transfer', register);
      if (swap && send) return COPY.next.afterShield;
      if (send) return COPY.next.afterShieldSend;
      if (swap) return COPY.next.afterShieldSwap;
      return null;
    }
    case 'exchange.swap':
      return isRouteOpen('post-office.transfer', register) && intents.every(boughtStrk)
        ? COPY.next.afterSwap
        : null;
    case 'post-office.transfer':
      return COPY.next.afterTransfer;
    // The minted xSTRK is already a pool note (`returnToPool: false`), and no
    // other counter takes xSTRK yet (D-042's catalog is fixed), so there is
    // nowhere onward to point.
    case 'bank.stake':
      return COPY.next.afterStake;
    default:
      return null;
  }
}

/**
 * Whether a settled Bridge arrival should be nudged towards the Bank at all:
 * the register must still say the Bridge returns value to the pool (D-021),
 * and the shield it points at must be an open door.
 */
export function offersBridgeArrival(register: readonly RouteGrade[] = PRIVACY_REGISTER): boolean {
  return routeReturnsToPool('bridge.deposit', register) && isRouteOpen('bank.shield', register);
}

function routeFor(intent: Intent): string | undefined {
  const kind: unknown = intent?.kind;
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ROUTE_BY_INTENT_KIND, kind)
    ? ROUTE_BY_INTENT_KIND[kind as Intent['kind']]
    : undefined;
}

function boughtStrk(intent: Intent): boolean {
  return intent.kind === 'swap' && catalogAsset(intent.tokenOut)?.symbol === 'STRK';
}
