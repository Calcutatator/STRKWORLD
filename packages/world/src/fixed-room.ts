/**
 * The renderer-free fixed-room module. A definition is the only variation
 * between Game Mode interiors; the controller owns the ordering-sensitive
 * handoff and the renderer only draws its map and state (D-059).
 */

import { STREET_ORIGIN_X, type BuildingId, type EventBus, type ShellEvents, type StationId, type WorldEvents } from '@strkworld/shared';

export const FIXED_ROOM_TILE_SIZE = 32;

/**
 * `fixture` is furniture built into a room around a counter (a desk's wings,
 * the boards or shelving behind it, a gateway's pylons): solid like a wall,
 * drawn by the room builder, never a station or its approach.
 */
export type FixedRoomTile = 'floor' | 'wall' | 'exit' | 'station' | 'lift' | 'fixture';

export interface FixedRoomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Free-standing furniture the room builder draws on a fixture. A fixture
 * without one belongs to a counter: its desk's wings or what stands behind it.
 */
export type FixedRoomProp = 'trading-pod' | 'high-table' | 'pillar-box' | 'writing-desk' | 'bench';

/** Solid furniture on the floor (`fixture` tiles). */
export interface FixedRoomFixture extends FixedRoomRect {
  readonly prop?: FixedRoomProp;
}

export interface FixedRoomStationDefinition extends FixedRoomRect {
  readonly station: StationId;
  readonly label: string;
}

/**
 * A floor of a building. The street door always opens onto the ground floor;
 * the others are reached only by lift, and the Shell still sees one building
 * on every floor (D-019, D-030).
 */
export type FixedRoomLevelId = 'ground' | 'degen' | 'roof';

/**
 * A lift pad: walking onto it rides to another floor of the same building,
 * the way walking onto an exit leaves it. Rides are World-local and emit
 * nothing.
 */
export interface FixedRoomLiftDefinition extends FixedRoomRect {
  /** The floor this pad rides to. */
  readonly to: FixedRoomLevelId;
  /**
   * Where a rider coming the other way steps out on this floor. It sits on
   * the far side of the pad from the direction its partner is entered, so a
   * key still held from the ride walks the rider away instead of riding
   * straight back (up pads stand north, down pads south).
   */
  readonly arrival: { readonly x: number; readonly y: number };
}

/** A floor's walkable grid; the ground floor adds the exit (below). */
export interface FixedRoomFloorDefinition {
  readonly building: BuildingId;
  readonly width: number;
  readonly height: number;
  readonly spawn: { readonly x: number; readonly y: number };
  readonly stations: readonly FixedRoomStationDefinition[];
  /** Pads to the building's other floors. */
  readonly lifts?: readonly FixedRoomLiftDefinition[];
  /**
   * Solid furniture: what a counter is built into (its desk's wings and what
   * stands behind it) and free-standing props. Strictly inside the walls, clear of every station, lift,
   * arrival, the exit and the spawn, and never cutting a counter, lift or the
   * exit off from the spawn.
   */
  readonly fixtures?: readonly FixedRoomFixture[];
}

/** A building's ground floor: the room its street door opens onto. */
export interface FixedRoomDefinition extends FixedRoomFloorDefinition {
  readonly exit: FixedRoomRect;
}

/**
 * The top of a building, drawn in the street scene rather than over the
 * hidden street: its grid lies over the building's footprint, raised to the
 * roof, so the street stays in view below.
 */
export interface FixedRoomRooftop {
  /** The street tile under the floor's tile (0, 0). */
  readonly x: number;
  readonly y: number;
  /** The walkable deck's height above the street, in world units (one tile each). */
  readonly height: number;
}

/** A floor above the ground floor. It has no street exit: its lifts are the way out. */
export interface FixedRoomLevelDefinition extends FixedRoomFloorDefinition {
  readonly level: Exclude<FixedRoomLevelId, 'ground'>;
  readonly lifts: readonly FixedRoomLiftDefinition[];
  /** Present on a roof; absent on an interior floor. */
  readonly rooftop?: FixedRoomRooftop;
}

/** Any floor's grid: the ground floor (`FixedRoomMap`) or one reached by lift. */
export interface FixedRoomLevelMap {
  readonly building: BuildingId;
  readonly level: FixedRoomLevelId;
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly (readonly FixedRoomTile[])[];
  readonly spawn: FixedRoomDefinition['spawn'];
  /** The way back to the street; only a ground floor has one. */
  readonly exit: FixedRoomRect | null;
  readonly stations: readonly FixedRoomStationDefinition[];
  readonly lifts: readonly FixedRoomLiftDefinition[];
  /** Solid furniture tiles' rectangles (`fixture` tiles). */
  readonly fixtures: readonly FixedRoomFixture[];
  readonly rooftop: FixedRoomRooftop | null;
}

export interface FixedRoomMap extends FixedRoomLevelMap {
  readonly level: 'ground';
  readonly exit: FixedRoomRect;
  readonly rooftop: null;
}

export interface FixedRoomStationSnapshot {
  readonly station: StationId;
  readonly label: string;
  readonly status: 'available' | 'locked';
}

export interface FixedRoomState {
  readonly inRoom: boolean;
  readonly building: BuildingId | null;
  /**
   * The floor the player is on: 'ground' on entry, others by lift; null
   * outside. The controller always reports it; it is optional only so a
   * single-floor snapshot can omit it.
   */
  readonly level?: FixedRoomLevelId | null;
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
  | 'overlapping-approaches'
  | 'invalid-lift'
  | 'invalid-level'
  | 'invalid-fixture'
  | 'unreachable';

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
  /** True when suspension owns a partial or complete disabled-input handoff. */
  readonly suspended?: boolean;
}

export interface FixedRoomPresentationPort {
  setPlayerVelocity(): void;
  setBodyEnabled(enabled: boolean): void;
  setGroundVisible(visible: boolean): void;
  setDoorsVisible(visible: boolean): void;
  setRemoteVisible(visible: boolean): void;
  setLabelsVisible(visible: boolean): void;
  setRoomVisible(visible: boolean): void;
  setWorldBounds(room: boolean): void;
  setCameraBounds(room: boolean): void;
  setPlayerPosition(room: boolean): void;
  resetDoors(): void;
  resumeStreet(): void;
}

export interface FixedRoomPresentation {
  enter(): void;
  exit(): void;
}

