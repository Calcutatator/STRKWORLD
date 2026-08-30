import type { BuildingId, ShellEvents, StationId } from '@strkworld/shared';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { routeDoor, type DoorState } from '../panels/routes.js';
import type { BankMode } from '../panels/bank/bank-machine.js';
import { COPY } from '../copy.js';

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
 */
export function resolveStation(
  building: BuildingId,
  station: StationId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  capabilities: StationCapabilities = {},
): StationResolution {
  const definition = STATIONS.find(
    (candidate) => candidate.building === building && candidate.station === station,
  );
  if (!definition) {
    return {
      status: 'locked',
      definition: null,
      door: routeDoor('__unknown_station__', register),
    };
  }

  for (const route of definition.routes) {
    const door = routeDoor(route, register);
    if (!door.open) return { status: 'locked', definition, door };
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
): ShellEvents['world:stations']['stations'] {
  return STATIONS.filter((station) => station.building === building).map((definition) => ({
    station: definition.station,
    label: definition.label,
    status: resolveStation(building, definition.station, register, capabilities).status,
  }));
}
