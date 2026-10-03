/**
 * The arena ring's rules (D-114). Pure, synchronous, transport-free.
 *
 * One authority object owns the ring: its phase, the round, the two slots
 * and the deadline. The lobby room runs one instance per room and the Shell
 * can run one locally for solo play, so both paths apply the same rules.
 * Nothing here imports Colyseus, touches the network or reads a clock: time
 * comes in as arguments, and positions come in from the caller, who holds
 * them (the room's own held positions on the server).
 *
 * ## Phases
 *
 * ```
 * idle ──claim──► countdown (3 s) ──► fighting (≤ 90 s) ──► ended ──► idle
 * ```
 *
 * - **Claim.** Only while `idle`, only from a session live in the arena,
 *   only from the gate approach (`ARENA_GATE_APPROACH`, with
 *   `ARENA_APPROACH_SLACK_PX` of slack), and only past the intent floor. The
 *   round goes up by one (mod 65536), the challenger slot takes the claimant
 *   and the opponent slot the dummy, and a `place` event moves the fighter to
 *   `ARENA_RING_SPAWN`. Any other phase answers `busy`: the first claim the
 *   room handles wins, and nothing is queued.
 * - **Fighting** ends on a knockout (the opponent at 0 HP; the challenger
 *   wins), on the deadline (a timeout; nobody wins against the dummy), on a
 *   leave intent, a suspend or an area change (`left`), or on a disconnect
 *   (`disconnect`). A countdown can end by `left` or `disconnect` too.
 * - **Ended** lasts `ARENA_RESULT_MS` after a knockout or a timeout and
 *   `ARENA_ABORT_RESULT_MS` after a walk-out. At its close a `place` event
 *   returns the fighter to `ARENA_RING_RETURN`, unless they already left, and
 *   both slots empty.
 *
 * ## Attacks
 *
 * An attack is an intent with no fields. The floor (`ARENA_ATTACK_MIN_INTERVAL_MS`)
 * is consumed before any rule runs, so a refused attack still costs its
 * sender a full interval. Only the challenger's slot attacks, only while
 * `fighting`; each such attack bumps that slot's `swings` (mod 256), hit or
 * miss. It hits when the target's centre is within `ARENA_REACH_PX` of the
 * attacker and either within `ARENA_POINT_BLANK_PX` or inside the ±75° arc
 * of the attacker's facing (`cos ≥ ARENA_HIT_MIN_COS`). A hit takes a flat
 * `ARENA_HIT_DAMAGE` and bumps the target's `hits` (mod 256).
 *
 * ## The block (D-128)
 *
 * `block(key, down, now)` raises or lowers a slot's guard. A raise is only
 * accepted while `fighting` and costs a `ARENA_BLOCK_MIN_INTERVAL_MS` floor;
 * a drop is never throttled, because it only ever de-escalates and a dropped
 * stop would leave a fighter blocking for ever. While `guarding` the slot
 * cannot swing (`'guarding'`), and for `ARENA_GUARD_RECOVERY_MS` after the
 * guard comes down it still cannot. A swing that reaches a guarding target
 * is `'blocked'`: no damage, no `hits`, and the target's `blocks` goes up, so
 * the view sparks it without being told what the damage was. The dummy never
 * swings, so only a future PvP opponent can be blocked — but the rule is
 * written against the slots, not against the dummy, so PvP needs no change.
 *
 * ## The champion and the emperor's box (D-128)
 *
 * A knockout crowns the winning slot's player as the `champion`, and only
 * the champion may use the emperor's box. `seat` takes or leaves the throne
 * from the box's approach; a new champion deposes the old one at the moment
 * they win, putting them down on `ARENA_BOX_STAND` beside the box. Champion
 * status is held by connection key, reaches the wire as the ephemeral
 * presence id only, and is dropped the moment that session leaves the arena
 * or disconnects (`gone`).
 *
 * ## The opponent slot is polymorphic
 *
 * Both slots are `empty | player | dummy`. An attack resolves "attacker's
 * slot → the other slot"; the target stands at the dummy tile's centre for a
 * dummy, or wherever the caller says a player stands. PvP only adds a phase
 * that fills the opponent with a player; the slot shapes do not change.
 *
 * ## Anonymity
 *
 * A slot names a player only by the ephemeral presence id peers already
 * hold. The connection `key` exists so the authority can tell sessions apart;
 * it never appears in a snapshot.
 *
 * It imports `@strkworld/shared` and nothing else, so the browser can run it
 * for solo play (`@strkworld/lobby/arena`) without any server code.
 */

