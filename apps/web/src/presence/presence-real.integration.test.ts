import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import { startPresenceServer, type PresenceServer } from '@strkworld/lobby/server';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceController } from './presence-controller.js';

let server: PresenceServer | null = null;
let stopped = false;
const opened: Array<{ presence: PresenceController; stopWorld: () => void }> = [];

async function waitFor<T>(
  read: () => T,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 46_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: { interestRadius: 1_000 },
  });
});

afterAll(async () => {
  for (const { presence, stopWorld } of opened.splice(0)) {
    stopWorld();
    await presence.destroy().catch(() => undefined);
  }
  if (!stopped && server) await server.shutdown().catch(() => undefined);
});

describe('real shell presence preserves the D-038 remote-peer seam', () => {
  it('filters self, replaces snapshots, suspends/resumes, and clears on leave/drop', async () => {
    if (!server) throw new Error('presence test server did not start');
    const firstWorld = createEventBus<WorldEvents>();
    const secondWorld = createEventBus<WorldEvents>();
    const first = createPresenceController({ endpoint: server.endpoint });
    const second = createPresenceController({ endpoint: server.endpoint });
    const stopFirstWorld = first.listen(firstWorld);
    const stopSecondWorld = second.listen(secondWorld);
    opened.push(
      { presence: first, stopWorld: stopFirstWorld },
      { presence: second, stopWorld: stopSecondWorld },
    );

    const firstHistory: unknown[][] = [];
    const secondHistory: unknown[][] = [];
    const stopFirstPeers = first.remotePeers.subscribe((snapshot) => firstHistory.push([...snapshot]));
    const stopSecondPeers = second.remotePeers.subscribe((snapshot) => secondHistory.push([...snapshot]));

    firstWorld.emit('player:moved', { position: { x: 100, y: 100 }, facing: 'right' });
    secondWorld.emit('player:moved', { position: { x: 140, y: 100 }, facing: 'left' });

    await waitFor(
      () => [first.getState().status, second.getState().status],
      ([firstStatus, secondStatus]) => firstStatus === 'connected' && secondStatus === 'connected',
      'both controllers to connect',
    );
    await waitFor(
      () => firstHistory.at(-1),
      (snapshot) => Array.isArray(snapshot) && snapshot.length === 1,
      'the second avatar to appear to the first controller',
    );
    await waitFor(
      () => secondHistory.at(-1),
      (snapshot) => Array.isArray(snapshot) && snapshot.length === 1,
      'the first avatar to appear to the second controller',
    );

    const firstPeer = firstHistory.at(-1)?.[0] as { id: string; x: number; y: number; facing: string };
    const secondPeer = secondHistory.at(-1)?.[0] as { id: string; x: number; y: number; facing: string };
    expect(firstPeer.id).not.toBe(secondPeer.id);
    expect(firstPeer).toMatchObject({ x: 140, y: 100, facing: 'left' });
    expect(secondPeer).toMatchObject({ x: 100, y: 100, facing: 'right' });

    // A movement is a complete replacement snapshot, not an incremental event.
    secondWorld.emit('player:moved', { position: { x: 180, y: 120 }, facing: 'up' });
    await waitFor(
      () => firstHistory.at(-1),
      (snapshot) => (snapshot?.[0] as { x?: number } | undefined)?.x === 180,
      'the replacement movement snapshot',
    );
    expect(firstHistory.at(-1)).toHaveLength(1);
    expect(firstHistory.at(-1)?.[0]).toMatchObject({ x: 180, y: 120, facing: 'up' });

    // Entering the Bank removes the avatar from the street for every peer.
    secondWorld.emit('building:entered', { building: 'bank' });
    await waitFor(
      () => firstHistory.at(-1),
      (snapshot) => Array.isArray(snapshot) && snapshot.length === 0,
      'the suspended avatar to disappear',
    );
    expect(second.getState().status).toBe('suspended');

    // Exit resumes at the controller's restored street placement.
    secondWorld.emit('building:exited', { building: 'bank' });
    await waitFor(
      () => firstHistory.at(-1),
      (snapshot) => (snapshot?.[0] as { x?: number } | undefined)?.x === 180,
      'the resumed avatar to return at its last placement',
    );
    expect(firstHistory.at(-1)).toHaveLength(1);
    expect(firstHistory.at(-1)?.[0]).toMatchObject({ x: 180, y: 120, facing: 'up' });

    // A public destroy clears the source and removes the avatar from the room.
    await second.destroy();
    await waitFor(
      () => firstHistory.at(-1),
      (snapshot) => Array.isArray(snapshot) && snapshot.length === 0,
      'the destroyed avatar to disappear',
    );
    expect(secondHistory.at(-1)).toEqual([]);
    stopSecondPeers();

    // A server drop is distinct from an empty snapshot and still clears the source.
    stopped = true;
    await server.shutdown();
    await waitFor(
      () => first.getState(),
      (state) => state.status === 'unavailable',
      'the first controller to report the server drop',
    );
    expect(firstHistory.at(-1)).toEqual([]);

    stopFirstPeers();
    await first.destroy();
  }, 30_000);
});
