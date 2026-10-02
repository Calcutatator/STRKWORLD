/**
 * @strkworld/lobby — multiplayer presence.
 *
 * Broadcasts where avatars are, plus D-060's anonymous block sandbox and
 * D-078's one football. Nothing else, and structurally nothing else: the room
 * schema in `state.ts` mirrors the frozen `PresenceState` field for field and
 * adds only colour stacks keyed by tile and one ball with its scoreboard, so
 * there is no field for an account, a balance, a hash or a destination to
 * travel in. See README.md.
 *
 * The pure sandbox rules the Shell runs for solo play live at
 * `@strkworld/lobby/sandbox`, the football's at `@strkworld/lobby/football`
 * and the arena ring's (D-114) at `@strkworld/lobby/arena`, with no Colyseus
 * import at all.
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
  FOOTBALL_CLIENT_KICK_INTERVAL_MS,
  FOOTBALL_MIN_KICK_INTERVAL_MS,
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
  SANDBOX_CLIENT_ACTION_INTERVAL_MS,
  SANDBOX_MIN_ACTION_INTERVAL_MS,
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
  normalizeSandboxColour,
  normalizeSandboxTile,
  normalizeSprite,
  selectVisible,
  type Located,
} from './policy';

export {
  AREA_STEP_SLACK_PX,
  SHARED_AREA_GRIDS,
  isAreaStepAllowed,
  isAreaWalkable,
  isOverAreaGrid,
  normalizePresenceArea,
  type SharedPresenceArea,
} from './areas';

export {
  ARENA_RING_KEY,
  ArenaRingEntry,
  ArenaSlotEntry,
  FootballEntry,
  LobbyState,
  PositionSchema,
  PresenceEntry,
  SandboxColumnEntry,
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
