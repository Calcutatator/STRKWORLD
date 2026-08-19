import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startFlyComposition, type FlyComposition } from './compose.js';

interface FlyEnvironment {
  readonly publicPort: number;
  readonly backendPort: number;
  readonly lobbyPort: number;
  readonly staticRoot: string;
  readonly backendEntry: string;
  readonly lobbyEntry: string;
}

export function parseFlyEnvironment(environment: NodeJS.ProcessEnv = process.env): FlyEnvironment {
  return {
    publicPort: parsePort(environment['PORT'], 'PORT'),
    backendPort: parsePort(environment['FLY_BACKEND_PORT'] ?? '18080', 'FLY_BACKEND_PORT'),
    lobbyPort: parsePort(environment['FLY_LOBBY_PORT'] ?? '12567', 'FLY_LOBBY_PORT'),
    staticRoot: environment['FLY_STATIC_ROOT'] ?? '/app/web-dist',
    backendEntry: environment['FLY_BACKEND_ENTRY'] ?? '/app/build/deploy/fly/src/backend-child.js',
    lobbyEntry: environment['FLY_LOBBY_ENTRY'] ?? '/app/build/deploy/fly/src/lobby-child.js',
  };
}

function parsePort(value: string | undefined, name: string): number {
  if (!value || !/^[1-9][0-9]{0,4}$/.test(value)) throw new Error(`Invalid ${name}.`);
  const port = Number(value);
  if (port > 65_535) throw new Error(`Invalid ${name}.`);
  return port;
}

async function run(): Promise<void> {
  const config = parseFlyEnvironment();
  let composition: FlyComposition | undefined;
  let stopping = false;
  const fatal = () => {
    if (stopping) return;
    stopping = true;
    void composition?.shutdown().finally(() => process.exit(1));
  };

  try {
    composition = await startFlyComposition({
      ...config,
      onFatal: fatal,
      environment: { ...process.env },
    });
  } catch {
    process.exitCode = 1;
    return;
  }

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void composition?.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await run();
}
