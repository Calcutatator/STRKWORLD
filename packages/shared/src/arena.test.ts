import { describe, expect, it, vi } from 'vitest';
import {
  ARENA_BOX,
  ARENA_DUMMY_TILE,
  ARENA_EXIT,
  ARENA_GATE_APPROACH,
  ARENA_HEIGHT,
  ARENA_ORIGIN_PX,
  ARENA_PRESENCE_GRID,
  ARENA_RING_FENCE,
  ARENA_RING_GATE,
  ARENA_RING_INTERIOR,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  ARENA_RING_WALKABLE,
  ARENA_SPAWN,
  ARENA_SPAWN_FACING,
  ARENA_STAIRS,
  ARENA_TILE_SIZE,
  ARENA_TUNNEL,
  ARENA_WIDTH,
  arenaTierAt,
  arenaTileAt,
  arenaTileCentre,
  isArenaFloorKind,
  normalizeArenaRing,
  type ArenaRingSnapshot,
} from './arena.js';
import { BUILDINGS, PRESENCE_AREAS, presenceAreaOfBuilding, type TileRect } from './index.js';

/** D-114: the arena's shared geometry, and the ring snapshot's validator. */

function inRect(r: TileRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}

function tilesOf(r: TileRect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = r.y; y < r.y + r.height; y += 1) for (let x = r.x; x < r.x + r.width; x += 1) out.push([x, y]);
  return out;
}

/** The static grid's walkability, read back from its row runs. */
function gridWalkable(x: number, y: number): boolean {
  return ARENA_PRESENCE_GRID.walkable.some((r) => inRect(r, x, y));
}

