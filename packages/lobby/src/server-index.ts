/**
 * @strkworld/lobby/server — the Node-only server side.
 *
 * Everything here transitively pulls in `@colyseus/core` and
 * `@colyseus/ws-transport` (and, through the transport, `express`), so it must
 * never be imported into a browser bundle. The World lane and the shell import
 * the client from the root entry; only a Node process — the standalone
 * presence server, or a test — imports this one.
 *
 * The registry, presence policy, schema and config re-exported here are the
 * same modules the root entry exports; they are repeated so a server-side
 * consumer has one place to import from.
 */

export {
  LobbyPresence,
  type AdmitOutcome,
  type AdmitRejection,
  type LobbyPresenceOptions,
  type MoveOutcome,
  type MoveRequest,
  type PlacementRequest,
  type PresenceCounters,
} from './presence';

export {
  PRESENCE_REFUSED,
  PresenceRoom,
  definePresenceRoom,
} from './room';

export {
  startPresenceServer,
  type PresenceServer,
  type PresenceServerOptions,
} from './server';

export { silenceColyseusDebug } from './logging';

// Re-exported for convenience so a server consumer imports from one place.
export {
  DEFAULT_ROOM_CONFIG,
  DEFAULT_ROOM_NAME,
  resolveRoomConfig,
  type PresenceRoomConfig,
  type PresenceRoomConfigOverrides,
} from './config';
export { LobbyState, PresenceEntry, PositionSchema } from './state';
