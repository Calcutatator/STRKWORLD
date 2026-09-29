import { describe, expect, it } from 'vitest';
import {
  SANDBOX_AREA,
  SANDBOX_BURST_HEIGHT,
  SANDBOX_COLOURS,
  SANDBOX_ENTRANCE,
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  type SandboxTile,
} from '@strkworld/shared';
import {
  SANDBOX_ACTION_RANGE,
  SANDBOX_FAST_SPAWN_LIMIT,
  SANDBOX_SLOW_SPAWN_INTERVAL_MS,
  SANDBOX_SPAWN_INTERVAL_MS,
  SANDBOX_TILE_SIZE,
  createSandboxAuthority,
  isEntranceTile,
  isSandboxBurst,
  isSandboxTile,
  sandboxLevelAt,
  sandboxSpawnDelay,
  sandboxTileAt,
  sandboxTileKey,
  type SandboxAuthority,
  type SandboxBurst,
  type SandboxPlayer,
} from './sandbox-rules';

const T = SANDBOX_TILE_SIZE;
const LEFT = SANDBOX_AREA.x;
const TOP = SANDBOX_AREA.y;
const RIGHT = SANDBOX_AREA.x + SANDBOX_AREA.width - 1;
const BOTTOM = SANDBOX_AREA.y + SANDBOX_AREA.height - 1;

/** A player standing at a tile's centre, optionally offset in pixels. */
function at(tileX: number, tileY: number, key = 'me', dx = 0, dy = 0): SandboxPlayer {
  return { key, x: tileX * T + T / 2 + dx, y: tileY * T + T / 2 + dy };
}

/** Deterministic PRNG, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rig {
  readonly sandbox: SandboxAuthority;
  /** Scripted draws, consumed before the fallback. */
  readonly draws: number[];
  /** How many times `random` was called. */
  calls(): number;
  /** Spawn one block of `colour` on `tile`, with `players` present. */
  drop(tile: SandboxTile, colour: number, players?: readonly SandboxPlayer[]): void;
  /** Build a stack bottom-up. */
  stack(tile: SandboxTile, colours: readonly number[]): void;
  /** The open tiles a drop may land on, in the documented `(y, x)` order. */
  open(players?: readonly SandboxPlayer[]): SandboxTile[];
}

/**
 * An authority whose draws are scripted. `drop` computes the draw that selects
 * a given tile from the documented order: open tiles enumerated by `(y, x)`,
 * skipping the entrance, tiles within one of a player and full stacks.
 */
function rig(fallback: () => number = () => 0.5): Rig {
  const draws: number[] = [];
  let calls = 0;
  const sandbox = createSandboxAuthority({
    random: () => {
      calls += 1;
      return draws.length > 0 ? (draws.shift() as number) : fallback();
    },
  });
  const openTiles = (players: readonly SandboxPlayer[]): SandboxTile[] => {
    const blocked = new Set<string>();
    for (const player of players) {
      const here = sandboxTileAt(player.x, player.y);
      if (here === null) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) blocked.add(sandboxTileKey(here.x + dx, here.y + dy));
      }
    }
    const open: SandboxTile[] = [];
    for (let y = TOP; y <= BOTTOM; y += 1) {
      for (let x = LEFT; x <= RIGHT; x += 1) {
        if (isEntranceTile(x, y)) continue;
        if (blocked.has(sandboxTileKey(x, y))) continue;
        if (sandboxLevelAt(sandbox.columns(), x, y) >= SANDBOX_MAX_HEIGHT) continue;
        open.push({ x, y });
      }
    }
    return open;
  };
  const drop = (tile: SandboxTile, colour: number, players: readonly SandboxPlayer[] = []): void => {
    const open = openTiles(players);
    const index = open.findIndex((candidate) => candidate.x === tile.x && candidate.y === tile.y);
    if (index < 0) throw new Error(`tile ${tile.x},${tile.y} is not open`);
    draws.push((index + 0.5) / open.length, (colour + 0.5) / SANDBOX_COLOURS);
    const landed = sandbox.spawn(players);
    if (landed === null || isSandboxBurst(landed) || landed.x !== tile.x || landed.y !== tile.y) {
      throw new Error(`drop missed ${tile.x},${tile.y}`);
    }
  };
  return {
    sandbox,
    draws,
    calls: () => calls,
    drop,
    stack: (tile, colours) => {
      for (const colour of colours) drop(tile, colour);
    },
    open: (players = []) => openTiles(players),
  };
}

function heightAt(sandbox: SandboxAuthority, x: number, y: number): number {
  return sandboxLevelAt(sandbox.columns(), x, y);
}

/** A grid of players whose one-tile neighbourhoods cover the whole area. */
function coveringGrid(): SandboxPlayer[] {
  const xs = [55, 58, 61, 64, 67, 70, 73, 76, 79, 81];
  const ys = [1, 4, 7, 10, 13, 16, 19, 22, 25, 27];
  const players: SandboxPlayer[] = [];
  for (const y of ys) for (const x of xs) players.push(at(x, y, `p${x},${y}`));
  return players;
}

