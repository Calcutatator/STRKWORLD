/**
 * Tuning constants for the presence layer.
 *
 * Every value here is a bound on traffic or on what a client may put on the
 * wire. None of them is a secret and none of them is per-player.
 */

import type { Facing } from '@strkworld/shared';

/**
 * Default port for the standalone presence server.
 *
 * 2567 is the Colyseus convention and is what `npm run dev -w @strkworld/lobby`
 * binds. Recorded in README.md so the shell and the World lane agree.
 */
export const DEFAULT_LOBBY_PORT = 2567;

/** Only one room type exists. A district would become a second name later. */
export const DEFAULT_ROOM_NAME = 'street';

/**
 * Server-side floor between two accepted moves from the same session, in ms.
 *
 * 50ms is 20 updates/second, which matches the default patch rate: sending
 * faster cannot make anything appear sooner, it only costs bandwidth. Anything
 * arriving early is dropped, never queued — a dropped move is superseded by
 * the next one, so queueing would only add latency.
 */
export const MIN_UPDATE_INTERVAL_MS = 50;

/**
 * Hard per-connection message ceiling handed to Colyseus itself.
 *
 * The throttle above silently drops; this one disconnects. Colyseus counts
 * every inbound message before dispatch — including the ones the throttle
 * would drop — and force-closes the socket on exceed, with no notice to the
 * client. So a client must be constructed such that it *cannot* reach this
 * rate; see MIN_CLIENT_SEND_INTERVAL_MS below.
 */
export const MAX_MESSAGES_PER_SECOND = 40;

/**
 * The interval the hard ceiling implies, in ms. Sending faster than this risks
 * the force-close. `Math.ceil` so the rounding is conservative (25ms, not
 * 24.99ms).
 */
export const HARD_MIN_INTERVAL_MS = Math.ceil(1000 / MAX_MESSAGES_PER_SECOND);

/**
 * The floor the client clamps its own send interval to.
 *
 * Two constraints, and this is the stricter of the two: never send moves
 * faster than the server accepts them (`MIN_UPDATE_INTERVAL_MS`, since faster
 * is silently dropped), and never approach the hard ceiling
 * (`HARD_MIN_INTERVAL_MS`). Being at or above `MIN_UPDATE_INTERVAL_MS` clears
 * both with a comfortable margin for the occasional suspend/resume that also
 * counts against the ceiling. A consumer may ask for a smaller interval; the
 * client raises it to this floor rather than trusting the request.
 */
export const MIN_CLIENT_SEND_INTERVAL_MS = Math.max(
  MIN_UPDATE_INTERVAL_MS,
  HARD_MIN_INTERVAL_MS,
);

/** How often the room encodes state changes, in ms. 20fps. */
export const PATCH_RATE_MS = 50;

/**
 * Interest radius in world pixels, measured as a square (Chebyshev) box.
 *
 * A peer further away than this from the observer is not relayed to that
 * observer at all. Roughly one screen's worth of street either side, so an
 * avatar becomes visible slightly before it could be drawn.
 */
export const INTEREST_RADIUS = 640;

/**
 * Ceiling on how many peers one observer receives, nearest first.
 *
 * The radius alone does not bound traffic when a crowd forms in one place.
 * This does, and it incidentally bounds how much of the street any single
 * observer can watch at once.
 */
export const MAX_VISIBLE_PEERS = 24;

/** Ceiling on concurrent sessions in one room. */
export const MAX_CLIENTS_PER_ROOM = 48;

/**
 * Absolute ceiling on room capacity, regardless of what an operator asks for.
 *
 * `resolveRoomConfig` clamps to this. It exists so a typo — or, if the trusted
 * boundary ever failed, a hostile value — cannot produce a room that admits an
 * unbounded number of sessions (a `maxClients` of 99999 was reproduced live
 * before the trusted-config fix).
 */
export const HARD_MAX_CLIENTS = 128;

