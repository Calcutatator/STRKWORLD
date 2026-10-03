/**
 * The room's pitch match (D-135): one rules authority and its mirror in the
 * room schema. No transport.
 *
 * The authority in `pitch-rules.ts` is the truth; the `PitchMatchEntry` handed
 * to this class is a copy that exists only so Colyseus can encode it. Every
 * change goes authority first, then the entry is rewritten where it differs,
 * so the two never disagree after a call returns. An open, unchanged match
 * costs no patches.
 *
 * The entry reaches only sessions live on the street and near the pitch: the
 * room adds it to a view in `#syncView`, never to anyone else's. Everything
 * here is keyed by the caller's connection key, which never leaves the server;
 * the entry holds a phase, the score, counters, the dummies' places and, for a
 * player slot, the presence id street peers within interest already hold.
 */

import {
  FOOTBALL_SIDES,
  PITCH_MATCH_PHASES,
  PITCH_SLOTS,
  PITCH_SLOT_KINDS,
  type PitchMatchSnapshot,
  type PitchSlot,
} from '@strkworld/shared';
import {
  createPitchAuthority,
  type PitchAuthority,
  type PitchAuthorityOptions,
  type PitchEvent,
  type PitchGateOutcome,
  type PitchGoneReason,
  type PitchPresser,
} from './pitch-rules.js';
import type { BallState } from './football-rules.js';
import type { PitchMatchEntry, PitchSlotEntry } from './state.js';

/** One slot's wire bytes. */
export interface PitchSlotWire {
  readonly kind: number;
  readonly gameId: string;
  readonly x: number;
  readonly y: number;
}

/** The match's wire bytes, as `PitchMatchEntry` holds them. */
export interface PitchMatchWire {
  readonly phase: number;
  readonly round: number;
  readonly slots: readonly PitchSlotWire[];
  readonly starks: number;
  readonly snarks: number;
  readonly secondsLeft: number;
  readonly winner: number;
}

function slotToWire(slot: PitchSlot): PitchSlotWire {
  return {
    kind: PITCH_SLOT_KINDS.indexOf(slot.kind),
    gameId: slot.gameId ?? '',
    x: slot.x,
    y: slot.y,
  };
}

/** A snapshot as the wire carries it: codes for names, `''` for no presence id, 0 for none. */
export function pitchMatchToWire(match: PitchMatchSnapshot): PitchMatchWire {
  return {
    phase: PITCH_MATCH_PHASES.indexOf(match.phase),
    round: match.round,
    slots: match.slots.map(slotToWire),
    starks: match.starks,
    snarks: match.snarks,
    secondsLeft: match.secondsLeft,
    winner: match.winner === null ? 0 : FOOTBALL_SIDES.indexOf(match.winner) + 1,
  };
}

function writeSlot(entry: PitchSlotEntry, next: PitchSlotWire, last: PitchSlotWire | null): void {
  if (last === null || last.kind !== next.kind) entry.kind = next.kind;
  if (last === null || last.gameId !== next.gameId) entry.gameId = next.gameId;
  if (last === null || last.x !== next.x) entry.x = next.x;
  if (last === null || last.y !== next.y) entry.y = next.y;
}

export class LobbyPitch {
  readonly #mirror: PitchMatchEntry;
  readonly #authority: PitchAuthority;
  /** What the mirror holds now, so nothing is ever read back out of the schema. */
  #written: PitchMatchWire | null = null;

  constructor(mirror: PitchMatchEntry, options: PitchAuthorityOptions = {}, now = 0) {
    this.#mirror = mirror;
    this.#authority = createPitchAuthority(options);
    this.#copy(now);
  }

  /** Whether a deadline is pending: the room keeps its pitch clock running while true. */
  get active(): boolean {
    return this.#authority.active;
  }

  /** Whether the gates read "IN PLAY": four real players, or a winner's banner up. */
  get locked(): boolean {
    return this.#authority.locked;
  }

  get phase(): PitchMatchSnapshot['phase'] {
    return this.#authority.phase;
  }

  snapshot(now: number): PitchMatchSnapshot {
    return this.#authority.snapshot(now);
  }

  /** Whether `key`'s session takes part, and so may stand inside the fence. */
  holdsSlot(key: string): boolean {
    return this.#authority.holdsSlot(key);
  }

  mayKick(key: string): boolean {
    return this.#authority.mayKick(key);
  }

  gate(presser: PitchPresser, now: number): PitchGateOutcome {
    const outcome = this.#authority.gate(presser, now);
    this.#copy(now);
    return outcome;
  }

  gone(key: string, reason: PitchGoneReason, now: number): boolean {
    const changed = this.#authority.gone(key, reason, now);
    this.#copy(now);
    return changed;
  }

  scored(starks: number, snarks: number, now: number): void {
    this.#authority.scored(starks, snarks, now);
    this.#copy(now);
  }

  fullTime(winner: PitchMatchSnapshot['winner'] & {}, now: number): void {
    this.#authority.fullTime(winner, now);
    this.#copy(now);
  }

  /** Every deadline up to `now`, the dummies' step, and what the room must do. */
  advance(now: number, ball: BallState): PitchEvent[] {
    const events = this.#authority.advance(now, ball);
    this.#copy(now);
    return events;
  }

  /** Whether the ball must be put back on the centre spot at 0–0 since the last call. */
  takeReset(): boolean {
    return this.#authority.takeReset();
  }

  dummies(): readonly { readonly key: string; readonly x: number; readonly y: number }[] {
    return this.#authority.dummies();
  }

  forget(key: string): void {
    this.#authority.forget(key);
  }

  /** Rewrite the mirror where the authority differs from it. */
  #copy(now: number): void {
    const next = pitchMatchToWire(this.#authority.snapshot(now));
    const last = this.#written;
    const entry = this.#mirror;
    if (last === null || last.phase !== next.phase) entry.phase = next.phase;
    if (last === null || last.round !== next.round) entry.round = next.round;
    if (last === null || last.starks !== next.starks) entry.starks = next.starks;
    if (last === null || last.snarks !== next.snarks) entry.snarks = next.snarks;
    if (last === null || last.secondsLeft !== next.secondsLeft) entry.secondsLeft = next.secondsLeft;
    if (last === null || last.winner !== next.winner) entry.winner = next.winner;
    for (let index = 0; index < PITCH_SLOTS; index += 1) {
      const slot = entry.slots.at(index) as PitchSlotEntry | undefined;
      if (slot === undefined) continue;
      writeSlot(slot, next.slots[index]!, last?.slots[index] ?? null);
    }
    this.#written = next;
  }
}
