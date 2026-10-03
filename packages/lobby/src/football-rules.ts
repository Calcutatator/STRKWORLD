/**
 * The football rules (D-078). Pure, synchronous, transport-free.
 *
 * One authority object owns the ball, the score and the phase of play. The
 * lobby room runs one instance per room and the Shell runs one locally for
 * solo play, so both paths apply exactly the same physics and the same match
 * rules; the Shell also runs the physics alone (`stepBall`, `kickBall`) to
 * carry the ball it draws on from the latest server state. Nothing here
 * imports Colyseus, touches the network or reads a clock: time comes in as
 * arguments.
 *
 * ## Units
 *
 * Positions are World pixels and velocities World pixels per second, like
 * presence, with `FOOTBALL_TILE_SIZE` (32) pixels to a tile. The pitch's
 * geometry comes from the shared seam in tiles.
 *
 * ## The simulation
 *
 * A fixed step of `FOOTBALL_TICK_MS` (40 ms, 25 a second), each split into
 * `FOOTBALL_SUBSTEPS` (4) so a ball at full speed moves less than its own
 * radius per substep and cannot pass through a post or a board. In each
 * substep the ball slows (a drag proportional to its speed plus a constant
 * rolling resistance), moves, is pushed by any player it overlaps, then comes
 * off the posts and the boards round the field, or into the net. A goal is a
 * ball wholly over a goal line between the posts. The authority steps only
 * while its caller says someone is near (`resume`/`pause`); a paused ball is
 * at rest, and resuming never simulates the time it was paused.
 *
 * ## Kicking
 *
 * A kick needs the kicker's centre within `FOOTBALL_KICK_RANGE` tiles of the
 * ball's centre, during live play. It sends the ball at `FOOTBALL_KICK_SPEED`
 * straight away from the kicker's centre through the ball's: you aim by where
 * you stand, all the way round, which four wire facings could not give. The
 * facing is used only when the kicker stands on the ball's centre. The kick
 * therefore carries no payload at all: the authority already holds both
 * positions. Walking into the ball pushes it (a dribble): the ball comes off
 * the player's body as off a moving wall, with a little bounce, so a player
 * walking into a still ball sends it on ahead of them.
 *
 * D-130: a player whose caller marks them `airborne` is not a body the ball
 * meets, so a running jump carries them over it and leaves it where it was.
 * Their movement is still followed, so they land pushing it as usual.
 *
 * ## Anonymity
 *
 * The ball, the score and the phase carry nothing about anyone. The `key` of
 * a `FootballPlayer` exists only so the authority can tell one player's
 * movement from another's; it never appears in a snapshot or an event, and no
 * goal, kick or score is counted per player.
 */

import {
  FOOTBALL_BALL_RADIUS,
  FOOTBALL_KICK_RANGE,
  FOOTBALL_POST_RADIUS,
  FOOTBALL_TICK_MS,
  FOOTBALL_WIN_SCORE,
  PITCH_AREA,
  PITCH_FIELD,
  PITCH_GOAL,
  STREET_ORIGIN_X,
  type Facing,
  type FootballPhase,
  type FootballSide,
  type FootballSnapshot,
} from '@strkworld/shared';

/** World pixels per street tile. */
export const FOOTBALL_TILE_SIZE = 32;

/** Substeps per simulation step. */
export const FOOTBALL_SUBSTEPS = 4;

/** How fast a kick sends the ball, in World pixels per second: 13 tiles a second. */
export const FOOTBALL_KICK_SPEED = 13 * FOOTBALL_TILE_SIZE;

/** The fastest the ball ever moves, in World pixels per second: 20 tiles a second. */
export const FOOTBALL_MAX_SPEED = 20 * FOOTBALL_TILE_SIZE;

/** Drag, per second: the share of its speed the ball loses to it, continuously. */
export const FOOTBALL_DRAG = 0.8;

/** Rolling resistance, in World pixels per second squared: what finally stops the ball. */
export const FOOTBALL_ROLLING = 24;

/** Below this speed, in World pixels per second, the ball is at rest. */
export const FOOTBALL_REST_SPEED = 2;

