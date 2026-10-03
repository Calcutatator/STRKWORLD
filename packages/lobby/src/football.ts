/**
 * The room's football (D-078): one rules authority, its mirror in the room
 * schema, and the per-session kick floor. No transport.
 *
 * The authority in `football-rules.ts` is the truth; the `FootballEntry`
 * handed to this class is a copy that exists only so Colyseus can encode it.
 * Every change goes authority first, then the entry is rewritten where it
 * differs, so the two can never disagree after a call returns. The entry is
 * written only when the ball, the score or the phase changed: a ball at rest
 * costs no patches, and `tick` always dates the sample it rides with.
 *
 * Everything here is keyed by the caller's connection key, which never leaves
 * the server; the entry holds the ball and the scoreboard only.
 */

import type { Facing, FootballPhase, FootballSnapshot } from '@strkworld/shared';
import { resolveRoomConfig } from './config.js';
import { UpdateThrottle } from './policy.js';
import {
  createFootballAuthority,
  isNearPitch,
  type BallState,
  type FootballAuthority,
  type FootballEvent,
  type FootballPlayer,
} from './football-rules.js';
import type { FootballEntry } from './state.js';

export type KickOutcome =
  /** The authority accepted it; the ball is on its way. */
  | 'applied'
  /** On time, but a rule refused it: out of reach, play not live, or the ball at rest. Nothing changed. */
  | 'rejected'
  /** Arrived inside the session's kick floor and was dropped. */
  | 'throttled'
  /** No live entry — unknown or currently suspended. */
  | 'absent';

/** Someone who kicks: where the room says they stand, and which way they face. */
export interface Kicker {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
}

export interface LobbyFootballOptions {
  readonly kickIntervalMs?: number;
  /** Where the ball starts; a kick-off ball when absent. A test seam. */
  readonly ball?: BallState;
}

/**
 * The ball's position and velocity travel in whole 64ths of a World pixel
 * (and of a pixel a second): a 64th of a pixel is far below what anyone can
 * see, and whole numbers leave the state no spare precision.
 */
export const FOOTBALL_WIRE_SCALE = 64;

/** A World-pixel value as the wire carries it. */
export function toWire(value: number): number {
  return Math.round(value * FOOTBALL_WIRE_SCALE);
}

/** The phase's byte on the wire. */
export const FOOTBALL_PHASE_CODES: Readonly<Record<FootballPhase, number>> = Object.freeze({
  live: 0,
  goal: 1,
  'full-time': 2,
});

export class LobbyFootball {
  readonly #mirror: FootballEntry;
  readonly #authority: FootballAuthority;
  readonly #throttle: UpdateThrottle;
  /** What the mirror holds now, in wire units, so nothing is ever read back out of the schema. */
  #written: FootballSnapshot | null = null;

  constructor(mirror: FootballEntry, options: LobbyFootballOptions = {}) {
    this.#mirror = mirror;
    // Clamp through the same resolver as the room config, so a direct
    // construction cannot bypass the bounds an operator override would get.
    const config = resolveRoomConfig({ footballKickIntervalMs: options.kickIntervalMs });
    this.#authority = createFootballAuthority(options.ball === undefined ? {} : { ball: options.ball });
    this.#throttle = new UpdateThrottle(config.footballKickIntervalMs);
    this.#copy();
  }

  /** Whether the ball is running: someone was near at the last check. */
  get running(): boolean {
    return this.#authority.running;
  }

  snapshot(): FootballSnapshot {
    return this.#authority.snapshot();
  }

  /**
   * Run the ball while anyone in `players` is on or near the pitch, and bring
   * it to rest when nobody is. Returns whether it now runs.
   */
  keepRunning(players: readonly FootballPlayer[], now: number): boolean {
    const near = Array.isArray(players) && players.some((player) => isNearPitch(player.x, player.y));
    if (near) this.#authority.resume(now);
    else this.#authority.pause();
    this.#copy();
    return this.#authority.running;
  }

  /** Every whole step up to `now`, with `players` as they stand, and what happened in them. */
  advance(now: number, players: readonly FootballPlayer[]): FootballEvent[] {
    const events = this.#authority.advance(now, players);
    this.#copy();
    return events;
  }

  /**
   * Apply one kick from `actor`, whose position is the one the room holds.
   * The floor is consumed before the rules run, so a refused kick still costs
   * its sender a full interval.
   */
  kick(actor: Kicker, now: number): KickOutcome {
    if (!this.#throttle.accept(actor.key, now)) return 'throttled';
    if (!this.#authority.kick({ x: actor.x, y: actor.y }, actor.facing)) return 'rejected';
    this.#copy();
    return 'applied';
  }

  /**
   * D-135: a kick the room itself makes — one of the pitch's dummies. No
   * per-session floor, because the match paces the dummies
   * (`PITCH_DUMMY_KICK_INTERVAL_MS`), and no facing, because a dummy lines
   * itself up behind the ball and so never stands on its centre. Returns
   * whether the rules took it.
   */
  kickFrom(at: { readonly x: number; readonly y: number }): boolean {
    if (!this.#authority.kick(at)) return false;
    this.#copy();
    return true;
  }

  /** Forget a connection's floor and movement: it left. */
  forget(key: string): void {
    this.#throttle.forget(key);
    this.#authority.forget(key);
  }

  /** Forget a connection's movement only: it left the street, and keeps its floor. */
  lose(key: string): void {
    this.#authority.forget(key);
  }

  /**
   * D-135: back to a kick-off, 0–0, live — what the pitch's match authority
   * does at the start and the close of a match.
   */
  reset(): void {
    this.#authority.reset();
    this.#copy();
  }

  /**
   * Rewrite the mirror where the authority differs from it: the ball, the
   * score, the phase, and the tick they are from. A ball at rest keeps the
   * tick it stopped on, so it costs no patch; a moving one is always dated.
   */
  #copy(): void {
    const truth = this.#authority.snapshot();
    const next: FootballSnapshot = {
      ...truth,
      x: toWire(truth.x),
      y: toWire(truth.y),
      vx: toWire(truth.vx),
      vy: toWire(truth.vy),
    };
    const last = this.#written;
    if (
      last !== null &&
      last.x === next.x &&
      last.y === next.y &&
      last.vx === next.vx &&
      last.vy === next.vy &&
      last.starks === next.starks &&
      last.snarks === next.snarks &&
      last.phase === next.phase &&
      (last.tick === next.tick || (next.vx === 0 && next.vy === 0))
    ) {
      return;
    }
    const entry = this.#mirror;
    if (last === null || last.tick !== next.tick) entry.tick = next.tick;
    if (last === null || last.x !== next.x) entry.x = next.x;
    if (last === null || last.y !== next.y) entry.y = next.y;
    if (last === null || last.vx !== next.vx) entry.vx = next.vx;
    if (last === null || last.vy !== next.vy) entry.vy = next.vy;
    if (last === null || last.starks !== next.starks) entry.starks = next.starks;
    if (last === null || last.snarks !== next.snarks) entry.snarks = next.snarks;
    if (last === null || last.phase !== next.phase) entry.phase = FOOTBALL_PHASE_CODES[next.phase];
    this.#written = next;
  }
}
