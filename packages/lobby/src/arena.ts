/**
 * The room's arena ring (D-114): one rules authority and its mirror in the
 * room schema. No transport.
 *
 * The authority in `arena-rules.ts` is the truth; the `ArenaRingEntry`
 * handed to this class is a copy that exists only so Colyseus can encode it.
 * Every change goes authority first, then the entry is rewritten where it
 * differs, so the two never disagree after a call returns. A ring that is
 * idle and unchanged costs no patches.
 *
 * The entry reaches only sessions live in the arena: the room adds it to a
 * view in `#syncView`, never to anyone else's. Everything here is keyed by
 * the caller's connection key, which never leaves the server; the entry holds
 * a phase, counters and, for a player slot, the presence id peers in the
 * arena already hold.
 */

import {
  ARENA_END_REASONS,
  ARENA_PHASES,
  ARENA_SIDES,
  ARENA_SLOT_KINDS,
  type ArenaRingSnapshot,
  type ArenaSlot,
} from '@strkworld/shared';
import {
  createArenaAuthority,
  type ArenaAttackOutcome,
  type ArenaAuthority,
  type ArenaAuthorityOptions,
  type ArenaBlockOutcome,
  type ArenaClaimOutcome,
  type ArenaClaimant,
  type ArenaEvent,
  type ArenaGoneReason,
  type ArenaLeaveOutcome,
  type ArenaLocate,
  type ArenaSeatOutcome,
} from './arena-rules.js';
import type { ArenaRingEntry, ArenaSlotEntry } from './state.js';

/** The ring's wire bytes, as `ArenaRingEntry` holds them. */
export interface ArenaRingWire {
  readonly phase: number;
  readonly round: number;
  readonly challenger: ArenaSlotWire;
  readonly opponent: ArenaSlotWire;
  readonly secondsLeft: number;
  readonly reason: number;
  readonly winner: number;
  readonly champion: string;
  readonly seated: number;
}

export interface ArenaSlotWire {
  readonly kind: number;
  readonly gameId: string;
  readonly hp: number;
  readonly swings: number;
  readonly hits: number;
  readonly guarding: number;
  readonly blocks: number;
}

function slotToWire(slot: ArenaSlot): ArenaSlotWire {
  return {
    kind: ARENA_SLOT_KINDS.indexOf(slot.kind),
    gameId: slot.gameId ?? '',
    hp: slot.hp,
    swings: slot.swings,
    hits: slot.hits,
    guarding: slot.guarding ? 1 : 0,
    blocks: slot.blocks,
  };
}

/** A snapshot as the wire carries it: codes for names, `''` for no presence id, 0 for none. */
export function arenaRingToWire(ring: ArenaRingSnapshot): ArenaRingWire {
  return {
    phase: ARENA_PHASES.indexOf(ring.phase),
    round: ring.round,
    challenger: slotToWire(ring.challenger),
    opponent: slotToWire(ring.opponent),
    secondsLeft: ring.secondsLeft,
    reason: ring.outcome === null ? 0 : ARENA_END_REASONS.indexOf(ring.outcome.reason) + 1,
    winner: ring.outcome === null || ring.outcome.winner === null ? 0 : ARENA_SIDES.indexOf(ring.outcome.winner) + 1,
    champion: ring.champion ?? '',
    seated: ring.seated ? 1 : 0,
  };
}

function writeSlot(entry: ArenaSlotEntry, next: ArenaSlotWire, last: ArenaSlotWire | null): void {
  if (last === null || last.kind !== next.kind) entry.kind = next.kind;
  if (last === null || last.gameId !== next.gameId) entry.gameId = next.gameId;
  if (last === null || last.hp !== next.hp) entry.hp = next.hp;
  if (last === null || last.swings !== next.swings) entry.swings = next.swings;
  if (last === null || last.hits !== next.hits) entry.hits = next.hits;
  if (last === null || last.guarding !== next.guarding) entry.guarding = next.guarding;
  if (last === null || last.blocks !== next.blocks) entry.blocks = next.blocks;
}