import {
  ARENA_ABORT_RESULT_MS,
  ARENA_ATTACK_MIN_INTERVAL_MS,
  ARENA_BLOCK_MIN_INTERVAL_MS,
  ARENA_BOX,
  ARENA_BOX_APPROACH,
  ARENA_BOX_SEAT_FACING,
  ARENA_BOX_STAND,
  ARENA_BOX_STAND_FACING,
  ARENA_COUNTDOWN_MS,
  ARENA_DUMMY_TILE,
  ARENA_GUARD_RECOVERY_MS,
  ARENA_FIGHT_MS,
  ARENA_GATE_APPROACH,
  ARENA_HIT_DAMAGE,
  ARENA_HIT_MIN_COS,
  ARENA_INTENT_MIN_INTERVAL_MS,
  ARENA_MAX_HP,
  ARENA_ORIGIN_PX,
  ARENA_POINT_BLANK_PX,
  ARENA_REACH_PX,
  ARENA_RESULT_MS,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  ARENA_RING_WALKABLE,
  ARENA_TILE_SIZE,
  arenaTileCentre,
  type ArenaEndReason,
  type ArenaPhase,
  type ArenaRingSnapshot,
  type ArenaSide,
  type ArenaSlot,
  type ArenaSlotKind,
  type ArenaTile,
  type Facing,
  type GameId,
  type Position,
  type PresenceArea,
  type TileRect,
} from '@strkworld/shared';

/** How far outside the gate approach a claim may stand, in World pixels: a quarter tile. */
export const ARENA_APPROACH_SLACK_PX = 8;

/** The challenger's extra walkable tiles: the ring interior minus the dummy. */
export const ARENA_CHALLENGER_WALKABLE: readonly TileRect[] = ARENA_RING_WALKABLE;

/**
 * D-128: the seated champion's one extra walkable tile, the emperor's box
 * itself. The podium it stands in is not floor for anyone else, so only the
 * session the authority says is on the throne may hold that position — and
 * stepping off it is a plain move onto the sand, which lowers the seat.
 */
export const ARENA_THRONE_WALKABLE: readonly TileRect[] = Object.freeze([
  Object.freeze({ x: ARENA_BOX.x, y: ARENA_BOX.y, width: 1, height: 1 }),
]);

/** Where someone stands and faces, as the caller holds it. */
export interface ArenaStance {
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
}

/** Someone claiming the ring: their connection key, presence id, area and held position. */
export interface ArenaClaimant {
  readonly key: string;
  readonly gameId: GameId;
  /** The presence area the session is live in; null while suspended. */
  readonly area: PresenceArea | null;
  readonly x: number;
  readonly y: number;
}

export type ArenaClaimOutcome =
  /** The ring is the claimant's; a `place` event moves them in. */
  | 'applied'
  /** The ring is not idle. Nothing changed. */
  | 'busy'
  /** Not live in the arena, or not on the gate approach. Nothing changed. */
  | 'rejected'
  /** Inside the session's intent floor. Nothing changed. */
  | 'throttled';

export type ArenaAttackOutcome =
  /** On time, during the fight: the swing landed. */
  | 'hit'
  /** D-128: the swing landed on a guarding target. No damage; its `blocks` went up. */
  | 'blocked'
  /** On time, during the fight: the swing missed (still counted as a swing). */
  | 'miss'
  /** On time, but the ring is not fighting. Nothing changed. */
  | 'rejected'
  /** D-128: the sender holds a block, or is still recovering from one. Nothing changed. */
  | 'guarding'
  /** Inside the session's attack floor. Nothing changed. */
  | 'throttled'
  /** The session holds no slot. Nothing changed (the floor is still spent). */
  | 'absent';

