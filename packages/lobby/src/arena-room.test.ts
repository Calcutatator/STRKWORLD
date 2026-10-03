/**
 * D-114 end to end: the arena ring through the real room, the real websocket
 * and the real `LobbyClient`. A fighter claims, swings ten times and wins, all
 * by state; a spectator sees the same fight; a second claim while busy
 * changes nothing; a disconnect opens the ring; only arena members are ever
 * sent the ring; a look change racing the claim keeps the room's position;
 * and an attack flood is cut off by the room's message ceiling.
 *
 * A file of its own because it needs its own server: the matchmaker is a
 * process-global (see the AGENTS.md finding). Negative checks wait for a
 * later patch first, never for a guessed time.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { Client as ColyseusClient } from '@colyseus/sdk';
import {
  ARENA_ATTACK_CLIENT_INTERVAL_MS,
  ARENA_MAX_HP,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  arenaTileCentre,
  type ArenaRingSnapshot,
} from '@strkworld/shared';
import { LobbyClient } from './client';
import { MAX_MESSAGES_PER_SECOND, MESSAGE } from './config';
import type { PresenceRoom } from './room';
import type { LobbyState } from './state';
import { startPresenceServer, type PresenceServer } from './server';

const WIRE_TIMEOUT_MS = 20_000;
/** A whole fight: a 3 s countdown, ten swings 450 ms apart, a 4 s result. */
const FIGHT_TIMEOUT_MS = 40_000;
let server: PresenceServer;
const opened: LobbyClient[] = [];

const at = (x: number, y: number) => arenaTileCentre({ x, y });

async function joined(start = { x: 100, y: 100 }): Promise<LobbyClient> {
  const client = new LobbyClient({ endpoint: server.endpoint, sprite: 'avatar-2', start: { ...start, facing: 'down' } });
  opened.push(client);
  await client.connect();
  return client;
}

/** A client live in the arena at `tile`, once it has been sent the ring. */
async function inArena(tile: { x: number; y: number }): Promise<LobbyClient> {
  const client = await joined();
  client.enterArea('arena', { ...at(tile.x, tile.y), facing: 'right' }, 'avatar-3');
  await waitFor(() => client.arena(), (ring) => ring !== null, 'the ring');
  return client;
}

async function waitFor<V>(read: () => V, ready: (value: V) => boolean, label: string, timeoutMs = 10_000): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function roomOf(client: LobbyClient): Promise<PresenceRoom> {
  for (const cached of await matchMaker.query({ name: server.roomName })) {
    const room = matchMaker.getLocalRoomById(cached.roomId) as PresenceRoom | undefined;
    if (room !== undefined && room.state.peers.has(client.gameId as string)) return room;
  }
  throw new Error('no local room holds the client');
}

/** Where the room holds `client`. */
async function heldAt(client: LobbyClient): Promise<{ x: number; y: number; facing: string }> {
  const entry = (await roomOf(client)).state.peers.get(client.gameId as string);
  if (entry === undefined) throw new Error('no entry');
  return { x: entry.position.x, y: entry.position.y, facing: entry.facing };
}

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 49_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: { minUpdateIntervalMs: 10 },
  });
});

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
  // Each test starts from an idle ring: wait out any result still closing.
  for (const cached of await matchMaker.query({ name: server.roomName })) {
    const room = matchMaker.getLocalRoomById(cached.roomId) as PresenceRoom | undefined;
    if (room === undefined) continue;
    await waitFor(() => room.state.arena.get('ring')?.phase, (phase) => phase === 0, 'an idle ring', 10_000).catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.all(matchMaker.disconnectAll());
  await server?.shutdown();
});

