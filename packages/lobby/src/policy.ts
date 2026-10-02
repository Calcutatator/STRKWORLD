/**
 * Boundary policy: what a client is allowed to say, and who hears it.
 *
 * Pure functions and one small clock-driven class. Nothing here imports
 * Colyseus, so the rules that keep the wire clean are unit-testable without a
 * transport, and the room is left with nothing but wiring.
 *
 * The normalisers all take `unknown`. That is deliberate: everything they see
 * arrives from a client and none of it is trustworthy.
 */

import {
  SANDBOX_COLOURS,
  type Facing,
  type GameId,
  type Position,
  type SandboxTile,
} from '@strkworld/shared';
import {
  DEFAULT_FACING,
  DEFAULT_SPRITE,
  GAME_ID_PATTERN,
  WORLD_LIMIT,
} from './config.js';
import { isSandboxTile } from './sandbox-rules.js';

const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right'];

/**
 * Accept a client-generated session identifier, or reject it outright.
 *
 * Rejection is the only option — there is no safe way to repair a malformed
 * one, and silently substituting a generated identifier would hide a client
 * bug that is worth surfacing.
 */
export function normalizeGameId(raw: unknown): GameId | null {
  if (typeof raw !== 'string') return null;
  if (!GAME_ID_PATTERN.test(raw)) return null;
  return raw as GameId;
}

/** Generate a well-formed session identifier. Random, never derived. */
export function createGameId(
  random: (bytes: Uint8Array) => Uint8Array = defaultRandom,
): GameId {
  const bytes = random(new Uint8Array(8));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 8) {
    throw new Error('Lobby game id randomness must return exactly 8 bytes');
  }
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as GameId;
}

function defaultRandom(target: Uint8Array): Uint8Array {
  globalThis.crypto.getRandomValues(target);
  return target;
}

/**
 * Map a requested sprite key onto one the room recognises.
 *
 * Falls back rather than rejecting: a cosmetic mismatch between this package
 * and the world's asset registry should cost a wrong-looking avatar, not a
 * failed join. The important half is that an unrecognised string never
 * reaches room state.
 */
export function normalizeSprite(
  raw: unknown,
  allowed: readonly string[],
  fallback: string = DEFAULT_SPRITE,
): string {
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  return allowed.includes(fallback) ? fallback : (allowed[0] ?? fallback);
}

/** Map a requested facing onto one of the four legal ones. */
export function normalizeFacing(raw: unknown): Facing {
  return FACINGS.includes(raw as Facing) ? (raw as Facing) : DEFAULT_FACING;
}

/**
 * Accept a coordinate, rounded to a whole pixel and clamped to the world.
 *
 * Returns null for anything that is not a finite number, which rejects the
 * whole update. NaN and Infinity are rejected rather than clamped: they are
 * never a real position, so they are either a bug or an attempt at something.
 */
export function normalizeCoordinate(
  raw: unknown,
  limit: number = WORLD_LIMIT,
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(-limit, Math.min(limit, Math.round(raw)));
}

/**
 * Accept a sandbox tile (D-060), or reject it outright.
 *
 * Integer coordinates inside `SANDBOX_AREA`, read from own data properties
 * only — an accessor or a proxy trap is never invoked, and a string, an
 * array, NaN, Infinity or a fraction is simply not a tile. There is no repair:
 * a tile that is almost right is still somewhere the player did not aim.
 */
export function normalizeSandboxTile(raw: unknown): SandboxTile | null {
  if (raw === null || typeof raw !== 'object') return null;
  const x = ownDataField(raw, 'x');
  const y = ownDataField(raw, 'y');
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!isSandboxTile(x, y)) return null;
  return Object.freeze({ x, y });
}

/**
 * Accept a sandbox block colour: an integer palette index in
 * `0 .. SANDBOX_COLOURS - 1`. Anything else, including the schema's `-1`
 * "carrying nothing", is null.
 */
export function normalizeSandboxColour(raw: unknown): number | null {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw < SANDBOX_COLOURS
    ? raw
    : null;
}

