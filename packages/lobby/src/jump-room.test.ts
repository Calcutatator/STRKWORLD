/**
 * D-097 end to end: the jump through the real room, the real websocket and
 * the real `LobbyClient`. A jump reaches the peers who see the jumper — in
 * the same presence area — and nobody else; the client and the room each
 * hold it to a floor; the Studio jumps like the street and the roof
 * (D-111); and a client sends nothing while suspended.
 *
 * A file of its own because it needs its own server: the matchmaker is a
 * process-global (see the AGENTS.md finding). Negative checks wait for a
 * later patch first (`settled`), never for a guessed time.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { ROOF_PRESENCE_GRID, STUDIO_PRESENCE_GRID } from '@strkworld/shared';
import { LobbyClient } from './client';
import { JUMP_CLIENT_INTERVAL_MS } from './config';
import type { PresenceRoom } from './room';
import { startPresenceServer, type PresenceServer } from './server';

const T = 32;
const WIRE_TIMEOUT_MS = 20_000;
let server: PresenceServer;
const opened: LobbyClient[] = [];

const roof = (x: number, y: number) => ({ x: ROOF_PRESENCE_GRID.originX + x * T + T / 2, y: ROOF_PRESENCE_GRID.originY + y * T + T / 2 });
const studio = (x: number, y: number) => ({ x: STUDIO_PRESENCE_GRID.originX + x * T + T / 2, y: STUDIO_PRESENCE_GRID.originY + y * T + T / 2 });

async function joined(at: { x: number; y: number }): Promise<LobbyClient> {
  const client = new LobbyClient({ endpoint: server.endpoint, sprite: 'avatar-2', start: { ...at, facing: 'down' } });
  opened.push(client);
  await client.connect();
  return client;
}

async function waitFor<V>(read: () => V, ready: (value: V) => boolean, label: string, timeoutMs = 8000): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const peerOf = (observer: LobbyClient, peer: LobbyClient) =>
  observer.peers().find((candidate) => candidate.gameId === peer.gameId);

async function roomOf(client: LobbyClient): Promise<PresenceRoom> {
  for (const cached of await matchMaker.query({ name: server.roomName })) {
    const room = matchMaker.getLocalRoomById(cached.roomId) as PresenceRoom | undefined;
    if (room !== undefined && room.state.peers.has(client.gameId as string)) return room;
  }
  throw new Error('no local room holds the client');
}

/** `mover` steps; once every observer has seen the step, anything the room did before it has reached them. */
async function settled(mover: LobbyClient, home: { x: number; y: number }, observers: readonly LobbyClient[], step: number) {
  const x = home.x + 2 * step;
  mover.updatePosition(x, home.y, 'right');
  for (const observer of observers) {
    await waitFor(() => peerOf(observer, mover)?.x, (seen) => seen === x, 'the step seen');
  }
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
});

afterAll(async () => {
  await Promise.all(matchMaker.disconnectAll());
  await server?.shutdown();
});

describe('the jump over the wire (D-097)', () => {
  it('reaches the peers in the jumper\'s own area and no one else', async () => {
    const home = { x: 848, y: 304 };
    const jumper = await joined(home);
    const neighbour = await joined({ x: home.x + 40, y: home.y });
    const climber1 = await joined({ x: roof(3, 3).x, y: roof(3, 3).y + 4 * T });
    const climber2 = await joined({ x: roof(3, 3).x, y: roof(3, 3).y + 4 * T });
    const dresser = await joined(studio(6, 6));
    const dresser2 = await joined(studio(6, 6));
    climber1.suspend();
    climber2.suspend();
    climber1.enterArea('roof', roof(3, 3), 'avatar-2');
    climber2.enterArea('roof', roof(4, 2), 'avatar-2');
    dresser.enterArea('studio', studio(6, 5), 'avatar-2');
    dresser2.enterArea('studio', studio(7, 5), 'avatar-2');
    await waitFor(() => peerOf(dresser2, dresser), (peer) => peer !== undefined, 'the Studio sees itself');
    await waitFor(() => peerOf(neighbour, jumper), (peer) => peer !== undefined, 'the neighbour sees the jumper');
    await waitFor(() => peerOf(climber2, climber1), (peer) => peer !== undefined, 'the roof sees itself');
    expect(peerOf(neighbour, jumper)?.jumps).toBe(0);

    // A street jump reaches the street neighbour.
    expect(jumper.jump()).toBe(true);
    await waitFor(() => peerOf(neighbour, jumper)?.jumps, (jumps) => jumps === 1, 'the street jump');
    // A second press inside the client floor is dropped before the wire.
    expect(jumper.jump()).toBe(false);

    // A roof jump reaches the roof, never the street or the Studio.
    expect(climber1.jump()).toBe(true);
    await waitFor(() => peerOf(climber2, climber1)?.jumps, (jumps) => jumps === 1, 'the roof jump');
    await settled(jumper, home, [neighbour], 1);
    expect(peerOf(neighbour, climber1)).toBeUndefined();
    expect(peerOf(jumper, climber1)).toBeUndefined();
    expect(peerOf(dresser, climber1)).toBeUndefined();

    // A Studio jump (D-111) reaches the Studio, never the street or the roof.
    expect(dresser.jump()).toBe(true);
    await waitFor(() => peerOf(dresser2, dresser)?.jumps, (jumps) => jumps === 1, 'the Studio jump');
    await settled(jumper, home, [neighbour], 2);
    expect(peerOf(neighbour, dresser)).toBeUndefined();
    expect(peerOf(climber2, dresser)).toBeUndefined();

    // A suspended client sends nothing.
    neighbour.suspend();
    expect(neighbour.jump()).toBe(false);
    const room = await roomOf(jumper);
    expect(room.state.peers.get(dresser.gameId as string)?.jumps).toBe(1);
    expect(room.state.peers.get(jumper.gameId as string)?.jumps).toBe(1);
  }, WIRE_TIMEOUT_MS);

  it('holds a client to its floor, then lets the next jump through', async () => {
    const home = { x: 900, y: 304 };
    const jumper = await joined(home);
    const watcher = await joined({ x: home.x + 40, y: home.y });
    await waitFor(() => peerOf(watcher, jumper), (peer) => peer !== undefined, 'the watcher sees the jumper');
    expect(jumper.jump()).toBe(true);
    expect(jumper.jump()).toBe(false);
    await waitFor(() => peerOf(watcher, jumper)?.jumps, (jumps) => jumps === 1, 'the first jump');
    await new Promise((resolve) => setTimeout(resolve, JUMP_CLIENT_INTERVAL_MS + 50));
    expect(jumper.jump()).toBe(true);
    await waitFor(() => peerOf(watcher, jumper)?.jumps, (jumps) => jumps === 2, 'the second jump');
  }, WIRE_TIMEOUT_MS);
});
