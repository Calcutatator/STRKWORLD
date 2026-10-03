/**
 * The roof swing's rules (D-133). Pure, synchronous, transport-free.
 *
 * One authority object owns the swing: its phase, the round, the rider and
 * the deadline. The lobby room runs one instance per room and the Shell can
 * run one locally for solo play, so both paths apply the same rules. Nothing
 * here imports Colyseus, touches the network or reads a clock: time comes in
 * as arguments, and positions come in from the caller, who holds them.
 *
 * ## Phases
 *
 * ```
 * idle ──claim──► riding (20 s) ──► cooldown (1 s) ──► idle
 * ```
 *
 * - **Claim.** Only while `idle`, only from a session live on the roof, only
 *   from the deck tiles in front of the swing (`SWING_APPROACH`, with
 *   `SWING_APPROACH_SLACK_PX` of slack), and only past the intent floor. The
 *   round goes up by one (mod 65536), the rider slot takes the claimant, and
 *   a `place` event moves them onto the seat. Any other phase answers `busy`:
 *   the first claim the room handles wins, and nothing is queued.
 * - **Riding** ends on the deadline (`timeout`), on a leave intent, a
 *   suspend or a change of area (`left`), or on a disconnect (`disconnect`).
 *   Every ending starts the cooldown; at its close a `place` event puts the
 *   rider back on the step-off tile, unless they have already gone.
 *
 * ## Anonymity
 *
 * The rider is named only by the ephemeral presence id roof peers already
 * hold. The connection `key` exists so the authority can tell sessions apart;
 * it never appears in a snapshot.
 *
 * It imports `@strkworld/shared` and nothing else, so the browser can run it
 * for solo play (`@strkworld/lobby/swing`) without any server code.
 */

import {
  SWING_COOLDOWN_MS,
  SWING_INTENT_MIN_INTERVAL_MS,
  SWING_RIDE_MS,
  SWING_RIDER_WALKABLE,
  SWING_SEAT_FACING,
  SWING_SEAT_TILE,
  SWING_STEP_OFF_FACING,
  SWING_STEP_OFF_TILE,
  isOnSwingApproach,
  type Facing,
  type GameId,
  type PresenceArea,
  type RoofSwingSnapshot,
  type RoofTile,
  type SwingEndReason,
  type SwingPhase,
  type TileRect,
} from '@strkworld/shared';

/** The rider's extra walkable tiles: the seat's, and nobody else's. */
export const SWING_RIDER_TILES: readonly TileRect[] = SWING_RIDER_WALKABLE;

/** Someone claiming the swing: their connection key, presence id, area and held position. */
export interface SwingClaimant {
  readonly key: string;
  readonly gameId: GameId;
  /** The presence area the session is live in; null while suspended. */
  readonly area: PresenceArea | null;
  readonly x: number;
  readonly y: number;
}

export type SwingClaimOutcome =
  /** The swing is the claimant's; a `place` event sits them on it. */
  | 'applied'
  /** Someone is riding, or it is still cooling down. Nothing changed. */
  | 'busy'
  /** Not live on the roof, or not on the approach. Nothing changed. */
  | 'rejected'
  /** Inside the session's intent floor. Nothing changed. */
  | 'throttled';

export type SwingLeaveOutcome =
  /** The ride ended as `left`. */
  | 'applied'
  /** The sender is not riding. Nothing changed. */
  | 'absent'
  /** Inside the session's intent floor (shared with claim). */
  | 'throttled';

/** Why a rider stopped being reachable: a suspend or area change, or a disconnect. */
export type SwingGoneReason = 'left' | 'disconnect';

/**
 * Something the caller must do: stand `key`'s session on `tile`, facing
 * `facing` (roof-local tiles; the centre in World pixels via
 * `roofTileCentre`). A claim moves the rider onto the seat; the cooldown's
 * close moves them off.
 */
export interface SwingPlaceEvent {
  readonly kind: 'place';
  readonly key: string;
  readonly tile: RoofTile;
  readonly facing: Facing;
}

export type SwingEvent = SwingPlaceEvent;

export interface SwingAuthorityOptions {
  /** The round the next claim increments from. A test seam (the wrap at 65536). */
  readonly round?: number;
}

export interface SwingAuthority {
  /** The swing as the wire carries it, with `secondsLeft` at `now`. Frozen. */
  snapshot(now: number): RoofSwingSnapshot;
  readonly phase: SwingPhase;
  /** Whether `key`'s session is the rider still on the seat (and so stands on its tile). */
  holdsSeat(key: string): boolean;
  /** Whether a deadline is pending: the caller keeps a clock running while true. */
  readonly active: boolean;
  claim(claimant: SwingClaimant, now: number): SwingClaimOutcome;
  leave(key: string, now: number): SwingLeaveOutcome;
  /** `key`'s session suspended, changed area (`left`) or disconnected. Returns whether the swing changed. */
  gone(key: string, reason: SwingGoneReason, now: number): boolean;
  /** Run every deadline up to `now`, and return what the caller must do, in order. */
  advance(now: number): SwingEvent[];
  /** Forget a connection's floor: it left the room. */
  forget(key: string): void;
}

