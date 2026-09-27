/**
 * The block sandbox (D-060) end to end: a real Colyseus server, real
 * websocket clients, the real room.
 *
 * One server for the file, as the matchmaker is a process-global (see the
 * AGENTS.md finding). It is tuned so every room receives exactly one sky drop
 * shortly after the first player arrives, and then no new block for an hour:
 * blocks are conserved, so any later drop is a carried block coming back when
 * its carrier leaves the street.
 *
 * Every test starts from a fresh room: `afterEach` disposes whatever rooms
 * remain, because an emptied room otherwise lingers for its seat-reservation
 * window and would carry its blocks into the next test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import { SANDBOX_AREA, type SandboxColumn, type SandboxTile } from '@strkworld/shared';
import {
  DEFAULT_ROOM_NAME,
  MESSAGE,
  SANDBOX_CLIENT_ACTION_INTERVAL_MS,
  SERVER_MESSAGE,
} from './config';
import { LobbyClient, type PeerSnapshot } from './client';
import { isSandboxTile } from './sandbox-rules';
import { startPresenceServer, type PresenceServer } from './server';
import type { LobbyState } from './state';
import vocabulary from './testing/forbidden-vocabulary.json';

const INTEREST_RADIUS = 300;
const SPAWN_MS = 400;
const T = 32;
const LEFT = SANDBOX_AREA.x;

/** On the road four tiles west of the sandbox: close to it, but outside the drop zone. */
const WAITING = { x: (LEFT - 4) * T + T / 2, y: 5 * T + T / 2 };

let server: PresenceServer;
const opened: LobbyClient[] = [];
const raws: ColyseusRoom<unknown, LobbyState>[] = [];

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 50_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: {
      interestRadius: INTEREST_RADIUS,
      minUpdateIntervalMs: 10,
      sandboxSpawnIntervalMs: SPAWN_MS,
      sandboxFastSpawnLimit: 1,
      sandboxSlowSpawnIntervalMs: 3_600_000,
    },
  });
});

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
  while (raws.length > 0) await raws.pop()?.leave(true).catch(() => undefined);
  await Promise.all(matchMaker.disconnectAll());
  await sleep(50);
});

afterAll(async () => {
  await server.shutdown();
});

function makeClient(x = WAITING.x, y = WAITING.y): LobbyClient {
  const client = new LobbyClient({ endpoint: server.endpoint, sprite: 'avatar-2', start: { x, y } });
  opened.push(client);
  return client;
}

interface RawPlayer {
  readonly room: ColyseusRoom<unknown, LobbyState>;
  readonly gameId: string;
  readonly drops: unknown[];
}

/** A bare SDK client, so tests can put anything on the wire. */
async function rawJoin(at: { x: number; y: number }): Promise<RawPlayer> {
  const sdk = new ColyseusClient(server.endpoint);
  const room = await sdk.joinOrCreate<LobbyState>(DEFAULT_ROOM_NAME, {
    x: at.x,
    y: at.y,
    facing: 'down',
    sprite: 'avatar-1',
  });
  room.reconnection.enabled = false;
  raws.push(room);
  let gameId = '';
  const drops: unknown[] = [];
  room.onMessage(SERVER_MESSAGE.welcome, (payload: { gameId: string }) => {
    gameId = payload.gameId;
  });
  room.onMessage(SERVER_MESSAGE.sandboxDrop, (payload: unknown) => drops.push(payload));
  await waitFor(() => gameId, (id) => id.length === 16, 'the raw welcome');
  return { room, gameId, drops };
}

/** The carrying field on a raw player's own presence entry. */
function rawCarrying(player: RawPlayer): number | undefined {
  return player.room.state.peers?.get(player.gameId)?.carrying;
}

async function waitFor<V>(
  read: () => V,
  ready: (value: V) => boolean,
  label: string,
  timeoutMs = 6000,
): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function centreOf(tile: SandboxTile): { x: number; y: number } {
  return { x: tile.x * T + T / 2, y: tile.y * T + T / 2 };
}

function sameTile(a: SandboxTile, b: SandboxTile): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Orthogonal neighbours inside the sandbox. */
function neighbours(tile: SandboxTile): SandboxTile[] {
  return [
    { x: tile.x - 1, y: tile.y },
    { x: tile.x + 1, y: tile.y },
    { x: tile.x, y: tile.y - 1 },
    { x: tile.x, y: tile.y + 1 },
  ].filter((candidate) => isSandboxTile(candidate.x, candidate.y));
}

