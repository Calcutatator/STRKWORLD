/**
 * The tests this lane exists for.
 *
 * Everything else in the package can be rewritten. These properties cannot
 * change without a decision entry:
 *
 *   1. The room schema's field set is exactly the frozen `PresenceState`.
 *   2. A client cannot set the room's configuration — the attacker-config
 *      break that reached production (a hostile `spriteKeys`/`defaultSprite`
 *      allowlist putting a hex id and token amount on other players' screens).
 *   3. Suspending takes a player out of every other observer's view.
 *   4. No sequence of client input puts a financial-looking string into room
 *      state or onto the wire.
 *   5. The block sandbox (D-060) is anonymous: no column, drop or sandbox
 *      patch names a player.
 *
 * The vocabulary they scan for lives in `testing/forbidden-vocabulary.json`
 * rather than in this file, because check 5 of `scripts/check-invariants.sh`
 * fails the build on those words appearing in any lobby `.ts` file — see the
 * `why` note inside the fixture.
 */

import type { Client } from '@colyseus/core';
import { Encoder, Metadata, Reflection } from '@colyseus/schema';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_AREA,
  type GameId,
  type Position,
  type PresenceState,
  type SandboxColumn,
  type SandboxTile,
} from '@strkworld/shared';
import {
  DEFAULT_ROOM_CONFIG,
  SANDBOX_MIN_ACTION_INTERVAL_MS,
  resolveRoomConfig,
  type PresenceRoomConfig,
} from './config';
import { LobbyPresence } from './presence';
import { PresenceRoom, definePresenceRoom } from './room';
import {
  LobbyState,
  PositionSchema,
  PresenceEntry,
  SandboxColumnEntry,
} from './state';
import vocabulary from './testing/forbidden-vocabulary.json';

/**
 * The frozen field set, written out as a value.
 *
 * `Record<keyof PresenceState, true>` makes this a compile-time assertion as
 * well as a runtime one: adding a field to the frozen seam without adding it
 * here fails the typecheck, and adding one here that the seam does not have
 * fails it too.
 */
const FROZEN_PRESENCE_FIELDS: Record<keyof PresenceState, true> = {
  gameId: true,
  position: true,
  facing: true,
  sprite: true,
  carrying: true,
};

const FROZEN_POSITION_FIELDS: Record<keyof Position, true> = {
  x: true,
  y: true,
};

/** D-060's column shape, with the same compile-time pinning. */
const FROZEN_SANDBOX_COLUMN_FIELDS: Record<keyof SandboxColumn, true> = {
  x: true,
  y: true,
  colours: true,
};

function fieldNames(klass: unknown): string[] {
  return Object.keys(Metadata.getFields(klass) as Record<string, unknown>).sort();
}

/** What the room holds, as the room itself would serialise it. */
function stateOf(registry: LobbyPresence): string {
  return JSON.stringify(registry.state);
}

/**
 * What the room would actually put on the wire.
 *
 * Stronger than the JSON view and slower, so the randomised sequence samples
 * it rather than running it on every step.
 */
function wireOf(encoder: Encoder): string {
  return Buffer.from(encoder.encodeAll()).toString('latin1');
}

function findLeak(surface: string): string | null {
  const haystack = surface.toLowerCase();
  for (const word of vocabulary.substrings) {
    if (haystack.includes(word)) return `substring "${word}"`;
  }
  for (const pattern of vocabulary.patterns) {
    if (new RegExp(pattern.regex).test(surface)) return `pattern "${pattern.name}"`;
  }
  return null;
}

