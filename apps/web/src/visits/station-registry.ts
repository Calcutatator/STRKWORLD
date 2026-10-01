import type { BuildingId, ShellEvents, StationId } from '@strkworld/shared';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { routeDoor, type DoorState } from '../panels/routes.js';
import type { BankMode } from '../panels/bank/bank-machine.js';
import { COPY } from '../copy.js';
import { detectRoutePolicy } from '../production/config.js';

type BankStationDefinition = {
  station: StationId; building: BuildingId; label: string; routes: readonly string[];
  view: 'bank'; modes: readonly BankMode[]; initialMode: BankMode;
};
type ExchangeStationDefinition = {
  station: StationId; building: 'exchange'; label: string; routes: readonly string[];
  view: 'exchange';
  /** The ground floor's six-asset swap (D-042), or the degen floor's list (D-067). */
  mode: 'ground' | 'degen';
};
type BridgeStationDefinition = {
  station: StationId; building: 'bridge'; label: string; routes: readonly string[];
  view: 'bridge';
};
/**
 * The Vault's lending counter (D-077): supply and redeem behind one door,
 * both `anonymous` in the register, so the station keeps one grade (D-030).
 */
type VaultStationDefinition = {
  station: StationId; building: 'vault'; label: string; routes: readonly string[];
  view: 'vault';
};
/**
 * The Borrow counter (D-083): Vesu loans from a second shadow account, its
 * own counter in the Vault's room because its one route carries its own
 * grade entry and disclosure (liquidation), so no station mixes them (D-030).
 */
type BorrowStationDefinition = {
  station: StationId; building: 'vault'; label: string; routes: readonly string[];
  view: 'borrow';
};
/**
 * The Privacy Plaza's two windows (D-076). No money and no route: `routes`
 * is empty on purpose, so nothing here reaches the privacy register, and
 * the plaza needs no wallet. The station still resolves here before its
 * window opens, and an unknown plaza id stays locked.
 */
type PlazaStationDefinition = {
  station: StationId; building: 'plaza'; label: string; routes: readonly [];
  view: 'plaza-monument' | 'plaza-shells';
};

/**
 * Shell-owned meaning for an opaque station id.
 *
 * None of this crosses into Phaser. The World receives only the preformatted
 * label and lock state; routes, modes and privacy grades stay here with the
 * financial controls they admit (D-033).
 */
export type StationDefinition =
  | BankStationDefinition
  | ExchangeStationDefinition
  | BridgeStationDefinition
  | VaultStationDefinition
  | BorrowStationDefinition
  | PlazaStationDefinition;

export interface StationCapabilities {
  /** The account reader is deliberately coarse: the World only gets a lock bit. */
  bridgeAccountAvailable?: boolean;
  bridgePlannerAvailable?: boolean;
}

function freezeStationDefinition(definition: StationDefinition): StationDefinition {
  Object.freeze(definition.routes);
  if ('modes' in definition) Object.freeze(definition.modes);
  return Object.freeze(definition);
}

