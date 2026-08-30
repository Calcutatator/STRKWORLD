/**
 * The Phaser-free fixed-room module. A definition is the only variation
 * between Game Mode interiors; the controller owns the ordering-sensitive
 * handoff and the Phaser scene only adapts its map/state to pixels.
 */

import type { BuildingId, EventBus, ShellEvents, StationId, WorldEvents } from '@strkworld/shared';

export const FIXED_ROOM_TILE_SIZE = 32;

export type FixedRoomTile = 'floor' | 'wall' | 'exit' | 'station';

export interface FixedRoomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FixedRoomStationDefinition extends FixedRoomRect {
  readonly station: StationId;
  readonly label: string;
}

export interface FixedRoomDefinition {
  readonly building: BuildingId;
  readonly width: number;
  readonly height: number;
  readonly spawn: { readonly x: number; readonly y: number };
  readonly exit: FixedRoomRect;
  readonly stations: readonly FixedRoomStationDefinition[];
}

export interface FixedRoomMap {
  readonly building: BuildingId;
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly (readonly FixedRoomTile[])[];
  readonly spawn: FixedRoomDefinition['spawn'];
  readonly exit: FixedRoomRect;
  readonly stations: readonly FixedRoomStationDefinition[];
}

export interface FixedRoomStationSnapshot {
  readonly station: StationId;
  readonly label: string;
  readonly status: 'available' | 'locked';
}

export interface FixedRoomState {
  readonly inRoom: boolean;
  readonly building: BuildingId | null;
  readonly controlOwner: 'world' | 'shell';
  readonly highlightedStation: StationId | null;
  readonly stations: readonly FixedRoomStationSnapshot[];
}

export interface FixedRoomStationPresentation extends FixedRoomStationDefinition {
  readonly label: string;
  readonly status: 'available' | 'locked';
  readonly highlighted: boolean;
}

export type FixedRoomDefinitionErrorCode =
  | 'invalid-dimensions'
  | 'invalid-spawn'
  | 'invalid-exit'
  | 'invalid-station'
  | 'duplicate-station'
  | 'overlapping-stations'
  | 'overlapping-approaches';

/** Stable fail-closed error surface for authored room data. */
export class FixedRoomDefinitionError extends Error {
  override readonly name = 'FixedRoomDefinitionError';

  constructor(readonly code: FixedRoomDefinitionErrorCode) {
    super(`Invalid fixed room definition: ${code}`);
  }
}

export interface FixedRoomInputGate {
  suspend(): void;
  resume(): void;
}

export interface FixedRoomController {
  readonly state: FixedRoomState;
  enter(): void;
  update(tile: { x: number; y: number }): void;
  destroy(): void;
}

export interface FixedRoomControllerOptions {
  readonly definition: FixedRoomDefinition;
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  readonly in?: Pick<EventBus<ShellEvents>, 'on'>;
  readonly input: FixedRoomInputGate;
  readonly onEnter?: () => void;
  readonly onExit?: () => void;
  readonly onChange?: (state: FixedRoomState) => void;
}

function freezeAuthoredRoom<const T extends FixedRoomDefinition>(definition: T): T {
  Object.freeze(definition.spawn);
  Object.freeze(definition.exit);
  for (const station of definition.stations) Object.freeze(station);
  Object.freeze(definition.stations);
  return Object.freeze(definition);
}

export const BANK_ROOM_DEFINITION = freezeAuthoredRoom({
  building: 'bank',
  width: 18,
  height: 12,
  spawn: { x: 9, y: 9 },
  exit: { x: 8, y: 11, width: 2, height: 1 },
  stations: [
    {
      station: 'bank:shielding',
      label: 'SHIELD / UNSHIELD',
      x: 8,
      y: 3,
      width: 2,
      height: 1,
    },
  ],
} as const satisfies FixedRoomDefinition);

export const POST_OFFICE_ROOM_DEFINITION = freezeAuthoredRoom({
  building: 'post-office',
  width: 18,
  height: 12,
  spawn: { x: 9, y: 9 },
  exit: { x: 8, y: 11, width: 2, height: 1 },
  stations: [
    {
      station: 'post-office:transfer',
      label: 'TRANSFER',
      x: 3,
      y: 3,
      width: 2,
      height: 1,
    },
  ],
} as const satisfies FixedRoomDefinition);

