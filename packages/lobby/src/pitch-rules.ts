/**
 * The gated pitch's match rules (D-135). Pure, synchronous, transport-free.
 *
 * One authority object owns the match: its phase, the round, the four slots,
 * the score it mirrors from the ball and the deadline. The lobby room runs one
 * instance per room; nothing here imports Colyseus, touches the network or
 * reads a clock — time comes in as arguments, and positions come in from the
 * caller, who holds them.
 *
 * It is the arena ring's design (D-114, arena-rules.ts) with four slots
 * instead of two and a ball instead of a swing.
 *
 * ## Phases
 *
 * ```
 * open ──4 slots taken──► countdown (3 s) ──► playing ──┬─goal─► countdown (2.5 s) ──► playing
 *   ▲                                                   └─3 goals─► ended (4.5 s) ──► open
 *   └───────────────────────── no real players left ─────────────────────────────────────┘
 * ```
 *
 * - **The gate.** `gate()` is one press of E, from a gate's approach outside
 *   the fence or from its spawn tile inside. From outside it takes a free slot
 *   — an empty one, or one a dummy holds — and stands the presser inside; from
 *   inside it gives the slot up and stands them back out. Both are held to the
 *   intent floor (`PITCH_INTENT_MIN_INTERVAL_MS`), and a refusal changes
 *   nothing: the match in state is the only answer.
 * - **The dummies.** With `dummyFill` on (the default, so one person can test
 *   a 2v2 alone) the first entrant brings three dummies in with them, which
 *   fills the four slots and starts the match at once. A later arrival takes a
 *   dummy's slot, which is why the gate reads "IN PLAY" only when all four
 *   slots hold real players.
 * - **Start.** The caller resets the ball (0–0, on the centre spot), every
 *   slot is placed on its quarter's spot (`PITCH_QUARTERS`), and the 3–2–1
 *   runs before play.
 * - **A goal** re-places every slot and runs the shorter countdown.
 *   **Full time** — a side's third goal — ends the match; at the close every
 *   real player is put back outside a gate, the ball is reset and the pitch
 *   reopens.
 * - **Leaving.** A real player who presses E at a gate, suspends, changes area
 *   or drops is replaced by a dummy so the match can carry on, whatever
 *   `dummyFill` says: a 2v2 three-handed is not a match. When the last real
 *   player goes the match is abandoned and the pitch reopens.
 *
 * ## The dummies' play
 *
 * Deterministic and server-side. Each steps on a fixed `PITCH_DUMMY_STEP_MS`
 * tick toward the point a stride behind the ball on the line from the ball to
 * the goal it is attacking, clamped to its own zone (its quarter, grown by
 * `PITCH_DUMMY_ZONE_SLACK`), at no more than `PITCH_DUMMY_SPEED`. Within kick
 * range, and with the ball between it and that goal, it kicks — no more often
 * than `PITCH_DUMMY_KICK_INTERVAL_MS`. It reads nothing but the ball and its
 * own place, so the same inputs always give the same play, and it is slower
 * than a player: beatable on purpose.
 *
 * ## Anonymity
 *
 * A slot names a player only by the ephemeral presence id street peers within
 * interest already hold. The connection `key` exists so the authority can tell
 * sessions apart; it never appears in a snapshot. No goal, kick or score is
 * counted per player.
 */

import {
  FOOTBALL_KICK_RANGE,
  FOOTBALL_SIDE_GOAL,
  FOOTBALL_WIN_SCORE,
  PITCH_COUNTDOWN_MS,
  PITCH_DUMMY_SPEED,
  PITCH_FIELD,
  PITCH_GOAL,
  PITCH_QUARTERS,
  PITCH_RESTART_MS,
  PITCH_RESULT_MS,
  PITCH_SLOTS,
  PITCH_SLOT_EXITS,
  PITCH_TILE_SIZE,
  isInsidePitchPen,
  pitchGateAt,
  pitchSlotSide,
  pitchTileCentre,
  type Facing,
  type FootballSide,
  type GameId,
  type PitchMatchPhase,
  type PitchMatchSnapshot,
  type PitchSlot,
  type PitchSlotKind,
  type Position,
  type PresenceArea,
  type TileRect,
} from '@strkworld/shared';
import type { BallState } from './football-rules.js';

