/**
 * DEFECT 8: the final position of a movement must always land, even when the
 * server's own rate floor drops an intermediate move the client sent.
 *
 * Its own file with one server, because Colyseus's matchmaker is a
 * process-global and this suite needs a server tuned to drop moves (a high
 * server-side floor) without disturbing the other client suites.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LobbyClient } from './client';
import { startPresenceServer, type PresenceServer } from './server';

let server: PresenceServer;
const opened: LobbyClient[] = [];

async function waitFor<T>(
  read: () => T,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 8000,
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
    port: 47_000 + Math.floor(Math.random() * 2_000),
    portAttempts: 40,
    // The server accepts at most one move per 250ms — slower than the client
    // sends — so an intermediate client move is dropped by this floor.
    room: { minUpdateIntervalMs: 250, interestRadius: 1000 },
  });
});

afterAll(async () => {
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
  await server.shutdown();
});

describe('the final position lands despite a server-dropped move (DEFECT 8)', () => {
  it('reconciles until the server’s copy matches the last requested position', async () => {
    const observer = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });
    const walker = new LobbyClient({ endpoint: server.endpoint, start: { x: 20, y: 0 } });
    opened.push(observer, walker);
    await observer.connect();
    await walker.connect();

    await waitFor(
      () => observer.peers(),
      (list) => list.length === 1,
      'the walker to appear',
    );

    // Two moves in quick succession. The first is accepted; the second arrives
    // inside the 250ms server floor and is dropped. Without reconciliation the
    // observer would be stuck at the first position forever.
    walker.updatePosition(100, 0, 'right');
    walker.updatePosition(200, 0, 'right');

    const peers = await waitFor(
      () => observer.peers(),
      (list) => list[0]?.x === 200,
      'the final position to reconcile through the server floor',
    );
    expect(peers[0]?.x).toBe(200);
  }, 20000);
});