/** D-128: what a block start or stop did. */
export type ArenaBlockOutcome =
  /** The guard went up (a start) or came down (a stop). */
  | 'applied'
  /** The guard was already in that state, or the ring is not fighting. Nothing changed. */
  | 'rejected'
  /** A start inside the session's block floor. Nothing changed. */
  | 'throttled'
  /** The session holds no slot. */
  | 'absent';

/** D-128: what a press of E at the emperor's box did. */
export type ArenaSeatOutcome =
  /** The champion took the throne, or stood up from it. */
  | 'applied'
  /** Not the champion, not live in the arena, not on the box's approach, or fighting. */
  | 'rejected'
  /** Inside the session's intent floor (shared with claim and leave). */
  | 'throttled';

export type ArenaLeaveOutcome =
  /** The fight ended as `left`. */
  | 'applied'
  /** The sender's fight is already over. Nothing changed. */
  | 'rejected'
  /** Inside the session's intent floor (shared with claim). */
  | 'throttled'
  /** The session holds no slot. */
  | 'absent';

/** Why a fighter stopped being reachable: a suspend or area change, or a disconnect. */
export type ArenaGoneReason = 'left' | 'disconnect';

/**
 * Something the caller must do: stand `key`'s session on `tile`, facing
 * `facing` (arena-local tiles; the centre in World pixels via
 * `arenaTileCentre`). A claim moves the fighter in; the close moves them out.
 */
export interface ArenaPlaceEvent {
  readonly kind: 'place';
  readonly key: string;
  readonly tile: ArenaTile;
  readonly facing: Facing;
}

export type ArenaEvent = ArenaPlaceEvent;

export interface ArenaAuthorityOptions {
  /** The round the next claim increments from. A test seam (the wrap at 65536). */
  readonly round?: number;
  /**
   * D-128: a second player takes the opponent slot on every claim, instead
   * of the dummy. Nothing on the wire can set it and the lobby never does:
   * it is the seam that exercises the polymorphic slot — a target that
   * swings back, blocks and can win — which is the shape PvP will use.
   */
  readonly opponent?: { readonly key: string; readonly gameId: GameId };
}

/** Where a slot's player stands, looked up by connection key; null when they cannot be found. */
export type ArenaLocate = (key: string) => ArenaStance | null;

export interface ArenaAuthority {
  /** The ring as the wire carries it, with `secondsLeft` at `now`. Frozen. */
  snapshot(now: number): ArenaRingSnapshot;
  readonly phase: ArenaPhase;
  /** Whether `key`'s session is the challenger still in the ring (walks the ring's tiles). */
  holdsRing(key: string): boolean;
  /** D-128: whether `key`'s session is on the throne (and so walks the box's tile). */
  holdsSeat(key: string): boolean;
  /** Whether a deadline is pending: the caller keeps a clock running while true. */
  readonly active: boolean;
  claim(claimant: ArenaClaimant, now: number): ArenaClaimOutcome;
  attack(key: string, now: number, locate: ArenaLocate): ArenaAttackOutcome;
  /** D-128: raise (`down` true) or lower this session's guard. */
  block(key: string, down: boolean, now: number): ArenaBlockOutcome;
  /** D-128: the champion presses E at the emperor's box: sit, or stand up again. */
  seat(claimant: ArenaClaimant, now: number): ArenaSeatOutcome;
  /** D-128: `key`'s session stepped off the throne's tile, so it is no longer seated. */
  unseat(key: string): boolean;
  leave(key: string, now: number): ArenaLeaveOutcome;
  /** `key`'s session suspended, changed area (`left`) or disconnected. Returns whether the ring changed. */
  gone(key: string, reason: ArenaGoneReason, now: number): boolean;
  /** Run every deadline up to `now`, and return what the caller must do, in order. */
  advance(now: number): ArenaEvent[];
  /** Forget a connection's floors: it left the room. */
  forget(key: string): void;
}

