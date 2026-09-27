/**
 * The room's sandbox half without a transport: the registry's pick/place
 * wiring, the action floor, suspend/leave discards, spawn avoidance, and the
 * schema mirror a real client decodes.
 */

import { Encoder, MapSchema, Reflection } from '@colyseus/schema';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_AREA,
  SANDBOX_COLOURS,
  SANDBOX_MAX_BLOCKS,
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
  sandboxTileKey,
} from './sandbox-rules';
import { SandboxColumnEntry } from './state';

const T = SANDBOX_TILE_SIZE;
const LEFT = SANDBOX_AREA.x;
const TOP = SANDBOX_AREA.y;

function centre(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * T + T / 2, y: tileY * T + T / 2 };
}

/**
 * A registry whose sandbox draws are scripted: `drop(tile, colour)` lands a
 * block exactly, given the tiles currently open (no live players nearby).
 */
function registryWith(options: LobbyPresenceOptions = {}): {
  registry: LobbyPresence;
  drop: (tile: SandboxTile, colour: number) => void;
  join: (session: string, tileX: number, tileY: number) => GameId;
} {
  const draws: number[] = [];
  const registry = new LobbyPresence({
    capacity: 128,
    ...options,
    sandboxRandom: () => (draws.length > 0 ? (draws.shift() as number) : 0.5),
  });
  const drop = (tile: SandboxTile, colour: number): void => {
    // With no live player within a tile of the target and no full stacks,
    // the open list is the whole area minus the neighbourhoods of players.
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
        if (!blocked.has(sandboxTileKey(x, y))) open.push({ x, y });
      }
    }
    const index = open.findIndex((candidate) => candidate.x === tile.x && candidate.y === tile.y);
    if (index < 0) throw new Error(`tile ${tile.x},${tile.y} is not open`);
    draws.push((index + 0.5) / open.length, (colour + 0.5) / SANDBOX_COLOURS);
    expect(registry.spawnBlock()).toEqual(tile);
  };
  const join = (session: string, tileX: number, tileY: number): GameId => {
    const outcome = registry.admit(session, centre(tileX, tileY));
    if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
    return outcome.gameId;
  };
  return { registry, drop, join };
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
    expect(config.sandboxActionIntervalMs).toBe(0);
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
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    drop({ x: 60, y: 10 }, 2);
    drop({ x: 60, y: 10 }, 5);
    expect(mirrorOf(registry)).toEqual([{ x: 60, y: 10, colours: [2, 5] }]);

    join('a', 61, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    expect(mirrorOf(registry)).toEqual([{ x: 60, y: 10, colours: [2] }]);
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 0)).toBe('applied');
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    expect(mirrorOf(registry)).toEqual([{ x: 62, y: 10, colours: [5] }]);
    expect(mirrorOf(registry)).toEqual(plain(registry.sandboxColumns()));
  });

  it('reaches a real decoder intact, including a take and a put on one stack in one patch', () => {
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    const encoder = new Encoder(registry.state);
    const client = decoderFor(encoder);
    drop({ x: 60, y: 10 }, 1);
    drop({ x: 60, y: 10 }, 2);
    drop({ x: 64, y: 10 }, 3);
    expect(client.sync()).toEqual(plain(registry.sandboxColumns()));

    join('a', 61, 10);
    join('b', 59, 10);
    join('c', 63, 10);
    expect(registry.pickBlock('c', { x: 64, y: 10 }, 0)).toBe('applied');
    expect(client.sync()).toEqual(plain(registry.sandboxColumns()));
    // One patch: the stack is emptied, its entry deleted, and rebuilt reversed.
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 1)).toBe('applied');
    expect(registry.pickBlock('b', { x: 60, y: 10 }, 1)).toBe('applied');
    expect(registry.placeBlock('a', { x: 60, y: 10 }, 2)).toBe('applied');
    expect(registry.placeBlock('b', { x: 60, y: 10 }, 2)).toBe('applied');
    expect(registry.sandboxColumns()).toEqual([{ x: 60, y: 10, colours: [2, 1] }]);
    expect(client.sync()).toEqual([{ x: 60, y: 10, colours: [2, 1] }]);
  });

  it('stays equal to the authority through a long seeded sequence', () => {
    const registry = new LobbyPresence({
      capacity: 8,
      minUpdateIntervalMs: 0,
      sandboxActionIntervalMs: 0,
      sandboxRandom: mulberry32(1),
    });
    const encoder = new Encoder(registry.state);
    const client = decoderFor(encoder);
    const random = mulberry32(2);
    const sessions = ['a', 'b', 'c', 'd'];
    for (const session of sessions) registry.admit(session, centre(LEFT + 2, TOP + 2));
    for (let step = 0; step < 2500; step += 1) {
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
          registry.pickBlock(session, tile, step);
          break;
        case 2:
          registry.placeBlock(session, tile, step);
          break;
        case 3: {
          const spot = centre(LEFT + Math.floor(random() * 5), TOP + Math.floor(random() * 5));
          registry.move(session, spot, step);
          break;
        }
        default:
          if (random() < 0.5) registry.suspend(session);
          else registry.resume(session, centre(LEFT + 2, TOP + 2), step);
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
  });

  it('clears a mirror handed over non-empty, since the authority starts empty', () => {
    const mirror = new MapSchema<SandboxColumnEntry>();
    const stale = new SandboxColumnEntry();
    stale.x = 60;
    stale.y = 10;
    stale.colours.push(1);
    mirror.set('60,10', stale);
    const sandbox = new LobbySandbox(mirror);
    expect(mirror.size).toBe(0);
    expect(sandbox.columns()).toEqual([]);
  });
});