describe('geometry helpers', () => {
  it('uses 32-pixel tiles, a 48-pixel reach and the shared area', () => {
    expect(SANDBOX_TILE_SIZE).toBe(32);
    expect(SANDBOX_ACTION_RANGE).toBe(48);
    expect(isSandboxTile(LEFT, TOP)).toBe(true);
    expect(isSandboxTile(RIGHT, BOTTOM)).toBe(true);
    expect(isSandboxTile(LEFT - 1, TOP)).toBe(false);
    expect(isSandboxTile(RIGHT + 1, TOP)).toBe(false);
    expect(isSandboxTile(LEFT, TOP - 1)).toBe(false);
    expect(isSandboxTile(LEFT, BOTTOM + 1)).toBe(false);
    expect(isSandboxTile(LEFT + 0.5, TOP)).toBe(false);
    expect(isSandboxTile(Number.NaN, TOP)).toBe(false);
  });

  it('keeps the entrance inside the area, flush with its west edge (D-060)', () => {
    const { x, y, width, height } = SANDBOX_ENTRANCE;
    expect(x).toBe(LEFT);
    expect(isSandboxTile(x, y) && isSandboxTile(x + width - 1, y + height - 1)).toBe(true);
    expect(isEntranceTile(x, y)).toBe(true);
    expect(isEntranceTile(x + width - 1, y + height - 1)).toBe(true);
    expect(isEntranceTile(x + width, y)).toBe(false);
    expect(isEntranceTile(x, y - 1)).toBe(false);
    expect(isEntranceTile(x, y + height)).toBe(false);
    expect(isEntranceTile(x - 1, y)).toBe(false);
    expect(isEntranceTile(x + 0.5, y)).toBe(false);
    expect(isEntranceTile(Number.NaN, y)).toBe(false);
  });

  it('floors pixel positions to tiles, including negative ones', () => {
    expect(sandboxTileAt(0, 0)).toEqual({ x: 0, y: 0 });
    expect(sandboxTileAt(31.9, 32)).toEqual({ x: 0, y: 1 });
    expect(sandboxTileAt(-0.5, -32)).toEqual({ x: -1, y: -1 });
    expect(sandboxTileAt(Number.NaN, 0)).toBeNull();
    expect(sandboxTileAt(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('reads a level from a column list or a stack map, and 0 outside the area', () => {
    const columns = [{ x: LEFT, y: TOP, colours: [1, 2, 3] }];
    expect(sandboxLevelAt(columns, LEFT, TOP)).toBe(3);
    expect(sandboxLevelAt(columns, LEFT + 1, TOP)).toBe(0);
    const stacks = new Map([[sandboxTileKey(LEFT, TOP), [4, 5]]]);
    expect(sandboxLevelAt(stacks, LEFT, TOP)).toBe(2);
    expect(sandboxLevelAt(stacks, LEFT, TOP + 1)).toBe(0);
    // A stack claimed outside the area is not something anyone stands on.
    const outside = new Map([[sandboxTileKey(LEFT - 1, TOP), [1]]]);
    expect(sandboxLevelAt(outside, LEFT - 1, TOP)).toBe(0);
    expect(sandboxLevelAt(columns, LEFT + 0.5, TOP)).toBe(0);
  });

  it('switches from the fast to the slow drop interval at the fast limit', () => {
    expect(SANDBOX_SPAWN_INTERVAL_MS).toBe(1500);
    expect(SANDBOX_SLOW_SPAWN_INTERVAL_MS).toBe(5000);
    expect(SANDBOX_FAST_SPAWN_LIMIT).toBe(120);
    expect(sandboxSpawnDelay(0)).toBe(SANDBOX_SPAWN_INTERVAL_MS);
    expect(sandboxSpawnDelay(SANDBOX_FAST_SPAWN_LIMIT - 1)).toBe(SANDBOX_SPAWN_INTERVAL_MS);
    expect(sandboxSpawnDelay(SANDBOX_FAST_SPAWN_LIMIT)).toBe(SANDBOX_SLOW_SPAWN_INTERVAL_MS);
    expect(sandboxSpawnDelay(SANDBOX_MAX_BLOCKS)).toBe(SANDBOX_SLOW_SPAWN_INTERVAL_MS);
  });
});

describe('a new authority', () => {
  it('starts empty, frozen and carrying nothing', () => {
    const sandbox = createSandboxAuthority();
    expect(sandbox.columns()).toEqual([]);
    expect(Object.isFrozen(sandbox.columns())).toBe(true);
    expect(sandbox.totalBlocks).toBe(0);
    expect(sandbox.carrying('anyone')).toBeNull();
    const snapshot = sandbox.snapshotFor('anyone');
    expect(snapshot).toEqual({ columns: [], carrying: null });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('falls back to Math.random for a malformed options value', () => {
    for (const options of [null, { random: 'not a function' }] as const) {
      const sandbox = createSandboxAuthority(options as never);
      expect(sandbox.spawn([])).not.toBeNull();
    }
  });
});

describe('spawn', () => {
  it('never drops into the entrance, so the rain cannot wall the way in', () => {
    const sandbox = createSandboxAuthority({ random: mulberry32(2_025) });
    while (sandbox.spawn([]) !== null) { /* rain to the cap */ }
    expect(sandbox.totalBlocks).toBe(SANDBOX_MAX_BLOCKS);
    expect(sandbox.columns().filter((column) => isEntranceTile(column.x, column.y))).toEqual([]);
  });

  it('draws the tile first, then the colour, from open tiles in (y, x) order', () => {
    const { sandbox, draws, calls } = rig();
    draws.push(0, 0);
    expect(sandbox.spawn([])).toEqual({ x: LEFT, y: TOP });
    draws.push(0.999999, 0.999999);
    expect(sandbox.spawn([])).toEqual({ x: RIGHT, y: BOTTOM });
    expect(calls()).toBe(4);
    expect(sandbox.columns()).toEqual([
      { x: LEFT, y: TOP, colours: [0] },
      { x: RIGHT, y: BOTTOM, colours: [SANDBOX_COLOURS - 1] },
    ]);
    expect(sandbox.totalBlocks).toBe(2);
  });

  it('lands on top of an existing stack', () => {
    const { sandbox, stack } = rig();
    stack({ x: 60, y: 10 }, [1, 2, 3]);
    expect(sandbox.columns()).toEqual([{ x: 60, y: 10, colours: [1, 2, 3] }]);
    expect(sandbox.totalBlocks).toBe(3);
  });

  it('returns a frozen tile and nothing that names a player', () => {
    const { sandbox } = rig(mulberry32(7));
    const tile = sandbox.spawn([at(60, 10, 'someone')]);
    expect(tile).not.toBeNull();
    expect(Object.isFrozen(tile)).toBe(true);
    expect(Object.keys(tile as object).sort()).toEqual(['x', 'y']);
  });

  it('never lands within one tile of any player, over many seeded drops', () => {
    const sandbox = createSandboxAuthority({ random: mulberry32(20260927) });
    const players = [
      at(60, 10, 'a'),
      at(LEFT - 1, 5, 'b'), // just outside the west edge: still guards column 54
      at(RIGHT, BOTTOM, 'c', 15, 15),
      at(70, TOP, 'd', -15, -15),
    ];
    const tiles = players.map((player) => sandboxTileAt(player.x, player.y) as SandboxTile);
    for (let n = 0; n < 800; n += 1) {
      const tile = sandbox.spawn(players);
      expect(tile).not.toBeNull();
      const landed = tile as SandboxTile;
      expect(isSandboxTile(landed.x, landed.y)).toBe(true);
      for (const guarded of tiles) {
        const distance = Math.max(Math.abs(landed.x - guarded.x), Math.abs(landed.y - guarded.y));
        expect(distance, `landed ${landed.x},${landed.y} next to ${guarded.x},${guarded.y}`).toBeGreaterThan(1);
      }
    }
    expect(sandbox.totalBlocks).toBe(800);
  });

  it('uses every colour in the palette and nothing outside it', () => {
    const sandbox = createSandboxAuthority({ random: mulberry32(11) });
    for (let n = 0; n < 400; n += 1) sandbox.spawn([]);
    const seen = new Set(sandbox.columns().flatMap((column) => column.colours));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns null without drawing when no tile is open', () => {
    const { sandbox, calls } = rig();
    expect(sandbox.spawn(coveringGrid())).toBeNull();
    expect(calls()).toBe(0);
    expect(sandbox.totalBlocks).toBe(0);
  });

  it('never builds a column past SANDBOX_BURST_HEIGHT, so the height cap is never reached (D-071)', () => {
    const { sandbox } = rig(mulberry32(3));
    expect(SANDBOX_BURST_HEIGHT).toBeLessThan(SANDBOX_MAX_HEIGHT);
    // Leave only the 3x3 corner around (55, 1) open: the rain piles up there.
    const players = coveringGrid().filter((player) => player.key !== 'p55,1');
    let bursts = 0;
    for (let n = 0; n < 300; n += 1) {
      const landing = sandbox.spawn(players);
      expect(landing).not.toBeNull();
      if (isSandboxBurst(landing as NonNullable<typeof landing>)) bursts += 1;
      for (const column of sandbox.columns()) {
        expect(column.colours.length).toBeLessThanOrEqual(SANDBOX_BURST_HEIGHT);
      }
    }
    expect(bursts).toBeGreaterThan(0);
  });

  it('stops at the block cap, counting a carried block, and resumes after a release', () => {
    const { sandbox, drop } = rig(mulberry32(9));
    drop({ x: 60, y: 10 }, 4);
    expect(sandbox.pick(at(61, 10, 'carrier'), { x: 60, y: 10 }, [])).toBe(true);
    expect(sandbox.columns()).toEqual([]);
    expect(sandbox.totalBlocks).toBe(1);
    for (let n = 1; n < SANDBOX_MAX_BLOCKS; n += 1) expect(sandbox.spawn([])).not.toBeNull();
    expect(sandbox.totalBlocks).toBe(SANDBOX_MAX_BLOCKS);
    expect(sandbox.spawn([])).toBeNull();
    sandbox.release('carrier');
    expect(sandbox.totalBlocks).toBe(SANDBOX_MAX_BLOCKS - 1);
    expect(sandbox.spawn([])).not.toBeNull();
  });

  it('clamps a misbehaving random source to a valid tile and colour', () => {
    for (const sample of [Number.NaN, -1, 1, 2, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const sandbox = createSandboxAuthority({ random: () => sample });
      const tile = sandbox.spawn([]);
      expect(tile).not.toBeNull();
      const landed = tile as SandboxTile;
      expect(isSandboxTile(landed.x, landed.y)).toBe(true);
      const colour = sandbox.columns()[0]?.colours[0] as number;
      expect(Number.isInteger(colour) && colour >= 0 && colour < SANDBOX_COLOURS).toBe(true);
    }
  });

  it('changes nothing when the random source throws on either draw', () => {
    for (const failingDraw of [3, 4]) {
      let draws = 0;
      const sandbox = createSandboxAuthority({
        random: () => {
          draws += 1;
          if (draws === failingDraw) throw new Error('no entropy');
          return 0.25;
        },
      });
      expect(sandbox.spawn([])).not.toBeNull();
      const before = sandbox.columns();
      expect(() => sandbox.spawn([])).toThrow('no entropy');
      expect(sandbox.columns()).toBe(before);
      expect(sandbox.totalBlocks).toBe(1);
    }
  });

  it('refuses a players value that is not an array, without drawing', () => {
    const { sandbox, calls } = rig();
    expect(sandbox.spawn(null as never)).toBeNull();
    expect(sandbox.spawn({ length: 0 } as never)).toBeNull();
    expect(calls()).toBe(0);
  });
});

describe('pick', () => {
  it('takes the top colour of a neighbouring stack', () => {
    const { sandbox, stack } = rig();
    stack({ x: 60, y: 10 }, [1, 6]);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, [])).toBe(true);
    expect(sandbox.carrying('me')).toBe(6);
    expect(sandbox.columns()).toEqual([{ x: 60, y: 10, colours: [1] }]);
    expect(sandbox.totalBlocks).toBe(2);
  });

  it('removes a stack entirely when its last block is taken', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 3);
    expect(sandbox.pick(at(60, 11), { x: 60, y: 10 }, [])).toBe(true);
    expect(sandbox.columns()).toEqual([]);
    expect(heightAt(sandbox, 60, 10)).toBe(0);
    expect(sandbox.totalBlocks).toBe(1);
  });

  it('refuses while already carrying', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 3);
    drop({ x: 62, y: 10 }, 4);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, [])).toBe(true);
    expect(sandbox.pick(at(61, 10), { x: 62, y: 10 }, [])).toBe(false);
    expect(sandbox.carrying('me')).toBe(3);
    expect(heightAt(sandbox, 62, 10)).toBe(1);
  });

  it('refuses the tile the player stands on', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 3);
    expect(sandbox.pick(at(60, 10), { x: 60, y: 10 }, [])).toBe(false);
    expect(heightAt(sandbox, 60, 10)).toBe(1);
  });

  it('refuses an empty tile', () => {
    const { sandbox } = rig();
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, [])).toBe(false);
    expect(sandbox.carrying('me')).toBeNull();
  });

  it('measures reach from the player position to the tile centre, as a square box', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 1);
    drop({ x: 64, y: 10 }, 2);
    drop({ x: 62, y: 12 }, 3);
    // Diagonal neighbour from the centre: 32 px each way.
    expect(sandbox.pick(at(61, 11, 'diag'), { x: 62, y: 12 }, [])).toBe(true);
    // Standing on the far (west) edge of tile 62: tile 64's centre is 80 px away.
    const westEdge: SandboxPlayer = { key: 'edge', x: 62 * T, y: 10 * T + 16 };
    expect(sandbox.pick(westEdge, { x: 64, y: 10 }, [])).toBe(false);
    // Standing on the west edge of tile 61, tile 60's centre is 16 px away and
    // the right neighbour 62's centre exactly 48 px: both inside the box.
    const onBoundary: SandboxPlayer = { key: 'boundary', x: 61 * T, y: 10 * T + 16 };
    expect(sandbox.pick(onBoundary, { x: 60, y: 10 }, [])).toBe(true);
  });

  it('allows exactly 48 px and refuses 49', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 1);
    // Tile 60's centre is at x = 1936; x = 1984 is the west edge of tile 62,
    // exactly 48 px away, and one pixel further is out of reach.
    const exactly: SandboxPlayer = { key: 'a', x: 60 * T + 16 + 48, y: 10 * T + 16 };
    expect(sandboxTileAt(exactly.x, exactly.y)).toEqual({ x: 62, y: 10 });
    const beyond: SandboxPlayer = { key: 'b', x: 60 * T + 16 + 49, y: 10 * T + 16 };
    expect(sandbox.pick(beyond, { x: 60, y: 10 }, [])).toBe(false);
    expect(sandbox.pick(exactly, { x: 60, y: 10 }, [])).toBe(true);
    // Vertical axis too.
    drop({ x: 70, y: 10 }, 2);
    const below: SandboxPlayer = { key: 'c', x: 70 * T + 16, y: 10 * T + 16 + 49 };
    expect(sandbox.pick(below, { x: 70, y: 10 }, [])).toBe(false);
    const justBelow: SandboxPlayer = { key: 'd', x: 70 * T + 16 + 5, y: 10 * T + 16 + 48 };
    expect(sandbox.pick(justBelow, { x: 70, y: 10 }, [])).toBe(true);
  });

  it('refuses tiles outside the area and accepts its corners', () => {
    const { sandbox, drop } = rig();
    drop({ x: LEFT, y: TOP }, 1);
    drop({ x: RIGHT, y: BOTTOM }, 2);
    for (const tile of [
      { x: LEFT - 1, y: TOP },
      { x: RIGHT + 1, y: BOTTOM },
      { x: LEFT, y: TOP - 1 },
      { x: RIGHT, y: BOTTOM + 1 },
    ]) {
      expect(sandbox.pick(at(tile.x + 1, tile.y, 'probe'), tile, [])).toBe(false);
    }
    expect(sandbox.pick(at(LEFT + 1, TOP, 'a'), { x: LEFT, y: TOP }, [])).toBe(true);
    expect(sandbox.pick(at(RIGHT - 1, BOTTOM, 'b'), { x: RIGHT, y: BOTTOM }, [])).toBe(true);
  });

  it('refuses malformed tiles and players without throwing', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 1);
    const player = at(61, 10);
    const tiles: unknown[] = [
      null,
      undefined,
      'tile',
      [60, 10],
      { x: 60.5, y: 10 },
      { x: Number.NaN, y: 10 },
      { x: 60, y: Number.POSITIVE_INFINITY },
      { x: '60', y: '10' },
      {
        get x(): number {
          throw new Error('hostile getter');
        },
        y: 10,
      },
    ];
    for (const tile of tiles) expect(sandbox.pick(player, tile as SandboxTile, [])).toBe(false);
    const players: unknown[] = [
      null,
      { key: 'x', x: Number.NaN, y: 0 },
      { key: 42, x: player.x, y: player.y },
      { x: player.x, y: player.y },
      {
        key: 'hostile',
        get x(): number {
          throw new Error('hostile getter');
        },
        y: 0,
      },
    ];
    for (const candidate of players) {
      expect(sandbox.pick(candidate as SandboxPlayer, { x: 60, y: 10 }, [])).toBe(false);
    }
    expect(heightAt(sandbox, 60, 10)).toBe(1);
    expect(sandbox.totalBlocks).toBe(1);
  });

  it('reaches from one below to two above the level on the ground', () => {
    const { sandbox, stack } = rig();
    stack({ x: 60, y: 10 }, [1]);
    stack({ x: 62, y: 10 }, [1, 2]);
    stack({ x: 61, y: 9 }, [1, 2, 3]);
    const player = (key: string): SandboxPlayer => at(61, 10, key);
    expect(sandbox.pick(player('h1'), { x: 60, y: 10 }, [])).toBe(true);
    expect(sandbox.pick(player('h2'), { x: 62, y: 10 }, [])).toBe(true);
    expect(sandbox.pick(player('h3'), { x: 61, y: 9 }, [])).toBe(false);
  });

  it('reaches relative to the stack under the player', () => {
    const { sandbox, stack } = rig();
    // The player stands on a stack of 2 at (61, 10).
    stack({ x: 61, y: 10 }, [0, 0]);
    stack({ x: 60, y: 10 }, [1]); // top 1 = level - 1: in reach
    stack({ x: 62, y: 10 }, [1, 1, 1, 1]); // top 4 = level + 2: in reach
    stack({ x: 61, y: 9 }, [2, 2, 2, 2, 2]); // top 5 = level + 3: out of reach
    stack({ x: 61, y: 11 }, [3, 3]); // top 2 = level: in reach
    expect(sandbox.pick(at(61, 10, 'a'), { x: 60, y: 10 }, [])).toBe(true);
    expect(sandbox.pick(at(61, 10, 'b'), { x: 62, y: 10 }, [])).toBe(true);
    expect(sandbox.pick(at(61, 10, 'c'), { x: 61, y: 9 }, [])).toBe(false);
    expect(sandbox.pick(at(61, 10, 'd'), { x: 61, y: 11 }, [])).toBe(true);

    // Standing on 3, a single block is two below: out of reach.
    const high = rig();
    high.stack({ x: 61, y: 10 }, [0, 0, 0]);
    high.stack({ x: 60, y: 10 }, [1]);
    high.stack({ x: 62, y: 10 }, [1, 1]);
    expect(high.sandbox.pick(at(61, 10, 'e'), { x: 60, y: 10 }, [])).toBe(false);
    expect(high.sandbox.pick(at(61, 10, 'f'), { x: 62, y: 10 }, [])).toBe(true);
  });

  it('treats the level outside the area as the ground', () => {
    const { sandbox, stack } = rig();
    stack({ x: LEFT, y: 5 }, [1, 2]);
    stack({ x: LEFT, y: 6 }, [1, 2, 3]);
    // Standing on the road just west of the sandbox.
    expect(sandbox.pick(at(LEFT - 1, 5, 'a'), { x: LEFT, y: 5 }, [])).toBe(true);
    expect(sandbox.pick(at(LEFT - 1, 6, 'b'), { x: LEFT, y: 6 }, [])).toBe(false);
  });

  it('refuses to pull a block out from under another player (D-060)', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 5);
    const standing = at(60, 10, 'other', 10, -10);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, [standing])).toBe(false);
    expect(sandbox.carrying('me')).toBeNull();
    expect(heightAt(sandbox, 60, 10)).toBe(1);
    // Once they step off, the block is fair game; unlocatable entries block nothing.
    expect(
      sandbox.pick(at(61, 10), { x: 60, y: 10 }, [
        at(62, 12, 'other'),
        { key: 'ghost', x: Number.NaN, y: 0 },
        null as never,
      ]),
    ).toBe(true);
  });

  it('fails closed when the other players are not an array', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 5);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, null as never)).toBe(false);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, { length: 0 } as never)).toBe(false);
    expect(heightAt(sandbox, 60, 10)).toBe(1);
  });
});

