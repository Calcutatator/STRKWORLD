import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BUILDINGS,
  BUILDINGS,
  PITCH_AREA,
  PRESENCE_AREAS,
  SANDBOX_AREA,
  SHIELDED_BUILDINGS,
  STREET_ORIGIN_X,
  type EventBus,
  type ShellEvents,
  type WorldEvents,
} from '@strkworld/shared';
import {
  BUNKER_ALLEY,
  BUNKER_BUILDING,
  BUNKER_DOOR,
  BUNKER_STAIRWELL,
  BUNKER_TILES,
  BUNKER_VENDING,
  inBunkerRect,
} from './map/bunker.js';
import { PLAZA_AREA, PLAZA_NEARBY } from './map/plaza.js';
import { createStreetMap, doorAt, isSolidAt, type DistrictMap } from './map/street.js';
import {
  BUNKER_ELEVATOR_STATION,
  BUNKER_ROOM_DEFINITION,
  FIXED_ROOM_DEFINITIONS,
  createFixedRoom,
  createFixedRoomController,
  fixedRoomStationAtApproach,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  normalizeFixedRoomStations,
  type FixedRoomState,
} from './fixed-room.js';

/**
 * The hidden room (D-107), as data: where its stair is on the street, the
 * room under it, and the lift that only says it is out of order.
 */

const X = STREET_ORIGIN_X;
const map = createStreetMap();