/**
 * Server-side floor between two accepted gate presses from the same session,
 * in ms. The arena's intent floor, for the same reason: a gate press is a
 * deliberate key press, and a refused one still spends it so a client cannot
 * probe the gate at full rate.
 */
export const PITCH_INTENT_MIN_INTERVAL_MS = 900;

/** The floor the client wrapper holds its own gate presses to, in ms. */
export const PITCH_INTENT_CLIENT_INTERVAL_MS = 1_000;

/** One step of a dummy's play, in ms: the ball's own tick. */
export const PITCH_DUMMY_STEP_MS = 40;

/** Most steps one `advance` catches up; past that the lost time is dropped. */
export const PITCH_DUMMY_MAX_CATCH_UP = 8;

/** A dummy waits this long between kicks, in ms. */
export const PITCH_DUMMY_KICK_INTERVAL_MS = 500;

/** How far behind the ball a dummy lines itself up, in World pixels. */
export const PITCH_DUMMY_STANDOFF_PX = 0.9 * PITCH_TILE_SIZE;

/**
 * How squarely a dummy must be behind the ball to kick: the cosine between
 * the way to the ball and the way to the goal. 0.3 is about 72°, so it will
 * shove the ball goalwards from a fair angle but never kick it backwards.
 */
export const PITCH_DUMMY_KICK_MIN_COS = 0.3;

/** How far a dummy's centre stays inside the field's edges, in World pixels. */
const DUMMY_INSET_PX = 12;

const T = PITCH_TILE_SIZE;
const KICK_RANGE_PX = FOOTBALL_KICK_RANGE * T;

/** Someone pressing a gate: their connection key, presence id, area and held position. */
export interface PitchPresser {
  readonly key: string;
  readonly gameId: GameId;
  /** The presence area the session is live in; null while suspended. */
  readonly area: PresenceArea | null;
  readonly x: number;
  readonly y: number;
}

export type PitchGateOutcome =
  /** A slot is theirs; a `place` event stands them inside. */
  | 'entered'
  /** They gave their slot up; a `place` event stands them back outside. */
  | 'left'
  /** Every slot holds a real player, or a match is on its winner's banner. */
  | 'locked'
  /** Not live on the street, or not at a gate. Nothing changed. */
  | 'rejected'
  /** Inside the session's intent floor. Nothing changed. */
  | 'throttled';

/** Why a participant stopped being reachable: a suspend or area change, or a disconnect. */
export type PitchGoneReason = 'left' | 'disconnect';

/**
 * Something the caller must do: stand `key`'s session on `spot` (a street
 * tile) facing `facing`. The World pixel centre comes from `pitchTileCentre`.
 */
export interface PitchPlaceEvent {
  readonly kind: 'place';
  readonly key: string;
  readonly spot: Position;
  readonly facing: Facing;
}

/**
 * A dummy kicked: apply it to the ball authority as a kick from this World
 * pixel position, which is where the dummy stands, so the ball leaves it
 * along the line the rules already use (away from the kicker, through the
 * ball).
 */
export interface PitchKickEvent {
  readonly kind: 'kick';
  readonly x: number;
  readonly y: number;
}

export type PitchEvent = PitchPlaceEvent | PitchKickEvent;

export interface PitchAuthorityOptions {
  /**
   * D-135: three dummies drop in with the first entrant, so one person can
   * test a 2v2 alone. Default on; an operator switches it off for real 2v2
   * through the room config, and nothing on the wire can set it.
   */
  readonly dummyFill?: boolean;
  /** The round the next match increments from. A test seam (the wrap at 65536). */
  readonly round?: number;
}

