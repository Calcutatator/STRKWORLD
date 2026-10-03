/**
 * The room's roof swing (D-133): one rules authority and its mirror in the
 * room schema. No transport.
 *
 * The authority in `swing-rules.ts` is the truth; the `SwingEntry` handed to
 * this class is a copy that exists only so Colyseus can encode it. Every
 * change goes authority first, then the entry is rewritten where it differs,
 * so the two never disagree after a call returns. An idle swing that nothing
 * touched costs no patches.
 *
 * The entry reaches only sessions live on the roof: the room adds it to a
 * view in `#syncView`, never to anyone else's. Everything here is keyed by
 * the caller's connection key, which never leaves the server; the entry holds
 * a phase, counters and, while someone rides, the presence id roof peers
 * already hold.
 */

import { SWING_END_REASONS, SWING_PHASES, type RoofSwingSnapshot } from '@strkworld/shared';
import {
  createSwingAuthority,
  type SwingAuthority,
  type SwingAuthorityOptions,
  type SwingClaimOutcome,
  type SwingClaimant,
  type SwingEvent,
  type SwingGoneReason,
  type SwingLeaveOutcome,
} from './swing-rules.js';
import type { SwingEntry } from './state.js';

/** The swing's wire bytes, as `SwingEntry` holds them. */
export interface SwingWire {
  readonly phase: number;
  readonly round: number;
  readonly riderId: string;
  readonly secondsLeft: number;
  readonly reason: number;
}

/** A snapshot as the wire carries it: codes for names, `''` for no presence id, 0 for none. */
export function swingToWire(swing: RoofSwingSnapshot): SwingWire {
  return {
    phase: SWING_PHASES.indexOf(swing.phase),
    round: swing.round,
    riderId: swing.riderId ?? '',
    secondsLeft: swing.secondsLeft,
    reason: swing.reason === null ? 0 : SWING_END_REASONS.indexOf(swing.reason) + 1,
  };
}

export class LobbySwing {
  readonly #mirror: SwingEntry;
  readonly #authority: SwingAuthority;
  /** What the mirror holds now, so nothing is ever read back out of the schema. */
  #written: SwingWire | null = null;

  constructor(mirror: SwingEntry, options: SwingAuthorityOptions = {}, now = 0) {
    this.#mirror = mirror;
    this.#authority = createSwingAuthority(options);
    this.#copy(now);
  }

  /** Whether a deadline is pending: the room keeps its swing clock running while true. */
  get active(): boolean {
    return this.#authority.active;
  }

  snapshot(now: number): RoofSwingSnapshot {
    return this.#authority.snapshot(now);
  }

  /** Whether `key`'s session is the rider on the seat, and so stands on its tile. */
  holdsSeat(key: string): boolean {
    return this.#authority.holdsSeat(key);
  }

  claim(claimant: SwingClaimant, now: number): SwingClaimOutcome {
    const outcome = this.#authority.claim(claimant, now);
    this.#copy(now);
    return outcome;
  }

  leave(key: string, now: number): SwingLeaveOutcome {
    const outcome = this.#authority.leave(key, now);
    this.#copy(now);
    return outcome;
  }

  gone(key: string, reason: SwingGoneReason, now: number): boolean {
    const changed = this.#authority.gone(key, reason, now);
    this.#copy(now);
    return changed;
  }

  /** Every deadline up to `now`, and the placements the room must make. */
  advance(now: number): SwingEvent[] {
    const events = this.#authority.advance(now);
    this.#copy(now);
    return events;
  }

  forget(key: string): void {
    this.#authority.forget(key);
  }

  /** Rewrite the mirror where the authority differs from it. */
  #copy(now: number): void {
    const next = swingToWire(this.#authority.snapshot(now));
    const last = this.#written;
    const entry = this.#mirror;
    if (last === null || last.phase !== next.phase) entry.phase = next.phase;
    if (last === null || last.round !== next.round) entry.round = next.round;
    if (last === null || last.riderId !== next.riderId) entry.riderId = next.riderId;
    if (last === null || last.secondsLeft !== next.secondsLeft) entry.secondsLeft = next.secondsLeft;
    if (last === null || last.reason !== next.reason) entry.reason = next.reason;
    this.#written = next;
  }
}
