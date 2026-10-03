import { describe, expect, it } from 'vitest';
import { SANDBOX_AREA, STREET_ORIGIN_X } from '@strkworld/shared';
import {
  COLOSSEUM_AREA,
  COLOSSEUM_DOOR,
  COLOSSEUM_GATEPOSTS,
  COLOSSEUM_PATH,
  COLOSSEUM_RETURN,
  COLOSSEUM_RETURN_FACING,
  COLOSSEUM_TORCHES,
  colosseumTileAt,
} from './colosseum.js';
import { PLACEMENT_PATH, PLACEMENT_STAND, PLAZA_AREA } from './plaza.js';
import { createStreetMap, doorAt, isSolidAt, TILES, type TileKind } from './street.js';

/**
 * The Colosseum on the street (D-114, amended 2026-10-02; D-128 replaced the
 * sunken pit with the building): its exact rows, its west grand arch, the
 * branch off the Studio's path to it, the return tile, and no invisible walls
 * anywhere round it. D-128 changed none of this on purpose, so the rows below
 * are the pit's rows unchanged.
 */

const map = createStreetMap();
const X = STREET_ORIGIN_X;
const kind = (x: number, y: number): TileKind | undefined => map.tiles[y]?.[x];

/** Inclusive x runs of one kind on one row, as the design's table lists them. */
function runs(y: number, of: TileKind): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x <= map.width; x++) {
    const hit = x < map.width && kind(x, y) === of;
    if (hit && start < 0) start = x;
    if (!hit && start >= 0) {
      found.push([start, x - 1]);
      start = -1;
    }
  }
  return found;
}

