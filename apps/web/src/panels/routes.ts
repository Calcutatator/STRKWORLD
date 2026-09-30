import type { Intent, WalletRoutePolicy } from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { PRIVACY_REGISTER, isDisclosureWaived, isRoutePlayable, type RouteGrade } from '../privacy/register.js';
import { COPY } from '../copy.js';
import { sameAddress } from '../format.js';
import { STRK_TOKEN, detectRoutePolicy } from '../production/config.js';

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

export type LockReason =
  | 'coming-soon'
  | 'unapproved-route'
  | 'unknown-route'
  | 'capability-unavailable'
  /** Approved by the privacy register, but this build's wallet policy has not switched it on (D-054/D-056). */
  | 'not-enabled';

const ROUTE_GRADE_FIELDS = [
  'building',
  'route',
  'grade',
  'observable',
  'disclosure',
  'approvedBy',
  'approvedOn',
  'rationale',
  'returnToPool',
] as const;

function isOwnRouteGrade(entry: unknown): entry is RouteGrade {
  if (entry === null || typeof entry !== 'object') return false;
  return ROUTE_GRADE_FIELDS.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(entry, field);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

function isRouteRegister(value: unknown): value is readonly RouteGrade[] {
  return Array.isArray(value);
}

export interface DoorState {
  open: boolean;
  reason: LockReason | null;
  /** Player-facing explanation. Empty when the door is open. */
  message: string;
}

const OPEN: DoorState = Object.freeze({ open: true, reason: null, message: '' });

/** @param message Override the reason's default copy — the Vault's coming-soon line, or a route-specific not-enabled line. */
function locked(reason: LockReason, message?: string): DoorState {
  const resolved =
    message ??
    (reason === 'coming-soon'
      ? COPY.locked.comingSoon
      : reason === 'unapproved-route'
        ? COPY.locked.unapprovedRoute
        : reason === 'capability-unavailable'
          ? COPY.bridge.unavailable
          : reason === 'not-enabled'
            ? COPY.locked.notEnabled.generic
            : COPY.locked.unknownRoute);
  return Object.freeze({ open: false, reason, message: resolved });
}

export function findRoute(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): RouteGrade | undefined {
  if (!isRouteRegister(register)) return undefined;
  return register.find((entry) => isOwnRouteGrade(entry) && entry.route === routeId);
}

/**
 * The approved disclosure for a route, verbatim.
 *
 * `null` means the register says none is needed — the route is graded
 * `private`, or the lead waived its disclosure by decision (D-064, D-065).
 * Callers must check `routeDoor` first; an unknown route also returns `null`
 * here and must never be rendered as "nothing to disclose".
 */
export function routeDisclosure(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): string | null {
  return findRoute(routeId, register)?.disclosure ?? null;
}

/**
 * Whether a route may be offered, and why not when it may not.
 *
 * Two independent gates, checked in order. The privacy register says whether
 * a route is approved and disclosed at all (D-020) — fail here and the door
 * is a hard "no", the same for every build. Passing that, the active wallet
 * policy says whether *this build* has actually switched the route on
 * (D-054/D-056): production never enables swap today, and each of shield,
 * transfer, unshield (D-062) and stake (D-063) stays off unless this build's
 * own fail-closed configuration switches it on, independently of the others.
 * `policy` defaults to this build's live policy, or `null` outside production
 * (demo, tests) where there is no policy to disable anything — every
 * register-approved route stays open, exactly as before this gate existed.
 */
export function routeDoor(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): DoorState {
  const entry = findRoute(routeId, register);
  if (!entry) return locked('unknown-route');
  if (!isRoutePlayable(entry)) return locked('unapproved-route');
  if (!isPolicyEnabledRoute(routeId, policy)) return notEnabledDoor(routeId);
  return OPEN;
}

export function isRouteOpen(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): boolean {
  return routeDoor(routeId, register, policy).open;
}

export function buildingRoutes(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): readonly RouteGrade[] {
  if (!isRouteRegister(register)) return [];
  return register.filter((entry) => isOwnRouteGrade(entry) && entry.building === building);
}

/**
 * Whether a building's door opens at all.
 *
 * A building with no graded route is `coming-soon` — the Vault was, until
 * D-077 graded its two routes. A building whose every route is an unapproved
 * or undisclosed deviation is locked for that reason instead, which is a
 * different sentence to a player and a very different situation to us. This
 * is the register's answer only: whether this build switched a route on is
 * `routeDoor`'s, and the Vault's street door itself follows `vaultDoorOpen`.
 */
export function buildingDoor(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): DoorState {
  const routes = buildingRoutes(building, register);
  if (routes.length === 0) {
    // "Coming soon" is shared copy for every unbuilt building, except the one
    // the player is most likely to ask about by name: give the Vault its own
    // line rather than the generic one every other never-built building uses.
    return locked('coming-soon', building === 'vault' ? COPY.vault.locked : undefined);
  }
  return routes.some((entry) => isRoutePlayable(entry)) ? OPEN : locked('unapproved-route');
}

/**
 * Which graded route executes a given intent.
 *
 * The register grades the private transfer once, under the Post Office; the
 * Bank's transfer control drives that same pool-native route rather than
 * inventing an id the project lead never graded. Endur staking is its own
 * Bank route (D-063), graded apart from shielding so no station mixes grades.
 */
export const ROUTE_BY_INTENT_KIND: Readonly<Record<Intent['kind'], string>> = Object.freeze({
  shield: 'bank.shield',
  unshield: 'bank.unshield',
  transfer: 'post-office.transfer',
  swap: 'exchange.swap',
  stake: 'bank.stake',
});

/**
 * The entry gate's deposit (D-072): the Bank's shield on a second surface,
 * graded in the register on its own so its approval is recorded for that
 * surface. `ROUTE_BY_INTENT_KIND` still maps a shield intent to the Bank's
 * route; the gate names this one directly.
 */
export const ENTRY_SHIELD_ROUTE = 'entry.shield';

/**
 * The Vault's two routes (D-077). They are not intents: the Vault has its own
 * seam methods (`vaultPositions`, `prepareVaultSupply`, `prepareVaultRedeem`,
 * `vaultRates`), and one policy route, `vault`, gates both.
 */
export const VAULT_SUPPLY_ROUTE = 'vault.supply';
export const VAULT_REDEEM_ROUTE = 'vault.redeem';
export const VAULT_ROUTES: readonly string[] = Object.freeze([VAULT_SUPPLY_ROUTE, VAULT_REDEEM_ROUTE]);

/** A policy route kind: an intent's, or the Vault's (D-077). */
type PolicyRouteKind = WalletRoutePolicy['enabledRoutes'][number];

/**
 * The inverse of `ROUTE_BY_INTENT_KIND` — which policy route kind, if any,
 * gates a given route id. Written out rather than derived with
 * `Object.fromEntries`, which would widen the value back to `string` and lose
 * the literal union `routeDoor` relies on. The entry gate's deposit is a
 * shield, so the shield policy gates it too, and both Vault routes are gated
 * by the Vault's one policy route: a route missing here would pass the policy
 * check open.
 */
const POLICY_KIND_BY_ROUTE: Readonly<Partial<Record<string, PolicyRouteKind>>> = Object.freeze({
  [ROUTE_BY_INTENT_KIND.shield]: 'shield',
  [ROUTE_BY_INTENT_KIND.unshield]: 'unshield',
  [ROUTE_BY_INTENT_KIND.transfer]: 'transfer',
  [ROUTE_BY_INTENT_KIND.swap]: 'swap',
  [ROUTE_BY_INTENT_KIND.stake]: 'stake',
  [ENTRY_SHIELD_ROUTE]: 'shield',
  [VAULT_SUPPLY_ROUTE]: 'vault',
  [VAULT_REDEEM_ROUTE]: 'vault',
});

/**
 * Whether the Vault's door opens in this build (D-077): both of its routes
 * approved and disclosed in the register, and switched on by the build's own
 * fail-closed policy (`VITE_STRK20_VAULT_*`). The Shell tells the World once,
 * at composition, and a closed answer keeps D-007's locked facade exactly as
 * it was. Outside production there is no policy, so the register alone
 * decides, and the demo's fake runs the Vault.
 */
export function vaultDoorOpen(
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): boolean {
  return VAULT_ROUTES.every((route) => routeDoor(route, register, policy).open);
}

/**
 * Whether the active wallet policy admits a route.
 *
 * A route the policy has no opinion about — the Bridge's `bridge.deposit`,
 * which never goes through `PrivacyOperations.prepare` — is not this gate's
 * business and passes through open. `policy: null` means this build never
 * constructed one (demo, tests): nothing is disabled beyond the register.
 *
 * Since D-072 a build may admit shield tokens other than STRK. The Bank's own
 * shield control deposits STRK, the pool's money and fee token (D-013), so its
 * door also needs STRK on the list; the entry gate's `entry.shield` takes any
 * admitted token and chooses from the list itself.
 */
function isPolicyEnabledRoute(routeId: string, policy: WalletRoutePolicy | null): boolean {
  if (!policy) return true;
  const kind = POLICY_KIND_BY_ROUTE[routeId];
  if (!kind) return true;
  if (!policy.enabledRoutes.includes(kind)) return false;
  // The Vault lends STRK alone (D-077): its list must name it.
  if (kind === 'vault') return admitsStrk(policy.allowedTokens.vault ?? []);
  return routeId !== ROUTE_BY_INTENT_KIND.shield || admitsStrk(policy.allowedTokens.shield);
}

function admitsStrk(tokens: readonly string[]): boolean {
  return Array.isArray(tokens) && tokens.some((token) => sameAddress(token, STRK_TOKEN));
}

/** A route-specific "not switched on in this build" door, falling back to a generic line for an unmapped route id. */
function notEnabledDoor(routeId: string): DoorState {
  const kind = POLICY_KIND_BY_ROUTE[routeId];
  return locked('not-enabled', kind ? COPY.locked.notEnabled[kind] : undefined);
}

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
 * The one exception is a deviation whose disclosure the lead waived by
 * decision (D-064 for staking, D-065 for the transfer): it needs none, and
 * must not block the commit.
 */
export function batchRequiresDisclosure(
  intents: readonly Intent[],
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): boolean {
  return intents.some((intent) => {
    const entry = findRoute(ROUTE_BY_INTENT_KIND[intent.kind], register);
    // An unknown route is not a "no disclosure needed" answer.
    return entry === undefined || (entry.grade !== 'private' && !isDisclosureWaived(entry));
  });
}

/**
 * Whether committing on one route needs its disclosure on screen: the
 * route-level twin of `batchRequiresDisclosure`, for a surface that commits
 * one registered route by name (the entry gate, D-072). An unknown route
 * fails closed.
 */
export function routeRequiresDisclosure(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): boolean {
  const entry = findRoute(routeId, register);
  return entry === undefined || (entry.grade !== 'private' && !isDisclosureWaived(entry));
}

/** Routes that leave value sitting in public and must offer the way back (D-021). */
export function routeReturnsToPool(
  routeId: string,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): boolean {
  return findRoute(routeId, register)?.returnToPool ?? false;
}
