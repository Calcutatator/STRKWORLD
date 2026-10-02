/**
 * D-106: the client side of a refused climb. The room sends `resync` with the
 * position it holds; the client validates it, stops re-sending the refused
 * position and hands the held one to its subscribers, only while live on the
 * street.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import { MESSAGE, SERVER_MESSAGE } from './config';
import { LobbyClient } from './client';
import type { LobbyState } from './state';

const OWN = '0123456789abcdef';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const moves = (joined: FakeRoom) => joined.send.mock.calls.filter(([type]) => type === MESSAGE.move).length;

describe('resync (D-106)', () => {
  it('delivers the held position, frozen, and stops re-sending the refused one', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const heard: unknown[] = [];
    client.onResync((position) => heard.push(position));
    client.updatePosition(4000, 450, 'right');
    expect(moves(joined)).toBe(1);
    joined.message(SERVER_MESSAGE.resync, { x: 3990, y: 450 });
    expect(heard).toEqual([{ x: 3990, y: 450 }]);
    expect(Object.isFrozen(heard[0])).toBe(true);
    // The refused position is not re-sent: the World reports the held one next.
    await sleep(160);
    expect(moves(joined)).toBe(1);
  });

  it('ignores anything but a finite, whole, in-world position read from own data properties', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const heard: unknown[] = [];
    client.onResync((position) => heard.push(position));
    const accessor = Object.defineProperty({ y: 10 }, 'x', { get: () => 10, enumerable: true });
    for (const payload of [null, 'x', [], { x: 1 }, { x: Number.NaN, y: 1 }, { x: 1.5, y: 2 }, { x: '1', y: 2 }, { x: 1e9, y: 2 }, accessor]) {
      joined.message(SERVER_MESSAGE.resync, payload);
    }
    expect(heard).toEqual([]);
  });

  it('is silent off the street, and after unsubscribing', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const heard: unknown[] = [];
    const stop = client.onResync((position) => heard.push(position));
    client.suspend();
    joined.message(SERVER_MESSAGE.resync, { x: 10, y: 10 });
    expect(heard).toEqual([]);
    client.resume({ x: 10, y: 10 });
    stop();
    joined.message(SERVER_MESSAGE.resync, { x: 10, y: 10 });
    expect(heard).toEqual([]);
  });

  it('keeps delivering when one subscriber throws', async () => {
    const joined = fakeRoom();
    const client = await connectedTo(joined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const heard: unknown[] = [];
    client.onResync(() => {
      throw new Error('boom');
    });
    client.onResync((position) => heard.push(position));
    joined.message(SERVER_MESSAGE.resync, { x: 12, y: 34 });
    expect(heard).toEqual([{ x: 12, y: 34 }]);
    expect(error).toHaveBeenCalledWith('lobby client: resync subscriber threw');
  });
});
