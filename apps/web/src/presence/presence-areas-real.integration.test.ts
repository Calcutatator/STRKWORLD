/**
 * D-087 through the real shell presence controller, the real `LobbyClient`
 * and a real lobby: three players, the street, the Avatar Studio and the
 * Exchange roof, driven only by the World events the session emits.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOF_PRESENCE_GRID, STUDIO_PRESENCE_GRID, type WorldEvents } from '@strkworld/shared';
import { startPresenceServer, type PresenceServer } from '@strkworld/lobby/server';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceController } from './presence-controller.js';

let server: PresenceServer | null = null;
const opened: Array<{ presence: PresenceController; stop: () => void }> = [];

async function waitFor<T>(read: () => T, ready: (value: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> {
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
    port: 49_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: { interestRadius: 2_000 },
  });
});

afterAll(async () => {
  for (const { presence, stop } of opened.splice(0)) {
    stop();
    await presence.destroy().catch(() => undefined);
  }
  await server?.shutdown().catch(() => undefined);
});

const studio = (x: number, y: number) => ({ x: STUDIO_PRESENCE_GRID.originX + x * 32 + 16, y: STUDIO_PRESENCE_GRID.originY + y * 32 + 16 });
const roof = (x: number, y: number) => ({ x: ROOF_PRESENCE_GRID.originX + x * 32 + 16, y: ROOF_PRESENCE_GRID.originY + y * 32 + 16 });

function player() {
  const world = createEventBus<WorldEvents>();
  const presence = createPresenceController({ endpoint: server!.endpoint });
  const stop = presence.listen(world);
  opened.push({ presence, stop });
  let latest: readonly { id: string; x: number; y: number; sprite: string }[] = [];
  presence.remotePeers.subscribe((snapshot) => {
    latest = snapshot as typeof latest;
  });
  return { world, presence, peers: () => latest };
}

const count = (who: ReturnType<typeof player>, n: number, label: string) =>
  waitFor(() => who.peers().length, (value) => value === n, label);

describe('real shell presence across shared areas (D-087)', () => {
  it('shares the Studio and the roof, keeps them off the street, and still suspends elsewhere', async () => {
    const a = player();
    const b = player();
    const c = player();
    a.world.emit('player:moved', { position: { x: 1300, y: 420 }, facing: 'down' });
    b.world.emit('player:moved', { position: { x: 1340, y: 420 }, facing: 'down' });
    c.world.emit('player:moved', { position: { x: 1380, y: 420 }, facing: 'down' });
    await count(a, 2, 'everyone on the street');

    // B walks into the Studio: gone from the street, live in the Studio.
    b.world.emit('area:moved', { position: studio(9, 1), facing: 'down' });
    b.world.emit('avatar-studio:entered', {});
    expect(b.presence.getState().status).toBe('connected');
    await count(a, 1, 'B to leave the street');
    await count(b, 0, 'B alone in the Studio');

    // C follows: B and C see each other there, A sees neither.
    c.world.emit('area:moved', { position: studio(9, 1), facing: 'down' });
    c.world.emit('avatar-studio:entered', {});
    await count(b, 1, 'C to join B in the Studio');
    await count(a, 0, 'the street to empty');
    c.world.emit('area:moved', { position: studio(9, 4), facing: 'down' });
    await waitFor(() => b.peers()[0]?.y, (y) => y === studio(9, 4).y, 'C to walk in the Studio');
    // C tries a look on: B sees it at once.
    c.world.emit('avatar:selected', { sprite: 'avatar-6' });
    await waitFor(() => b.peers()[0]?.sprite, (sprite) => sprite === 'avatar-6', 'C’s new look');

    // B walks out through the portal, back to the street beside A.
    b.world.emit('player:moved', { position: { x: 1340, y: 420 }, facing: 'up' });
    b.world.emit('avatar-studio:exited', {});
    await count(a, 1, 'B back on the street');
    await count(c, 0, 'B gone from the Studio');

    // A goes up the Exchange: suspended on its floors, live on its roof.
    a.world.emit('building:entered', { building: 'exchange' });
    await waitFor(() => a.presence.getState().status, (status) => status === 'suspended', 'A suspended');
    await count(b, 0, 'A gone from the street');
    a.world.emit('area:moved', { position: roof(5, 3), facing: 'up' });
    a.world.emit('rooftop:entered', {});
    await waitFor(() => a.presence.getState().status, (status) => status === 'connected', 'A live on the roof');
    // One way: A on the roof sees B on the street below; B does not see A.
    await count(a, 1, 'B below, seen from the roof');
    expect(a.peers()[0]).toMatchObject({ x: 1340, y: 420 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(b.peers()).toEqual([]);
    // B follows A up: they meet on the roof; nobody below sees either.
    b.world.emit('building:entered', { building: 'exchange' });
    b.world.emit('area:moved', { position: roof(2, 2), facing: 'up' });
    b.world.emit('rooftop:entered', {});
    await waitFor(() => a.peers()[0]?.x, (x) => x === roof(2, 2).x, 'B on the roof with A');
    await count(b, 1, 'A on the roof with B');
    expect(a.peers()).toHaveLength(1);
    expect(a.peers()[0]).toMatchObject(roof(2, 2));

    // B rides down: suspended again, gone from the roof.
    b.world.emit('rooftop:exited', {});
    await waitFor(() => b.presence.getState().status, (status) => status === 'suspended', 'B suspended below');
    await count(a, 0, 'B gone from the roof');
    b.world.emit('player:moved', { position: { x: 1340, y: 420 }, facing: 'down' });
    b.world.emit('building:exited', { building: 'exchange' });
    await waitFor(() => b.presence.getState().status, (status) => status === 'connected', 'B back on the street');
    await count(a, 1, 'B below again, seen from the roof');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(b.peers()).toEqual([]);
  }, 30_000);
});
