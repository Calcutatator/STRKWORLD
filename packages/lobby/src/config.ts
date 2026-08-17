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
 * The throttle above silently drops; this one disconnects. It is deliberately
 * well above the throttle so a normal client never trips it.
 */
export const MAX_MESSAGES_PER_SECOND = 40;

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
 * 64 bits of client-generated randomness. The narrowness is the point — a
 * free-form identifier field is somewhere a client could smuggle a string
 * that this package is forbidden to hold, and a fixed 16-character hex window
 * cannot carry one.
 */
export const GAME_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Characters used when generating a session identifier. */
export const GAME_ID_LENGTH = 16;

/**
 * Sprite keys a client may choose from.
 *
 * Placeholder until the World lane publishes its asset registry; a room can be
 * defined with its own list through `PresenceRoomOptions.spriteKeys`. An
 * unrecognised key is replaced with the default rather than rejected, so a
 * mismatch between lanes costs a wrong-looking avatar and never a leak.
 */
export const DEFAULT_SPRITE_KEYS: readonly string[] = [
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'avatar-7',
  'avatar-8',
];

/** Substituted for any sprite key not on the allowed list. */
export const DEFAULT_SPRITE = 'avatar-1';

/** Substituted for any facing value outside the four legal ones. */
export const DEFAULT_FACING: Facing = 'down';

/**
 * The room's entire client-to-server vocabulary.
 *
 * Three verbs, none of them financial. There is no message type through which
 * a client could tell the room anything else, which is the enforcement: the
 * room's surface has no field for it.
 */
export const MESSAGE = {
  /** `{ x, y, facing }` — the only high-rate message. */
  move: 'move',
  /** No payload. The avatar disappears for everyone else. See D-019. */
  suspend: 'suspend',
  /** `{ x, y, facing, sprite }` — reappear after a suspend. */
  resume: 'resume',
} as const;

export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];
