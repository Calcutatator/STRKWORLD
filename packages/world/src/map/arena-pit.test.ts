import { describe, expect, it } from 'vitest';
import { SANDBOX_AREA, STREET_ORIGIN_X } from '@strkworld/shared';
import {
  ARENA_PIT_AREA,
  ARENA_PIT_DOOR,
  ARENA_PIT_GATEPOSTS,
  ARENA_PIT_PATH,
  ARENA_PIT_RETURN,
  ARENA_PIT_TORCHES,
  arenaPitTileAt,
} from './arena-pit.js';
import { PLAZA_AREA } from './plaza.js';
import { createStreetMap, doorAt, isSolidAt, TILES, type TileKind } from './street.js';

/**
 * The gladiator pit on the street (D-114): its exact rows, its door and the
 * path to it, the return tile, and no invisible walls anywhere round it.
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
  it('lies on the east half of the south lawn, street x 61-75, rows 20-26', () => {
    expect(ARENA_PIT_AREA).toEqual({ x: X + 32, y: 20, width: 15, height: 7 });
    expect(X + 32).toBe(61);
    expect(ARENA_PIT_DOOR).toEqual({ x: 67, y: 20, width: 2, height: 1 });
    expect(ARENA_PIT_PATH).toEqual({ x: 67, y: 19, width: 2, height: 1 });
    expect(ARENA_PIT_RETURN).toEqual({ x: 67, y: 19 });
  });

  it('paints exactly the design\'s rows: rim, bowl and the arch\'s threshold', () => {
    const rows: Record<number, { rim: Array<[number, number]>; bowl: Array<[number, number]>; step: Array<[number, number]> }> = {
      20: { rim: [[63, 66], [69, 73]], bowl: [], step: [[67, 68]] },
      21: { rim: [[62, 62], [74, 74]], bowl: [[63, 73]], step: [] },
      22: { rim: [[61, 61], [75, 75]], bowl: [[62, 74]], step: [] },
      23: { rim: [[61, 61], [75, 75]], bowl: [[62, 74]], step: [] },
      24: { rim: [[61, 61], [75, 75]], bowl: [[62, 74]], step: [] },
      25: { rim: [[62, 62], [74, 74]], bowl: [[63, 73]], step: [] },
      26: { rim: [[63, 73]], bowl: [], step: [] },
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
      for (let x = 58; x <= 78; x++) {
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
      for (let x = 61; x <= 75; x++) {
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
      for (let x = 61; x <= 75; x++) {
        if (kind(x, y) !== 'pitbowl') continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          expect(['pitrim', 'pitbowl', 'pitstep'], `bowl ${x},${y} side ${dx},${dy}`).toContain(kind(x + dx, y + dy));
        }
      }
    }
  });

  it('puts the door on the arch\'s threshold, reachable from the pavement by the stone path', () => {
    const doors = map.doors.filter((door) => door.building === 'arena');
    expect(doors).toEqual([{ building: 'arena', x: 67, y: 20, width: 2, height: 1, locked: false }]);
    for (let x = 67; x <= 68; x++) {
      expect(doorAt(map, x, 20)?.building).toBe('arena');
      expect(kind(x, 19)).toBe('pavement');
      expect(kind(x, 18)).toBe('pavement');
    }
    // Walk the street's walkable tiles from the spawn: the door is reached.
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
    expect(seen.has('67,20') && seen.has('68,20')).toBe(true);
    // The return tile is walkable, off the door, and leads straight back to the pavement.
    expect(isSolidAt(map, ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y)).toBe(false);
    expect(doorAt(map, ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y)).toBeNull();
    expect(seen.has(`${ARENA_PIT_RETURN.x},${ARENA_PIT_RETURN.y}`)).toBe(true);
  });

  it('stands its gateposts and braziers on the rim', () => {
    for (const tile of [...ARENA_PIT_GATEPOSTS, ...ARENA_PIT_TORCHES]) expect(kind(tile.x, tile.y), `${tile.x},${tile.y}`).toBe('pitrim');
    expect(ARENA_PIT_GATEPOSTS.map((post) => post.x)).toEqual([66, 69]);
  });

  it('keeps clear of the plaza, the Studio path, the sandbox fence and the spawn', () => {
    const plazaEast = PLAZA_AREA.x + PLAZA_AREA.width;
    expect(ARENA_PIT_AREA.x).toBeGreaterThan(plazaEast + 10);
    // The Studio's path (x 52-53) and the sandbox fence stay as they were.
    for (let y = 17; y < map.height; y++) {
      expect(kind(X + 23, y)).toBe('pavement');
      expect(kind(X + 24, y)).toBe('pavement');
    }
    expect(ARENA_PIT_AREA.x + ARENA_PIT_AREA.width).toBeLessThan(SANDBOX_AREA.x - 1);
    expect(map.spawn.y).toBeLessThan(ARENA_PIT_PATH.y);
  });
});
