/**
 * D-071 end to end: a real Colyseus server, real websocket clients and the
 * real room class, whose sky drops are scripted so that every one lands on
 * the same tile. The sixteenth bursts the sandbox.
 *
 * A file of its own because it needs its own room definition, and the
 * matchmaker is a process-global (see the AGENTS.md finding).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import { SANDBOX_AREA, SANDBOX_BURST_HEIGHT, type SandboxTile } from '@strkworld/shared';
import { DEFAULT_ROOM_NAME, SERVER_MESSAGE, resolveRoomConfig, type PresenceRoomConfig } from './config';
import { LobbyClient } from './client';
import { PresenceRoom } from './room';
import type { LobbyPresenceOptions } from './presence';
import type { LobbyState } from './state';
import vocabulary from './testing/forbidden-vocabulary.json';

const T = 32;
/** The first open tile in `(y, x)` order: where a draw of 0 drops every block. */
const PILLAR = { x: SANDBOX_AREA.x, y: SANDBOX_AREA.y };
const KEY = `${PILLAR.x},${PILLAR.y}`;
/** On the road west of the square, far from the pillar. */
const WAITING = { x: (SANDBOX_AREA.x - 4) * T + T / 2, y: 5 * T + T / 2 };

/**
 * The production room, with a trusted config that drops a block every 50 ms
 * and a scripted source that puts each one on `PILLAR`. The room spreads its
 * config into the registry's options, so the source rides along with it.
 */
class ScriptedDropRoom extends PresenceRoom {
  protected override roomConfig: PresenceRoomConfig & Pick<LobbyPresenceOptions, 'sandboxRandom'> = {
    ...resolveRoomConfig({ sandboxSpawnIntervalMs: 50, sandboxFastSpawnLimit: 900 }),
    sandboxRandom: () => 0,
  };
}

let server: Server;
let endpoint = '';

beforeAll(async () => {
  for (let attempt = 0; ; attempt += 1) {
    const port = 53_000 + Math.floor(Math.random() * 3_000);
    const candidate = new Server({ transport: new WebSocketTransport(), greet: false, gracefullyShutdown: false });
    candidate.define(DEFAULT_ROOM_NAME, ScriptedDropRoom);
    try {
      await candidate.listen(port, '127.0.0.1');
      server = candidate;
      endpoint = `ws://127.0.0.1:${port}`;
      return;
    } catch (error) {
      await candidate.gracefullyShutdown(false).catch(() => undefined);
      if (attempt >= 20) throw error;
    }
  }
});

afterAll(async () => {
  await Promise.all(matchMaker.disconnectAll());
  await server?.gracefullyShutdown(false);
});

async function waitFor<V>(read: () => V, ready: (value: V) => boolean, label: string, timeoutMs = 8000): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a burst reaches every client (D-071)', () => {
  it('broadcasts the bare tile at once, while clients still hold the pillar, before the patch that empties it', async () => {
    // A bare SDK client sees the raw payload and the raw state it lands in.
    const sdk = new ColyseusClient(endpoint);
    const raw: ColyseusRoom<unknown, LobbyState> = await sdk.joinOrCreate<LobbyState>(DEFAULT_ROOM_NAME, {
      x: WAITING.x,
      y: WAITING.y,
      facing: 'down',
      sprite: 'avatar-1',
    });
    raw.reconnection.enabled = false;
    const height = (): number => raw.state.sandbox?.get(KEY)?.colours.length ?? 0;
    const heard: Array<{ payload: unknown; heightThen: number; changesBefore: number }> = [];
    let changes = 0;
    const heightsAfterBurst: number[] = [];
    raw.onStateChange(() => {
      changes += 1;
      if (heard.length > 0) heightsAfterBurst.push(height());
    });
    raw.onMessage(SERVER_MESSAGE.sandboxBurst, (payload: unknown) => {
      heard.push({ payload, heightThen: height(), changesBefore: changes });
    });
    // So does the client wrapper the Shell uses.
    const client = new LobbyClient({ endpoint, start: { x: WAITING.x + 40, y: WAITING.y } });
    const wrapped: Array<{ tile: SandboxTile; heightThen: number }> = [];
    client.onSandboxBurst((tile) => {
      const column = client.sandbox().columns.find((entry) => entry.x === tile.x && entry.y === tile.y);
      wrapped.push({ tile, heightThen: column?.colours.length ?? 0 });
    });

    try {
      await client.connect();
      await waitFor(() => heard.length, (count) => count >= 1, 'the burst');
      const first = heard[0]!;
      expect(first.payload).toEqual(PILLAR);
      expect(Object.keys(first.payload as object).sort()).toEqual(['x', 'y']);
      // Sent at once: the patch that removes the pillar had not arrived.
      expect(first.heightThen).toBe(SANDBOX_BURST_HEIGHT);
      expect(first.changesBefore).toBeGreaterThan(0);
      const cleared = await waitFor(() => heightsAfterBurst, (list) => list.length >= 1, 'the clearing patch');
      expect(cleared[0]).toBe(0);

      await waitFor(() => wrapped.length, (count) => count >= 1, 'the wrapped burst');
      expect(wrapped[0]).toEqual({ tile: PILLAR, heightThen: SANDBOX_BURST_HEIGHT });
      expect(Object.isFrozen(wrapped[0]!.tile)).toBe(true);

      const surface = JSON.stringify(heard.map((entry) => entry.payload));
      expect(surface).not.toContain(client.gameId as string);
      const lowered = surface.toLowerCase();
      for (const word of vocabulary.substrings) expect(lowered).not.toContain(word);
    } finally {
      await client.disconnect().catch(() => undefined);
      await raw.leave(true).catch(() => undefined);
    }
  }, 20_000);
});
