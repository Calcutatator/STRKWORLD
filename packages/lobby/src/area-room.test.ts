/**
 * D-087 end to end: presence areas through the real room, the real
 * websocket and the real `LobbyClient`.
 *
 * The registry tests prove the rule; these prove the wire carries it: each
 * client decodes only peers in its own area, plus, one way, the street below
 * for a roof player; a switch never shows the area left in the area entered,
 * a shared room's moves are held to its tiles, and the sandbox and the ball
 * stay on the street.
 *
 * Nothing here sleeps for a guessed time. A positive check waits for its
 * condition; a negative one ("this client is not shown that player") waits
 * first for `settled`, which proves the client has decoded a patch the room
 * encoded after whatever is being checked, or for the room's own counters.
 *
 * A file of its own because it needs its own server: the matchmaker is a
 * process-global (see the AGENTS.md finding).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { Room as SdkRoom } from '@colyseus/sdk';
import { BUNKER_PRESENCE_GRID, ROOF_PRESENCE_GRID, SANDBOX_AREA, STUDIO_PRESENCE_GRID } from '@strkworld/shared';
import { MESSAGE } from './config';
import { LobbyClient, type PeerSnapshot } from './client';
import type { PresenceRoom } from './room';
import { startPresenceServer, type PresenceServer } from './server';

const T = 32;
/**
 * Every wire test's budget. Six real joins and a dozen patch round trips
 * took longer than vitest's 5 s default on a loaded CI runner; the other
 * lobby wire tests use the same 20 s.
 */
const WIRE_TIMEOUT_MS = 20_000;
let server: PresenceServer;
const opened: LobbyClient[] = [];

function roof(tileX: number, tileY: number): { x: number; y: number } {
  return { x: ROOF_PRESENCE_GRID.originX + tileX * T + T / 2, y: ROOF_PRESENCE_GRID.originY + tileY * T + T / 2 };
}
function studio(tileX: number, tileY: number): { x: number; y: number } {
  return { x: STUDIO_PRESENCE_GRID.originX + tileX * T + T / 2, y: STUDIO_PRESENCE_GRID.originY + tileY * T + T / 2 };
}

function bunker(tileX: number, tileY: number): { x: number; y: number } {
  return { x: BUNKER_PRESENCE_GRID.originX + tileX * T + T / 2, y: BUNKER_PRESENCE_GRID.originY + tileY * T + T / 2 };
}