const RIDE_SECONDS = Math.ceil(SWING_RIDE_MS / 1000);

function isTime(now: number): boolean {
  return Number.isFinite(now) && now >= 0;
}

/**
 * A strict per-key floor: accepted only a full interval after the last
 * accepted one, and dropped (never queued) otherwise. The same rule as the
 * arena's, kept here so this module needs nothing but the shared seam.
 */
class Floor {
  readonly #intervalMs: number;
  readonly #due = new Map<string, number>();

  constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  accept(key: string, now: number): boolean {
    if (!isTime(now)) return false;
    const due = this.#due.get(key);
    if (due !== undefined && now < due) return false;
    this.#due.set(key, now + this.#intervalMs);
    return true;
  }

  forget(key: string): void {
    this.#due.delete(key);
  }
}

export function createSwingAuthority(options: SwingAuthorityOptions = {}): SwingAuthority {
  let phase: SwingPhase = 'idle';
  let round = Number.isInteger(options.round) && (options.round as number) >= 0 ? (options.round as number) & 0xffff : 0;
  let riderKey: string | null = null;
  let riderId: GameId | null = null;
  /** When the current phase ends; null while idle. */
  let deadline: number | null = null;
  let reason: SwingEndReason | null = null;
  /** The rider's key while they are still on the roof to be put down; null once they left. */
  let returnKey: string | null = null;
  const intentFloor = new Floor(SWING_INTENT_MIN_INTERVAL_MS);
  const pending: SwingEvent[] = [];

  function end(why: SwingEndReason, at: number): void {
    phase = 'cooldown';
    reason = why;
    riderKey = null;
    riderId = null;
    deadline = at + SWING_COOLDOWN_MS;
  }

  function catchUp(now: number): void {
    if (!isTime(now)) return;
    // Each transition starts from the deadline it replaces, so a late call
    // lands where a punctual one would have, and a long gap runs straight
    // through to idle.
    while (deadline !== null && now >= deadline) {
      const at = deadline;
      if (phase === 'riding') {
        end('timeout', at);
      } else {
        if (returnKey !== null) {
          pending.push(Object.freeze({
            kind: 'place',
            key: returnKey,
            tile: SWING_STEP_OFF_TILE,
            facing: SWING_STEP_OFF_FACING,
          }));
        }
        phase = 'idle';
        deadline = null;
        reason = null;
        returnKey = null;
      }
    }
  }

  return {
    get phase() {
      return phase;
    },

    get active() {
      return deadline !== null;
    },

    snapshot(now: number): RoofSwingSnapshot {
      let secondsLeft = 0;
      if (deadline !== null && phase === 'riding' && isTime(now)) {
        secondsLeft = Math.min(RIDE_SECONDS, Math.max(0, Math.ceil((deadline - now) / 1000)));
      }
      return Object.freeze({
        phase,
        round,
        riderId: phase === 'riding' ? riderId : null,
        secondsLeft,
        reason: phase === 'cooldown' ? reason : null,
      });
    },

    holdsSeat(key: string): boolean {
      return phase === 'riding' && riderKey !== null && riderKey === key;
    },

    claim(claimant: SwingClaimant, now: number): SwingClaimOutcome {
      catchUp(now);
      if (!intentFloor.accept(claimant.key, now)) return 'throttled';
      if (claimant.area !== 'roof') return 'rejected';
      if (phase !== 'idle') return 'busy';
      if (!isOnSwingApproach(claimant.x, claimant.y)) return 'rejected';
      round = (round + 1) & 0xffff;
      phase = 'riding';
      riderKey = claimant.key;
      riderId = claimant.gameId;
      returnKey = claimant.key;
      reason = null;
      deadline = now + SWING_RIDE_MS;
      pending.push(Object.freeze({
        kind: 'place',
        key: claimant.key,
        tile: SWING_SEAT_TILE,
        facing: SWING_SEAT_FACING,
      }));
      return 'applied';
    },

    leave(key: string, now: number): SwingLeaveOutcome {
      catchUp(now);
      if (!intentFloor.accept(key, now)) return 'throttled';
      if (phase !== 'riding' || riderKey !== key) return 'absent';
      end('left', isTime(now) ? now : 0);
      return 'applied';
    },

    gone(key: string, why: SwingGoneReason, now: number): boolean {
      catchUp(now);
      if (why === 'disconnect') intentFloor.forget(key);
      let changed = false;
      // They are no longer on the roof, so nobody is put down at the close.
      if (returnKey === key) {
        returnKey = null;
        changed = true;
      }
      if (phase === 'riding' && riderKey === key) {
        end(why, isTime(now) ? now : 0);
        changed = true;
      }
      return changed;
    },

    advance(now: number): SwingEvent[] {
      catchUp(now);
      return pending.splice(0, pending.length);
    },

    forget(key: string): void {
      intentFloor.forget(key);
    },
  };
}