/** How much of its speed into a board the ball keeps coming off it. */
export const FOOTBALL_BOARD_RESTITUTION = 0.7;

/** ...into a post. */
export const FOOTBALL_POST_RESTITUTION = 0.6;

/** ...into the net, which takes most of it. */
export const FOOTBALL_NET_RESTITUTION = 0.15;

/** A player's body, as the ball meets it: a circle this wide, in World pixels (the avatar's half-size). */
export const FOOTBALL_PLAYER_RADIUS = 12;

/** How much the ball bounces off a player it meets, or who walks into it. */
export const FOOTBALL_DRIBBLE_RESTITUTION = 0.4;

/** A player's speed is read over at most this long, in ms, and is nil once they have not moved for this long. */
export const FOOTBALL_PLAYER_WINDOW_MS = 160;

/** The fastest a player is taken to move, in World pixels per second: a sprint, with room for jitter. */
export const FOOTBALL_PLAYER_MAX_SPEED = 360;

/** How long a goal is celebrated before the kick-off, in ms. */
export const FOOTBALL_GOAL_MS = 2500;

/** How long the full-time moment lasts before the score goes back to 0–0, in ms. */
export const FOOTBALL_FULL_TIME_MS = 4500;

/** Most steps one `advance` catches up; past that, the lost time is dropped rather than simulated. */
export const FOOTBALL_MAX_CATCH_UP = 8;

/**
 * Where a player keeps the ball running, in street tiles: the pitch square
 * and the first stretch of street outside its gate, from where the camera
 * still sees the field.
 */
export const FOOTBALL_ACTIVE_AREA = Object.freeze({
  x: PITCH_AREA.x,
  y: PITCH_AREA.y,
  width: STREET_ORIGIN_X + 15 - PITCH_AREA.x,
  height: PITCH_AREA.height,
});

const T = FOOTBALL_TILE_SIZE;
const BALL_R = FOOTBALL_BALL_RADIUS * T;
const POST_R = FOOTBALL_POST_RADIUS * T;
const KICK_RANGE = FOOTBALL_KICK_RANGE * T;
const X0 = PITCH_FIELD.x * T;
const X1 = (PITCH_FIELD.x + PITCH_FIELD.width) * T;
const Y0 = PITCH_FIELD.y * T;
const Y1 = (PITCH_FIELD.y + PITCH_FIELD.height) * T;
const MID = (PITCH_FIELD.y + PITCH_FIELD.height / 2) * T;
const HALF_MOUTH = (PITCH_GOAL.width / 2) * T;
const DEPTH = PITCH_GOAL.depth * T;

/** The centre spot, where every kick-off starts, in World pixels. */
export const FOOTBALL_CENTRE = Object.freeze({ x: (X0 + X1) / 2, y: MID });

/** The ball's state: its centre in World pixels, its velocity in World pixels per second. */
export interface BallState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** A body the ball can meet: where it is and how it moves, World pixels and pixels per second. */
export interface FootballPusher {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** Someone on the pitch. `x`/`y` are World pixels; `at` is when that position was set, in ms. */
export interface FootballPlayer {
  /** Opaque, caller-chosen. Only used to follow one player's movement. */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  /**
   * D-130: their feet are off the ground — mid-jump, above knee height — so
   * the ball passes under them: they are not a body it meets this step. They
   * are still followed, so the speed they land with pushes it as always. The
   * caller decides it: the room from the jump it timed, the Shell from its own
   * jump state. Absent means standing.
   */
  readonly airborne?: boolean;
}

/** What one step of play produced. A goal names its side and nothing else. */
export type FootballEvent =
  | { readonly kind: 'goal'; readonly side: FootballSide }
  | { readonly kind: 'full-time'; readonly winner: FootballSide }
  | { readonly kind: 'kick-off' };

interface Segment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly restitution: number;
}

interface Post {
  readonly x: number;
  readonly y: number;
}

/**
 * The boards the ball comes off and the net it goes into, as line segments:
 * both touchlines, each goal line either side of its mouth, and each goal's
 * two sides and back. The posts, at the mouths' corners, are circles.
 */
