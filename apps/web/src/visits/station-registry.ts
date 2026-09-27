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
};
type BridgeStationDefinition = {
  station: StationId; building: 'bridge'; label: string; routes: readonly string[];
  view: 'bridge';
};

/**
 * Shell-owned meaning for an opaque station id.
 *
 * None of this crosses into Phaser. The World receives only the preformatted
 * label and lock state; routes, modes and privacy grades stay here with the
 * financial controls they admit (D-033).
 */
export type StationDefinition = BankStationDefinition | ExchangeStationDefinition | BridgeStationDefinition;

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
  },
  {
    station: 'bridge:deposit',
    building: 'bridge',
    label: 'DEPOSIT',
    routes: ['bridge.deposit'],
    view: 'bridge',
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
