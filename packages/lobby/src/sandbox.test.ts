/**
 * The room's sandbox half without a transport: the registry's pick/place
 * wiring, the action floor, suspend/leave discards, spawn avoidance, and the
 * schema mirror a real client decodes.
 */

import { Encoder, MapSchema, Reflection } from '@colyseus/schema';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_AREA,
  SANDBOX_BURST_HEIGHT,
  SANDBOX_COLOURS,
  SANDBOX_MAX_BLOCKS,
  STREET_ORIGIN_X,
  type GameId,
  type SandboxColumn,
  type SandboxTile,
} from '@strkworld/shared';
import {
  DEFAULT_ROOM_CONFIG,
  SANDBOX_CLIENT_ACTION_INTERVAL_MS,
  SANDBOX_MIN_ACTION_INTERVAL_MS,
  resolveRoomConfig,
} from './config';
import { LobbyPresence, type LobbyPresenceOptions } from './presence';
import { LobbySandbox } from './sandbox';
import {
  SANDBOX_FAST_SPAWN_LIMIT,
  SANDBOX_SLOW_SPAWN_INTERVAL_MS,
  SANDBOX_SPAWN_INTERVAL_MS,
  SANDBOX_TILE_SIZE,
  isEntranceTile,
  sandboxTileKey,
} from './sandbox-rules';
import { SandboxColumnEntry } from './state';

/**
 * D-078 moved the street, the sandbox with it, east by the pitch square. The
 * tiles here keep D-060's numbering: `S(n)` is the street's column `n`, so the
 * square is `S(54)` to `S(81)`, and a comment's "tile 62" is `S(62)`.
 */
const S = (column: number): number => STREET_ORIGIN_X + column;

const T = SANDBOX_TILE_SIZE;
const LEFT = SANDBOX_AREA.x;
const TOP = SANDBOX_AREA.y;
/** One default server floor: actions this far apart are never throttled. */
const STEP = SANDBOX_MIN_ACTION_INTERVAL_MS;

function chebyshev(a: SandboxTile, b: SandboxTile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function centre(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * T + T / 2, y: tileY * T + T / 2 };
}

/**
 * A registry whose sandbox draws are scripted: `drop(tile, colour)` lands a
 * block exactly, given the tiles currently open (no live players nearby), and
 * `aim(tile)` scripts the next fall onto `tile` — a spawn's two draws when
 * given a colour, a returned block's one draw when not.
 */
function registryWith(options: LobbyPresenceOptions = {}): {
  registry: LobbyPresence;
  drop: (tile: SandboxTile, colour: number) => void;
  aim: (tile: SandboxTile, colour?: number) => void;
  join: (session: string, tileX: number, tileY: number) => GameId;
} {
  const draws: number[] = [];
  const registry = new LobbyPresence({
    capacity: 128,
    ...options,
    sandboxRandom: () => (draws.length > 0 ? (draws.shift() as number) : 0.5),
  });
  const aim = (tile: SandboxTile, colour?: number): void => {
    // With no live player within a tile of the target and no full stacks,
    // the open list is the whole area minus the entrance and the
    // neighbourhoods of players.
    const open: SandboxTile[] = [];
    const blocked = new Set<string>();
    registry.peers.forEach((entry) => {
      const tx = Math.floor(entry.position.x / T);
      const ty = Math.floor(entry.position.y / T);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) blocked.add(sandboxTileKey(tx + dx, ty + dy));
      }
    });
    for (let y = TOP; y < TOP + SANDBOX_AREA.height; y += 1) {
      for (let x = LEFT; x < LEFT + SANDBOX_AREA.width; x += 1) {
        if (!blocked.has(sandboxTileKey(x, y)) && !isEntranceTile(x, y)) open.push({ x, y });
      }
    }
    const index = open.findIndex((candidate) => candidate.x === tile.x && candidate.y === tile.y);
    if (index < 0) throw new Error(`tile ${tile.x},${tile.y} is not open`);
    draws.push((index + 0.5) / open.length);
    if (colour !== undefined) draws.push((colour + 0.5) / SANDBOX_COLOURS);
  };
  const drop = (tile: SandboxTile, colour: number): void => {
    aim(tile, colour);
    expect(registry.spawnBlock()).toEqual(tile);
  };
  const join = (session: string, tileX: number, tileY: number): GameId => {
    const outcome = registry.admit(session, centre(tileX, tileY));
    if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
    return outcome.gameId;
  };
  return { registry, drop, aim, join };
}

