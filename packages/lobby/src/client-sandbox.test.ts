/**
 * The client wrapper's sandbox surface (D-060) against a transport double:
 * validation of everything the server sends, change-only delivery, listener
 * isolation, the client-side action floor, and what goes on the wire.
 *
 * No real server here — the end-to-end behaviour lives in
 * `sandbox-room.test.ts`. The double routes `onMessage` by type, so the drop
 * and welcome handlers can be driven independently.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import {
  SANDBOX_AREA,
  SANDBOX_MAX_HEIGHT,
  STREET_ORIGIN_X,
  type SandboxSnapshot,
  type SandboxTile,
} from '@strkworld/shared';
import { MESSAGE, SANDBOX_CLIENT_ACTION_INTERVAL_MS, SERVER_MESSAGE } from './config';
import { LobbyClient, type PeerSnapshot } from './client';
import type { LobbyState } from './state';

/**
 * D-078 moved the street, the sandbox with it, east by the pitch square. The
 * tiles here keep D-060's numbering: `S(n)` is the street's column `n`, so the
 * square is `S(54)` to `S(81)`, and a comment's "tile 62" is `S(62)`.
 */
const S = (column: number): number => STREET_ORIGIN_X + column;

const OWN = '0123456789abcdef';
const PEER = 'fedcba9876543210';
const LEFT = SANDBOX_AREA.x;
const TOP = SANDBOX_AREA.y;

interface FakeRoom {
  readonly room: ColyseusRoom<unknown, LobbyState>;
  readonly state: { peers: Map<string, unknown>; sandbox: unknown };
  readonly send: ReturnType<typeof vi.fn>;
  readonly leave: ReturnType<typeof vi.fn>;
  message(type: string, payload?: unknown): void;
  handles(type: string): boolean;
  stateChange(): void;
  left(code: number): void;
}

function fakeRoom(): FakeRoom {
  const handlers = new Map<string, (payload: unknown) => void>();
  let stateChange: (() => void) | undefined;
  let left: ((code: number) => void) | undefined;
  const send = vi.fn();
  const leave = vi.fn(async () => 0);
  const state = { peers: new Map<string, unknown>(), sandbox: new Map<string, unknown>() as unknown };
  const room = {
    state,
    reconnection: { enabled: true },
    send,
    leave,
    onMessage: vi.fn((type: string, callback: (payload: unknown) => void) => {
      handlers.set(type, callback);
      return () => undefined;
    }),
    onStateChange: vi.fn((callback: () => void) => {
      stateChange = callback;
      return () => undefined;
    }),
    onError: vi.fn(() => () => undefined),
    onLeave: vi.fn((callback: (code: number) => void) => {
      left = callback;
      return () => undefined;
    }),
  } as unknown as ColyseusRoom<unknown, LobbyState>;
  return {
    room,
    state,
    send,
    leave,
    message: (type, payload) => handlers.get(type)?.(payload),
    handles: (type) => handlers.has(type),
    stateChange: () => stateChange?.(),
    left: (code) => left?.(code),
  };
}

function column(x: number, y: number, colours: unknown[]): unknown {
  return { x, y, colours };
}

function presence(gameId: string, carrying: unknown): unknown {
  return { gameId, position: { x: 10, y: 10 }, facing: 'down', sprite: 'avatar-1', carrying };
}

const opened: LobbyClient[] = [];

/** A client joined to `joined`, welcomed with `OWN`. */
async function connectedTo(joined: FakeRoom): Promise<LobbyClient> {
  vi.spyOn(ColyseusClient.prototype, 'joinOrCreate').mockResolvedValueOnce(joined.room as never);
  const client = new LobbyClient({ endpoint: 'ws://example', start: { x: 0, y: 0 } });
  opened.push(client);
  const connecting = client.connect();
  for (let tick = 0; tick < 20 && !joined.handles(SERVER_MESSAGE.welcome); tick += 1) {
    await Promise.resolve();
  }
  joined.message(SERVER_MESSAGE.welcome, { gameId: OWN });
  await connecting;
  return client;
}

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
  vi.restoreAllMocks();
});

