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

import type { Facing, GameId, Position } from '@strkworld/shared';
import {
  DEFAULT_FACING,
  DEFAULT_SPRITE,
  GAME_ID_PATTERN,
  WORLD_LIMIT,
} from './config';

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
 */
export function selectVisible<T extends Located>(
  observer: Located,
  candidates: Iterable<T>,
  radius: number,
  cap: number,
): T[] {
  const near: Array<{ item: T; distance: number }> = [];
  for (const item of candidates) {
    const distance = distanceBetween(observer.position, item.position);
    if (distance <= radius) near.push({ item, distance });
  }
  near.sort((a, b) => a.distance - b.distance);
  return near.slice(0, cap).map((entry) => entry.item);
}

/**
 * Per-session rate floor for high-rate messages.
 *
 * Drop, do not queue: a superseded position is worthless, and queueing would
 * turn a fast client into a laggy one. The clock is a parameter so tests are
 * deterministic and so the room can share one time source across a tick.
 */
export class UpdateThrottle {
  readonly #minIntervalMs: number;
  readonly #lastAccepted = new Map<string, number>();

  constructor(minIntervalMs: number) {
    this.#minIntervalMs = minIntervalMs;
  }

  /** True if this update is due; records the time when it is. */
  accept(key: string, now: number): boolean {
    const previous = this.#lastAccepted.get(key);
    if (previous !== undefined && now - previous < this.#minIntervalMs) {
      return false;
    }
    this.#lastAccepted.set(key, now);
    return true;
  }

  /** Forget a session. Called on leave so the map cannot grow unbounded. */
  forget(key: string): void {
    this.#lastAccepted.delete(key);
  }

  get tracked(): number {
    return this.#lastAccepted.size;
  }
}