function plain(columns: readonly SandboxColumn[]): SandboxColumn[] {
  return columns.map(({ x, y, colours }) => ({ x, y, colours: [...colours] }));
}

/** The columns as the room's schema mirror holds them. */
function mirrorOf(registry: LobbyPresence): SandboxColumn[] {
  const out: SandboxColumn[] = [];
  (registry.state.sandbox as MapSchema<SandboxColumnEntry>).forEach((entry, key) => {
    expect(key).toBe(sandboxTileKey(entry.x, entry.y));
    out.push({ x: entry.x, y: entry.y, colours: [...entry.colours] });
  });
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** A client-side decoder of the room state, fed shared patches. */
function decoderFor(encoder: Encoder): { sync: () => SandboxColumn[] } {
  const decoder = Reflection.decode(Reflection.encode(encoder));
  decoder.decode(encoder.encodeAll());
  return {
    sync: () => {
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      const json = (decoder.state as { toJSON(): { sandbox?: Record<string, SandboxColumn> } }).toJSON();
      return Object.values(json.sandbox ?? {})
        .map(({ x, y, colours }) => ({ x, y, colours: [...colours] }))
        .sort((a, b) => a.y - b.y || a.x - b.x);
    },
  };
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

describe('trusted sandbox configuration', () => {
  it('defaults to the rules module timings and the documented action floors', () => {
    expect(DEFAULT_ROOM_CONFIG.sandboxSpawnIntervalMs).toBe(SANDBOX_SPAWN_INTERVAL_MS);
    expect(DEFAULT_ROOM_CONFIG.sandboxSlowSpawnIntervalMs).toBe(SANDBOX_SLOW_SPAWN_INTERVAL_MS);
    expect(DEFAULT_ROOM_CONFIG.sandboxFastSpawnLimit).toBe(SANDBOX_FAST_SPAWN_LIMIT);
    expect(DEFAULT_ROOM_CONFIG.sandboxActionIntervalMs).toBe(SANDBOX_MIN_ACTION_INTERVAL_MS);
    expect(SANDBOX_MIN_ACTION_INTERVAL_MS).toBe(150);
    // The client floor sits above the server floor, so ordinary jitter does
    // not turn a legitimate action into a silently dropped one.
    expect(SANDBOX_CLIENT_ACTION_INTERVAL_MS).toBeGreaterThan(SANDBOX_MIN_ACTION_INTERVAL_MS);
  });

  it('clamps hostile-looking sandbox overrides', () => {
    const config = resolveRoomConfig({
      sandboxSpawnIntervalMs: 0,
      sandboxSlowSpawnIntervalMs: 10 ** 12,
      sandboxFastSpawnLimit: 10 ** 9,
      sandboxActionIntervalMs: -5,
    });
    expect(config.sandboxSpawnIntervalMs).toBe(50);
    expect(config.sandboxSlowSpawnIntervalMs).toBe(3_600_000);
    expect(config.sandboxFastSpawnLimit).toBe(SANDBOX_MAX_BLOCKS);
    // Never off, and never above the client's own floor.
    expect(config.sandboxActionIntervalMs).toBe(50);
    expect(resolveRoomConfig({ sandboxActionIntervalMs: 10 ** 9 }).sandboxActionIntervalMs).toBe(
      SANDBOX_CLIENT_ACTION_INTERVAL_MS,
    );
    expect(resolveRoomConfig({ sandboxActionIntervalMs: 0 }).sandboxActionIntervalMs).toBe(50);
    const junk = resolveRoomConfig({
      sandboxSpawnIntervalMs: Number.NaN,
      sandboxFastSpawnLimit: '7' as never,
    });
    expect(junk.sandboxSpawnIntervalMs).toBe(SANDBOX_SPAWN_INTERVAL_MS);
    expect(junk.sandboxFastSpawnLimit).toBe(SANDBOX_FAST_SPAWN_LIMIT);
  });
});

describe('the schema mirror', () => {
  it('adds, grows, shrinks and deletes columns exactly as the authority does', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 2);
    drop({ x: S(60), y: 10 }, 5);
    expect(mirrorOf(registry)).toEqual([{ x: S(60), y: 10, colours: [2, 5] }]);

    join('a', S(61), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');
    expect(mirrorOf(registry)).toEqual([{ x: S(60), y: 10, colours: [2] }]);
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, STEP)).toBe('applied');
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 2 * STEP)).toBe('applied');
    expect(mirrorOf(registry)).toEqual([{ x: S(62), y: 10, colours: [5] }]);
    expect(mirrorOf(registry)).toEqual(plain(registry.sandboxColumns()));
  });

  it('reaches a real decoder intact, including a take and a put on one stack in one patch', () => {
    const { registry, drop, join } = registryWith();
    const encoder = new Encoder(registry.state);
    const client = decoderFor(encoder);
    drop({ x: S(60), y: 10 }, 1);
    drop({ x: S(60), y: 10 }, 2);
    drop({ x: S(64), y: 10 }, 3);
    expect(client.sync()).toEqual(plain(registry.sandboxColumns()));

    join('a', S(61), 10);
    join('b', S(59), 10);
    join('c', S(63), 10);
    expect(registry.pickBlock('c', { x: S(64), y: 10 }, 0)).toBe('applied');
    expect(client.sync()).toEqual(plain(registry.sandboxColumns()));
    // One patch: the stack is emptied, its entry deleted, and rebuilt reversed.
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, STEP)).toBe('applied');
    expect(registry.pickBlock('b', { x: S(60), y: 10 }, STEP)).toBe('applied');
    expect(registry.placeBlock('a', { x: S(60), y: 10 }, 2 * STEP)).toBe('applied');
    expect(registry.placeBlock('b', { x: S(60), y: 10 }, 2 * STEP)).toBe('applied');
    expect(registry.sandboxColumns()).toEqual([{ x: S(60), y: 10, colours: [2, 1] }]);
    expect(client.sync()).toEqual([{ x: S(60), y: 10, colours: [2, 1] }]);
  });

  // Thousands of seeded operations: about 2.5 s alone and slower under a full
  // parallel run, so it gets more than vitest's 5 s default.
  it('stays equal to the authority through a long seeded sequence', () => {
    const registry = new LobbyPresence({
      capacity: 8,
      minUpdateIntervalMs: 0,
      sandboxActionIntervalMs: 50,
      sandboxRandom: mulberry32(1),
    });
    const encoder = new Encoder(registry.state);
    const client = decoderFor(encoder);
    const random = mulberry32(2);
    const sessions = ['a', 'b', 'c', 'd'];
    for (const session of sessions) registry.admit(session, centre(LEFT + 2, TOP + 2));
    for (let step = 0; step < 2500; step += 1) {
      const now = step * 20;
      const session = sessions[Math.floor(random() * sessions.length)] as string;
      const tile = {
        x: LEFT + Math.floor(random() * 5),
        y: TOP + Math.floor(random() * 5),
      };
      switch (Math.floor(random() * 5)) {
        case 0:
          registry.spawnBlock();
          break;
        case 1:
          registry.pickBlock(session, tile, now);
          break;
        case 2:
          registry.placeBlock(session, tile, now);
          break;
        case 3: {
          const spot = centre(LEFT + Math.floor(random() * 5), TOP + Math.floor(random() * 5));
          registry.move(session, spot, now);
          break;
        }
        default:
          if (random() < 0.5) registry.suspend(session);
          else registry.resume(session, centre(LEFT + 2, TOP + 2), now);
          break;
      }
      expect(mirrorOf(registry)).toEqual(plain(registry.sandboxColumns()));
      if (step % 10 === 0) {
        expect(client.sync(), `decoded mirror at step ${step}`).toEqual(
          plain(registry.sandboxColumns()),
        );
      }
    }
    expect(registry.sandboxColumns().length).toBeGreaterThan(0);
  }, 60_000);

  it('clears a mirror handed over non-empty, since the authority starts empty', () => {
    const mirror = new MapSchema<SandboxColumnEntry>();
    const stale = new SandboxColumnEntry();
    stale.x = S(60);
    stale.y = 10;
    stale.colours.push(1);
    mirror.set(`${S(60)},10`, stale);
    const sandbox = new LobbySandbox(mirror);
    expect(mirror.size).toBe(0);
    expect(sandbox.columns()).toEqual([]);
  });
});

