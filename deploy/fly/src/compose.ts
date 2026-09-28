import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { isRelayStartupNotice } from '../../../apps/backend/src/relay.js';
import { forwardDebugLines, forwardsDebugLines, writeEdgeStdout } from './debug-lines.js';
import { closeEdgeServer, createEdgeServer } from './edge.js';
import { resolveContainedRegularFile } from './static-file.js';

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
  /**
   * Where the backend's `[debug]` lines go while `BACKEND_DEBUG_LOGS_ENABLED`
   * is true (D-069). The edge's own stdout by default; a test seam.
   */
  readonly debugLogWriter?: (line: string) => void;
  /**
   * Where the relay's D-070 startup line goes: the edge's own stdout by
   * default; a test seam. It is the only thing a child's readiness message
   * can print, and only the backend's.
   */
  readonly noticeWriter?: (line: string) => void;
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
  const startChild = (
    entry: string,
    childEnvironment: NodeJS.ProcessEnv,
    stdout: ChildStdout = 'ignore',
  ): ChildProcess => {
    const child = launchChild(entry, childEnvironment, stdout);
    try { observer.onChildStart?.(); } catch { /* Observation cannot interrupt startup. */ }
    return child;
  };
  // D-069: only an opted-in test deployment reads the backend's stdout, and
  // then only its `[debug]` lines pass. The lobby's output is always discarded.
  const debugLogs = forwardsDebugLines(environment);
  const backend = startChild(
    options.backendEntry,
    { ...environment, PORT: String(options.backendPort) },
    debugLogs ? 'pipe' : 'ignore',
  );
  if (debugLogs && backend.stdout) {
    forwardDebugLines(backend.stdout, options.debugLogWriter ?? writeEdgeStdout);
  }
  const children = [
    backend,
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
    const [backendReady] = await Promise.all([
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
    writeRelayNotice(backendReady, options.noticeWriter ?? writeEdgeStdout);
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
    if (!(await resolveContainedRegularFile(resolve(root, 'index.html'), root))) {
      throw new Error('invalid shell');
    }
  } catch {
    throw new Error('Fly static shell is unavailable.');
  }
}

/**
 * The relay's one startup line (D-070), when its readiness message carries
 * one: printed once, and only if it is exactly the relay's own line. The
 * lobby's readiness message is never read for this.
 */
function writeRelayNotice(ready: unknown, write: (line: string) => void): void {
  const notice = ready && typeof ready === 'object' ? (ready as { notice?: unknown }).notice : undefined;
  if (!isRelayStartupNotice(notice)) return;
  try {
    write(notice);
  } catch {
    // A broken log stream must never take the edge down.
  }
}

function assertStartupActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FlyStartupAbortError();
}

type ChildStdout = 'ignore' | 'pipe';

function launchChild(entry: string, environment: NodeJS.ProcessEnv, stdout: ChildStdout): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    env: environment,
    stdio: ['ignore', stdout, 'ignore', 'ipc'],
  });
  // An error is followed by exit for normal spawn failures. The listener is
  // still attached by the caller so a custom supervisor sees one fatal event.
  child.once('error', () => undefined);
  return child;
}

/** Resolves with the child's readiness message, which the caller may read (D-070). */
async function waitForChildReady(
  child: ChildProcess | undefined,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!child) throw new Error('Private service was not started.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveReady: ((message: unknown) => void) | undefined;
  const onAbort = () => rejectReady?.(new FlyStartupAbortError());
  const onMessage = (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready') {
      resolveReady?.(message);
    }
  };
  const ready = new Promise<unknown>((resolve, reject) => {
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
    const message = await ready;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private service exited before readiness.');
    return message;
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
