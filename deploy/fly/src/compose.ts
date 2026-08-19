import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { closeEdgeServer, createEdgeServer } from './edge.js';

export interface FlyCompositionOptions {
  readonly staticRoot: string;
  readonly backendEntry: string;
  readonly lobbyEntry: string;
  readonly publicPort: number;
  readonly backendPort: number;
  readonly lobbyPort: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onFatal?: (error: Error) => void;
}

export interface FlyComposition {
  readonly address: { address: string; family: string; port: number };
  shutdown(): Promise<void>;
}

/** Start private children, wait for their TCP listeners, then expose one edge. */
export async function startFlyComposition(options: FlyCompositionOptions): Promise<FlyComposition> {
  const environment = options.environment ?? process.env;
  const children = [
    launchChild(options.backendEntry, { ...environment, PORT: String(options.backendPort) }),
    launchChild(options.lobbyEntry, {
      ...environment,
      LOBBY_PORT: String(options.lobbyPort),
    }),
  ];
  let stopping = false;
  let fatalReported = false;
  const onFatal = options.onFatal ?? (() => undefined);
  const reportFatal = () => {
    if (stopping || fatalReported) return;
    fatalReported = true;
    onFatal(new Error('A private service exited.'));
  };
  children.forEach((child) => {
    child.once('exit', reportFatal);
    child.once('error', reportFatal);
  });

  try {
    await Promise.all([
      waitForChildReady(children[0], options.readinessTimeoutMs),
      waitForChildReady(children[1], options.readinessTimeoutMs),
    ]);
    const edge = createEdgeServer({
      staticRoot: options.staticRoot,
      backendPort: options.backendPort,
      lobbyPort: options.lobbyPort,
    });
    const address = await listenPublic(edge, options.publicPort);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        stopping = true;
        await closeEdgeServer(edge, options.shutdownTimeoutMs ?? 5_000);
        await stopChildren(children, options.shutdownTimeoutMs ?? 5_000);
      })();
      return shutdownPromise;
    };
    return { address, shutdown };
  } catch (error) {
    stopping = true;
    await stopChildren(children, options.shutdownTimeoutMs ?? 5_000);
    throw error;
  }
}

function launchChild(entry: string, environment: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  // An error is followed by exit for normal spawn failures. The listener is
  // still attached by the caller so a custom supervisor sees one fatal event.
  child.once('error', () => undefined);
  return child;
}

async function waitForChildReady(
  child: ChildProcess | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  if (!child) throw new Error('Private service was not started.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    timer = setTimeout(() => reject(new Error('Private service did not become ready.')), timeoutMs ?? 15_000);
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready') resolve();
    });
  });
  const onExit = () => rejectReady?.(new Error('Private service exited before readiness.'));
  child.once('exit', onExit);
  child.once('error', onExit);
  try {
    await ready;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private service exited before readiness.');
  } finally {
    if (timer) clearTimeout(timer);
    child.off('exit', onExit);
    child.off('error', onExit);
  }
}

function listenPublic(server: Server, port: number): Promise<{ address: string; family: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        void closeEdgeServer(server, 100).finally(() => reject(new Error('Public edge did not bind a TCP address.')));
        return;
      }
      resolve({ address: address.address, family: String(address.family), port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function stopChildren(children: readonly ChildProcess[], timeoutMs: number): Promise<void> {
  await Promise.all(children.map((child) => stopChild(child, timeoutMs)));
}

function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, timeoutMs);
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}