describe('pick and place through the registry', () => {
  it('acts from the position the registry holds and writes carrying from the authority', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    const id = join('a', S(61), 10);
    // Position fields in the payload are not the actor's position; only the
    // tile is read.
    expect(
      registry.pickBlock('a', { x: S(60), y: 10, px: 0, py: 0, carrying: 3, gameId: 'x' }, 0),
    ).toBe('applied');
    expect(registry.peers.get(id)?.carrying).toBe(6);
    expect(registry.sandboxCarrying('a')).toBe(6);

    expect(registry.placeBlock('a', { x: S(61), y: 11 }, STEP)).toBe('applied');
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(registry.sandboxColumns()).toEqual([{ x: S(61), y: 11, colours: [6] }]);
  });

  it('starts every entry empty-handed', () => {
    const { registry, join } = registryWith();
    const id = join('a', S(61), 10);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
  });

  it('refuses malformed payloads silently without consuming the floor', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    const id = join('a', S(61), 10);
    const hostile: unknown[] = [
      undefined,
      null,
      'sandbox',
      42,
      [S(60), 10],
      {},
      { x: S(60) },
      { x: S(60) + 0.5, y: 10 },
      { x: Number.NaN, y: 10 },
      { x: S(60), y: Number.NEGATIVE_INFINITY },
      { x: String(S(60)), y: '10' },
      { x: LEFT - 1, y: 10 },
      { x: S(60), y: TOP + SANDBOX_AREA.height },
      Object.create({ x: S(60), y: 10 }),
      Object.defineProperty({ y: 10 }, 'x', { get: () => S(60), enumerable: true }),
      new Proxy({}, {
        getOwnPropertyDescriptor: () => {
          throw new Error('hostile trap');
        },
      }),
    ];
    for (const payload of hostile) {
      expect(registry.pickBlock('a', payload, 0)).toBe('malformed');
    }
    expect(registry.sandboxColumns()).toEqual([{ x: S(60), y: 10, colours: [6] }]);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    // None of that consumed the floor: a real request at the same instant lands.
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');
  });

  it('refuses a session that is unknown or suspended', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    expect(registry.pickBlock('ghost', { x: S(60), y: 10 }, 0)).toBe('absent');
    join('a', S(61), 10);
    registry.suspend('a');
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('absent');
    expect(registry.placeBlock('a', { x: S(60), y: 10 }, 0)).toBe('absent');
    expect(registry.sandboxColumns()).toEqual([{ x: S(60), y: 10, colours: [6] }]);
  });

  it('refuses out-of-reach requests without changing anything', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    const id = join('a', S(63), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('rejected');
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, STEP)).toBe('rejected');
    expect(registry.sandboxColumns()).toEqual([{ x: S(60), y: 10, colours: [6] }]);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
  });

  it('will not put a block under another live player, but ignores a suspended one', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    join('a', S(61), 10);
    join('b', S(62), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, STEP)).toBe('rejected');
    registry.suspend('b');
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, 2 * STEP)).toBe('applied');
  });

  it('will not take a block from under another live player, but ignores a suspended one', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    join('a', S(61), 10);
    join('b', S(60), 10); // standing on the stack
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('rejected');
    expect(registry.sandboxColumns()).toEqual([{ x: S(60), y: 10, colours: [6] }]);
    registry.suspend('b');
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, STEP)).toBe('applied');
  });
});

