/**
 * The first Game Mode room: a deliberately small, fixed Bank interior.
 *
 * This module is Phaser-free.  It owns the room's geometry and the local
 * interaction state machine; the Phaser scene is only an adapter that draws
 * the returned tiles and reports the player's tile.  The station id is an
 * opaque presentation id (D-033), never a route or action name.
 */

import type {
  BuildingId,
  EventBus,
  ShellEvents,
  StationId,
  WorldEvents,
} from '@strkworld/shared';

export const BANK_ROOM_BUILDING: BuildingId = 'bank';
export const BANK_SHIELDING_STATION: StationId = 'bank:shielding';
export const BANK_SHIELDING_LABEL = 'SHIELD / UNSHIELD';
export const BANK_ROOM_TILE_SIZE = 32;

export type BankRoomTile = 'floor' | 'wall' | 'exit' | 'station';

export interface BankRoomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BankRoomMap {
  readonly name: 'bank';
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly (readonly BankRoomTile[])[];
  readonly spawn: { readonly x: number; readonly y: number };
  readonly exit: BankRoomRect;
  readonly station: BankRoomRect & { readonly station: StationId };
}

export interface BankStationSnapshot {
  readonly station: StationId;
  readonly label: string;
  readonly status: 'available' | 'locked';
}

export interface BankRoomState {
  readonly inRoom: boolean;
  readonly building: BuildingId | null;
  readonly controlOwner: 'world' | 'shell';
  readonly highlightedStation: StationId | null;
  readonly station: BankStationSnapshot;
}

/** The only input surface the room controller needs. */
export interface RoomInputGate {
  suspend(): void;
  resume(): void;
}

export interface BankRoomController {
  readonly state: BankRoomState;
  /** Enter the local room before `building:entered` is published. */
  enter(): void;
  /** Report a room tile; this drives highlight, activation and physical exit. */
  update(tile: { x: number; y: number }): void;
  /** Leave without publishing an event (used only by shutdown). */
  destroy(): void;
}

export interface BankRoomControllerOptions {
  out: Pick<EventBus<WorldEvents>, 'emit'>;
  in?: Pick<EventBus<ShellEvents>, 'on'>;
  input: RoomInputGate;
  onEnter?: () => void;
  onExit?: () => void;
  onChange?: (state: BankRoomState) => void;
}

/**
 * Procedural geometry for the tracer room.
 *
 * The border is solid except for a two-tile physical exit at the bottom.  The
 * station is also solid, so a player can approach and highlight it but cannot
 * walk over the control.  All coordinates are tiles, matching the street map.
 */
export function createBankRoom(): BankRoomMap {
  const width = 18;
  const height = 12;
  const exit: BankRoomRect = { x: 8, y: height - 1, width: 2, height: 1 };
  const station = {
    station: BANK_SHIELDING_STATION,
    x: 8,
    y: 3,
    width: 2,
    height: 1,
  } as const;

  const tiles: BankRoomTile[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const border = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      if (border) return isInsideRect(exit, x, y) ? 'exit' : 'wall';
      if (isInsideRect(station, x, y)) return 'station';
      return 'floor';
    }),
  );

  return {
    name: 'bank',
    width,
    height,
    tiles,
    spawn: { x: 9, y: 9 },
    exit,
    station,
  };
}

export function bankRoomTileAt(room: BankRoomMap, x: number, y: number): BankRoomTile | null {
  return room.tiles[y]?.[x] ?? null;
}

/** Out of bounds and the station count as solid. */
export function isBankRoomSolidAt(room: BankRoomMap, x: number, y: number): boolean {
  const tile = bankRoomTileAt(room, x, y);
  return tile === null || tile === 'wall' || tile === 'station';
}

export function isBankRoomExit(room: BankRoomMap, x: number, y: number): boolean {
  return isInsideRect(room.exit, x, y);
}

/** A one-tile halo around the station, excluding its occupied footprint. */
export function isBankStationApproach(room: BankRoomMap, x: number, y: number): boolean {
  const station = room.station;
  const inHalo =
    x >= station.x - 1 &&
    x < station.x + station.width + 1 &&
    y >= station.y - 1 &&
    y < station.y + station.height + 1;
  return inHalo && !isInsideRect(station, x, y);
}

