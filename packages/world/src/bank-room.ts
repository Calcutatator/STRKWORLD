/** D-033 compatibility facade over the data-driven fixed-room core. */

import type { BuildingId, EventBus, ShellEvents, StationId, WorldEvents } from '@strkworld/shared';
import {
  BANK_ROOM_DEFINITION,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomController,
  fixedRoomStationAtApproach,
  fixedRoomTileAt,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  normalizeFixedRoomStations,
  type FixedRoomController,
  type FixedRoomInputGate,
  type FixedRoomMap,
  type FixedRoomRect,
  type FixedRoomState,
  type FixedRoomTile,
} from './fixed-room.js';

export const BANK_ROOM_BUILDING: BuildingId = 'bank';
export const BANK_SHIELDING_STATION: StationId = 'bank:shielding';
export const BANK_SHIELDING_LABEL = 'SHIELD / UNSHIELD';
export const BANK_ROOM_TILE_SIZE = FIXED_ROOM_TILE_SIZE;

export type BankRoomTile = FixedRoomTile;
export type BankRoomRect = FixedRoomRect;

export interface BankRoomMap extends FixedRoomMap {
  readonly name: 'bank';
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

export interface RoomInputGate extends FixedRoomInputGate {}

export interface BankRoomController {
  readonly state: BankRoomState;
  enter(): void;
  update(tile: { x: number; y: number }): void;
  destroy(): void;
}

export interface BankRoomControllerOptions {
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  readonly in?: Pick<EventBus<ShellEvents>, 'on'>;
  readonly input: RoomInputGate;
  readonly onEnter?: () => void;
  readonly onExit?: () => void;
  readonly onChange?: (state: BankRoomState) => void;
}

export function createBankRoom(): BankRoomMap {
  const room = createFixedRoom(BANK_ROOM_DEFINITION);
  return {
    ...room,
    name: 'bank',
    station: BANK_ROOM_DEFINITION.stations[0]!,
  };
}

export function bankRoomTileAt(room: BankRoomMap, x: number, y: number): BankRoomTile | null {
  return fixedRoomTileAt(room, x, y);
}

export function isBankRoomSolidAt(room: BankRoomMap, x: number, y: number): boolean {
  return isFixedRoomSolidAt(room, x, y);
}

export function isBankRoomExit(room: BankRoomMap, x: number, y: number): boolean {
  return isFixedRoomExit(room, x, y);
}

export function isBankStationApproach(room: BankRoomMap, x: number, y: number): boolean {
  return fixedRoomStationAtApproach(room, x, y) !== null;
}

export function normalizeBankStationSnapshot(
  stations: readonly ShellEvents['world:stations']['stations'][number][] | undefined,
): BankStationSnapshot {
  return normalizeFixedRoomStations(BANK_ROOM_DEFINITION, stations)[0]!;
}

export function createBankRoomController(options: BankRoomControllerOptions): BankRoomController {
  let latest: BankRoomState = {
    inRoom: false,
    building: null,
    controlOwner: 'world',
    highlightedStation: null,
    station: normalizeBankStationSnapshot(undefined),
  };
  let controller!: FixedRoomController;
  controller = createFixedRoomController({
    definition: BANK_ROOM_DEFINITION,
    out: options.out,
    in: options.in,
    input: options.input,
    onEnter: options.onEnter,
    onExit: options.onExit,
    onChange: (state: FixedRoomState) => {
      latest = {
        inRoom: state.inRoom,
        building: state.building,
        controlOwner: state.controlOwner,
        highlightedStation: state.highlightedStation,
        station: state.stations[0]!,
      };
      options.onChange?.(latest);
    },
  });
  return {
    get state() {
      const state = controller.state;
      latest = {
        inRoom: state.inRoom,
        building: state.building,
        controlOwner: state.controlOwner,
        highlightedStation: state.highlightedStation,
        station: state.stations[0]!,
      };
      return latest;
    },
    enter: () => controller.enter(),
    update: (tile) => controller.update(tile),
    destroy: () => controller.destroy(),
  };
}
