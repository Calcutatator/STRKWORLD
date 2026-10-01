/**
 * D-086 end to end: interest management under churn, against a real Colyseus
 * server, real websocket clients and the real room class.
 *
 * A crowd teleports about a small square far faster than anyone walks, with a
 * small interest radius and a small cap, so entries enter and leave every
 * observer's view on almost every patch. Two things must hold:
 *
 *   - Every client decodes every patch. When the room recomputed views on
 *     every move, one entry could be dropped and re-added inside one patch,
 *     and `@colyseus/schema@4.0.30` encoded that so clients lost track of it:
 *     the SDK logged `"refId" not found`, skipped the entry's updates and
 *     that peer froze on screen. The load test counted thousands a minute.
 *   - Views are recomputed once per patch, not once per move: the room's
 *     interest work is bounded by its patch rate, whatever the move rate.
 *
 * And at the end, each client's decoded peers are exactly the entries the
 * room's own rule (`selectVisible`) picks for it, at their latest positions.
 *
 * A file of its own because it needs its own room definition, and the
 * matchmaker is a process-global (see the AGENTS.md finding).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Room, Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as ColyseusClient, Room as SdkRoom, type Room as ColyseusRoom } from '@colyseus/sdk';
import { DEFAULT_ROOM_NAME, MESSAGE, SERVER_MESSAGE, resolveRoomConfig, type PresenceRoomConfig } from './config';
import { selectVisible } from './policy';
import { LobbyPresence } from './presence';
import { PresenceRoom } from './room';
import type { LobbyState } from './state';

/** The protocol byte of the server's join reply, which the client acknowledges. */
const JOIN_ROOM = 10;
const RADIUS = 300;
const CAP = 4;
const CROWD = 12;
const SQUARE = 700;

/** A small radius and cap, and a fast move floor, so views churn constantly. */
class ChurnRoom extends PresenceRoom {
  protected override roomConfig: PresenceRoomConfig = resolveRoomConfig({
    interestRadius: RADIUS,
    maxVisiblePeers: CAP,
    minUpdateIntervalMs: 10,
    capacity: 64,
  });
}

let server: Server;
let endpoint = '';

beforeAll(async () => {
  for (let attempt = 0; ; attempt += 1) {
    const port = 50_000 + Math.floor(Math.random() * 3_000);
    const candidate = new Server({ transport: new WebSocketTransport(), greet: false, gracefullyShutdown: false });
    candidate.define(DEFAULT_ROOM_NAME, ChurnRoom);
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

afterEach(() => {
  vi.restoreAllMocks();
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Member {
  readonly room: ColyseusRoom<unknown, LobbyState>;
  gameId: string;
  x: number;
  y: number;
}

describe('interest sync for joiners (D-086)', () => {
  it('shows clients that join at the same moment to each other, with nobody moving after', async () => {
    // Every client takes 120 ms to acknowledge its join, as over a real
    // network, so each is still joining when the next patches go out.
    type Callback = (this: unknown, event: { data: ArrayBuffer }) => void;
    const proto = SdkRoom.prototype as unknown as { onMessageCallback: Callback };
    const deliver = proto.onMessageCallback;
    vi.spyOn(proto, 'onMessageCallback').mockImplementation(function (this: unknown, event) {
      if (new Uint8Array(event.data)[0] === JOIN_ROOM) setTimeout(() => deliver.call(this, event), 120);
      else deliver.call(this, event);
    });
    // As many as one view holds (itself and the cap), so everyone sees everyone.
    const joins = Array.from({ length: CAP + 1 }, (_, index) =>
      new ColyseusClient(endpoint).joinOrCreate<LobbyState>(DEFAULT_ROOM_NAME, {
        x: 5000 + index * 10,
        y: 5000,
        facing: 'down',
        sprite: 'avatar-1',
      }),
    );
    const rooms = await Promise.all(joins);
    // Nobody moves: only the joins themselves can bring the views up to date.
    const limit = Date.now() + 3000;
    while (rooms.some((room) => room.state.peers?.size !== rooms.length) && Date.now() < limit) {
      await wait(20);
    }
    expect(rooms.map((room) => room.state.peers.size)).toEqual(rooms.map(() => rooms.length));
    await Promise.all(rooms.map((room) => room.leave(true).catch(() => undefined)));
  });
});

describe('interest sync under churn (D-086)', () => {
  it('keeps every client decoding, recomputes views once per patch, and ends with exactly the right peers', async () => {
    const decodeErrors: unknown[] = [];
    const realError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('refId')) decodeErrors.push(args[0]);
      else realError(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const visibleTo = vi.spyOn(LobbyPresence.prototype, 'visibleTo');
    const patches = vi.spyOn(Room.prototype, 'broadcastPatch');

    const random = mulberry32(86);
    const spot = () => Math.round(1000 + random() * SQUARE);
    const members: Member[] = [];
    for (let index = 0; index < CROWD; index += 1) {
      const x = spot();
      const y = spot();
      const room = await new ColyseusClient(endpoint).joinOrCreate<LobbyState>(DEFAULT_ROOM_NAME, {
        x,
        y,
        facing: 'down',
        sprite: 'avatar-1',
      });
      const member: Member = { room, gameId: '', x, y };
      room.onMessage(SERVER_MESSAGE.welcome, (payload: { gameId: string }) => {
        member.gameId = payload.gameId;
      });
      members.push(member);
    }
    await wait(200);
    expect(members.every((member) => /^[0-9a-f]{16}$/.test(member.gameId))).toBe(true);

    const joinCalls = visibleTo.mock.calls.length;
    const patchesBefore = patches.mock.calls.length;
    // Two seconds of teleporting, every member every 30 ms: about 800 moves,
    // each client under the room's hard ceiling of 40 messages a second.
    let moves = 0;
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      for (const member of members) {
        member.x = spot();
        member.y = spot();
        member.room.send(MESSAGE.move, { x: member.x, y: member.y, facing: 'up' });
        moves += 1;
      }
      await wait(30);
    }
    await wait(300);

    expect(decodeErrors).toEqual([]);
    // Nobody was dropped, so every decoded state below is live.
    expect(members.every((member) => member.room.connection.isOpen)).toBe(true);

    // Once per patch: at most one recompute per client per patch, against
    // one per client per move before.
    const syncCalls = visibleTo.mock.calls.length - joinCalls;
    const patchCount = patches.mock.calls.length - patchesBefore;
    expect(moves).toBeGreaterThan(500);
    expect(syncCalls).toBeLessThanOrEqual(patchCount * CROWD);
    expect(syncCalls).toBeLessThan(moves);

    // Each client holds exactly its own entry and the room's pick for it.
    const byId = new Map(members.map((member) => [member.gameId, member]));
    for (const member of members) {
      const others = members
        .filter((other) => other !== member)
        .map((other) => ({ gameId: other.gameId, position: { x: other.x, y: other.y } }));
      const expected = selectVisible({ position: { x: member.x, y: member.y } }, others, RADIUS, CAP)
        .map((entry) => entry.gameId)
        .concat(member.gameId)
        .sort();
      const decoded: string[] = [];
      member.room.state.peers.forEach((entry, key) => {
        decoded.push(key);
        const truth = byId.get(key);
        expect(entry.position.x).toBe(truth?.x);
        expect(entry.position.y).toBe(truth?.y);
      });
      expect(decoded.sort()).toEqual(expected);
    }

    await Promise.all(members.map((member) => member.room.leave(true).catch(() => undefined)));
  }, 20_000);
});
