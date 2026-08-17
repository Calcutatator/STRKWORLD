import type { Intent } from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { PRIVACY_REGISTER, isRoutePlayable, type RouteGrade } from '../privacy/register.js';
import { COPY } from '../copy.js';

/**
 * What the shell is allowed to open, and what it must say when it does.
 *
 * The privacy register in `packages/shared` is the single source of truth for
 * both halves (D-020, D-024): whether a route may be offered at all, and the
 * exact approved words shown to the player. This module reads it and does not
 * restate it — a paraphrase here would be a privacy claim that no project lead
 * approved.
 *
 * Everything fails closed. An id the register does not carry is a locked door,
 * not a default-open one, because the register is what CI checks and a route
 * that is not in it has not been graded.
 */

export type LockReason = 'coming-soon' | 'unapproved-route' | 'unknown-route';

export interface DoorState {
  open: boolean;
  reason: LockReason | null;
  /** Player-facing explanation. Empty when the door is open. */
  message: string;
}

const OPEN: DoorState = { open: true, reason: null, message: '' };

function locked(reason: LockReason): DoorState {
  const message =
    reason === 'coming-soon'
      ? COPY.locked.comingSoon
      : reason === 'unapproved-route'
        ? COPY.locked.unapprovedRoute
        : COPY.locked.unknownRoute;
  return { open: false, reason, message };
}

export function findRoute(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): RouteGrade | undefined {
  return register.find((entry) => entry.route === routeId);
}

/**
 * The approved disclosure for a route, verbatim.
 *
 * `null` means the register says none is needed — the route is graded
 * `private`. Callers must check `routeDoor` first; an unknown route also
 * returns `null` here and must never be rendered as "nothing to disclose".
 */
export function routeDisclosure(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): string | null {
  return findRoute(routeId, register)?.disclosure ?? null;
}

export function routeDoor(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): DoorState {
  const entry = findRoute(routeId, register);
  if (!entry) return locked('unknown-route');
  return isRoutePlayable(entry) ? OPEN : locked('unapproved-route');
}

export function isRouteOpen(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): boolean {
  return routeDoor(routeId, register).open;
}

export function buildingRoutes(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): readonly RouteGrade[] {
  return register.filter((entry) => entry.building === building);
}

/**
 * Whether a building's door opens at all.
 *
 * A building with no graded route is `coming-soon` — the Vault in v1 (D-007).
 * A building whose every route is an unapproved or undisclosed deviation is
 * locked for that reason instead, which is a different sentence to a player and
 * a very different situation to us.
 */
export function buildingDoor(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): DoorState {
  const routes = buildingRoutes(building, register);
  if (routes.length === 0) return locked('coming-soon');
  return routes.some((entry) => isRoutePlayable(entry)) ? OPEN : locked('unapproved-route');
}

/**
 * Which graded route executes a given intent.
 *
 * The register grades the private transfer once, under the Post Office; the
 * Bank's transfer control drives that same pool-native route rather than
 * inventing an id the project lead never graded.
 */
export const ROUTE_BY_INTENT_KIND: Record<Intent['kind'], string> = {
  shield: 'bank.shield',
  unshield: 'bank.unshield',
  transfer: 'post-office.transfer',
  swap: 'exchange.swap',
};

/**
 * The approved disclosures for the intents actually queued, de-duplicated.
 *
 * Derived from the batch rather than from whatever control the player last
 * touched. A player who queues a shield and then switches tab is still about
 * to commit a public deposit, and must still be told so at the moment they
 * commit — which is why the commit surface renders this, not the tab.
 */
export function disclosuresForIntents(
  intents: readonly Intent[],
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): readonly string[] {
  const seen = new Set<string>();
  for (const intent of intents) {
    const disclosure = routeDisclosure(ROUTE_BY_INTENT_KIND[intent.kind], register);
    if (disclosure) seen.add(disclosure);
  }
  return [...seen];
}

/**
 * Whether any route in the batch is a below-private deviation.
 *
 * The register already refuses to make an undisclosed deviation playable, so
 * `disclosures` being empty for such a batch means something between the
 * register and the screen has gone wrong. The commit gate uses this to fail
 * closed on that combination rather than trusting the chain that produced it.
 */
export function batchRequiresDisclosure(
  intents: readonly Intent[],
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): boolean {
  return intents.some((intent) => {
    const entry = findRoute(ROUTE_BY_INTENT_KIND[intent.kind], register);
    // An unknown route is not a "no disclosure needed" answer.
    return entry === undefined || entry.grade !== 'private';
  });
}

/** Routes that leave value sitting in public and must offer the way back (D-021). */
export function routeReturnsToPool(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): boolean {
  return findRoute(routeId, register)?.returnToPool ?? false;
}