describe('place', () => {
  /** A rig where 'me' already carries `colour`, picked from (60, 12). */
  function carrying(colour: number): Rig {
    const r = rig();
    r.drop({ x: 60, y: 12 }, colour);
    if (!r.sandbox.pick(at(60, 11), { x: 60, y: 12 }, [])) throw new Error('setup pick failed');
    return r;
  }

  it('puts the carried colour on top of a neighbouring tile', () => {
    const { sandbox, drop } = carrying(6);
    drop({ x: 62, y: 11 }, 1);
    const landed = sandbox.place(at(61, 11), { x: 62, y: 11 }, []);
    expect(landed).toEqual({ x: 62, y: 11 });
    expect(Object.isFrozen(landed)).toBe(true);
    expect(sandbox.carrying('me')).toBeNull();
    expect(sandbox.columns()).toEqual([{ x: 62, y: 11, colours: [1, 6] }]);
    expect(sandbox.totalBlocks).toBe(2);
  });

  it('still lets a player build in the entrance, where nothing falls', () => {
    const { sandbox } = carrying(3);
    const inside = { x: SANDBOX_ENTRANCE.x + SANDBOX_ENTRANCE.width - 1, y: SANDBOX_ENTRANCE.y + 2 };
    expect(isEntranceTile(inside.x, inside.y)).toBe(true);
    expect(sandbox.place(at(inside.x + 1, inside.y), inside, [])).not.toBeNull();
    expect(sandbox.columns()).toEqual([{ ...inside, colours: [3] }]);
  });

  it('keeps entrance stacks to one step, so the way in cannot be walled off', () => {
    const r = carrying(3);
    const inside = { x: SANDBOX_ENTRANCE.x + SANDBOX_ENTRANCE.width - 1, y: SANDBOX_ENTRANCE.y + 2 };
    const me = at(inside.x + 1, inside.y);
    expect(r.sandbox.place(me, inside, [])).not.toBeNull();
    r.drop({ x: inside.x + 2, y: inside.y }, 5);
    expect(r.sandbox.pick(me, { x: inside.x + 2, y: inside.y }, [])).toBe(true);
    expect(r.sandbox.place(me, inside, [])).toBeNull();
    expect(r.sandbox.carrying('me')).toBe(5);
    expect(r.sandbox.columns()).toEqual([{ ...inside, colours: [3] }]);
    // One tile further in, the usual rules apply.
    expect(r.sandbox.place(me, { x: inside.x + 2, y: inside.y }, [])).not.toBeNull();
  });

  it('refuses when not carrying', () => {
    const { sandbox } = rig();
    expect(sandbox.place(at(61, 11), { x: 62, y: 11 }, [])).toBeNull();
    expect(sandbox.columns()).toEqual([]);
  });

  it('refuses the own tile, out-of-range and out-of-area tiles', () => {
    const { sandbox } = carrying(2);
    expect(sandbox.place(at(61, 11), { x: 61, y: 11 }, [])).toBeNull();
    expect(sandbox.place(at(61, 11), { x: 63, y: 11 }, [])).toBeNull();
    expect(sandbox.place(at(LEFT, 11), { x: LEFT - 1, y: 11 }, [])).toBeNull();
    expect(sandbox.place(at(61, TOP), { x: 61, y: TOP - 1 }, [])).toBeNull();
    expect(sandbox.carrying('me')).toBe(2);
    expect(sandbox.columns()).toEqual([]);
  });

  it('refuses the tile under another player', () => {
    const { sandbox } = carrying(2);
    const other = at(62, 11, 'other', 10, -10);
    expect(sandbox.place(at(61, 11), { x: 62, y: 11 }, [other])).toBeNull();
    expect(sandbox.carrying('me')).toBe(2);
    // Elsewhere is fine, and unlocatable entries do not block anything.
    expect(
      sandbox.place(at(61, 11), { x: 62, y: 11 }, [
        at(64, 11, 'far'),
        { key: 'ghost', x: Number.NaN, y: 0 },
        null as never,
      ]),
    ).toEqual({ x: 62, y: 11 });
  });

  it('fails closed when the other players are not an array', () => {
    const { sandbox } = carrying(2);
    expect(sandbox.place(at(61, 11), { x: 62, y: 11 }, null as never)).toBeNull();
    expect(sandbox.carrying('me')).toBe(2);
  });

  it('reaches from one below to two above the level, for the new top', () => {
    const ground = carrying(1);
    ground.stack({ x: 62, y: 11 }, [0]); // new top 2: in reach
    expect(ground.sandbox.place(at(61, 11), { x: 62, y: 11 }, [])).not.toBeNull();

    const tooHigh = carrying(1);
    tooHigh.stack({ x: 62, y: 11 }, [0, 0]); // new top 3 on level 0: out of reach
    expect(tooHigh.sandbox.place(at(61, 11), { x: 62, y: 11 }, [])).toBeNull();
    expect(tooHigh.sandbox.carrying('me')).toBe(1);

    // Standing on 3: placing on the ground (new top 1) is below reach, on a
    // stack of 1 (new top 2) is in reach, on 4 (new top 5) in, on 5 out.
    const high = carrying(1);
    high.stack({ x: 61, y: 11 }, [0, 0, 0]);
    high.stack({ x: 61, y: 10 }, [0]);
    high.stack({ x: 60, y: 10 }, [0, 0, 0, 0]);
    high.stack({ x: 62, y: 10 }, [0, 0, 0, 0, 0]);
    expect(high.sandbox.place(at(61, 11), { x: 62, y: 11 }, [])).toBeNull();
    expect(high.sandbox.place(at(61, 11), { x: 62, y: 10 }, [])).toBeNull();
    expect(high.sandbox.place(at(61, 11), { x: 60, y: 10 }, [])).not.toBeNull();
    expect(high.sandbox.pick(at(61, 11), { x: 60, y: 10 }, [])).toBe(true);
    expect(high.sandbox.place(at(61, 11), { x: 61, y: 10 }, [])).not.toBeNull();
  });

});