interface MutableSlot {
  kind: ArenaSlotKind;
  /** The connection key of a player slot; never on the wire. */
  key: string | null;
  gameId: GameId | null;
  hp: number;
  swings: number;
  hits: number;
  /** D-128: this slot holds a block. */
  guarding: boolean;
  blocks: number;
  /** D-128: when the slot's last guard came down; its swings wait out the recovery. */
  guardDroppedAt: number;
}

const FACING_VECTORS: Readonly<Record<Facing, Readonly<{ x: number; y: number }>>> = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  down: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
  right: Object.freeze({ x: 1, y: 0 }),
});

const SECONDS_CAP: Readonly<Record<ArenaPhase, number>> = Object.freeze({
  idle: 0,
  countdown: Math.ceil(ARENA_COUNTDOWN_MS / 1000),
  fighting: Math.ceil(ARENA_FIGHT_MS / 1000),
  ended: 0,
});

/** A tile rectangle in World pixels, with `ARENA_APPROACH_SLACK_PX` of slack all round. */
function approachBox(rect: TileRect): Readonly<{ minX: number; maxX: number; minY: number; maxY: number }> {
  return Object.freeze({
    minX: ARENA_ORIGIN_PX + rect.x * ARENA_TILE_SIZE - ARENA_APPROACH_SLACK_PX,
    maxX: ARENA_ORIGIN_PX + (rect.x + rect.width) * ARENA_TILE_SIZE + ARENA_APPROACH_SLACK_PX,
    minY: ARENA_ORIGIN_PX + rect.y * ARENA_TILE_SIZE - ARENA_APPROACH_SLACK_PX,
    maxY: ARENA_ORIGIN_PX + (rect.y + rect.height) * ARENA_TILE_SIZE + ARENA_APPROACH_SLACK_PX,
  });
}

/** The gate approach in World pixels, slack included. */
const APPROACH = approachBox(ARENA_GATE_APPROACH);
/** D-128: the emperor's box's approach, the same way. */
const BOX_APPROACH = approachBox(ARENA_BOX_APPROACH);

function inApproach(box: Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>, x: number, y: number): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= box.minX &&
    x <= box.maxX &&
    y >= box.minY &&
    y <= box.maxY
  );
}

/** Whether a World pixel position is on the gate approach, slack included. */
export function isOnArenaApproach(x: number, y: number): boolean {
  return inApproach(APPROACH, x, y);
}

/** D-128: whether a World pixel position is on the emperor's box's own tile (the throne). */
export function isOnArenaThrone(x: number, y: number): boolean {
  const seat = arenaTileCentre(ARENA_BOX);
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x - seat.x) <= ARENA_TILE_SIZE / 2 + ARENA_APPROACH_SLACK_PX &&
    Math.abs(y - seat.y) <= ARENA_TILE_SIZE / 2 + ARENA_APPROACH_SLACK_PX
  );
}

/**
 * D-128: whether a World pixel position is at the emperor's box — the sand
 * in front of it, or the box's own tile (where the champion sits).
 */
export function isAtArenaBox(x: number, y: number): boolean {
  return inApproach(BOX_APPROACH, x, y) || isOnArenaThrone(x, y);
}

/**
 * Whether a swing from `attacker` reaches a target centred at `target`:
 * within `ARENA_REACH_PX`, and point-blank or inside the facing's arc.
 */
export function isArenaHit(attacker: ArenaStance, target: Position): boolean {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance > ARENA_REACH_PX) return false;
  if (distance <= ARENA_POINT_BLANK_PX) return true;
  const facing = FACING_VECTORS[attacker.facing] ?? FACING_VECTORS.down;
  return (dx * facing.x + dy * facing.y) / distance >= ARENA_HIT_MIN_COS;
}

function emptySlot(): MutableSlot {
  return {
    kind: 'empty',
    key: null,
    gameId: null,
    hp: 0,
    swings: 0,
    hits: 0,
    guarding: false,
    blocks: 0,
    guardDroppedAt: Number.NEGATIVE_INFINITY,
  };
}