/** Admit a session and return the server-minted identifier. */
function join(registry: LobbyPresence, session: string, x = 0, y = 0): GameId {
  const outcome = registry.admit(session, { x, y });
  if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
  return outcome.gameId;
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

describe('the schema is the enforcement point', () => {
  it('carries exactly the frozen PresenceState field set', () => {
    expect(fieldNames(PresenceEntry)).toEqual(
      Object.keys(FROZEN_PRESENCE_FIELDS).sort(),
    );
  });

  it('carries exactly the frozen Position field set', () => {
    expect(fieldNames(PositionSchema)).toEqual(
      Object.keys(FROZEN_POSITION_FIELDS).sort(),
    );
  });

  it('has two fields at the root: interest-filtered presence and the shared sandbox', () => {
    expect(fieldNames(LobbyState)).toEqual(['peers', 'sandbox']);
    const fields = Metadata.getFields(LobbyState) as Record<string, Record<string, unknown>>;
    expect(fields['peers']).toEqual({ map: PresenceEntry, view: true });
    // D-060: everyone shares one sandbox, so it is deliberately not a view.
    expect(fields['sandbox']).toEqual({ map: SandboxColumnEntry });
  });

  it('carries exactly the frozen SandboxColumn field set', () => {
    expect(fieldNames(SandboxColumnEntry)).toEqual(
      Object.keys(FROZEN_SANDBOX_COLUMN_FIELDS).sort(),
    );
  });

  it('declares no field type that could hold a structured payload', () => {
    const fields = Metadata.getFields(PresenceEntry) as Record<string, unknown>;
    expect(fields['gameId']).toBe('string');
    expect(fields['facing']).toBe('string');
    expect(fields['sprite']).toBe('string');
    expect(fields['position']).toBe(PositionSchema);
    // D-060: a palette index or -1, and a byte cannot hold anything else.
    expect(fields['carrying']).toBe('int8');

    const column = Metadata.getFields(SandboxColumnEntry) as Record<string, unknown>;
    expect(column['x']).toBe('uint8');
    expect(column['y']).toBe('uint8');
    expect(column['colours']).toEqual({ array: 'uint8' });
  });

  it('does not encode a property that is not declared', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 1, 2);
    const entry = registry.peers.get(id);
    expect(entry).toBeDefined();

    for (const attempt of vocabulary.smuggleAttempts) {
      Reflect.set(entry as object, 'extra', attempt);
    }

    expect(stateOf(registry)).not.toContain('extra');
    expect(findLeak(stateOf(registry))).toBeNull();
    expect(findLeak(wireOf(new Encoder(registry.state)))).toBeNull();
  });
});