export interface PitchAuthority {
  /** The match as the wire carries it, with `secondsLeft` at `now`. Frozen. */
  snapshot(now: number): PitchMatchSnapshot;
  readonly phase: PitchMatchPhase;
  /** Whether a deadline is pending: the caller keeps a clock running while true. */
  readonly active: boolean;
  /** Whether every slot holds a real player, so the gates read "IN PLAY". */
  readonly locked: boolean;
  /** How many slots hold a real player. */
  readonly players: number;
  /** Whether `key`'s session takes part, and so may stand inside the fence. */
  holdsSlot(key: string): boolean;
  /** Whether `key`'s session may kick: it takes part, and play is open or on. */
  mayKick(key: string): boolean;
  /** One press of E at a gate. */
  gate(presser: PitchPresser, now: number): PitchGateOutcome;
  /** `key`'s session suspended, changed area (`left`) or disconnected. Whether the match changed. */
  gone(key: string, reason: PitchGoneReason, now: number): boolean;
  /**
   * A goal went in: the ball's own score, which the match mirrors. The side
   * that scored reaches clients as the goal broadcast and the score itself,
   * so the match never needs to be told it.
   */
  scored(starks: number, snarks: number, now: number): void;
  /** `winner` reached `FOOTBALL_WIN_SCORE`: the match is over. */
  fullTime(winner: FootballSide, now: number): void;
  /**
   * Run every deadline up to `now`, step the dummies against `ball`, and
   * return what the caller must do, in order. Whether the match reset the ball
   * is reported separately by `takeReset`.
   */
  advance(now: number, ball: BallState): PitchEvent[];
  /**
   * Whether the ball must be reset (0–0, on the centre spot) since the last
   * call: a match starting, or one closing. Clears the flag.
   */
  takeReset(): boolean;
  /** Every dummy as a body the ball meets. */
  dummies(): readonly { readonly key: string; readonly x: number; readonly y: number }[];
  /** Forget a connection's floor: it left the room. */
  forget(key: string): void;
}

interface MutableSlot {
  kind: PitchSlotKind;
  /** The connection key of a player slot; never on the wire. */
  key: string | null;
  gameId: GameId | null;
  /** A dummy's centre, World pixels. */
  x: number;
  y: number;
  /** When this dummy may kick again, in ms. */
  kickDue: number;
}

/** The mouth centre of the goal a side attacks, in World pixels. */
const ATTACKS: Readonly<Record<FootballSide, Position>> = Object.freeze({
  starks: goalMouth('snarks'),
  snarks: goalMouth('starks'),
});

function goalMouth(defender: FootballSide): Position {
  const end = FOOTBALL_SIDE_GOAL[defender];
  const line = end === 'west' ? PITCH_FIELD.x : PITCH_FIELD.x + PITCH_FIELD.width;
  const out = end === 'west' ? -1 : 1;
  return Object.freeze({
    x: (line + (out * PITCH_GOAL.depth) / 2) * T,
    y: (PITCH_FIELD.y + PITCH_FIELD.height / 2) * T,
  });
}

/** A tile rect as a World pixel box a dummy's centre stays inside. */
function zoneBox(rect: TileRect): Readonly<{ minX: number; maxX: number; minY: number; maxY: number }> {
  return Object.freeze({
    minX: rect.x * T + DUMMY_INSET_PX,
    maxX: (rect.x + rect.width) * T - DUMMY_INSET_PX,
    minY: rect.y * T + DUMMY_INSET_PX,
    maxY: (rect.y + rect.height) * T - DUMMY_INSET_PX,
  });
}

const ZONES = Object.freeze(PITCH_QUARTERS.map((quarter) => zoneBox(quarter.zone)));

function isTime(now: number): boolean {
  return Number.isFinite(now) && now >= 0;
}

/** A strict per-key floor, as `arena-rules.ts`'s: one accepted press per interval, never queued. */
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

function emptySlot(): MutableSlot {
  return { kind: 'empty', key: null, gameId: null, x: 0, y: 0, kickDue: 0 };
}