describe('sandbox()', () => {
  it('is empty and frozen before any connection', () => {
    const client = new LobbyClient({ endpoint: 'ws://example', start: { x: 0, y: 0 } });
    const snapshot = client.sandbox();
    expect(snapshot).toEqual({ columns: [], carrying: null });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.columns)).toBe(true);
    expect(client.sandbox()).toBe(snapshot);
  });

  it('reads every validated column, sorted by (y, x), and the own carried colour', async () => {
    const joined = fakeRoom();
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    sandbox.set(`${S(70)},3`, column(S(70), 3, [1]));
    sandbox.set(`${S(60)},9`, column(S(60), 9, [2, 3]));
    sandbox.set(`${S(65)},3`, column(S(65), 3, [4]));
    joined.state.peers.set(OWN, presence(OWN, 5));
    joined.state.peers.set(PEER, presence(PEER, 6));
    const client = await connectedTo(joined);

    const snapshot = client.sandbox();
    expect(snapshot).toEqual({
      columns: [
        { x: S(65), y: 3, colours: [4] },
        { x: S(70), y: 3, colours: [1] },
        { x: S(60), y: 9, colours: [2, 3] },
      ],
      carrying: 5,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.columns)).toBe(true);
    expect(Object.isFrozen(snapshot.columns[0])).toBe(true);
    expect(Object.isFrozen(snapshot.columns[0]?.colours)).toBe(true);
    // The same object while nothing changes; a new one when something does.
    expect(client.sandbox()).toBe(snapshot);
    sandbox.set(`${S(55)},0`, column(S(55), 0, [7]));
    expect(client.sandbox()).not.toBe(snapshot);
    expect(snapshot.columns).toHaveLength(3);
  });

  it('skips every malformed column whole and keeps the good ones', async () => {
    const joined = fakeRoom();
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    const throwing = {
      x: S(71),
      y: 1,
      get colours(): unknown {
        throw new Error('hostile decoded state');
      },
    };
    sandbox.set(`${S(60)},1`, column(S(60), 1, [1, 2]));
    sandbox.set('wrong-key', column(S(61), 2, [1]));
    sandbox.set(`${S(62)},1`, column(S(61), 1, [1])); // key names another tile
    sandbox.set(`${LEFT - 1},1`, column(LEFT - 1, 1, [1]));
    sandbox.set(`${LEFT},${TOP + SANDBOX_AREA.height}`, column(LEFT, TOP + SANDBOX_AREA.height, [1]));
    sandbox.set(`${S(63)},1.5`, column(S(63), 1.5, [1]));
    sandbox.set(`${S(64)},1`, column(S(64), 1, []));
    sandbox.set(`${S(65)},1`, column(S(65), 1, Array.from({ length: SANDBOX_MAX_HEIGHT + 1 }, () => 0)));
    sandbox.set(`${S(66)},1`, column(S(66), 1, [1, 8]));
    sandbox.set(`${S(67)},1`, column(S(67), 1, [-1]));
    sandbox.set(`${S(68)},1`, column(S(68), 1, [2.5]));
    sandbox.set(`${S(69)},1`, column(S(69), 1, ['1']));
    sandbox.set(`${S(70)},1`, column(S(70), 1, { length: 1, 0: 1.1 } as never));
    sandbox.set(`${S(71)},1`, throwing);
    sandbox.set(`${S(72)},1`, null);
    sandbox.set(`${S(73)},1`, column(S(73), 1, [SANDBOX_MAX_HEIGHT - 250, 0]));
    const client = await connectedTo(joined);

    expect(client.sandbox().columns).toEqual([
      { x: S(60), y: 1, colours: [1, 2] },
      { x: S(73), y: 1, colours: [6, 0] },
    ]);
  });

  it('fails closed to no columns when the container cannot be read', async () => {
    const cases: unknown[] = [
      undefined,
      'sandbox',
      { forEach: 'not callable' },
      {
        forEach: () => {
          throw new Error('hostile iteration');
        },
      },
    ];
    for (const container of cases) {
      const joined = fakeRoom();
      Reflect.set(joined.state, 'sandbox', container);
      joined.state.peers.set(OWN, presence(OWN, 2));
      const client = await connectedTo(joined);
      expect(client.sandbox()).toEqual({ columns: [], carrying: 2 });
      await client.disconnect();
    }
  });

  it('draws no more than the room-wide block cap', async () => {
    const joined = fakeRoom();
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    const full = (): number[] => Array.from({ length: SANDBOX_MAX_HEIGHT }, () => 1);
    for (const [x, y] of [[S(60), 4], [S(61), 4], [S(62), 4], [S(63), 4]] as const) {
      sandbox.set(`${x},${y}`, column(x, y, full()));
    }
    const client = await connectedTo(joined);
    // 3 x 256 = 768 fits the 900 cap; a fourth full stack would not.
    expect(client.sandbox().columns.map(({ x }) => x)).toEqual([S(60), S(61), S(62)]);
  });

  it('validates the own carried colour and never borrows a peer’s', async () => {
    for (const [value, expected] of [
      [3, 3],
      [0, 0],
      [7, 7],
      [-1, null],
      [8, null],
      [2.5, null],
      ['3', null],
      [undefined, null],
    ] as const) {
      const joined = fakeRoom();
      joined.state.peers.set(OWN, presence(OWN, value));
      joined.state.peers.set(PEER, presence(PEER, 4));
      const client = await connectedTo(joined);
      expect(client.sandbox().carrying, `own carrying ${String(value)}`).toBe(expected);
      await client.disconnect();
    }
    // An entry stored under our key but naming someone else is not ours.
    const joined = fakeRoom();
    joined.state.peers.set(OWN, presence(PEER, 4));
    const client = await connectedTo(joined);
    expect(client.sandbox().carrying).toBeNull();
  });

  it('reports nothing carried while suspended, and nothing at all after disconnect', async () => {
    const joined = fakeRoom();
    (joined.state.sandbox as Map<string, unknown>).set(`${S(60)},1`, column(S(60), 1, [1]));
    joined.state.peers.set(OWN, presence(OWN, 3));
    const client = await connectedTo(joined);
    expect(client.sandbox().carrying).toBe(3);

    client.suspend();
    // The stale entry is still in the decoded state, but the server has
    // already discarded the block.
    expect(client.sandbox()).toEqual({ columns: [{ x: S(60), y: 1, colours: [1] }], carrying: null });

    await client.disconnect();
    expect(client.sandbox()).toEqual({ columns: [], carrying: null });
  });
});

