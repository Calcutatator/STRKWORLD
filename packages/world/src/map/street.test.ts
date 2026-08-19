import { describe, expect, it } from 'vitest';
import { ACTIVE_BUILDINGS, BUILDINGS } from '@strkworld/shared';
import {
  createStreetMap,
  doorAt,
  isSolidAt,
  objectLayerToDoors,
  TILE_SIZE,
  tileToWorld,
  worldToTile,
} from './street.js';
import type { TiledObject } from '../tiled-object-props.js';

const map = createStreetMap();

describe('the street is walkable', () => {
  it('spawns the player on a non-solid tile', () => {
    // A spawn inside a wall is the kind of bug that only shows up when someone
    // opens the game and cannot move.
    expect(isSolidAt(map, map.spawn.x, map.spawn.y)).toBe(false);
  });

  it('has a continuous road across the full width', () => {
    const roadRow = 14;
    for (let x = 0; x < map.width; x++) {
      expect(isSolidAt(map, x, roadRow)).toBe(false);
    }
  });

  it('treats out-of-bounds as solid so the player cannot leave the map', () => {
    expect(isSolidAt(map, -1, 10)).toBe(true);
    expect(isSolidAt(map, map.width, 10)).toBe(true);
    expect(isSolidAt(map, 10, -1)).toBe(true);
    expect(isSolidAt(map, 10, map.height)).toBe(true);
  });
});

describe('every building is present and reachable', () => {
  it('has a door for all five buildings', () => {
    const withDoors = map.doors.map((d) => d.building).sort();
    expect(withDoors).toEqual([...BUILDINGS].sort());
  });

  it('locks the Vault and only the Vault', () => {
    // D-007: the Vault ships as a visible facade so the world reads complete.
    const locked = map.doors.filter((d) => d.locked).map((d) => d.building);
    expect(locked).toEqual(['vault']);

    const unlocked = map.doors.filter((d) => !d.locked).map((d) => d.building).sort();
    expect(unlocked).toEqual([...ACTIVE_BUILDINGS].sort());
  });

  it('places every door on a tile the player can stand on', () => {
    // A door embedded in a solid facade is unreachable, and it looks fine on
    // screen — which is why this is a test rather than a look.
    for (const door of map.doors) {
      const approach = { x: door.x, y: door.y + 1 };
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
      { building: 'bank', text: 'BANK\nSHIELD / UNSHIELD', x: 6.5, y: 7 },
      { building: 'exchange', text: 'EXCHANGE\nSWAP', x: 15.5, y: 7 },
      { building: 'post-office', text: 'POST OFFICE\nTRANSFER', x: 24.5, y: 7 },
      { building: 'bridge', text: 'BRIDGE\nDEPOSIT', x: 33.5, y: 7 },
      { building: 'vault', text: 'VAULT\nCOMING SOON', x: 42.5, y: 7 },
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
    expect(objectLayerToDoors(objects)).toEqual([
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
    expect(objectLayerToDoors(objects)[0]?.locked).toBe(true);
  });

  it('fails closed: an object naming an unknown building is not a door', () => {
    const objects: TiledObject[] = [
      { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE, properties: [
        { name: 'building', type: 'string', value: 'casino' },
      ] },
      { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE, properties: [] },
    ];
    expect(objectLayerToDoors(objects)).toEqual([]);
  });

  it('produces exactly one door per known building for the procedural map', () => {
    // The real map's doors are the adapter's output — the parsing path a Tiled
    // export will use is already the one under test.
    expect(map.doors.map((d) => d.building).sort()).toEqual([...BUILDINGS].sort());
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