describe('the sandbox action floor', () => {
  it('drops a second action inside the floor and accepts one after it', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    join('a', S(61), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 1000)).toBe('applied');
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, 1000 + SANDBOX_MIN_ACTION_INTERVAL_MS - 1)).toBe(
      'throttled',
    );
    expect(registry.sandboxCarrying('a')).toBe(6);
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, 1000 + SANDBOX_MIN_ACTION_INTERVAL_MS)).toBe(
      'applied',
    );
  });

  it('charges a rule-refused action against the floor', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 6);
    join('a', S(61), 10);
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, 0)).toBe('rejected');
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 10)).toBe('throttled');
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, SANDBOX_MIN_ACTION_INTERVAL_MS)).toBe('applied');
  });

  it('floors each session independently', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 1);
    drop({ x: S(66), y: 10 }, 2);
    join('a', S(61), 10);
    join('b', S(65), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');
    expect(registry.pickBlock('b', { x: S(66), y: 10 }, 0)).toBe('applied');
  });

  it('keeps the floor across suspend and resume, and forgets it on leave', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: S(60), y: 10 }, 1);
    drop({ x: S(60), y: 10 }, 2);
    join('a', S(61), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');
    registry.suspend('a');
    expect(registry.resume('a', centre(S(61), 10), 1)).toBe(true);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 2)).toBe('throttled');
    registry.release('a');
    join('a', S(61), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 3)).toBe('applied');
  });
});