function plain(columns: readonly SandboxColumn[]): SandboxColumn[] {
  return columns.map(({ x, y, colours }) => ({ x, y, colours: [...colours] }));
}

async function onlyColumn(client: LobbyClient): Promise<SandboxColumn> {
  const columns = await waitFor(
    () => client.sandbox().columns,
    (list) => list.length === 1,
    'the first sky drop',
  );
  return columns[0] as SandboxColumn;
}

function peerOf(observer: LobbyClient, subject: LobbyClient): PeerSnapshot | undefined {
  return observer.peers().find((peer) => peer.gameId === subject.gameId);
}

/**
 * Put `mover` on the centre of `stand` and `observer` on the same tile, then
 * wait until the observer sees the mover there — so the server holds both.
 */
async function gather(
  observer: LobbyClient,
  mover: LobbyClient,
  stand: SandboxTile,
): Promise<{ x: number; y: number }> {
  const spot = centreOf(stand);
  observer.updatePosition(spot.x + 8, spot.y + 8, 'left');
  mover.updatePosition(spot.x, spot.y, 'right');
  await waitFor(
    () => peerOf(observer, mover),
    (peer) => peer?.x === spot.x && peer?.y === spot.y,
    'the mover to arrive beside the stack',
  );
  return spot;
}

function findLeak(surface: string): string | null {
  const haystack = surface.toLowerCase();
  for (const word of vocabulary.substrings) {
    if (haystack.includes(word)) return `substring "${word}"`;
  }
  for (const pattern of vocabulary.patterns) {
    if (new RegExp(pattern.regex).test(surface)) return `pattern "${pattern.name}"`;
  }
  return null;
}

describe('the shared sandbox reaches everyone', () => {
  it('shows every client the same columns, even one far outside the interest radius', async () => {
    const a = makeClient();
    const b = makeClient(WAITING.x + 40, WAITING.y);
    const far = makeClient(T / 2, T / 2);
    await a.connect();
    await b.connect();
    await far.connect();

    const column = await onlyColumn(a);
    expect(isSandboxTile(column.x, column.y)).toBe(true);
    expect(column.colours).toHaveLength(1);
    await waitFor(() => b.sandbox().columns, (list) => list.length === 1, 'b to see the stack');
    await waitFor(() => far.sandbox().columns, (list) => list.length === 1, 'far to see the stack');
    expect(plain(b.sandbox().columns)).toEqual(plain(a.sandbox().columns));
    expect(plain(far.sandbox().columns)).toEqual(plain(a.sandbox().columns));

    // Presence is still interest-filtered; only the sandbox is room-wide.
    await waitFor(
      () => a.peers(),
      (peers) => peers.some((peer) => peer.gameId === b.gameId),
      'a to see b',
    );
    expect(far.peers()).toEqual([]);
    expect(a.peers().some((peer) => peer.gameId === far.gameId)).toBe(false);
  });

  it('broadcasts a drop as a bare tile after the state that holds it, and only while someone is on the street', async () => {
    // A connected but suspended player: nobody is on the street yet.
    const watcher = await rawJoin(WAITING);
    watcher.room.send(MESSAGE.suspend);
    await sleep(SPAWN_MS * 3);
    expect(watcher.drops).toEqual([]);
    expect(watcher.room.state.sandbox?.size ?? 0).toBe(0);

    const a = makeClient();
    const drops: SandboxTile[] = [];
    const heldAtDrop: boolean[] = [];
    a.onSandboxDrop((tile) => {
      drops.push(tile);
      heldAtDrop.push(a.sandbox().columns.some((column) => sameTile(column, tile)));
    });
    await a.connect();

    await waitFor(() => drops.length, (count) => count === 1, 'the drop hint');
    await waitFor(() => watcher.drops.length, (count) => count === 1, 'the suspended watcher to hear it');
    const tile = drops[0] as SandboxTile;
    expect(heldAtDrop).toEqual([true]);
    expect(watcher.drops[0]).toEqual({ x: tile.x, y: tile.y });
    expect(Object.keys(watcher.drops[0] as object).sort()).toEqual(['x', 'y']);
    expect(plain(a.sandbox().columns)).toEqual([
      { x: tile.x, y: tile.y, colours: [expect.any(Number)] },
    ]);

    const surface = JSON.stringify([watcher.drops, a.sandbox(), watcher.room.state.sandbox]);
    expect(surface).not.toContain(a.gameId as string);
    expect(surface).not.toContain(watcher.gameId);
    expect(findLeak(surface)).toBeNull();
  });
});