describe('sandbox() reads only what changed (D-086)', () => {
  it('reuses every column a patch did not touch, and rebuilds the one it did', async () => {
    const joined = fakeRoom();
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    const growing = [2];
    sandbox.set(`${S(60)},1`, column(S(60), 1, [1]));
    sandbox.set(`${S(61)},1`, column(S(61), 1, growing));
    sandbox.set(`${S(62)},1`, column(S(62), 1, [3]));
    const client = await connectedTo(joined);
    const before = client.sandbox();

    growing.push(4);
    const after = client.sandbox();
    expect(after).not.toBe(before);
    expect(after.columns[0]).toBe(before.columns[0]);
    expect(after.columns[2]).toBe(before.columns[2]);
    expect(after.columns[1]).not.toBe(before.columns[1]);
    expect(after.columns[1]).toEqual({ x: S(61), y: 1, colours: [2, 4] });
    expect(Object.isFrozen(after.columns[1]?.colours)).toBe(true);
    // A column that goes away goes, and the rest are still reused.
    sandbox.delete(`${S(62)},1`);
    const shrunk = client.sandbox();
    expect(shrunk.columns).toHaveLength(2);
    expect(shrunk.columns[0]).toBe(before.columns[0]);
  });

  it('still refuses a column changed in place to something invalid', async () => {
    const joined = fakeRoom();
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    const colours: unknown[] = [1, 2];
    sandbox.set(`${S(60)},1`, column(S(60), 1, colours));
    sandbox.set(`${S(61)},1`, column(S(61), 1, [3]));
    const client = await connectedTo(joined);
    expect(client.sandbox().columns).toHaveLength(2);

    colours[1] = 99;
    expect(client.sandbox().columns).toEqual([{ x: S(61), y: 1, colours: [3] }]);
    colours[1] = 2;
    expect(client.sandbox().columns).toHaveLength(2);
  });

  it('skips the read on a patch the decoder says only moved players, and falls back if its hook is taken', async () => {
    const joined = fakeRoom();
    const decoder: { triggerChanges?: (changes: unknown) => void } = {};
    Object.assign(joined.room, { serializer: { decoder } });
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    const colours = [1];
    sandbox.set(`${S(60)},1`, column(S(60), 1, colours));
    const client = await connectedTo(joined);
    expect(typeof decoder.triggerChanges).toBe('function');
    const first = client.sandbox();
    expect(first.columns).toEqual([{ x: S(60), y: 1, colours: [1] }]);

    // A patch that only moved a player: the decoded sandbox is not read.
    colours.push(2);
    decoder.triggerChanges?.([{ ref: joined.state.peers }, { ref: { x: 1, y: 2 } }, { ref: { gameId: PEER } }]);
    expect(client.sandbox()).toBe(first);

    // A patch that touched a column's colours: read, and the change shows.
    decoder.triggerChanges?.([{ ref: colours }]);
    expect(client.sandbox().columns).toEqual([{ x: S(60), y: 1, colours: [1, 2] }]);

    // Anything unrecognised counts as a sandbox change.
    colours.push(3);
    decoder.triggerChanges?.([{ ref: null }]);
    expect(client.sandbox().columns[0]?.colours).toEqual([1, 2, 3]);

    // Someone else takes the hook: the client stops trusting it and reads.
    decoder.triggerChanges = () => undefined;
    colours.push(4);
    expect(client.sandbox().columns[0]?.colours).toEqual([1, 2, 3, 4]);
  });

  it('still reads in full now and then, and stops trusting a decoder the SDK replaced', async () => {
    const joined = fakeRoom();
    const decoder: { triggerChanges?: (changes: unknown) => void } = {};
    const serializer: { decoder: object } = { decoder };
    Object.assign(joined.room, { serializer });
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    const colours = [1];
    sandbox.set(`${S(60)},1`, column(S(60), 1, colours));
    const client = await connectedTo(joined);
    client.sandbox();

    // A change the hook never heard of (a decode that failed part-way)...
    colours.push(2);
    let reads = 0;
    while (client.sandbox().columns[0]?.colours.length === 1 && reads < 1000) reads += 1;
    // ...shows within a bounded number of reads.
    expect(reads).toBeLessThanOrEqual(100);
    expect(client.sandbox().columns[0]?.colours).toEqual([1, 2]);

    // A new decoder (a fresh handshake) carries no hook of ours: read.
    serializer.decoder = {};
    colours.push(3);
    expect(client.sandbox().columns[0]?.colours).toEqual([1, 2, 3]);
  });

  it('never carries one room\'s columns into the next', async () => {
    const first = fakeRoom();
    (first.state.sandbox as Map<string, unknown>).set(`${S(60)},1`, column(S(60), 1, [1]));
    const client = await connectedTo(first);
    expect(client.sandbox().columns).toHaveLength(1);
    await client.disconnect();

    const second = fakeRoom();
    vi.spyOn(ColyseusClient.prototype, 'joinOrCreate').mockResolvedValueOnce(second.room as never);
    const connecting = client.connect();
    for (let tick = 0; tick < 20 && !second.handles(SERVER_MESSAGE.welcome); tick += 1) {
      await Promise.resolve();
    }
    second.message(SERVER_MESSAGE.welcome, { gameId: OWN });
    await connecting;
    expect(client.sandbox().columns).toEqual([]);
  });
});