/**
 * Coordinates are clamped to this half-extent, in world pixels.
 *
 * Position is public within the world, but an unbounded float is a channel:
 * clamping and rounding to whole pixels leaves a client no spare precision to
 * encode anything in.
 */
export const WORLD_LIMIT = 8192;

/**
 * The only shape a session identifier may take: 16 lowercase hex characters.
 *
 * 64 bits of randomness, generated on the **server** at admission (see
 * `LobbyPresence.admit`). The narrowness is the point — a free-form identifier
 * field is somewhere a client could smuggle a string that this package is
 * forbidden to hold, and a fixed 16-character hex window cannot carry one. A
 * client-supplied identifier is ignored outright, so "ephemeral per-session"
 * is a property the server enforces rather than one it trusts the client to
 * respect.
 */
export const GAME_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Characters used when generating a session identifier. */
export const GAME_ID_LENGTH = 16;

/**
 * Sprite keys a client may choose from.
 *
 * D-047 fixes the deployed vocabulary at sixteen opaque keys. The first eight
 * are the cosy/default variants and the second eight are their paired fighting
 * variants; that meaning stays cosmetic and never becomes another lobby field.
 * A server operator may still override the list through the trusted
 * `startPresenceServer({ room: { spriteKeys } })` channel. An unrecognised
 * client value is replaced with the default rather than entering room state.
 */
export const DEFAULT_SPRITE_KEYS = Object.freeze([
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'avatar-7',
  'avatar-8',
  'avatar-9',
  'avatar-10',
  'avatar-11',
  'avatar-12',
  'avatar-13',
  'avatar-14',
  'avatar-15',
  'avatar-16',
] as const satisfies readonly string[]);

/** One key in D-047's fixed browser-to-lobby cosmetic vocabulary. */
export type LobbySprite = (typeof DEFAULT_SPRITE_KEYS)[number];

/** Substituted for any sprite key not on the allowed list. */
export const DEFAULT_SPRITE: LobbySprite = 'avatar-1';

/** Substituted for any facing value outside the four legal ones. */
export const DEFAULT_FACING: Facing = 'down';

/**
 * The room's entire client-to-server vocabulary.
 *
 * Three verbs, none of them financial. There is no message type through which
 * a client could tell the room anything else, which is the enforcement: the
 * room's surface has no field for it.
 */
export const MESSAGE = Object.freeze({
  /** `{ x, y, facing }` — the only high-rate message. */
  move: 'move',
  /** No payload. The avatar disappears for everyone else. See D-019. */
  suspend: 'suspend',
  /** `{ x, y, facing, sprite }` — reappear after a suspend. */
  resume: 'resume',
} as const);

export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

/**
 * Server-to-client messages. Exactly one, and it carries only the recipient's
 * own server-assigned session identifier so the client can recognise its own
 * avatar in the shared state. Nothing about any other player rides here.
 */
export const SERVER_MESSAGE = Object.freeze({
  /** `{ gameId }` — sent once, right after a join is admitted. */
  welcome: 'welcome',
} as const);

export type ServerMessageType =
  (typeof SERVER_MESSAGE)[keyof typeof SERVER_MESSAGE];

// ---------------------------------------------------------------------------
// Trusted room configuration
// ---------------------------------------------------------------------------

/**
 * The complete, resolved configuration of a presence room.
 *
 * ⚠ This is a *trusted* object. Under Colyseus matchmaking, a room's
 * `onCreate` receives `merge({}, clientOptions, handlerOptions)` — the client
 * half of which is attacker-controlled and, before this type existed, became
 * the room's entire config when the handler side was empty (a hex id + token
 * amount smuggled through `spriteKeys`/`defaultSprite` reached other players'
 * screens). A room must therefore build its config with `resolveRoomConfig`
 * from an operator-supplied source and never from its `onCreate` argument.
 */
