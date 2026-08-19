import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
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
  return {
    publicPort: parsePort(environment['PORT'], 'PORT'),
    backendPort: parsePort(environment['FLY_BACKEND_PORT'] ?? '18080', 'FLY_BACKEND_PORT'),
    lobbyPort: parsePort(environment['FLY_LOBBY_PORT'] ?? '12567', 'FLY_LOBBY_PORT'),
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

function isProductionHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4 && host.split('.')[0] === '127') return false;
  if (ipVersion === 6) {
    const words = parseIPv6(host);
    if (!words) return false;
    if (words.every((word, index) => index === 7 ? word === 1 : word === 0)) return false;
    // IPv4-mapped loopback is still loopback, including hexadecimal and dotted
    // spellings of the mapped 127/8 address.
    if (
      words.slice(0, 5).every((word) => word === 0) &&
      words[5] === 0xffff &&
      words[6] !== undefined &&
      (words[6] >> 8) === 127
    ) return false;
  }
  if (host === 'invalid' || host.endsWith('.invalid')) return false;
  return !/(?:placeholder|replace|your(?:[-_]|$))/i.test(host);
}

function parseIPv6(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  const parseWords = (parts: string[]): number[] | null => {
    const words: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) return null;
        const [first, second, third, fourth] = octets;
        if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null;
        words.push((first << 8) | second, (third << 8) | fourth);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        words.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return words;
  };

  const leftWords = parseWords(left);
  const rightWords = parseWords(right);
  if (!leftWords || !rightWords) return null;
  if (halves.length === 1) return leftWords.length === 8 ? leftWords : null;
  if (leftWords.length + rightWords.length >= 8) return null;
  return [...leftWords, ...Array(8 - leftWords.length - rightWords.length).fill(0), ...rightWords];
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
