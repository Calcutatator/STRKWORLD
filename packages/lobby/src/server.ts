/**
 * Standalone presence server.
 *
 * A `@colyseus/core` server on a `@colyseus/ws-transport` websocket, serving
 * exactly one room type. Deliberately assembled from the two narrow packages
 * rather than the `colyseus` meta-package: the meta-package pulls in a
 * monitor, a playground and an HTTP surface this server has no use for, and
 * every one of those is another place a per-connection detail could surface.
 *
 * ## The HTTP surface is real
 *
 * `@colyseus/core` registers an HTTP matchmaking API on the same port —
 * `POST /matchmake/<method>/<room>` and an `OPTIONS` preflight — because that
 * is how the websocket handshake is negotiated. So the presence port is not
 * websocket-only, and the join payload rides as an HTTP request body. Two
 * consequences this module addresses:
 *
 *   - **CORS.** Colyseus's default reflects any `Origin` back with
 *     `Access-Control-Allow-Credentials: true`, which is the permissive-with-
 *     credentials pattern. `startPresenceServer` replaces the CORS policy with
 *     an origin allowlist and grants credentials only to those approved local
 *     web origins (the SDK uses credentialed matchmaking requests).
 *   - **Logging.** An HTTP body is the kind of thing a fronting proxy logs by
 *     default. That is out of this process's hands, but it is why the join
 *     payload must never carry anything sensitive — which, post-hardening, it
 *     structurally cannot: the id is server-minted and every other field is a
 *     coordinate or a checked enum. Relevant to the backend's D-014 no-log
 *     posture if this ever sits behind the same proxy.
 *
 * The server binds a port it was told to bind. It never reads the bound port
 * back off the socket, which is why `portAttempts` exists — see below.
 */

import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import {
  DEFAULT_LOBBY_PORT,
  DEFAULT_ROOM_NAME,
  resolveRoomConfig,
  type PresenceRoomConfigOverrides,
} from './config.js';
import { definePresenceRoom } from './room.js';
import { silenceColyseusDebug } from './logging.js';

/** Origins allowed to reach the matchmaking HTTP API from a browser. */
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const INVALID_PORT_ATTEMPTS_ERROR = 'Lobby port attempts must be a positive safe integer.';
const INVALID_BASE_PORT_ERROR = 'Lobby base port must be an integer from 0 through 65535.';

export interface PresenceServerOptions {
  /** Defaults to 2567. */
  port?: number;
  /** Defaults to all interfaces. */
  hostname?: string;
  /** Defaults to `street`. */
  roomName?: string;
  /**
   * Operator overrides for the room's trusted configuration. This is the ONLY
   * channel for room config — the client join payload is not one. Every field
   * is clamped by `resolveRoomConfig`.
   */
  room?: PresenceRoomConfigOverrides;
  /**
   * Browser origins allowed to call the matchmaking HTTP API. Defaults to the
   * local Vite dev/preview origins. A non-browser client (the game's own
   * process, a native wrapper, curl) sends no `Origin` and is unaffected.
   */
  allowedOrigins?: readonly string[];
  /**
   * How many consecutive ports to try, starting at `port`.
   *
   * Defaults to 1, which fails loudly if the port is taken — the right
   * behaviour for a service whose endpoint other people have configured.
   * Tests raise it so parallel runs do not collide.
   */
  portAttempts?: number;
}

export interface PresenceServer {
  readonly port: number;
  readonly endpoint: string;
  readonly roomName: string;
  shutdown(): Promise<void>;
}

function isPortTaken(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE';
}

/**
 * Lock the matchmaking CORS policy to an origin allowlist.
 *
 * `matchMaker.controller` is a process-global; this replaces its default
 * "reflect any origin, allow credentials" policy. In a dedicated lobby process
 * that global is ours to set. The last caller's allowlist wins, which for a
 * single-purpose server is exactly one caller.
 */
function lockCors(allowedOrigins: readonly string[]): void {
  const controller = (matchMaker as unknown as {
    controller: {
      DEFAULT_CORS_HEADERS: Record<string, string>;
      getCorsHeaders: (headers: Headers) => Record<string, string>;
    };
  }).controller;

  controller.DEFAULT_CORS_HEADERS = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };

  const allowed = new Set(allowedOrigins);
  controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
    const origin = headers.get('origin');
    // No Origin header → not a browser cross-origin request → nothing to grant.
    // A disallowed origin gets no Allow-Origin header, so the browser blocks it.
    if (origin !== null && allowed.has(origin)) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      };
    }
    return { Vary: 'Origin' };
  };
}

/**
 * Start the presence server and resolve once it is accepting connections.
 */
export async function startPresenceServer(
  options: PresenceServerOptions = {},
): Promise<PresenceServer> {
  const basePort = options.port ?? DEFAULT_LOBBY_PORT;
  const roomName = options.roomName ?? DEFAULT_ROOM_NAME;
  if (!Number.isSafeInteger(basePort) || basePort < 0 || basePort > 65_535) {
    throw new Error(INVALID_BASE_PORT_ERROR);
  }
  const attempts = options.portAttempts ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(INVALID_PORT_ATTEMPTS_ERROR);
  }

  // Off before anything binds, so no per-connection line can print even under
  // DEBUG=colyseus:* (see logging.ts).
  silenceColyseusDebug();
  lockCors(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);

  // Resolve and freeze the trusted config once, in this trusted process, and
  // bake it into the room class. Nothing about it travels as client options.
  const config = resolveRoomConfig(options.room);
  const RoomClass = definePresenceRoom(config);

  let lastError: unknown;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = basePort + offset;
    const transport = new WebSocketTransport();
    const server = new Server({
      transport,
      greet: false,
      gracefullyShutdown: false,
    });
    // The config is also passed as define-time handler options so Colyseus's
    // own merge favours it over any client-supplied key (defence in depth; the
    // room ignores its onCreate options regardless).
    server.define(roomName, RoomClass, config);

    try {
      await server.listen(port, options.hostname);
    } catch (error) {
      lastError = error;
      await server.gracefullyShutdown(false).catch(() => undefined);
      if (isPortTaken(error)) continue;
      throw error;
    }

    return {
      port,
      roomName,
      endpoint: `ws://${options.hostname ?? 'localhost'}:${port}`,
      shutdown: () => server.gracefullyShutdown(false),
    };
  }

  throw lastError ?? new Error(`no free port in ${attempts} attempts from ${basePort}`);
}
