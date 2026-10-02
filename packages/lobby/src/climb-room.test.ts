/**
 * D-106 end to end: jump to climb through the real room, the real websocket
 * and the real `LobbyClient`. Walking onto a block is refused and the client
 * hears where the room holds it; a jump first lets the same step through.
 *
 * A file of its own because it needs its own server: the matchmaker is a
 * process-global (see the AGENTS.md finding).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { PLAYER_BODY_SIZE, SANDBOX_AREA, type Position, type SandboxColumn } from '@strkworld/shared';
import { LobbyClient } from './client';
import type { PresenceRoom } from './room';
import { isSandboxTile } from './sandbox-rules';
import { startPresenceServer, type PresenceServer } from './server';

const T = 32;
const HALF = PLAYER_BODY_SIZE / 2;
const WIRE_TIMEOUT_MS = 20_000;
const WAITING = { x: (SANDBOX_AREA.x - 4) * T + T / 2, y: 5 * T + T / 2 };
let server: PresenceServer;
const opened: LobbyClient[] = [];

async function waitFor<V>(read: () => V, ready: (value: V) => boolean, label: string, timeoutMs = 8000): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function roomOf(client: LobbyClient): Promise<PresenceRoom> {
  for (const cached of await matchMaker.query({ name: server.roomName })) {
    const room = matchMaker.getLocalRoomById(cached.roomId) as PresenceRoom | undefined;
    if (room !== undefined && room.state.peers.has(client.gameId as string)) return room;
  }
  throw new Error('no local room holds the client');
}

const held = (room: PresenceRoom, client: LobbyClient) => {
  const position = room.state.peers.get(client.gameId as string)?.position;
  return position ? { x: position.x, y: position.y } : null;
};

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 46_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: {
      minUpdateIntervalMs: 10,
      sandboxSpawnIntervalMs: 300,
      sandboxFastSpawnLimit: 1,
      sandboxSlowSpawnIntervalMs: 3_600_000,
    },
  });
});

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
  await Promise.all(matchMaker.disconnectAll());
});

afterAll(async () => {
  await server?.shutdown();
});

describe('jump to climb over the wire (D-106)', () => {
  it('refuses a walk onto a block and resyncs the client; a jump first lets it climb', async () => {
    const client = new LobbyClient({ endpoint: server.endpoint, sprite: 'avatar-2', start: { ...WAITING, facing: 'down' } });
    opened.push(client);
    await client.connect();
    const resyncs: Position[] = [];
    client.onResync((position) => resyncs.push(position));
    const column = await waitFor(() => client.sandbox().columns, (list) => list.length === 1, 'the first sky drop')
      .then((list) => list[0] as SandboxColumn);
    // Flush against the block from whichever side is inside the square.
    const side = isSandboxTile(column.x - 1, column.y) ? -1 : 1;
    const flush = { x: side < 0 ? column.x * T - HALF : (column.x + 1) * T + HALF, y: column.y * T + T / 2 };
    const onTop = { x: column.x * T + T / 2, y: column.y * T + T / 2 };
    const room = await roomOf(client);

    client.updatePosition(flush.x, flush.y, side < 0 ? 'right' : 'left');
    await waitFor(() => held(room, client), (at) => at?.x === flush.x && at?.y === flush.y, 'the flush position');

    client.updatePosition(onTop.x, onTop.y, side < 0 ? 'right' : 'left');
    await waitFor(() => resyncs.length, (count) => count >= 1, 'the resync');
    expect(resyncs[0]).toEqual(flush);
    expect(held(room, client)).toEqual(flush);

    // The World stands the player back; then a jump, and the same step lands.
    client.updatePosition(flush.x, flush.y, side < 0 ? 'right' : 'left');
    expect(client.jump()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.updatePosition(onTop.x, onTop.y, side < 0 ? 'right' : 'left');
    await waitFor(() => held(room, client), (at) => at?.x === onTop.x && at?.y === onTop.y, 'the climb');
    expect(resyncs).toHaveLength(1);
  }, WIRE_TIMEOUT_MS);
});
