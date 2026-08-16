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
 * It prints the endpoint and nothing else. There is no per-connection line to
 * print: joins, leaves and positions are exactly the things this package is
 * not allowed to record.
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