const SEGMENTS: readonly Segment[] = Object.freeze([
  { ax: X0, ay: Y0, bx: X1, by: Y0, restitution: FOOTBALL_BOARD_RESTITUTION },
  { ax: X0, ay: Y1, bx: X1, by: Y1, restitution: FOOTBALL_BOARD_RESTITUTION },
  ...[X0, X1].flatMap((line) => {
    const out = line === X0 ? -1 : 1;
    const back = line + out * DEPTH;
    return [
      { ax: line, ay: Y0, bx: line, by: MID - HALF_MOUTH, restitution: FOOTBALL_BOARD_RESTITUTION },
      { ax: line, ay: MID + HALF_MOUTH, bx: line, by: Y1, restitution: FOOTBALL_BOARD_RESTITUTION },
      { ax: back, ay: MID - HALF_MOUTH, bx: line, by: MID - HALF_MOUTH, restitution: FOOTBALL_NET_RESTITUTION },
      { ax: back, ay: MID + HALF_MOUTH, bx: line, by: MID + HALF_MOUTH, restitution: FOOTBALL_NET_RESTITUTION },
      { ax: back, ay: MID - HALF_MOUTH, bx: back, by: MID + HALF_MOUTH, restitution: FOOTBALL_NET_RESTITUTION },
    ];
  }),
].map((segment) => Object.freeze(segment)));

/** Each post stands just behind its goal line, its face on the line. */
const POSTS: readonly Post[] = Object.freeze([
  { x: X0 - POST_R, y: MID - HALF_MOUTH },
  { x: X0 - POST_R, y: MID + HALF_MOUTH },
  { x: X1 + POST_R, y: MID - HALF_MOUTH },
  { x: X1 + POST_R, y: MID + HALF_MOUTH },
].map((post) => Object.freeze(post)));

/** Whether a World-pixel position is where a player keeps the ball running. */
export function isNearPitch(x: number, y: number): boolean {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const area = FOOTBALL_ACTIVE_AREA;
  return x >= area.x * T && x < (area.x + area.width) * T && y >= area.y * T && y < (area.y + area.height) * T;
}

/**
 * The side a ball has just scored for, or null: a ball wholly over the west
 * goal line between the posts is East's, over the east one West's.
 */
export function goalScoredBy(ball: BallState): FootballSide | null {
  if (!(Math.abs(ball.y - MID) < HALF_MOUTH)) return null;
  if (ball.x < X0 - BALL_R) return 'east';
  if (ball.x > X1 + BALL_R) return 'west';
  return null;
}

/** A ball at rest on the centre spot. */
export function kickOffBall(): BallState {
  return Object.freeze({ x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0 });
}

const FACING_VECTOR: Readonly<Record<Facing, readonly [number, number]>> = Object.freeze({
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
});

/**
 * The ball after `player` kicks it, or null when it is out of range (or
 * anything is not a finite number). Away from the kicker's centre through the
 * ball's; along `facing` only when the kicker stands on the ball's centre.
 */
export function kickBall(ball: BallState, player: { readonly x: number; readonly y: number }, facing: Facing = 'down'): BallState | null {
  if (!isBall(ball) || !isPoint(player)) return null;
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance <= KICK_RANGE)) return null;
  const [nx, ny] = distance > 2 ? [dx / distance, dy / distance] : FACING_VECTOR[facing] ?? FACING_VECTOR.down;
  return Object.freeze({ x: ball.x, y: ball.y, vx: nx * FOOTBALL_KICK_SPEED, vy: ny * FOOTBALL_KICK_SPEED });
}

/**
 * One step of physics, `dtMs` long, split into `FOOTBALL_SUBSTEPS`: drag and
 * rolling resistance, movement, then any `pushers` the ball overlaps, the
 * posts and the boards or net. Returns the ball and the first side it scored
 * for during the step, if it went wholly over a goal line between the posts.
 * A malformed ball comes back as a kick-off ball; malformed pushers are
 * ignored.
 */
