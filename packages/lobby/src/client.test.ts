/**
 * End-to-end tests for the client wrapper, against a real server on a real
 * websocket.
 *
 * These are the tests that can catch a lifecycle mistake, because the thing
 * that goes wrong — a duplicated join, an avatar that stays visible after
 * suspend, a client-set room config — only exists once there is a second
 * observer on the other side of a socket.
 */

import { Client as ColyseusClient } from '@colyseus/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOM_NAME,
  MAX_MESSAGES_PER_SECOND,
  MIN_CLIENT_SEND_INTERVAL_MS,
} from './config';
import { LobbyClient, type LobbyStatusEvent, type PeerSnapshot } from './client';
import { startPresenceServer, type PresenceServer } from './server';
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

  it('ignores a position report before connecting', () => {
    const quiet = makeClient(10, 0);
    expect(() => quiet.updatePosition(5, 5, 'up')).not.toThrow();
    expect(quiet.status).toBe('idle');
  });
});

describe('connect is idempotent', () => {
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
});

describe('presence', () => {
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
