import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BUILDINGS,
  BUILDINGS,
  PITCH_AREA,
  PITCH_FIELD,
  SANDBOX_AREA,
  SANDBOX_ENTRANCE,
  STREET_ORIGIN_X,
  isPitchFenceTile,
} from '@strkworld/shared';
import {
  createStreetMap,
  doorAt,
  isAvatarStudioEntrance,
  isSolidAt,
  objectLayerToDoors,
  TILES,
  TILE_SIZE,
  tileToWorld,
  westRoadColumn,
  worldToTile,
  type DistrictMap,
  type DoorZone,
} from './street.js';
import { PITCH_GATE } from './pitch.js';
import type { TiledObject } from '../tiled-object-props.js';

const map = createStreetMap();
const DOOR_MAP_BOUNDS = { width: 48, height: 28 } as const;
/** D-078: the street's first column, past the pitch square's fence. */
const X = STREET_ORIGIN_X;

describe('the street is walkable', () => {
  it('keeps the canonical collision vocabulary immutable', () => {
    expect(Object.isFrozen(TILES)).toBe(true);
    expect(Object.isFrozen(TILES.wall)).toBe(true);
    expect(Reflect.set(TILES.wall, 'solid', false)).toBe(false);
    expect(TILES.wall.solid).toBe(true);
  });

  it('rejects geometry supplied only through an object prototype', () => {
    const object = Object.create({
      x: TILE_SIZE,
      y: 2 * TILE_SIZE,
      width: 2 * TILE_SIZE,
      height: TILE_SIZE,
    });
    object.properties = [{ name: 'building', type: 'string', value: 'bank' }];

    expect(objectLayerToDoors([object], DOOR_MAP_BOUNDS)).toEqual([]);
  });

  it('rejects accessor-backed geometry without invoking the accessor', () => {
    const object = tiledDoor();
    let accessed = false;
    Object.defineProperty(object, 'x', {
      get: () => {
        accessed = true;
        return TILE_SIZE;
      },
    });

    expect(objectLayerToDoors([object], DOOR_MAP_BOUNDS)).toEqual([]);
    expect(accessed).toBe(false);
  });

  it('spawns the player on a non-solid tile', () => {
    // A spawn inside a wall is the kind of bug that only shows up when someone
    // opens the game and cannot move.
    expect(isSolidAt(map, map.spawn.x, map.spawn.y)).toBe(false);
  });

  it('runs the road without a break from the pitch gate to the sandbox gate', () => {
    const roadRow = 14;
    // Road all the way, crossed by each door's zebra crossing.
    for (let x = PITCH_GATE.x; x < SANDBOX_AREA.x; x++) {
      expect(['road', 'pavement'], `road ${x}`).toContain(map.tiles[roadRow]![x]);
    }
    expect(map.tiles[roadRow]![PITCH_GATE.x]).toBe('road');
    expect(map.tiles[roadRow]![SANDBOX_AREA.x - 1]).toBe('road');
    // Inside the sandbox square the row stays walkable; at the pitch it is
    // stopped by the fence (D-135) and the goals' nets behind it (D-078).
    for (let x = 0; x < map.width; x++) {
      const inGoal = x === PITCH_FIELD.x - 1 || x === PITCH_FIELD.x + PITCH_FIELD.width;
      const fence = isPitchFenceTile(x, roadRow);
      expect(isSolidAt(map, x, roadRow), `row ${roadRow}, ${x}`).toBe(inGoal || fence);
    }
    expect(westRoadColumn(map)).toBe(PITCH_GATE.x);
  });

  it('widens by the pitch square west of the street, and nothing east of it moves but by the street\'s first column (D-078)', () => {
    expect(X).toBe(PITCH_AREA.x + PITCH_AREA.width + 1);
    expect(map.width).toBe(X + 54 + SANDBOX_AREA.width);
    expect(SANDBOX_AREA.x).toBe(X + 54);
    expect(map.spawn).toEqual({ x: X + 24, y: 15 });
    expect(map.doors.map((door) => [door.building, door.x - X, door.y])).toEqual([
      // West to east: the Bridge on the west lot, the Bank on the fourth (D-110).
      ['bridge', 5, 10],
      ['exchange', 14, 10],
      ['post-office', 23, 10],
      ['bank', 32, 10],
      ['vault', 41, 10],
      // The hidden stair's top step in the alley across from the plaza (D-107).
      ['bunker', 10, 10],
      // The gladiator pit's west arch on the south lawn (D-114).
      ['arena', 28, 22],
    ]);
  });

  it('treats out-of-bounds as solid so the player cannot leave the map', () => {
    expect(isSolidAt(map, -1, 10)).toBe(true);
    expect(isSolidAt(map, map.width, 10)).toBe(true);
    expect(isSolidAt(map, 10, -1)).toBe(true);
    expect(isSolidAt(map, 10, map.height)).toBe(true);
  });

  it('extends a hidden two-tile path from spawn to the south edge', () => {
    expect(map.avatarStudioEntrance).toEqual({ x: X + 23, y: 27, width: 2, height: 1 });
    for (let y = map.spawn.y; y < map.height; y += 1) {
      expect(isSolidAt(map, X + 23, y)).toBe(false);
      expect(isSolidAt(map, X + 24, y)).toBe(false);
    }
    expect(isAvatarStudioEntrance(map, X + 23, 27)).toBe(true);
    expect(isAvatarStudioEntrance(map, X + 24, 27)).toBe(true);
    expect(isAvatarStudioEntrance(map, X + 22, 27)).toBe(false);
  });
});