describe('pick and place through the registry', () => {
  it('acts from the position the registry holds and writes carrying from the authority', () => {
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    drop({ x: 60, y: 10 }, 6);
    const id = join('a', 61, 10);
    // Position fields in the payload are not the actor's position; only the
    // tile is read.
    expect(
      registry.pickBlock('a', { x: 60, y: 10, px: 0, py: 0, carrying: 3, gameId: 'x' }, 0),
    ).toBe('applied');
    expect(registry.peers.get(id)?.carrying).toBe(6);
    expect(registry.sandboxCarrying('a')).toBe(6);

    expect(registry.placeBlock('a', { x: 61, y: 11 }, 0)).toBe('applied');
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(registry.sandboxColumns()).toEqual([{ x: 61, y: 11, colours: [6] }]);
  });

  it('starts every entry empty-handed', () => {
    const { registry, join } = registryWith();
    const id = join('a', 61, 10);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
  });

  it('refuses malformed payloads silently without consuming the floor', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: 60, y: 10 }, 6);
    const id = join('a', 61, 10);
    const hostile: unknown[] = [
      undefined,
      null,
      'sandbox',
      42,
      [60, 10],
      {},
      { x: 60 },
      { x: 60.5, y: 10 },
      { x: Number.NaN, y: 10 },
      { x: 60, y: Number.NEGATIVE_INFINITY },
      { x: '60', y: '10' },
      { x: LEFT - 1, y: 10 },
      { x: 60, y: TOP + SANDBOX_AREA.height },
      Object.create({ x: 60, y: 10 }),
      Object.defineProperty({ y: 10 }, 'x', { get: () => 60, enumerable: true }),
      new Proxy({}, {
        getOwnPropertyDescriptor: () => {
          throw new Error('hostile trap');
        },
      }),
    ];
    for (const payload of hostile) {
      expect(registry.pickBlock('a', payload, 0)).toBe('malformed');
    }
    expect(registry.sandboxColumns()).toEqual([{ x: 60, y: 10, colours: [6] }]);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    // None of that consumed the floor: a real request at the same instant lands.
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
  });

  it('refuses a session that is unknown or suspended', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: 60, y: 10 }, 6);
    expect(registry.pickBlock('ghost', { x: 60, y: 10 }, 0)).toBe('absent');
    join('a', 61, 10);
    registry.suspend('a');
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('absent');
    expect(registry.placeBlock('a', { x: 60, y: 10 }, 0)).toBe('absent');
    expect(registry.sandboxColumns()).toEqual([{ x: 60, y: 10, colours: [6] }]);
  });

  it('refuses out-of-reach requests without changing anything', () => {
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    drop({ x: 60, y: 10 }, 6);
    const id = join('a', 63, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('rejected');
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 0)).toBe('rejected');
    expect(registry.sandboxColumns()).toEqual([{ x: 60, y: 10, colours: [6] }]);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
  });

  it('will not put a block under another live player, but ignores a suspended one', () => {
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    drop({ x: 60, y: 10 }, 6);
    join('a', 61, 10);
    join('b', 62, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 0)).toBe('rejected');
    registry.suspend('b');
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 0)).toBe('applied');
  });
});

