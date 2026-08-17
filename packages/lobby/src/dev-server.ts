/**
 * Local development entry point.
 *
 *   npm run dev --workspace=@strkworld/lobby
 *
 * Binds port 2567 unless LOBBY_PORT says otherwise, and serves the one room
 * type on `ws://localhost:2567`. Fails loudly if the port is taken rather than
 * quietly moving to another one, because the shell has the endpoint
 * configured.
 *
 * It prints one line — the endpoint — and this package logs nothing per
 * connection of its own. Colyseus's own `debug` channels *could* print joins,
 * leaves and per-message payloads under `DEBUG=colyseus:*`; `startPresenceServer`
 * force-disables the per-connection ones so that switch cannot expose a
 * player's coordinates (see logging.ts). What this process cannot control is a
 * fronting proxy logging the matchmaking HTTP request body, which is why that
 * body carries nothing sensitive to begin with.
 */

import { DEFAULT_LOBBY_PORT, DEFAULT_ROOM_NAME } from './config';
import { startPresenceServer } from './server';

const port = Number(process.env['LOBBY_PORT'] ?? DEFAULT_LOBBY_PORT);

const server = await startPresenceServer({
  port,
  roomName: DEFAULT_ROOM_NAME,
});

process.stdout.write(
  `lobby presence on ${server.endpoint} (room "${server.roomName}")\n`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.shutdown().then(() => process.exit(0));
  });
}