describe('a client cannot set the room configuration', () => {
  // BLOCKER 1/2. Under Colyseus matchmaking, onCreate is called with
  // merge({}, clientOptions, handlerOptions). This models the original bug
  // exactly: hostile client options with an empty handler side, which used to
  // become the room's whole config. The room must ignore its onCreate argument
  // and use its trusted this.roomConfig instead.
  const HOSTILE = {
    capacity: 99999,
    interestRadius: 1_000_000,
    maxVisiblePeers: 99999,
    minUpdateIntervalMs: 0,
    worldLimit: 10_000_000,
    maxMessagesPerSecond: 100000,
    spriteKeys: ['0xdeadbeefcafef00d 12.5 STRK to the Bank'],
    defaultSprite: '0xdeadbeefcafef00d 12.5 STRK to the Bank',
    // D-060: a hostile creator would love a sky that rains blocks every 50 ms
    // and a pick/place floor switched off.
    sandboxSpawnIntervalMs: 50,
    sandboxSlowSpawnIntervalMs: 50,
    sandboxFastSpawnLimit: 900,
    sandboxActionIntervalMs: 0,
  };

  /**
   * Admit one connection into a room built outside a server and read the delay
   * its spawner armed — the room's effective sky-drop pace.
   */
  function armedDropDelays(room: PresenceRoom): number[] {
    const probe = { sessionId: 'probe', send: () => undefined } as unknown as Client;
    room.onJoin(probe, { x: 0, y: 0 });
    const timers = (room.clock as unknown as { delayed: Array<{ active: boolean; time: number }> })
      .delayed;
    return timers.filter((timer) => timer.active).map((timer) => timer.time);
  }

  function trustedConfigOf(room: PresenceRoom): PresenceRoomConfig {
    return (room as unknown as { roomConfig: PresenceRoomConfig }).roomConfig;
  }

  it('the base room ignores hostile onCreate options entirely', () => {
    const room = new PresenceRoom();
    (room as unknown as { onCreate: (o: unknown) => void }).onCreate(HOSTILE);
    // Capacity is the trusted default, not 99999 (the live-reproduced value).
    expect(room.maxClients).toBe(DEFAULT_ROOM_CONFIG.capacity);
    // The sky keeps the trusted pace and the floor stays on.
    expect(armedDropDelays(room)).toEqual([DEFAULT_ROOM_CONFIG.sandboxSpawnIntervalMs]);
    expect(trustedConfigOf(room)).toEqual(DEFAULT_ROOM_CONFIG);
    expect(trustedConfigOf(room).sandboxActionIntervalMs).toBe(SANDBOX_MIN_ACTION_INTERVAL_MS);
  });

  it('a configured room uses the operator config, not hostile options', () => {
    const config = resolveRoomConfig({ capacity: 10, sandboxSpawnIntervalMs: 900 });
    const RoomClass = definePresenceRoom(config);
    const room = new RoomClass();
    (room as unknown as { onCreate: (o: unknown) => void }).onCreate(HOSTILE);
    expect(room.maxClients).toBe(10);
    expect(armedDropDelays(room)).toEqual([900]);
    expect(trustedConfigOf(room)).toEqual(config);
  });

  it('owns the trusted config after defining a room class', () => {
    const config = {
      ...DEFAULT_ROOM_CONFIG,
      spriteKeys: [...DEFAULT_ROOM_CONFIG.spriteKeys],
      capacity: 10,
    };
    const RoomClass = definePresenceRoom(config);
    Reflect.set(config, 'capacity', 99);
    Reflect.set(config, 'defaultSprite', 'avatar-16');

    const room = new RoomClass();
    (room as unknown as { onCreate: (o: unknown) => void }).onCreate({});

    expect(room.maxClients).toBe(10);
    expect(room.counters).toEqual(expect.objectContaining({ present: 0 }));
  });

  it('a hostile sprite allowlist never reaches an entry', () => {
    // The registry is what actually holds sprites; drive it with the config a
    // room would build from HOSTILE if it (wrongly) trusted onCreate options,
    // versus the trusted config it actually uses. With the trusted config, a
    // client asking for the hostile sprite gets a trusted fallback.
    const registry = new LobbyPresence(DEFAULT_ROOM_CONFIG);
    const id = registry.admit('s1', {
      x: 0,
      y: 0,
      sprite: HOSTILE.defaultSprite,
    });
    expect(id.ok).toBe(true);
    if (!id.ok) throw new Error('unreachable');
    const entry = registry.peers.get(id.gameId);
    expect(entry?.sprite).toBe(DEFAULT_ROOM_CONFIG.defaultSprite);
    expect(findLeak(stateOf(registry))).toBeNull();
  });

  it('resolveRoomConfig clamps even a hostile-looking numeric override', () => {
    // Defence in depth: resolveRoomConfig is the operator channel, but if a
    // hostile value ever reached it, the clamp still holds.
    const config = resolveRoomConfig({
      capacity: 99999,
      interestRadius: -5,
      minUpdateIntervalMs: -1,
      maxMessagesPerSecond: 10 ** 9,
    });
    expect(config.capacity).toBeLessThanOrEqual(128);
    expect(config.interestRadius).toBeGreaterThanOrEqual(0);
    expect(config.minUpdateIntervalMs).toBeGreaterThanOrEqual(0);
    expect(config.maxMessagesPerSecond).toBeLessThanOrEqual(1000);
  });

  it('fails closed for a null override container', () => {
    expect(() => resolveRoomConfig(null as never)).not.toThrow();
    expect(resolveRoomConfig(null as never)).toEqual(DEFAULT_ROOM_CONFIG);
  });
});

describe('suspend removes a player from every other view', () => {
  it('takes the entry out of a nearby observer’s interest set', () => {
    const registry = new LobbyPresence({ interestRadius: 500 });
    join(registry, 'watcher', 0, 0);
    const walker = join(registry, 'walker', 20, 20);

    expect(registry.visibleTo('watcher').map((e) => e.gameId)).toEqual([walker]);

    registry.suspend('walker');

    expect(registry.visibleTo('watcher')).toEqual([]);
    expect(registry.peers.has(walker)).toBe(false);
  });

  it('leaves nothing behind about where the player was standing', () => {
    const registry = new LobbyPresence();
    registry.admit('walker', { x: 1234, y: 5678 });
    registry.suspend('walker');
    expect(stateOf(registry)).not.toContain('1234');
    expect(stateOf(registry)).not.toContain('5678');
  });

  it('puts the player back only where the client says, on an explicit resume', () => {
    const registry = new LobbyPresence({ interestRadius: 500 });
    join(registry, 'watcher', 0, 0);
    const walker = join(registry, 'walker', 20, 20);
    registry.suspend('walker');
    registry.resume('walker', { x: 30, y: 30 }, 1000);

    const seen = registry.visibleTo('watcher');
    expect(seen.map((e) => e.gameId)).toEqual([walker]);
    expect(seen[0]?.position.x).toBe(30);
  });
});