describe('a carried block goes back to the sky (conservation)', () => {
  it('falls away from where its carrier stood on suspend, and resume starts empty-handed', () => {
    const drops: SandboxTile[] = [];
    const { registry, drop, join } = registryWith({ onSandboxDrop: (tile) => drops.push(tile) });
    drop({ x: S(60), y: 10 }, 6);
    drops.length = 0;
    const id = join('a', S(61), 10);
    join('b', S(70), 20);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');
    expect(registry.sandboxColumns()).toEqual([]);

    expect(registry.suspend('a')).toBe(true);

    expect(registry.sandboxBlocks).toBe(1);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(drops).toHaveLength(1);
    const landed = drops[0] as SandboxTile;
    expect(Object.keys(landed).sort()).toEqual(['x', 'y']);
    expect(registry.sandboxColumns()).toEqual([{ x: landed.x, y: landed.y, colours: [6] }]);
    expect(chebyshev(landed, { x: S(61), y: 10 })).toBeGreaterThan(1);
    expect(chebyshev(landed, { x: S(70), y: 20 })).toBeGreaterThan(1);
    expect(mirrorOf(registry)).toEqual(plain(registry.sandboxColumns()));

    expect(registry.resume('a', centre(S(61), 10), 1)).toBe(true);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    expect(registry.placeBlock('a', { x: S(62), y: 10 }, STEP)).toBe('rejected');
  });

  it('falls away from where its carrier stood on leave', () => {
    const drops: SandboxTile[] = [];
    const { registry, drop, join } = registryWith({ onSandboxDrop: (tile) => drops.push(tile) });
    drop({ x: S(60), y: 10 }, 6);
    drop({ x: S(64), y: 10 }, 7);
    drops.length = 0;
    join('a', S(61), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');

    registry.release('a');

    expect(registry.sandboxBlocks).toBe(2);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(drops).toHaveLength(1);
    const landed = drops[0] as SandboxTile;
    expect(chebyshev(landed, { x: S(61), y: 10 })).toBeGreaterThan(1);
    const columns = registry.sandboxColumns();
    expect(columns).toContainEqual({ x: S(64), y: 10, colours: [7] });
    expect(columns.find((column) => column.x === landed.x && column.y === landed.y)?.colours.at(-1)).toBe(6);
  });

  it('is discarded only when no tile is allowed, and then nothing is announced', () => {
    const drops: SandboxTile[] = [];
    const { registry, drop } = registryWith({ onSandboxDrop: (tile) => drops.push(tile) });
    drop({ x: S(60), y: 10 }, 6);
    drops.length = 0;
    const xs = [55, 58, 61, 64, 67, 70, 73, 76, 79, 81].map(S);
    const ys = [1, 4, 7, 10, 13, 16, 19, 22, 25, 27];
    for (const y of ys) for (const x of xs) expect(registry.admit(`p${x},${y}`, centre(x, y)).ok).toBe(true);
    // p61,10 stands beside the block; the grid leaves no tile to fall onto.
    expect(registry.pickBlock(`p${S(61)},10`, { x: S(60), y: 10 }, 0)).toBe('applied');

    registry.suspend(`p${S(61)},10`);

    expect(registry.sandboxBlocks).toBe(0);
    expect(registry.sandboxColumns()).toEqual([]);
    expect(drops).toEqual([]);
  });

  it('announces every sky drop — spawns included — as a tile alone', () => {
    const drops: SandboxTile[] = [];
    const registry = new LobbyPresence({ sandboxRandom: mulberry32(9), onSandboxDrop: (tile) => drops.push(tile) });
    const spawned = registry.spawnBlock();
    expect(spawned).not.toBeNull();
    expect(drops).toEqual([spawned]);
    expect(Object.keys(drops[0] as object).sort()).toEqual(['x', 'y']);
  });

  it('keeps every block through a pick, suspend and resume loop at production floors', () => {
    // The reviewer's exploit: carry a block into a building and back, forever.
    const registry = new LobbyPresence({ capacity: 48, sandboxRandom: mulberry32(77) });
    while (registry.spawnBlock() !== null) {
      // fill to the cap with nobody on the street
    }
    expect(registry.sandboxBlocks).toBe(SANDBOX_MAX_BLOCKS);
    const sessions = ['g0', 'g1', 'g2'];
    for (const session of sessions) expect(registry.admit(session, { x: 0, y: 0 }).ok).toBe(true);
    let now = 1000;
    let cycles = 0;
    for (let round = 0; round < 200; round += 1) {
      for (const session of sessions) {
        const columns = registry.sandboxColumns();
        const heights = new Map(columns.map((column) => [sandboxTileKey(column.x, column.y), column.colours.length]));
        const level = (x: number, y: number): number => heights.get(sandboxTileKey(x, y)) ?? 0;
        const column = columns[(round * sessions.length + sessions.indexOf(session)) % columns.length];
        if (column === undefined) continue;
        const top = column.colours.length;
        const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => ({ x: column.x + (dx as number), y: column.y + (dy as number) }))
          .find((tile) => tile.x >= LEFT && tile.x < LEFT + SANDBOX_AREA.width && tile.y >= TOP &&
            tile.y < TOP + SANDBOX_AREA.height && top >= level(tile.x, tile.y) - 1 && top <= level(tile.x, tile.y) + 2);
        if (spot === undefined) continue;
        registry.move(session, centre(spot.x, spot.y), now);
        if (registry.pickBlock(session, { x: column.x, y: column.y }, now) === 'applied') {
          registry.suspend(session);
          registry.resume(session, { x: 0, y: 0 }, now);
          cycles += 1;
        }
      }
      now += STEP;
    }
    expect(cycles).toBeGreaterThan(100);
    expect(registry.sandboxBlocks).toBe(SANDBOX_MAX_BLOCKS);
    const onBoard = registry.sandboxColumns().reduce((sum, column) => sum + column.colours.length, 0);
    expect(onBoard).toBe(SANDBOX_MAX_BLOCKS);
    expect(mirrorOf(registry)).toEqual(plain(registry.sandboxColumns()));
  });
});

