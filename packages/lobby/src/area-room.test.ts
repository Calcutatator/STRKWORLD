/**
 * D-087 end to end: presence areas through the real room, the real
 * websocket and the real `LobbyClient`.
 *
 * The registry tests prove the rule; these prove the wire carries it: each
 * client decodes only peers in its own area, a switch never shows the area
 * left in the area entered, a shared room's moves are held to its tiles, and
 * the sandbox and the ball stay on the street.
 *
 * A file of its own because it needs its own server: the matchmaker is a
 * process-global (see the AGENTS.md finding).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { Room as SdkRoom } from '@colyseus/sdk';
import { ROOF_PRESENCE_GRID, SANDBOX_AREA, STUDIO_PRESENCE_GRID } from '@strkworld/shared';
import { MESSAGE } from './config';
import { LobbyClient, type PeerSnapshot } from './client';
import { startPresenceServer, type PresenceServer } from './server';

const T = 32;
let server: PresenceServer;
const opened: LobbyClient[] = [];

function roof(tileX: number, tileY: number): { x: number; y: number } {
  return { x: ROOF_PRESENCE_GRID.originX + tileX * T + T / 2, y: ROOF_PRESENCE_GRID.originY + tileY * T + T / 2 };
}
function studio(tileX: number, tileY: number): { x: number; y: number } {
  return { x: STUDIO_PRESENCE_GRID.originX + tileX * T + T / 2, y: STUDIO_PRESENCE_GRID.originY + tileY * T + T / 2 };
}

async function joined(at: { x: number; y: number }, sprite = 'avatar-2'): Promise<LobbyClient> {
  const client = new LobbyClient({ endpoint: server.endpoint, sprite, start: { ...at, facing: 'down' } });
  opened.push(client);
  await client.connect();
  return client;
}

async function waitFor<T>(read: () => T, ready: (value: T) => boolean, label: string, timeoutMs = 6000): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ids = (peers: readonly PeerSnapshot[]): string[] => peers.map((peer) => peer.gameId).sort();
const sees = (client: LobbyClient, expected: readonly (string | null)[]) =>
  waitFor(() => ids(client.peers()), (value) => JSON.stringify(value) === JSON.stringify([...expected].sort()), `peers ${expected.join(',')}`);

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 46_000 + Math.floor(Math.random() * 3_000),
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

describe('presence areas over the wire (D-087)', () => {
  it('delivers each client only the peers in its own area', async () => {
    const decodeErrors = vi.spyOn(console, 'error');
    // Street players beside the Exchange, under its roof, and on the pitch,
    // under the Studio's coordinates.
    const below = await joined({ x: roof(3, 3).x, y: roof(3, 3).y + 3 * T });
    const pitch = await joined(studio(6, 5));
    const climber1 = await joined({ x: roof(3, 3).x, y: roof(3, 3).y + 4 * T });
    const climber2 = await joined({ x: roof(3, 3).x, y: roof(3, 3).y + 4 * T });
    const dresser1 = await joined(studio(6, 6));
    const dresser2 = await joined(studio(6, 6), 'avatar-7');
    climber1.suspend();
    climber2.suspend();
    climber1.enterArea('roof', roof(3, 3), 'avatar-2');
    climber2.enterArea('roof', roof(4, 2), 'avatar-2');
    dresser1.enterArea('studio', studio(6, 5), 'avatar-2');
    dresser2.enterArea('studio', studio(9, 1), 'avatar-11');

    await sees(climber1, [climber2.gameId]);
    await sees(climber2, [climber1.gameId]);
    await sees(dresser1, [dresser2.gameId]);
    await sees(dresser2, [dresser1.gameId]);
    await sees(below, []);
    await sees(pitch, []);
    // The Studio shows its players with their current look, and a new look
    // at once, without withdrawing anyone from view.
    expect(dresser1.peers()[0]?.sprite).toBe('avatar-11');
    dresser2.enterArea('studio', studio(9, 1), 'avatar-12');
    expect(ids(dresser2.peers())).toEqual([dresser1.gameId]);
    await waitFor(() => dresser1.peers()[0]?.sprite, (sprite) => sprite === 'avatar-12', 'the new look');
    expect(climber1.area).toBe('roof');
    expect(dresser1.area).toBe('studio');
    expect(below.area).toBe('street');

    // A roof player's moves reach the other roof player, held to the deck.
    climber1.updatePosition(roof(1, 1).x, roof(1, 1).y, 'left');
    await waitFor(() => climber2.peers()[0], (peer) => peer?.x === roof(1, 1).x && peer?.y === roof(1, 1).y, 'roof move');
    climber1.updatePosition(roof(0, 1).x, roof(0, 1).y, 'left');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(climber2.peers()[0]).toMatchObject(roof(1, 1));
    expect(decodeErrors.mock.calls.some((call) => String(call[0]).includes('refId'))).toBe(false);
  });

  it('never shows the area left in the area entered, and comes back to the street', async () => {
    const walker = await joined(studio(6, 5));
    const dresser = await joined(studio(6, 6));
    const resident = await joined(studio(6, 6));
    resident.enterArea('studio', studio(10, 4), 'avatar-2');
    await sees(dresser, [walker.gameId]);

    const seen: string[][] = [];
    dresser.onPeers((peers) => seen.push(ids(peers)));
    seen.length = 0;
    dresser.enterArea('studio', studio(9, 1), 'avatar-4');
    // Withdrawn at once, before any patch.
    expect(dresser.peers()).toEqual([]);
    await sees(dresser, [resident.gameId]);
    expect(seen.every((snapshot) => !snapshot.includes(walker.gameId as string))).toBe(true);
    await sees(walker, []);

    seen.length = 0;
    dresser.enterArea('street', studio(6, 6), 'avatar-4');
    await sees(dresser, [walker.gameId]);
    expect(seen.every((snapshot) => !snapshot.includes(resident.gameId as string))).toBe(true);
    await sees(walker, [dresser.gameId]);
    expect(walker.peers()[0]?.sprite).toBe('avatar-4');
  });

  it('sends the area verb with a placement and a sprite and nothing else', async () => {
    const client = await joined(studio(6, 5));
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    client.enterArea('studio', { x: studio(9, 1).x, y: studio(9, 1).y, facing: 'up', extra: 'dropped' } as never, 'avatar-3');
    const call = send.mock.calls.find(([type]) => type === MESSAGE.area);
    expect(call?.[1]).toEqual({ area: 'studio', ...studio(9, 1), facing: 'up', sprite: 'avatar-3' });
  });

  it('keeps the sandbox and the ball on the street', async () => {
    const client = await joined({ x: (SANDBOX_AREA.x + 2) * T, y: 2 * T });
    client.enterArea('studio', studio(9, 1), 'avatar-2');
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    client.pickBlock({ x: SANDBOX_AREA.x + 1, y: 1 });
    client.placeBlock({ x: SANDBOX_AREA.x + 1, y: 1 });
    expect(client.kick()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(client.sandbox().carrying).toBeNull();
  });

  it('fails closed when the room refuses a switch: the avatar is seen by no one', async () => {
    const watcher = await joined(studio(6, 5));
    const stray = await joined(studio(6, 6));
    await sees(watcher, [stray.gameId]);
    // Off the Studio's floor: the room suspends the session.
    stray.enterArea('studio', studio(0, 0), 'avatar-2');
    await sees(watcher, []);
    stray.updatePosition(studio(6, 6).x, studio(6, 6).y);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(watcher.peers()).toEqual([]);
  });

  it('refuses to switch a client that is not on the air, or to a name that is not an area', async () => {
    const idle = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });
    expect(() => idle.enterArea('roof', roof(2, 2))).toThrow(/connected or suspended/);
    const client = await joined(studio(6, 5));
    expect(() => client.enterArea('vault' as never, roof(2, 2))).toThrow(/area is invalid/);
    expect(() => client.enterArea('roof', { x: Number.NaN, y: 0 })).toThrow(/placement is invalid/);
    expect(client.area).toBe('street');
  });
});
