/**
 * @strkworld/lobby — multiplayer presence.
 *
 * Broadcasts where avatars are. Nothing else, and structurally nothing else:
 * the room schema in `state.ts` mirrors the frozen `PresenceState` field for
 * field, so there is no field for an account, a balance, a hash or a
 * destination to travel in. See README.md.
 *
 * ## This entry is browser-safe
 *
 * The root entry exports only what a browser consumer (the World lane, the
 * shell) needs: the client wrapper, the shared schema and the pure policy and
 * config helpers. It does **not** re-export the room or the server, because
 * those pull in `@colyseus/core` and `@colyseus/ws-transport` (and, through the
 * transport, `express` and its ~50 transitive dependencies) — none of which
 * belong in a browser bundle. Import the server side from `@strkworld/lobby/server`,
 * which only a Node process should do.
 */

export {
  DEFAULT_FACING,
  DEFAULT_LOBBY_PORT,
  DEFAULT_ROOM_CONFIG,
  DEFAULT_ROOM_NAME,
  DEFAULT_SPRITE,
  DEFAULT_SPRITE_KEYS,
  GAME_ID_PATTERN,
  HARD_MAX_CLIENTS,
  HARD_MIN_INTERVAL_MS,
  INTEREST_RADIUS,
  MAX_CLIENTS_PER_ROOM,
  MAX_MESSAGES_PER_SECOND,
  MAX_VISIBLE_PEERS,
  MESSAGE,
  MIN_CLIENT_SEND_INTERVAL_MS,
  MIN_UPDATE_INTERVAL_MS,
  PATCH_RATE_MS,
  SERVER_MESSAGE,
  WORLD_LIMIT,
  resolveRoomConfig,
  type MessageType,
  type LobbySprite,
  type PresenceRoomConfig,
  type PresenceRoomConfigOverrides,
  type ServerMessageType,
} from './config';

export {
  UpdateThrottle,
  createGameId,
  distanceBetween,
  isWithinInterest,
  normalizeCoordinate,
  normalizeFacing,
  normalizeGameId,
  normalizeSprite,
  selectVisible,
  type Located,
} from './policy';

export {
  LobbyState,
  PositionSchema,
  PresenceEntry,
} from './state';

export {
  LobbyClient,
  type LobbyClientOptions,
  type LobbyStatus,
  type LobbyStatusEvent,
  type LobbyStatusReason,
  type PeerSnapshot,
  type Placement,
} from './client';