describe('a pillar taller than SANDBOX_BURST_HEIGHT bursts the sandbox (D-071)', () => {
  interface Heard {
    readonly tile: SandboxTile;
    /** Mirrored columns and blocks left when the burst was announced. */
    readonly mirrored: number;
    readonly blocks: number;
  }

  /** A registry that records bursts and drops, with what state held at each burst. */
  function listening() {
    const drops: SandboxTile[] = [];
    const bursts: Heard[] = [];
    const rig: ReturnType<typeof registryWith> = registryWith({
      onSandboxDrop: (tile) => drops.push(tile),
      onSandboxBurst: (tile) =>
        bursts.push({ tile, mirrored: rig.registry.state.sandbox.size, blocks: rig.registry.sandboxBlocks }),
    });
    const pillar = (tile: SandboxTile, height = SANDBOX_BURST_HEIGHT): void => {
      for (let n = 0; n < height; n += 1) rig.drop(tile, n % SANDBOX_COLOURS);
    };
    return { ...rig, drops, bursts, pillar };
  }

  it('announces a sky drop onto a full column as a burst, a tile alone, once the mirror is empty', () => {
    const { registry, drop, aim, drops, bursts, pillar } = listening();
    pillar({ x: S(60), y: 10 });
    drop({ x: S(70), y: 20 }, 4);
    drops.length = 0;

    aim({ x: S(60), y: 10 }, 0);
    expect(registry.spawnBlock()).toBeNull();

    expect(bursts).toEqual([{ tile: { x: S(60), y: 10 }, mirrored: 0, blocks: 0 }]);
    expect(Object.keys(bursts[0]!.tile).sort()).toEqual(['x', 'y']);
    expect(drops).toEqual([]);
    expect(registry.sandboxColumns()).toEqual([]);
    expect(mirrorOf(registry)).toEqual([]);
  });

  it('bursts on a place: the placer ends empty-handed, and a peer keeps the block they carry', () => {
    const { registry, drop, join, bursts, pillar } = listening();
    pillar({ x: S(61), y: 11 }, SANDBOX_BURST_HEIGHT - 1); // where 'a' stands: level 13
    pillar({ x: S(62), y: 11 }); // the full column beside it
    pillar({ x: S(61), y: 10 }, SANDBOX_BURST_HEIGHT - 1); // a supply stack in reach
    drop({ x: S(72), y: 20 }, 3);
    const a = join('a', S(61), 11);
    const b = join('b', S(73), 20);
    expect(registry.pickBlock('b', { x: S(72), y: 20 }, 0)).toBe('applied');
    expect(registry.pickBlock('a', { x: S(61), y: 10 }, 0)).toBe('applied');

    expect(registry.placeBlock('a', { x: S(62), y: 11 }, STEP)).toBe('applied');

    expect(bursts).toEqual([{ tile: { x: S(62), y: 11 }, mirrored: 0, blocks: 1 }]);
    expect(registry.sandboxColumns()).toEqual([]);
    expect(mirrorOf(registry)).toEqual([]);
    expect(registry.peers.get(a)?.carrying).toBe(-1);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(registry.peers.get(b)?.carrying).toBe(3);
    expect(registry.sandboxBlocks).toBe(1);
  });

  it('bursts when a carrier suspends and their block falls onto a full column, and announces no drop', () => {
    const { registry, drop, aim, join, drops, bursts, pillar } = listening();
    drop({ x: S(60), y: 10 }, 6);
    pillar({ x: S(70), y: 5 });
    drops.length = 0;
    join('a', S(61), 10);
    expect(registry.pickBlock('a', { x: S(60), y: 10 }, 0)).toBe('applied');

    aim({ x: S(70), y: 5 });
    expect(registry.suspend('a')).toBe(true);

    expect(bursts).toEqual([{ tile: { x: S(70), y: 5 }, mirrored: 0, blocks: 0 }]);
    expect(drops).toEqual([]);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(registry.sandboxColumns()).toEqual([]);
  });

  it('reaches a real decoder as an empty board, with a block landing in the same patch, and a late joiner agrees', () => {
    const { registry, drop, aim, pillar } = listening();
    const encoder = new Encoder(registry.state);
    const client = decoderFor(encoder);
    pillar({ x: S(60), y: 10 });
    drop({ x: S(64), y: 10 }, 3);
    expect(client.sync()).toEqual(plain(registry.sandboxColumns()));

    // One patch: the burst, then blocks landing where the pillar stood and beside it.
    aim({ x: S(60), y: 10 }, 0);
    expect(registry.spawnBlock()).toBeNull();
    drop({ x: S(60), y: 10 }, 5);
    drop({ x: S(64), y: 10 }, 6);
    const after = [
      { x: S(60), y: 10, colours: [5] },
      { x: S(64), y: 10, colours: [6] },
    ];
    expect(plain(registry.sandboxColumns())).toEqual(after);
    expect(client.sync()).toEqual(after);
    expect(decoderFor(encoder).sync()).toEqual(after);
  });

  // Hundreds of seeded drops into one corner, so the corner bursts again and again.
  it('keeps the mirror equal to the authority through repeated bursts', () => {
    const bursts: SandboxTile[] = [];
    const registry = new LobbyPresence({
      capacity: 128,
      sandboxRandom: mulberry32(71),
      onSandboxBurst: (tile) => bursts.push(tile),
    });
    const encoder = new Encoder(registry.state);
    const client = decoderFor(encoder);
    // Players everywhere but the 3x3 corner around (55, 1): the rain piles up there.
    const xs = [55, 58, 61, 64, 67, 70, 73, 76, 79, 81].map(S);
    const ys = [1, 4, 7, 10, 13, 16, 19, 22, 25, 27];
    for (const y of ys) {
      for (const x of xs) {
        if (x === S(55) && y === 1) continue;
        expect(registry.admit(`p${x},${y}`, centre(x, y)).ok).toBe(true);
      }
    }
    for (let step = 0; step < 400; step += 1) {
      registry.spawnBlock();
      expect(mirrorOf(registry)).toEqual(plain(registry.sandboxColumns()));
      for (const column of registry.sandboxColumns()) {
        expect(column.colours.length).toBeLessThanOrEqual(SANDBOX_BURST_HEIGHT);
      }
      if (step % 7 === 0) expect(client.sync(), `decoded at step ${step}`).toEqual(plain(registry.sandboxColumns()));
    }
    expect(bursts.length).toBeGreaterThan(2);
    expect(client.sync()).toEqual(plain(registry.sandboxColumns()));
  });
});