describe('onSandbox', () => {
  it('replays at once, then delivers only real changes', async () => {
    const joined = fakeRoom();
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    joined.state.peers.set(OWN, presence(OWN, -1));
    joined.state.peers.set(PEER, presence(PEER, -1));
    const client = await connectedTo(joined);
    const seen: SandboxSnapshot[] = [];
    client.onSandbox((snapshot) => seen.push(snapshot));
    expect(seen).toEqual([{ columns: [], carrying: null }]);

    // A peer moving is a room patch, not a sandbox change.
    (joined.state.peers.get(PEER) as { position: { x: number } }).position.x = 99;
    joined.stateChange();
    expect(seen).toHaveLength(1);

    sandbox.set(`${S(60)},1`, column(S(60), 1, [1]));
    joined.stateChange();
    joined.stateChange();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ columns: [{ x: S(60), y: 1, colours: [1] }], carrying: null });
    expect(Object.isFrozen(seen[1])).toBe(true);

    (joined.state.peers.get(OWN) as { carrying: number }).carrying = 1;
    sandbox.delete(`${S(60)},1`);
    joined.stateChange();
    expect(seen[2]).toEqual({ columns: [], carrying: 1 });

    client.suspend();
    expect(seen[3]).toEqual({ columns: [], carrying: null });

    await client.disconnect();
    expect(seen).toHaveLength(4);
  });

  it('delivers the empty sandbox when the connection ends', async () => {
    const joined = fakeRoom();
    (joined.state.sandbox as Map<string, unknown>).set(`${S(60)},1`, column(S(60), 1, [1]));
    const client = await connectedTo(joined);
    const seen: SandboxSnapshot[] = [];
    client.onSandbox((snapshot) => seen.push(snapshot));
    joined.left(1006);
    expect(seen.at(-1)).toEqual({ columns: [], carrying: null });
    expect(client.status).toBe('closed');
  });

  it('isolates a throwing subscriber behind a fixed diagnostic', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('subscriber failed');
    const later: SandboxSnapshot[] = [];
    let stop!: () => void;
    expect(() => {
      stop = client.onSandbox(() => {
        throw error;
      });
    }).not.toThrow();
    client.onSandbox((snapshot) => later.push(snapshot));
    (joined.state.sandbox as Map<string, unknown>).set(`${S(60)},1`, column(S(60), 1, [2]));
    expect(() => joined.stateChange()).not.toThrow();
    expect(later.at(-1)?.columns).toEqual([{ x: S(60), y: 1, colours: [2] }]);
    expect(consoleError).toHaveBeenCalledWith('lobby client: sandbox subscriber threw');
    expect(consoleError).not.toHaveBeenCalledWith('lobby client: sandbox subscriber threw', error);
    stop();
  });

  it('skips a subscriber removed before its turn and gives a late one a single replay', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const second = vi.fn();
    const late: SandboxSnapshot[] = [];
    let stopSecond!: () => void;
    let added = false;
    client.onSandbox((snapshot) => {
      if (snapshot.columns.length === 0) return;
      stopSecond();
      if (!added) {
        added = true;
        client.onSandbox((next) => late.push(next));
      }
    });
    stopSecond = client.onSandbox(second);
    second.mockClear();

    (joined.state.sandbox as Map<string, unknown>).set(`${S(60)},1`, column(S(60), 1, [2]));
    joined.stateChange();

    expect(second).not.toHaveBeenCalled();
    expect(late).toEqual([{ columns: [{ x: S(60), y: 1, colours: [2] }], carrying: null }]);
  });

  it('stops delivering after unsubscribe', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const listener = vi.fn();
    const stop = client.onSandbox(listener);
    stop();
    (joined.state.sandbox as Map<string, unknown>).set(`${S(60)},1`, column(S(60), 1, [2]));
    joined.stateChange();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('onSandboxDrop', () => {
  it('relays validated, frozen tiles and nothing else', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const drops: SandboxTile[] = [];
    client.onSandboxDrop((tile) => drops.push(tile));

    let accessorRead = false;
    const accessor = Object.defineProperty({ y: 1 }, 'x', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return S(60);
      },
    });
    for (const payload of [
      undefined,
      null,
      'drop',
      [S(60), 1],
      { x: LEFT - 1, y: 1 },
      { x: S(60) + 0.5, y: 1 },
      { x: S(60), y: Number.NaN },
      { x: String(S(60)), y: '1' },
      Object.create({ x: S(60), y: 1 }),
      accessor,
    ]) {
      joined.message(SERVER_MESSAGE.sandboxDrop, payload);
    }
    expect(drops).toEqual([]);
    expect(accessorRead).toBe(false);

    joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(60), y: 1, gameId: PEER });
    expect(drops).toEqual([{ x: S(60), y: 1 }]);
    expect(Object.isFrozen(drops[0])).toBe(true);
    expect(Object.keys(drops[0] as object).sort()).toEqual(['x', 'y']);
  });

  it('does not replay, stops after unsubscribe, and ignores a retired room', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(60), y: 1 });
    const listener = vi.fn();
    const stop = client.onSandboxDrop(listener);
    expect(listener).not.toHaveBeenCalled();
    joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(61), y: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(62), y: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    const after = vi.fn();
    client.onSandboxDrop(after);
    await client.disconnect();
    joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(63), y: 1 });
    expect(after).not.toHaveBeenCalled();
  });

  it('isolates a throwing drop subscriber behind a fixed diagnostic', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();
    client.onSandboxDrop(() => {
      throw new Error('drop subscriber failed');
    });
    client.onSandboxDrop(later);
    expect(() => joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(60), y: 1 })).not.toThrow();
    expect(later).toHaveBeenCalledWith({ x: S(60), y: 1 });
    expect(consoleError).toHaveBeenCalledWith('lobby client: sandbox drop subscriber threw');
  });
});

