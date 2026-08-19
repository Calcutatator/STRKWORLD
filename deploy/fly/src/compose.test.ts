import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlyEnvironment } from './main';
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
      setTimeout(() => server.listen(port, '127.0.0.1', () => {
        process.send?.({ type: 'ready' }, () => {
          if (process.env.EXIT_AFTER_READY) setTimeout(() => process.exit(2), Number(process.env.EXIT_AFTER_READY));
        });
      }), delay);
    }
    process.on('SIGTERM', () => {
      if (process.env.IGNORE_SIGTERM) return;
      server.close(() => process.exit(0));
    });
  `);
  return path;
}

async function fakeStaticRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strkworld-static-'));
  directories.push(directory);
  await writeFile(join(directory, 'index.html'), '<html>test shell</html>');
  return directory;
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

function signalArmedAfterAbortListeners(
  controller: AbortController,
  requiredListeners: number,
): { signal: AbortSignal; armed: Promise<void> } {
  let abortListeners = 0;
  let resolveArmed: (() => void) | undefined;
  const armed = new Promise<void>((resolve) => { resolveArmed = resolve; });
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'addEventListener') {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          target.addEventListener(type, listener, options);
          if (type === 'abort' && ++abortListeners === requiredListeners) resolveArmed?.();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { signal, armed };
}

describe('Fly composition process boundary', () => {
  it('requires the public origin to be in the lobby origin allowlist', () => {
    const base = {
      PORT: '8080',
      FLY_PUBLIC_ORIGIN: 'https://game.example',
      LOBBY_ALLOWED_ORIGINS: 'https://other.example',
    };
    expect(() => parseFlyEnvironment(base)).toThrow('LOBBY_ALLOWED_ORIGINS');
    expect(parseFlyEnvironment({
      ...base,
      LOBBY_ALLOWED_ORIGINS: 'https://other.example, https://game.example',
    })).toMatchObject({ publicOrigin: 'https://game.example' });
  });

  it.each([
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.2]',
    'https://[::ffff:7f00:2]',
    'https://example.invalid',
    'https://REPLACE-WITH-HOST.example',
  ])('rejects non-production public origin %s', (publicOrigin) => {
    expect(() => parseFlyEnvironment({
      PORT: '8080',
      FLY_PUBLIC_ORIGIN: publicOrigin,
      LOBBY_ALLOWED_ORIGINS: publicOrigin,
    })).toThrow('FLY_PUBLIC_ORIGIN');
  });

  it('waits for both private children before binding the public edge', async () => {
    const child = await fakeChild();
    const staticRoot = await fakeStaticRoot();
    const { publicPort, backendPort, lobbyPort } = await ports();
    const starting = startFlyComposition({
      staticRoot,
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      publicOrigin: 'https://game.example',
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
    await expect(response.text()).resolves.toBe('<html>test shell</html>');
  });

  it('aborts pending readiness and stops private children before exposing the edge', async () => {
    const child = await fakeChild();
    const controller = new AbortController();
    const { publicPort, backendPort, lobbyPort } = await ports();
    const { signal: startupSignal, armed } = signalArmedAfterAbortListeners(controller, 2);
    const starting = startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      publicOrigin: 'https://game.example',
      environment: { ...process.env, START_DELAY_MS: '300' },
      readinessTimeoutMs: 2_000,
      startupSignal,
    });
    await armed;
    controller.abort();

    await expect(starting).rejects.toThrow('startup was aborted');
    await expect(fetch(`http://127.0.0.1:${publicPort}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backendPort}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${lobbyPort}/`)).rejects.toThrow();
  });

  it('reports cleanup failure when an orderly startup abort requires forced termination', async () => {
    const child = await fakeChild();
    const controller = new AbortController();
    const { publicPort, backendPort, lobbyPort } = await ports();
    let abortedReads = 0;
    const startupSignal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'aborted') {
          if (++abortedReads === 3) controller.abort();
          return target.aborted;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const starting = startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      publicOrigin: 'https://game.example',
      environment: { ...process.env, IGNORE_SIGTERM: '1' },
      readinessTimeoutMs: 2_000,
      shutdownTimeoutMs: 50,
      startupSignal,
    });

    await expect(starting).rejects.toThrow('startup cleanup failed');
    await expect(fetch(`http://127.0.0.1:${publicPort}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backendPort}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${lobbyPort}/`)).rejects.toThrow();
  });

  it.each([
    ['after readiness', 3],
    ['after public bind', 4],
    ['during the ownership handoff', 5],
  ] as const)('rechecks an abort %s before handing off the public edge', async (_phase, abortRead) => {
    const child = await fakeChild();
    const { publicPort, backendPort, lobbyPort } = await ports();
    const controller = new AbortController();
    let abortedReads = 0;
    const startupSignal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'aborted') return ++abortedReads >= abortRead;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(startFlyComposition({
      staticRoot: join(process.cwd(), 'apps/web/dist'),
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      publicOrigin: 'https://game.example',
      environment: process.env,
      readinessTimeoutMs: 2_000,
      startupSignal,
    })).rejects.toThrow('startup was aborted');

    await expect(fetch(`http://127.0.0.1:${publicPort}/`)).rejects.toThrow();
  });

  it('waits for forced child exits and rejects shutdown after the graceful deadline', async () => {
    const child = await fakeChild();
    const staticRoot = await fakeStaticRoot();
    const { publicPort, backendPort, lobbyPort } = await ports();
    const composition = await startFlyComposition({
      staticRoot,
      backendEntry: child,
      lobbyEntry: child,
      publicPort,
      backendPort,
      lobbyPort,
      publicOrigin: 'https://game.example',
      environment: { ...process.env, IGNORE_SIGTERM: '1' },
      readinessTimeoutMs: 2_000,
      shutdownTimeoutMs: 50,
    });

    await expect(composition.shutdown()).rejects.toThrow('forced termination');
    await expect(fetch(`http://127.0.0.1:${publicPort}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backendPort}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${lobbyPort}/`)).rejects.toThrow();
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
      publicOrigin: 'https://game.example',
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
      publicOrigin: 'https://game.example',
      environment: { ...process.env, EXIT_BEFORE_READY: '20' },
      readinessTimeoutMs: 2_000,
    })).rejects.toThrow('Private service exited before readiness.');
  });

  it('fails startup when a child dies immediately after reporting ready', async () => {
    const child = await fakeChild();
    const { publicPort, backendPort, lobbyPort } = await ports();
    let composition: FlyComposition | undefined;
    let startupError: unknown;
    let resolveFatal: (error: Error) => void = () => undefined;
    const fatalPromise = new Promise<Error>((resolve) => { resolveFatal = resolve; });
    try {
      composition = await startFlyComposition({
        staticRoot: join(process.cwd(), 'apps/web/dist'),
        backendEntry: child,
        lobbyEntry: child,
        publicPort,
        backendPort,
        lobbyPort,
        publicOrigin: 'https://game.example',
        environment: { ...process.env, EXIT_AFTER_READY: '0' },
        readinessTimeoutMs: 2_000,
        onFatal: resolveFatal,
      });
    } catch (error) {
      startupError = error;
    }
    if (composition) {
      compositions.push(composition);
      await expect(fatalPromise).resolves.toMatchObject({ message: 'A private service exited.' });
      await expect(fetch(`http://127.0.0.1:${composition.address.port}/`)).rejects.toThrow();
    } else {
      expect(startupError).toBeInstanceOf(Error);
      await expect(fetch(`http://127.0.0.1:${publicPort}/`)).rejects.toThrow();
    }
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
      publicOrigin: 'https://game.example',
      environment: process.env,
      readinessTimeoutMs: 500,
    })).rejects.toThrow('Private service exited before readiness.');
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  });
});
