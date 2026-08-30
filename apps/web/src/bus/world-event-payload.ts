import { BUILDINGS, type BuildingId, type Facing, type StationId } from '@strkworld/shared';

const FACINGS = new Set<unknown>(['up', 'down', 'left', 'right']);

function ownData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function building(value: unknown): BuildingId | null {
  const candidate = ownData(value, 'building');
  return BUILDINGS.includes(candidate as BuildingId) ? candidate as BuildingId : null;
}

export function ownBuildingPayload(value: unknown): { readonly building: BuildingId } | null {
  const ownedBuilding = building(value);
  return ownedBuilding ? Object.freeze({ building: ownedBuilding }) : null;
}

export function ownLockedBuildingPayload(
  value: unknown,
): { readonly building: BuildingId; readonly reason: 'coming-soon' } | null {
  const ownedBuilding = building(value);
  const reason = ownData(value, 'reason');
  return ownedBuilding && reason === 'coming-soon'
    ? Object.freeze({ building: ownedBuilding, reason })
    : null;
}

export function ownStationPayload(
  value: unknown,
): { readonly building: BuildingId; readonly station: StationId } | null {
  const ownedBuilding = building(value);
  const station = ownData(value, 'station');
  return ownedBuilding && typeof station === 'string' && station.startsWith(`${ownedBuilding}:`)
    ? Object.freeze({ building: ownedBuilding, station: station as StationId })
    : null;
}

export function ownMovementPayload(
  value: unknown,
): { readonly position: { readonly x: number; readonly y: number }; readonly facing: Facing } | null {
  const position = ownData(value, 'position');
  const x = ownData(position, 'x');
  const y = ownData(position, 'y');
  const facing = ownData(value, 'facing');
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y) || !FACINGS.has(facing)) {
    return null;
  }
  return Object.freeze({ position: Object.freeze({ x, y }), facing: facing as Facing });
}