describe('a fight over the wire (D-114)', () => {
  it('claim, ten attacks and the result arrive by state, and a spectator sees the same fight', async () => {
    // The approach is the sand outside the ring's west gate (D-114).
    const fighter = await inArena({ x: 13, y: 16 });
    const spectator = await inArena({ x: 20, y: 8 });
    const seen: ArenaRingSnapshot[] = [];
    spectator.onArena((ring) => {
      if (ring !== null) seen.push(ring);
    });

    expect(fighter.arena()).toMatchObject({ phase: 'idle' });
    expect(fighter.arenaClaim()).toBe(true);
    const counting = await waitFor(() => fighter.arena(), (ring) => ring?.phase === 'countdown', 'the countdown');
    expect(counting?.challenger).toMatchObject({ kind: 'player', gameId: fighter.gameId, hp: ARENA_MAX_HP });
    expect(counting?.opponent).toMatchObject({ kind: 'dummy', gameId: null, hp: ARENA_MAX_HP });
    // The room moved the fighter into the ring itself.
    expect(await heldAt(fighter)).toEqual({ ...at(ARENA_RING_SPAWN.x, ARENA_RING_SPAWN.y), facing: ARENA_RING_SPAWN_FACING });
    // The spectator sees the fighter: pinned into its view, and the same ring.
    await waitFor(() => spectator.peers().find((peer) => peer.gameId === fighter.gameId), (peer) => peer?.x === at(17, 16).x, 'the fighter in the ring');
    await waitFor(() => spectator.arena(), (ring) => ring?.challenger.gameId === fighter.gameId, 'the spectator’s ring');

    // Step east up to the dummy while the countdown runs (the World's job in the game).
    fighter.updatePosition(at(20, 16).x, at(20, 16).y, 'right');
    await waitFor(() => fighter.arena(), (ring) => ring?.phase === 'fighting', 'the fight');
    expect((await heldAt(fighter)).x).toBe(at(20, 16).x);

    for (let swing = 1; swing <= 10; swing += 1) {
      expect(fighter.arenaAttack(), `swing ${swing}`).toBe(true);
      await waitFor(() => fighter.arena(), (ring) => ring?.challenger.swings === swing, `swing ${swing} counted`);
      await sleep(ARENA_ATTACK_CLIENT_INTERVAL_MS + 20);
    }
    const ended = await waitFor(() => fighter.arena(), (ring) => ring?.phase === 'ended', 'the result');
    expect(ended?.outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    expect(ended?.opponent).toMatchObject({ hp: 0, hits: 10 });

    // The spectator saw the swings and the HP fall, step by step, to the same result.
    await waitFor(() => spectator.arena(), (ring) => ring?.phase === 'ended', 'the spectator’s result');
    const fight = seen.filter((ring) => ring.round === counting?.round && ring.opponent.kind === 'dummy');
    const hps = [...new Set(fight.map((ring) => ring.opponent.hp))];
    expect(hps[0]).toBe(ARENA_MAX_HP);
    expect(hps.at(-1)).toBe(0);
    expect(hps.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...fight.map((ring) => ring.challenger.swings))).toBe(10);
    // Never up: each value the spectator saw is at most the one before.
    expect(hps).toEqual([...hps].sort((a, b) => b - a));

    // The close returns the fighter to the gate and opens the ring.
    await waitFor(() => fighter.arena(), (ring) => ring?.phase === 'idle', 'the ring idle again', 8000);
    expect(await heldAt(fighter)).toEqual({ ...at(ARENA_RING_RETURN.x, ARENA_RING_RETURN.y), facing: ARENA_RING_RETURN_FACING });
  }, FIGHT_TIMEOUT_MS);

  it('a second client’s claim while busy changes nothing, and the fighter disconnecting opens the ring', async () => {
    const fighter = await inArena({ x: 13, y: 16 });
    const rival = await inArena({ x: 14, y: 17 });
    expect(fighter.arenaClaim()).toBe(true);
    const busy = await waitFor(() => rival.arena(), (ring) => ring?.phase === 'countdown', 'the countdown');
    expect(rival.arenaClaim()).toBe(true);
    // Let the room handle it: the fighter steps, and the rival sees the step.
    fighter.updatePosition(at(18, 16).x, at(18, 16).y, 'right');
    await waitFor(() => rival.peers().find((peer) => peer.gameId === fighter.gameId), (peer) => peer?.x === at(18, 16).x, 'the step');
    const after = rival.arena();
    expect(after?.round).toBe(busy?.round);
    expect(after?.challenger.gameId).toBe(fighter.gameId);
    expect((await heldAt(rival)).y).toBe(at(14, 17).y);

    await fighter.disconnect();
    const ended = await waitFor(() => rival.arena(), (ring) => ring?.phase === 'ended', 'the walk-out');
    expect(ended?.outcome).toEqual({ reason: 'disconnect', winner: null });
    await waitFor(() => rival.arena(), (ring) => ring?.phase === 'idle', 'the ring open', 5000);
    await sleep(1000);
    // Open again: the rival takes it.
    expect(rival.arenaClaim()).toBe(true);
    await waitFor(() => rival.arena(), (ring) => ring?.challenger.gameId === rival.gameId, 'the rival’s claim');
  }, FIGHT_TIMEOUT_MS);

  it('two claims sent in the same turn: exactly one challenger', async () => {
    const left = await inArena({ x: 13, y: 15 });
    const right = await inArena({ x: 13, y: 17 });
    expect(left.arenaClaim()).toBe(true);
    expect(right.arenaClaim()).toBe(true);
    const ring = await waitFor(() => left.arena(), (value) => value?.phase === 'countdown', 'the countdown');
    // The room handled them one at a time: whichever came first holds the ring.
    expect([left.gameId, right.gameId]).toContain(ring?.challenger.gameId);
    const winner = ring?.challenger.gameId === left.gameId ? left : right;
    const loser = winner === left ? right : left;
    expect(ring?.round).toBe(1);
    expect((await heldAt(winner)).x).toBe(at(ARENA_RING_SPAWN.x, ARENA_RING_SPAWN.y).x);
    // The other stays on the approach (both stood on its outer column).
    expect((await heldAt(loser)).x).toBe(at(13, 16).x);
    await waitFor(() => right.arena(), (value) => value?.challenger.gameId === winner.gameId, 'the same ring for both');
  }, WIRE_TIMEOUT_MS);

  it('a look change racing the claim keeps the room’s position, and the fight goes on', async () => {
    const fighter = await inArena({ x: 13, y: 16 });
    expect(fighter.arenaClaim()).toBe(true);
    // Sent before the client has heard of the claim: the approach position, a new look.
    fighter.enterArea('arena', { ...at(13, 16), facing: 'right' }, 'avatar-11');
    await waitFor(() => fighter.arena(), (ring) => ring?.phase === 'countdown', 'the countdown');
    const room = await roomOf(fighter);
    await waitFor(() => room.state.peers.get(fighter.gameId as string)?.sprite, (sprite) => sprite === 'avatar-11', 'the new look');
    expect(await heldAt(fighter)).toEqual({ ...at(ARENA_RING_SPAWN.x, ARENA_RING_SPAWN.y), facing: ARENA_RING_SPAWN_FACING });
    expect(fighter.area).toBe('arena');
    expect(fighter.arena()?.challenger.gameId).toBe(fighter.gameId);
  }, WIRE_TIMEOUT_MS);
});