describe('no sequence of client input reaches state with money in it', () => {
  it('ignores every hostile value that might be offered as an identifier', () => {
    // The server mints the identifier; a client-supplied one is not read. So a
    // hostile "gameId" is not rejected — it simply never becomes identity, and
    // never appears in state.
    const registry = new LobbyPresence();
    vocabulary.smuggleAttempts.forEach((attempt, index) => {
      const outcome = registry.admit(`s${index}`, {
        x: 0,
        y: 0,
        // @ts-expect-error — not part of PlacementRequest; models a wire field
        gameId: attempt,
      });
      expect(outcome.ok).toBe(true);
    });
    expect(registry.peers.size).toBe(vocabulary.smuggleAttempts.length);
    expect(findLeak(stateOf(registry))).toBeNull();
    expect(findLeak(wireOf(new Encoder(registry.state)))).toBeNull();
  });

  it('replaces every hostile value offered as a sprite or a facing', () => {
    const registry = new LobbyPresence();
    vocabulary.smuggleAttempts.forEach((attempt, index) => {
      registry.admit(`s${index}`, {
        x: 0,
        y: 0,
        sprite: attempt,
        facing: attempt,
      });
    });
    expect(registry.peers.size).toBe(vocabulary.smuggleAttempts.length);
    expect(findLeak(stateOf(registry))).toBeNull();
    expect(findLeak(wireOf(new Encoder(registry.state)))).toBeNull();
  });

  it('stays clean across a long randomised sequence of operations', () => {
    const registry = new LobbyPresence({
      interestRadius: 400,
      minUpdateIntervalMs: 50,
      capacity: 12,
    });
    const encoder = new Encoder(registry.state);
    const random = mulberry32(20260816);
    const sessions = Array.from({ length: 12 }, (_unused, n) => `s${n}`);
    const attempts = vocabulary.smuggleAttempts;
    let clock = 0;

    for (let step = 0; step < 4000; step += 1) {
      clock += Math.floor(random() * 120);
      const session = sessions[Math.floor(random() * sessions.length)] as string;
      const hostile = random() < 0.4;
      const payload = hostile
        ? attempts[Math.floor(random() * attempts.length)]
        : undefined;

      switch (Math.floor(random() * 5)) {
        case 0:
          registry.admit(session, {
            x: hostile ? payload : Math.floor(random() * 2000) - 1000,
            y: hostile ? payload : Math.floor(random() * 2000) - 1000,
            facing: hostile ? payload : 'up',
            sprite: hostile ? payload : 'avatar-2',
          });
          break;
        case 1:
          registry.move(
            session,
            {
              x: hostile ? payload : Math.floor(random() * 2000) - 1000,
              y: hostile ? payload : Math.floor(random() * 2000) - 1000,
              facing: hostile ? payload : 'left',
            },
            clock,
          );
          break;
        case 2:
          registry.suspend(session);
          break;
        case 3:
          registry.resume(
            session,
            {
              x: hostile ? payload : Math.floor(random() * 2000) - 1000,
              y: hostile ? payload : Math.floor(random() * 2000) - 1000,
              sprite: hostile ? payload : 'avatar-4',
            },
            clock,
          );
          break;
        default:
          registry.release(session);
          break;
      }

      const leak = findLeak(stateOf(registry));
      expect(leak, `step ${step} leaked ${leak}`).toBeNull();
      if (step % 250 === 0) {
        const onWire = findLeak(wireOf(encoder));
        expect(onWire, `step ${step} put ${onWire} on the wire`).toBeNull();
      }
    }

    const counters = registry.counters();
    expect(counters.admitted).toBeGreaterThan(0);
    expect(counters.refused).toBeGreaterThan(0);
    expect(counters.suspensions).toBeGreaterThan(0);
  });
});