export const EXCHANGE_ROOM_DEFINITION = freezeAuthoredRoom({
  building: 'exchange',
  width: 18,
  height: 12,
  spawn: { x: 9, y: 9 },
  exit: { x: 8, y: 11, width: 2, height: 1 },
  stations: [
    {
      station: 'exchange:swap',
      label: 'SWAP',
      x: 13,
      y: 3,
      width: 2,
      height: 1,
    },
  ],
} as const satisfies FixedRoomDefinition);

export const BRIDGE_ROOM_DEFINITION = freezeAuthoredRoom({
  building: 'bridge',
  width: 18,
  height: 12,
  spawn: { x: 9, y: 9 },
  exit: { x: 8, y: 11, width: 2, height: 1 },
  stations: [
    {
      station: 'bridge:deposit',
      label: 'DEPOSIT',
      x: 8,
      y: 3,
      width: 2,
      height: 1,
    },
  ],
} as const satisfies FixedRoomDefinition);

export const FIXED_ROOM_DEFINITIONS = Object.freeze({
  bank: BANK_ROOM_DEFINITION,
  bridge: BRIDGE_ROOM_DEFINITION,
  exchange: EXCHANGE_ROOM_DEFINITION,
  'post-office': POST_OFFICE_ROOM_DEFINITION,
} as const satisfies Partial<Record<BuildingId, FixedRoomDefinition>>);

export function createFixedRoom(definition: FixedRoomDefinition): FixedRoomMap {
  validateFixedRoomDefinition(definition);
  const tiles: FixedRoomTile[][] = Array.from({ length: definition.height }, (_, y) =>
    Array.from({ length: definition.width }, (_, x) => {
      const border =
        x === 0 || x === definition.width - 1 || y === 0 || y === definition.height - 1;
      if (border) return isInside(definition.exit, x, y) ? 'exit' : 'wall';
      if (definition.stations.some((station) => isInside(station, x, y))) return 'station';
      return 'floor';
    }),
  );

  for (const row of tiles) Object.freeze(row);
  const stations = definition.stations.map((station) => Object.freeze({ ...station }));
  return Object.freeze({
    building: definition.building,
    width: definition.width,
    height: definition.height,
    tiles: Object.freeze(tiles),
    spawn: Object.freeze({ ...definition.spawn }),
    exit: Object.freeze({ ...definition.exit }),
    stations: Object.freeze(stations),
  });
}

export function validateFixedRoomDefinition(definition: FixedRoomDefinition): void {
  if (!positiveInteger(definition.width) || !positiveInteger(definition.height)) {
    rejectDefinition('invalid-dimensions');
  }

  const exit = definition.exit;
  if (!validRect(exit) || !rectInside(exit, definition.width, definition.height)) {
    rejectDefinition('invalid-exit');
  }
  forEachCell(exit, (x, y) => {
    if (!onBorder(x, y, definition.width, definition.height)) {
      rejectDefinition('invalid-exit');
    }
  });

  if (!Array.isArray(definition.stations) || definition.stations.length === 0) {
    rejectDefinition('invalid-station');
  }

  const stationIds = new Set<StationId>();
  for (const station of definition.stations) {
    const correctPrefix =
      typeof station.station === 'string' &&
      station.station.startsWith(`${definition.building}:`) &&
      station.station.length > definition.building.length + 1;
    const validLabel = typeof station.label === 'string' && station.label.trim().length > 0;
    if (
      !validRect(station) ||
      !rectStrictlyInside(station, definition.width, definition.height) ||
      !correctPrefix ||
      !validLabel ||
      rectanglesOverlap(station, exit)
    ) {
      rejectDefinition('invalid-station');
    }
    if (stationIds.has(station.station)) rejectDefinition('duplicate-station');
    stationIds.add(station.station);
  }

  for (let first = 0; first < definition.stations.length; first++) {
    for (let second = first + 1; second < definition.stations.length; second++) {
      const a = definition.stations[first]!;
      const b = definition.stations[second]!;
      if (rectanglesOverlap(a, b)) rejectDefinition('overlapping-stations');
      if (rectanglesOverlap(expandRect(a), expandRect(b))) {
        rejectDefinition('overlapping-approaches');
      }
    }
  }

  const spawn = definition.spawn;
  const validSpawn =
    Number.isInteger(spawn.x) &&
    Number.isInteger(spawn.y) &&
    spawn.x > 0 &&
    spawn.x < definition.width - 1 &&
    spawn.y > 0 &&
    spawn.y < definition.height - 1 &&
    !definition.stations.some((station) => isInside(station, spawn.x, spawn.y)) &&
    !isInside(exit, spawn.x, spawn.y);
  if (!validSpawn) rejectDefinition('invalid-spawn');
}