function inRect(rect: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Street tiles reachable from the spawn; a door is reached but never walked through. */
function streetReach(district: DistrictMap): Set<string> {
  const reached = new Set<string>([`${district.spawn.x},${district.spawn.y}`]);
  const queue = [district.spawn];
  while (queue.length > 0) {
    const tile = queue.pop()!;
    if (doorAt(district, tile.x, tile.y)) continue;
    for (const next of [
      { x: tile.x + 1, y: tile.y },
      { x: tile.x - 1, y: tile.y },
      { x: tile.x, y: tile.y + 1 },
      { x: tile.x, y: tile.y - 1 },
    ]) {
      const key = `${next.x},${next.y}`;
      if (reached.has(key) || isSolidAt(district, next.x, next.y)) continue;
      reached.add(key);
      queue.push(next);
    }
  }
  return reached;
}

describe('the hidden stair on the street (D-107)', () => {
  it('stands across the road from the Privacy Plaza, in the alley between the Bridge and the Exchange', () => {
    // The plaza is south of the road, the stair north of it, inside the plaza's columns.
    expect(BUNKER_DOOR.x).toBeGreaterThanOrEqual(PLAZA_AREA.x);
    expect(BUNKER_DOOR.x).toBeLessThan(PLAZA_AREA.x + PLAZA_AREA.width);
    expect(BUNKER_DOOR.x - X).toBe(10);
    const roadRows = [...Array(map.height).keys()].filter((y) => map.tiles[y]![X + 10] === 'road');
    expect(Math.max(...BUNKER_TILES.map((tile) => tile.y + tile.height - 1))).toBeLessThan(Math.min(...roadRows));
    expect(PLAZA_AREA.y).toBeGreaterThan(Math.max(...roadRows));
    // The alley: the Bridge's east wall on one side, the Exchange's west wall
    // on the other. The west lot was the Bank's when the stair was laid; the
    // lots swapped in D-110 and the stair stayed put.
    for (let y = BUNKER_ALLEY.y; y < BUNKER_ALLEY.y + BUNKER_ALLEY.height; y++) {
      expect(['wall', 'facade']).toContain(map.tiles[y]![BUNKER_ALLEY.x - 1]);
      expect(['wall', 'facade']).toContain(map.tiles[y]![BUNKER_ALLEY.x + BUNKER_ALLEY.width]);
    }
    const doorOf = (building: string) => map.doors.find((door) => door.building === building)!;
    // Each building's two-tile door is centred on its seven-tile lot, two
    // tiles in from its west wall: the Bridge's lot ends where the alley
    // begins, and the Exchange's begins where it ends.
    expect(doorOf('bridge').x + 5).toBe(BUNKER_ALLEY.x);
    expect(doorOf('exchange').x - 2).toBe(BUNKER_ALLEY.x + BUNKER_ALLEY.width);
    expect(doorOf('bank').x).toBeGreaterThan(BUNKER_ALLEY.x);
    for (const tile of BUNKER_TILES) {
      for (let y = tile.y; y < tile.y + tile.height; y++) {
        for (let x = tile.x; x < tile.x + tile.width; x++) expect(inBunkerRect(BUNKER_ALLEY, x, y)).toBe(true);
      }
    }
  });

  it('takes three tiles of the alley\'s grass and nothing else: one step to stand on, two solid', () => {
    expect(BUNKER_TILES.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(3);
    expect(map.tiles[BUNKER_DOOR.y]![BUNKER_DOOR.x]).toBe('stairhead');
    expect(isSolidAt(map, BUNKER_DOOR.x, BUNKER_DOOR.y)).toBe(false);
    for (const solid of [BUNKER_STAIRWELL, BUNKER_VENDING]) {
      expect(map.tiles[solid.y]![solid.x]).toBe('service');
      expect(isSolidAt(map, solid.x, solid.y)).toBe(true);
    }
    // Everything else in the alley is still grass.
    for (let y = BUNKER_ALLEY.y; y < BUNKER_ALLEY.y + BUNKER_ALLEY.height; y++) {
      for (let x = BUNKER_ALLEY.x; x < BUNKER_ALLEY.x + BUNKER_ALLEY.width; x++) {
        if (BUNKER_TILES.some((tile) => inRect(tile, x, y))) continue;
        expect(map.tiles[y]![x], `${x},${y}`).toBe('grass');
      }
    }
  });

  it('overlaps nothing: no walkway, no square, no building, no plaza, no spawn or Studio path', () => {
    const studio = { x: X + 23, y: 17, width: 2, height: map.height - 17 };
    for (const tile of BUNKER_TILES) {
      for (let y = tile.y; y < tile.y + tile.height; y++) {
        for (let x = tile.x; x < tile.x + tile.width; x++) {
          for (const area of [PLAZA_AREA, PLAZA_NEARBY, PITCH_AREA, SANDBOX_AREA, studio]) expect(inRect(area, x, y)).toBe(false);
          expect(x === map.spawn.x && y === map.spawn.y).toBe(false);
          // Off the pavements and the road: those rows are unchanged.
          expect(y).toBeLessThan(11);
        }
      }
    }
    // The pavement either side and the road run on unbroken past the alley.
    for (const y of [11, 12, 13, 14, 15, 16, 17, 18]) {
      for (let x = X; x < SANDBOX_AREA.x - 1; x++) expect(isSolidAt(map, x, y), `${x},${y}`).toBe(false);
    }
    expect(map.tiles[BUNKER_DOOR.y + 1]![BUNKER_DOOR.x]).toBe('pavement');
  });

  it('is reached from the spawn like any door, and every building\'s door still is', () => {
    const reached = streetReach(map);
    for (const door of map.doors) expect(reached.has(`${door.x},${door.y}`), door.building).toBe(true);
    expect(doorAt(map, BUNKER_DOOR.x, BUNKER_DOOR.y)).toEqual({ building: BUNKER_BUILDING, ...BUNKER_DOOR, locked: false });
    expect(map.doors.filter((door) => door.building === BUNKER_BUILDING)).toHaveLength(1);
    // No label anywhere on the street names it.
    expect(map.exteriorLabels.some((label) => label.building === BUNKER_BUILDING)).toBe(false);
  });

  it('is no building, no shared area and nothing financial', () => {
    expect(BUILDINGS).not.toContain(BUNKER_BUILDING);
    expect(ACTIVE_BUILDINGS).not.toContain(BUNKER_BUILDING);
    expect(SHIELDED_BUILDINGS).not.toContain(BUNKER_BUILDING);
    // Solo: it is no presence area, so entering it suspends presence (D-019, D-087).
    expect(PRESENCE_AREAS as readonly string[]).not.toContain(BUNKER_BUILDING);
  });
});

describe('the hidden room (D-107)', () => {
  const room = createFixedRoom(BUNKER_ROOM_DEFINITION);

  /** Room tiles reachable from the spawn, not through the exit. */
  function reachable(): Set<string> {
    const reached = new Set<string>([`${room.spawn.x},${room.spawn.y}`]);
    const queue = [room.spawn];
    while (queue.length > 0) {
      const tile = queue.pop()!;
      for (const next of [
        { x: tile.x + 1, y: tile.y },
        { x: tile.x - 1, y: tile.y },
        { x: tile.x, y: tile.y + 1 },
        { x: tile.x, y: tile.y - 1 },
      ]) {
        const key = `${next.x},${next.y}`;
        if (reached.has(key) || isFixedRoomSolidAt(room, next.x, next.y) || isFixedRoomExit(room, next.x, next.y)) continue;
        reached.add(key);
        queue.push(next);
      }
    }
    return reached;
  }

  it('is an always-open room with one station, the lift, held for the floors to come', () => {
    expect(FIXED_ROOM_DEFINITIONS.bunker).toBe(BUNKER_ROOM_DEFINITION);
    expect(room.stations.map((station) => station.station)).toEqual([BUNKER_ELEVATOR_STATION]);
    expect(room.stations[0]!.reserved).toBe(true);
  });

  it('keeps the lift right by the stair: its approach one step from the spawn', () => {
    const lift = room.stations[0]!;
    expect(fixedRoomStationAtApproach(room, room.spawn.x, room.spawn.y)).toBeNull();
    expect(fixedRoomStationAtApproach(room, room.spawn.x, room.spawn.y - 1)?.station).toBe(lift.station);
    // The stair (the exit) is directly behind the spawn.
    expect(isFixedRoomExit(room, room.spawn.x, room.spawn.y + 1)).toBe(true);
  });

  it('reaches every booth, the lift and the stair from the spawn', () => {
    const reached = reachable();
    const booths = room.fixtures.filter((fixture) => fixture.prop === 'pc-booth');
    let cells = 0;
    for (const booth of booths) {
      for (let y = booth.y; y < booth.y + booth.height; y++) {
        for (let x = booth.x; x < booth.x + booth.width; x++) {
          cells += 1;
          const fronts = [
            [x, y + 1],
            [x, y - 1],
            [x - 1, y],
            [x + 1, y],
          ].filter(([fx, fy]) => reached.has(`${fx},${fy}`));
          expect(fronts.length, `booth ${x},${y}`).toBeGreaterThan(0);
        }
      }
    }
    expect(cells).toBe(25);
    const lift = room.stations[0]!;
    const approach: string[] = [];
    for (let y = lift.y - 1; y <= lift.y + lift.height; y++) {
      for (let x = lift.x - 1; x <= lift.x + lift.width; x++) if (reached.has(`${x},${y}`)) approach.push(`${x},${y}`);
    }
    expect(approach.length).toBeGreaterThan(0);
    for (const prop of ['reception', 'drinks-fridge', 'manga-shelf'] as const) {
      const fixture = room.fixtures.find((candidate) => candidate.prop === prop)!;
      expect(reached.has(`${fixture.x},${fixture.y + fixture.height}`), prop).toBe(true);
    }
    expect(reached.has(`${room.exit.x},${room.exit.y - 1}`)).toBe(true);
  });

  it('is tight in parts, one tile between booths, and opens into one larger booth area', () => {
    const open = (x: number, y: number): boolean => !isFixedRoomSolidAt(room, x, y) && !isFixedRoomExit(room, x, y);
    // The two corridors between the booth rows, and the spine past the lift: one tile wide.
    for (let x = 4; x <= 8; x++) {
      for (const y of [2, 5]) {
        expect(open(x, y), `${x},${y}`).toBe(true);
        expect(open(x, y - 1) || open(x, y + 1), `${x},${y} walls`).toBe(false);
      }
    }
    for (let y = 1; y <= 5; y++) {
      expect(open(3, y)).toBe(true);
      expect(open(2, y)).toBe(false);
      // Booths on its east side, but where the corridors leave it.
      if (y !== 2 && y !== 5) expect(open(4, y)).toBe(false);
    }
    // The booth area: a block of floor at least four tiles wide and five deep.
    let floor = 0;
    for (let y = 2; y <= 6; y++) for (let x = 9; x <= 13; x++) if (open(x, y)) floor += 1;
    expect(floor).toBeGreaterThanOrEqual(22);
  });

  it('keeps the lift locked whatever a snapshot says, so it never opens anything', () => {
    const stations = normalizeFixedRoomStations(room, [
      { station: BUNKER_ELEVATOR_STATION, label: 'GOING DOWN', status: 'available' },
    ]);
    expect(stations).toEqual([{ station: BUNKER_ELEVATOR_STATION, label: room.stations[0]!.label, status: 'locked' }]);
  });

  it('highlights the lift as the player walks up and emits nothing, even after an "available" snapshot', () => {
    const listeners = new Map<string, Set<(payload: never) => void>>();
    const shell = {
      on(event: string, listener: (payload: never) => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return () => set.delete(listener);
      },
    } as unknown as Pick<EventBus<ShellEvents>, 'on'>;
    const shellEmit = <K extends keyof ShellEvents>(event: K, payload: ShellEvents[K]): void => {
      for (const listener of listeners.get(event) ?? []) listener(payload as never);
    };
    const emitted: Array<keyof WorldEvents> = [];
    const states: FixedRoomState[] = [];
    const input: string[] = [];
    const controller = createFixedRoomController({
      definition: BUNKER_ROOM_DEFINITION,
      out: { emit: (event) => void emitted.push(event) },
      in: shell,
      input: { suspend: () => void input.push('suspend'), resume: () => void input.push('resume') },
      onChange: (state) => void states.push(state),
    });
    controller.enter();
    const lift = room.stations[0]!;
    controller.update({ x: lift.x, y: lift.y + 1 });
    expect(controller.state.highlightedStation).toBe(BUNKER_ELEVATOR_STATION);
    expect(controller.state.stations[0]!.status).toBe('locked');
    shellEmit('world:stations', {
      building: 'bunker',
      stations: [{ station: BUNKER_ELEVATOR_STATION, label: 'GOING DOWN', status: 'available' }],
    });
    controller.update({ x: lift.x + 1, y: lift.y + 1 });
    controller.update({ x: room.spawn.x, y: room.spawn.y });
    controller.update({ x: lift.x, y: lift.y + 1 });
    expect(emitted).not.toContain('station:activated');
    expect(input).not.toContain('suspend');
    expect(controller.state.controlOwner).toBe('world');
    expect(states.at(-1)?.stations[0]?.status).toBe('locked');
    controller.destroy();
  });
});