describe('the block sandbox is anonymous (D-060)', () => {
  const TILE = 32;

  /** World-pixel centre of a street tile. */
  function centre(tileX: number, tileY: number): { x: number; y: number } {
    return { x: tileX * TILE + TILE / 2, y: tileY * TILE + TILE / 2 };
  }

  /** A shared-state-only client: what an observer with no interest in anyone decodes. */
  function sharedObserver(encoder: Encoder): {
    read: () => { sandbox?: Record<string, unknown>; peers?: unknown };
    patch: () => string;
  } {
    const decoder = Reflection.decode(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());
    return {
      read: () => (decoder.state as { toJSON(): Record<string, unknown> }).toJSON(),
      patch: () => {
        const bytes = encoder.encode();
        decoder.decode(bytes);
        encoder.discardChanges();
        return Buffer.from(bytes).toString('latin1');
      },
    };
  }

  function columnsOf(json: { sandbox?: Record<string, unknown> }): SandboxColumn[] {
    return Object.values(json.sandbox ?? {})
      .map((value) => value as SandboxColumn)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map(({ x, y, colours }) => ({ x, y, colours: [...colours] }));
  }

  it('names no player in columns, drops or carried state on the shared wire', () => {
    // Scripted draws first, then a seeded stream.
    const scripted: number[] = [];
    const seeded = mulberry32(60);
    const registry = new LobbyPresence({
      sandboxRandom: () => (scripted.length > 0 ? (scripted.shift() as number) : seeded()),
    });
    const encoder = new Encoder(registry.state);
    const observer = sharedObserver(encoder);

    // Nobody on the street yet, so every tile is open and a draw of 0 is the
    // first tile in (y, x) order. Colour draw 3.5/8 is palette index 3.
    scripted.push(0, 3.5 / 8);
    expect(registry.spawnBlock()).toEqual({ x: SANDBOX_AREA.x, y: SANDBOX_AREA.y });

    const picker = centre(SANDBOX_AREA.x + 1, SANDBOX_AREA.y);
    const ids = [
      join(registry, 'picker', picker.x, picker.y),
      join(registry, 'watcher', picker.x + 256, picker.y + 256),
    ];
    // The picker carries a block, so there is per-player sandbox state to leak.
    expect(registry.pickBlock('picker', { x: SANDBOX_AREA.x, y: SANDBOX_AREA.y }, 0)).toBe('applied');
    expect(registry.sandboxCarrying('picker')).toBe(3);
    expect(registry.peers.get(ids[0] as GameId)?.carrying).toBe(3);

    const drops: SandboxTile[] = [];
    for (let n = 0; n < 40; n += 1) {
      const tile = registry.spawnBlock();
      expect(tile).not.toBeNull();
      drops.push(tile as SandboxTile);
    }
    // A drop is a tile and nothing else — exactly what the room broadcasts.
    for (const tile of drops) expect(Object.keys(tile).sort()).toEqual(['x', 'y']);

    const wire = observer.patch();
    const shared = observer.read();
    expect(shared.peers).toBeUndefined();
    expect(columnsOf(shared)).toEqual(
      registry.sandboxColumns().map(({ x, y, colours }) => ({ x, y, colours: [...colours] })),
    );
    const surface = JSON.stringify(shared) + wire;
    for (const id of ids) expect(surface).not.toContain(id);
    expect(findLeak(JSON.stringify(registry.state.sandbox))).toBeNull();
    expect(findLeak(surface)).toBeNull();
  });

  // A long seeded run: about 2 s alone and much slower under a full parallel
  // run, so it gets more than vitest's 5 s default.
  it('stays anonymous and in sync across a long randomised sequence of sandbox input', () => {
    const registry = new LobbyPresence({
      interestRadius: 400,
      minUpdateIntervalMs: 0,
      sandboxActionIntervalMs: 50,
      capacity: 8,
      sandboxRandom: mulberry32(20260927),
    });
    const encoder = new Encoder(registry.state);
    const observer = sharedObserver(encoder);
    const random = mulberry32(60060);
    const sessions = Array.from({ length: 8 }, (_unused, n) => `s${n}`);
    const attempts: unknown[] = [
      ...vocabulary.smuggleAttempts,
      null,
      [SANDBOX_AREA.x, SANDBOX_AREA.y],
      { x: Number.NaN, y: 0 },
      { x: SANDBOX_AREA.x + 0.5, y: 1 },
      { x: SANDBOX_AREA.x - 1, y: 1 },
      { x: String(SANDBOX_AREA.x), y: '1' },
    ];
    const everyId = new Set<string>();
    let clock = 0;

    const nearTile = (): SandboxTile => ({
      x: SANDBOX_AREA.x + Math.floor(random() * 6),
      y: SANDBOX_AREA.y + Math.floor(random() * 6),
    });

    for (let step = 0; step < 3000; step += 1) {
      clock += Math.floor(random() * 80);
      const session = sessions[Math.floor(random() * sessions.length)] as string;
      const hostile = random() < 0.3;
      const payload = hostile ? attempts[Math.floor(random() * attempts.length)] : nearTile();
      const spot = nearTile();
      const at = { x: spot.x * TILE + Math.floor(random() * TILE), y: spot.y * TILE + Math.floor(random() * TILE) };

      switch (Math.floor(random() * 8)) {
        case 0: {
          const outcome = registry.admit(session, at);
          if (outcome.ok) everyId.add(outcome.gameId);
          break;
        }
        case 1:
          registry.move(session, at, clock);
          break;
        case 2:
          registry.suspend(session);
          break;
        case 3:
          registry.resume(session, at, clock);
          break;
        case 4:
          registry.release(session);
          break;
        case 5:
          registry.pickBlock(session, payload, clock);
          break;
        case 6:
          registry.placeBlock(session, payload, clock);
          break;
        default:
          registry.spawnBlock();
          break;
      }

      const sandboxJson = JSON.stringify(registry.state.sandbox);
      for (const id of everyId) {
        expect(sandboxJson.includes(id), `step ${step} put an id in the sandbox`).toBe(false);
      }
      expect(findLeak(sandboxJson), `step ${step}`).toBeNull();
      expect(registry.sandboxBlocks).toBeLessThanOrEqual(900);

      if (step % 100 === 0) {
        const wire = observer.patch();
        const shared = observer.read();
        expect(columnsOf(shared), `step ${step} mirror`).toEqual(
          registry.sandboxColumns().map(({ x, y, colours }) => ({ x, y, colours: [...colours] })),
        );
        for (const id of everyId) {
          expect(wire.includes(id), `step ${step} put an id on the shared wire`).toBe(false);
        }
        expect(findLeak(JSON.stringify(shared)), `step ${step}`).toBeNull();
      }
    }

    // The sequence really exercised the sandbox, not just the guards.
    expect(registry.sandboxColumns().length).toBeGreaterThan(0);
    expect(everyId.size).toBeGreaterThan(0);
  }, 30_000);

  it('never drops a returned block where its carrier left the street', () => {
    // A carried block falls back when its carrier suspends (enters a building)
    // or leaves. Landing on or beside their last tile would mark the spot.
    const drops: SandboxTile[] = [];
    const registry = new LobbyPresence({
      sandboxRandom: mulberry32(1919),
      onSandboxDrop: (tile) => drops.push(tile),
    });
    for (let n = 0; n < 300; n += 1) registry.spawnBlock();
    const id = join(registry, 'carrier', 0, 0);
    const encoder = new Encoder(registry.state);
    const observer = sharedObserver(encoder);
    let now = 1000;
    let returned = 0;
    for (let round = 0; round < 400 && returned < 100; round += 1) {
      const columns = registry.sandboxColumns();
      const column = columns[round % columns.length] as SandboxColumn;
      const heights = new Map(columns.map((c) => [`${c.x},${c.y}`, c.colours.length]));
      const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => ({ x: column.x + (dx as number), y: column.y + (dy as number) }))
        .find((tile) => {
          const level = heights.get(`${tile.x},${tile.y}`) ?? 0;
          const inside = tile.x >= SANDBOX_AREA.x && tile.x < SANDBOX_AREA.x + SANDBOX_AREA.width &&
            tile.y >= SANDBOX_AREA.y && tile.y < SANDBOX_AREA.y + SANDBOX_AREA.height;
          return inside && column.colours.length >= level - 1 && column.colours.length <= level + 2;
        });
      now += 200;
      if (spot === undefined) continue;
      registry.move('carrier', centre(spot.x, spot.y), now);
      if (registry.pickBlock('carrier', { x: column.x, y: column.y }, now) !== 'applied') continue;
      drops.length = 0;
      registry.suspend('carrier');
      expect(drops).toHaveLength(1);
      const landed = drops[0] as SandboxTile;
      expect(Object.keys(landed).sort()).toEqual(['x', 'y']);
      expect(Math.max(Math.abs(landed.x - spot.x), Math.abs(landed.y - spot.y))).toBeGreaterThan(1);
      registry.resume('carrier', { x: 0, y: 0 }, now);
      returned += 1;
    }
    expect(returned).toBe(100);
    expect(registry.sandboxBlocks).toBe(300);
    const wire = observer.patch();
    expect(wire).not.toContain(id);
    expect(JSON.stringify(observer.read())).not.toContain(id);
  });
});