describe('returnCarried', () => {
  /** A rig where 'me' carries `colour`, picked from (60, 12) while standing on (60, 11). */
  function carrier(colour: number, fallback?: () => number): Rig {
    const r = rig(fallback);
    r.drop({ x: 60, y: 12 }, colour);
    if (!r.sandbox.pick(at(60, 11), { x: 60, y: 12 }, [])) throw new Error('setup pick failed');
    return r;
  }

  it('drops the carried block back from the sky, keeping its colour and the total', () => {
    const r = carrier(6);
    const leaver = at(60, 11);
    const open = r.open([leaver]);
    const target = open.findIndex((tile) => tile.x === 70 && tile.y === 20);
    r.draws.push((target + 0.5) / open.length);
    const calls = r.calls();

    const tile = r.sandbox.returnCarried('me', [leaver]);

    expect(tile).toEqual({ x: 70, y: 20 });
    expect(Object.isFrozen(tile)).toBe(true);
    expect(Object.keys(tile as object).sort()).toEqual(['x', 'y']);
    expect(r.calls() - calls).toBe(1); // the tile only: the colour is kept
    expect(r.sandbox.carrying('me')).toBeNull();
    expect(r.sandbox.columns()).toEqual([{ x: 70, y: 20, colours: [6] }]);
    expect(r.sandbox.totalBlocks).toBe(1);
  });

  it('never lands within one tile of any listed player, the carrier included', () => {
    const random = mulberry32(606);
    for (let trial = 0; trial < 300; trial += 1) {
      const r = rig(random);
      const pickSpot = () => ({
        x: LEFT + 1 + Math.floor(random() * (SANDBOX_AREA.width - 2)),
        y: TOP + 1 + Math.floor(random() * (SANDBOX_AREA.height - 2)),
      });
      // The block reaches the neighbour by falling, and nothing falls in the entrance.
      let spot = pickSpot();
      while (isEntranceTile(spot.x + 1, spot.y)) spot = pickSpot();
      const neighbour = { x: spot.x + 1, y: spot.y };
      const colour = trial % SANDBOX_COLOURS;
      r.drop(neighbour, colour);
      const player = at(spot.x, spot.y, 'me', Math.floor(random() * 31) - 15, Math.floor(random() * 31) - 15);
      expect(r.sandbox.pick(player, neighbour, [])).toBe(true);
      const bystander = at(
        LEFT + Math.floor(random() * SANDBOX_AREA.width),
        TOP + Math.floor(random() * SANDBOX_AREA.height),
        'bystander',
      );

      const tile = r.sandbox.returnCarried('me', [player, bystander]);

      expect(tile).not.toBeNull();
      const landed = tile as SandboxTile;
      expect(isEntranceTile(landed.x, landed.y), `trial ${trial} landed in the entrance`).toBe(false);
      for (const who of [player, bystander]) {
        const there = sandboxTileAt(who.x, who.y) as SandboxTile;
        const distance = Math.max(Math.abs(landed.x - there.x), Math.abs(landed.y - there.y));
        expect(distance, `trial ${trial} landed next to ${who.key}`).toBeGreaterThan(1);
      }
      expect(r.sandbox.columns()).toEqual([{ x: landed.x, y: landed.y, colours: [colour] }]);
    }
  });

  it('discards the block, without drawing, when no tile is allowed', () => {
    const r = carrier(3);
    const calls = r.calls();
    expect(r.sandbox.returnCarried('me', [...coveringGrid(), at(60, 11)])).toBeNull();
    expect(r.calls()).toBe(calls);
    expect(r.sandbox.carrying('me')).toBeNull();
    expect(r.sandbox.totalBlocks).toBe(0);
    expect(r.sandbox.columns()).toEqual([]);
  });

  it('discards the block, without drawing, when the players are not an array', () => {
    const r = carrier(3);
    const calls = r.calls();
    expect(r.sandbox.returnCarried('me', null as never)).toBeNull();
    expect(r.calls()).toBe(calls);
    expect(r.sandbox.carrying('me')).toBeNull();
    expect(r.sandbox.totalBlocks).toBe(0);
  });

  it('does nothing, without drawing, for a key that carries nothing', () => {
    const r = carrier(3);
    const calls = r.calls();
    const before = r.sandbox.columns();
    expect(r.sandbox.returnCarried('nobody', [])).toBeNull();
    expect(r.sandbox.returnCarried(42 as never, [])).toBeNull();
    expect(r.calls()).toBe(calls);
    expect(r.sandbox.columns()).toBe(before);
    expect(r.sandbox.carrying('me')).toBe(3);
    expect(r.sandbox.totalBlocks).toBe(1);
  });

  it('leaves the block carried when the random source throws', () => {
    let draws = 0;
    const sandbox = createSandboxAuthority({
      random: () => {
        draws += 1;
        if (draws === 3) throw new Error('no entropy');
        return 0;
      },
    });
    expect(sandbox.spawn([])).toEqual({ x: LEFT, y: TOP });
    expect(sandbox.pick(at(LEFT + 1, TOP), { x: LEFT, y: TOP }, [])).toBe(true);
    expect(() => sandbox.returnCarried('me', [at(LEFT + 1, TOP)])).toThrow('no entropy');
    expect(sandbox.carrying('me')).toBe(0);
    expect(sandbox.columns()).toEqual([]);
    expect(sandbox.totalBlocks).toBe(1);
  });

  it('conserves every block through any number of pick-and-leave cycles', () => {
    const r = rig(mulberry32(5150));
    for (let n = 0; n < 100; n += 1) expect(r.sandbox.spawn([])).not.toBeNull();
    let cycles = 0;
    for (let round = 0; round < 400 && cycles < 200; round += 1) {
      // Any stack with a neighbouring tile it can be reached from.
      const reachable = r.sandbox.columns().flatMap((column) =>
        [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => ({ x: column.x + (dx as number), y: column.y + (dy as number) }))
          .filter((spot) => isSandboxTile(spot.x, spot.y))
          .filter((spot) => {
            const level = heightAt(r.sandbox, spot.x, spot.y);
            return column.colours.length >= level - 1 && column.colours.length <= level + 2;
          })
          .map((spot) => ({ column, spot })),
      );
      const choice = reachable[round % reachable.length];
      if (choice === undefined) break;
      const player = at(choice.spot.x, choice.spot.y);
      expect(r.sandbox.pick(player, choice.column, [])).toBe(true);
      expect(r.sandbox.returnCarried('me', [player])).not.toBeNull();
      expect(r.sandbox.totalBlocks).toBe(100);
      cycles += 1;
    }
    expect(cycles).toBe(200);
    const blocks = r.sandbox.columns().reduce((sum, column) => sum + column.colours.length, 0);
    expect(blocks).toBe(100);
  });
});