function frozenSlot(slot: MutableSlot): ArenaSlot {
  return Object.freeze({
    kind: slot.kind,
    gameId: slot.kind === 'player' ? slot.gameId : null,
    hp: slot.hp,
    swings: slot.swings,
    hits: slot.hits,
    guarding: slot.kind === 'player' && slot.guarding,
    blocks: slot.blocks,
  });
}

function isTime(now: number): boolean {
  return Number.isFinite(now) && now >= 0;
}

/**
 * A strict per-key floor: accepted only a full interval after the last
 * accepted one, and dropped (never queued) otherwise. The same rule as the
 * lobby's `UpdateThrottle` with no burst, kept here so this module needs
 * nothing but the shared seam.
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

export function createArenaAuthority(options: ArenaAuthorityOptions = {}): ArenaAuthority {
  let phase: ArenaPhase = 'idle';
  let round = Number.isInteger(options.round) && (options.round as number) >= 0 ? (options.round as number) & 0xffff : 0;
  let challenger = emptySlot();
  let opponent = emptySlot();
  /** When the current phase ends; null while idle. */
  let deadline: number | null = null;
  let outcome: { reason: ArenaEndReason; winner: ArenaSide | null } | null = null;
  /** The challenger's key while they are still in the ring to be returned; null once they left. */
  let returnKey: string | null = null;
  /**
   * D-128: the player who most recently won a fight here, while they are
   * still in the arena, and whether they are on the throne. The key never
   * leaves the server; only the presence id reaches the wire.
   */
  let champion: { key: string; gameId: GameId } | null = null;
  let seated = false;
  const intentFloor = new Floor(ARENA_INTENT_MIN_INTERVAL_MS);
  const attackFloor = new Floor(ARENA_ATTACK_MIN_INTERVAL_MS);
  const blockFloor = new Floor(ARENA_BLOCK_MIN_INTERVAL_MS);
  const pending: ArenaEvent[] = [];

  /** Put whoever is on the throne back on the sand beside the box, and empty the seat. */
  function vacateSeat(): void {
    if (!seated) return;
    seated = false;
    if (champion === null) return;
    pending.push(Object.freeze({
      kind: 'place',
      key: champion.key,
      tile: ARENA_BOX_STAND,
      facing: ARENA_BOX_STAND_FACING,
    }));
  }

  /**
   * D-128: crown the winner of a fight. The outgoing champion loses the box
   * at once: if they were sitting in it they are put down beside it, which is
   * the lead's rule — "if someone else wins the last fight you get kicked out
   * of the seat".
   */
  function crown(side: ArenaSide | null): void {
    const slot = side === 'challenger' ? challenger : side === 'opponent' ? opponent : null;
    if (slot === null || slot.kind !== 'player' || slot.key === null || slot.gameId === null) return;
    if (champion !== null && champion.key === slot.key) {
      // The same player won again: they keep the box, and the seat if they are in it.
      champion = { key: slot.key, gameId: slot.gameId };
      return;
    }
    vacateSeat();
    champion = { key: slot.key, gameId: slot.gameId };
  }

  function end(reason: ArenaEndReason, winner: ArenaSide | null, at: number): void {
    phase = 'ended';
    outcome = { reason, winner };
    deadline = at + (reason === 'knockout' || reason === 'timeout' ? ARENA_RESULT_MS : ARENA_ABORT_RESULT_MS);
    // Only a knockout crowns: a timeout or a walk-out leaves the box as it was.
    if (reason === 'knockout') crown(winner);
    challenger.guarding = false;
    opponent.guarding = false;
  }

  function catchUp(now: number): void {
    if (!isTime(now)) return;
    // Each transition starts from the deadline it replaces, so a late call
    // lands where a punctual one would have, and a long gap runs straight
    // through to idle.
    while (deadline !== null && now >= deadline) {
      const at = deadline;
      if (phase === 'countdown') {
        phase = 'fighting';
        deadline = at + ARENA_FIGHT_MS;
      } else if (phase === 'fighting') {
        end('timeout', null, at);
      } else {
        if (returnKey !== null) {
          pending.push(Object.freeze({
            kind: 'place',
            key: returnKey,
            tile: ARENA_RING_RETURN,
            facing: ARENA_RING_RETURN_FACING,
          }));
        }
        phase = 'idle';
        deadline = null;
        outcome = null;
        returnKey = null;
        challenger = emptySlot();
        opponent = emptySlot();
      }
    }
  }

  /** The slot `key` plays in, and the other one; null when it plays in neither. */
  function slotsOf(key: string): { own: MutableSlot; other: MutableSlot; side: ArenaSide } | null {
    if (phase === 'idle') return null;
    if (challenger.kind === 'player' && challenger.key === key) return { own: challenger, other: opponent, side: 'challenger' };
    if (opponent.kind === 'player' && opponent.key === key) return { own: opponent, other: challenger, side: 'opponent' };
    return null;
  }

  function otherSide(side: ArenaSide): ArenaSide {
    return side === 'challenger' ? 'opponent' : 'challenger';
  }

  return {
    get phase() {
      return phase;
    },

    get active() {
      return deadline !== null;
    },

    snapshot(now: number): ArenaRingSnapshot {
      let secondsLeft = 0;
      if (deadline !== null && (phase === 'countdown' || phase === 'fighting') && isTime(now)) {
        secondsLeft = Math.min(SECONDS_CAP[phase], Math.max(0, Math.ceil((deadline - now) / 1000)));
      }
      return Object.freeze({
        phase,
        round,
        challenger: frozenSlot(challenger),
        opponent: frozenSlot(opponent),
        secondsLeft,
        outcome: phase === 'ended' && outcome !== null ? Object.freeze({ ...outcome }) : null,
        champion: champion?.gameId ?? null,
        seated: champion !== null && seated,
      });
    },

    holdsRing(key: string): boolean {
      return phase !== 'idle' && returnKey !== null && returnKey === key;
    },

    holdsSeat(key: string): boolean {
      return seated && champion !== null && champion.key === key;
    },

    claim(claimant: ArenaClaimant, now: number): ArenaClaimOutcome {
      catchUp(now);
      if (!intentFloor.accept(claimant.key, now)) return 'throttled';
      if (claimant.area !== 'arena') return 'rejected';
      if (phase !== 'idle') return 'busy';
      if (!isOnArenaApproach(claimant.x, claimant.y)) return 'rejected';
      round = (round + 1) & 0xffff;
      // A champion who walks into the ring leaves the throne empty behind them.
      if (seated && champion !== null && champion.key === claimant.key) seated = false;
      challenger = { ...emptySlot(), kind: 'player', key: claimant.key, gameId: claimant.gameId, hp: ARENA_MAX_HP };
      const second = options.opponent;
      opponent = second === undefined
        ? { ...emptySlot(), kind: 'dummy', hp: ARENA_MAX_HP }
        : { ...emptySlot(), kind: 'player', key: second.key, gameId: second.gameId, hp: ARENA_MAX_HP };
      phase = 'countdown';
      deadline = now + ARENA_COUNTDOWN_MS;
      outcome = null;
      returnKey = claimant.key;
      pending.push(Object.freeze({
        kind: 'place',
        key: claimant.key,
        tile: ARENA_RING_SPAWN,
        facing: ARENA_RING_SPAWN_FACING,
      }));
      return 'applied';
    },

    attack(key: string, now: number, locate: ArenaLocate): ArenaAttackOutcome {
      catchUp(now);
      if (!attackFloor.accept(key, now)) return 'throttled';
      const slots = slotsOf(key);
      if (slots === null) return 'absent';
      if (phase !== 'fighting') return 'rejected';
      // D-128: a raised guard cannot swing, and neither can one that has just
      // come down, until the recovery is out. The swing counter does not move.
      if (slots.own.guarding) return 'guarding';
      if (isTime(now) && now - slots.own.guardDroppedAt < ARENA_GUARD_RECOVERY_MS) return 'guarding';
      slots.own.swings = (slots.own.swings + 1) & 0xff;
      const attacker = locate(key);
      let target: Position | null = null;
      if (slots.other.kind === 'dummy') target = arenaTileCentre(ARENA_DUMMY_TILE);
      else if (slots.other.kind === 'player' && slots.other.key !== null) target = locate(slots.other.key);
      if (attacker === null || target === null || !isArenaHit(attacker, target)) return 'miss';
      // D-128: a blocked hit lands but does nothing. Its own counter drives
      // the spark, so the view can tell it from a hit that took HP.
      if (slots.other.guarding) {
        slots.other.blocks = (slots.other.blocks + 1) & 0xff;
        return 'blocked';
      }
      slots.other.hp = Math.max(0, slots.other.hp - ARENA_HIT_DAMAGE);
      slots.other.hits = (slots.other.hits + 1) & 0xff;
      if (slots.other.hp === 0) end('knockout', slots.side, now);
      return 'hit';
    },

    block(key: string, down: boolean, now: number): ArenaBlockOutcome {
      catchUp(now);
      const slots = slotsOf(key);
      if (slots === null) {
        // A start still spends the floor, as a refused attack does.
        if (down) blockFloor.accept(key, now);
        return 'absent';
      }
      if (down) {
        if (!blockFloor.accept(key, now)) return 'throttled';
        if (phase !== 'fighting' || slots.own.guarding) return 'rejected';
        slots.own.guarding = true;
        return 'applied';
      }
      // A stop is never throttled: it only ever lowers a guard.
      if (!slots.own.guarding) return 'rejected';
      slots.own.guarding = false;
      slots.own.guardDroppedAt = isTime(now) ? now : 0;
      return 'applied';
    },

    seat(claimant: ArenaClaimant, now: number): ArenaSeatOutcome {
      catchUp(now);
      if (!intentFloor.accept(claimant.key, now)) return 'throttled';
      if (claimant.area !== 'arena') return 'rejected';
      if (champion === null || champion.key !== claimant.key) return 'rejected';
      // A fighter is in the ring, not in the stands.
      if (slotsOf(claimant.key) !== null) return 'rejected';
      if (!isAtArenaBox(claimant.x, claimant.y)) return 'rejected';
      if (seated) {
        vacateSeat();
        return 'applied';
      }
      seated = true;
      pending.push(Object.freeze({
        kind: 'place',
        key: claimant.key,
        tile: ARENA_BOX,
        facing: ARENA_BOX_SEAT_FACING,
      }));
      return 'applied';
    },

    unseat(key: string): boolean {
      if (!seated || champion === null || champion.key !== key) return false;
      // They walked off it themselves, so nobody needs putting anywhere.
      seated = false;
      return true;
    },

    leave(key: string, now: number): ArenaLeaveOutcome {
      catchUp(now);
      if (!intentFloor.accept(key, now)) return 'throttled';
      const slots = slotsOf(key);
      if (slots === null) return 'absent';
      if (phase !== 'countdown' && phase !== 'fighting') return 'rejected';
      // A walk-out against the dummy has no winner; against a player, they win.
      end('left', slots.other.kind === 'player' ? otherSide(slots.side) : null, now);
      return 'applied';
    },

    gone(key: string, reason: ArenaGoneReason, now: number): boolean {
      catchUp(now);
      if (reason === 'disconnect') {
        intentFloor.forget(key);
        attackFloor.forget(key);
        blockFloor.forget(key);
      }
      // D-128: the champion is a fact about someone in the arena. They left
      // or dropped, so there is no champion and the box is nobody's.
      let changed = false;
      if (champion !== null && champion.key === key) {
        champion = null;
        seated = false;
        changed = true;
      }
      const slots = slotsOf(key);
      if (slots === null) return changed;
      slots.own.guarding = false;
      // They are no longer in the arena, so nobody is returned at the close.
      if (returnKey === key) returnKey = null;
      if (phase === 'countdown' || phase === 'fighting') {
        end(reason, slots.other.kind === 'player' ? otherSide(slots.side) : null, isTime(now) ? now : 0);
      }
      return true;
    },

    advance(now: number): ArenaEvent[] {
      catchUp(now);
      return pending.splice(0, pending.length);
    },

    forget(key: string): void {
      intentFloor.forget(key);
      attackFloor.forget(key);
      blockFloor.forget(key);
    },
  };
}
