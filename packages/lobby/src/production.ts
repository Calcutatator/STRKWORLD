import { DEFAULT_LOBBY_PORT } from './config.js';
import { isProductionHostname } from './production-origin.js';
import { startPresenceServer, type PresenceServer } from './server.js';

export interface ProductionLobbyEnvironment {
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly allowedOrigins: readonly string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Parse the lobby's deployment-only environment without echoing values. */
export function parseProductionLobbyEnvironment(
  environment: Environment = process.env,
): ProductionLobbyEnvironment {
  const rawOrigins = required(environment, 'LOBBY_ALLOWED_ORIGINS');
  const allowedOrigins = rawOrigins.split(',').map((origin) => origin.trim());
  if (
    allowedOrigins.length === 0 ||
    allowedOrigins.some((origin) => !isRealHttpsOrigin(origin)) ||
    new Set(allowedOrigins).size !== allowedOrigins.length
  ) {
    throw new Error('Invalid LOBBY_ALLOWED_ORIGINS.');
  }

  const rawPort = environment['LOBBY_PORT'] ?? String(DEFAULT_LOBBY_PORT);
  const port = parsePort(rawPort, 'LOBBY_PORT');
  return { hostname: '127.0.0.1', port, allowedOrigins };
}

/** Production entry used by the Fly composition process as a private child. */
export async function startProductionLobby(
  environment: Environment = process.env,
): Promise<PresenceServer> {
  const config = parseProductionLobbyEnvironment(environment);
  return startPresenceServer({
    hostname: config.hostname,
    port: config.port,
    allowedOrigins: config.allowedOrigins,
  });
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value || value !== value.trim()) throw new Error(`Missing or invalid ${name}.`);
  return value;
}

function parsePort(value: string, name: string): number {
  if (!/^(?:[1-9][0-9]{0,4})$/.test(value)) throw new Error(`Invalid ${name}.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error(`Invalid ${name}.`);
  return port;
}

function isRealHttpsOrigin(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.pathname.replace(/\/$/, '') &&
      !url.search &&
      !url.hash &&
      isProductionHostname(host)
    );
  } catch {
    return false;
  }
}
