import { describe, expect, it } from 'vitest';
import { SANDBOX_AREA, STREET_ORIGIN_X } from '@strkworld/shared';
import {
  ARENA_PIT_AREA,
  ARENA_PIT_DOOR,
  ARENA_PIT_GATEPOSTS,
  ARENA_PIT_PATH,
  ARENA_PIT_RETURN,
  ARENA_PIT_RETURN_FACING,
  ARENA_PIT_TORCHES,
  arenaPitTileAt,
} from './arena-pit.js';
import { PLACEMENT_PATH, PLACEMENT_STAND, PLAZA_AREA } from './plaza.js';
import { createStreetMap, doorAt, isSolidAt, TILES, type TileKind } from './street.js';

/**
 * The gladiator pit on the street (D-114, amended 2026-10-02): its exact
 * rows, its west arch, the branch off the Studio's path to it, the return
 * tile, and no invisible walls anywhere round it.
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

describe('the gladiator pit on the street (D-114)', () => {
  it('lies on the south lawn just east of the Studio path, street x 57-70, rows 20-26', () => {
    expect(ARENA_PIT_AREA).toEqual({ x: X + 28, y: 20, width: 14, height: 7 });
    expect(X + 28).toBe(57);
    // The arch is on the pit's west front, three tiles tall, and the branch
    // runs east to it from the Studio's path.
    expect(ARENA_PIT_DOOR).toEqual({ x: 57, y: 22, width: 1, height: 3 });
    expect(ARENA_PIT_PATH).toEqual({ x: 54, y: 22, width: 3, height: 3 });
    expect(ARENA_PIT_RETURN).toEqual({ x: 56, y: 23 });
    expect(ARENA_PIT_RETURN_FACING).toBe('left');
    // The return is on the branch, one tile west of the arch: walking east
    // from it goes through the door, walking west goes back to the path.
    expect(ARENA_PIT_RETURN.x).toBe(ARENA_PIT_DOOR.x - 1);
  });

  it('paints exactly the design\'s rows: rim, bowl and the arch\'s threshold', () => {
    const rows: Record<number, { rim: Array<[number, number]>; bowl: Array<[number, number]>; step: Array<[number, number]> }> = {
      20: { rim: [[57, 68]], bowl: [], step: [] },
      21: { rim: [[57, 57], [69, 69]], bowl: [[58, 68]], step: [] },
      22: { rim: [[70, 70]], bowl: [[58, 69]], step: [[57, 57]] },
      23: { rim: [[70, 70]], bowl: [[58, 69]], step: [[57, 57]] },
      24: { rim: [[70, 70]], bowl: [[58, 69]], step: [[57, 57]] },
      25: { rim: [[57, 57], [69, 69]], bowl: [[58, 68]], step: [] },
      26: { rim: [[57, 68]], bowl: [], step: [] },
    };
    for (const [row, expected] of Object.entries(rows)) {
      const y = Number(row);
      expect(runs(y, 'pitrim'), `rim, row ${y}`).toEqual(expected.rim);
      expect(runs(y, 'pitbowl'), `bowl, row ${y}`).toEqual(expected.bowl);
      expect(runs(y, 'pitstep'), `step, row ${y}`).toEqual(expected.step);
    }
    // Nothing of the pit outside its rows.
    for (let y = 0; y < map.height; y++) {
      if (y >= 20 && y <= 26) continue;
      for (const pit of ['pitrim', 'pitbowl', 'pitstep'] as const) expect(runs(y, pit), `${pit}, row ${y}`).toEqual([]);
    }
    // The pure lookup agrees with the painted grid.
    for (let y = 18; y <= 27; y++) {
      for (let x = 52; x <= 74; x++) {
        const painted = kind(x, y);
        const pit = painted === 'pitrim' || painted === 'pitbowl' || painted === 'pitstep' ? painted : null;
        expect(arenaPitTileAt(x, y), `${x},${y}`).toBe(pit);
      }
    }
  });

  it('makes the rim and bowl solid and the threshold walkable', () => {
    expect(TILES.pitrim.solid).toBe(true);
    expect(TILES.pitbowl.solid).toBe(true);
    expect(TILES.pitstep.solid).toBe(false);
    expect([TILES.pitrim.colour, TILES.pitbowl.colour, TILES.pitstep.colour]).toEqual([0x8f8574, 0xcdb38a, 0x9d9384]);
  });

  it('has no invisible wall: every solid tile round it is drawn rim or bowl, every other tile is walkable', () => {
    for (let y = ARENA_PIT_AREA.y - 1; y <= ARENA_PIT_AREA.y + ARENA_PIT_AREA.height; y++) {
      for (let x = ARENA_PIT_AREA.x - 1; x <= ARENA_PIT_AREA.x + ARENA_PIT_AREA.width; x++) {
        const k = kind(x, y)!;
        const pit = k === 'pitrim' || k === 'pitbowl';
        expect(isSolidAt(map, x, y), `${x},${y} (${k})`).toBe(pit);
        if (!pit) expect(['grass', 'pavement', 'pitstep'], `${x},${y}`).toContain(k);
      }
    }
    // The rim really is a rim: every rim tile touches the bowl or the threshold,
    // so the corners follow the bowl and no lone solid tile stands on the lawn.
    for (let y = 20; y <= 26; y++) {
      for (let x = 56; x <= 71; x++) {
        if (kind(x, y) !== 'pitrim') continue;
        let touches = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const n = kind(x + dx, y + dy);
            if (n === 'pitbowl' || n === 'pitstep') touches = true;
          }
        }
        expect(touches, `rim ${x},${y}`).toBe(true);
      }
    }
    // The bowl never touches the lawn: the rim closes it on every side but the arch.
    for (let y = 20; y <= 26; y++) {
      for (let x = 56; x <= 71; x++) {
        if (kind(x, y) !== 'pitbowl') continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          expect(['pitrim', 'pitbowl', 'pitstep'], `bowl ${x},${y} side ${dx},${dy}`).toContain(kind(x + dx, y + dy));
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
      // Nothing of the door's own column is reached from the east: the bowl is solid.
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
    expect(isSolidAt(map, ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y)).toBe(false);
    expect(doorAt(map, ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y)).toBeNull();
    expect(seen.has(`${ARENA_PIT_RETURN.x},${ARENA_PIT_RETURN.y}`)).toBe(true);
  });

  it('stands its gateposts and braziers on the rim', () => {
    for (const tile of [...ARENA_PIT_GATEPOSTS, ...ARENA_PIT_TORCHES]) expect(kind(tile.x, tile.y), `${tile.x},${tile.y}`).toBe('pitrim');
    // Both posts are on the west front, north and south of the opening.
    expect(ARENA_PIT_GATEPOSTS.map((post) => post.x)).toEqual([57, 57]);
    expect(ARENA_PIT_GATEPOSTS.map((post) => post.y)).toEqual([21, 25]);
  });

  it('branches off the Studio path and overlaps nothing else on the lawn', () => {
    // The branch starts where the Studio's path (x 52-53) ends, so a step west
    // off it is the path to the changing room.
    expect(ARENA_PIT_PATH.x).toBe(X + 25);
    for (let y = ARENA_PIT_PATH.y; y < ARENA_PIT_PATH.y + ARENA_PIT_PATH.height; y++) {
      expect(kind(ARENA_PIT_PATH.x - 1, y), `studio path ${y}`).toBe('pavement');
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
    for (const mine of [ARENA_PIT_AREA, ARENA_PIT_PATH]) {
      expect(overlaps(mine, PLAZA_AREA), 'plaza').toBe(false);
      expect(overlaps(mine, PLACEMENT_PATH), 'placement path').toBe(false);
      expect(overlaps(mine, PLACEMENT_STAND), 'placement stand').toBe(false);
      expect(overlaps(mine, { x: X + 23, y: 17, width: 2, height: map.height - 17 }), 'studio path').toBe(false);
      expect(overlaps(mine, SANDBOX_AREA), 'sandbox').toBe(false);
    }
    expect(ARENA_PIT_AREA.x).toBeGreaterThan(PLACEMENT_STAND.x + PLACEMENT_STAND.width);
    expect(ARENA_PIT_AREA.x + ARENA_PIT_AREA.width).toBeLessThan(SANDBOX_AREA.x - 1);
    expect(map.spawn.y).toBeLessThan(ARENA_PIT_PATH.y);
  });
});