function dummyAt(index: number): MutableSlot {
  const at = pitchTileCentre(PITCH_QUARTERS[index]!.spot);
  return { kind: 'dummy', key: null, gameId: null, x: Math.round(at.x), y: Math.round(at.y), kickDue: 0 };
}

function frozenSlot(slot: MutableSlot): PitchSlot {
  const dummy = slot.kind === 'dummy';
  return Object.freeze({
    kind: slot.kind,
    gameId: slot.kind === 'player' ? slot.gameId : null,
    x: dummy ? Math.round(slot.x) : 0,
    y: dummy ? Math.round(slot.y) : 0,
  });
}

export function createPitchAuthority(options: PitchAuthorityOptions = {}): PitchAuthority {
  const dummyFill = options.dummyFill !== false;
  let phase: PitchMatchPhase = 'open';
  let round = Number.isInteger(options.round) && (options.round as number) >= 0 ? (options.round as number) & 0xffff : 0;
  const slots: MutableSlot[] = Array.from({ length: PITCH_SLOTS }, emptySlot);
  let starks = 0;
  let snarks = 0;
  /** When the current phase ends; null while open or playing. */
  let deadline: number | null = null;
  let winner: FootballSide | null = null;
  /** Set when the caller must put the ball back on the centre spot at 0–0. */
  let resetBall = false;
  /** The dummy clock: the time of the last whole step, null while nothing steps. */
  let dummyClock: number | null = null;
  const intentFloor = new Floor(PITCH_INTENT_MIN_INTERVAL_MS);
  const pending: PitchEvent[] = [];

  const taken = (): number => slots.filter((slot) => slot.kind !== 'empty').length;
  const realPlayers = (): number => slots.filter((slot) => slot.kind === 'player').length;

  function slotIndexOf(key: string): number {
    return slots.findIndex((slot) => slot.kind === 'player' && slot.key === key);
  }

  function place(key: string, stand: { readonly spot: Position; readonly facing: Facing }): void {
    pending.push(Object.freeze({ kind: 'place', key, spot: stand.spot, facing: stand.facing }));
  }

  /** Stand every slot's player on its quarter's spot: a kick-off, or a restart after a goal. */
  function setPlaces(): void {
    slots.forEach((slot, index) => {
      const quarter = PITCH_QUARTERS[index]!;
      if (slot.kind === 'player' && slot.key !== null) place(slot.key, quarter);
      if (slot.kind === 'dummy') {
        const at = pitchTileCentre(quarter.spot);
        slot.x = Math.round(at.x);
        slot.y = Math.round(at.y);
        slot.kickDue = 0;
      }
    });
  }

  function start(now: number): void {
    round = (round + 1) & 0xffff;
    starks = 0;
    snarks = 0;
    winner = null;
    resetBall = true;
    phase = 'countdown';
    deadline = (isTime(now) ? now : 0) + PITCH_COUNTDOWN_MS;
    dummyClock = null;
    setPlaces();
  }

  /** The match is over, or abandoned: everyone out, the ball back, the pitch open. */
  function close(putBack: boolean): void {
    if (putBack) {
      slots.forEach((slot, index) => {
        if (slot.kind === 'player' && slot.key !== null) place(slot.key, PITCH_SLOT_EXITS[index]!);
      });
    }
    for (let index = 0; index < slots.length; index += 1) slots[index] = emptySlot();
    phase = 'open';
    deadline = null;
    winner = null;
    starks = 0;
    snarks = 0;
    dummyClock = null;
    resetBall = true;
  }

  /**
   * `key`'s session gives its slot up. Mid-match a dummy takes over, whatever
   * `dummyFill` says: three-handed is not a 2v2. With the last real player
   * gone the match is abandoned and the pitch reopens.
   */
  function release(key: string): boolean {
    const index = slotIndexOf(key);
    if (index < 0) return false;
    if (phase === 'open') {
      slots[index] = emptySlot();
      return true;
    }
    slots[index] = dummyAt(index);
    if (realPlayers() === 0) close(false);
    return true;
  }

  function catchUp(now: number): void {
    if (!isTime(now)) return;
    // Each transition starts from the deadline it replaces, so a late call
    // lands where a punctual one would have.
    while (deadline !== null && now >= deadline) {
      const at = deadline;
      if (phase === 'countdown') {
        phase = 'playing';
        deadline = null;
        dummyClock = at;
      } else {
        // `ended`: the banner has had its time.
        close(true);
      }
    }
  }

  /** One fixed step of every dummy's play against `ball`. */
  function stepDummies(ball: BallState, at: number): void {
    const dt = PITCH_DUMMY_STEP_MS / 1000;
    const reach = PITCH_DUMMY_SPEED * dt;
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]!;
      if (slot.kind !== 'dummy') continue;
      const goal = ATTACKS[pitchSlotSide(index)];
      // The way the ball must travel, and the point a stride behind it.
      let gx = goal.x - ball.x;
      let gy = goal.y - ball.y;
      const span = Math.hypot(gx, gy);
      if (span > 1e-6) {
        gx /= span;
        gy /= span;
      } else {
        gx = 1;
        gy = 0;
      }
      const zone = ZONES[index]!;
      const wantX = clamp(ball.x - gx * PITCH_DUMMY_STANDOFF_PX, zone.minX, zone.maxX);
      const wantY = clamp(ball.y - gy * PITCH_DUMMY_STANDOFF_PX, zone.minY, zone.maxY);
      const dx = wantX - slot.x;
      const dy = wantY - slot.y;
      const away = Math.hypot(dx, dy);
      if (away > reach) {
        slot.x += (dx / away) * reach;
        slot.y += (dy / away) * reach;
      } else {
        slot.x = wantX;
        slot.y = wantY;
      }
      // In range, and squarely enough behind the ball to send it the right way.
      const bx = ball.x - slot.x;
      const by = ball.y - slot.y;
      const range = Math.hypot(bx, by);
      if (!(range <= KICK_RANGE_PX) || at < slot.kickDue) continue;
      const square = range > 1e-6 ? (bx * gx + by * gy) / range : 1;
      if (square < PITCH_DUMMY_KICK_MIN_COS) continue;
      slot.kickDue = at + PITCH_DUMMY_KICK_INTERVAL_MS;
      pending.push(Object.freeze({ kind: 'kick', x: slot.x, y: slot.y }));
    }
  }

  return {
    get phase() {
      return phase;
    },

    get active() {
      return deadline !== null;
    },

    get locked() {
      return phase === 'ended' || slots.every((slot) => slot.kind === 'player');
    },

    get players() {
      return realPlayers();
    },

    snapshot(now: number): PitchMatchSnapshot {
      let secondsLeft = 0;
      if (phase === 'countdown' && deadline !== null && isTime(now)) {
        secondsLeft = Math.min(
          Math.ceil(PITCH_COUNTDOWN_MS / 1000),
          Math.max(0, Math.ceil((deadline - now) / 1000)),
        );
      }
      return Object.freeze({
        phase,
        round,
        slots: Object.freeze(slots.map(frozenSlot)),
        starks,
        snarks,
        secondsLeft,
        winner: phase === 'ended' ? winner : null,
      });
    },

    holdsSlot(key: string): boolean {
      return slotIndexOf(key) >= 0;
    },

    mayKick(key: string): boolean {
      return (phase === 'open' || phase === 'playing') && slotIndexOf(key) >= 0;
    },

    gate(presser: PitchPresser, now: number): PitchGateOutcome {
      catchUp(now);
      if (!intentFloor.accept(presser.key, now)) return 'throttled';
      // The pitch is on the street (D-087): the Studio is drawn over it.
      if (presser.area !== 'street') return 'rejected';
      const gate = pitchGateAt(presser.x, presser.y);
      if (gate === null) return 'rejected';
      const held = slotIndexOf(presser.key);
      if (held >= 0) {
        // Giving a slot up: out through the gate they pressed.
        release(presser.key);
        place(presser.key, { spot: gate.exit, facing: gate.exitFacing });
        return 'left';
      }
      if (isInsidePitchPen(presser.x, presser.y)) return 'rejected';
      if (phase === 'ended') return 'locked';
      // An empty slot first; then a dummy's, which is how a real player joins
      // a match already running.
      let index = slots.findIndex((slot) => slot.kind === 'empty');
      if (index < 0) index = slots.findIndex((slot) => slot.kind === 'dummy');
      if (index < 0) return 'locked';
      const first = realPlayers() === 0;
      slots[index] = { ...emptySlot(), kind: 'player', key: presser.key, gameId: presser.gameId };
      if (first && dummyFill) {
        for (let other = 0; other < slots.length; other += 1) {
          if (slots[other]!.kind === 'empty') slots[other] = dummyAt(other);
        }
      }
      if (phase === 'open' && taken() === PITCH_SLOTS) {
        start(now);
      } else if (phase === 'open') {
        // Still waiting for a full four: just inside the gate, free to walk
        // about and kick until the match begins.
        place(presser.key, { spot: gate.spawn, facing: gate.spawnFacing });
      } else {
        // Joining a match already on: straight into the quarter they will play.
        place(presser.key, PITCH_QUARTERS[index]!);
      }
      return 'entered';
    },

    gone(key: string, reason: PitchGoneReason, now: number): boolean {
      catchUp(now);
      if (reason === 'disconnect') intentFloor.forget(key);
      return release(key);
    },

    scored(nextStarks: number, nextSnarks: number, now: number): void {
      catchUp(now);
      starks = wholeScore(nextStarks);
      snarks = wholeScore(nextSnarks);
      if (phase !== 'playing') return;
      // The goal that wins waits for full time rather than restarting.
      if (starks >= FOOTBALL_WIN_SCORE || snarks >= FOOTBALL_WIN_SCORE) return;
      phase = 'countdown';
      deadline = (isTime(now) ? now : 0) + PITCH_RESTART_MS;
      dummyClock = null;
      setPlaces();
    },

    fullTime(won: FootballSide, now: number): void {
      catchUp(now);
      if (phase !== 'playing' && phase !== 'countdown') return;
      phase = 'ended';
      winner = won;
      deadline = (isTime(now) ? now : 0) + PITCH_RESULT_MS;
      dummyClock = null;
    },

    advance(now: number, ball: BallState): PitchEvent[] {
      catchUp(now);
      if (phase === 'playing' && isTime(now) && isBall(ball)) {
        if (dummyClock === null) dummyClock = now;
        let steps = 0;
        while (dummyClock + PITCH_DUMMY_STEP_MS <= now && steps < PITCH_DUMMY_MAX_CATCH_UP) {
          dummyClock += PITCH_DUMMY_STEP_MS;
          steps += 1;
          stepDummies(ball, dummyClock);
        }
        // Too far behind to catch up (a stalled process): drop the lost time.
        if (dummyClock + PITCH_DUMMY_STEP_MS <= now) dummyClock = now;
      }
      return pending.splice(0, pending.length);
    },

    takeReset(): boolean {
      const was = resetBall;
      resetBall = false;
      return was;
    },

    dummies() {
      const bodies: { key: string; x: number; y: number }[] = [];
      slots.forEach((slot, index) => {
        if (slot.kind === 'dummy') bodies.push({ key: `pitch-dummy:${index}`, x: slot.x, y: slot.y });
      });
      return bodies;
    },

    forget(key: string): void {
      intentFloor.forget(key);
    },
  };
}

function clamp(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, value));
}

function wholeScore(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= FOOTBALL_WIN_SCORE
    ? value
    : 0;
}

function isBall(value: unknown): value is BallState {
  if (value === null || typeof value !== 'object') return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
}