describe('the Colosseum on the street (D-114, D-128)', () => {
  it('lies on the south lawn just east of the Studio path, street x 57-70, rows 20-26', () => {
    expect(COLOSSEUM_AREA).toEqual({ x: X + 28, y: 20, width: 14, height: 7 });
    expect(X + 28).toBe(57);
    // The arch is on the pit's west front, three tiles tall, and the branch
    // runs east to it from the Studio's path.
    expect(COLOSSEUM_DOOR).toEqual({ x: 57, y: 22, width: 1, height: 3 });
    expect(COLOSSEUM_PATH).toEqual({ x: 54, y: 22, width: 3, height: 3 });
    expect(COLOSSEUM_RETURN).toEqual({ x: 56, y: 23 });
    expect(COLOSSEUM_RETURN_FACING).toBe('left');
    // The return is on the branch, one tile west of the arch: walking east
    // from it goes through the door, walking west goes back to the path.
    expect(COLOSSEUM_RETURN.x).toBe(COLOSSEUM_DOOR.x - 1);
  });

  it('paints exactly the design\'s rows: wall, core and the grand arch\'s threshold', () => {
    const rows: Record<number, { wall: Array<[number, number]>; core: Array<[number, number]>; step: Array<[number, number]> }> = {
      20: { wall: [[57, 68]], core: [], step: [] },
      21: { wall: [[57, 57], [69, 69]], core: [[58, 68]], step: [] },
      22: { wall: [[70, 70]], core: [[58, 69]], step: [[57, 57]] },
      23: { wall: [[70, 70]], core: [[58, 69]], step: [[57, 57]] },
      24: { wall: [[70, 70]], core: [[58, 69]], step: [[57, 57]] },
      25: { wall: [[57, 57], [69, 69]], core: [[58, 68]], step: [] },
      26: { wall: [[57, 68]], core: [], step: [] },
    };
    for (const [row, expected] of Object.entries(rows)) {
      const y = Number(row);
      expect(runs(y, 'colwall'), `wall, row ${y}`).toEqual(expected.wall);
      expect(runs(y, 'colcore'), `core, row ${y}`).toEqual(expected.core);
      expect(runs(y, 'colstep'), `step, row ${y}`).toEqual(expected.step);
    }
    // Nothing of the building outside its rows.
    for (let y = 0; y < map.height; y++) {
      if (y >= 20 && y <= 26) continue;
      for (const part of ['colwall', 'colcore', 'colstep'] as const) expect(runs(y, part), `${part}, row ${y}`).toEqual([]);
    }
    // The pure lookup agrees with the painted grid.
    for (let y = 18; y <= 27; y++) {
      for (let x = 52; x <= 74; x++) {
        const painted = kind(x, y);
        const part = painted === 'colwall' || painted === 'colcore' || painted === 'colstep' ? painted : null;
        expect(colosseumTileAt(x, y), `${x},${y}`).toBe(part);
      }
    }
  });

  it('makes the wall and its core solid and the threshold walkable', () => {
    expect(TILES.colwall.solid).toBe(true);
    expect(TILES.colcore.solid).toBe(true);
    expect(TILES.colstep.solid).toBe(false);
    expect([TILES.colwall.colour, TILES.colcore.colour, TILES.colstep.colour]).toEqual([0x8f8574, 0xcdb38a, 0x9d9384]);
  });

  it('has no invisible wall: every solid tile round it carries the building, every other tile is walkable', () => {
    for (let y = COLOSSEUM_AREA.y - 1; y <= COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
      for (let x = COLOSSEUM_AREA.x - 1; x <= COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
        const k = kind(x, y)!;
        const solid = k === 'colwall' || k === 'colcore';
        expect(isSolidAt(map, x, y), `${x},${y} (${k})`).toBe(solid);
        if (!solid) expect(['grass', 'pavement', 'colstep'], `${x},${y}`).toContain(k);
      }
    }
    // The wall really is a ring: every wall tile touches the core or the
    // threshold, so the corners follow the oval and no lone solid tile stands
    // on the lawn.
    for (let y = 20; y <= 26; y++) {
      for (let x = 56; x <= 71; x++) {
        if (kind(x, y) !== 'colwall') continue;
        let touches = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const n = kind(x + dx, y + dy);
            if (n === 'colcore' || n === 'colstep') touches = true;
          }
        }
        expect(touches, `wall ${x},${y}`).toBe(true);
      }
    }
    // The core never touches the lawn: the wall closes it on every side but the arch.
    for (let y = 20; y <= 26; y++) {
      for (let x = 56; x <= 71; x++) {
        if (kind(x, y) !== 'colcore') continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          expect(['colwall', 'colcore', 'colstep'], `core ${x},${y} side ${dx},${dy}`).toContain(kind(x + dx, y + dy));
        }
      }
    }
  });

  it('puts the door on the west arch\'s threshold, reached by walking east off the branch', () => {
    const doors = map.doors.filter((door) => door.building === 'arena');
    expect(doors).toEqual([{ building: 'arena', x: 57, y: 22, width: 1, height: 3, locked: false }]);
    for (let y = 22; y <= 24; y++) {
      expect(doorAt(map, 57, y)?.building).toBe('arena');
      // The branch lies west of the arch, the whole height of the opening.
      for (let x = 54; x <= 56; x++) expect(kind(x, y), `${x},${y}`).toBe('pavement');
      // Nothing of the door's own column is reached from the east: the building is solid.
      expect(isSolidAt(map, 58, y)).toBe(true);
    }
    // Walk the street's walkable tiles from the spawn: every door tile is reached.
    const seen = new Set<string>([`${map.spawn.x},${map.spawn.y}`]);
    const queue: Array<[number, number]> = [[map.spawn.x, map.spawn.y]];
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        const key = `${nx},${ny}`;
        if (seen.has(key) || isSolidAt(map, nx, ny)) continue;
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
    for (let y = 22; y <= 24; y++) expect(seen.has(`57,${y}`), `57,${y}`).toBe(true);
    // The return tile is walkable, off the door, and leads straight back to the path.
    expect(isSolidAt(map, COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y)).toBe(false);
    expect(doorAt(map, COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y)).toBeNull();
    expect(seen.has(`${COLOSSEUM_RETURN.x},${COLOSSEUM_RETURN.y}`)).toBe(true);
  });

  it('stands its piers and cressets on the wall', () => {
    for (const tile of [...COLOSSEUM_GATEPOSTS, ...COLOSSEUM_TORCHES]) expect(kind(tile.x, tile.y), `${tile.x},${tile.y}`).toBe('colwall');
    // Both piers are on the west front, north and south of the opening.
    expect(COLOSSEUM_GATEPOSTS.map((post) => post.x)).toEqual([57, 57]);
    expect(COLOSSEUM_GATEPOSTS.map((post) => post.y)).toEqual([21, 25]);
  });

  it('branches off the Studio path and overlaps nothing else on the lawn', () => {
    // The branch starts where the Studio's path (x 52-53) ends, so a step west
    // off it is the path to the changing room.
    expect(COLOSSEUM_PATH.x).toBe(X + 25);
    for (let y = COLOSSEUM_PATH.y; y < COLOSSEUM_PATH.y + COLOSSEUM_PATH.height; y++) {
      expect(kind(COLOSSEUM_PATH.x - 1, y), `studio path ${y}`).toBe('pavement');
    }
    // The Studio's path and the sandbox fence stay as they were.
    for (let y = 17; y < map.height; y++) {
      expect(kind(X + 23, y)).toBe('pavement');
      expect(kind(X + 24, y)).toBe('pavement');
    }
    // Clear of the plaza, the placement stand's apron (off by default, but it
    // must still fit), the sandbox and the spawn.
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const mine of [COLOSSEUM_AREA, COLOSSEUM_PATH]) {
      expect(overlaps(mine, PLAZA_AREA), 'plaza').toBe(false);
      expect(overlaps(mine, PLACEMENT_PATH), 'placement path').toBe(false);
      expect(overlaps(mine, PLACEMENT_STAND), 'placement stand').toBe(false);
      expect(overlaps(mine, { x: X + 23, y: 17, width: 2, height: map.height - 17 }), 'studio path').toBe(false);
      expect(overlaps(mine, SANDBOX_AREA), 'sandbox').toBe(false);
    }
    expect(COLOSSEUM_AREA.x).toBeGreaterThan(PLACEMENT_STAND.x + PLACEMENT_STAND.width);
    expect(COLOSSEUM_AREA.x + COLOSSEUM_AREA.width).toBeLessThan(SANDBOX_AREA.x - 1);
    expect(map.spawn.y).toBeLessThan(COLOSSEUM_PATH.y);
  });
});