export interface PresenceRoomConfig {
  readonly spriteKeys: readonly string[];
  readonly defaultSprite: string;
  readonly interestRadius: number;
  readonly maxVisiblePeers: number;
  readonly minUpdateIntervalMs: number;
  readonly capacity: number;
  readonly worldLimit: number;
  readonly maxMessagesPerSecond: number;
  readonly patchRateMs: number;
}

/** Operator-supplied overrides. Every field optional; all are clamped. */
export type PresenceRoomConfigOverrides = Partial<PresenceRoomConfig>;

/** The frozen defaults. What a room uses when the operator overrides nothing. */
export const DEFAULT_ROOM_CONFIG: PresenceRoomConfig = Object.freeze({
  spriteKeys: DEFAULT_SPRITE_KEYS,
  defaultSprite: DEFAULT_SPRITE,
  interestRadius: INTEREST_RADIUS,
  maxVisiblePeers: MAX_VISIBLE_PEERS,
  minUpdateIntervalMs: MIN_UPDATE_INTERVAL_MS,
  capacity: MAX_CLIENTS_PER_ROOM,
  worldLimit: WORLD_LIMIT,
  maxMessagesPerSecond: MAX_MESSAGES_PER_SECOND,
  patchRateMs: PATCH_RATE_MS,
});

function clamp(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/**
 * Merge operator overrides over the frozen defaults, clamping every numeric
 * field to a safe range, and return a frozen config.
 *
 * The clamps are not there to police a trusted operator — they are the last
 * line of defence in depth. If the trusted boundary ever failed and a hostile
 * value reached this function, a capacity of 99999 still becomes
 * `HARD_MAX_CLIENTS` and a negative interval still becomes something sane.
 *
 * `spriteKeys` and `defaultSprite` are strings and cannot be range-clamped, so
 * they are simply taken from the override or the default. That is safe because
 * this function is only ever called with an operator-supplied override; the
 * whole point of the trusted boundary is that a client value never arrives
 * here to begin with.
 */
export function resolveRoomConfig(
  overrides: PresenceRoomConfigOverrides = {},
): PresenceRoomConfig {
  // This is an operator-facing seam, but it is still called from runtime
  // composition code. Treat a malformed container as no overrides rather
  // than allowing a null dereference to prevent the lobby from starting.
  if (overrides === null || typeof overrides !== 'object') overrides = {};
  const spriteKeys =
    Array.isArray(overrides.spriteKeys) &&
    overrides.spriteKeys.length > 0 &&
    overrides.spriteKeys.every((k) => typeof k === 'string')
      ? Object.freeze([...overrides.spriteKeys])
      : DEFAULT_ROOM_CONFIG.spriteKeys;

  const defaultSprite =
    typeof overrides.defaultSprite === 'string' &&
    spriteKeys.includes(overrides.defaultSprite)
      ? overrides.defaultSprite
      : spriteKeys.includes(DEFAULT_ROOM_CONFIG.defaultSprite)
        ? DEFAULT_ROOM_CONFIG.defaultSprite
        : (spriteKeys[0] as string);

  return Object.freeze({
    spriteKeys,
    defaultSprite,
    interestRadius: clamp(overrides.interestRadius, 0, WORLD_LIMIT * 2, INTEREST_RADIUS),
    maxVisiblePeers: clamp(overrides.maxVisiblePeers, 1, HARD_MAX_CLIENTS, MAX_VISIBLE_PEERS),
    minUpdateIntervalMs: clamp(overrides.minUpdateIntervalMs, 0, 10_000, MIN_UPDATE_INTERVAL_MS),
    capacity: clamp(overrides.capacity, 1, HARD_MAX_CLIENTS, MAX_CLIENTS_PER_ROOM),
    worldLimit: clamp(overrides.worldLimit, 1, 1_000_000, WORLD_LIMIT),
    maxMessagesPerSecond: clamp(overrides.maxMessagesPerSecond, 1, 1000, MAX_MESSAGES_PER_SECOND),
    patchRateMs: clamp(overrides.patchRateMs, 10, 1000, PATCH_RATE_MS),
  });
}