export function fixedRoomTileAt(room: FixedRoomMap, x: number, y: number): FixedRoomTile | null {
  return room.tiles[y]?.[x] ?? null;
}

export function isFixedRoomSolidAt(room: FixedRoomMap, x: number, y: number): boolean {
  const tile = fixedRoomTileAt(room, x, y);
  return tile === null || tile === 'wall' || tile === 'station';
}

export function isFixedRoomExit(room: FixedRoomMap, x: number, y: number): boolean {
  return isInside(room.exit, x, y);
}

export function fixedRoomStationAtApproach(
  room: FixedRoomMap,
  x: number,
  y: number,
): FixedRoomStationDefinition | null {
  for (const station of room.stations) {
    const halo =
      x >= station.x - 1 &&
      x < station.x + station.width + 1 &&
      y >= station.y - 1 &&
      y < station.y + station.height + 1;
    if (halo && !isInside(station, x, y)) return station;
  }
  return null;
}

export function isFixedRoomApproach(room: FixedRoomMap, x: number, y: number): boolean {
  return fixedRoomStationAtApproach(room, x, y) !== null;
}

/**
 * Project controller state into independent station render models. Keeping
 * this Phaser-free prevents a renderer from accidentally reusing one label
 * object and overwriting all but the final station.
 */
export function fixedRoomStationPresentations(
  room: FixedRoomMap,
  state: FixedRoomState,
): readonly FixedRoomStationPresentation[] {
  return room.stations.map((station) => {
    const snapshot = state.stations.find((candidate) => candidate.station === station.station);
    return {
      ...station,
      label: snapshot?.label ?? station.label,
      status: snapshot?.status ?? 'locked',
      highlighted: state.highlightedStation === station.station,
    };
  });
}

/** Normalize only the definition's station ids; unknown input has no power. */
export function normalizeFixedRoomStations(
  definition: FixedRoomDefinition,
  stations: readonly ShellEvents['world:stations']['stations'][number][] | undefined,
): readonly FixedRoomStationSnapshot[] {
  return Object.freeze(definition.stations.map((known) => {
    const candidates = Array.isArray(stations)
      ? stations.filter((candidate) => candidate?.station === known.station)
      : [];
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    const validLabel = typeof candidate?.label === 'string' && candidate.label.trim().length > 0;
    const validStatus = candidate?.status === 'available' || candidate?.status === 'locked';
    return Object.freeze({
      station: known.station,
      label: validLabel && candidate ? candidate.label : known.label,
      status: candidate && validLabel && validStatus ? candidate.status : 'locked',
    });
  }));
}