describe('only arena members are sent the ring (D-114)', () => {
  it('a street client never decodes it; it joins a view on entry and leaves it on exit', async () => {
    const fighter = await inArena({ x: 13, y: 16 });
    // A raw SDK client, so the test reads exactly what was decoded.
    const sdk = new ColyseusClient(server.endpoint);
    const raw = await sdk.joinOrCreate<LobbyState>(server.roomName, { x: 120, y: 100 });
    raw.onMessage('*', () => undefined);
    const rings = () => (raw.state as unknown as { arena?: { size: number; get(key: string): unknown } }).arena;
    try {
      expect(fighter.arenaClaim()).toBe(true);
      await waitFor(() => fighter.arena(), (ring) => ring?.phase === 'countdown', 'the countdown');
      // The fighter steps; the room patches the ring and the step together,
      // and the street client decodes those patches with no ring entry.
      fighter.updatePosition(at(18, 16).x, at(18, 16).y, 'right');
      const room = await roomOf(fighter);
      await waitFor(() => room.state.peers.get(fighter.gameId as string)?.position.x, (x) => x === at(18, 16).x, 'the step');
      for (let patch = 0; patch < 5; patch += 1) {
        await sleep(60);
        expect(rings()?.size ?? 0, `patch ${patch}`).toBe(0);
      }
      expect([...(raw.state.peers?.keys() ?? [])]).not.toContain(fighter.gameId);

      // Into the arena: the ring arrives, mid-fight, with the fighter.
      raw.send(MESSAGE.area, { area: 'arena', ...at(12, 16), facing: 'down', sprite: 'avatar-4' });
      await waitFor(() => rings()?.size ?? 0, (size) => size === 1, 'the ring on entry');
      await waitFor(() => [...(raw.state.peers?.keys() ?? [])], (keys) => keys.includes(fighter.gameId as string), 'the fighter on entry');
      // And out again: the view drops it.
      raw.send(MESSAGE.area, { area: 'street', x: 120, y: 100, facing: 'down', sprite: 'avatar-4' });
      await waitFor(() => rings()?.size ?? 0, (size) => size === 0, 'the ring out of the view');
      // The fighter's own client still holds it.
      expect(fighter.arena()).not.toBeNull();
    } finally {
      await raw.leave(true).catch(() => undefined);
    }
  }, WIRE_TIMEOUT_MS);

  it('the LobbyClient reports no ring outside the arena, and drops it at once on leaving', async () => {
    const walker = await inArena({ x: 12, y: 16 });
    expect(walker.arena()).toMatchObject({ phase: 'idle' });
    const seen: (ArenaRingSnapshot | null)[] = [];
    walker.onArena((ring) => seen.push(ring));
    walker.enterArea('street', { x: 120, y: 100, facing: 'down' }, 'avatar-4');
    expect(walker.arena()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    // Off the arena, the intents send nothing.
    expect(walker.arenaClaim()).toBe(false);
    expect(walker.arenaAttack()).toBe(false);
    expect(walker.arenaLeave()).toBe(false);
  }, WIRE_TIMEOUT_MS);
});

describe('the message ceiling (D-114)', () => {
  it('an attack flood past 40 messages a second disconnects', async () => {
    const sdk = new ColyseusClient(server.endpoint);
    const raw = await sdk.joinOrCreate(server.roomName, at(13, 16));
    raw.onMessage('*', () => undefined);
    let closed: number | null = null;
    raw.onLeave((code) => {
      closed = code;
    });
    for (let n = 0; n < MAX_MESSAGES_PER_SECOND * 3; n += 1) raw.send(MESSAGE.arenaAttack, { damage: 1000 });
    await waitFor(() => closed, (code) => code !== null, 'the force-close', 5000);
  }, WIRE_TIMEOUT_MS);
});
