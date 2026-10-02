/**
 * D-114: the LobbyClient's arena API against a real server. The intents go
 * only from the arena and are held to their client floors; an attack lets a
 * waiting position (and its facing) go first; the ring is validated and fails
 * closed; subscribers are isolated.
 *
 * A file of its own because it needs its own server: the matchmaker is a
 * process-global (see the AGENTS.md finding).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { Room as SdkRoom } from '@colyseus/sdk';
import {
  ARENA_ATTACK_CLIENT_INTERVAL_MS,
  ARENA_INTENT_CLIENT_INTERVAL_MS,
  ARENA_MAX_HP,
  arenaTileCentre,
  type ArenaRingSnapshot,
} from '@strkworld/shared';
import { LobbyClient } from './client';
import {
  FOOTBALL_CLIENT_KICK_INTERVAL_MS,
  JUMP_CLIENT_INTERVAL_MS,
  MAX_MESSAGES_PER_SECOND,
  MESSAGE,
  MIN_CLIENT_SEND_INTERVAL_MS,
  SANDBOX_CLIENT_ACTION_INTERVAL_MS,
} from './config';
import type { PresenceRoom } from './room';
import { startPresenceServer, type PresenceServer } from './server';
import type { ArenaRingEntry } from './state';

const WIRE_TIMEOUT_MS = 20_000;
let server: PresenceServer;
const opened: LobbyClient[] = [];
const at = (x: number, y: number) => arenaTileCentre({ x, y });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<V>(read: () => V, ready: (value: V) => boolean, label: string, timeoutMs = 8000): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function joined(): Promise<LobbyClient> {
  const client = new LobbyClient({ endpoint: server.endpoint, sprite: 'avatar-2', start: { x: 100, y: 100, facing: 'down' } });
  opened.push(client);
  await client.connect();
  return client;
}

async function inArena(tile = { x: 20, y: 22 }): Promise<LobbyClient> {
  const client = await joined();
  client.enterArea('arena', { ...at(tile.x, tile.y), facing: 'up' }, 'avatar-3');
  await waitFor(() => client.arena(), (ring) => ring !== null, 'the ring');
  return client;
}

async function roomOf(client: LobbyClient): Promise<PresenceRoom> {
  for (const cached of await matchMaker.query({ name: server.roomName })) {
    const room = matchMaker.getLocalRoomById(cached.roomId) as PresenceRoom | undefined;
    if (room !== undefined && room.state.peers.has(client.gameId as string)) return room;
  }
  throw new Error('no local room holds the client');
}

const sent = (spy: { mock: { calls: unknown[][] } }, type: string) => spy.mock.calls.filter(([name]) => name === type).length;

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 43_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: { minUpdateIntervalMs: 10 },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
});

afterAll(async () => {
  await Promise.all(matchMaker.disconnectAll());
  await server?.shutdown();
});

describe('the arena intents (D-114)', () => {
  it('send nothing unless live in the arena', async () => {
    const idle = new LobbyClient({ endpoint: server.endpoint, start: { x: 100, y: 100 } });
    expect(idle.arenaClaim()).toBe(false);
    expect(idle.arenaAttack()).toBe(false);
    expect(idle.arenaLeave()).toBe(false);
    expect(idle.arena()).toBeNull();

    const walker = await joined();
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    expect(walker.arenaClaim()).toBe(false);
    expect(walker.arenaAttack()).toBe(false);
    expect(walker.arenaLeave()).toBe(false);
    expect(walker.arena()).toBeNull();
    walker.suspend();
    expect(walker.arenaClaim()).toBe(false);
    expect(send.mock.calls.filter(([type]) => String(type).startsWith('arena:'))).toEqual([]);
  }, WIRE_TIMEOUT_MS);

  it('hold claim and leave to one shared client floor, and attacks to their own', async () => {
    const client = await inArena({ x: 12, y: 16 });
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    // Off the approach, so the room refuses the claim; the client floor is the subject here.
    expect(client.arenaClaim()).toBe(true);
    expect(client.arenaClaim()).toBe(false);
    expect(client.arenaLeave()).toBe(false);
    expect(client.arenaAttack()).toBe(true);
    expect(client.arenaAttack()).toBe(false);
    expect(sent(send, MESSAGE.arenaClaim)).toBe(1);
    expect(sent(send, MESSAGE.arenaLeave)).toBe(0);
    expect(sent(send, MESSAGE.arenaAttack)).toBe(1);
    await sleep(ARENA_ATTACK_CLIENT_INTERVAL_MS + 20);
    expect(client.arenaAttack()).toBe(true);
    expect(client.arenaLeave()).toBe(false);
    await sleep(ARENA_INTENT_CLIENT_INTERVAL_MS - ARENA_ATTACK_CLIENT_INTERVAL_MS + 20);
    expect(client.arenaLeave()).toBe(true);
    expect(sent(send, MESSAGE.arenaLeave)).toBe(1);
    // Every arena intent goes with no payload at all.
    for (const [type, payload] of send.mock.calls) {
      if (String(type).startsWith('arena:')) expect(payload).toBeUndefined();
    }
    // Nothing changed in the room: the claim came from the stands.
    expect(client.arena()).toMatchObject({ phase: 'idle' });
  }, WIRE_TIMEOUT_MS);

  it('an attack lets a waiting position go first, so the room judges the facing the player sees', async () => {
    const client = await inArena();
    expect(client.arenaClaim()).toBe(true);
    await waitFor(() => client.arena(), (ring) => ring?.phase === 'countdown', 'the countdown');
    const room = await roomOf(client);
    const held = () => room.state.peers.get(client.gameId as string);
    // Beside the dummy, facing away from it.
    client.updatePosition(at(20, 15).x, at(20, 15).y, 'down');
    await waitFor(() => held()?.facing, (facing) => facing === 'down' && held()?.position.y === at(20, 15).y, 'facing away');
    await waitFor(() => client.arena(), (ring) => ring?.phase === 'fighting', 'the fight', 5000);
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    // Turn to face it and swing in the same frame.
    client.updatePosition(at(20, 15).x, at(20, 15).y, 'up');
    expect(client.arenaAttack()).toBe(true);
    const ring = await waitFor(() => client.arena(), (value) => (value?.challenger.swings ?? 0) >= 1, 'the swing');
    const order = send.mock.calls.map(([type]) => type).filter((type) => type === MESSAGE.move || type === MESSAGE.arenaAttack);
    expect(order.indexOf(MESSAGE.move)).toBeLessThan(order.indexOf(MESSAGE.arenaAttack));
    await waitFor(() => client.arena(), (value) => value?.opponent.hp === ARENA_MAX_HP - 10, 'the hit');
    expect(ring?.challenger.gameId).toBe(client.gameId);
    expect(client.arenaLeave()).toBe(true);
  }, WIRE_TIMEOUT_MS);
});

describe('the ring snapshot (D-114)', () => {
  it('is frozen, the same object while unchanged, and fails closed on a malformed entry', async () => {
    const client = await inArena({ x: 12, y: 16 });
    const first = client.arena();
    expect(first).not.toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.challenger)).toBe(true);
    expect(client.arena()).toBe(first);

    const room = await roomOf(client);
    const ring = room.state.arena.get('ring') as ArenaRingEntry;
    const corrupt = async (label: string, apply: () => void, restore: () => void) => {
      apply();
      await waitFor(() => client.arena(), (value) => value === null, `${label}: null`);
      restore();
      await waitFor(() => client.arena(), (value) => value !== null, `${label}: restored`);
    };
    await corrupt('a phase off the table', () => { ring.phase = 9; }, () => { ring.phase = 0; });
    await corrupt('a result while idle', () => { ring.reason = 1; }, () => { ring.reason = 0; });
    await corrupt('a winner with no reason', () => { ring.winner = 1; }, () => { ring.winner = 0; });
    await corrupt('a presence id on an empty slot', () => { ring.challenger.gameId = 'abc'; }, () => { ring.challenger.gameId = ''; });
    await corrupt('hp over the maximum', () => { ring.opponent.hp = 200; }, () => { ring.opponent.hp = 0; });
    await corrupt('seconds left while idle', () => { ring.secondsLeft = 5; }, () => { ring.secondsLeft = 0; });
  }, WIRE_TIMEOUT_MS);

  it('onArena fires at once, on every change and with null on leaving; a throwing subscriber is isolated', async () => {
    const client = await inArena();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: (ArenaRingSnapshot | null)[] = [];
    client.onArena(() => {
      throw new Error('subscriber failed');
    });
    const stop = client.onArena((ring) => seen.push(ring));
    expect(seen).toHaveLength(1);
    expect(client.arenaClaim()).toBe(true);
    await waitFor(() => seen.at(-1)?.phase, (phase) => phase === 'countdown', 'the countdown delivered');
    expect(consoleError).toHaveBeenCalledWith('lobby client: arena subscriber threw');
    client.enterArea('street', { x: 100, y: 100, facing: 'down' });
    expect(seen.at(-1)).toBeNull();
    stop();
    const count = seen.length;
    client.enterArea('arena', { ...at(12, 16), facing: 'up' });
    await sleep(200);
    expect(seen).toHaveLength(count);
  }, WIRE_TIMEOUT_MS);
});

describe('the message budget (D-114)', () => {
  it('every client floor at once stays under the room’s 40 a second', () => {
    const perSecond = (intervalMs: number) => 1000 / intervalMs;
    const budget =
      perSecond(MIN_CLIENT_SEND_INTERVAL_MS) + // moves: 20
      perSecond(SANDBOX_CLIENT_ACTION_INTERVAL_MS) + // pick/place: 5
      perSecond(FOOTBALL_CLIENT_KICK_INTERVAL_MS) + // kicks: 3.3
      perSecond(JUMP_CLIENT_INTERVAL_MS) + // jumps: 1.2
      perSecond(ARENA_ATTACK_CLIENT_INTERVAL_MS) + // attacks: 2.2
      perSecond(ARENA_INTENT_CLIENT_INTERVAL_MS); // claim/leave: 1
    expect(budget).toBeCloseTo(32.7, 1);
    expect(budget).toBeLessThan(MAX_MESSAGES_PER_SECOND);
  });
});
