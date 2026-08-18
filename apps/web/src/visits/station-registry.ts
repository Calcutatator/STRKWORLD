import type { BuildingId, ShellEvents, StationId } from '@strkworld/shared';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { routeDoor, type DoorState } from '../panels/routes.js';
import type { BankMode } from '../panels/bank/bank-machine.js';

/**
 * Shell-owned meaning for an opaque station id.
 *
 * None of this crosses into Phaser. The World receives only the preformatted
 * label and lock state; routes, modes and privacy grades stay here with the
 * financial controls they admit (D-033).
 */
export interface StationDefinition {
  station: StationId;
  building: BuildingId;
  label: string;
  routes: readonly string[];
  modes: readonly BankMode[];
  initialMode: BankMode;
  view: 'bank';
}

const STATIONS: readonly StationDefinition[] = [
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
] as const;

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
  return { status: 'available', definition };
}

/** Presentation-only data sent to the World. Omitted and unknown means locked. */
export function stationSnapshot(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): ShellEvents['world:stations']['stations'] {
  return STATIONS.filter((station) => station.building === building).map((definition) => ({
    station: definition.station,
    label: definition.label,
    status: resolveStation(building, definition.station, register).status,
  }));
}
