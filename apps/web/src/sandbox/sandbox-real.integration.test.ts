import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SANDBOX_AREA,
  type SandboxSnapshot,
  type SandboxTile,
  type WorldEvents,
} from '@strkworld/shared';
import { LobbyClient } from '@strkworld/lobby/client';
import { startPresenceServer, type PresenceServer } from '@strkworld/lobby/server';
import type { RemotePeerSnapshot } from '@strkworld/world';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceController } from '../presence/presence-controller.js';
import { createSandboxController, type SandboxController } from './sandbox-controller.js';

/**
 * The shared sandbox end to end (D-060): two real Shell stacks — presence
 * controller, sandbox controller, lobby client — against one real lobby
 * server. What one player does to the blocks, the other must see.
 */

let server: PresenceServer | null = null;
const opened: Array<() => Promise<void>> = [];

async function waitFor<T>(
  read: () => T,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const centre = (tile: SandboxTile) => ({ x: tile.x * 32 + 16, y: tile.y * 32 + 16 });
const heightAt = (snapshot: SandboxSnapshot | undefined, tile: SandboxTile): number =>
  snapshot?.columns.find((column) => column.x === tile.x && column.y === tile.y)?.colours.length ?? 0;

function openPlayer(endpoint: string) {
  const world = createEventBus<WorldEvents>();
  const sandbox: SandboxController = createSandboxController();
  const presence: PresenceController = createPresenceController({
    endpoint,
    factory: (options) => sandbox.adopt(new LobbyClient(options)),
    sandbox: sandbox.channel,
  });
  const stopPresenceWorld = presence.listen(world);
  const stopSandboxWorld = sandbox.listen(world);
  const snapshots: SandboxSnapshot[] = [];
  const drops: SandboxTile[] = [];
  const peers: RemotePeerSnapshot[][] = [];
  sandbox.channel.subscribe((snapshot) => snapshots.push(snapshot));
  sandbox.channel.subscribeDrops?.((tile) => drops.push({ x: tile.x, y: tile.y }));
  presence.remotePeers.subscribe((snapshot) => peers.push([...snapshot]));
  opened.push(async () => {
    stopPresenceWorld();
    stopSandboxWorld();
    sandbox.destroy();
    await presence.destroy().catch(() => undefined);
  });
  return {
    world,
    presence,
    sandbox,
    snapshots,
    drops,
    peers,
    latest: () => snapshots.at(-1),
    stand(tile: SandboxTile, facing: 'up' | 'down' | 'left' | 'right' = 'right') {
      world.emit('player:moved', { position: centre(tile), facing });
    },
  };
}

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 49_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: { interestRadius: 2_000 },
  });
});

afterAll(async () => {
  for (const close of opened.splice(0)) await close();
  await server?.shutdown().catch(() => undefined);
});

describe('the shared block sandbox across two real players (D-060)', () => {
  it('shares sky drops, picks and places between players', async () => {
    if (!server) throw new Error('lobby test server did not start');
    const first = openPlayer(server.endpoint);
    const second = openPlayer(server.endpoint);
    // Opposite corners of the square, far from each other's spawn exclusion.
    first.stand({ x: SANDBOX_AREA.x + 2, y: 2 });
    second.stand({ x: SANDBOX_AREA.x + SANDBOX_AREA.width - 3, y: SANDBOX_AREA.height - 3 });

    await waitFor(
      () => [first.presence.getState().status, second.presence.getState().status],
      ([a, b]) => a === 'connected' && b === 'connected',
      'both players to connect',
    );

    // The server rains a block; both players see the same drop and the same stacks.
    const drop = await waitFor(() => first.drops.at(-1), (tile) => tile !== undefined, 'a sky drop');
    await waitFor(() => heightAt(second.latest(), drop!), (height) => height >= 1, 'the drop on the other client');
    await waitFor(
      () => JSON.stringify(first.latest()?.columns) === JSON.stringify(second.latest()?.columns),
      Boolean,
      'identical stacks on both clients',
    );

    // The first player walks next to the block and picks it up.
    const target = drop!;
    const before = heightAt(first.latest(), target);
    const standAt = { x: target.x - 1 >= SANDBOX_AREA.x ? target.x - 1 : target.x + 1, y: target.y };
    first.stand(standAt, target.x > standAt.x ? 'right' : 'left');
    // Let the move reach the server before acting on it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    first.sandbox.channel.pick(target);
    const carried = await waitFor(() => first.latest()?.carrying, (colour) => colour !== null && colour !== undefined, 'the pick');
    await waitFor(() => heightAt(second.latest(), target), (height) => height === before - 1, 'the other client to see the stack shrink');
    await waitFor(
      () => second.peers.at(-1)?.[0]?.carrying,
      (colour) => colour === carried,
      'the other client to see the carried block',
    );

    // And puts it down on its other side.
    const placeAt = { x: standAt.x, y: standAt.y + 1 < SANDBOX_AREA.y + SANDBOX_AREA.height ? standAt.y + 1 : standAt.y - 1 };
    const placeBefore = heightAt(first.latest(), placeAt);
    first.sandbox.channel.place(placeAt);
    await waitFor(() => first.latest()?.carrying, (colour) => colour === null, 'the place');
    await waitFor(() => heightAt(second.latest(), placeAt), (height) => height === placeBefore + 1, 'the other client to see the placed block');
    await waitFor(() => second.peers.at(-1)?.[0]?.carrying, (colour) => colour === null, 'empty hands on the other client');

    // Out of reach: the second player cannot take a block from across the square.
    const far = first.latest()?.columns[0];
    if (far) {
      const height = heightAt(second.latest(), far);
      second.sandbox.channel.pick({ x: far.x, y: far.y });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(second.latest()?.carrying).toBeNull();
      expect(heightAt(second.latest(), far)).toBeGreaterThanOrEqual(height);
    }
  }, 45_000);
});