describe('bursting (D-071)', () => {
  const full = (colour = 1): number[] => Array.from({ length: SANDBOX_BURST_HEIGHT }, () => colour);
  const tall = (height: number, colour = 0): number[] => Array.from({ length: height }, () => colour);

  /** Script the next spawn's two draws so it falls on `tile`. */
  function aim(r: Rig, tile: SandboxTile, players: readonly SandboxPlayer[] = []): void {
    const open = r.open(players);
    const index = open.findIndex((candidate) => candidate.x === tile.x && candidate.y === tile.y);
    if (index < 0) throw new Error(`tile ${tile.x},${tile.y} is not open`);
    r.draws.push((index + 0.5) / open.length, 0.5);
  }

  /**
   * 'me' stands on a 13-high stack at (61, 11), within reach of a 15th block
   * on the column beside it at (62, 11), carrying a block from the supply
   * stack at (61, 10); 'other' carries a block of colour 3 far away.
   */
  function besidePillar(column: number): Rig & { readonly me: SandboxPlayer; readonly other: SandboxPlayer } {
    const r = rig();
    r.stack({ x: 61, y: 11 }, tall(SANDBOX_BURST_HEIGHT - 1));
    r.stack({ x: 62, y: 11 }, tall(column, 1));
    r.stack({ x: 61, y: 10 }, tall(SANDBOX_BURST_HEIGHT - 1, 2));
    r.drop({ x: 72, y: 20 }, 3);
    const me = at(61, 11);
    const other = at(73, 20, 'other');
    if (!r.sandbox.pick(me, { x: 61, y: 10 }, [other])) throw new Error('setup pick failed');
    if (!r.sandbox.pick(other, { x: 72, y: 20 }, [me])) throw new Error('setup pick failed');
    return { ...r, me, other };
  }

  it('drops the 14th block by sky drop onto SANDBOX_BURST_HEIGHT, and a 15th there bursts the sandbox', () => {
    const r = rig();
    r.stack({ x: 60, y: 10 }, tall(SANDBOX_BURST_HEIGHT - 1));
    r.drop({ x: 70, y: 20 }, 4);
    expect(heightAt(r.sandbox, 60, 10)).toBe(SANDBOX_BURST_HEIGHT - 1);

    // The drop that brings the column to SANDBOX_BURST_HEIGHT still stacks.
    aim(r, { x: 60, y: 10 });
    expect(r.sandbox.spawn([])).toEqual({ x: 60, y: 10 });
    expect(heightAt(r.sandbox, 60, 10)).toBe(SANDBOX_BURST_HEIGHT);

    const calls = r.calls();
    aim(r, { x: 60, y: 10 });
    const burst = r.sandbox.spawn([]);
    expect(burst).toEqual({ burst: { x: 60, y: 10 } });
    // Tile and colour, as for any drop, so scripted sources stay aligned.
    expect(r.calls() - calls).toBe(2);
    expect(Object.isFrozen(burst)).toBe(true);
    expect(Object.isFrozen((burst as SandboxBurst).burst)).toBe(true);
    expect(Object.keys(burst as object)).toEqual(['burst']);
    expect(Object.keys((burst as SandboxBurst).burst).sort()).toEqual(['x', 'y']);
    // Every placed block is gone, the far column's too, and the new one with them.
    expect(r.sandbox.columns()).toEqual([]);
    expect(Object.isFrozen(r.sandbox.columns())).toBe(true);
    expect(r.sandbox.totalBlocks).toBe(0);
    // And the board starts again.
    r.drop({ x: 60, y: 10 }, 2);
    expect(r.sandbox.columns()).toEqual([{ x: 60, y: 10, colours: [2] }]);
  });

  it('places the 14th block, and a 15th placed bursts it: the carried block goes, other hands keep theirs', () => {
    const r = besidePillar(SANDBOX_BURST_HEIGHT - 1);
    expect(r.sandbox.place(r.me, { x: 62, y: 11 }, [r.other])).toEqual({ x: 62, y: 11 });
    expect(heightAt(r.sandbox, 62, 11)).toBe(SANDBOX_BURST_HEIGHT);
    expect(r.sandbox.pick(r.me, { x: 61, y: 10 }, [r.other])).toBe(true);
    const total = r.sandbox.totalBlocks;
    // The pillar 'me' stands on, the column just placed onto, the supply
    // stack after two picks, and what 'me' and 'other' carry.
    expect(total).toBe(
      (SANDBOX_BURST_HEIGHT - 1) + SANDBOX_BURST_HEIGHT + (SANDBOX_BURST_HEIGHT - 3) + 2,
    );

    const burst = r.sandbox.place(r.me, { x: 62, y: 11 }, [r.other]);
    expect(burst).toEqual({ burst: { x: 62, y: 11 } });
    expect(Object.isFrozen(burst)).toBe(true);
    expect(r.sandbox.columns()).toEqual([]);
    expect(r.sandbox.carrying('me')).toBeNull();
    expect(r.sandbox.carrying('other')).toBe(3);
    expect(r.sandbox.totalBlocks).toBe(1);
    expect(r.sandbox.snapshotFor('other')).toEqual({ columns: [], carrying: 3 });
  });

  it('lands the 14th block when a carried block is put back, and a 15th put back bursts it', () => {
    const r = rig();
    r.drop({ x: 60, y: 12 }, 6);
    const leaver = at(60, 11);
    expect(r.sandbox.pick(leaver, { x: 60, y: 12 }, [])).toBe(true);
    r.drop({ x: 72, y: 20 }, 3);
    expect(r.sandbox.pick(at(73, 20, 'other'), { x: 72, y: 20 }, [])).toBe(true);
    r.stack({ x: 70, y: 5 }, tall(SANDBOX_BURST_HEIGHT - 1));

    // Returned onto a column one below the cap, the block still lands.
    let open = r.open([leaver]);
    r.draws.push((open.findIndex((tile) => tile.x === 70 && tile.y === 5) + 0.5) / open.length);
    expect(r.sandbox.returnCarried('me', [leaver])).toEqual({ x: 70, y: 5 });
    expect(heightAt(r.sandbox, 70, 5)).toBe(SANDBOX_BURST_HEIGHT);
    expect(r.sandbox.carrying('me')).toBeNull();

    // 'me' picks up another block, then returns it onto the now-full column.
    r.drop({ x: 60, y: 12 }, 5);
    expect(r.sandbox.pick(leaver, { x: 60, y: 12 }, [])).toBe(true);
    open = r.open([leaver]);
    r.draws.push((open.findIndex((tile) => tile.x === 70 && tile.y === 5) + 0.5) / open.length);
    const calls = r.calls();

    expect(r.sandbox.returnCarried('me', [leaver])).toEqual({ burst: { x: 70, y: 5 } });
    expect(r.calls() - calls).toBe(1);
    expect(r.sandbox.carrying('me')).toBeNull();
    expect(r.sandbox.carrying('other')).toBe(3);
    expect(r.sandbox.columns()).toEqual([]);
    expect(r.sandbox.totalBlocks).toBe(1);
  });

  it('refuses first: a place that is refused today changes nothing, full column or not', () => {
    const r = besidePillar(SANDBOX_BURST_HEIGHT);
    const before = r.sandbox.columns();
    // Two tiles away, the own tile, under another player, an unreadable
    // players list, from the ground (a 15th top is out of reach there), and
    // with empty hands.
    expect(r.sandbox.place(at(60, 11), { x: 62, y: 11 }, [])).toBeNull();
    expect(r.sandbox.place(r.me, { x: 61, y: 11 }, [])).toBeNull();
    expect(r.sandbox.place(r.me, { x: 62, y: 11 }, [at(62, 11, 'standing')])).toBeNull();
    expect(r.sandbox.place(r.me, { x: 62, y: 11 }, null as never)).toBeNull();
    expect(r.sandbox.place(at(63, 11), { x: 62, y: 11 }, [])).toBeNull();
    expect(r.sandbox.place(at(61, 11, 'empty-handed'), { x: 62, y: 11 }, [])).toBeNull();
    expect(r.sandbox.columns()).toBe(before);
    expect(heightAt(r.sandbox, 62, 11)).toBe(SANDBOX_BURST_HEIGHT);
    expect(r.sandbox.carrying('me')).toBe(2);
  });

  it('stops the rain at the block cap before it can burst anything', () => {
    const r = rig(mulberry32(8));
    r.stack({ x: 60, y: 10 }, full());
    // A guard beside the column keeps the rain off it while the board fills.
    const guard = at(61, 10, 'guard');
    while (r.sandbox.spawn([guard]) !== null) { /* rain to the cap */ }
    expect(r.sandbox.totalBlocks).toBe(SANDBOX_MAX_BLOCKS);
    expect(heightAt(r.sandbox, 60, 10)).toBe(SANDBOX_BURST_HEIGHT);
    const calls = r.calls();
    const before = r.sandbox.columns();
    expect(r.sandbox.spawn([])).toBeNull();
    expect(r.calls()).toBe(calls);
    expect(r.sandbox.columns()).toBe(before);
  });
});

