/**
 * End-to-end tests for the client wrapper, against a real server on a real
 * websocket.
 *
 * These are the tests that can catch a lifecycle mistake, because the thing
 * that goes wrong — a duplicated join, an avatar that stays visible after
 * suspend, a client-set room config — only exists once there is a second
 * observer on the other side of a socket.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import {
  DEFAULT_ROOM_NAME,
  MAX_MESSAGES_PER_SECOND,
  MIN_CLIENT_SEND_INTERVAL_MS,
  WORLD_LIMIT,
} from './config';
import {
  LobbyClient,
  type LobbyClientOptions,
  type LobbyStatusEvent,
  type PeerSnapshot,
} from './client';
import { startPresenceServer, type PresenceServer } from './server';
import type { LobbyState } from './state';
import vocabulary from './testing/forbidden-vocabulary.json';

// One server for the whole file. Colyseus's matchmaker is a process-global, so
// tests that need to shut a server down mid-run, or need a differently
// configured server, live in their own files (client-reconcile, client-drop) —
// one Server per process. See the AGENTS.md finding.
const INTEREST_RADIUS = 300;

let server: PresenceServer;
const opened: LobbyClient[] = [];

function makeClient(x: number, y: number, sprite = 'avatar-2'): LobbyClient {
  const client = new LobbyClient({
    endpoint: server.endpoint,
    sprite,
    start: { x, y },
  });
  opened.push(client);
  return client;
}

async function waitFor<T>(
  read: () => T,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 6000,
): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeRoom(): {
  room: ColyseusRoom<unknown, LobbyState>;
  leave: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  welcome: (payload: { gameId: string }) => void;
  stateChange: () => void;
  error: (code: number, message?: string) => void;
  left: (code: number, reason?: string) => void;
} {
  let welcome: ((payload: { gameId: string }) => void) | undefined;
  let stateChange: (() => void) | undefined;
  let error: ((code: number, message?: string) => void) | undefined;
  let left: ((code: number, reason?: string) => void) | undefined;
  const leave = vi.fn(async () => 0);
  const send = vi.fn();
  const room = {
    state: { peers: new Map() },
    // Matches @colyseus/sdk@0.17.43: automatic reconnection is enabled on
    // every Room unless the consumer turns it off.
    reconnection: { enabled: true },
    leave,
    send,
    onMessage: vi.fn((_type: unknown, callback: (payload: { gameId: string }) => void) => {
      welcome = callback;
      return () => undefined;
    }),
    onStateChange: vi.fn((callback: () => void) => {
      stateChange = callback;
      return () => undefined;
    }),
    onError: vi.fn((callback: (code: number, message?: string) => void) => {
      error = callback;
      return () => undefined;
    }),
    onLeave: vi.fn((callback: (code: number, reason?: string) => void) => {
      left = callback;
      return () => undefined;
    }),
  } as unknown as ColyseusRoom<unknown, LobbyState>;
  return {
    room,
    leave,
    send,
    welcome: (payload) => welcome?.(payload),
    stateChange: () => stateChange?.(),
    error: (code, message) => error?.(code, message),
    left: (code, reason) => left?.(code, reason),
  };
}

it.each(['onStateChange', 'onError', 'onLeave'] as const)(
  'releases a joined room when %s registration fails',
  async (registration) => {
    const joined = fakeRoom();
    vi.mocked(joined.room[registration]).mockImplementationOnce(() => {
      throw new Error(`${registration} registration failed`);
    });
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);
    const client = new LobbyClient({
      endpoint: 'ws://example',
      start: { x: 10, y: 20 },
      welcomeTimeoutMs: 60_000,
    });

    try {
      const connecting = client.connect();
      joined.welcome({ gameId: '0000000000000001' });

      await expect(connecting).rejects.toThrow(`${registration} registration failed`);
      expect(joined.leave).toHaveBeenCalledOnce();
      expect(joined.leave).toHaveBeenCalledWith(true);
      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
    } finally {
      joinOrCreate.mockRestore();
    }
  },
);

it('releases a joined room when disabling SDK reconnection fails', async () => {
  const joined = fakeRoom();
  Object.defineProperty(joined.room, 'reconnection', {
    value: Object.defineProperty({}, 'enabled', {
      set() { throw new Error('reconnection setup failed'); },
    }),
  });
  const joinOrCreate = vi
    .spyOn(ColyseusClient.prototype, 'joinOrCreate')
    .mockResolvedValueOnce(joined.room as never);
  const client = new LobbyClient({ endpoint: 'ws://example', start: { x: 10, y: 20 } });

  try {
    await expect(client.connect()).rejects.toThrow('reconnection setup failed');
    expect(joined.leave).toHaveBeenCalledOnce();
    expect(joined.leave).toHaveBeenCalledWith(true);
    expect(client.status).toBe('closed');
    expect(client.gameId).toBeNull();
  } finally {
    joinOrCreate.mockRestore();
  }
});

/** Give the server a beat to prove it does *not* do something. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 41_000 + Math.floor(Math.random() * 4_000),
    portAttempts: 40,
    room: { interestRadius: INTEREST_RADIUS, minUpdateIntervalMs: 10 },
  });
});

afterEach(async () => {
  while (opened.length > 0) {
    await opened.pop()?.disconnect().catch(() => undefined);
  }
  await settle();
});

afterAll(async () => {
  await server.shutdown();
});

describe('identity is server-assigned', () => {
  it('learns its gameId from the server by the time connect resolves', async () => {
    const client = makeClient(0, 0);
    expect(client.gameId).toBeNull();
    await client.connect();
    expect(client.gameId).not.toBeNull();
    expect(client.gameId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects inherited or accessor-backed welcome identities', async () => {
    const cases: unknown[] = [
      Object.create({ gameId: '0123456789abcdef' }),
    ];
    let accessorRead = false;
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, 'gameId', {
      get: () => {
        accessorRead = true;
        return '0123456789abcdef';
      },
    });
    cases.push(accessorPayload);

    for (const payload of cases) {
      const joined = fakeRoom();
      const joinOrCreate = vi
        .spyOn(ColyseusClient.prototype, 'joinOrCreate')
        .mockResolvedValueOnce(joined.room as never);
      const client = makeClient(20, 0);
      try {
        const connecting = client.connect();
        await Promise.resolve();
        joined.welcome(payload as never);

        await expect(connecting).rejects.toThrow(/welcome/i);
        expect(client.status).toBe('closed');
        expect(client.gameId).toBeNull();
        expect(joined.leave).toHaveBeenCalledOnce();
      } finally {
        joinOrCreate.mockRestore();
      }
    }

    expect(accessorRead).toBe(false);
  });

  it('gives two clients distinct server-assigned ids', async () => {
    const a = makeClient(0, 0);
    const b = makeClient(10, 0);
    await a.connect();
    await b.connect();
    expect(a.gameId).not.toBe(b.gameId);
  });

  it('never publishes the local avatar while its server identity is still arriving', async () => {
    const client = makeClient(0, 0);
    const seen: Array<readonly PeerSnapshot[]> = [];
    client.onPeers((peers) => seen.push(peers));

    await client.connect();

    expect(client.gameId).not.toBeNull();
    expect(seen.flat().some((peer) => peer.gameId === client.gameId)).toBe(false);
  });

  it.each(['', 'not-a-game-id'])('fails closed when the welcome identity is malformed (%j)', async (gameId) => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);

    try {
      const client = makeClient(20, 0);
      const leakedSelf = '0123456789abcdef';
      joined.room.state.peers.set(leakedSelf, {
        gameId: leakedSelf,
        position: { x: 20, y: 0 },
        facing: 'down',
        sprite: 'avatar-1',
      } as never);

      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId });

      await expect(connecting).rejects.toThrow(/welcome/i);
      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
      expect(client.peers()).toEqual([]);
      expect(joined.leave).toHaveBeenCalledWith(true);
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('keeps the first welcome identity across duplicate messages', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);

    try {
      const client = makeClient(20, 0);
      const ownId = '0123456789abcdef';
      const peerId = 'fedcba9876543210';
      joined.room.state.peers.set(ownId, {
        gameId: ownId,
        position: { x: 20, y: 0 },
        facing: 'down',
        sprite: 'avatar-1',
      } as never);
      joined.room.state.peers.set(peerId, {
        gameId: peerId,
        position: { x: 30, y: 0 },
        facing: 'left',
        sprite: 'avatar-2',
      } as never);

      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: ownId });
      await connecting;

      expect(client.gameId).toBe(ownId);
      expect(client.peers().map((peer) => peer.gameId)).toEqual([peerId]);
      joined.welcome({ gameId: peerId });
      joined.welcome({ gameId: ownId });
      expect(client.gameId).toBe(ownId);
      expect(client.peers().map((peer) => peer.gameId)).toEqual([peerId]);
      expect(joined.leave).not.toHaveBeenCalled();
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('isolates peer snapshots from listener mutation', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);

    try {
      const client = makeClient(20, 0);
      const ownId = '0123456789abcdef';
      const peerId = 'fedcba9876543210';
      joined.room.state.peers.set(peerId, {
        gameId: peerId,
        position: { x: 40, y: 72 },
        facing: 'left',
        sprite: 'avatar-2',
      } as never);

      const secondSnapshots: Array<readonly PeerSnapshot[]> = [];
      let mutated = false;
      client.onPeers((snapshot) => {
        if (snapshot.length === 0 || mutated) return;
        mutated = true;
        // Deliberately probe the runtime boundary despite the readonly TS
        // type. Frozen snapshots reject both item and array mutation.
        try {
          const mutable = snapshot as unknown as Array<Record<string, unknown>>;
          mutable[0]!.x = 999;
          mutable.push({
            gameId: '0011223344556677',
            x: 1,
            y: 2,
            facing: 'down',
            sprite: 'avatar-1',
          });
        } catch {
          // Expected once the immutable boundary is enforced.
        }
      });
      client.onPeers((snapshot) => secondSnapshots.push(snapshot));

      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: ownId });
      await connecting;

      const delivered = secondSnapshots.at(-1);
      expect(delivered).toEqual([{
        gameId: peerId,
        x: 40,
        y: 72,
        facing: 'left',
        sprite: 'avatar-2',
      }]);
      expect(Object.isFrozen(delivered)).toBe(true);
      expect(Object.isFrozen(delivered?.[0])).toBe(true);
    } finally {
      joinOrCreate.mockRestore();
    }
  });
});

describe('client send interval configuration', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
    'rejects timer-unsafe interval %s',
    (minSendIntervalMs) => {
      expect(
        () =>
          new LobbyClient({
            endpoint: 'ws://127.0.0.1:2567',
            start: { x: 0, y: 0 },
            minSendIntervalMs,
          }),
      ).toThrow('Lobby client send interval is invalid.');
    },
  );

  it('accepts the exact timer ceiling', () => {
    expect(
      () =>
        new LobbyClient({
          endpoint: 'ws://127.0.0.1:2567',
          start: { x: 0, y: 0 },
          minSendIntervalMs: 2_147_483_647,
        }),
    ).not.toThrow();
  });
});

describe('welcome timeout configuration', () => {
  it('clears the pending welcome timeout when disconnect interrupts a join', async () => {
    vi.useFakeTimers();
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);

    try {
      const client = new LobbyClient({
        endpoint: server.endpoint,
        start: { x: 20, y: 0 },
        welcomeTimeoutMs: 2_147_483_647,
      });
      const connecting = client.connect();
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      expect(joined.room.onMessage).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await client.disconnect();
      await expect(connecting).rejects.toThrow(/interrupted/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      joinOrCreate.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
  ])('rejects timer-unsafe welcome timeout %s', (welcomeTimeoutMs) => {
    expect(() => new LobbyClient({
      endpoint: 'ws://127.0.0.1:2567',
      start: { x: 0, y: 0 },
      welcomeTimeoutMs,
    })).toThrow('Lobby welcome timeout is invalid.');
  });

  it.each([0, 2_147_483_647])('accepts bounded integer welcome timeout %s', (welcomeTimeoutMs) => {
    expect(() => new LobbyClient({
      endpoint: 'ws://127.0.0.1:2567',
      start: { x: 0, y: 0 },
      welcomeTimeoutMs,
    })).not.toThrow();
  });
});

describe('nothing connects by itself', () => {
  it('constructs without opening a connection', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();

    const quiet = makeClient(10, 0);
    expect(quiet.status).toBe('idle');

    await settle();
    expect(observer.peers()).toEqual([]);
  });

  it('subscribes without opening a connection', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();

    const quiet = makeClient(10, 0);
    const seen: number[] = [];
    quiet.onPeers((peers) => seen.push(peers.length));

    await settle();
    expect(quiet.status).toBe('idle');
    expect(seen).toEqual([0]);
    expect(observer.peers()).toEqual([]);
  });

  it('refuses to resume a client that was never connected', () => {
    const quiet = makeClient(10, 0);
    expect(() => quiet.resume({ x: 0, y: 0 })).toThrow(/suspended/);
  });

  it.each([
    ['x', { x: Number.NaN, y: 0 }],
    ['y', { x: 0, y: Number.POSITIVE_INFINITY }],
  ] as const)('does not claim connected when the server rejects a non-finite %s coordinate', async (_axis, placement) => {
    const observer = makeClient(0, 0);
    const walker = makeClient(10, 0);
    await observer.connect();
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );
    walker.suspend();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 0,
      'the walker to disappear',
    );

    expect(() => walker.resume(placement)).toThrow(/placement is invalid/);
    expect(walker.status).toBe('suspended');
    await settle();
    expect(observer.peers()).toEqual([]);
  });

  it('ignores a position report before connecting', () => {
    const quiet = makeClient(10, 0);
    expect(() => quiet.updatePosition(5, 5, 'up')).not.toThrow();
    expect(quiet.status).toBe('idle');
  });
});

describe('connect is idempotent', () => {
  it('owns connection options after construction', async () => {
    const joined = fakeRoom();
    let joinOptions: unknown;
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation((_roomName, options) => {
        joinOptions = options;
        return Promise.resolve(joined.room) as never;
      });
    const options: LobbyClientOptions = {
      endpoint: 'ws://test',
      roomName: 'street',
      start: { x: 20, y: 30, facing: 'right' as const },
      sprite: 'avatar-2',
    };

    try {
      const client = new LobbyClient(options);
      options.roomName = 'attacker-room';
      Reflect.set(options.start, 'x', 999);
      Reflect.set(options.start, 'facing', 'up');
      options.sprite = 'avatar-16';

      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0000000000000010' });
      await connecting;

      expect(joinOptions).toEqual({ x: 20, y: 30, facing: 'right', sprite: 'avatar-2' });
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('disables the SDK automatic retry owner on the joined room', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);

    try {
      const client = makeClient(20, 0);
      const statuses: LobbyStatusEvent[] = [];
      client.onStatus((event) => statuses.push(event));

      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0000000000000001' });
      await connecting;

      expect(joined.room.reconnection.enabled).toBe(false);
      expect(statuses.at(-1)).toEqual({ status: 'connected' });
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('yields one presence entry for two sequential calls', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();

    const walker = makeClient(20, 0);
    await walker.connect();
    await walker.connect();

    const peers = await waitFor(
      () => observer.peers(),
      (list) => list.length > 0,
      'the walker to appear',
    );
    await settle();

    expect(observer.peers()).toHaveLength(1);
    expect(peers[0]?.gameId).toBe(walker.gameId);
  });

  it('yields one presence entry for two concurrent calls', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();

    const walker = makeClient(20, 0);
    await Promise.all([walker.connect(), walker.connect(), walker.connect()]);

    await waitFor(
      () => observer.peers(),
      (list) => list.length > 0,
      'the walker to appear',
    );
    await settle();

    expect(observer.peers()).toHaveLength(1);
    expect(walker.status).toBe('connected');
  });

  it('can connect again after an explicit disconnect', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();

    const walker = makeClient(20, 0);
    await walker.connect();
    await walker.disconnect();
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'exactly one walker after a reconnect',
    );
    await settle();
    expect(observer.peers()).toHaveLength(1);
  });

  it('does not classify a replacement room drop as the prior local leave', async () => {
    const firstRoom = fakeRoom();
    const replacementRoom = fakeRoom();
    const firstLeave = deferred<number>();
    firstRoom.leave.mockImplementationOnce(() => firstLeave.promise);
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate
      .mockImplementationOnce(() => Promise.resolve(firstRoom.room) as never)
      .mockImplementationOnce(() => Promise.resolve(replacementRoom.room) as never);

    try {
      const client = makeClient(20, 0);
      const statuses: LobbyStatusEvent[] = [];
      client.onStatus((event) => statuses.push(event));

      const firstConnecting = client.connect();
      await Promise.resolve();
      firstRoom.welcome({ gameId: '0000000000000002' });
      await firstConnecting;

      const disconnecting = client.disconnect();
      const replacementConnecting = client.connect();
      await Promise.resolve();
      replacementRoom.welcome({ gameId: '0000000000000003' });
      await replacementConnecting;

      replacementRoom.left(1006, 'replacement transport dropped');

      expect(client.status).toBe('closed');
      expect(statuses.at(-1)).toEqual({
        status: 'closed',
        reason: 'server-dropped',
        code: 1006,
      });

      firstLeave.resolve(0);
      await disconnecting;
    } finally {
      firstLeave.resolve(0);
      joinOrCreate.mockRestore();
    }
  });

  it('invalidates a pending join before an explicit reconnect', async () => {
    const firstJoin = deferred<ColyseusRoom<unknown, LobbyState>>();
    const secondJoin = deferred<ColyseusRoom<unknown, LobbyState>>();
    const staleRoom = fakeRoom();
    const freshRoom = fakeRoom();
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate
      .mockImplementationOnce(() => firstJoin.promise as never)
      .mockImplementationOnce(() => secondJoin.promise as never);

    try {
      const client = makeClient(20, 0);
      const statuses: LobbyStatusEvent[] = [];
      const peerSnapshots: Array<readonly PeerSnapshot[]> = [];
      client.onStatus((event) => statuses.push(event));
      client.onPeers((peers) => peerSnapshots.push(peers));

      const pending = client.connect();
      const interrupted = expect(pending).rejects.toThrow(/interrupted/i);
      await Promise.resolve();
      await client.disconnect();
      await interrupted;

      const reconnecting = client.connect();
      firstJoin.resolve(staleRoom.room);
      await Promise.resolve();
      await Promise.resolve();

      expect(staleRoom.leave).toHaveBeenCalledWith(true);
      expect(client.status).toBe('connecting');
      expect(client.gameId).toBeNull();
      expect(statuses.some((event) => event.status === 'connected')).toBe(false);
      expect(peerSnapshots.every((peers) => peers.length === 0)).toBe(true);

      secondJoin.resolve(freshRoom.room);
      await Promise.resolve();
      freshRoom.welcome({ gameId: '0000000000000004' });
      await reconnecting;

      expect(freshRoom.leave).not.toHaveBeenCalled();
      expect(client.status).toBe('connected');
      expect(client.gameId).toBe('0000000000000004');
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('ignores callbacks from a room replaced by an explicit reconnect', async () => {
    vi.useFakeTimers();
    const firstJoin = deferred<ColyseusRoom<unknown, LobbyState>>();
    const secondJoin = deferred<ColyseusRoom<unknown, LobbyState>>();
    const staleRoom = fakeRoom();
    const freshRoom = fakeRoom();
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate
      .mockImplementationOnce(() => firstJoin.promise as never)
      .mockImplementationOnce(() => secondJoin.promise as never);

    try {
      const client = makeClient(20, 0);
      const statuses: LobbyStatusEvent[] = [];
      const peerSnapshots: Array<readonly PeerSnapshot[]> = [];
      client.onStatus((event) => statuses.push(event));
      client.onPeers((peers) => peerSnapshots.push(peers));

      const firstConnecting = client.connect();
      firstJoin.resolve(staleRoom.room);
      await Promise.resolve();
      staleRoom.welcome({ gameId: '0000000000000005' });
      await firstConnecting;

      await client.disconnect();
      const reconnecting = client.connect();
      secondJoin.resolve(freshRoom.room);
      await Promise.resolve();
      freshRoom.welcome({ gameId: '0000000000000004' });
      await reconnecting;

      const statusCount = statuses.length;
      const peerSnapshotCount = peerSnapshots.length;
      client.updatePosition(99, 0, 'right');
      const sentCount = freshRoom.send.mock.calls.length;

      staleRoom.welcome({ gameId: '0000000000000006' });
      staleRoom.stateChange();
      staleRoom.error(500, 'stale error');
      staleRoom.left(400, 'stale leave');

      expect(client.status).toBe('connected');
      expect(client.gameId).toBe('0000000000000004');
      expect(statuses).toHaveLength(statusCount);
      expect(peerSnapshots).toHaveLength(peerSnapshotCount);

      await vi.advanceTimersByTimeAsync(MIN_CLIENT_SEND_INTERVAL_MS);
      expect(freshRoom.send.mock.calls.length).toBeGreaterThan(sentCount);
    } finally {
      joinOrCreate.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects a join immediately when the room errors before welcome, without stale callbacks', async () => {
    const joined = deferred<ColyseusRoom<unknown, LobbyState>>();
    const failedRoom = fakeRoom();
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate.mockImplementationOnce(() => joined.promise as never);

    try {
      const client = new LobbyClient({
        endpoint: server.endpoint,
        start: { x: 20, y: 0 },
        welcomeTimeoutMs: 60_000,
      });
      opened.push(client);
      const statuses: LobbyStatusEvent[] = [];
      const peerSnapshots: Array<readonly PeerSnapshot[]> = [];
      client.onStatus((event) => statuses.push(event));
      client.onPeers((peers) => peerSnapshots.push(peers));

      const connecting = client.connect();
      const rejection = expect(connecting).rejects.toThrow(/error before welcome/i);
      joined.resolve(failedRoom.room);
      await Promise.resolve();
      failedRoom.error(503, 'server unavailable');
      await rejection;
      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
      expect(statuses.map((event) => event.status)).toEqual(['idle', 'connecting', 'connected', 'closed']);

      failedRoom.welcome({ gameId: '0000000000000007' });
      failedRoom.stateChange();
      failedRoom.left(1006, 'leave after error cleanup');
      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
      expect(peerSnapshots.every((peers) => peers.length === 0)).toBe(true);
      expect(failedRoom.leave).toHaveBeenCalledTimes(1);
      expect(failedRoom.leave).toHaveBeenCalledWith(true);
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('shares the pending identity wait with a concurrent caller after the room has joined', async () => {
    const joined = deferred<ColyseusRoom<unknown, LobbyState>>();
    const pendingRoom = fakeRoom();
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate.mockImplementationOnce(() => joined.promise as never);

    try {
      const client = makeClient(20, 0);
      const first = client.connect();
      joined.resolve(pendingRoom.room);
      await Promise.resolve();

      const second = client.connect();
      pendingRoom.error(503, 'same attempt');

      await expect(first).rejects.toThrow(/error before welcome/i);
      await expect(second).rejects.toThrow(/error before welcome/i);
      expect(joinOrCreate).toHaveBeenCalledTimes(1);
      expect(pendingRoom.leave).toHaveBeenCalledTimes(1);
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('rejects a pre-welcome leave promptly, cleans the room once, and reconnects cleanly', async () => {
    const firstJoin = deferred<ColyseusRoom<unknown, LobbyState>>();
    const secondJoin = deferred<ColyseusRoom<unknown, LobbyState>>();
    const failedRoom = fakeRoom();
    const freshRoom = fakeRoom();
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate
      .mockImplementationOnce(() => firstJoin.promise as never)
      .mockImplementationOnce(() => secondJoin.promise as never);

    try {
      const client = makeClient(20, 0);
      const statuses: LobbyStatusEvent[] = [];
      client.onStatus((event) => statuses.push(event));

      const firstConnecting = client.connect();
      firstJoin.resolve(failedRoom.room);
      await Promise.resolve();
      failedRoom.left(1006, 'server restart');
      await expect(firstConnecting).rejects.toThrow(/left before welcome/i);

      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
      expect(failedRoom.leave).not.toHaveBeenCalled();
      expect(statuses.at(-1)).toMatchObject({ status: 'closed', reason: 'server-dropped', code: 1006 });

      const reconnecting = client.connect();
      secondJoin.resolve(freshRoom.room);
      await Promise.resolve();
      freshRoom.welcome({ gameId: '0000000000000008' });
      await reconnecting;

      expect(freshRoom.leave).not.toHaveBeenCalled();
      expect(client.status).toBe('connected');
      expect(client.gameId).toBe('0000000000000008');
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('rejects a joined pre-welcome attempt immediately when explicitly disconnected', async () => {
    const joined = deferred<ColyseusRoom<unknown, LobbyState>>();
    const pendingRoom = fakeRoom();
    const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
    joinOrCreate.mockImplementationOnce(() => joined.promise as never);

    try {
      const client = new LobbyClient({
        endpoint: server.endpoint,
        start: { x: 20, y: 0 },
        welcomeTimeoutMs: 50,
      });
      opened.push(client);
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      const connecting = client.connect();
      void connecting.then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        },
      );
      joined.resolve(pendingRoom.room);
      await Promise.resolve();

      await client.disconnect();
      await Promise.resolve();

      expect(outcome).toBe('rejected');
      await expect(connecting).rejects.toThrow(/interrupted/i);
      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
      expect(pendingRoom.leave).toHaveBeenCalledTimes(1);
      expect(pendingRoom.leave).toHaveBeenCalledWith(true);

      pendingRoom.welcome({ gameId: '0000000000000009' });
      pendingRoom.stateChange();
      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it.each([
    ['error', (room: ReturnType<typeof fakeRoom>) => room.error(503, 'same-turn error')],
    ['leave', (room: ReturnType<typeof fakeRoom>) => room.left(1006, 'same-turn leave')],
  ] as const)(
    'does not resolve connect when welcome is followed by a same-turn %s',
    async (label, terminate) => {
      const joined = deferred<ColyseusRoom<unknown, LobbyState>>();
      const terminalRoom = fakeRoom();
      const joinOrCreate = vi.spyOn(ColyseusClient.prototype, 'joinOrCreate');
      joinOrCreate.mockImplementationOnce(() => joined.promise as never);

      try {
        const client = makeClient(20, 0);
        const connecting = client.connect();
        joined.resolve(terminalRoom.room);
        await Promise.resolve();

        terminalRoom.welcome({ gameId: '000000000000000a' });
        terminate(terminalRoom);

        await expect(connecting).rejects.toThrow(/before connect completed/i);
        expect(client.status).toBe('closed');
        expect(client.gameId).toBeNull();
        expect(terminalRoom.leave).toHaveBeenCalledTimes(label === 'error' ? 1 : 0);
      } finally {
        joinOrCreate.mockRestore();
      }
    },
  );
});

it('clears peer listeners even when room leave fails during disconnect', async () => {
  const joined = fakeRoom();
  const joinOrCreate = vi
    .spyOn(ColyseusClient.prototype, 'joinOrCreate')
    .mockResolvedValueOnce(joined.room as never);

  try {
    const client = makeClient(20, 0);
    const peerSnapshots: Array<readonly PeerSnapshot[]> = [];
    client.onPeers((peers) => peerSnapshots.push(peers));

    const connecting = client.connect();
    await Promise.resolve();
    joined.welcome({ gameId: '0000000000000009' });
    await connecting;
    joined.room.state.peers.set('000000000000000a', {
      gameId: '000000000000000a',
      position: { x: 25, y: 30 },
      facing: 'right',
      sprite: 'avatar-2',
    } as never);
    joined.stateChange();
    expect(peerSnapshots.at(-1)).toHaveLength(1);

    const leaveError = new Error('transport leave failed');
    joined.leave.mockRejectedValueOnce(leaveError);
    await expect(client.disconnect()).rejects.toBe(leaveError);

    expect(client.status).toBe('closed');
    expect(client.gameId).toBeNull();
    expect(peerSnapshots.at(-1)).toEqual([]);
  } finally {
    joinOrCreate.mockRestore();
  }
});

describe('presence', () => {
  it.each([
    ['x', Number.NaN, 0],
    ['y', 0, Number.POSITIVE_INFINITY],
    ['x negative infinity', Number.NEGATIVE_INFINITY, 0],
  ] as const)('does not send a non-finite %s update', async (_axis, x, y) => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const client = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcde0' });
      await connecting;
      timer.mockClear();

      client.updatePosition(x, y, 'right');

      expect(joined.send).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      await client.disconnect();
      timer.mockRestore();
      joinOrCreate.mockRestore();
    }
  });

  it('clamps finite movement to the server world limit before reconciliation', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);
    const client = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;

      client.updatePosition(9_000, -9_000, 'right');
      expect(joined.send).toHaveBeenCalledWith('move', {
        x: WORLD_LIMIT,
        y: -WORLD_LIMIT,
        facing: 'right',
      });

      joined.room.state.peers.set('0123456789abcdef', {
        gameId: '0123456789abcdef',
        position: { x: WORLD_LIMIT, y: -WORLD_LIMIT },
        facing: 'right',
        sprite: 'avatar-1',
      } as never);
      joined.stateChange();
      expect(joined.send).toHaveBeenCalledTimes(1);
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
    }
  });

  it.each([
    ['unknown string', 'diagonal'],
    ['coercible object', { toString: (): string => 'left' }],
  ] as const)('normalizes a malformed %s movement facing before reconciliation', async (_label, facing) => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);
    const client = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;

      client.updatePosition(10, 20, facing as never);
      expect(joined.send).toHaveBeenCalledWith('move', {
        x: 10,
        y: 20,
        facing: 'down',
      });

      joined.room.state.peers.set('0123456789abcdef', {
        gameId: '0123456789abcdef',
        position: { x: 10, y: 20 },
        facing: 'down',
        sprite: 'avatar-1',
      } as never);
      joined.stateChange();
      expect(joined.send).toHaveBeenCalledTimes(1);
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
    }
  });

  it('does not schedule reconciliation after move synchronously closes its room', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockResolvedValueOnce(joined.room as never);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const client = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;
      timer.mockClear();
      joined.send.mockImplementationOnce((message: string) => {
        expect(message).toBe('move');
        joined.left(1006);
      });

      client.updatePosition(10, 0, 'right');

      expect(client.status).toBe('closed');
      expect(timer).not.toHaveBeenCalled();
    } finally {
      await client.disconnect();
      timer.mockRestore();
      joinOrCreate.mockRestore();
    }
  });
  it('keeps reconciliation timers within the timer ceiling through clock rollback', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const client = new LobbyClient({
      endpoint: server.endpoint,
      start: { x: 0, y: 0 },
      minSendIntervalMs: 2_147_483_647,
    });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '000000000000000b' });
      await connecting;
      timer.mockClear();

      client.updatePosition(10, 0, 'right');
      now = 900;
      client.updatePosition(20, 0, 'left');
      now = 2_147_484_647;
      joined.stateChange();

      expect(timer.mock.calls.map((call) => call[1])).toEqual([
        2_147_483_647,
        2_147_483_647,
        2_147_483_647,
      ]);
      expect(joined.send).toHaveBeenCalledTimes(2);
      expect(joined.send).toHaveBeenLastCalledWith('move', {
        x: 20,
        y: 0,
        facing: 'left',
      });
    } finally {
      await client.disconnect();
      timer.mockRestore();
      joinOrCreate.mockRestore();
      clock.mockRestore();
    }
  });

  it('keeps its send floor through clock rollback and reconciles the latest placement', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const client = new LobbyClient({
      endpoint: server.endpoint,
      start: { x: 0, y: 0 },
    });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '000000000000000c' });
      await connecting;

      client.updatePosition(10, 0, 'right');
      expect(joined.send).toHaveBeenCalledTimes(1);

      now = 900;
      client.updatePosition(20, 0, 'left');
      joined.stateChange();
      now = 1000;
      joined.stateChange();
      now = 1049;
      joined.stateChange();
      expect(joined.send).toHaveBeenCalledTimes(1);

      now = 1050;
      joined.stateChange();
      expect(joined.send).toHaveBeenCalledTimes(2);
      expect(joined.send).toHaveBeenLastCalledWith('move', {
        x: 20,
        y: 0,
        facing: 'left',
      });
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
      clock.mockRestore();
    }
  });

  it('relays position updates to a nearby peer', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0);
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );

    walker.updatePosition(60, 40, 'right');

    const peers = await waitFor(
      () => observer.peers(),
      (list) => list[0]?.x === 60,
      'the walker to move',
    );
    expect(peers[0]).toEqual({
      gameId: walker.gameId,
      x: 60,
      y: 40,
      facing: 'right',
      sprite: 'avatar-2',
    });
  });

  it('does not relay a peer outside the interest radius', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const distant = makeClient(INTEREST_RADIUS * 10, 0);
    await distant.connect();

    await settle();
    expect(observer.peers()).toEqual([]);

    distant.updatePosition(50, 0, 'left');
    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the distant peer to come into range',
    );
  });

  it('removes the avatar from another client’s view on suspend', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0);
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );

    walker.suspend();
    expect(walker.status).toBe('suspended');

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 0,
      'the walker to disappear',
    );
    await settle();
    expect(observer.peers()).toEqual([]);
  });

  it('does not restore suspended status when transport leaves during suspend send', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);

    try {
      const client = new LobbyClient({ endpoint: 'ws://test', start: { x: 20, y: 0 } });
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '000000000000000f' });
      await connecting;

      joined.send.mockImplementationOnce(() => joined.left(1006, 'transport dropped'));
      client.suspend();

      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('brings the avatar back on an explicit resume', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0);
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );
    walker.suspend();
    await waitFor(
      () => observer.peers(),
      (list) => list.length === 0,
      'the walker to disappear',
    );

    walker.resume({ x: 40, y: 40, facing: 'up' });
    const peers = await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to reappear',
    );
    expect(peers[0]?.x).toBe(40);
    expect(peers[0]?.facing).toBe('up');
  });

  it('clamps an out-of-bounds resumed placement before sending it to the room', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);
    const client = makeClient(20, 0);

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;
      client.suspend();

      client.resume({ x: WORLD_LIMIT + 1_000, y: -WORLD_LIMIT - 1_000 });

      expect(joined.send).toHaveBeenLastCalledWith('resume', {
        x: WORLD_LIMIT,
        y: -WORLD_LIMIT,
        facing: 'down',
        sprite: 'avatar-2',
      });
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
    }
  });

  it.each([
    ['unknown string', 'diagonal'],
    ['coercible object', { toString: (): string => 'left' }],
  ] as const)('normalizes a malformed resumed %s facing before sending it to the room', async (_label, facing) => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);
    const client = makeClient(20, 0);

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;
      client.suspend();

      client.resume({ x: 40, y: 40, facing: facing as never });

      expect(joined.send).toHaveBeenLastCalledWith('resume', {
        x: 40,
        y: 40,
        facing: 'down',
        sprite: 'avatar-2',
      });
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
    }
  });

  it.each([null, undefined])('rejects a nullish resumed placement with the controlled error', async (placement) => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);
    const client = makeClient(20, 0);

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;
      client.suspend();

      expect(() => client.resume(placement as never)).toThrow('Lobby resume placement is invalid.');
      expect(joined.send).toHaveBeenLastCalledWith('suspend');
      expect(client.status).toBe('suspended');
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
    }
  });

  it.each(['x', 'y'] as const)('rejects an accessor-backed resumed %s coordinate without invoking it', async (axis) => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);
    const client = makeClient(20, 0);
    let accessed = false;
    const placement = { x: 40, y: 40, facing: 'up' as const };
    Object.defineProperty(placement, axis, {
      configurable: true,
      get: () => {
        accessed = true;
        throw new Error(`unexpected ${axis} accessor`);
      },
    });

    try {
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '0123456789abcdef' });
      await connecting;
      client.suspend();

      expect(() => client.resume(placement)).toThrow('Lobby resume placement is invalid.');
      expect(accessed).toBe(false);
      expect(joined.send).toHaveBeenLastCalledWith('suspend');
      expect(client.status).toBe('suspended');
    } finally {
      await client.disconnect();
      joinOrCreate.mockRestore();
    }
  });

  it('does not restore connected status when transport leaves during resume send', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);

    try {
      const client = new LobbyClient({ endpoint: 'ws://test', start: { x: 20, y: 0 } });
      const connecting = client.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '000000000000000e' });
      await connecting;
      client.suspend();

      joined.send.mockImplementationOnce(() => joined.left(1006, 'transport dropped'));
      client.resume({ x: 40, y: 40, facing: 'up' });

      expect(client.status).toBe('closed');
      expect(client.gameId).toBeNull();
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('delivers a reentrant suspend after the resume transition to every subscriber', async () => {
    const walker = makeClient(20, 0);
    await walker.connect();
    walker.suspend();

    const first: LobbyStatusEvent[] = [];
    const second: LobbyStatusEvent[] = [];
    walker.onStatus((event) => {
      first.push(event);
      if (event.status === 'connected') walker.suspend();
    });
    walker.onStatus((event) => second.push(event));
    first.length = 0;
    second.length = 0;

    walker.resume({ x: 40, y: 40, facing: 'up' });

    expect(walker.status).toBe('suspended');
    expect(first).toEqual([{ status: 'connected' }, { status: 'suspended' }]);
    expect(second).toEqual([{ status: 'connected' }, { status: 'suspended' }]);
  });

  it('delivers reentrant peer snapshots in order to every subscriber', async () => {
    const joined = fakeRoom();
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(() => Promise.resolve(joined.room) as never);

    try {
      const walker = makeClient(20, 0);
      const first: string[][] = [];
      const second: string[][] = [];
      walker.onPeers((peers) => {
        first.push(peers.map(({ gameId }) => gameId));
        if (peers.length !== 1 || peers[0]?.gameId !== 'peer-a') return;
        joined.room.state.peers.set(
          'peer-b',
          {
            gameId: 'peer-b',
            position: { x: 40, y: 40 },
            facing: 'up',
            sprite: 'avatar-3',
          } as never,
        );
        joined.stateChange();
      });
      walker.onPeers((peers) => second.push(peers.map(({ gameId }) => gameId)));

      const connecting = walker.connect();
      await Promise.resolve();
      joined.welcome({ gameId: '000000000000000d' });
      await connecting;
      first.length = 0;
      second.length = 0;

      joined.room.state.peers.set(
        'peer-a',
        {
          gameId: 'peer-a',
          position: { x: 30, y: 30 },
          facing: 'down',
          sprite: 'avatar-2',
        } as never,
      );
      joined.stateChange();

      expect(first).toEqual([['peer-a'], ['peer-a', 'peer-b']]);
      expect(second).toEqual([['peer-a'], ['peer-a', 'peer-b']]);
    } finally {
      joinOrCreate.mockRestore();
    }
  });

  it('resumes with an explicitly selected approved sprite', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0, 'avatar-2');
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );
    walker.suspend();
    await waitFor(
      () => observer.peers(),
      (list) => list.length === 0,
      'the walker to disappear',
    );

    walker.resume({ x: 40, y: 40, facing: 'up' }, 'avatar-16');
    const peers = await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to reappear with its selected sprite',
    );
    expect(peers[0]?.sprite).toBe('avatar-16');
  });

  it('preserves the configured sprite when resume omits a selection', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0, 'avatar-9');
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list[0]?.sprite === 'avatar-9',
      'the configured sprite to appear',
    );
    walker.suspend();
    await waitFor(
      () => observer.peers(),
      (list) => list.length === 0,
      'the walker to disappear',
    );

    walker.resume({ x: 40, y: 40, facing: 'up' });
    const peers = await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to reappear with its configured sprite',
    );
    expect(peers[0]?.sprite).toBe('avatar-9');
  });

  it('drops a peer when it leaves', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0);
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );
    await walker.disconnect();
    await waitFor(
      () => observer.peers(),
      (list) => list.length === 0,
      'the walker to be forgotten',
    );
  });
});

describe('a client cannot set the room configuration over the wire (BLOCKER 1)', () => {
  it('a hostile first join does not put money on an honest player’s screen', async () => {
    const evil = '0xdeadbeefcafef00d 12.5 STRK to the Bank';

    // The attacker creates the room with a hostile config as ordinary join
    // options — exactly the proven exploit. They never need to do more.
    const attacker = new ColyseusClient(server.endpoint);
    const attackerRoom = await attacker.joinOrCreate(DEFAULT_ROOM_NAME, {
      x: 0,
      y: 0,
      spriteKeys: [evil],
      defaultSprite: evil,
      capacity: 99999,
      interestRadius: 1_000_000,
    });

    // Two honest players join the same room and stand near each other.
    const a = makeClient(0, 0, 'avatar-2');
    const b = makeClient(20, 0, 'avatar-3');
    await a.connect();
    await b.connect();

    const seen = await waitFor(
      () => a.peers(),
      (list) => list.some((p) => p.gameId === b.gameId),
      'the other honest player to appear',
    );

    // The hostile string reached no one; sprites are the trusted values.
    const surface = JSON.stringify([a.peers(), b.peers()]);
    expect(surface).not.toContain('STRK');
    expect(surface).not.toContain('Bank');
    expect(surface).not.toContain('0xdead');
    expect(seen.find((p) => p.gameId === b.gameId)?.sprite).toBe('avatar-3');

    // The hostile interestRadius (1e6) did not take effect either: a peer
    // far past the trusted 300px radius stays invisible.
    const distant = makeClient(INTEREST_RADIUS * 5, 0);
    await distant.connect();
    await settle();
    expect(a.peers().some((p) => p.gameId === distant.gameId)).toBe(false);

    await attackerRoom.leave(true).catch(() => undefined);
  });

  it('rejects a join with no placement at all', async () => {
    const sdk = new ColyseusClient(server.endpoint);
    await expect(sdk.joinOrCreate(DEFAULT_ROOM_NAME, {})).rejects.toThrow();
  });
});

describe('the client cannot flood itself into a disconnect (BLOCKER 3)', () => {
  it('stays connected while updatePosition is driven far above the server ceiling', async () => {
    // The default hard ceiling is 40 messages/second. Ask the client for an
    // absurd 1ms send interval and drive updatePosition every ~8ms for well
    // over a second — ~150 calls that, unfloored, would blow past 40/s and be
    // force-closed. The client's floor holds it to a safe rate.
    expect(MIN_CLIENT_SEND_INTERVAL_MS).toBeGreaterThanOrEqual(
      Math.ceil(1000 / MAX_MESSAGES_PER_SECOND),
    );

    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = new LobbyClient({
      endpoint: server.endpoint,
      start: { x: 20, y: 0 },
      minSendIntervalMs: 1,
    });
    opened.push(walker);
    await walker.connect();

    let x = 20;
    for (let i = 0; i < 150; i += 1) {
      x += 1;
      walker.updatePosition(x, 0, 'right');
      await new Promise((r) => setTimeout(r, 8));
    }

    expect(walker.status).toBe('connected');
    // And the final position still lands.
    await waitFor(
      () => observer.peers(),
      (list) => list.some((p) => p.gameId === walker.gameId && p.x === x),
      'the final position to land',
    );
  }, 20000);
});

describe('the consumer can tell a local leave apart (DEFECT 9)', () => {
  it('reports client-left on an explicit disconnect', async () => {
    const client = makeClient(0, 0);
    const events: LobbyStatusEvent[] = [];
    client.onStatus((e) => events.push(e));
    await client.connect();
    await client.disconnect();

    const last = events.at(-1);
    expect(last?.status).toBe('closed');
    expect(last?.reason).toBe('client-left');
  });
});

describe('what arrives at the other client', () => {
  it('carries nothing from the forbidden vocabulary', async () => {
    const observer = makeClient(0, 0);
    await observer.connect();
    const walker = makeClient(20, 0, 'avatar-5');
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );
    walker.updatePosition(80, 90, 'down');
    await waitFor(
      () => observer.peers(),
      (list) => list[0]?.x === 80,
      'the walker to move',
    );

    const received = JSON.stringify(observer.peers()).toLowerCase();
    for (const word of vocabulary.substrings) {
      expect(received, `received ${word}`).not.toContain(word);
    }
    for (const pattern of vocabulary.patterns) {
      expect(new RegExp(pattern.regex).test(received)).toBe(false);
    }
  });
});
