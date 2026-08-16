/**
 * Standalone presence server.
 *
 * A `@colyseus/core` server on a `@colyseus/ws-transport` websocket, serving
 * exactly one room type. Deliberately assembled from the two narrow packages
 * rather than the `colyseus` meta-package: the meta-package pulls in a
 * monitor, a playground and an HTTP surface this server has no use for, and
 * every one of those is another place a per-connection detail could surface.
 *
 * The server binds a port it was told to bind. It never reads the bound port
 * back off the socket, which is why `portAttempts` exists — see below.
 */

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { DEFAULT_LOBBY_PORT, DEFAULT_ROOM_NAME } from './config';
import { PresenceRoom, type PresenceRoomOptions } from './room';

export interface PresenceServerOptions {
  /** Defaults to 2567. */
  port?: number;
  /** Defaults to all interfaces. */
  hostname?: string;
  /** Defaults to `street`. */
  roomName?: string;
  /** Passed through to every room this server creates. */
  room?: PresenceRoomOptions;
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
 * Start the presence server and resolve once it is accepting connections.
 */
export async function startPresenceServer(
  options: PresenceServerOptions = {},
): Promise<PresenceServer> {
  const basePort = options.port ?? DEFAULT_LOBBY_PORT;
  const roomName = options.roomName ?? DEFAULT_ROOM_NAME;
  const attempts = Math.max(1, options.portAttempts ?? 1);

  let lastError: unknown;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = basePort + offset;
    const transport = new WebSocketTransport();
    const server = new Server({
      transport,
      greet: false,
      gracefullyShutdown: false,
    });
    server.define(roomName, PresenceRoom, options.room ?? {});

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