function isInsideRect(rect: BankRoomRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * Sanitize a Shell presentation snapshot.  Only the one known station can be
 * rendered, and anything missing, malformed or unknown is locked.  In
 * particular, this function never turns a World default into authorization.
 */
export function normalizeBankStationSnapshot(
  stations: readonly ShellEvents['world:stations']['stations'][number][] | undefined,
): BankStationSnapshot {
  const candidates = Array.isArray(stations)
    ? stations.filter((entry) => entry?.station === BANK_SHIELDING_STATION)
    : [];
  // A duplicate is ambiguous presentation input.  Treat it as locked rather
  // than letting the first item win and accidentally opening a route.
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  const validLabel = typeof candidate?.label === 'string' && candidate.label.trim().length > 0;
  return {
    station: BANK_SHIELDING_STATION,
    label: validLabel && candidate ? candidate.label : BANK_SHIELDING_LABEL,
    status: candidate?.status === 'available' && validLabel ? 'available' : 'locked',
  };
}

/**
 * Build the state machine used by the Phaser adapter and headless tests.
 *
 * The controller listens only to matching Bank commands.  A station is armed
 * once per approach: the player must leave its halo before it can activate
 * again.  The input gate is suspended *before* `station:activated` is emitted;
 * synchronous Shell listeners can then claim ownership, while an absent or
 * stale Shell listener cannot leave the World suspended.
 */
export function createBankRoomController(options: BankRoomControllerOptions): BankRoomController {
  const room = createBankRoom();
  let inRoom = false;
  let controlOwner: 'world' | 'shell' = 'world';
  let highlightedStation: StationId | null = null;
  let station = normalizeBankStationSnapshot(undefined);
  let approachArmed = true;
  let destroyed = false;

  const state = (): BankRoomState => ({
    inRoom,
    building: inRoom ? BANK_ROOM_BUILDING : null,
    controlOwner,
    highlightedStation,
    station,
  });

  const publish = (): void => options.onChange?.(state());

  const stopStations = options.in?.on('world:stations', (payload) => {
    if (destroyed || !inRoom || payload.building !== BANK_ROOM_BUILDING) return;
    station = normalizeBankStationSnapshot(payload.stations);
    publish();
  });

  const stopOwner = options.in?.on('world:control-owner', (payload) => {
    if (destroyed || !inRoom || payload.building !== BANK_ROOM_BUILDING) return;
    controlOwner = payload.owner;
    if (payload.owner === 'shell') options.input.suspend();
    else options.input.resume();
    publish();
  });

  const stopExit = options.in?.on('world:exit-building', (payload) => {
    if (destroyed || !inRoom || payload.building !== BANK_ROOM_BUILDING) return;
    leave();
  });

  function leave(): void {
    if (!inRoom) return;
    inRoom = false;
    controlOwner = 'world';
    highlightedStation = null;
    approachArmed = true;
    // Exiting is always a safe handoff back to the street, including a
    // shutdown after a panel disappeared unexpectedly.
    options.input.resume();
    options.onExit?.();
    publish();
    options.out.emit('building:exited', { building: BANK_ROOM_BUILDING });
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
      approachArmed = true;
      // Every visit starts locked until the Shell sends a fresh snapshot.
      station = normalizeBankStationSnapshot(undefined);
      options.input.resume();
      options.onEnter?.();
      publish();
    },

    update(tile): void {
      if (destroyed || !inRoom || controlOwner === 'shell') return;
      if (isBankRoomExit(room, tile.x, tile.y)) {
        leave();
        return;
      }

      const nextHighlighted = isBankStationApproach(room, tile.x, tile.y)
        ? BANK_SHIELDING_STATION
        : null;
      if (nextHighlighted === null) {
        approachArmed = true;
      }

      if (nextHighlighted !== highlightedStation) {
        highlightedStation = nextHighlighted;
        publish();
      }

      if (
        nextHighlighted === BANK_SHIELDING_STATION &&
        approachArmed &&
        station.status === 'available'
      ) {
        approachArmed = false;
        options.input.suspend();
        options.out.emit('station:activated', {
          building: BANK_ROOM_BUILDING,
          station: BANK_SHIELDING_STATION,
        });
        // EventBus delivery is synchronous.  If no current Shell claims the
        // control, restore the World immediately instead of trapping input.
        if (controlOwner === 'world') options.input.resume();
      }
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopStations?.();
      stopOwner?.();
      stopExit?.();
      inRoom = false;
      controlOwner = 'world';
      highlightedStation = null;
      options.input.resume();
    },
  };
}