const STATIONS: readonly StationDefinition[] = Object.freeze([
  {
    station: 'bank:shielding',
    building: 'bank',
    label: 'SHIELD / UNSHIELD',
    routes: ['bank.shield', 'bank.unshield'],
    modes: ['shield', 'unshield'],
    initialMode: 'shield',
    view: 'bank',
  },
  // Endur staking (D-063) is `anonymous`, shielding is `public-edge`: its own
  // counter, never merged with the one above, so no station mixes grades (D-030).
  {
    station: 'bank:staking',
    building: 'bank',
    label: 'STAKE',
    routes: ['bank.stake'],
    modes: ['stake'],
    initialMode: 'stake',
    view: 'bank',
  },
  {
    station: 'post-office:transfer',
    building: 'post-office',
    label: 'TRANSFER',
    routes: ['post-office.transfer'],
    modes: ['transfer'],
    initialMode: 'transfer',
    view: 'bank',
  },
  {
    station: 'exchange:swap',
    building: 'exchange',
    label: 'SWAP',
    routes: ['exchange.swap'],
    view: 'exchange',
    mode: 'ground',
  },
  // The Exchange tower's degen floor (D-067): the same `exchange.swap` route,
  // grade and disclosure as the counter downstairs, so it opens and locks
  // exactly when that one does; only its token list differs.
  {
    station: 'exchange:degen',
    building: 'exchange',
    label: 'DEGEN SWAP',
    routes: ['exchange.swap'],
    view: 'exchange',
    mode: 'degen',
  },
  {
    station: 'bridge:deposit',
    building: 'bridge',
    label: 'DEPOSIT',
    routes: ['bridge.deposit'],
    view: 'bridge',
  },
  // The Vault (D-077): Vesu lending from the player's shadow account. It
  // opens only when this build switches both of its routes on; otherwise the
  // World keeps the door locked and the player never reaches this counter.
  {
    station: 'vault:lending',
    building: 'vault',
    label: 'SUPPLY / REDEEM',
    routes: ['vault.supply', 'vault.redeem'],
    view: 'vault',
  },
  // D-083: the Borrow counter beside it, behind its own switch
  // (`VITE_STRK20_BORROW_ENABLED`). With the Vault open and borrowing off,
  // the counter stands locked and says so.
  {
    station: 'vault:borrow',
    building: 'vault',
    label: 'BORROW',
    routes: ['vault.borrow'],
    view: 'borrow',
  },
  // The Privacy Plaza (D-076): its stations stand on the street, and open
  // with E. Client-only windows with no route, so no privacy grade applies.
  {
    station: 'plaza:monument',
    building: 'plaza',
    label: 'POOL STATS',
    routes: [],
    view: 'plaza-monument',
  },
  {
    station: 'plaza:shells',
    building: 'plaza',
    label: "WHERE'S THE NOTE?",
    routes: [],
    view: 'plaza-shells',
  },
] as const).map((definition) => freezeStationDefinition(definition));

export type StationResolution =
  | { status: 'available'; definition: StationDefinition }
  | { status: 'locked'; definition: StationDefinition | null; door: DoorState };

/**
 * Resolve again at the interaction boundary. A World snapshot is presentation,
 * never authorization, and an unknown id is always a locked result.
 *
 * A station can bundle more than one route — `bank:shielding` is shield and
 * unshield behind one door. Those two gates disagree in how a locked
 * constituent route should behave: an unapproved or unknown route (the
 * privacy register's business) is a hard stop for the whole station, because
 * an unapproved deviation must never be reachable through a sibling control
 * that happens to be fine. A route the active wallet policy simply has not
 * switched on (D-054/D-056) is softer — that is this deployment's own choice,
 * expected to vary per route (shield enabled while unshield stays off, say;
 * D-062 lets a build switch unshield on too), and the panel behind an
 * otherwise-open station already renders that one control as locked on its
 * own (`BankPanel`'s `ModeTabs`). So the station only locks outright on a
 * policy reason when *every* route it offers is unavailable — there is nothing
 * left inside worth opening the door for.
 */
export function resolveStation(
  building: BuildingId,
  station: StationId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  capabilities: StationCapabilities = {},
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): StationResolution {
  const definition = STATIONS.find(
    (candidate) => candidate.building === building && candidate.station === station,
  );
  if (!definition) {
    return {
      status: 'locked',
      definition: null,
      door: routeDoor('__unknown_station__', register, policy),
    };
  }

  // The plaza's windows move no money and take no route (D-076): once the id
  // resolves, they open.
  if (definition.building === 'plaza') return { status: 'available', definition };

  const doors = definition.routes.map((route) => routeDoor(route, register, policy));
  const hardLock = doors.find((door) => !door.open && door.reason !== 'not-enabled');
  if (hardLock) return { status: 'locked', definition, door: hardLock };
  if (doors.every((door) => !door.open)) {
    return { status: 'locked', definition, door: doors[0]! };
  }
  if (
    definition.view === 'bridge' &&
    (!capabilities.bridgeAccountAvailable || !capabilities.bridgePlannerAvailable)
  ) {
    return {
      status: 'locked',
      definition,
      door: { open: false, reason: 'capability-unavailable', message: COPY.bridge.unavailable },
    };
  }
  return { status: 'available', definition };
}

/** Presentation-only data sent to the World. Omitted and unknown means locked. */
export function stationSnapshot(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  capabilities: StationCapabilities = {},
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): ShellEvents['world:stations']['stations'] {
  return Object.freeze(STATIONS.filter((station) => station.building === building).map((definition) => Object.freeze({
    station: definition.station,
    label: definition.label,
    status: resolveStation(building, definition.station, register, capabilities, policy).status,
  })));
}