export function createFixedRoomController(
  options: FixedRoomControllerOptions,
): FixedRoomController {
  const room = createFixedRoom(options.definition);
  let inRoom = false;
  let controlOwner: 'world' | 'shell' = 'world';
  let highlightedStation: StationId | null = null;
  let stations = normalizeFixedRoomStations(options.definition, undefined);
  let destroyed = false;
  let approachArmed = new Set(options.definition.stations.map((station) => station.station));

  const state = (): FixedRoomState => ({
    inRoom,
    building: inRoom ? options.definition.building : null,
    controlOwner,
    highlightedStation,
    stations,
  });
  const publish = (): void => options.onChange?.(state());
  const ownsWorldControl = (): boolean => controlOwner === 'world';

  let stopStations: (() => void) | undefined;
  let stopOwner: (() => void) | undefined;
  let stopExit: (() => void) | undefined;
  try {
    stopStations = options.in?.on('world:stations', (payload) => {
    if (destroyed || !inRoom || payload?.building !== options.definition.building) return;
    stations = normalizeFixedRoomStations(options.definition, payload?.stations);
      publish();
    });
    stopOwner = options.in?.on('world:control-owner', (payload) => {
    if (destroyed || !inRoom || payload?.building !== options.definition.building) return;
      if (payload.owner !== 'world' && payload.owner !== 'shell') return;
      controlOwner = payload.owner;
      if (controlOwner === 'shell') options.input.suspend();
      else options.input.resume();
      publish();
    });
    stopExit = options.in?.on('world:exit-building', (payload) => {
    if (destroyed || !inRoom || payload?.building !== options.definition.building) return;
      leave();
    });
  } catch (error) {
    for (const stop of [stopExit, stopOwner, stopStations]) {
      if (!stop) continue;
      try { stop(); } catch { /* preserve registration failure */ }
    }
    throw error;
  }

  function leave(): void {
    if (!inRoom) return;
    inRoom = false;
    controlOwner = 'world';
    highlightedStation = null;
    approachArmed = new Set(options.definition.stations.map((station) => station.station));
    options.input.resume();
    options.onExit?.();
    if (destroyed || inRoom) return;
    publish();
    options.out.emit('building:exited', Object.freeze({
      building: options.definition.building,
    }));
  }

  return {
    get state() {
      return state();
    },
    enter(): void {
      if (destroyed || inRoom) return;
      inRoom = true;
      controlOwner = 'world';
      highlightedStation = null;
      approachArmed = new Set(options.definition.stations.map((station) => station.station));
      stations = normalizeFixedRoomStations(options.definition, undefined);
      try {
        options.input.resume();
      } catch (error) {
        // Input restoration is an external lifecycle boundary. If it fails,
        // do not leave the controller claiming an interior it cannot operate;
        // a later explicit enter can retry the same restoration.
        inRoom = false;
        controlOwner = 'world';
        highlightedStation = null;
        approachArmed = new Set(options.definition.stations.map((station) => station.station));
        throw error;
      }
      options.onEnter?.();
      if (destroyed || !inRoom) return;
      publish();
    },
    update(tile): void {
      if (destroyed || !inRoom || controlOwner === 'shell') return;
      if (isFixedRoomExit(room, tile.x, tile.y)) {
        leave();
        return;
      }

      const approached = fixedRoomStationAtApproach(room, tile.x, tile.y);
      if (!approached)
        approachArmed = new Set(options.definition.stations.map((station) => station.station));
      const nextHighlighted = approached?.station ?? null;
      if (nextHighlighted !== highlightedStation) {
        highlightedStation = nextHighlighted;
        publish();
      }
      // onChange delivery is synchronous and may destroy the room or let
      // Shell claim control before this update resumes.
      if (destroyed || !inRoom || !ownsWorldControl()) return;
      const station = stations.find((candidate) => candidate.station === nextHighlighted);
      if (approached && station?.status === 'available' && approachArmed.has(approached.station)) {
        approachArmed.delete(approached.station);
        options.input.suspend();
        try {
          options.out.emit('station:activated', Object.freeze({
            building: options.definition.building,
            station: approached.station,
          }));
        } finally {
          // EventBus delivery is synchronous and may throw. A stale/missing
          // Shell claim or failed consumer must not strand the player with
          // World input suspended.
          if (!destroyed && inRoom && ownsWorldControl()) options.input.resume();
        }
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      const errors: unknown[] = [];
      const attempt = (cleanup: () => void): void => {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      };
      if (stopStations) attempt(stopStations);
      if (stopOwner) attempt(stopOwner);
      if (stopExit) attempt(stopExit);
      inRoom = false;
      controlOwner = 'world';
      highlightedStation = null;
      attempt(() => options.input.resume());
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Fixed-room cleanup failed');
      }
    },
  };
}

function isInside(rect: FixedRoomRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validRect(rect: FixedRoomRect): boolean {
  return (
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    positiveInteger(rect.width) &&
    positiveInteger(rect.height)
  );
}

function rectInside(rect: FixedRoomRect, width: number, height: number): boolean {
  return (
    rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height
  );
}

function rectStrictlyInside(rect: FixedRoomRect, width: number, height: number): boolean {
  return rect.x > 0 && rect.y > 0 && rect.x + rect.width < width && rect.y + rect.height < height;
}

function onBorder(x: number, y: number, width: number, height: number): boolean {
  return x === 0 || y === 0 || x === width - 1 || y === height - 1;
}

function forEachCell(rect: FixedRoomRect, visit: (x: number, y: number) => void): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) visit(x, y);
  }
}

function rectanglesOverlap(a: FixedRoomRect, b: FixedRoomRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function expandRect(rect: FixedRoomRect): FixedRoomRect {
  return { x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 };
}

function rejectDefinition(code: FixedRoomDefinitionErrorCode): never {
  throw new FixedRoomDefinitionError(code);
}