describe('release', () => {
  it('discards the carried block and lowers the total', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 3);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, [])).toBe(true);
    const before = sandbox.columns();
    sandbox.release('me');
    expect(sandbox.carrying('me')).toBeNull();
    expect(sandbox.totalBlocks).toBe(0);
    // Stacks are untouched; the cached list is still valid.
    expect(sandbox.columns()).toBe(before);
    // A released player can pick again.
    drop({ x: 62, y: 10 }, 4);
    expect(sandbox.pick(at(61, 10), { x: 62, y: 10 }, [])).toBe(true);
  });

  it('is a no-op for a key that carries nothing', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 3);
    sandbox.release('nobody');
    sandbox.release(42 as never);
    expect(sandbox.totalBlocks).toBe(1);
  });
});

describe('snapshots', () => {
  it('sorts columns by (y, x) and never lists an empty one', () => {
    const { sandbox, drop } = rig();
    drop({ x: 70, y: 3 }, 1);
    drop({ x: 60, y: 9 }, 2);
    drop({ x: 65, y: 3 }, 3);
    drop({ x: 55, y: 9 }, 4);
    expect(sandbox.columns().map(({ x, y }) => [x, y])).toEqual([
      [65, 3],
      [70, 3],
      [55, 9],
      [60, 9],
    ]);
    expect(sandbox.pick(at(66, 3), { x: 65, y: 3 }, [])).toBe(true);
    expect(sandbox.columns().every((column) => column.colours.length > 0)).toBe(true);
    expect(sandbox.columns()).toHaveLength(3);
  });

  it('is frozen at every level and cannot be used to change the authority', () => {
    const { sandbox, stack } = rig();
    stack({ x: 60, y: 10 }, [1, 2]);
    const columns = sandbox.columns();
    // Probe the runtime boundary despite the readonly types.
    const column = columns[0] as unknown as { x: number; colours: number[] };
    expect(Object.isFrozen(columns)).toBe(true);
    expect(Object.isFrozen(column)).toBe(true);
    expect(Object.isFrozen(column.colours)).toBe(true);
    expect(Reflect.set(column, 'x', 99)).toBe(false);
    expect(Reflect.set(column.colours, 0, 7)).toBe(false);
    expect(() => (columns as unknown as unknown[]).push({})).toThrow();
    expect(sandbox.columns()).toEqual([{ x: 60, y: 10, colours: [1, 2] }]);
  });

  it('keeps one list until something changes, and never rewrites an old one', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 1);
    const first = sandbox.columns();
    expect(sandbox.columns()).toBe(first);
    drop({ x: 60, y: 10 }, 2);
    const second = sandbox.columns();
    expect(second).not.toBe(first);
    expect(first).toEqual([{ x: 60, y: 10, colours: [1] }]);
    expect(second).toEqual([{ x: 60, y: 10, colours: [1, 2] }]);
  });

  it('reports only the requesting key’s own carried colour', () => {
    const { sandbox, drop } = rig();
    drop({ x: 60, y: 10 }, 5);
    drop({ x: 64, y: 10 }, 6);
    expect(sandbox.pick(at(61, 10, 'a'), { x: 60, y: 10 }, [])).toBe(true);
    const mine = sandbox.snapshotFor('a');
    const theirs = sandbox.snapshotFor('b');
    expect(mine).toEqual({ columns: [{ x: 64, y: 10, colours: [6] }], carrying: 5 });
    expect(theirs).toEqual({ columns: [{ x: 64, y: 10, colours: [6] }], carrying: null });
    expect(Object.isFrozen(mine)).toBe(true);
    expect(mine.columns).toBe(sandbox.columns());
    expect(JSON.stringify(theirs)).not.toContain('"a"');
  });
});

describe('total block accounting', () => {
  it('counts spawns, keeps picks and places neutral and drops releases', () => {
    const { sandbox, drop } = rig();
    const history: number[] = [];
    drop({ x: 60, y: 10 }, 1);
    drop({ x: 62, y: 10 }, 2);
    history.push(sandbox.totalBlocks);
    expect(sandbox.pick(at(61, 10), { x: 60, y: 10 }, [])).toBe(true);
    history.push(sandbox.totalBlocks);
    expect(sandbox.place(at(61, 10), { x: 62, y: 10 }, [])).not.toBeNull();
    history.push(sandbox.totalBlocks);
    expect(sandbox.pick(at(61, 10), { x: 62, y: 10 }, [])).toBe(true);
    sandbox.release('me');
    history.push(sandbox.totalBlocks);
    expect(history).toEqual([2, 2, 2, 1]);
    expect(sandbox.columns()).toEqual([{ x: 62, y: 10, colours: [2] }]);
  });
});