describe('the sandbox square has one way in (D-060)', () => {
  const wallX = SANDBOX_AREA.x - 1;
  const inGate = (y: number) => y >= SANDBOX_ENTRANCE.y && y < SANDBOX_ENTRANCE.y + SANDBOX_ENTRANCE.height;

  /** Every walkable tile reachable from spawn, optionally with the gate shut. */
  function reachable(gateShut = false): Set<string> {
    const solid = (x: number, y: number) => isSolidAt(map, x, y) || (gateShut && x === wallX && inGate(y));
    const seen = new Set<string>([`${map.spawn.x},${map.spawn.y}`]);
    const queue = [map.spawn];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (solid(nx, ny) || seen.has(`${nx},${ny}`)) continue;
        seen.add(`${nx},${ny}`);
        queue.push({ x: nx, y: ny });
      }
    }
    return seen;
  }

  it('walls its street side except for the gate', () => {
    for (let y = 0; y < map.height; y += 1) {
      expect(isSolidAt(map, wallX, y), `row ${y}`).toBe(!inGate(y));
      if (!inGate(y)) expect(map.tiles[y]![wallX]).toBe('fence');
    }
  });

  it('lines the gate up with the road and both pavements', () => {
    const street: number[] = [];
    for (let y = 0; y < map.height; y += 1) {
      const kind = map.tiles[y]![wallX - 1];
      if (kind === 'road' || kind === 'pavement') street.push(y);
    }
    expect(street[0]).toBe(SANDBOX_ENTRANCE.y);
    expect(street).toHaveLength(SANDBOX_ENTRANCE.height);
    expect(SANDBOX_ENTRANCE.x).toBe(SANDBOX_AREA.x);
    for (let y = SANDBOX_ENTRANCE.y; y < SANDBOX_ENTRANCE.y + SANDBOX_ENTRANCE.height; y += 1) {
      for (let x = SANDBOX_ENTRANCE.x; x < SANDBOX_ENTRANCE.x + SANDBOX_ENTRANCE.width; x += 1) {
        expect(map.tiles[y]![x]).toBe('sandbox');
      }
    }
  });

  it('reaches every sandbox tile from spawn, and only through the gate', () => {
    const open = reachable();
    const shut = reachable(true);
    for (let y = SANDBOX_AREA.y; y < SANDBOX_AREA.y + SANDBOX_AREA.height; y += 1) {
      for (let x = SANDBOX_AREA.x; x < SANDBOX_AREA.x + SANDBOX_AREA.width; x += 1) {
        expect(open.has(`${x},${y}`), `${x},${y}`).toBe(true);
        expect(shut.has(`${x},${y}`), `${x},${y}`).toBe(false);
      }
    }
  });
});

