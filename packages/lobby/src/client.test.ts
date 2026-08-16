/**
 * End-to-end tests for the client wrapper, against a real server on a real
 * websocket.
 *
 * These are the tests that can catch a lifecycle mistake, because the thing
 * that goes wrong — a duplicated join, an avatar that stays visible after
 * suspend — only exists once there is a second observer on the other side of
 * a socket.
 */

import { Client as ColyseusClient } from '@colyseus/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameId } from '@strkworld/shared';
import { DEFAULT_ROOM_NAME } from './config';
import { LobbyClient } from './client';
import { startPresenceServer, type PresenceServer } from './server';
import vocabulary from './testing/forbidden-vocabulary.json';

const INTEREST_RADIUS = 300;

let server: PresenceServer;
const opened: LobbyClient[] = [];

function id(n: number): GameId {
  return `ab${String(n).padStart(14, '0')}` as GameId;
}

function makeClient(
  n: number,
  x: number,
  y: number,
  sprite = 'avatar-2',
): LobbyClient {
  const client = new LobbyClient({
    endpoint: server.endpoint,
    gameId: id(n),
    sprite,
    start: { x, y },
    minSendIntervalMs: 10,
  });
  opened.push(client);
  return client;
}

async function waitFor<T>(
  read: () => T,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 5000,
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
    await opened.pop()?.disconnect();
  }
  await settle();
});

afterAll(async () => {
  await server.shutdown();
});

describe('nothing connects by itself', () => {
  it('constructs without opening a connection', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();

    const quiet = makeClient(2, 10, 0);
    expect(quiet.status).toBe('idle');

    await settle();
    expect(observer.peers()).toEqual([]);
  });

  it('subscribes without opening a connection', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();

    const quiet = makeClient(2, 10, 0);
    const seen: number[] = [];
    quiet.onPeers((peers) => seen.push(peers.length));

    await settle();
    expect(quiet.status).toBe('idle');
    expect(seen).toEqual([0]);
    expect(observer.peers()).toEqual([]);
  });

  it('refuses to resume a client that was never connected', () => {
    const quiet = makeClient(2, 10, 0);
    expect(() => quiet.resume({ x: 0, y: 0 })).toThrow(/suspended/);
  });

  it('ignores a position report before connecting', () => {
    const quiet = makeClient(2, 10, 0);
    expect(() => quiet.updatePosition(5, 5, 'up')).not.toThrow();
    expect(quiet.status).toBe('idle');
  });
});

describe('connect is idempotent', () => {
  it('yields one presence entry for two sequential calls', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();

    const walker = makeClient(2, 20, 0);
    await walker.connect();
    await walker.connect();

    const peers = await waitFor(
      () => observer.peers(),
      (list) => list.length > 0,
      'the walker to appear',
    );
    await settle();

    expect(observer.peers()).toHaveLength(1);
    expect(peers[0]?.gameId).toBe(id(2));
  });

  it('yields one presence entry for two concurrent calls', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();

    const walker = makeClient(2, 20, 0);
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
    const observer = makeClient(1, 0, 0);
    await observer.connect();

    const walker = makeClient(2, 20, 0);
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
    const observer = makeClient(1, 0, 0);
    await observer.connect();
    const walker = makeClient(2, 20, 0);
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
      gameId: id(2),
      x: 60,
      y: 40,
      facing: 'right',
      sprite: 'avatar-2',
    });
  });

  it('does not relay a peer outside the interest radius', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();
    const distant = makeClient(2, INTEREST_RADIUS * 10, 0);
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
    const observer = makeClient(1, 0, 0);
    await observer.connect();
    const walker = makeClient(2, 20, 0);
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
    const observer = makeClient(1, 0, 0);
    await observer.connect();
    const walker = makeClient(2, 20, 0);
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

  it('drops a peer when it leaves', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();
    const walker = makeClient(2, 20, 0);
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

describe('the room refuses a hostile join over the wire', () => {
  it('rejects every smuggle attempt offered as an identifier', async () => {
    const sdk = new ColyseusClient(server.endpoint);
    for (const attempt of vocabulary.smuggleAttempts) {
      await expect(
        sdk.joinOrCreate(DEFAULT_ROOM_NAME, {
          gameId: attempt,
          x: 0,
          y: 0,
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects a join with no placement at all', async () => {
    const sdk = new ColyseusClient(server.endpoint);
    await expect(sdk.joinOrCreate(DEFAULT_ROOM_NAME, {})).rejects.toThrow();
  });
});

describe('what arrives at the other client', () => {
  it('carries nothing from the forbidden vocabulary', async () => {
    const observer = makeClient(1, 0, 0);
    await observer.connect();
    const walker = makeClient(2, 20, 0, 'avatar-5');
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