export function stepBall(
  ball: BallState,
  dtMs: number,
  pushers: readonly FootballPusher[] = [],
): { readonly ball: BallState; readonly scored: FootballSide | null } {
  const start = isBall(ball) ? ball : kickOffBall();
  let { x, y, vx, vy } = start;
  let scored: FootballSide | null = null;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, FOOTBALL_TICK_MS * FOOTBALL_MAX_CATCH_UP) / 1000 : 0;
  const bodies = Array.isArray(pushers) ? pushers.filter(isPusher) : [];
  const substeps = dt > 0 ? Math.max(1, Math.round((dt * 1000 * FOOTBALL_SUBSTEPS) / FOOTBALL_TICK_MS)) : 0;
  const h = substeps > 0 ? dt / substeps : 0;
  for (let i = 0; i < substeps; i++) {
    // Slow down: drag in proportion to speed, then a constant rolling loss.
    const speed = Math.hypot(vx, vy);
    if (speed > 0) {
      const next = speed * Math.exp(-FOOTBALL_DRAG * h) - FOOTBALL_ROLLING * h;
      const scale = next > FOOTBALL_REST_SPEED ? next / speed : 0;
      vx *= scale;
      vy *= scale;
    }
    x += vx * h;
    y += vy * h;
    // Bodies first, so whatever they push is then kept inside by the boards.
    for (const body of bodies) ({ x, y, vx, vy } = meetCircle(x, y, vx, vy, body.x, body.y, body.vx, body.vy, FOOTBALL_PLAYER_RADIUS, FOOTBALL_DRIBBLE_RESTITUTION));
    ({ vx, vy } = capSpeed(vx, vy));
    for (const post of POSTS) ({ x, y, vx, vy } = meetCircle(x, y, vx, vy, post.x, post.y, 0, 0, POST_R, FOOTBALL_POST_RESTITUTION));
    for (const segment of SEGMENTS) ({ x, y, vx, vy } = meetSegment(x, y, vx, vy, segment));
    ({ x, y } = contain(x, y));
    if (scored === null) scored = goalScoredBy({ x, y, vx, vy });
  }
  return Object.freeze({ ball: Object.freeze({ x, y, vx, vy }), scored });
}