describe('every building is present and reachable', () => {
  it('has a door for all five buildings, the hidden stair\'s (D-107) and the pit\'s arch (D-114)', () => {
    const withDoors = map.doors.map((d) => d.building).sort();
    expect(withDoors).toEqual([...BUILDINGS, 'bunker', 'arena'].sort());
  });

  it('locks the Vault and only the Vault', () => {
    // D-007: the Vault ships as a visible facade so the world reads complete.
    const locked = map.doors.filter((d) => d.locked).map((d) => d.building);
    expect(locked).toEqual(['vault']);

    const unlocked = map.doors.filter((d) => !d.locked).map((d) => d.building).sort();
    // The hidden stair is never locked: it is found, not opened (D-107); nor is the pit (D-114).
    expect(unlocked).toEqual([...ACTIVE_BUILDINGS, 'bunker', 'arena'].sort());
  });

  it('places every door on a tile the player can stand on', () => {
    // A door embedded in a solid facade is unreachable, and it looks fine on
    // screen — which is why this is a test rather than a look.
    for (const door of map.doors) {
      // The pit's west arch is approached from the branch west of it (D-114).
      const approach = door.building === 'arena' ? { x: door.x - 1, y: door.y } : { x: door.x, y: door.y + 1 };
      expect(isSolidAt(map, approach.x, approach.y)).toBe(false);
    }
  });

  it('connects each door to the road by a walkable path', () => {
    // Walk straight down from each door to the road row. Any solid tile in
    // between means the building cannot actually be entered.
    const roadRow = 14;
    for (const door of map.doors) {
      for (let y = door.y + 1; y <= roadRow; y++) {
        expect(isSolidAt(map, door.x, y)).toBe(false);
      }
    }
  });

  it('does not overlap two buildings', () => {
    const seen = new Set<string>();
    for (const door of map.doors) {
      for (let x = door.x; x < door.x + door.width; x++) {
        const key = `${x},${door.y}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('gives every facade a readable placeholder name and function', () => {
    expect(map.exteriorLabels).toEqual([
      { building: 'bridge', text: 'BRIDGE\nDEPOSIT', x: X + 6.5, y: 7 },
      { building: 'exchange', text: 'EXCHANGE\nSWAP', x: X + 15.5, y: 7 },
      { building: 'post-office', text: 'POST OFFICE\nTRANSFER', x: X + 24.5, y: 7 },
      { building: 'bank', text: 'BANK\nSHIELD / UNSHIELD', x: X + 33.5, y: 7 },
      { building: 'vault', text: 'VAULT\nCOMING SOON', x: X + 42.5, y: 7 },
    ]);
  });

  it('anchors each exterior label to the corresponding building door', () => {
    for (const label of map.exteriorLabels) {
      const door = map.doors.find((candidate) => candidate.building === label.building);
      expect(door, label.building).toBeDefined();
      // The sign is centred on the facade (not the narrower door opening).
      expect(label.x).toBeGreaterThan(door!.x);
      expect(label.x).toBeLessThan(door!.x + 5);
      expect(label.y).toBeLessThan(door!.y);
    }
  });
});

describe('the Vault opens on the Shell\'s switch (D-077)', () => {
  const open = createStreetMap({ vaultOpen: true });
  const vaultDoor = (m: DistrictMap): DoorZone => m.doors.find((door) => door.building === 'vault')!;
  const vaultSign = (m: DistrictMap) => m.exteriorLabels.find((label) => label.building === 'vault')!;

  it('keeps D-007\'s locked facade unless the Shell says open, failing closed', () => {
    const locked = [
      createStreetMap(),
      createStreetMap({}),
      createStreetMap({ vaultOpen: false }),
      ...[1, 'true', {}, null].map((value) => createStreetMap({ vaultOpen: value as never })),
    ];
    for (const m of locked) {
      expect(vaultDoor(m).locked).toBe(true);
      expect(vaultSign(m).text).toBe('VAULT\nCOMING SOON');
    }
  });

  it('unlocks the Vault door and names its counter on the sign', () => {
    expect(vaultDoor(open).locked).toBe(false);
    expect(doorAt(open, vaultDoor(open).x, vaultDoor(open).y)).toEqual({ ...vaultDoor(map), locked: false });
    expect(vaultSign(open)).toEqual({ ...vaultSign(map), text: 'VAULT\nSUPPLY / REDEEM' });
    expect(open.doors.filter((door) => door.locked)).toEqual([]);
  });

  it('reaches the open Vault door from spawn', () => {
    const seen = new Set<string>([`${open.spawn.x},${open.spawn.y}`]);
    const queue = [open.spawn];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (isSolidAt(open, nx, ny) || seen.has(`${nx},${ny}`)) continue;
        seen.add(`${nx},${ny}`);
        queue.push({ x: nx, y: ny });
      }
    }
    const door = vaultDoor(open);
    for (let dx = 0; dx < door.width; dx++) expect(seen.has(`${door.x + dx},${door.y}`)).toBe(true);
  });

  it('changes nothing else: tiles, spawn, other doors and signs, plaza and sandbox', () => {
    expect(open.tiles).toEqual(map.tiles);
    for (const key of ['name', 'width', 'height', 'spawn', 'avatarStudioEntrance'] as const) {
      expect(open[key], key).toEqual(map[key]);
    }
    const others = (m: DistrictMap) => ({
      doors: m.doors.filter((door) => door.building !== 'vault'),
      labels: m.exteriorLabels.filter((label) => label.building !== 'vault'),
    });
    expect(others(open)).toEqual(others(map));
    // The Vault's door keeps its place; only its lock changed.
    expect({ ...vaultDoor(open), locked: true }).toEqual(vaultDoor(map));
  });
});

describe('door lookup', () => {
  it('finds the door under a coordinate', () => {
    const bank = map.doors.find((d) => d.building === 'bank')!;
    expect(doorAt(map, bank.x, bank.y)?.building).toBe('bank');
  });

  it('returns null away from any door', () => {
    expect(doorAt(map, map.spawn.x, map.spawn.y)).toBeNull();
  });

  it('returns the zone, not a boolean, so locked is distinguishable', () => {
    // A locked door is a designed state with its own copy, not a failure.
    const vault = map.doors.find((d) => d.building === 'vault')!;
    expect(doorAt(map, vault.x, vault.y)?.locked).toBe(true);
  });
});

describe('doors come from a Tiled object layer, not hardcoded coordinates', () => {
  it('reads the building id from a flattened object property', () => {
    // A Tiled object: pixel rect + raw `[{name,type,value}]` property array.
    const objects: TiledObject[] = [
      {
        name: 'door:bank',
        x: 4 * TILE_SIZE,
        y: 10 * TILE_SIZE,
        width: 2 * TILE_SIZE,
        height: 1 * TILE_SIZE,
        properties: [{ name: 'building', type: 'string', value: 'bank' }],
      },
    ];
    expect(objectLayerToDoors(objects, DOOR_MAP_BOUNDS)).toEqual([
      { building: 'bank', x: 4, y: 10, width: 2, height: 1, locked: false },
    ]);
  });

  it('reads the locked flag from the object property', () => {
    const objects: TiledObject[] = [
      {
        x: 0,
        y: 0,
        width: TILE_SIZE,
        height: TILE_SIZE,
        properties: [
          { name: 'building', type: 'string', value: 'vault' },
          { name: 'locked', type: 'bool', value: true },
        ],
      },
    ];
    expect(objectLayerToDoors(objects, DOOR_MAP_BOUNDS)[0]?.locked).toBe(true);
  });

  it('fails closed: an object naming an unknown building is not a door', () => {
    const objects: TiledObject[] = [
      { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE, properties: [
        { name: 'building', type: 'string', value: 'casino' },
      ] },
      { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE, properties: [] },
    ];
    expect(objectLayerToDoors(objects, DOOR_MAP_BOUNDS)).toEqual([]);
  });

  it('fails closed for null and non-object entries or containers', () => {
    expect(() => objectLayerToDoors([
      null,
      'not-an-object',
      42,
      tiledDoor(),
    ] as never, DOOR_MAP_BOUNDS)).not.toThrow();
    expect(objectLayerToDoors([
      null,
      'not-an-object',
      42,
      tiledDoor(),
    ] as never, DOOR_MAP_BOUNDS)).toEqual([
      { building: 'bank', x: 1, y: 2, width: 2, height: 1, locked: false },
    ]);
    expect(() => objectLayerToDoors(null as never, DOOR_MAP_BOUNDS)).not.toThrow();
    expect(objectLayerToDoors(null as never, DOOR_MAP_BOUNDS)).toEqual([]);
  });

  it('skips malformed or off-grid rectangle geometry instead of rounding it into a door', () => {
    const valid = tiledDoor();
    const malformed = [
      tiledDoor({ x: Number.NaN }),
      tiledDoor({ y: Number.POSITIVE_INFINITY }),
      tiledDoor({ width: Number.NEGATIVE_INFINITY }),
      tiledDoor({ height: Number.NaN }),
      tiledDoor({ x: -TILE_SIZE }),
      tiledDoor({ y: -TILE_SIZE }),
      tiledDoor({ width: 0 }),
      tiledDoor({ height: 0 }),
      tiledDoor({ width: -TILE_SIZE }),
      tiledDoor({ height: -TILE_SIZE }),
      tiledDoor({ x: TILE_SIZE + 1 }),
      tiledDoor({ y: TILE_SIZE + 1 }),
      tiledDoor({ width: TILE_SIZE + 1 }),
      tiledDoor({ height: TILE_SIZE + 1 }),
    ];

    expect(objectLayerToDoors([valid, ...malformed], DOOR_MAP_BOUNDS)).toEqual([
      { building: 'bank', x: 1, y: 2, width: 2, height: 1, locked: false },
    ]);
  });

  it('skips unsafe tile quotients and rectangles outside the explicit map bounds', () => {
    const valid = tiledDoor();
    const invalid = [
      tiledDoor({ x: 2 ** 60 }),
      tiledDoor({ x: DOOR_MAP_BOUNDS.width * TILE_SIZE }),
      tiledDoor({ y: DOOR_MAP_BOUNDS.height * TILE_SIZE }),
      tiledDoor({
        x: (DOOR_MAP_BOUNDS.width - 1) * TILE_SIZE,
        width: 2 * TILE_SIZE,
      }),
      tiledDoor({
        y: (DOOR_MAP_BOUNDS.height - 1) * TILE_SIZE,
        height: 2 * TILE_SIZE,
      }),
    ];

    expect(objectLayerToDoors([valid, ...invalid], DOOR_MAP_BOUNDS)).toEqual([
      { building: 'bank', x: 1, y: 2, width: 2, height: 1, locked: false },
    ]);
  });

  it.each([
    ['zero width', { width: 0, height: DOOR_MAP_BOUNDS.height }],
    ['negative width', { width: -1, height: DOOR_MAP_BOUNDS.height }],
    ['fractional width', { width: 1.5, height: DOOR_MAP_BOUNDS.height }],
    ['non-finite width', { width: Number.POSITIVE_INFINITY, height: DOOR_MAP_BOUNDS.height }],
    ['unsafe width', { width: Number.MAX_SAFE_INTEGER + 1, height: DOOR_MAP_BOUNDS.height }],
    ['zero height', { width: DOOR_MAP_BOUNDS.width, height: 0 }],
    ['negative height', { width: DOOR_MAP_BOUNDS.width, height: -1 }],
    ['fractional height', { width: DOOR_MAP_BOUNDS.width, height: 1.5 }],
    ['non-finite height', { width: DOOR_MAP_BOUNDS.width, height: Number.NaN }],
    ['unsafe height', { width: DOOR_MAP_BOUNDS.width, height: Number.MAX_SAFE_INTEGER + 1 }],
  ])('fails closed for %s map bounds', (_label, bounds) => {
    expect(objectLayerToDoors([tiledDoor()], bounds)).toEqual([]);
  });

  it('produces exactly one door per known building for the procedural map', () => {
    // The real map's doors are the adapter's output — the parsing path a Tiled
    // export will use is already the one under test.
    // The hidden stair's door is added after the layer, which admits only
    // `BUILDINGS` (D-107).
    // So is the gladiator pit's arch (D-114).
    expect(map.doors.filter((d) => d.building !== 'bunker' && d.building !== 'arena').map((d) => d.building).sort()).toEqual([...BUILDINGS].sort());
  });

  // Regression: the facade row was filled solid and the door was only a trigger
  // object on top of it, so the player collided one tile short of the trigger
  // row and no door ever fired. A door the player cannot stand on is not a door.
  it('makes every door tile walkable, so the trigger is reachable', () => {
    for (const door of map.doors) {
      for (let dx = 0; dx < door.width; dx++) {
        for (let dy = 0; dy < door.height; dy++) {
          expect(isSolidAt(map, door.x + dx, door.y + dy)).toBe(false);
        }
      }
    }
  });

  it('connects each door to the road by a walkable column below it', () => {
    for (const door of map.doors) {
      // From the door row down to the road, the approach column must be clear.
      for (let y = door.y; y < 13; y++) {
        expect(isSolidAt(map, door.x, y)).toBe(false);
      }
    }
  });
});

function tiledDoor(overrides: Partial<TiledObject> = {}): TiledObject {
  return {
    x: TILE_SIZE,
    y: 2 * TILE_SIZE,
    width: 2 * TILE_SIZE,
    height: TILE_SIZE,
    properties: [{ name: 'building', type: 'string', value: 'bank' }],
    ...overrides,
  };
}

describe('coordinate conversion', () => {
  it('round-trips a tile through world space', () => {
    const world = tileToWorld(5, 7);
    expect(worldToTile(world.x, world.y)).toEqual({ x: 5, y: 7 });
  });

  it('places the world position at the tile centre', () => {
    expect(tileToWorld(0, 0)).toEqual({ x: TILE_SIZE / 2, y: TILE_SIZE / 2 });
  });

  it('floors rather than rounds, so an edge pixel belongs to one tile', () => {
    expect(worldToTile(TILE_SIZE - 1, TILE_SIZE - 1)).toEqual({ x: 0, y: 0 });
    expect(worldToTile(TILE_SIZE, TILE_SIZE)).toEqual({ x: 1, y: 1 });
  });
});
