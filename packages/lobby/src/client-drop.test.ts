/**
 * DEFECT 9: a consumer must be able to tell "the connection died" from "an
 * empty street". The client reports a `server-dropped` status when the server
 * closes the connection, distinct from a local `client-left`.
 *
 * Its own file with one server, because the test shuts that server down
 * mid-run to force the drop, and Colyseus's process-global matchmaker means a
 * shutdown would corrupt any other server sharing the process.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LobbyClient, type LobbyStatusEvent } from './client';
import { startPresenceServer, type PresenceServer } from './server';

let server: PresenceServer;
let stopped = false;

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
    port: 49_000 + Math.floor(Math.random() * 500),
    portAttempts: 40,
  });
});

afterAll(async () => {
  if (!stopped) await server.shutdown().catch(() => undefined);
});

describe('a server drop is reported distinctly (DEFECT 9)', () => {
  it('reports server-dropped with a close code when the server closes', async () => {
    const client = new LobbyClient({ endpoint: server.endpoint, start: { x: 0, y: 0 } });
    const events: LobbyStatusEvent[] = [];
    client.onStatus((event) => events.push(event));

    await client.connect();
    expect(client.status).toBe('connected');

    // Kill the server out from under the connected client.
    stopped = true;
    await server.shutdown();

    await waitFor(
      () => events.at(-1)?.status,
      (status) => status === 'closed',
      'the client to notice the drop',
    );

    const last = events.at(-1);
    expect(last?.status).toBe('closed');
    expect(last?.reason).toBe('server-dropped');
    expect(typeof last?.code).toBe('number');
  }, 20000);
});