interface Moving {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** The ball against a circle moving at (cvx, cvy): pushed clear, and off it if it was closing. */
function meetCircle(
  x: number,
  y: number,
  vx: number,
  vy: number,
  cx: number,
  cy: number,
  cvx: number,
  cvy: number,
  radius: number,
  restitution: number,
): Moving {
  const dx = x - cx;
  const dy = y - cy;
  const reach = BALL_R + radius;
  const distance = Math.hypot(dx, dy);
  if (!(distance < reach)) return { x, y, vx, vy };
  // Dead centre: push along the circle's own motion, or east.
  const motion = Math.hypot(cvx, cvy);
  const [nx, ny] = distance > 1e-6 ? [dx / distance, dy / distance] : motion > 1e-6 ? [cvx / motion, cvy / motion] : [1, 0];
  const px = cx + nx * reach;
  const py = cy + ny * reach;
  const closing = (vx - cvx) * nx + (vy - cvy) * ny;
  if (closing >= 0) return { x: px, y: py, vx, vy };
  return { x: px, y: py, vx: vx - (1 + restitution) * closing * nx, vy: vy - (1 + restitution) * closing * ny };
}

/** The ball against a board or a stretch of net: pushed clear of the segment, and off it if moving into it. */
function meetSegment(x: number, y: number, vx: number, vy: number, s: Segment): Moving {
  const ex = s.bx - s.ax;
  const ey = s.by - s.ay;
  const length2 = ex * ex + ey * ey;
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((x - s.ax) * ex + (y - s.ay) * ey) / length2)) : 0;
  const cx = s.ax + ex * t;
  const cy = s.ay + ey * t;
  const dx = x - cx;
  const dy = y - cy;
  const distance = Math.hypot(dx, dy);
  if (!(distance < BALL_R)) return { x, y, vx, vy };
  let nx: number;
  let ny: number;
  if (distance > 1e-6) {
    nx = dx / distance;
    ny = dy / distance;
  } else {
    // On the line itself, which substeps never allow: back toward the field's middle.
    const length = Math.sqrt(length2) || 1;
    nx = -ey / length;
    ny = ex / length;
    if (nx * (FOOTBALL_CENTRE.x - cx) + ny * (FOOTBALL_CENTRE.y - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
  }
  const px = cx + nx * BALL_R;
  const py = cy + ny * BALL_R;
  const into = vx * nx + vy * ny;
  if (into >= 0) return { x: px, y: py, vx, vy };
  return { x: px, y: py, vx: vx - (1 + s.restitution) * into * nx, vy: vy - (1 + s.restitution) * into * ny };
}

/** How far past the net's inner line a ball behind a goal line may stray and still be in the goal. */
const NET_SLACK = 2;

/**
 * The last guard: the ball's centre stays inside the field or a goal,
 * whatever pushed it. Behind a goal line it stays in the net; if it is there
 * without being in line with the mouth, only a push through the boards could
 * have put it there, and it goes back onto the field rather than into a goal.
 */
function contain(x: number, y: number): { x: number; y: number } {
  const clampY = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  if (x < X0 || x > X1) {
    const west = x < X0;
    if (Math.abs(y - MID) <= HALF_MOUTH - BALL_R + NET_SLACK) {
      const cx = west ? Math.max(X0 - DEPTH + BALL_R, x) : Math.min(X1 + DEPTH - BALL_R, x);
      return { x: cx, y: clampY(y, MID - HALF_MOUTH + BALL_R, MID + HALF_MOUTH - BALL_R) };
    }
    return { x: west ? X0 + BALL_R : X1 - BALL_R, y: clampY(y, Y0 + BALL_R, Y1 - BALL_R) };
  }
  // On the field: inside the boards, but free to cross a goal line in a mouth.
  const inMouth = Math.abs(y - MID) < HALF_MOUTH;
  const cx = inMouth ? x : Math.min(X1 - BALL_R, Math.max(X0 + BALL_R, x));
  return { x: cx, y: clampY(y, Y0 + BALL_R, Y1 - BALL_R) };
}

function capSpeed(vx: number, vy: number): { vx: number; vy: number } {
  const speed = Math.hypot(vx, vy);
  if (!(speed > FOOTBALL_MAX_SPEED)) return { vx, vy };
  const scale = FOOTBALL_MAX_SPEED / speed;
  return { vx: vx * scale, vy: vy * scale };
}

function isBall(value: unknown): value is BallState {
  if (value === null || typeof value !== 'object') return false;
  const { x, y, vx, vy } = value as Partial<Record<keyof BallState, unknown>>;
  return [x, y, vx, vy].every((part) => typeof part === 'number' && Number.isFinite(part));
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (value === null || typeof value !== 'object') return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
}

function isPusher(value: unknown): value is FootballPusher {
  return isBall(value);
}

// ---------------------------------------------------------------------------
// The authority
// ---------------------------------------------------------------------------

export interface FootballAuthority {
  /** The ball, the score and the phase, as of the last step. Frozen; the same object until the next change. */
  snapshot(): FootballSnapshot;
  /** Whether the ball is running (someone is near). */
  readonly running: boolean;
  /**
   * Start the clock at `nowMs`, without simulating anything before it. A
   * running authority ignores this.
   */
  resume(nowMs: number): void;
  /** Stop the clock: nobody is near. The ball comes to rest where it is. */
  pause(): void;
  /**
   * Run every whole step between the last one and `nowMs`, with `players` as
   * they stand now (at most `FOOTBALL_MAX_CATCH_UP`; time past that is
   * dropped), and report what happened, in order. A paused authority does
   * nothing.
   */
  advance(nowMs: number, players: readonly FootballPlayer[]): FootballEvent[];
  /**
   * `player` kicks the ball, facing `facing`: applied at once if the ball is
   * running, play is live and they are in range, and false otherwise, with
   * nothing changed.
   */
  kick(player: { readonly x: number; readonly y: number }, facing?: Facing): boolean;
  /** Forget a player's movement: they left. */
  forget(key: string): void;
}

export interface FootballAuthorityOptions {
  /** The ball to start from; a kick-off ball when absent. For tests. */
  readonly ball?: BallState;
}

const PHASE_STEPS: Readonly<Record<'goal' | 'full-time', number>> = Object.freeze({
  goal: Math.ceil(FOOTBALL_GOAL_MS / FOOTBALL_TICK_MS),
  'full-time': Math.ceil(FOOTBALL_FULL_TIME_MS / FOOTBALL_TICK_MS),
});

export function createFootballAuthority(options: FootballAuthorityOptions = {}): FootballAuthority {
  const start = options !== null && typeof options === 'object' && isBall(options.ball) ? options.ball : kickOffBall();
  return new Authority(start);
}

interface Track {
  /** Recent distinct positions, oldest first, with the time each was set. */
  readonly samples: { x: number; y: number; at: number }[];
}

class Authority implements FootballAuthority {
  #ball: BallState;
  #west = 0;
  #east = 0;
  #phase: FootballPhase = 'live';
  /** The step on which the current goal or full-time moment ends. */
  #phaseEnds = 0;
  #tick = 0;
  /** Time of the last step, in ms; null while paused. */
  #clock: number | null = null;
  readonly #tracks = new Map<string, Track>();
  #view: FootballSnapshot | null = null;

  constructor(ball: BallState) {
    this.#ball = Object.freeze({ ...ball });
  }

  get running(): boolean {
    return this.#clock !== null;
  }

  snapshot(): FootballSnapshot {
    if (this.#view === null) {
      this.#view = Object.freeze({
        tick: this.#tick,
        x: this.#ball.x,
        y: this.#ball.y,
        vx: this.#ball.vx,
        vy: this.#ball.vy,
        west: this.#west,
        east: this.#east,
        phase: this.#phase,
      });
    }
    return this.#view;
  }

  resume(nowMs: number): void {
    if (this.#clock !== null || !isTime(nowMs)) return;
    const tick = Math.floor(nowMs / FOOTBALL_TICK_MS);
    // A moment's remaining length carries over the pause.
    if (this.#phase !== 'live') this.#phaseEnds += Math.max(0, tick - this.#tick);
    this.#tick = Math.max(this.#tick, tick);
    this.#clock = this.#tick * FOOTBALL_TICK_MS;
    this.#view = null;
  }

  pause(): void {
    if (this.#clock === null) return;
    this.#clock = null;
    this.#tracks.clear();
    if (this.#ball.vx !== 0 || this.#ball.vy !== 0) {
      this.#ball = Object.freeze({ ...this.#ball, vx: 0, vy: 0 });
      this.#view = null;
    }
  }

  advance(nowMs: number, players: readonly FootballPlayer[]): FootballEvent[] {
    if (this.#clock === null || !isTime(nowMs)) return [];
    const events: FootballEvent[] = [];
    let steps = 0;
    while (this.#clock + FOOTBALL_TICK_MS <= nowMs && steps < FOOTBALL_MAX_CATCH_UP) {
      this.#clock += FOOTBALL_TICK_MS;
      this.#tick += 1;
      steps += 1;
      this.#step(players, events);
    }
    if (this.#clock + FOOTBALL_TICK_MS <= nowMs) {
      // Too far behind to catch up (a stalled process): drop the lost time.
      const tick = Math.floor(nowMs / FOOTBALL_TICK_MS);
      if (this.#phase !== 'live') this.#phaseEnds += tick - this.#tick;
      this.#tick = tick;
      this.#clock = tick * FOOTBALL_TICK_MS;
    }
    if (steps > 0) this.#view = null;
    return events;
  }

  kick(player: { readonly x: number; readonly y: number }, facing: Facing = 'down'): boolean {
    if (this.#clock === null || this.#phase !== 'live') return false;
    const kicked = kickBall(this.#ball, player, facing);
    if (kicked === null) return false;
    this.#ball = kicked;
    this.#view = null;
    return true;
  }

  forget(key: string): void {
    if (typeof key === 'string') this.#tracks.delete(key);
  }

  #step(players: readonly FootballPlayer[], events: FootballEvent[]): void {
    const now = this.#clock ?? 0;
    const pushers = this.#pushers(players, now);
    const { ball, scored } = stepBall(this.#ball, FOOTBALL_TICK_MS, pushers);
    this.#ball = ball;
    if (this.#phase === 'live' && scored !== null) {
      if (scored === 'west') this.#west += 1;
      else this.#east += 1;
      events.push(Object.freeze({ kind: 'goal', side: scored }));
      this.#phase = 'goal';
      this.#phaseEnds = this.#tick + PHASE_STEPS.goal;
      return;
    }
    if (this.#phase !== 'live' && this.#tick >= this.#phaseEnds) {
      const winner = this.#west >= FOOTBALL_WIN_SCORE ? 'west' : this.#east >= FOOTBALL_WIN_SCORE ? 'east' : null;
      if (this.#phase === 'goal' && winner !== null) {
        this.#phase = 'full-time';
        this.#phaseEnds = this.#tick + PHASE_STEPS['full-time'];
        events.push(Object.freeze({ kind: 'full-time', winner }));
        return;
      }
      if (this.#phase === 'full-time') {
        this.#west = 0;
        this.#east = 0;
      }
      this.#phase = 'live';
      this.#ball = kickOffBall();
      events.push(Object.freeze({ kind: 'kick-off' }));
    }
  }

  /**
   * Every locatable player as a body, moving at the speed read from their
   * recent positions. D-130: an airborne player is followed like any other —
   * so they land moving at the speed they were — but is not handed to the
   * physics, and the ball rolls on under them.
   */
  #pushers(players: readonly FootballPlayer[], now: number): FootballPusher[] {
    const seen = new Set<string>();
    const pushers: FootballPusher[] = [];
    for (const candidate of Array.isArray(players) ? (players as readonly unknown[]) : []) {
      const player = readPlayer(candidate);
      if (player === null || seen.has(player.key)) continue;
      seen.add(player.key);
      const track = this.#tracks.get(player.key) ?? { samples: [] };
      const last = track.samples[track.samples.length - 1];
      if (!last || last.x !== player.x || last.y !== player.y) {
        track.samples.push({ x: player.x, y: player.y, at: player.at });
        if (track.samples.length > 4) track.samples.shift();
      }
      this.#tracks.set(player.key, track);
      if (player.airborne === true) continue;
      pushers.push({ x: player.x, y: player.y, ...speedOf(track, now) });
    }
    for (const key of [...this.#tracks.keys()]) if (!seen.has(key)) this.#tracks.delete(key);
    return pushers;
  }
}

/**
 * A player's velocity from their recent positions: across the samples of the
 * last `FOOTBALL_PLAYER_WINDOW_MS`, nil once they have not moved for that
 * long, and never faster than `FOOTBALL_PLAYER_MAX_SPEED`.
 */
function speedOf(track: Track, now: number): { vx: number; vy: number } {
  const samples = track.samples;
  const last = samples[samples.length - 1];
  if (!last || !(now - last.at <= FOOTBALL_PLAYER_WINDOW_MS)) return { vx: 0, vy: 0 };
  let first = last;
  for (const sample of samples) {
    if (last.at - sample.at <= FOOTBALL_PLAYER_WINDOW_MS) {
      first = sample;
      break;
    }
  }
  const dt = (last.at - first.at) / 1000;
  if (!(dt > 0)) return { vx: 0, vy: 0 };
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed > FOOTBALL_PLAYER_MAX_SPEED) {
    vx *= FOOTBALL_PLAYER_MAX_SPEED / speed;
    vy *= FOOTBALL_PLAYER_MAX_SPEED / speed;
  }
  return { vx, vy };
}

/** A usable player, or null. Never throws, whatever the caller passed. */
function readPlayer(value: unknown): FootballPlayer | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const { key, x, y, at, airborne } = value as Partial<Record<keyof FootballPlayer, unknown>>;
    if (typeof key !== 'string') return null;
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (typeof y !== 'number' || !Number.isFinite(y)) return null;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    // Anything but exactly true is standing: a malformed flag never lifts a
    // player off the ground.
    return airborne === true ? { key, x, y, at, airborne: true } : { key, x, y, at };
  } catch {
    return null;
  }
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
