/**
 * DEFECT 9 / D-037: a consumer must be able to tell "the connection died"
 * from "an empty street". The client reports a `server-dropped` status when
 * the server disappears, distinct from a local `client-left`, and does not
 * enter the SDK's automatic retry loop.
 *
 * The server runs in its own child process so this test can terminate the
 * transport abruptly rather than ask Colyseus for an orderly shutdown.
 * Colyseus's matchmaker is process-global, so isolating the server also keeps
 * its teardown away from every other Lobby test process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import { LobbyClient, type LobbyStatusEvent } from './client';
import type { LobbyState } from './state';

const SDK_MIN_UPTIME_MS = 5_000;

async function startLobbyChild(basePort: number): Promise<{
  readonly child: ChildProcess;
  readonly port: number;
}> {
  const source = `
    import { startPresenceServer } from './packages/lobby/src/server.ts';
    const server = await startPresenceServer({
      hostname: '127.0.0.1',
      port: Number(process.env.LOBBY_PORT),
      portAttempts: 40,
    });
    process.stdout.write('ready:' + server.port + '\\n');
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOBBY_PORT: String(basePort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  let stdout = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new Error(
          `Lobby child exited before readiness (${code ?? signal ?? 'unknown'}): ${stderr}`,
        ),
      );
    };
    child.once('exit', onExit);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const ready = stdout.match(/ready:(\d+)/);
      if (ready === null) return;
      child.off('exit', onExit);
      resolve(Number(ready[1]));
    });
  });
  return { child, port };
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

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

describe('a server drop is reported distinctly (DEFECT 9)', () => {
  it('reports an established transport drop without automatic retry', async () => {
    const started = await startLobbyChild(49_000 + Math.floor(Math.random() * 500));
    const { child, port } = started;
    let joinedRoom: ColyseusRoom<unknown, LobbyState> | undefined;
    const originalJoin = ColyseusClient.prototype.joinOrCreate;
    const joinOrCreate = vi
      .spyOn(ColyseusClient.prototype, 'joinOrCreate')
      .mockImplementation(async function (
        this: ColyseusClient,
        ...args: Parameters<typeof originalJoin>
      ) {
        const room = await originalJoin.apply(this, args) as ColyseusRoom<unknown, LobbyState>;
        joinedRoom = room;
        return room as never;
      });
    const client = new LobbyClient({
      endpoint: `ws://127.0.0.1:${port}`,
      start: { x: 0, y: 0 },
    });
    const events: LobbyStatusEvent[] = [];
    client.onStatus((event) => events.push(event));

    try {
      await client.connect();
      expect(client.status).toBe('connected');

      // The pinned SDK only enables its retry path after this uptime. This is
      // an actual wait against an actual websocket, not a hand-authored drop.
      await new Promise((resolve) => setTimeout(resolve, SDK_MIN_UPTIME_MS + 100));

      await terminateChild(child);

      await waitFor(
        () => events.at(-1)?.status,
        (status) => status === 'closed',
        'the client to notice the established transport drop',
        1_000,
      );

      const last = events.at(-1);
      expect(last?.status).toBe('closed');
      expect(last?.reason).toBe('server-dropped');
      expect(typeof last?.code).toBe('number');
    } finally {
      // Mutation runs may leave the SDK retry owner enabled. Bound teardown by
      // turning off any captured room before asking the wrapper to disconnect.
      if (joinedRoom !== undefined) {
        joinedRoom.reconnection.enabled = false;
        joinedRoom.reconnection.maxRetries = 0;
      }
      await terminateChild(child);
      await Promise.race([
        client.disconnect().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      joinOrCreate.mockRestore();
    }
  }, 15_000);
});