export function createFixedRoomPresentation(
  port: FixedRoomPresentationPort,
): FixedRoomPresentation {
  let transitionRevision = 0;
  const run = (room: boolean): void => {
    const ownTransition = ++transitionRevision;
    const isCurrent = (): boolean => transitionRevision === ownTransition;
    try {
      port.setPlayerVelocity();
      if (!isCurrent()) return;
      port.setBodyEnabled(!room);
      if (!isCurrent()) return;
      port.setGroundVisible(!room);
      if (!isCurrent()) return;
      port.setDoorsVisible(!room);
      if (!isCurrent()) return;
      port.setRemoteVisible(!room);
      if (!isCurrent()) return;
      port.setLabelsVisible(!room);
      if (!isCurrent()) return;
      port.setRoomVisible(room);
      if (!isCurrent()) return;
      port.setWorldBounds(room);
      if (!isCurrent()) return;
      port.setCameraBounds(room);
      if (!isCurrent()) return;
      port.setPlayerPosition(room);
      if (!room && isCurrent()) {
        port.resetDoors();
        if (!isCurrent()) return;
        port.resumeStreet();
      }
    } catch (error) {
      if (room && isCurrent()) restoreStreetPresentation(port, isCurrent);
      throw error;
    }
  };
  return Object.freeze({ enter: () => run(true), exit: () => run(false) });
}

function restoreStreetPresentation(
  port: FixedRoomPresentationPort,
  isCurrent: () => boolean,
): void {
  const attempts = [
    () => port.setPlayerVelocity(),
    () => port.setBodyEnabled(true),
    () => port.setGroundVisible(true),
    () => port.setDoorsVisible(true),
    () => port.setRemoteVisible(true),
    () => port.setLabelsVisible(true),
    () => port.setRoomVisible(false),
    () => port.setWorldBounds(false),
    () => port.setCameraBounds(false),
    () => port.setPlayerPosition(false),
  ];
  for (const attempt of attempts) {
    if (!isCurrent()) return;
    try { attempt(); } catch { /* preserve the entry failure */ }
  }
}

export interface FixedRoomController {
  readonly state: FixedRoomState;
  enter(): void;
  update(tile: { x: number; y: number }): void;
  destroy(): void;
}

export interface FixedRoomControllerOptions {
  /** The ground floor, which the street door opens onto. */
  readonly definition: FixedRoomDefinition;
  /** The building's other floors, reached only by lift. */
  readonly levels?: readonly FixedRoomLevelDefinition[];
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  readonly in?: Pick<EventBus<ShellEvents>, 'on'>;
  readonly input: FixedRoomInputGate;
  readonly onEnter?: () => void;
  readonly onExit?: () => void;
  /**
   * Present a floor with the player on `tile`: a lift ride's arrival, or the
   * rollback of a ride or exit that failed. Synchronous, like the others.
   */
  readonly onLevel?: (level: FixedRoomLevelId, tile: { readonly x: number; readonly y: number }) => void;
  readonly onChange?: (state: FixedRoomState) => void;
}

function freezeFloor<T extends FixedRoomFloorDefinition>(definition: T): void {
  Object.freeze(definition.spawn);
  for (const station of definition.stations) Object.freeze(station);
  Object.freeze(definition.stations);
  for (const lift of definition.lifts ?? []) {
    Object.freeze(lift.arrival);
    Object.freeze(lift);
  }
  if (definition.lifts) Object.freeze(definition.lifts);
  for (const fixture of definition.fixtures ?? []) Object.freeze(fixture);
  if (definition.fixtures) Object.freeze(definition.fixtures);
}

function freezeAuthoredRoom<const T extends FixedRoomDefinition>(definition: T): T {
  freezeFloor(definition);
  Object.freeze(definition.exit);
  return Object.freeze(definition);
}

function freezeAuthoredLevel<const T extends FixedRoomLevelDefinition>(definition: T): T {
  freezeFloor(definition);
  if (definition.rooftop) Object.freeze(definition.rooftop);
  return Object.freeze(definition);
}