describe('pick and place through the room', () => {
  it('round-trips a block, and a nearby peer sees the carried colour', async () => {
    const a = makeClient();
    const b = makeClient(WAITING.x + 40, WAITING.y);
    await a.connect();
    await b.connect();
    const column = await onlyColumn(a);
    const colour = column.colours[0] as number;
    const stand = neighbours(column)[0] as SandboxTile;
    const target = neighbours(stand).find((tile) => !sameTile(tile, column)) as SandboxTile;
    await gather(b, a, stand);

    a.pickBlock({ x: column.x, y: column.y });
    await waitFor(
      () => a.sandbox(),
      (snapshot) => snapshot.carrying === colour && snapshot.columns.length === 0,
      'a to carry the block',
    );
    await waitFor(() => b.sandbox().columns, (list) => list.length === 0, 'b to see the stack go');
    await waitFor(() => peerOf(b, a)?.carrying, (value) => value === colour, 'b to see a carrying');
    expect(b.sandbox().carrying).toBeNull();

    // Placed the moment the pick shows up — well inside both floors. The
    // client holds it until its floor opens rather than losing it.
    a.placeBlock(target);
    const placed = [{ x: target.x, y: target.y, colours: [colour] }];
    await waitFor(
      () => a.sandbox(),
      (snapshot) => snapshot.carrying === null && JSON.stringify(plain(snapshot.columns)) === JSON.stringify(placed),
      'a to place the block',
    );
    await waitFor(
      () => plain(b.sandbox().columns),
      (list) => JSON.stringify(list) === JSON.stringify(placed),
      'b to see the placed block',
    );
    await waitFor(() => peerOf(b, a)?.carrying, (value) => value === null, 'b to see a empty-handed');
  });

  it('changes nothing for malformed payloads or out-of-reach requests', async () => {
    const observer = makeClient();
    await observer.connect();
    const column = await onlyColumn(observer);
    const colour = column.colours[0] as number;
    const stand = neighbours(column)[0] as SandboxTile;

    const farTile = { x: column.x - 3 >= LEFT ? column.x - 3 : column.x + 3, y: column.y };
    const distant = await rawJoin(centreOf(farTile));
    distant.room.send(MESSAGE.sandboxPick, { x: column.x, y: column.y });

    const beside = await rawJoin(centreOf(stand));
    const hostile: unknown[] = [
      null,
      'pick',
      42,
      [column.x, column.y],
      {},
      { x: column.x },
      { x: column.x + 0.5, y: column.y },
      { x: Number.NaN, y: column.y },
      { x: column.x, y: Number.POSITIVE_INFINITY },
      { x: String(column.x), y: String(column.y) },
      { x: -column.x, y: -column.y },
      { x: 1e9, y: 1e9 },
      { x: column.x, y: column.y + SANDBOX_AREA.height },
    ];
    for (const payload of hostile) beside.room.send(MESSAGE.sandboxPick, payload);
    for (const payload of hostile) beside.room.send(MESSAGE.sandboxPlace, payload);
    await sleep(400);

    expect(plain(observer.sandbox().columns)).toEqual(plain([column]));
    expect(rawCarrying(beside)).toBe(-1);
    expect(rawCarrying(distant)).toBe(-1);
    expect(beside.room.connection.isOpen).toBe(true);

    // Malformed input consumed no floor: a valid pick sent right behind it lands.
    for (const payload of hostile.slice(0, 5)) beside.room.send(MESSAGE.sandboxPick, payload);
    beside.room.send(MESSAGE.sandboxPick, { x: column.x, y: column.y });
    await waitFor(() => rawCarrying(beside), (value) => value === colour, 'the valid pick to land');
    await waitFor(() => observer.sandbox().columns, (list) => list.length === 0, 'the stack to go');
  });

  it('drops a second action that arrives inside the server floor', async () => {
    const observer = makeClient();
    await observer.connect();
    const column = await onlyColumn(observer);
    const colour = column.colours[0] as number;
    const stand = neighbours(column)[0] as SandboxTile;
    const target = neighbours(stand).find((tile) => !sameTile(tile, column)) as SandboxTile;
    const actor = await rawJoin(centreOf(stand));

    actor.room.send(MESSAGE.sandboxPick, { x: column.x, y: column.y });
    actor.room.send(MESSAGE.sandboxPlace, { x: target.x, y: target.y });
    await waitFor(() => rawCarrying(actor), (value) => value === colour, 'the pick to land');
    await sleep(400);
    expect(rawCarrying(actor)).toBe(colour);
    expect(observer.sandbox().columns).toEqual([]);

    actor.room.send(MESSAGE.sandboxPlace, { x: target.x, y: target.y });
    await waitFor(
      () => plain(observer.sandbox().columns),
      (list) => JSON.stringify(list) === JSON.stringify([{ x: target.x, y: target.y, colours: [colour] }]),
      'the later place to land',
    );
    expect(rawCarrying(actor)).toBe(-1);
  });
});

