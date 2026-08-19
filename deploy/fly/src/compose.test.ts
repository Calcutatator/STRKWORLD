import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFlyComposition, type FlyComposition } from './compose';

const compositions: FlyComposition[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(compositions.splice(0).map((composition) => composition.shutdown()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeChild(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strkworld-child-'));
  directories.push(directory);
  const path = join(directory, 'child.mjs');
  await writeFile(path, `
    import { createServer } from 'node:http';
    const port = Number(process.env.PORT ?? process.env.LOBBY_PORT);
    const delay = Number(process.env.START_DELAY_MS ?? 0);
    const server = createServer((_request, response) => response.end('child'));
    if (process.env.EXIT_BEFORE_READY) setTimeout(() => process.exit(2), Number(process.env.EXIT_BEFORE_READY));
    if (!process.env.EXIT_BEFORE_READY) {
      setTimeout(() => server.listen(port, '127.0.0.1', () => process.send?.({ type: 'ready' })), delay);
    }
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    if (process.env.EXIT_AFTER_READY) setTimeout(() => process.exit(2), Number(process.env.EXIT_AFTER_READY));
  `);
  return path;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port probe did not bind');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function ports(): Promise<{ publicPort: number; backendPort: number; lobbyPort: number }> {
  return { publicPort: await freePort(), backendPort: await freePort(), lobbyPort: await freePort() };
}

describe('Fly composition process boundary', () => {
  it('waits for both private children before binding the public edge', async () => {
    const child = await fakeChild();
    const { publicPort, backendPort, lobbyPort } = await ports();
    const starting = startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      environment: { ...process.env, START_DELAY_MS: '300' },
      readinessTimeoutMs: 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(fetch(`http://127.0.0.1:${publicPort}/`)).rejects.toThrow();
    const composition = await starting;
    compositions.push(composition);

    expect(composition.address.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${composition.address.port}/`);
    expect(response.status).toBe(200);
  });

  it('reports a ready child exit to the machine supervisor', async () => {
    const child = await fakeChild();
    const { publicPort, backendPort, lobbyPort } = await ports();
    let resolveFatal: (error: Error) => void = () => undefined;
    const fatalPromise = new Promise<Error>((resolve) => { resolveFatal = resolve; });
    const composition = await startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      environment: { ...process.env, EXIT_AFTER_READY: '100' },
      readinessTimeoutMs: 2_000,
      onFatal: resolveFatal,
    });
    compositions.push(composition);

    await expect(fatalPromise).resolves.toMatchObject({ message: 'A private service exited.' });
  });

  it('rejects promptly when a child exits before readiness', async () => {
    const child = await fakeChild();
    const { publicPort, backendPort, lobbyPort } = await ports();
    await expect(startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      environment: { ...process.env, EXIT_BEFORE_READY: '20' },
      readinessTimeoutMs: 2_000,
    })).rejects.toThrow('Private service exited before readiness.');
  });

  it('does not accept an unrelated listener as child readiness', async () => {
    const child = await fakeChild();
    const { publicPort, backendPort, lobbyPort } = await ports();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(backendPort, '127.0.0.1', resolve));
    await expect(startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      environment: process.env,
      readinessTimeoutMs: 500,
    })).rejects.toThrow('Private service exited before readiness.');
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  });
});