describe('the sandbox action floor', () => {
  it('drops a second action inside the floor and accepts one after it', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: 60, y: 10 }, 6);
    join('a', 61, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 1000)).toBe('applied');
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 1000 + SANDBOX_MIN_ACTION_INTERVAL_MS - 1)).toBe(
      'throttled',
    );
    expect(registry.sandboxCarrying('a')).toBe(6);
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 1000 + SANDBOX_MIN_ACTION_INTERVAL_MS)).toBe(
      'applied',
    );
  });

  it('charges a rule-refused action against the floor', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: 60, y: 10 }, 6);
    join('a', 61, 10);
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 0)).toBe('rejected');
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 10)).toBe('throttled');
    expect(registry.pickBlock('a', { x: 60, y: 10 }, SANDBOX_MIN_ACTION_INTERVAL_MS)).toBe('applied');
  });

  it('floors each session independently', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: 60, y: 10 }, 1);
    drop({ x: 66, y: 10 }, 2);
    join('a', 61, 10);
    join('b', 65, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    expect(registry.pickBlock('b', { x: 66, y: 10 }, 0)).toBe('applied');
  });

  it('keeps the floor across suspend and resume, and forgets it on leave', () => {
    const { registry, drop, join } = registryWith();
    drop({ x: 60, y: 10 }, 1);
    drop({ x: 60, y: 10 }, 2);
    join('a', 61, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    registry.suspend('a');
    expect(registry.resume('a', centre(61, 10), 1)).toBe(true);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 2)).toBe('throttled');
    registry.release('a');
    join('a', 61, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 3)).toBe('applied');
  });
});

describe('a carried block leaves with its carrier', () => {
  it('is discarded on suspend, and resume starts empty-handed', () => {
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    drop({ x: 60, y: 10 }, 6);
    const id = join('a', 61, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    expect(registry.sandboxBlocks).toBe(1);
    registry.suspend('a');
    expect(registry.sandboxBlocks).toBe(0);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(registry.resume('a', centre(61, 10), 1)).toBe(true);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    expect(registry.placeBlock('a', { x: 62, y: 10 }, 2)).toBe('rejected');
    expect(registry.sandboxColumns()).toEqual([]);
  });

  it('is discarded on leave', () => {
    const { registry, drop, join } = registryWith({ sandboxActionIntervalMs: 0 });
    drop({ x: 60, y: 10 }, 6);
    drop({ x: 64, y: 10 }, 7);
    join('a', 61, 10);
    expect(registry.pickBlock('a', { x: 60, y: 10 }, 0)).toBe('applied');
    registry.release('a');
    expect(registry.sandboxBlocks).toBe(1);
    expect(registry.sandboxCarrying('a')).toBeNull();
    expect(registry.sandboxColumns()).toEqual([{ x: 64, y: 10, colours: [7] }]);
  });
});

describe('the spawner inputs', () => {
  it('never drops within a tile of a live player, but ignores suspended ones', () => {
    const { registry } = registryWith();
    const xs = [55, 58, 61, 64, 67, 70, 73, 76, 79, 81];
    const ys = [1, 4, 7, 10, 13, 16, 19, 22, 25, 27];
    for (const y of ys) {
      for (const x of xs) {
        const outcome = registry.admit(`p${x},${y}`, centre(x, y));
        expect(outcome.ok).toBe(true);
      }
    }
    expect(registry.spawnBlock()).toBeNull();
    registry.suspend('p55,1');
    for (let n = 0; n < 20; n += 1) {
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