export class LobbyArena {
  readonly #mirror: ArenaRingEntry;
  readonly #authority: ArenaAuthority;
  /** What the mirror holds now, so nothing is ever read back out of the schema. */
  #written: ArenaRingWire | null = null;

  constructor(mirror: ArenaRingEntry, options: ArenaAuthorityOptions = {}, now = 0) {
    this.#mirror = mirror;
    this.#authority = createArenaAuthority(options);
    this.#copy(now);
  }

  /** Whether a deadline is pending: the room keeps its arena clock running while true. */
  get active(): boolean {
    return this.#authority.active;
  }

  snapshot(now: number): ArenaRingSnapshot {
    return this.#authority.snapshot(now);
  }

  /** Whether `key`'s session is the challenger still in the ring, and so walks its tiles. */
  holdsRing(key: string): boolean {
    return this.#authority.holdsRing(key);
  }

  claim(claimant: ArenaClaimant, now: number): ArenaClaimOutcome {
    const outcome = this.#authority.claim(claimant, now);
    this.#copy(now);
    return outcome;
  }

  /** D-128: whether `key`'s session is on the throne, and so walks the box's tile. */
  holdsSeat(key: string): boolean {
    return this.#authority.holdsSeat(key);
  }

  attack(key: string, now: number, locate: ArenaLocate): ArenaAttackOutcome {
    const outcome = this.#authority.attack(key, now, locate);
    this.#copy(now);
    return outcome;
  }

  /** D-128: raise or lower a session's guard. */
  block(key: string, down: boolean, now: number): ArenaBlockOutcome {
    const outcome = this.#authority.block(key, down, now);
    this.#copy(now);
    return outcome;
  }

  /** D-128: the champion presses E at the emperor's box. */
  seat(claimant: ArenaClaimant, now: number): ArenaSeatOutcome {
    const outcome = this.#authority.seat(claimant, now);
    this.#copy(now);
    return outcome;
  }

  /** D-128: the session walked off the throne's tile. */
  unseat(key: string, now: number): boolean {
    const changed = this.#authority.unseat(key);
    if (changed) this.#copy(now);
    return changed;
  }

  leave(key: string, now: number): ArenaLeaveOutcome {
    const outcome = this.#authority.leave(key, now);
    this.#copy(now);
    return outcome;
  }

  gone(key: string, reason: ArenaGoneReason, now: number): boolean {
    const changed = this.#authority.gone(key, reason, now);
    this.#copy(now);
    return changed;
  }

  /** Every deadline up to `now`, and the placements the room must make. */
  advance(now: number): ArenaEvent[] {
    const events = this.#authority.advance(now);
    this.#copy(now);
    return events;
  }

  forget(key: string): void {
    this.#authority.forget(key);
  }

  /** Rewrite the mirror where the authority differs from it. */
  #copy(now: number): void {
    const next = arenaRingToWire(this.#authority.snapshot(now));
    const last = this.#written;
    const entry = this.#mirror;
    if (last === null || last.phase !== next.phase) entry.phase = next.phase;
    if (last === null || last.round !== next.round) entry.round = next.round;
    if (last === null || last.secondsLeft !== next.secondsLeft) entry.secondsLeft = next.secondsLeft;
    if (last === null || last.reason !== next.reason) entry.reason = next.reason;
    if (last === null || last.winner !== next.winner) entry.winner = next.winner;
    if (last === null || last.champion !== next.champion) entry.champion = next.champion;
    if (last === null || last.seated !== next.seated) entry.seated = next.seated;
    writeSlot(entry.challenger as ArenaSlotEntry, next.challenger, last?.challenger ?? null);
    writeSlot(entry.opponent as ArenaSlotEntry, next.opponent, last?.opponent ?? null);
    this.#written = next;
  }
}