function ownDataField(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Anything carrying a position. Both schema instances and plain data fit. */
export interface Located {
  readonly position: { readonly x: number; readonly y: number };
}

/** Square (Chebyshev) distance. Cheaper than Euclidean and easier to reason about. */
export function distanceBetween(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Whether `other` is inside the observer's interest box. */
export function isWithinInterest(
  observer: Position,
  other: Position,
  radius: number,
): boolean {
  return distanceBetween(observer, other) <= radius;
}

/**
 * Pick what one observer should receive: everything inside the radius,
 * nearest first, capped.
 *
 * The cap is what actually bounds traffic — a radius alone does nothing when
 * a crowd forms on one corner.
 *
 * D-114: candidates in `pinned` come first, whatever their distance (the
 * arena ring's fighter, whom every arena observer must see), nearest first
 * among themselves, and still count against the cap.
 */
export function selectVisible<T extends Located>(
  observer: Located,
  candidates: Iterable<T>,
  radius: number,
  cap: number,
  pinned?: ReadonlySet<T>,
): T[] {
  const near: Array<{ item: T; distance: number; pinned: boolean }> = [];
  for (const item of candidates) {
    const distance = distanceBetween(observer.position, item.position);
    const isPinned = pinned !== undefined && pinned.has(item);
    if (isPinned || distance <= radius) near.push({ item, distance, pinned: isPinned });
  }
  near.sort((a, b) => (a.pinned === b.pinned ? a.distance - b.distance : a.pinned ? -1 : 1));
  return near.slice(0, Math.max(0, cap)).map((entry) => entry.item);
}

/**
 * Per-session rate floor for high-rate messages.
 *
 * Drop, do not queue: a superseded position is worthless, and queueing would
 * turn a fast client into a laggy one. The clock is a parameter so tests are
 * deterministic and so the room can share one time source across a tick.
 *
 * ## Burst (D-086)
 *
 * With `burst` 1 (the default) this is a strict floor: an update is accepted
 * only a full interval after the last accepted one. That is right for a key
 * press (a sandbox action, a kick), but wrong for a stream sent at exactly
 * the floor: network jitter delivers some of a client's 50 ms-apart moves
 * 40 ms apart, and a strict floor drops each of those. The load test
 * (`tools/load-test.ts`) measured a third of all moves dropped at 20 ms of
 * jitter, and every observer saw those peers stall for a patch.
 *
 * `burst` B > 1 makes it a token bucket (GCRA): the long-run rate is still at
 * most one per interval, but up to B may arrive close together after a gap,
 * so an update that is early only because the previous one was late is
 * accepted. Jitter up to `(B - 1) * interval` costs nothing.
 */
export class UpdateThrottle {
  readonly #minIntervalMs: number;
  /** How early an update may arrive and still be accepted, in ms. */
  readonly #toleranceMs: number;
  /**
   * Per key, the theoretical arrival time of the next update: when it would
   * be due if every accepted update had come exactly one interval apart.
   */
  readonly #due = new Map<string, number>();

  constructor(minIntervalMs: number, burst = 1) {
    this.#minIntervalMs = minIntervalMs;
    const slots = Number.isSafeInteger(burst) && burst >= 1 ? burst : 1;
    this.#toleranceMs = (slots - 1) * minIntervalMs;
  }

  /** True if this update is due; records the time when it is. */
  accept(key: string, now: number): boolean {
    if (!isValidMonotonicTime(now)) return false;
    const due = this.#due.get(key);
    if (due !== undefined && due - now > this.#toleranceMs) return false;
    this.#due.set(key, Math.max(due ?? now, now) + this.#minIntervalMs);
    return true;
  }

  /**
   * Consume the rate floor for a session at a valid `now`, without ever
   * moving its floor backward, and drain any burst allowance: the next
   * update must wait a full interval from `now`, whatever the burst.
   *
   * It is for a non-move event that must still consume the rate floor, so that
   * the next `move` waits a full interval from it. Used by `resume` (see
   * `LobbyPresence.resume`).
   */
  stamp(key: string, now: number): boolean {
    if (!isValidMonotonicTime(now)) return false;
    const due = this.#due.get(key);
    const drained = now + this.#toleranceMs + this.#minIntervalMs;
    if (due === undefined || drained > due) this.#due.set(key, drained);
    return true;
  }

  /** Forget a session. Called on leave so the map cannot grow unbounded. */
  forget(key: string): void {
    this.#due.delete(key);
  }

  get tracked(): number {
    return this.#due.size;
  }
}

/** A monotonic source starts at zero; negative and non-finite samples are unsafe. */
function isValidMonotonicTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
