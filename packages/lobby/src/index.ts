/**
 * @strkworld/lobby — multiplayer presence.
 *
 * Broadcasts where avatars are. Nothing else, and structurally nothing else:
 * the room schema in `state.ts` mirrors the frozen `PresenceState` field for
 * field, so there is no field for an account, a balance, a hash or a
 * destination to travel in. See README.md.
 *
 * Server side:  `startPresenceServer`, `PresenceRoom`, `LobbyPresence`.
 * Client side:  `LobbyClient` — plain data, no engine and no framework.
 */

export {
  DEFAULT_FACING,
  DEFAULT_LOBBY_PORT,
  DEFAULT_ROOM_NAME,
  DEFAULT_SPRITE,
  DEFAULT_SPRITE_KEYS,
  GAME_ID_PATTERN,
  INTEREST_RADIUS,
  MAX_CLIENTS_PER_ROOM,
  MAX_MESSAGES_PER_SECOND,
  MAX_VISIBLE_PEERS,
  MESSAGE,
  MIN_UPDATE_INTERVAL_MS,
  PATCH_RATE_MS,
  WORLD_LIMIT,
  type MessageType,
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
  type PresenceRoomOptions,
} from './room';

export {
  startPresenceServer,
  type PresenceServer,
  type PresenceServerOptions,
} from './server';

export {
  LobbyClient,
  type LobbyClientOptions,
  type LobbyStatus,
  type PeerSnapshot,
  type Placement,
} from './client';