describe('the spawner inputs', () => {
  it('never drops within a tile of a live player, but ignores suspended ones', () => {
    const { registry } = registryWith();
    const xs = [55, 58, 61, 64, 67, 70, 73, 76, 79, 81].map(S);
    const ys = [1, 4, 7, 10, 13, 16, 19, 22, 25, 27];
    for (const y of ys) {
      for (const x of xs) {
        const outcome = registry.admit(`p${x},${y}`, centre(x, y));
        expect(outcome.ok).toBe(true);
      }
    }
    expect(registry.spawnBlock()).toBeNull();
    registry.suspend(`p${S(55)},1`);
    // The constant draw lands every drop on one tile, which holds
    // SANDBOX_BURST_HEIGHT blocks before the next one would burst it (D-071).
    for (let n = 0; n < SANDBOX_BURST_HEIGHT; n += 1) {
      const tile = registry.spawnBlock() as SandboxTile;
      expect(tile).not.toBeNull();
      expect(tile.x).toBeGreaterThanOrEqual(LEFT);
      expect(tile.x).toBeLessThanOrEqual(LEFT + 2);
      expect(tile.y).toBeGreaterThanOrEqual(TOP);
      expect(tile.y).toBeLessThanOrEqual(TOP + 2);
    }
  });

  it('knows whether anyone is on the street', () => {
    const { registry, join } = registryWith();
    expect(registry.hasLivePlayers).toBe(false);
    join('a', 1, 1);
    expect(registry.hasLivePlayers).toBe(true);
    registry.suspend('a');
    expect(registry.hasLivePlayers).toBe(false);
    registry.resume('a', centre(1, 1), 0);
    expect(registry.hasLivePlayers).toBe(true);
    registry.release('a');
    expect(registry.hasLivePlayers).toBe(false);
  });

  it('paces drops fast until the configured limit, then slow', () => {
    const registry = new LobbyPresence({
      sandboxSpawnIntervalMs: 100,
      sandboxSlowSpawnIntervalMs: 900,
      sandboxFastSpawnLimit: 3,
      sandboxRandom: mulberry32(4),
    });
    const delays: number[] = [];
    for (let n = 0; n < 5; n += 1) {
      delays.push(registry.nextSpawnDelayMs());
      registry.spawnBlock();
    }
    expect(delays).toEqual([100, 100, 100, 900, 900]);
    expect(new LobbyPresence().nextSpawnDelayMs()).toBe(SANDBOX_SPAWN_INTERVAL_MS);
  });
});