describe('the arena grid (D-114)', () => {
  it('is 41 by 33 tiles of 32 px, drawn at the interiors’ origin', () => {
    expect(ARENA_WIDTH).toBe(41);
    expect(ARENA_HEIGHT).toBe(33);
    expect(ARENA_TILE_SIZE).toBe(32);
    expect(ARENA_ORIGIN_PX).toBe(64);
    expect(ARENA_PRESENCE_GRID).toMatchObject({ originX: 64, originY: 64, tileSize: 32, width: 41, height: 33 });
    for (const r of ARENA_PRESENCE_GRID.walkable) {
      expect(r.height).toBe(1);
      expect(r.width).toBeGreaterThan(0);
      expect(r.x >= 0 && r.y >= 0 && r.x + r.width <= ARENA_WIDTH && r.y < ARENA_HEIGHT).toBe(true);
    }
  });

  it('classifies out of bounds and non-integers as void', () => {
    for (const [x, y] of [[-1, 0], [0, -1], [ARENA_WIDTH, 0], [0, ARENA_HEIGHT], [0.5, 3], [Number.NaN, 1]]) {
      expect(arenaTileAt(x as number, y as number)).toBe('void');
    }
  });

  it('marks exactly the floor kinds walkable in the presence grid, tile for tile', () => {
    for (let y = 0; y < ARENA_HEIGHT; y += 1) {
      for (let x = 0; x < ARENA_WIDTH; x += 1) {
        expect(gridWalkable(x, y), `${x},${y}`).toBe(isArenaFloorKind(arenaTileAt(x, y)));
      }
    }
  });

  it('connects every walkable tile to the spawn, four-way, without the ring', () => {
    expect(gridWalkable(ARENA_SPAWN.x, ARENA_SPAWN.y)).toBe(true);
    const seen = new Set<string>([`${ARENA_SPAWN.x},${ARENA_SPAWN.y}`]);
    const queue: Array<[number, number]> = [[ARENA_SPAWN.x, ARENA_SPAWN.y]];
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        const key = `${nx},${ny}`;
        if (seen.has(key) || !gridWalkable(nx, ny)) continue;
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
    let walkable = 0;
    for (let y = 0; y < ARENA_HEIGHT; y += 1) {
      for (let x = 0; x < ARENA_WIDTH; x += 1) {
        if (!gridWalkable(x, y)) continue;
        walkable += 1;
        expect(seen.has(`${x},${y}`), `${x},${y} is cut off from the spawn`).toBe(true);
      }
    }
    expect(seen.size).toBe(walkable);
  });

  it('puts the exit, approach, return tile and both stairs on the floor', () => {
    for (const [x, y] of tilesOf(ARENA_EXIT)) expect(gridWalkable(x, y), `exit ${x},${y}`).toBe(true);
    for (const [x, y] of tilesOf(ARENA_GATE_APPROACH)) expect(gridWalkable(x, y), `approach ${x},${y}`).toBe(true);
    expect(gridWalkable(ARENA_RING_RETURN.x, ARENA_RING_RETURN.y)).toBe(true);
    for (const stair of ARENA_STAIRS) {
      for (const [x, y] of tilesOf(stair)) expect(arenaTileAt(x, y), `stair ${x},${y}`).toBe('stair');
    }
    for (const [x, y] of tilesOf(ARENA_TUNNEL)) expect(arenaTileAt(x, y)).toBe('tunnel');
  });

  it('keeps the ring interior strictly inside its fence, which is walled except at the gate', () => {
    const f = ARENA_RING_FENCE;
    const i = ARENA_RING_INTERIOR;
    expect(i.x).toBe(f.x + 1);
    expect(i.y).toBe(f.y + 1);
    expect(i.x + i.width).toBe(f.x + f.width - 1);
    expect(i.y + i.height).toBe(f.y + f.height - 1);
    for (const [x, y] of tilesOf(f)) {
      const kind = arenaTileAt(x, y);
      if (inRect(i, x, y)) {
        expect(['ring', 'dummy'], `${x},${y}`).toContain(kind);
      } else if (inRect(ARENA_RING_GATE, x, y)) {
        expect(kind).toBe('gate');
      } else {
        expect(kind, `${x},${y}`).toBe('fence');
      }
      // Nobody but the challenger stands anywhere inside the fence.
      expect(gridWalkable(x, y), `${x},${y}`).toBe(false);
    }
    // The gate is in the fence's north side, facing the tunnel, and the
    // approach is the two rows just outside it.
    expect(ARENA_RING_GATE.y).toBe(f.y);
    expect(ARENA_GATE_APPROACH.y + ARENA_GATE_APPROACH.height).toBe(ARENA_RING_GATE.y);
  });

  it('runs north to south: in through the north tunnel facing south, out walking north, the box facing it', () => {
    // The tunnel's far end is the arena's north edge, and the exit is its row there.
    expect(ARENA_TUNNEL.y).toBe(0);
    expect(ARENA_EXIT).toEqual({ x: ARENA_TUNNEL.x, y: 0, width: ARENA_TUNNEL.width, height: 1 });
    // The spawn is in the tunnel, facing south, into the arena; nothing south
    // of it is an exit, so walking on never leaves.
    expect(arenaTileAt(ARENA_SPAWN.x, ARENA_SPAWN.y)).toBe('tunnel');
    expect(ARENA_SPAWN_FACING).toBe('down');
    expect(ARENA_SPAWN.y).toBeGreaterThan(ARENA_EXIT.y);
    // The mouth (the tunnel's sand end) has no walls; every row behind it does.
    const mouth = ARENA_TUNNEL.y + ARENA_TUNNEL.height - 1;
    expect(arenaTileAt(ARENA_TUNNEL.x - 1, mouth)).not.toBe('tunnel-wall');
    for (let y = ARENA_TUNNEL.y; y < mouth; y += 1) {
      expect(arenaTileAt(ARENA_TUNNEL.x - 1, y)).toBe('tunnel-wall');
      expect(arenaTileAt(ARENA_TUNNEL.x + ARENA_TUNNEL.width, y)).toBe('tunnel-wall');
    }
    // Straight down the tunnel to the gate approach, all floor.
    for (let y = ARENA_SPAWN.y; y < ARENA_GATE_APPROACH.y + ARENA_GATE_APPROACH.height; y += 1) {
      expect(gridWalkable(ARENA_SPAWN.x, y), `${ARENA_SPAWN.x},${y}`).toBe(true);
    }
    // The box is on the south podium, across the ring from the tunnel.
    expect(ARENA_BOX.y).toBeGreaterThan(ARENA_RING_FENCE.y + ARENA_RING_FENCE.height);
    expect(arenaTileAt(ARENA_BOX.x, ARENA_BOX.y - 1)).toBe('sand');
    // In the ring: the fighter lands inside the gate facing the dummy, and
    // comes back out onto the approach facing the tunnel.
    expect(ARENA_RING_SPAWN.y).toBe(ARENA_RING_GATE.y + 2);
    expect(ARENA_RING_SPAWN_FACING).toBe('down');
    expect(ARENA_DUMMY_TILE.y).toBeGreaterThan(ARENA_RING_SPAWN.y);
    expect(ARENA_RING_RETURN.y).toBe(ARENA_GATE_APPROACH.y);
    expect(ARENA_RING_RETURN_FACING).toBe('up');
  });

  it('makes the dummy tile solid for everyone and the rest of the interior the challenger’s', () => {
    expect(arenaTileAt(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y)).toBe('dummy');
    expect(isArenaFloorKind('dummy')).toBe(false);
    expect(gridWalkable(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y)).toBe(false);
    const challenger = (x: number, y: number) => ARENA_RING_WALKABLE.some((r) => inRect(r, x, y));
    expect(challenger(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y)).toBe(false);
    for (const [x, y] of tilesOf(ARENA_RING_INTERIOR)) {
      const dummy = x === ARENA_DUMMY_TILE.x && y === ARENA_DUMMY_TILE.y;
      expect(challenger(x, y), `${x},${y}`).toBe(!dummy);
    }
    // The ring rects do not overlap, so they cover the interior minus the dummy exactly once.
    const area = ARENA_RING_WALKABLE.reduce((sum, r) => sum + r.width * r.height, 0);
    expect(area).toBe(ARENA_RING_INTERIOR.width * ARENA_RING_INTERIOR.height - 1);
    expect(challenger(ARENA_RING_SPAWN.x, ARENA_RING_SPAWN.y)).toBe(true);
    expect(arenaTileAt(ARENA_BOX.x, ARENA_BOX.y)).toBe('box');
  });

  it('numbers the tiers 1 to 5 and nothing else', () => {
    const tiers = new Set<number>();
    for (let y = 0; y < ARENA_HEIGHT; y += 1) {
      for (let x = 0; x < ARENA_WIDTH; x += 1) {
        const tier = arenaTierAt(x, y);
        if (arenaTileAt(x, y) === 'tier') {
          expect(tier >= 1 && tier <= 5, `${x},${y}`).toBe(true);
          tiers.add(tier);
        } else {
          expect(tier).toBe(0);
        }
      }
    }
    expect([...tiers].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('builds the presence grid deterministically from the one classifier', async () => {
    const rebuilt: TileRect[] = [];
    for (let y = 0; y < ARENA_HEIGHT; y += 1) {
      let start = -1;
      for (let x = 0; x <= ARENA_WIDTH; x += 1) {
        const floor = x < ARENA_WIDTH && isArenaFloorKind(arenaTileAt(x, y));
        if (floor && start < 0) start = x;
        if (!floor && start >= 0) {
          rebuilt.push({ x: start, y, width: x - start, height: 1 });
          start = -1;
        }
      }
    }
    expect(ARENA_PRESENCE_GRID.walkable).toEqual(rebuilt);
    expect(Object.isFrozen(ARENA_PRESENCE_GRID)).toBe(true);
    expect(Object.isFrozen(ARENA_PRESENCE_GRID.walkable)).toBe(true);
    expect(ARENA_PRESENCE_GRID.walkable.every((r) => Object.isFrozen(r))).toBe(true);
    // A fresh evaluation of the module gives the same grid.
    vi.resetModules();
    const fresh = await import('./arena.js');
    expect(fresh.ARENA_PRESENCE_GRID).not.toBe(ARENA_PRESENCE_GRID);
    expect(fresh.ARENA_PRESENCE_GRID).toEqual(ARENA_PRESENCE_GRID);
  });

  it('centres a tile in World pixels, room origin included', () => {
    expect(arenaTileCentre(ARENA_DUMMY_TILE)).toEqual({ x: 64 + 20.5 * 32, y: 64 + 18.5 * 32 });
    expect(Object.isFrozen(arenaTileCentre(ARENA_SPAWN))).toBe(true);
  });
});

describe('the arena presence area (D-114)', () => {
  it('names the arena building as its presence area, and no public building', () => {
    expect(PRESENCE_AREAS).toContain('arena');
    expect(presenceAreaOfBuilding('arena')).toBe('arena');
    expect(presenceAreaOfBuilding('bunker')).toBe('bunker');
    expect(BUILDINGS as readonly string[]).not.toContain('arena');
    for (const building of BUILDINGS) expect(presenceAreaOfBuilding(building)).toBeNull();
  });
});

describe('normalizeArenaRing (D-114)', () => {
  const dummy = { kind: 'dummy', gameId: null, hp: 70, swings: 0, hits: 3 };
  const player = { kind: 'player', gameId: '0123456789abcdef', hp: 100, swings: 5, hits: 0 };
  const fighting = { phase: 'fighting', round: 7, challenger: player, opponent: dummy, secondsLeft: 42, outcome: null };

  it('accepts a valid snapshot and freezes it, slots and outcome included', () => {
    const ring = normalizeArenaRing(fighting) as ArenaRingSnapshot;
    expect(ring).toEqual(fighting);
    expect(Object.isFrozen(ring) && Object.isFrozen(ring.challenger) && Object.isFrozen(ring.opponent)).toBe(true);
    const ended = normalizeArenaRing({ ...fighting, phase: 'ended', secondsLeft: 0, outcome: { reason: 'knockout', winner: 'challenger' } });
    expect(ended?.outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    expect(Object.isFrozen(ended?.outcome)).toBe(true);
    const empty = { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 };
    expect(normalizeArenaRing({ phase: 'idle', round: 0, challenger: empty, opponent: empty, secondsLeft: 0, outcome: null })).not.toBeNull();
    expect(normalizeArenaRing({ ...fighting, phase: 'ended', secondsLeft: 0, outcome: { reason: 'timeout', winner: null } })).not.toBeNull();
  });

  it('rejects anything not exactly a snapshot', () => {
    const bad: unknown[] = [
      null, undefined, 1, 'ring', [],
      { ...fighting, phase: 'waiting' },
      { ...fighting, round: 65536 },
      { ...fighting, round: -1 },
      { ...fighting, round: 1.5 },
      { ...fighting, secondsLeft: 91 },
      { ...fighting, phase: 'countdown', secondsLeft: 4 },
      { ...fighting, phase: 'idle', secondsLeft: 1 },
      { ...fighting, outcome: { reason: 'knockout', winner: 'challenger' } },
      { ...fighting, phase: 'ended', secondsLeft: 0, outcome: null },
      { ...fighting, phase: 'ended', secondsLeft: 0, outcome: { reason: 'draw', winner: null } },
      { ...fighting, phase: 'ended', secondsLeft: 0, outcome: { reason: 'knockout', winner: 'west' } },
      { ...fighting, challenger: { ...player, gameId: '' } },
      { ...fighting, challenger: { ...player, gameId: null } },
      { ...fighting, challenger: { ...player, gameId: 'x'.repeat(65) } },
      { ...fighting, opponent: { ...dummy, gameId: 'abc' } },
      { ...fighting, opponent: { ...dummy, hp: 101 } },
      { ...fighting, opponent: { ...dummy, hits: 256 } },
      { ...fighting, opponent: { ...dummy, swings: -1 } },
      { ...fighting, opponent: { ...dummy, kind: 'boss' } },
      { ...fighting, opponent: undefined },
    ];
    for (const value of bad) expect(normalizeArenaRing(value), JSON.stringify(value)).toBeNull();
  });

  it('reads own data fields only: never a getter or an inherited field', () => {
    let read = false;
    const withGetter = { ...fighting };
    Object.defineProperty(withGetter, 'phase', { get: () => { read = true; return 'fighting'; }, enumerable: true });
    expect(normalizeArenaRing(withGetter)).toBeNull();
    expect(read).toBe(false);
    expect(normalizeArenaRing(Object.create(fighting))).toBeNull();
    const slotGetter = { ...player };
    Object.defineProperty(slotGetter, 'hp', { get: () => { read = true; return 100; } });
    expect(normalizeArenaRing({ ...fighting, challenger: slotGetter })).toBeNull();
    expect(read).toBe(false);
    expect(normalizeArenaRing(new Proxy(fighting, { getOwnPropertyDescriptor: () => { throw new Error('hostile'); } }))).toBeNull();
  });
});
