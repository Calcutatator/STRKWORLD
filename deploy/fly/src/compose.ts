import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { closeEdgeServer, createEdgeServer } from './edge.js';

export interface FlyCompositionOptions {
  readonly staticRoot: string;
  readonly backendEntry: string;
  readonly lobbyEntry: string;
  readonly publicPort: number;
  readonly backendPort: number;
  readonly lobbyPort: number;
  readonly publicOrigin: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onFatal?: (error: Error) => void;
  /** Abort startup before the public edge has been handed to the caller. */
  readonly startupSignal?: AbortSignal;
}

export interface FlyComposition {
  readonly address: { address: string; family: string; port: number };
  shutdown(): Promise<void>;
}

interface FlyCompositionObserver {
  /** Test-only observation; it cannot own or interrupt the child lifecycle. */
  readonly onChildStart?: () => void;
}

/** Startup was cancelled before the public composition was handed off. */
export class FlyStartupAbortError extends Error {
  constructor() {
    super('Private service startup was aborted.');
    this.name = 'FlyStartupAbortError';
  }
}

/** Start private children, wait for their TCP listeners, then expose one edge. */
export async function startFlyComposition(
  options: FlyCompositionOptions,
  observer: FlyCompositionObserver = {},
): Promise<FlyComposition> {
  await assertStaticShell(options.staticRoot);
  assertStartupActive(options.startupSignal);
  const environment = options.environment ?? process.env;
  const startChild = (entry: string, childEnvironment: NodeJS.ProcessEnv): ChildProcess => {
    const child = launchChild(entry, childEnvironment);
    try { observer.onChildStart?.(); } catch { /* Observation cannot interrupt startup. */ }
    return child;
  };
  const children = [
    startChild(options.backendEntry, { ...environment, PORT: String(options.backendPort) }),
    startChild(options.lobbyEntry, {
      ...environment,
      LOBBY_PORT: String(options.lobbyPort),
    }),
  ];
  let stopping = false;
  let fatalReported = false;
  let startup = true;
  let startupChildDied = false;
  let edge: Server | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const onFatal = options.onFatal ?? (() => undefined);
  const reportFatal = () => {
    if (stopping || fatalReported) return;
    fatalReported = true;
    const error = new Error('A private service exited.');
    if (startup) {
      startupChildDied = true;
      return;
    }
    void shutdown?.().then(
      () => onFatal(error),
      () => onFatal(error),
    );
  };
  children.forEach((child) => {
    child.once('exit', reportFatal);
    child.once('error', reportFatal);
  });

  try {
    await Promise.all([
      waitForChildReady(children[0], options.readinessTimeoutMs, options.startupSignal),
      waitForChildReady(children[1], options.readinessTimeoutMs, options.startupSignal),
    ]);
    assertStartupActive(options.startupSignal);
    if (startupChildDied) throw new Error('A private service exited before the public edge was ready.');
    edge = createEdgeServer({
      staticRoot: options.staticRoot,
      backendPort: options.backendPort,
      lobbyPort: options.lobbyPort,
      publicOrigin: options.publicOrigin,
    });
    const address = await listenPublic(edge, options.publicPort);
    assertStartupActive(options.startupSignal);
    shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        stopping = true;
        if (edge) await closeEdgeServer(edge, options.shutdownTimeoutMs ?? 5_000);
        await stopChildren(children, options.shutdownTimeoutMs ?? 5_000);
      })();
      return shutdownPromise;
    };
    // Give an exit that raced the readiness IPC/public listen a turn to arrive
    // before ownership of the composition is handed to the caller.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertStartupActive(options.startupSignal);
    if (startupChildDied) throw new Error('A private service exited before the public edge was ready.');
    // The artifact can be removed or replaced while private readiness and the
    // public bind are pending. Recheck at the ownership handoff so a Machine
    // cannot be reported ready over a shell the edge would already reject.
    await assertStaticShell(options.staticRoot);
    assertStartupActive(options.startupSignal);
    if (startupChildDied) throw new Error('A private service exited before the public edge was ready.');
    startup = false;
    return { address, shutdown };
  } catch (error) {
    stopping = true;
    const cleanup = await Promise.allSettled([
      edge ? closeEdgeServer(edge, options.shutdownTimeoutMs ?? 5_000) : Promise.resolve(),
      stopChildren(children, options.shutdownTimeoutMs ?? 5_000),
    ]);
    if (cleanup.some((result) => result.status === 'rejected')) {
      throw new Error('Fly composition startup cleanup failed.');
    }
    throw error;
  }
}

async function assertStaticShell(staticRoot: string): Promise<void> {
  try {
    const root = await realpath(resolve(staticRoot));
    const shell = await realpath(resolve(root, 'index.html'));
    const location = relative(root, shell);
    if (
      location === '..' ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location) ||
      !(await stat(shell)).isFile()
    ) {
      throw new Error('invalid shell');
    }
  } catch {
    throw new Error('Fly static shell is unavailable.');
  }
}

function assertStartupActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FlyStartupAbortError();
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
  signal?: AbortSignal,
): Promise<void> {
  if (!child) throw new Error('Private service was not started.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveReady: (() => void) | undefined;
  const onAbort = () => rejectReady?.(new FlyStartupAbortError());
  const onMessage = (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready') {
      resolveReady?.();
    }
  };
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    timer = setTimeout(() => reject(new Error('Private service did not become ready.')), timeoutMs ?? 15_000);
    child.on('message', onMessage);
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
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
    child.off('message', onMessage);
    signal?.removeEventListener('abort', onAbort);
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
  const results = await Promise.allSettled(children.map((child) => stopChild(child, timeoutMs)));
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Private service shutdown required forced termination.');
  }
}

function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let forced = false;
    let forcedExitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(gracefulTimer);
      if (forcedExitTimer) clearTimeout(forcedExitTimer);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => {
      finish(forced ? new Error('Private service required forced termination.') : undefined);
    };
    const forceExit = () => {
      if (settled) return;
      forced = true;
      child.kill('SIGKILL');
      forcedExitTimer = setTimeout(() => {
        finish(new Error('Private service did not exit after forced termination.'));
      }, timeoutMs);
    };
    const gracefulTimer = setTimeout(forceExit, timeoutMs);
    child.once('exit', onExit);
    child.kill('SIGTERM');
  });
}