async function joined(at: { x: number; y: number }, sprite = 'avatar-2'): Promise<LobbyClient> {
  const client = new LobbyClient({ endpoint: server.endpoint, sprite, start: { ...at, facing: 'down' } });
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

const ids = (peers: readonly PeerSnapshot[]): string[] => peers.map((peer) => peer.gameId).sort();
const sees = (client: LobbyClient, expected: readonly (string | null)[]) =>
  waitFor(() => ids(client.peers()), (value) => JSON.stringify(value) === JSON.stringify([...expected].sort()), `peers ${expected.join(',')}`);
const peerOf = (observer: LobbyClient, peer: LobbyClient) =>
  observer.peers().find((candidate) => candidate.gameId === peer.gameId);

/**
 * A street player that takes one small step east from `home` per call, so
 * each call moves it somewhere it has not been.
 */
interface Mover {
  readonly client: LobbyClient;
  readonly home: { readonly x: number; readonly y: number };
  steps: number;
}

/**
 * Wait until every observer has decoded a patch the room encoded after this
 * call: `mover`, whom every observer is shown, steps, and each observer is
 * shown the step. Whatever the room did before the step (a switch, a
 * refusal) is then in every observer's state, so a negative check after
 * this is a real one, not a guess at how long the room takes.
 */
async function settled(mover: Mover, observers: readonly LobbyClient[], label: string): Promise<void> {
  mover.steps += 1;
  const x = mover.home.x + 2 * mover.steps;
  mover.client.updatePosition(x, mover.home.y, 'right');
  for (const observer of observers) {
    await waitFor(() => peerOf(observer, mover.client)?.x, (seen) => seen === x, `${label}: the step seen`);
  }
}

/** The server's own room holding `client`, for its aggregate counters and state. */
async function roomOf(client: LobbyClient): Promise<PresenceRoom> {
  for (const cached of await matchMaker.query({ name: server.roomName })) {
    const room = matchMaker.getLocalRoomById(cached.roomId) as PresenceRoom | undefined;
    if (room !== undefined && room.state.peers.has(client.gameId as string)) return room;
  }
  throw new Error('no local room holds the client');
}

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
  it('delivers each client the peers in its own area, and the roof the street below', async () => {
    const decodeErrors = vi.spyOn(console, 'error');
    // Street players beside the Exchange, and on the pitch, under the
    // Studio's coordinates; and one between them, whom both see, within the
    // interest radius of the roof's and the Studio's players too.
    const below = await joined({ x: roof(3, 3).x, y: roof(3, 3).y + 3 * T });
    const pitch = await joined(studio(6, 5));
    const passer: Mover = { client: await joined({ x: 848, y: 304 }), home: { x: 848, y: 304 }, steps: 0 };
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
    const street = passer.client.gameId as string;

    // The roof sees itself and the street below; the Studio only itself.
    await sees(climber1, [climber2.gameId, below.gameId, street]);
    await sees(climber2, [climber1.gameId, below.gameId, street]);
    await sees(dresser1, [dresser2.gameId]);
    await sees(dresser2, [dresser1.gameId]);
    // The street sees neither, once it has caught up with every switch.
    await settled(passer, [below, pitch, climber1], 'after the switches');
    expect(ids(below.peers())).toEqual([street]);
    expect(ids(pitch.peers())).toEqual([street]);
    expect(ids(dresser1.peers())).toEqual([dresser2.gameId]);
    // A street move reaches the roof; the roof's never reaches the street.
    below.updatePosition(roof(3, 3).x + 40, roof(3, 3).y + 3 * T, 'right');
    for (const observer of [climber1, climber2, passer.client]) {
      await waitFor(() => peerOf(observer, below)?.x, (x) => x === roof(3, 3).x + 40, 'the street move');
    }
    expect(ids(passer.client.peers())).toEqual([below.gameId, pitch.gameId].sort());
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
    const room = await roomOf(climber1);
    climber1.updatePosition(roof(1, 1).x, roof(1, 1).y, 'left');
    await waitFor(() => peerOf(climber2, climber1), (peer) => peer?.x === roof(1, 1).x && peer?.y === roof(1, 1).y, 'roof move');
    const refused = room.counters.rejected;
    climber1.updatePosition(roof(0, 1).x, roof(0, 1).y, 'left');
    await waitFor(() => room.counters.rejected, (count) => count > refused, 'the step off the deck refused');
    await settled(passer, [climber2, below, pitch], 'after the refusal');
    expect(peerOf(climber2, climber1)).toMatchObject(roof(1, 1));
    const held = room.state.peers.get(climber1.gameId as string)?.position;
    expect({ x: held?.x, y: held?.y }).toEqual(roof(1, 1));
    expect(ids(below.peers())).toEqual([street]);
    expect(ids(pitch.peers())).toEqual([street]);
    expect(decodeErrors.mock.calls.some((call) => String(call[0]).includes('refId'))).toBe(false);
  }, WIRE_TIMEOUT_MS);

  it('shares the bunker (D-112): its two players see each other move and jump, nobody else does, and leaving switches back', async () => {
    // A street player standing on the bunker's World pixels (it is drawn
    // over the hidden street), a street mover beside it, and a Studio
    // player on the same pixels (the Studio is drawn at the same origin).
    const street = await joined(bunker(2, 8));
    const passer: Mover = { client: await joined(bunker(4, 8)), home: bunker(4, 8), steps: 0 };
    const dresser = await joined(bunker(2, 8));
    const down1 = await joined(bunker(3, 8));
    const down2 = await joined(bunker(3, 8));
    dresser.enterArea('studio', studio(2, 8), 'avatar-2');
    down1.suspend();
    down1.enterArea('bunker', bunker(2, 8), 'avatar-2');
    down2.enterArea('bunker', bunker(1, 9), 'avatar-5');
    await sees(down1, [down2.gameId]);
    await sees(down2, [down1.gameId]);
    await sees(dresser, []);
    await settled(passer, [street], 'after the bunker entries');
    expect(ids(street.peers())).toEqual([passer.client.gameId]);
    expect(down1.area).toBe('bunker');

    // A move and a jump reach the other bunker player.
    down1.updatePosition(bunker(3, 7).x, bunker(3, 7).y, 'up');
    await waitFor(() => peerOf(down2, down1), (peer) => peer?.x === bunker(3, 7).x && peer?.y === bunker(3, 7).y, 'the bunker move');
    expect(down1.jump()).toBe(true);
    await waitFor(() => peerOf(down2, down1)?.jumps, (jumps) => jumps === 1, 'the bunker jump');
    // A move onto the lift's doors (out of order) is refused and held.
    const room = await roomOf(down1);
    const refused = room.counters.rejected;
    down1.updatePosition(bunker(2, 6).x, bunker(2, 6).y, 'up');
    await waitFor(() => room.counters.rejected, (count) => count > refused, 'the step into the lift refused');
    const held = room.state.peers.get(down1.gameId as string)?.position;
    expect({ x: held?.x, y: held?.y }).toEqual(bunker(3, 7));
    await settled(passer, [street], 'after the bunker moves');
    expect(ids(street.peers())).toEqual([passer.client.gameId]);
    expect(dresser.peers()).toEqual([]);

    // Up the stair: down2 is the street's again, and gone from the bunker.
    down2.enterArea('street', bunker(4, 9), 'avatar-5');
    await sees(street, [passer.client.gameId, down2.gameId]);
    await sees(down1, []);
    expect(down2.area).toBe('street');
  }, WIRE_TIMEOUT_MS);

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
  }, WIRE_TIMEOUT_MS);

  it('leaves no ghost behind when a player is erased and placed again inside one patch', async () => {
    // A street neighbour sees two players by the Exchange's door. Each goes
    // in and straight back out of the street's view in back-to-back
    // messages: one up to the roof, one back onto the street far away. The
    // room holds each placement a patch, so the erasure reaches the
    // neighbour, rather than a frozen copy of where they stood.
    const door = { x: roof(3, 3).x, y: roof(3, 3).y + 4 * T };
    const neighbour = await joined({ x: door.x, y: door.y + T });
    const passer: Mover = { client: await joined({ x: door.x - T, y: door.y + T }), home: { x: door.x - T, y: door.y + T }, steps: 0 };
    const climber = await joined(door);
    const runner = await joined({ x: door.x + T, y: door.y });
    await sees(neighbour, [passer.client.gameId, climber.gameId, runner.gameId]);
    const room = await roomOf(neighbour);
    climber.suspend();
    climber.enterArea('roof', roof(3, 3), 'avatar-2');
    runner.suspend();
    runner.resume({ x: door.x + 30 * T, y: door.y, facing: 'right' });
    // Both are placed again, a patch later...
    await waitFor(() => room.state.peers.has(climber.gameId as string) && room.state.peers.has(runner.gameId as string), (placed) => placed, 'both placed again');
    await sees(climber, [neighbour.gameId, passer.client.gameId]);
    // ...and the neighbour, caught up, is shown neither.
    await settled(passer, [neighbour, climber], 'after both placements');
    expect(ids(neighbour.peers())).toEqual([passer.client.gameId]);
    expect(ids(runner.peers())).toEqual([]);
  }, WIRE_TIMEOUT_MS);

  it('sends the area verb with a placement and a sprite and nothing else', async () => {
    const client = await joined(studio(6, 5));
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    client.enterArea('studio', { x: studio(9, 1).x, y: studio(9, 1).y, facing: 'up', extra: 'dropped' } as never, 'avatar-3');
    const call = send.mock.calls.find(([type]) => type === MESSAGE.area);
    expect(call?.[1]).toEqual({ area: 'studio', ...studio(9, 1), facing: 'up', sprite: 'avatar-3' });
  }, WIRE_TIMEOUT_MS);

  it('keeps the sandbox and the ball on the street', async () => {
    const client = await joined({ x: (SANDBOX_AREA.x + 2) * T, y: 2 * T });
    client.enterArea('studio', studio(9, 1), 'avatar-2');
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    client.pickBlock({ x: SANDBOX_AREA.x + 1, y: 1 });
    client.placeBlock({ x: SANDBOX_AREA.x + 1, y: 1 });
    expect(client.kick()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(client.sandbox().carrying).toBeNull();
  }, WIRE_TIMEOUT_MS);

  it('fails closed when the room refuses a switch: the avatar is seen by no one', async () => {
    const watcher = await joined(studio(6, 5));
    const witness: Mover = { client: await joined(studio(7, 5)), home: studio(7, 5), steps: 0 };
    const stray = await joined(studio(6, 6));
    await sees(watcher, [stray.gameId, witness.client.gameId]);
    const room = await roomOf(watcher);
    // Off the Studio's floor: the room suspends the session.
    stray.enterArea('studio', studio(0, 0), 'avatar-2');
    await sees(watcher, [witness.client.gameId]);
    expect(room.counters.suspended).toBe(1);
    // The stray's client still thinks it is in the Studio and moves; the
    // room drops every move from a suspended session.
    const send = vi.spyOn(SdkRoom.prototype, 'send');
    stray.updatePosition(studio(6, 6).x, studio(6, 6).y);
    await waitFor(() => send.mock.calls.some(([type]) => type === MESSAGE.move), (sent) => sent, 'the stray move sent');
    await settled(witness, [watcher], 'after the stray move');
    expect(ids(watcher.peers())).toEqual([witness.client.gameId]);
    expect(room.state.peers.has(stray.gameId as string)).toBe(false);
  }, WIRE_TIMEOUT_MS);

  it('refuses to switch a client that is not on the air, or to a name that is not an area', async () => {
    const idle = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });
    expect(() => idle.enterArea('roof', roof(2, 2))).toThrow(/connected or suspended/);
    const client = await joined(studio(6, 5));
    expect(() => client.enterArea('vault' as never, roof(2, 2))).toThrow(/area is invalid/);
    expect(() => client.enterArea('roof', { x: Number.NaN, y: 0 })).toThrow(/placement is invalid/);
    expect(client.area).toBe('street');
  }, WIRE_TIMEOUT_MS);
});