describe('a carried block goes back to the sky with its carrier (conservation)', () => {
  it('falls back on suspend, keeping its colour and away from the carrier, and resume starts empty-handed', async () => {
    const a = makeClient();
    const b = makeClient(WAITING.x + 40, WAITING.y);
    const drops: SandboxTile[] = [];
    b.onSandboxDrop((tile) => drops.push(tile));
    await a.connect();
    await b.connect();
    const column = await onlyColumn(a);
    const colour = column.colours[0] as number;
    const stand = neighbours(column)[0] as SandboxTile;
    const spot = await gather(b, a, stand);
    drops.length = 0;

    a.pickBlock({ x: column.x, y: column.y });
    await waitFor(() => peerOf(b, a)?.carrying, (value) => value === colour, 'b to see a carrying');
    await waitFor(() => b.sandbox().columns, (list) => list.length === 0, 'the stack to go');

    a.suspend();
    expect(a.sandbox().carrying).toBeNull();
    // Not destroyed: it falls from the sky, announced like any drop, and never
    // onto or beside the tile its carrier left from.
    const hint = (await waitFor(
      () => drops[0],
      (tile) => tile !== undefined,
      'the block to fall back',
    )) as SandboxTile;
    const returned = await waitFor(
      () => plain(b.sandbox().columns),
      (list) => list.length === 1,
      'the returned block on the board',
    );
    expect(returned).toEqual([{ x: hint.x, y: hint.y, colours: [colour] }]);
    expect(Math.max(Math.abs(hint.x - stand.x), Math.abs(hint.y - stand.y))).toBeGreaterThan(1);
    expect(drops).toHaveLength(1);

    a.resume({ x: spot.x, y: spot.y, facing: 'right' });
    await waitFor(() => peerOf(b, a), (peer) => peer !== undefined, 'a to reappear');
    expect(peerOf(b, a)?.carrying).toBeNull();
    expect(a.sandbox().carrying).toBeNull();

    // And nothing is left in hand to place.
    await sleep(SANDBOX_CLIENT_ACTION_INTERVAL_MS + 20);
    const target = neighbours(stand).find(
      (tile) => !sameTile(tile, column) && !sameTile(tile, hint),
    ) as SandboxTile;
    a.placeBlock(target);
    await sleep(400);
    expect(plain(b.sandbox().columns)).toEqual(returned);
  });

  it('falls back on leave, keeping its colour and away from where the carrier stood', async () => {
    const a = makeClient();
    const b = makeClient(WAITING.x + 40, WAITING.y);
    const drops: SandboxTile[] = [];
    b.onSandboxDrop((tile) => drops.push(tile));
    await a.connect();
    await b.connect();
    const column = await onlyColumn(a);
    const colour = column.colours[0] as number;
    const stand = neighbours(column)[0] as SandboxTile;
    await gather(b, a, stand);
    drops.length = 0;

    a.pickBlock({ x: column.x, y: column.y });
    await waitFor(() => peerOf(b, a)?.carrying, (value) => value === colour, 'b to see a carrying');
    await waitFor(() => b.sandbox().columns, (list) => list.length === 0, 'the stack to go');

    const leaver = a.gameId;
    await a.disconnect();
    await waitFor(
      () => b.peers().some((peer) => peer.gameId === leaver),
      (present) => !present,
      'a to leave',
    );
    const hint = (await waitFor(
      () => drops[0],
      (tile) => tile !== undefined,
      'the block to fall back',
    )) as SandboxTile;
    await waitFor(
      () => plain(b.sandbox().columns),
      (list) => JSON.stringify(list) === JSON.stringify([{ x: hint.x, y: hint.y, colours: [colour] }]),
      'the returned block on the board',
    );
    expect(Math.max(Math.abs(hint.x - stand.x), Math.abs(hint.y - stand.y))).toBeGreaterThan(1);
  });
});