describe('onSandboxBurst (D-071)', () => {
  it('relays validated, frozen tiles and nothing else', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    expect(joined.handles(SERVER_MESSAGE.sandboxBurst)).toBe(true);
    const bursts: SandboxTile[] = [];
    client.onSandboxBurst((tile) => bursts.push(tile));

    let accessorRead = false;
    const accessor = Object.defineProperty({ y: 1 }, 'x', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return S(60);
      },
    });
    for (const payload of [
      undefined,
      null,
      'burst',
      [S(60), 1],
      { x: LEFT - 1, y: 1 },
      { x: S(60) + 0.5, y: 1 },
      { x: S(60), y: Number.NaN },
      { x: String(S(60)), y: '1' },
      Object.create({ x: S(60), y: 1 }),
      accessor,
    ]) {
      joined.message(SERVER_MESSAGE.sandboxBurst, payload);
    }
    expect(bursts).toEqual([]);
    expect(accessorRead).toBe(false);

    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(60), y: 1, gameId: PEER, colours: [1] });
    expect(bursts).toEqual([{ x: S(60), y: 1 }]);
    expect(Object.isFrozen(bursts[0])).toBe(true);
    expect(Object.keys(bursts[0] as object).sort()).toEqual(['x', 'y']);
  });

  it('is not a drop: each hint reaches only its own subscribers', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const drops = vi.fn();
    const bursts = vi.fn();
    client.onSandboxDrop(drops);
    client.onSandboxBurst(bursts);
    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(60), y: 1 });
    expect(drops).not.toHaveBeenCalled();
    expect(bursts).toHaveBeenCalledWith({ x: S(60), y: 1 });
    joined.message(SERVER_MESSAGE.sandboxDrop, { x: S(61), y: 1 });
    expect(bursts).toHaveBeenCalledTimes(1);
    expect(drops).toHaveBeenCalledWith({ x: S(61), y: 1 });
  });

  it('arrives while the snapshot still holds the blocks it throws', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const sandbox = joined.state.sandbox as Map<string, unknown>;
    sandbox.set(`${S(60)},1`, column(S(60), 1, [1, 2, 3]));
    joined.stateChange();
    const seen: number[] = [];
    client.onSandboxBurst(() => seen.push(client.sandbox().columns.length));
    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(60), y: 1 });
    expect(seen).toEqual([1]);
  });

  it('does not replay, stops after unsubscribe, and ignores a retired room', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(60), y: 1 });
    const listener = vi.fn();
    const stop = client.onSandboxBurst(listener);
    expect(listener).not.toHaveBeenCalled();
    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(61), y: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(62), y: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    const after = vi.fn();
    client.onSandboxBurst(after);
    await client.disconnect();
    joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(63), y: 1 });
    expect(after).not.toHaveBeenCalled();
  });

  it('isolates a throwing burst subscriber behind a fixed diagnostic', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();
    client.onSandboxBurst(() => {
      throw new Error('burst subscriber failed');
    });
    client.onSandboxBurst(later);
    expect(() => joined.message(SERVER_MESSAGE.sandboxBurst, { x: S(60), y: 1 })).not.toThrow();
    expect(later).toHaveBeenCalledWith({ x: S(60), y: 1 });
    expect(consoleError).toHaveBeenCalledWith('lobby client: sandbox burst subscriber threw');
  });
});

