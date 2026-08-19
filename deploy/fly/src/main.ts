import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isProductionHostname } from '../../../packages/lobby/src/production-origin.js';
import {
  FlyStartupAbortError,
  startFlyComposition,
  type FlyComposition,
  type FlyCompositionOptions,
} from './compose.js';

interface FlyEnvironment {
  readonly publicPort: number;
  readonly backendPort: number;
  readonly lobbyPort: number;
  readonly publicOrigin: string;
  readonly staticRoot: string;
  readonly backendEntry: string;
  readonly lobbyEntry: string;
}

export function parseFlyEnvironment(environment: NodeJS.ProcessEnv = process.env): FlyEnvironment {
  const publicOrigin = parsePublicOrigin(environment['FLY_PUBLIC_ORIGIN']);
  const allowedOrigins = parseAllowedOrigins(environment['LOBBY_ALLOWED_ORIGINS']);
  if (!allowedOrigins.includes(publicOrigin)) {
    throw new Error('FLY_PUBLIC_ORIGIN is not present in LOBBY_ALLOWED_ORIGINS.');
  }
  const publicPort = parsePort(environment['PORT'], 'PORT');
  const backendPort = parsePort(environment['FLY_BACKEND_PORT'] ?? '18080', 'FLY_BACKEND_PORT');
  const lobbyPort = parsePort(environment['FLY_LOBBY_PORT'] ?? '12567', 'FLY_LOBBY_PORT');
  if (new Set([publicPort, backendPort, lobbyPort]).size !== 3) {
    throw new Error('Fly service ports must be distinct.');
  }
  return {
    publicPort,
    backendPort,
    lobbyPort,
    publicOrigin,
    staticRoot: environment['FLY_STATIC_ROOT'] ?? '/app/web-dist',
    backendEntry: environment['FLY_BACKEND_ENTRY'] ?? '/app/build/deploy/fly/src/backend-child.js',
    lobbyEntry: environment['FLY_LOBBY_ENTRY'] ?? '/app/build/deploy/fly/src/lobby-child.js',
  };
}

function parsePublicOrigin(value: string | undefined): string {
  if (!value || value !== value.trim()) throw new Error('Invalid FLY_PUBLIC_ORIGIN.');
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error('Invalid FLY_PUBLIC_ORIGIN.'); }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== value ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    !isProductionHostname(origin.hostname)
  ) {
    throw new Error('Invalid FLY_PUBLIC_ORIGIN.');
  }
  return value;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value || value !== value.trim()) throw new Error('Missing or invalid LOBBY_ALLOWED_ORIGINS.');
  const origins = value.split(',').map((entry) => entry.trim());
  if (origins.length === 0 || origins.some((entry) => !isRealHttpsOrigin(entry))) {
    throw new Error('Invalid LOBBY_ALLOWED_ORIGINS.');
  }
  return origins;
}

function isRealHttpsOrigin(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  let origin: URL;
  try { origin = new URL(value); } catch { return false; }
  return (
    origin.protocol === 'https:' &&
    origin.origin === value &&
    origin.pathname === '/' &&
    !origin.search &&
    !origin.hash &&
    !origin.username &&
    !origin.password &&
    isProductionHostname(origin.hostname)
  );
}


function parsePort(value: string | undefined, name: string): number {
  if (!value || !/^[1-9][0-9]{0,4}$/.test(value)) throw new Error(`Invalid ${name}.`);
  const port = Number(value);
  if (port > 65_535) throw new Error(`Invalid ${name}.`);
  return port;
}

async function run(): Promise<void> {
  const config = parseFlyEnvironment();
  await runFlySupervisor({
    compositionOptions: {
      ...config,
      environment: { ...process.env },
    },
  });
}

export interface FlySupervisorSignals {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
}

export interface FlySupervisorOptions {
  readonly compositionOptions: Omit<FlyCompositionOptions, 'onFatal' | 'startupSignal'>;
  readonly start?: typeof startFlyComposition;
  readonly signals?: FlySupervisorSignals;
  readonly exit?: (code: number) => void;
}

/**
 * Own the complete Fly process lifecycle, including the interval in which the
 * private children are starting but no composition has been returned yet.
 *
 * This is deliberately small and injectable: the production process uses the
 * real signal source and exit function, while tests can prove every handoff
 * without spawning a second supervisor process.
 */
export async function runFlySupervisor(options: FlySupervisorOptions): Promise<void> {
  const signals = options.signals ?? process;
  const start = options.start ?? startFlyComposition;
  const exit = options.exit ?? ((code: number) => { process.exitCode = code; });
  const startupAbort = new AbortController();
  let composition: FlyComposition | undefined;
  let stopCode: number | undefined;
  let stopPromise: Promise<void> | undefined;
  let exited = false;
  let listenersDisposed = false;

  let resolveComposition: (value: FlyComposition | undefined) => void = () => undefined;
  const compositionReady = new Promise<FlyComposition | undefined>((resolve) => {
    resolveComposition = resolve;
  });

  const disposeListeners = () => {
    if (listenersDisposed) return;
    listenersDisposed = true;
    signals.removeListener('SIGTERM', onOrderlySignal);
    signals.removeListener('SIGINT', onOrderlySignal);
  };

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    disposeListeners();
    exit(code);
  };

  const cleanup = async (): Promise<void> => {
    const active = await compositionReady;
    if (active) await active.shutdown();
  };

  const awaitStop = async (): Promise<void> => {
    if (!stopPromise) return;
    try {
      await stopPromise;
    } catch {
      exitOnce(1);
    }
  };

  const requestStop = (code: number) => {
    stopCode = stopCode === undefined ? code : Math.max(stopCode, code);
    startupAbort.abort();
    if (!stopPromise) {
      stopPromise = cleanup();
      void stopPromise.then(
        () => exitOnce(stopCode ?? code),
        () => exitOnce(1),
      );
    }
  };

  const fatal = () => requestStop(1);
  const onOrderlySignal = () => requestStop(0);
  signals.once('SIGTERM', onOrderlySignal);
  signals.once('SIGINT', onOrderlySignal);

  try {
    composition = await start({
      ...options.compositionOptions,
      onFatal: fatal,
      startupSignal: startupAbort.signal,
    });
    resolveComposition(composition);
    // A signal or fatal callback can win immediately before this assignment;
    // the single-flight cleanup already owns the returned composition then.
    await awaitStop();
  } catch (error) {
    const cleanOrderlyAbort = stopCode === 0 && error instanceof FlyStartupAbortError;
    if (!cleanOrderlyAbort) stopCode = 1;
    resolveComposition(undefined);
    if (stopPromise) await awaitStop();
    else exitOnce(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await run();
}