function ownDataField(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Bank's teller line (D-103): four counters along the north wall, one
 * action each, west to east SHIELD, UNSHIELD, STAKE and UNSTAKE. Each keeps
 * one privacy grade (D-030): shielding and unshielding are `public-edge`,
 * staking and unstaking their own Endur routes (D-063, D-085). Two-tile
 * counters four tiles apart: their approaches tile the north band edge to
 * edge without overlapping, so every counter opens from its own three-wide
 * halo and none stands in another's path. The Shell supplies the labels.
 */
export const BANK_ROOM_DEFINITION = freezeAuthoredRoom({
  building: 'bank',
  width: 18,
  height: 12,
  spawn: { x: 9, y: 9 },
  exit: { x: 8, y: 11, width: 2, height: 1 },
  stations: [
    { station: 'bank:shielding', label: 'SHIELD', x: 2, y: 3, width: 2, height: 1 },
    { station: 'bank:unshielding', label: 'UNSHIELD', x: 6, y: 3, width: 2, height: 1 },
    { station: 'bank:staking', label: 'STAKE', x: 10, y: 3, width: 2, height: 1 },
    { station: 'bank:unstaking', label: 'UNSTAKE', x: 14, y: 3, width: 2, height: 1 },
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
  // The long wooden counter the window is set into, the stamp machine at its
  // east end, and the sorting room behind it, where nobody walks.
  fixtures: [
    { x: 1, y: 1, width: 8, height: 2 },
    { x: 1, y: 3, width: 2, height: 1 },
    { x: 5, y: 3, width: 4, height: 1 },
    // A pillar box against the north wall, and a writing desk for forms.
    { x: 13, y: 1, width: 1, height: 1, prop: 'pillar-box' },
    { x: 12, y: 6, width: 3, height: 1, prop: 'writing-desk' },
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
  // The tower's lift, up to the Degen floor: in the north-west corner, clear
  // of everything the room already had.
  lifts: [{ to: 'degen', x: 1, y: 1, width: 2, height: 1, arrival: { x: 2, y: 2 } }],
  // The trading desk's wings either side of the counter, and the wall of
  // boards behind it with the traders' row in front of that.
  fixtures: [
    { x: 11, y: 1, width: 6, height: 2 },
    { x: 11, y: 3, width: 2, height: 1 },
    { x: 15, y: 3, width: 2, height: 1 },
    // Two traders' pods on the floor.
    { x: 3, y: 5, width: 3, height: 1, prop: 'trading-pod' },
    { x: 3, y: 7, width: 3, height: 1, prop: 'trading-pod' },
  ],
} as const satisfies FixedRoomDefinition);

/** The degen swap counter (avnu's degen-mode tokens); the Shell supplies its label and state. */
export const EXCHANGE_DEGEN_STATION: StationId = 'exchange:degen';

/**
 * The Exchange tower's first floor: the Degen floor, one swap counter between
 * the lift down (south-west, entered walking south) and the lift up to the
 * roof (north-east, entered walking north).
 */
export const EXCHANGE_DEGEN_LEVEL = freezeAuthoredLevel({
  building: 'exchange',
  level: 'degen',
  width: 18,
  height: 12,
  spawn: { x: 2, y: 9 },
  stations: [
    {
      station: 'exchange:degen',
      label: 'DEGEN SWAP',
      x: 8,
      y: 3,
      width: 2,
      height: 1,
    },
  ],
  lifts: [
    { to: 'ground', x: 1, y: 10, width: 2, height: 1, arrival: { x: 2, y: 9 } },
    { to: 'roof', x: 15, y: 1, width: 2, height: 1, arrival: { x: 15, y: 2 } },
  ],
  // The back room set into the poster wall, and the bar's ends either side
  // of the counter across its mouth.
  fixtures: [
    { x: 7, y: 1, width: 4, height: 2 },
    { x: 7, y: 3, width: 1, height: 1 },
    { x: 10, y: 3, width: 1, height: 1 },
    // Two neon high tables on the floor.
    { x: 4, y: 6, width: 1, height: 1, prop: 'high-table' },
    { x: 13, y: 6, width: 1, height: 1, prop: 'high-table' },
  ],
} as const satisfies FixedRoomLevelDefinition);

/** How far the Exchange's roof deck stands above the street, in world units. */
export const EXCHANGE_ROOF_HEIGHT = 36;

/**
 * The Exchange tower's roof: its real top in the street scene, a deck of 5 by
 * 4 tiles inside a solid ledge ring over the tower's 7 by 6 footprint (the
 * street's tiles 12-18, 5-10, counted from `STREET_ORIGIN_X`). The lift down
 * stands in the deck's south-east corner.
 */
export const EXCHANGE_ROOF_LEVEL = freezeAuthoredLevel({
  building: 'exchange',
  level: 'roof',
  width: 7,
  height: 6,
  spawn: { x: 5, y: 3 },
  stations: [],
  lifts: [{ to: 'degen', x: 5, y: 4, width: 1, height: 1, arrival: { x: 5, y: 3 } }],
  // Over the Exchange's street footprint, which the street lays out from its first column (D-078).
  rooftop: { x: STREET_ORIGIN_X + 12, y: 5, height: EXCHANGE_ROOF_HEIGHT },
} as const satisfies FixedRoomLevelDefinition);

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
  // The gateway the terminal stands in: its two pylons, and the portal
  // behind the desk.
  fixtures: [
    { x: 6, y: 1, width: 6, height: 2 },
    { x: 6, y: 3, width: 2, height: 1 },
    { x: 10, y: 3, width: 2, height: 1 },
    // Two rows of departure-lounge seats.
    { x: 3, y: 6, width: 3, height: 1, prop: 'bench' },
    { x: 12, y: 6, width: 3, height: 1, prop: 'bench' },
  ],
} as const satisfies FixedRoomDefinition);

/** The Vault's SUPPLY counter (D-077, D-103); the Shell supplies its label and state. */
export const VAULT_SUPPLY_STATION: StationId = 'vault:supply';

/** The Vault's REDEEM counter (D-103), beside SUPPLY. */
export const VAULT_REDEEM_STATION: StationId = 'vault:redeem';

/**
 * D-103: the id the Vault's one lending counter had while it held supply and
 * redeem together. It is not a station any more; a snapshot or a stale World
 * that still names it reads as SUPPLY (`canonicalFixedRoomStation`).
 * @deprecated Use `VAULT_SUPPLY_STATION`.
 */
export const VAULT_LENDING_STATION: StationId = 'vault:lending';

/**
 * The Vault's BORROW counter (D-083): borrow, and add collateral to a loan.
 * Its own counters, never merged with lending, because borrowing carries a
 * different, riskier disclosure, so each station keeps one privacy grade
 * (D-030). The Shell supplies its label and state.
 */
export const VAULT_BORROW_STATION: StationId = 'vault:borrow';

/** The Vault's REPAY counter (D-103): repay a loan, and withdraw its collateral. */
export const VAULT_REPAY_STATION: StationId = 'vault:repay';

/**
 * Station ids an earlier build used, and the counter each now names (D-103).
 * Only the Vault's lending counter was renamed; every other id was kept.
 */
export const FIXED_ROOM_STATION_ALIASES: Readonly<Partial<Record<StationId, StationId>>> = Object.freeze({
  [VAULT_LENDING_STATION]: VAULT_SUPPLY_STATION,
});

/** The current id for `station`: itself, or the counter a renamed id now names (D-103). */
export function canonicalFixedRoomStation(station: StationId): StationId {
  return FIXED_ROOM_STATION_ALIASES[station] ?? station;
}

/**
 * The Vault opens on shadow accounts, behind the Shell's switch (D-077): four
 * counters along the north wall in the envelope every room shares, west to
 * east SUPPLY, REDEEM, BORROW and REPAY (D-103), laid out as the Bank's teller
 * line. Locked, it is D-007's facade and no room is built, so it stays out of
 * `FIXED_ROOM_DEFINITIONS`, whose rooms are always open;
 * `fixedRoomDefinitionsFor` adds it when the Shell says so.
 */
export const VAULT_ROOM_DEFINITION = freezeAuthoredRoom({
  building: 'vault',
  width: 18,
  height: 12,
  spawn: { x: 9, y: 9 },
  exit: { x: 8, y: 11, width: 2, height: 1 },
  stations: [
    { station: 'vault:supply', label: 'SUPPLY', x: 2, y: 3, width: 2, height: 1 },
    { station: 'vault:redeem', label: 'REDEEM', x: 6, y: 3, width: 2, height: 1 },
    { station: 'vault:borrow', label: 'BORROW', x: 10, y: 3, width: 2, height: 1 },
    { station: 'vault:repay', label: 'REPAY', x: 14, y: 3, width: 2, height: 1 },
  ],
} as const satisfies FixedRoomDefinition);

export const FIXED_ROOM_DEFINITIONS = Object.freeze({
  bank: BANK_ROOM_DEFINITION,
  bridge: BRIDGE_ROOM_DEFINITION,
  exchange: EXCHANGE_ROOM_DEFINITION,
  'post-office': POST_OFFICE_ROOM_DEFINITION,
} as const satisfies Partial<Record<BuildingId, FixedRoomDefinition>>);

/** Floors above the ground floor, by building. Only the Exchange tower has any. */
export const FIXED_ROOM_LEVELS: Readonly<Partial<Record<BuildingId, readonly FixedRoomLevelDefinition[]>>> =
  Object.freeze({
    exchange: Object.freeze([EXCHANGE_DEGEN_LEVEL, EXCHANGE_ROOF_LEVEL]),
  });

const ALWAYS_OPEN_ROOMS: readonly FixedRoomDefinition[] = Object.freeze(Object.values(FIXED_ROOM_DEFINITIONS));
const ROOMS_WITH_VAULT: readonly FixedRoomDefinition[] = Object.freeze([...ALWAYS_OPEN_ROOMS, VAULT_ROOM_DEFINITION]);

/**
 * The ground floors a World builds: every always-open room, then the Vault's
 * when the Shell opens it (D-077). Fails closed: only a real `true` adds it.
 */
export function fixedRoomDefinitionsFor(options: { readonly vaultOpen?: boolean }): readonly FixedRoomDefinition[] {
  return options.vaultOpen === true ? ROOMS_WITH_VAULT : ALWAYS_OPEN_ROOMS;
}

export function createFixedRoom(definition: FixedRoomDefinition): FixedRoomMap {
  validateFixedRoomDefinition(definition);
  return buildFloorMap(definition, 'ground', definition.exit, null) as FixedRoomMap;
}

/** A floor reached by lift: validated like a room, without an exit. */
export function createFixedRoomLevel(definition: FixedRoomLevelDefinition): FixedRoomLevelMap {
  validateFixedRoomLevel(definition);
  return buildFloorMap(definition, definition.level, null, definition.rooftop ?? null);
}

function buildFloorMap(
  definition: FixedRoomFloorDefinition,
  level: FixedRoomLevelId,
  exit: FixedRoomRect | null,
  rooftop: FixedRoomRooftop | null,
): FixedRoomLevelMap {
  const lifts = definition.lifts ?? [];
  const fixtures = definition.fixtures ?? [];
  const tiles: FixedRoomTile[][] = Array.from({ length: definition.height }, (_, y) =>
    Array.from({ length: definition.width }, (_, x) => {
      if (lifts.some((lift) => isInside(lift, x, y))) return 'lift';
      const border =
        x === 0 || x === definition.width - 1 || y === 0 || y === definition.height - 1;
      if (border) return exit && isInside(exit, x, y) ? 'exit' : 'wall';
      if (definition.stations.some((station) => isInside(station, x, y))) return 'station';
      if (fixtures.some((fixture) => isInside(fixture, x, y))) return 'fixture';
      return 'floor';
    }),
  );

  for (const row of tiles) Object.freeze(row);
  const stations = definition.stations.map((station) => Object.freeze({ ...station }));
  return Object.freeze({
    building: definition.building,
    level,
    width: definition.width,
    height: definition.height,
    tiles: Object.freeze(tiles),
    spawn: Object.freeze({ ...definition.spawn }),
    exit: exit ? Object.freeze({ ...exit }) : null,
    stations: Object.freeze(stations),
    lifts: Object.freeze(lifts.map((lift) => Object.freeze({ ...lift, arrival: Object.freeze({ ...lift.arrival }) }))),
    fixtures: Object.freeze(fixtures.map((fixture) => Object.freeze({ ...fixture }))),
    rooftop: rooftop ? Object.freeze({ ...rooftop }) : null,
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
  validateFloor(definition, exit);
}

/**
 * A floor reached by lift. It has no exit, so it needs at least one lift, and
 * unlike a ground floor it may have no station at all (a roof).
 */
export function validateFixedRoomLevel(definition: FixedRoomLevelDefinition): void {
  if (!positiveInteger(definition.width) || !positiveInteger(definition.height)) {
    rejectDefinition('invalid-dimensions');
  }
  if (definition.level !== 'degen' && definition.level !== 'roof') rejectDefinition('invalid-level');
  if (!Array.isArray(definition.stations)) rejectDefinition('invalid-station');
  if (!Array.isArray(definition.lifts) || definition.lifts.length === 0) rejectDefinition('invalid-lift');
  const rooftop = definition.rooftop;
  if (
    rooftop !== undefined &&
    (!Number.isInteger(rooftop.x) ||
      !Number.isInteger(rooftop.y) ||
      rooftop.x < 0 ||
      rooftop.y < 0 ||
      !Number.isFinite(rooftop.height) ||
      rooftop.height <= 0)
  ) {
    rejectDefinition('invalid-level');
  }
  validateFloor(definition, null);
}

/**
 * Checks shared by every floor: stations, lifts and the spawn. A lift pad
 * stands inside the room or in its wall like an exit, never on a station, its
 * approach, another pad or the exit; its arrival is a free floor tile outside
 * every approach, so stepping out of a lift never opens a counter.
 */
function validateFloor(definition: FixedRoomFloorDefinition, exit: FixedRoomRect | null): void {
  const { width, height } = definition;
  const stationIds = new Set<StationId>();
  for (const station of definition.stations) {
    const correctPrefix =
      typeof station.station === 'string' &&
      station.station.startsWith(`${definition.building}:`) &&
      station.station.length > definition.building.length + 1;
    const validLabel = typeof station.label === 'string' && station.label.trim().length > 0;
    if (
      !validRect(station) ||
      !rectStrictlyInside(station, width, height) ||
      !correctPrefix ||
      !validLabel ||
      (exit !== null && rectanglesOverlap(station, exit))
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

  const lifts = definition.lifts ?? [];
  if (!Array.isArray(lifts)) rejectDefinition('invalid-lift');
  const inApproach = (x: number, y: number): boolean =>
    definition.stations.some((station) => isInside(expandRect(station), x, y));
  for (const [index, lift] of lifts.entries()) {
    if (!validRect(lift) || !rectInside(lift, width, height)) rejectDefinition('invalid-lift');
    let inside = 0;
    let wall = 0;
    forEachCell(lift, (x, y) => {
      if (!onBorder(x, y, width, height)) inside += 1;
      else if (!isCorner(x, y, width, height)) wall += 1;
    });
    const cells = lift.width * lift.height;
    if (inside !== cells && wall !== cells) rejectDefinition('invalid-lift');
    if (exit !== null && rectanglesOverlap(lift, exit)) rejectDefinition('invalid-lift');
    for (const station of definition.stations) {
      if (rectanglesOverlap(lift, expandRect(station))) rejectDefinition('invalid-lift');
    }
    for (const other of lifts.slice(index + 1)) {
      if (rectanglesOverlap(lift, other)) rejectDefinition('invalid-lift');
    }
    if (!isFloorLevel(lift.to)) rejectDefinition('invalid-lift');
    const arrival = lift.arrival;
    const validArrival =
      arrival !== null &&
      typeof arrival === 'object' &&
      Number.isInteger(arrival.x) &&
      Number.isInteger(arrival.y) &&
      arrival.x > 0 &&
      arrival.x < width - 1 &&
      arrival.y > 0 &&
      arrival.y < height - 1 &&
      !definition.stations.some((station) => isInside(station, arrival.x, arrival.y)) &&
      !inApproach(arrival.x, arrival.y) &&
      !lifts.some((candidate) => isInside(candidate, arrival.x, arrival.y));
    if (!validArrival) rejectDefinition('invalid-lift');
  }

  const spawn = definition.spawn;
  const validSpawn =
    Number.isInteger(spawn.x) &&
    Number.isInteger(spawn.y) &&
    spawn.x > 0 &&
    spawn.x < width - 1 &&
    spawn.y > 0 &&
    spawn.y < height - 1 &&
    !definition.stations.some((station) => isInside(station, spawn.x, spawn.y)) &&
    !lifts.some((lift) => isInside(lift, spawn.x, spawn.y)) &&
    !(exit !== null && isInside(exit, spawn.x, spawn.y));
  if (!validSpawn) rejectDefinition('invalid-spawn');

  const fixtures = definition.fixtures ?? [];
  if (!Array.isArray(fixtures)) rejectDefinition('invalid-fixture');
  for (const [index, fixture] of fixtures.entries()) {
    if (
      !validRect(fixture) ||
      !rectStrictlyInside(fixture, width, height) ||
      definition.stations.some((station) => rectanglesOverlap(fixture, station)) ||
      lifts.some((lift) => rectanglesOverlap(fixture, lift) || isInside(fixture, lift.arrival.x, lift.arrival.y)) ||
      fixtures.slice(index + 1).some((other) => rectanglesOverlap(fixture, other)) ||
      isInside(fixture, spawn.x, spawn.y) ||
      (fixture.prop !== undefined && !FIXED_ROOM_PROPS.includes(fixture.prop))
    ) {
      rejectDefinition('invalid-fixture');
    }
  }
  if (!everythingReachable(definition, exit)) rejectDefinition('unreachable');
}

/**
 * Walking from the spawn over free floor, can the player step up to every
 * counter (one free tile of its approach), onto every lift pad and onto the
 * exit? Furniture must never wall any of them off.
 */
const FIXED_ROOM_PROPS: readonly FixedRoomProp[] = ['trading-pod', 'high-table', 'pillar-box', 'writing-desk', 'bench'];

function everythingReachable(definition: FixedRoomFloorDefinition, exit: FixedRoomRect | null): boolean {
  const { width, height, spawn } = definition;
  const seen = new Set<number>([spawn.y * width + spawn.x]);
  const queue: [number, number][] = [[spawn.x, spawn.y]];
  const steps: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const key = ny * width + nx;
      if (seen.has(key)) continue;
      // A pad or the exit is reached by stepping onto it, never walked through.
      if (
        (definition.lifts ?? []).some((lift) => isInside(lift, nx, ny)) ||
        (exit !== null && isInside(exit, nx, ny))
      ) {
        seen.add(key);
        continue;
      }
      if (!walkableOn(definition, nx, ny)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  const reached = (x: number, y: number): boolean => seen.has(y * width + x);
  const reachedIn = (rect: FixedRoomRect, skip: FixedRoomRect | null): boolean => {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if (skip && isInside(skip, x, y)) continue;
        if (reached(x, y)) return true;
      }
    }
    return false;
  };
  return (
    definition.stations.every((station) => reachedIn(expandRect(station), station)) &&
    (definition.lifts ?? []).every((lift) => reachedIn(lift, null)) &&
    (exit === null || reachedIn(exit, null))
  );
}

/**
 * A building's floors as one: the levels belong to the ground floor's
 * building, have distinct ids, every lift rides to another floor that has
 * exactly one pad back (so its arrival is unambiguous), every floor can be
 * reached from the ground floor, and no station id repeats across floors,
 * because the Shell sees one building (D-030).
 */
export function validateFixedRoomLevels(
  ground: FixedRoomDefinition,
  levels: readonly FixedRoomLevelDefinition[],
): void {
  if (!Array.isArray(levels)) rejectDefinition('invalid-level');
  const floors = new Map<FixedRoomLevelId, FixedRoomFloorDefinition>([['ground', ground]]);
  for (const level of levels) {
    if (level.building !== ground.building || floors.has(level.level)) rejectDefinition('invalid-level');
    floors.set(level.level, level);
  }
  const stationIds = new Set<StationId>();
  for (const [id, floor] of floors) {
    for (const station of floor.stations) {
      if (stationIds.has(station.station)) rejectDefinition('duplicate-station');
      stationIds.add(station.station);
    }
    for (const lift of floor.lifts ?? []) {
      const target = floors.get(lift.to);
      if (!target || lift.to === id) rejectDefinition('invalid-lift');
      const back = (target.lifts ?? []).filter((candidate) => candidate.to === id);
      if (back.length !== 1) rejectDefinition('invalid-lift');
    }
    const destinations = (floor.lifts ?? []).map((lift) => lift.to);
    if (new Set(destinations).size !== destinations.length) rejectDefinition('invalid-lift');
  }
  // A key still held from a ride must walk the rider away from the pad they
  // step out beside, never straight back onto it (see `arrival`).
  for (const [id, floor] of floors) {
    for (const lift of floor.lifts ?? []) {
      const target = floors.get(lift.to)!;
      const back = (target.lifts ?? []).find((candidate) => candidate.to === id)!;
      for (const [dx, dy] of entryDirections(floor, lift)) {
        if (walksOnto(target, back.arrival, dx, dy, back)) rejectDefinition('invalid-lift');
      }
    }
  }
  const reached = new Set<FixedRoomLevelId>(['ground']);
  const queue: FixedRoomLevelId[] = ['ground'];
  while (queue.length > 0) {
    const floor = floors.get(queue.pop()!)!;
    for (const lift of floor.lifts ?? []) {
      if (reached.has(lift.to)) continue;
      reached.add(lift.to);
      queue.push(lift.to);
    }
  }
  if (reached.size !== floors.size) rejectDefinition('invalid-level');
}

/** Whether a floor tile can be walked on: inside the grid, not a wall or a counter. */
function walkableOn(floor: FixedRoomFloorDefinition, x: number, y: number): boolean {
  if (x <= 0 || y <= 0 || x >= floor.width - 1 || y >= floor.height - 1) {
    // The border is wall, except where a pad stands in it.
    return (floor.lifts ?? []).some((lift) => isInside(lift, x, y));
  }
  return (
    !floor.stations.some((station) => isInside(station, x, y)) &&
    !(floor.fixtures ?? []).some((fixture) => isInside(fixture, x, y))
  );
}

/** The straight directions a player can step onto `lift` from a free tile beside it. */
function entryDirections(floor: FixedRoomFloorDefinition, lift: FixedRoomLiftDefinition): [number, number][] {
  const found = new Map<string, [number, number]>();
  forEachCell(lift, (x, y) => {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const fromX = x - dx;
      const fromY = y - dy;
      if (isInside(lift, fromX, fromY) || !walkableOn(floor, fromX, fromY)) continue;
      found.set(`${dx},${dy}`, [dx, dy]);
    }
  });
  return [...found.values()];
}

/** Walking straight from `start` until something stops the walk: does it step onto `pad`? */
function walksOnto(
  floor: FixedRoomFloorDefinition,
  start: { readonly x: number; readonly y: number },
  dx: number,
  dy: number,
  pad: FixedRoomRect,
): boolean {
  let x = start.x;
  let y = start.y;
  for (let steps = 0; steps < floor.width + floor.height; steps++) {
    x += dx;
    y += dy;
    if (isInside(pad, x, y)) return true;
    if (!walkableOn(floor, x, y)) return false;
  }
  return false;
}

export function fixedRoomTileAt(room: FixedRoomLevelMap, x: number, y: number): FixedRoomTile | null {
  return room.tiles[y]?.[x] ?? null;
}

export function isFixedRoomSolidAt(room: FixedRoomLevelMap, x: number, y: number): boolean {
  const tile = fixedRoomTileAt(room, x, y);
  return tile === null || tile === 'wall' || tile === 'station' || tile === 'fixture';
}

export function isFixedRoomExit(room: FixedRoomLevelMap, x: number, y: number): boolean {
  return room.exit !== null && isInside(room.exit, x, y);
}

/** The lift pad under a tile, if any: walking onto it rides to its floor. */
export function fixedRoomLiftAt(room: FixedRoomLevelMap, x: number, y: number): FixedRoomLiftDefinition | null {
  return room.lifts.find((lift) => isInside(lift, x, y)) ?? null;
}

export function fixedRoomStationAtApproach(
  room: Pick<FixedRoomLevelMap, 'stations'>,
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

export function isFixedRoomApproach(room: Pick<FixedRoomLevelMap, 'stations'>, x: number, y: number): boolean {
  return fixedRoomStationAtApproach(room, x, y) !== null;
}

/**
 * Project controller state into independent station render models. Keeping
 * this Phaser-free prevents a renderer from accidentally reusing one label
 * object and overwriting all but the final station.
 */
export function fixedRoomStationPresentations(
  room: Pick<FixedRoomLevelMap, 'stations'>,
  state: FixedRoomState,
): readonly FixedRoomStationPresentation[] {
  const snapshots = Array.isArray(state.stations) ? state.stations : [];
  return room.stations.map((station) => {
    const snapshot = snapshots.find((candidate) => (
      ownDataField(candidate, 'station') === station.station
    ));
    const label = ownDataField(snapshot, 'label');
    const status = ownDataField(snapshot, 'status');
    const validLabel = typeof label === 'string' && label.trim().length > 0;
    const validStatus = status === 'available' || status === 'locked';
    return {
      ...station,
      label: validLabel ? label : station.label,
      status: snapshot && validLabel && validStatus ? status : 'locked',
      highlighted: state.highlightedStation === station.station,
    };
  });
}

/** Normalize only the definition's station ids; unknown input has no power. */
export function normalizeFixedRoomStations(
  definition: Pick<FixedRoomFloorDefinition, 'stations'>,
  stations: readonly ShellEvents['world:stations']['stations'][number][] | undefined,
): readonly FixedRoomStationSnapshot[] {
  return Object.freeze(definition.stations.map((known) => {
    // D-103: a snapshot that names a renamed counter by its old id still
    // reaches it; two entries for one counter stay ambiguous, so locked.
    const candidates = Array.isArray(stations)
      ? stations.filter((candidate) => {
          const id = ownDataField(candidate, 'station');
          return typeof id === 'string' && canonicalFixedRoomStation(id as StationId) === known.station;
        })
      : [];
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    const label = ownDataField(candidate, 'label');
    const status = ownDataField(candidate, 'status');
    const validLabel = typeof label === 'string' && label.trim().length > 0;
    const validStatus = status === 'available' || status === 'locked';
    return Object.freeze({
      station: known.station,
      label: validLabel ? label : known.label,
      status: candidate && validLabel && validStatus ? status : 'locked',
    });
  }));
}

export function createFixedRoomController(
  options: FixedRoomControllerOptions,
): FixedRoomController {
  const ground = createFixedRoom(options.definition);
  const levels = options.levels ?? [];
  validateFixedRoomLevels(options.definition, levels);
  const floors = new Map<FixedRoomLevelId, FixedRoomLevelMap>([['ground', ground]]);
  for (const definition of levels) floors.set(definition.level, createFixedRoomLevel(definition));
  const floorOf = (id: FixedRoomLevelId): FixedRoomLevelMap => floors.get(id) ?? ground;
  // The Shell sees one building (D-030): one station snapshot covers every floor.
  const building = Object.freeze({
    stations: Object.freeze([...floors.values()].flatMap((floor) => floor.stations)),
  });
  const armAll = (): Set<StationId> => new Set(building.stations.map((station) => station.station));
  let inRoom = false;
  let level: FixedRoomLevelId = 'ground';
  let controlOwner: 'world' | 'shell' = 'world';
  let highlightedStation: StationId | null = null;
  let stations = normalizeFixedRoomStations(building, undefined);
  let destroyed = false;
  let approachArmed = armAll();
  // The tile the World last reported in this room: a counter that becomes
  // available while the player already stands at it activates from here.
  let standing: { readonly x: number; readonly y: number } | null = null;

  const state = (): FixedRoomState => ({
    inRoom,
    building: inRoom ? options.definition.building : null,
    level: inRoom ? level : null,
    controlOwner,
    highlightedStation,
    stations,
  });
  const publish = (): void => options.onChange?.(state());
  const ownsWorldControl = (): boolean => controlOwner === 'world';

  let stopStations: (() => void) | undefined;
  let stopOwner: (() => void) | undefined;
  let stopExit: (() => void) | undefined;
  let destroyPending = false;
  let destroying = false;
  let inputCleanupPending = true;
  let updateRevision = 0;
  try {
    stopStations = options.in?.on('world:stations', (payload) => {
    if (destroyed || !inRoom || ownDataField(payload, 'building') !== options.definition.building) return;
    const waiting = highlightedStation;
    const wasAvailable = stations.some((station) => station.station === waiting && station.status === 'available');
    stations = normalizeFixedRoomStations(
      building,
      ownDataField(payload, 'stations') as ShellEvents['world:stations']['stations'] | undefined,
    );
      publish();
      // Activation otherwise runs only on a tile change. If this snapshot made
      // the counter the player already stands at available, step up to it now
      // through the same path, with its arming and ownership guards.
      const nowAvailable = stations.some((station) => station.station === waiting && station.status === 'available');
      if (waiting && standing && !wasAvailable && nowAvailable && highlightedStation === waiting) api.update(standing);
    });
    stopOwner = options.in?.on('world:control-owner', (payload) => {
    if (destroyed || !inRoom || ownDataField(payload, 'building') !== options.definition.building) return;
      const owner = ownDataField(payload, 'owner');
      if (owner !== 'world' && owner !== 'shell') return;
      const previousControlOwner = controlOwner;
      controlOwner = owner;
      try {
        if (controlOwner === 'shell') options.input.suspend();
        else options.input.resume();
      } catch (error) {
        // Do not publish ownership the input handoff did not establish. The
        // concrete gate retains Shell ownership when suspension reached a
        // partial disabled state, so preserve that state; otherwise restore
        // the previous owner and let the caller retry the command.
        let inputStateMatches = false;
        try {
          inputStateMatches = options.input.suspended === (owner === 'shell');
        } catch {
          // A hostile status accessor must not mask the original handoff error.
        }
        if (controlOwner === owner && !inputStateMatches) {
          controlOwner = previousControlOwner;
        }
        throw error;
      }
      publish();
    });
    stopExit = options.in?.on('world:exit-building', (payload) => {
    if (destroyed || !inRoom || ownDataField(payload, 'building') !== options.definition.building) return;
      leave();
    });
  } catch (error) {
    for (const stop of [stopExit, stopOwner, stopStations]) {
      if (!stop) continue;
      try { stop(); } catch { /* preserve registration failure */ }
    }
    throw error;
  }

  /**
   * Show a floor again after a failed handoff: the ground floor through the
   * room's own entry (the player at its spawn), an upper floor where the
   * player stood. Best effort: the handoff's own error stays authoritative.
   */
  function presentFloor(floor: FixedRoomLevelId, tile: { readonly x: number; readonly y: number } | null): void {
    try {
      if (floor === 'ground' && tile === null) options.onEnter?.();
      else options.onLevel?.(floor, tile ?? floorOf(floor).spawn);
    } catch {
      // Preserve the original handoff error.
    }
  }

  function leave(): void {
    if (!inRoom) return;
    const previousControlOwner = controlOwner;
    const previousHighlightedStation = highlightedStation;
    const previousApproachArmed = approachArmed;
    const previousLevel = level;
    const previousStanding = standing;
    inRoom = false;
    level = 'ground';
    controlOwner = 'world';
    highlightedStation = null;
    approachArmed = armAll();
    standing = null;
    const restoreInside = (keepStanding: boolean): void => {
      inRoom = true;
      level = previousLevel;
      controlOwner = previousControlOwner;
      highlightedStation = previousHighlightedStation;
      approachArmed = previousApproachArmed;
      if (keepStanding) standing = previousStanding;
    };
    // Compensate a presentation that already left. From the ground floor the
    // room's own entry re-presents it (the player back at its spawn, so the
    // tile they stood on is no longer known), as before floors existed; from
    // any other floor the player is put back where they stood.
    const restorePresented = (): void => {
      restoreInside(previousLevel !== 'ground');
      presentFloor(previousLevel, previousLevel === 'ground' ? null : previousStanding);
    };
    try {
      options.input.resume();
    } catch (error) {
      // Input restoration is an external lifecycle boundary. Keep the room
      // owned when it fails so the same exit can retry the transition.
      restoreInside(true);
      throw error;
    }
    // Input restoration is an external synchronous boundary. It may retire
    // this controller (or synchronously re-enter it) before presentation gets
    // the continuation. Do not invoke an onExit callback for that stale turn.
    if (destroyed || inRoom) return;
    try {
      options.onExit?.();
    } catch (error) {
      // Room presentation is an external lifecycle boundary. If it fails,
      // keep this transition retryable unless the callback already retired or
      // replaced the controller's ownership synchronously.
      if (!destroyed && !inRoom) restorePresented();
      throw error;
    }
    if (destroyed || inRoom) return;
    try {
      publish();
    } catch (error) {
      // Exit state publication is an external lifecycle boundary. If the
      // renderer rejects the outside snapshot, compensate the presentation
      // and restore the prior room state so the exit can be retried.
      if (!destroyed && !inRoom) restorePresented();
      throw error;
    }
    // Exit publication is synchronous and may immediately re-enter the room.
    // Do not announce an outside transition after that newer ownership wins.
    if (destroyed || inRoom) return;
    try {
      options.out.emit('building:exited', Object.freeze({
        building: options.definition.building,
      }));
    } catch (error) {
      // The semantic announcement is an external lifecycle boundary. If it
      // fails after the presentation has left, restore the room so the same
      // exit can be retried coherently once the consumer recovers.
      if (!destroyed && !inRoom) restorePresented();
      throw error;
    }
  }

  /**
   * Ride a lift: change floors inside the same building. Nothing reaches the
   * Shell, which still sees one building (D-030); presence stays suspended
   * throughout (D-019). A failed handoff puts the rider back on the pad's
   * floor, where the same step retries it.
   */
  function ride(lift: FixedRoomLiftDefinition, tile: { readonly x: number; readonly y: number }): void {
    const from = level;
    const to = lift.to;
    const back = floorOf(to).lifts.find((candidate) => candidate.to === from);
    if (!back || !floors.has(to)) return;
    const previousHighlightedStation = highlightedStation;
    const previousApproachArmed = approachArmed;
    const rollback = (): void => {
      if (destroyed || !inRoom || level !== to) return;
      level = from;
      highlightedStation = previousHighlightedStation;
      approachArmed = previousApproachArmed;
      standing = { x: tile.x, y: tile.y };
      presentFloor(from, tile);
    };
    level = to;
    highlightedStation = null;
    approachArmed = armAll();
    standing = null;
    try {
      options.onLevel?.(to, back.arrival);
    } catch (error) {
      rollback();
      throw error;
    }
    // The ride's presentation is synchronous and may retire the controller,
    // leave the building or ride again; this turn is then stale.
    if (destroyed || !inRoom || level !== to) return;
    try {
      publish();
    } catch (error) {
      rollback();
      throw error;
    }
  }

  const api: FixedRoomController = {
    get state() {
      return state();
    },
    enter(): void {
      if (destroyed || inRoom) return;
      inRoom = true;
      // The street door always opens onto the ground floor.
      level = 'ground';
      controlOwner = 'world';
      highlightedStation = null;
      standing = null;
      approachArmed = armAll();
      stations = normalizeFixedRoomStations(building, undefined);
      try {
        options.input.resume();
      } catch (error) {
        // Input restoration is an external lifecycle boundary. If it fails,
        // do not leave the controller claiming an interior it cannot operate;
        // a later explicit enter can retry the same restoration.
        inRoom = false;
        controlOwner = 'world';
        highlightedStation = null;
        approachArmed = armAll();
        throw error;
      }
      // Input restoration is an external synchronous boundary. A callback
      // can destroy the controller before presentation entry starts; retain
      // the retired state and stop this stale continuation.
      if (destroyed || !inRoom) return;
      try {
        options.onEnter?.();
      } catch (error) {
        // Room presentation is an external lifecycle boundary. If it fails,
        // compensate any partial presentation before releasing logical room
        // ownership. A later explicit enter can then retry the same complete
        // transition instead of inheriting a half-entered renderer.
        const shouldCompensate = !destroyed && inRoom;
        inRoom = false;
        controlOwner = 'world';
        highlightedStation = null;
        approachArmed = armAll();
        if (shouldCompensate) {
          try {
            options.onExit?.();
          } catch {
            // Preserve the original entry error.
          }
        }
        throw error;
      }
      if (destroyed || !inRoom) return;
      try {
        publish();
      } catch (error) {
        // The first room snapshot completes entry. If delivery fails, roll
        // back the presentation and logical owner so a later enter can retry.
        if (!destroyed && inRoom) {
          inRoom = false;
          level = 'ground';
          controlOwner = 'world';
          highlightedStation = null;
          approachArmed = armAll();
          try {
            options.onExit?.();
          } catch {
            // Preserve the original publication error.
          }
        }
        throw error;
      }
    },
    update(tile): void {
      if (destroyed || !inRoom) return;
      standing = { x: tile.x, y: tile.y };
      const floor = floorOf(level);
      // Stepping off every approach re-arms the counters even while a window
      // holds the controls. The session reports each tile once, so a step
      // that lands as a counter opens is never reported again: dropping it
      // here left that counter disarmed, and walking back did not reopen it.
      if (!fixedRoomStationAtApproach(floor, tile.x, tile.y)) approachArmed = armAll();
      if (controlOwner === 'shell') return;
      const ownRevision = ++updateRevision;
      if (isFixedRoomExit(floor, tile.x, tile.y)) {
        leave();
        return;
      }
      const lift = fixedRoomLiftAt(floor, tile.x, tile.y);
      if (lift) {
        ride(lift, tile);
        return;
      }

      const approached = fixedRoomStationAtApproach(floor, tile.x, tile.y);
      if (!approached) approachArmed = armAll();
      const nextHighlighted = approached?.station ?? null;
      if (nextHighlighted !== highlightedStation) {
        highlightedStation = nextHighlighted;
        publish();
      }
      // onChange delivery is synchronous and may destroy the room or let
      // Shell claim control before this update resumes. It may also run a
      // newer update, so do not activate the stale station from this turn.
      if (destroyed || !inRoom || !ownsWorldControl() || updateRevision !== ownRevision) return;
      const station = stations.find((candidate) => candidate.station === nextHighlighted);
      if (approached && station?.status === 'available' && approachArmed.has(approached.station)) {
        approachArmed.delete(approached.station);
        try {
          options.input.suspend();
        } catch (error) {
          // Input suspension is an external lifecycle boundary. Keep the
          // station armed when it fails so the same approach can be retried.
          approachArmed.add(approached.station);
          throw error;
        }
        // Input suspension is synchronous and may retire this controller,
        // transfer control to Shell, or trigger a newer update before the
        // handoff below. Do not emit station activation for that stale turn.
        if (destroyed || !inRoom || !ownsWorldControl() || updateRevision !== ownRevision) {
          if (!destroyed && inRoom) approachArmed.add(approached.station);
          return;
        }
        let deliveryError: unknown;
        let deliveryFailed = false;
        try {
          options.out.emit('station:activated', Object.freeze({
            building: options.definition.building,
            station: approached.station,
          }));
        } catch (error) {
          deliveryError = error;
          deliveryFailed = true;
        }
        try {
          // EventBus delivery is synchronous and may throw. A stale/missing
          // Shell claim or failed consumer must not strand the player with
          // World input suspended.
          if (!destroyed && inRoom && ownsWorldControl()) options.input.resume();
        } catch (error) {
          if (deliveryFailed && !destroyed && inRoom) approachArmed.add(approached.station);
          if (deliveryFailed) {
            throw new AggregateError(
              [deliveryError, error],
              'Fixed-room station activation failed',
            );
          }
          throw error;
        }
        if (deliveryFailed) {
          // A failed synchronous handoff did not complete station activation.
          // Keep the same approach retryable unless this controller has
          // already left its lifecycle; leaving or destruction owns reset.
          if (!destroyed && inRoom) approachArmed.add(approached.station);
          throw deliveryError;
        }
      }
    },
    destroy(): void {
      if (destroying || (destroyed && !destroyPending)) return;
      destroying = true;
      destroyed = true;
      const errors: unknown[] = [];
      const attempt = (cleanup: () => void): void => {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      };
      if (stopStations) {
        const stop = stopStations;
        attempt(() => {
          stop();
          stopStations = undefined;
        });
      }
      if (stopOwner) {
        const stop = stopOwner;
        attempt(() => {
          stop();
          stopOwner = undefined;
        });
      }
      if (stopExit) {
        const stop = stopExit;
        attempt(() => {
          stop();
          stopExit = undefined;
        });
      }
      inRoom = false;
      level = 'ground';
      controlOwner = 'world';
      highlightedStation = null;
      if (inputCleanupPending) {
        attempt(() => {
          options.input.resume();
          inputCleanupPending = false;
        });
      }
      destroyPending = errors.length > 0;
      destroying = false;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Fixed-room cleanup failed');
    },
  };
  return api;
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

function isCorner(x: number, y: number, width: number, height: number): boolean {
  return (x === 0 || x === width - 1) && (y === 0 || y === height - 1);
}

function isFloorLevel(level: unknown): level is FixedRoomLevelId {
  return level === 'ground' || level === 'degen' || level === 'roof';
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