describe('pickBlock and placeBlock', () => {
  it('send exactly one tile under the sandbox verbs', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    joined.send.mockClear();

    client.pickBlock({ x: S(60), y: 1 });
    now += SANDBOX_CLIENT_ACTION_INTERVAL_MS;
    client.placeBlock({ x: S(61), y: 2, extra: 'ignored' } as SandboxTile);

    expect(joined.send.mock.calls).toEqual([
      [MESSAGE.sandboxPick, { x: S(60), y: 1 }],
      [MESSAGE.sandboxPlace, { x: S(61), y: 2 }],
    ]);
    expect(MESSAGE.sandboxPick).toBe('sandbox:pick');
    expect(MESSAGE.sandboxPlace).toBe('sandbox:place');
  });

  it('holds an early action and sends only the latest one when the floor opens', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      joined.send.mockClear();
      client.pickBlock({ x: S(60), y: 1 });
      expect(joined.send).toHaveBeenCalledTimes(1);

      // The pick shows up 44 ms later and the Shell places at once: held, not lost.
      now = 1044;
      client.placeBlock({ x: S(61), y: 1 });
      now = 1100;
      client.placeBlock({ x: S(62), y: 1 }); // a newer request replaces the held one
      expect(joined.send).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      // If the timer fires early by the clock, the floor is re-checked.
      now = 1150;
      vi.advanceTimersByTime(100);
      expect(joined.send).toHaveBeenCalledTimes(1);
      now = 1200;
      vi.advanceTimersByTime(50);
      expect(joined.send.mock.calls).toEqual([
        [MESSAGE.sandboxPick, { x: S(60), y: 1 }],
        [MESSAGE.sandboxPlace, { x: S(62), y: 1 }],
      ]);
      expect(vi.getTimerCount()).toBe(0);

      // An action with the floor open goes at once and supersedes nothing held.
      now = 1400;
      client.pickBlock({ x: S(60), y: 1 });
      expect(joined.send).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a waiting position before the action, so reach is judged from where the player stands', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      joined.send.mockClear();
      client.updatePosition(1808, 464, 'right');
      now = 1010;
      // A step across a tile edge, still inside the move floor: held.
      client.updatePosition(1840, 464, 'right');
      client.pickBlock({ x: S(59), y: 14 });
      expect(joined.send.mock.calls.map(([type]) => type)).toEqual([MESSAGE.move]);
      now = 1100;
      vi.advanceTimersByTime(100);
      const sent = joined.send.mock.calls.map(([type, payload]) => [type, payload]);
      const moveIndex = sent.findIndex(([type, payload]) => type === MESSAGE.move && (payload as { x: number }).x === 1840);
      const pickIndex = sent.findIndex(([type]) => type === MESSAGE.sandboxPick);
      expect(moveIndex).toBeGreaterThanOrEqual(0);
      expect(pickIndex).toBeGreaterThan(moveIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the floor through a clock rollback and an unusable clock', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      joined.send.mockClear();
      client.pickBlock({ x: S(60), y: 1 });
      now = 500; // rolled back: the floor stays closed until 1200 again
      client.placeBlock({ x: S(61), y: 1 });
      vi.advanceTimersByTime(200);
      expect(joined.send).toHaveBeenCalledTimes(1);
      now = Number.NaN;
      vi.advanceTimersByTime(10_000);
      expect(joined.send).toHaveBeenCalledTimes(1);
      now = 1200;
      vi.advanceTimersByTime(10_000);
      expect(joined.send).toHaveBeenLastCalledWith(MESSAGE.sandboxPlace, { x: S(61), y: 1 });
      expect(joined.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['suspend', 'disconnect', 'server drop'] as const)(
    'discards a held action on %s',
    async (ending) => {
      let now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const joined = fakeRoom();
        const client = await connectedTo(joined);
        joined.send.mockClear();
        client.pickBlock({ x: S(60), y: 1 });
        now = 1050;
        client.placeBlock({ x: S(61), y: 1 });
        expect(vi.getTimerCount()).toBe(1);

        if (ending === 'suspend') client.suspend();
        else if (ending === 'disconnect') await client.disconnect();
        else joined.left(1006);

        expect(vi.getTimerCount()).toBe(0);
        now = 5000;
        vi.advanceTimersByTime(5000);
        const types = joined.send.mock.calls.map(([type]) => type);
        expect(types).not.toContain(MESSAGE.sandboxPlace);
        if (ending === 'suspend') {
          // Resuming does not resurrect it either.
          client.resume({ x: 10, y: 10 });
          vi.advanceTimersByTime(5000);
          expect(joined.send.mock.calls.map(([type]) => type)).not.toContain(MESSAGE.sandboxPlace);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('sends nothing for a tile that is not an integer sandbox tile', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    joined.send.mockClear();
    let accessorRead = false;
    const accessor = Object.defineProperty({ y: 1 }, 'x', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return S(60);
      },
    });
    for (const tile of [
      null,
      undefined,
      { x: LEFT - 1, y: 1 },
      { x: S(60), y: TOP - 1 },
      { x: S(60) + 0.5, y: 1 },
      { x: Number.POSITIVE_INFINITY, y: 1 },
      { x: String(S(60)), y: 1 },
      accessor,
    ]) {
      expect(() => client.pickBlock(tile as never)).not.toThrow();
      expect(() => client.placeBlock(tile as never)).not.toThrow();
    }
    expect(joined.send).not.toHaveBeenCalled();
    expect(accessorRead).toBe(false);
  });

  it('is a no-op unless connected', async () => {
    const idle = new LobbyClient({ endpoint: 'ws://example', start: { x: 0, y: 0 } });
    expect(() => idle.pickBlock({ x: S(60), y: 1 })).not.toThrow();

    const joined = fakeRoom();
    const client = await connectedTo(joined);
    client.suspend();
    joined.send.mockClear();
    client.pickBlock({ x: S(60), y: 1 });
    client.placeBlock({ x: S(60), y: 1 });
    expect(joined.send).not.toHaveBeenCalled();

    await client.disconnect();
    client.pickBlock({ x: S(60), y: 1 });
    expect(joined.send).not.toHaveBeenCalled();
  });

  it('starts a fresh floor on a new connection, even after a send that closed the room', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const first = fakeRoom();
    const client = await connectedTo(first);
    first.send.mockImplementationOnce(() => first.left(1006));
    client.pickBlock({ x: S(60), y: 1 });
    expect(client.status).toBe('closed');

    const second = fakeRoom();
    vi.spyOn(ColyseusClient.prototype, 'joinOrCreate').mockResolvedValueOnce(second.room as never);
    const reconnecting = client.connect();
    for (let tick = 0; tick < 20 && !second.handles(SERVER_MESSAGE.welcome); tick += 1) {
      await Promise.resolve();
    }
    second.message(SERVER_MESSAGE.welcome, { gameId: OWN });
    await reconnecting;
    second.send.mockClear();
    now += 1;
    client.pickBlock({ x: S(60), y: 1 });
    expect(second.send).toHaveBeenCalledWith(MESSAGE.sandboxPick, { x: S(60), y: 1 });
  });
});

describe('peer snapshots carry a validated colour', () => {
  it('reports a palette index and nothing else', async () => {
    const joined = fakeRoom();
    const peers: Array<[string, unknown]> = [
      ['00000000000000a1', 5],
      ['00000000000000a2', -1],
      ['00000000000000a3', 8],
      ['00000000000000a4', 2.5],
      ['00000000000000a5', '5'],
      ['00000000000000a6', undefined],
    ];
    for (const [gameId, carrying] of peers) joined.state.peers.set(gameId, presence(gameId, carrying));
    const client = await connectedTo(joined);
    const byId = new Map<string, PeerSnapshot>(client.peers().map((peer) => [peer.gameId, peer]));
    expect(byId.get('00000000000000a1')?.carrying).toBe(5);
    for (const [gameId] of peers.slice(1)) expect(byId.get(gameId)?.carrying).toBeNull();
  });
});
