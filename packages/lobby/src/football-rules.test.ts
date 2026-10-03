import { describe, expect, it } from 'vitest';
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
  type FootballSide,
} from '@strkworld/shared';
import {
  FOOTBALL_ACTIVE_AREA,
  FOOTBALL_BOARD_RESTITUTION,
  FOOTBALL_CENTRE,
  FOOTBALL_DRAG,
  FOOTBALL_FULL_TIME_MS,
  FOOTBALL_GOAL_MS,
  FOOTBALL_KICK_SPEED,
  FOOTBALL_MAX_CATCH_UP,
  FOOTBALL_MAX_SPEED,
  FOOTBALL_PLAYER_RADIUS,
  FOOTBALL_ROLLING,
  FOOTBALL_SUBSTEPS,
  FOOTBALL_TILE_SIZE,
  createFootballAuthority,
  goalScoredBy,
  isNearPitch,
  kickBall,
  kickOffBall,
  stepBall,
  type BallState,
  type FootballAuthority,
  type FootballEvent,
  type FootballPlayer,
} from './football-rules';

/**
 * The football's physics and match rules (D-078), run without a room: the
 * same module the lobby steps and the Shell runs for solo play.
 */

const T = FOOTBALL_TILE_SIZE;
const R = FOOTBALL_BALL_RADIUS * T;
const X0 = PITCH_FIELD.x * T;
const X1 = (PITCH_FIELD.x + PITCH_FIELD.width) * T;
const Y0 = PITCH_FIELD.y * T;
const Y1 = (PITCH_FIELD.y + PITCH_FIELD.height) * T;
const MID = (PITCH_FIELD.y + PITCH_FIELD.height / 2) * T;
const HALF_MOUTH = (PITCH_GOAL.width / 2) * T;
const DEPTH = PITCH_GOAL.depth * T;
const POST_R = FOOTBALL_POST_RADIUS * T;

const ball = (x: number, y: number, vx = 0, vy = 0): BallState => ({ x, y, vx, vy });

/**
 * Step a ball `steps` times with nobody on the pitch, keeping every
 * intermediate state and, in order, each side it went over a line for (a ball
 * resting in the net is over the line on every step, so each side once).
 */
function roll(start: BallState, steps: number): { states: BallState[]; scored: FootballSide[] } {
  const states: BallState[] = [start];
  const scored: FootballSide[] = [];
  let current = start;
  for (let i = 0; i < steps; i++) {
    const next = stepBall(current, FOOTBALL_TICK_MS);
    if (next.scored && !scored.includes(next.scored)) scored.push(next.scored);
    current = next.ball;
    states.push(current);
  }
  return { states, scored };
}

/** Distance from a point to a segment. */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(px - (ax + ex * t), py - (ay + ey * t));
}

/**
 * The physical invariant: the ball's centre is on the field or in a goal, its
 * body overlaps no board and no stretch of net, and no post.
 */
function contained(state: BallState): boolean {
  const eps = 1e-6;
  const { x, y } = state;
  const inField = x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
  const inGoal = Math.abs(y - MID) <= HALF_MOUTH && x >= X0 - DEPTH && x <= X1 + DEPTH;
  if (!inField && !inGoal) return false;
  const boards: [number, number, number, number][] = [
    [X0, Y0, X1, Y0],
    [X0, Y1, X1, Y1],
    ...[X0, X1].flatMap((line): [number, number, number, number][] => {
      const back = line === X0 ? X0 - DEPTH : X1 + DEPTH;
      return [
        [line, Y0, line, MID - HALF_MOUTH],
        [line, MID + HALF_MOUTH, line, Y1],
        [back, MID - HALF_MOUTH, line, MID - HALF_MOUTH],
        [back, MID + HALF_MOUTH, line, MID + HALF_MOUTH],
        [back, MID - HALF_MOUTH, back, MID + HALF_MOUTH],
      ];
    }),
  ];
  if (boards.some(([ax, ay, bx, by]) => toSegment(x, y, ax, ay, bx, by) < R - eps)) return false;
  const posts = [[X0 - POST_R, MID - HALF_MOUTH], [X0 - POST_R, MID + HALF_MOUTH], [X1 + POST_R, MID - HALF_MOUTH], [X1 + POST_R, MID + HALF_MOUTH]];
  return posts.every(([px, py]) => Math.hypot(x - px!, y - py!) >= R + POST_R - eps);
}

/** Deterministic PRNG, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A running authority, its clock and a way to step it and gather what happened. */
function match(start?: BallState): {
  authority: FootballAuthority;
  now: () => number;
  run: (ms: number, players?: readonly FootballPlayer[]) => FootballEvent[];
} {
  const authority = createFootballAuthority(start ? { ball: start } : {});
  let clock = 1_000 * FOOTBALL_TICK_MS;
  authority.resume(clock);
  return {
    authority,
    now: () => clock,
    run: (ms, players = []) => {
      const events: FootballEvent[] = [];
      const until = clock + ms;
      while (clock < until) {
        clock = Math.min(until, clock + FOOTBALL_TICK_MS);
        events.push(...authority.advance(clock, players));
      }
      return events;
    },
  };
}

describe('the pitch geometry the rules read (D-078)', () => {
  it('uses the shared field and goals in World pixels, and a centre spot in the middle of the field', () => {
    expect(T).toBe(32);
    expect(FOOTBALL_CENTRE).toEqual({ x: (X0 + X1) / 2, y: MID });
    expect(kickOffBall()).toEqual({ x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0 });
    expect(Object.isFrozen(kickOffBall())).toBe(true);
    // A substep never moves the ball as far as a post and the ball's own radius.
    const substep = (FOOTBALL_MAX_SPEED * FOOTBALL_TICK_MS) / 1000 / FOOTBALL_SUBSTEPS;
    expect(substep).toBeLessThan(R + POST_R);
  });

  it('keeps the ball running on the pitch and the street in sight of it, and nowhere else', () => {
    expect(FOOTBALL_ACTIVE_AREA).toEqual({ x: PITCH_AREA.x, y: 0, width: STREET_ORIGIN_X + 15, height: PITCH_AREA.height });
    expect(isNearPitch(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y)).toBe(true);
    expect(isNearPitch(0, 0)).toBe(true);
    expect(isNearPitch((STREET_ORIGIN_X + 15) * T - 1, 15 * T)).toBe(true);
    expect(isNearPitch((STREET_ORIGIN_X + 15) * T, 15 * T)).toBe(false);
    expect(isNearPitch(10 * T, 28 * T)).toBe(false);
    expect(isNearPitch(-1, 10)).toBe(false);
    expect(isNearPitch(Number.NaN, 10)).toBe(false);
    expect(isNearPitch('10' as never, 10)).toBe(false);
  });
});

describe('friction', () => {
  it('slows a rolling ball by drag and rolling resistance, and nothing else, in open field', () => {
    const start = ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y, 200, 0);
    const { ball: after } = stepBall(start, FOOTBALL_TICK_MS);
    let speed = 200;
    const h = FOOTBALL_TICK_MS / 1000 / FOOTBALL_SUBSTEPS;
    let travelled = 0;
    for (let i = 0; i < FOOTBALL_SUBSTEPS; i++) {
      speed = speed * Math.exp(-FOOTBALL_DRAG * h) - FOOTBALL_ROLLING * h;
      travelled += speed * h;
    }
    expect(after.vx).toBeCloseTo(speed, 9);
    expect(after.vy).toBe(0);
    expect(after.x - start.x).toBeCloseTo(travelled, 9);
    expect(after.y).toBe(start.y);
  });

  it('keeps its heading and slows every step until it comes to rest, and stays at rest', () => {
    const { states } = roll(ball(FOOTBALL_CENTRE.x - 3 * T, FOOTBALL_CENTRE.y - 2 * T, 120, 60), 200);
    let previous = Infinity;
    for (const state of states) {
      const speed = Math.hypot(state.vx, state.vy);
      expect(speed).toBeLessThanOrEqual(previous);
      if (speed > 0) expect(state.vy / state.vx).toBeCloseTo(0.5, 9);
      previous = speed;
    }
    const rest = states.findIndex((state) => state.vx === 0 && state.vy === 0);
    expect(rest).toBeGreaterThan(0);
    for (const state of states.slice(rest)) expect(state).toEqual(states[rest]);
  });

  it('carries a full kick from the centre spot about thirteen tiles, and stops it within four seconds', () => {
    const { states } = roll(ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y - 5, 0, 0), 0);
    void states;
    // Across the width of the field would hit a board, so measure along the length from the west goal area.
    const start = ball(X0 + 2 * T, MID - 5 * T, FOOTBALL_KICK_SPEED, 0);
    const run = roll(start, Math.ceil(4000 / FOOTBALL_TICK_MS));
    const stop = run.states.findIndex((state) => state.vx === 0);
    expect(stop).toBeGreaterThan(0);
    expect(stop * FOOTBALL_TICK_MS).toBeLessThan(4000);
    const distance = (run.states[stop]!.x - start.x) / T;
    expect(distance).toBeGreaterThan(12);
    expect(distance).toBeLessThan(14);
  });
});

describe('bounces', () => {
  it('comes back off a touchline board, keeping its speed along it and most of its speed into it', () => {
    const start = ball(FOOTBALL_CENTRE.x, Y0 + R + 2, 40, -300);
    const { states } = roll(start, 3);
    const after = states[3]!;
    expect(after.vy).toBeGreaterThan(0);
    // Most of the speed comes back: the board's restitution, less a few steps of friction.
    expect(after.vy).toBeGreaterThan(300 * FOOTBALL_BOARD_RESTITUTION * 0.8);
    expect(after.vy).toBeLessThan(300 * FOOTBALL_BOARD_RESTITUTION);
    expect(after.vx).toBeGreaterThan(30);
    for (const state of states) expect(state.y).toBeGreaterThanOrEqual(Y0 + R - 1e-9);
  });

  it('comes back off the goal line either side of a goal, and off the south board', () => {
    for (const [x, y, vx, vy] of [
      [X1 - R - 2, MID - HALF_MOUTH - 2 * T, 300, 0],
      [X0 + R + 2, MID + HALF_MOUTH + 3 * T, -300, 0],
      [FOOTBALL_CENTRE.x, Y1 - R - 2, 0, 300],
    ] as const) {
      const { states, scored } = roll(ball(x, y, vx, vy), 3);
      const after = states[3]!;
      expect(Math.sign(after.vx) === -Math.sign(vx)).toBe(true);
      expect(Math.sign(after.vy) === -Math.sign(vy)).toBe(true);
      expect(scored).toEqual([]);
      for (const state of states) expect(contained(state), JSON.stringify(state)).toBe(true);
    }
  });

  it('never leaves the field or a goal, whatever it is shot at, over a long seeded run', () => {
    const random = mulberry32(20260930);
    for (let shot = 0; shot < 60; shot++) {
      const angle = random() * Math.PI * 2;
      const speed = FOOTBALL_MAX_SPEED * (0.3 + random() * 0.7);
      const start = ball(X0 + R + random() * (X1 - X0 - 2 * R), Y0 + R + random() * (Y1 - Y0 - 2 * R), Math.cos(angle) * speed, Math.sin(angle) * speed);
      for (const state of roll(start, 150).states) {
        expect(contained(state), `shot ${shot}: ${JSON.stringify(state)}`).toBe(true);
        expect([state.x, state.y, state.vx, state.vy].every(Number.isFinite)).toBe(true);
        expect(Math.hypot(state.vx, state.vy)).toBeLessThanOrEqual(FOOTBALL_MAX_SPEED + 1e-9);
      }
    }
  });
});

describe('the posts', () => {
  const postY = MID - HALF_MOUTH;
  const postX = X1 + POST_R;

  it('turns a ball struck straight at a post back onto the field: no goal', () => {
    const start = ball(X1 - 3 * T, postY, FOOTBALL_KICK_SPEED, 0);
    const { states, scored } = roll(start, 20);
    expect(scored).toEqual([]);
    expect(states.some((state) => state.vx < 0)).toBe(true);
    for (const state of states) expect(Math.hypot(state.x - postX, state.y - postY)).toBeGreaterThanOrEqual(R + POST_R - 1e-6);
  });

  it('lets a ball that clips the inside of a post go in off it, and one that clips its outside stay out', () => {
    // Inside: aimed a little inside the post, it glances into the goal.
    const inside = roll(ball(X1 - 3 * T, postY + R * 0.9, FOOTBALL_KICK_SPEED, 0), 20);
    expect(inside.scored).toEqual(['starks']);
    // Outside: a little outside it, it glances off onto the goal line's board and stays out.
    const outside = roll(ball(X1 - 3 * T, postY - R * 0.9, FOOTBALL_KICK_SPEED, 0), 20);
    expect(outside.scored).toEqual([]);
  });

  it('never lets even the fastest ball through a post', () => {
    for (let offset = -12; offset <= 12; offset += 1) {
      for (const [x, vx] of [[X1 - 3 * T, FOOTBALL_MAX_SPEED], [X0 + 3 * T, -FOOTBALL_MAX_SPEED]] as const) {
        const px = vx > 0 ? X1 + POST_R : X0 - POST_R;
        for (const py of [MID - HALF_MOUTH, MID + HALF_MOUTH]) {
          let current = ball(x, py + offset, vx, 0);
          for (let step = 0; step < 12; step++) {
            current = stepBall(current, FOOTBALL_TICK_MS).ball;
            expect(Math.hypot(current.x - px, current.y - py), `offset ${offset} step ${step}`).toBeGreaterThanOrEqual(R + POST_R - 1e-6);
          }
        }
      }
    }
  });
});

describe('goals', () => {
  it('scores for the Starks into the east goal and for the Snarks into the west goal', () => {
    expect(roll(ball(X1 - 3 * T, MID, FOOTBALL_KICK_SPEED, 0), 20).scored).toEqual(['starks']);
    expect(roll(ball(X0 + 3 * T, MID, -FOOTBALL_KICK_SPEED, 0), 20).scored).toEqual(['snarks']);
  });

  it('counts only a ball wholly over the line, between the posts', () => {
    expect(goalScoredBy(ball(X1 + R + 0.01, MID))).toBe('starks');
    expect(goalScoredBy(ball(X1 + R, MID))).toBeNull();
    expect(goalScoredBy(ball(X1, MID))).toBeNull();
    expect(goalScoredBy(ball(X0 - R - 0.01, MID + HALF_MOUTH - R))).toBe('snarks');
    expect(goalScoredBy(ball(X0 - R, MID))).toBeNull();
    // Level with a post or beyond it is not between the posts.
    expect(goalScoredBy(ball(X1 + R + 1, MID - HALF_MOUTH))).toBeNull();
    expect(goalScoredBy(ball(X1 + R + 1, MID + HALF_MOUTH + 1))).toBeNull();
    expect(goalScoredBy(ball(FOOTBALL_CENTRE.x, MID))).toBeNull();
  });

  it('counts a ball that crosses the line and comes back out of the net within one step', () => {
    // Just short of the line at full speed: over it, off the back of the net and
    // back toward the field, all inside one 40 ms step.
    const start = ball(X1 - R - 1, MID, FOOTBALL_MAX_SPEED, 0);
    const { ball: after, scored } = stepBall(start, FOOTBALL_TICK_MS);
    expect(scored).toBe('starks');
    expect(after.x).toBeLessThanOrEqual(X1 + DEPTH - R);
  });

  it('stops a ball in the net, which takes most of its pace', () => {
    const { states } = roll(ball(X1 - 2 * T, MID + 10, FOOTBALL_KICK_SPEED, 0), 60);
    const last = states[states.length - 1]!;
    expect(last.x).toBeGreaterThan(X1 - T);
    for (const state of states) expect(state.x).toBeLessThanOrEqual(X1 + DEPTH - R + 1e-9);
  });
});

describe('kicks', () => {
  it('sends the ball at kick speed straight away from the kicker, through the ball\'s centre', () => {
    const at = ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y);
    const kicked = kickBall(at, { x: at.x - 20, y: at.y - 15 })!;
    expect(Math.hypot(kicked.vx, kicked.vy)).toBeCloseTo(FOOTBALL_KICK_SPEED, 9);
    expect(kicked.vx / kicked.vy).toBeCloseTo(20 / 15, 9);
    expect([kicked.x, kicked.y]).toEqual([at.x, at.y]);
    expect(Object.isFrozen(kicked)).toBe(true);
  });

  it('reaches exactly FOOTBALL_KICK_RANGE tiles, centre to centre, and no further', () => {
    const at = ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y);
    const reach = FOOTBALL_KICK_RANGE * T;
    expect(kickBall(at, { x: at.x - reach + 1e-9, y: at.y })).not.toBeNull();
    expect(kickBall(at, { x: at.x - reach - 0.01, y: at.y })).toBeNull();
    expect(kickBall(at, { x: at.x + reach * 0.75, y: at.y + reach * 0.75 })).toBeNull();
  });

  it('kicks along the facing only from on top of the ball, and refuses anything not a number', () => {
    const at = ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y);
    expect(kickBall(at, { x: at.x, y: at.y }, 'up')).toMatchObject({ vx: 0, vy: -FOOTBALL_KICK_SPEED });
    expect(kickBall(at, { x: at.x + 1, y: at.y }, 'right')).toMatchObject({ vx: FOOTBALL_KICK_SPEED, vy: 0 });
    expect(kickBall(at, { x: at.x, y: at.y }, 'sideways' as never)).toMatchObject({ vx: 0, vy: FOOTBALL_KICK_SPEED });
    for (const player of [{ x: Number.NaN, y: at.y }, { x: '1', y: at.y }, null, undefined, { x: at.x }]) {
      expect(kickBall(at, player as never)).toBeNull();
    }
    expect(kickBall(ball(Number.NaN, 0), { x: 0, y: 0 })).toBeNull();
  });

  it('is refused by the authority while the ball is at rest for want of anyone near, and during a goal', () => {
    const paused = createFootballAuthority();
    expect(paused.kick({ x: FOOTBALL_CENTRE.x - 20, y: FOOTBALL_CENTRE.y })).toBe(false);
    const { authority, run } = match(ball(X1 - 2 * T, MID, FOOTBALL_KICK_SPEED, 0));
    expect(run(400).map((event) => event.kind)).toEqual(['goal']);
    const snapshot = authority.snapshot();
    expect(authority.kick({ x: snapshot.x - 20, y: snapshot.y })).toBe(false);
    expect(authority.snapshot()).toBe(snapshot);
  });
});

describe('dribbling', () => {
  it('sends a still ball on ahead of a player who walks into it, faster than they walk', () => {
    const { authority, now, run } = match();
    const start = authority.snapshot();
    const walk = 160;
    const players = (t: number): FootballPlayer[] => [{ key: 'walker', x: start.x - 40 + (walk * (t - now0)) / 1000, y: start.y, at: t }];
    const now0 = now();
    let pushed = false;
    for (let i = 0; i < 20; i++) {
      run(FOOTBALL_TICK_MS, players(now()));
      const snapshot = authority.snapshot();
      if (snapshot.vx > 0) {
        pushed = true;
        expect(snapshot.vx).toBeGreaterThan(walk);
        expect(snapshot.vx).toBeLessThan(walk * 1.6);
        expect(snapshot.x - players(now())[0]!.x).toBeGreaterThanOrEqual(R + FOOTBALL_PLAYER_RADIUS - 1e-6);
        break;
      }
    }
    expect(pushed).toBe(true);
  });

  it('bounces a ball softly off a player who stands still, and never moves them', () => {
    const { authority, run } = match(ball(FOOTBALL_CENTRE.x - 60, FOOTBALL_CENTRE.y, 200, 0));
    const player: FootballPlayer = { key: 'wall', x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, at: 0 };
    run(600, [player]);
    const after = authority.snapshot();
    expect(after.vx).toBeLessThanOrEqual(0);
    expect(after.x).toBeLessThan(player.x - R - FOOTBALL_PLAYER_RADIUS + 1e-6);
  });

  it('ignores malformed players rather than trusting them', () => {
    const { authority, run } = match();
    const before = authority.snapshot();
    run(200, [
      { key: 1, x: before.x, y: before.y, at: 0 },
      { key: 'a', x: Number.NaN, y: before.y, at: 0 },
      { key: 'b', x: before.x, y: before.y },
      null,
      'player',
    ] as never);
    expect(authority.snapshot()).toMatchObject({ x: before.x, y: before.y, vx: 0, vy: 0 });
  });
});

describe('the match (D-078)', () => {
  /** A ball already on its way into `side`'s target: the Starks' into the east goal. */
  const shotFor = (side: FootballSide): BallState =>
    side === 'starks' ? ball(X1 - 2 * T, MID, FOOTBALL_KICK_SPEED, 0) : ball(X0 + 2 * T, MID, -FOOTBALL_KICK_SPEED, 0);

  it('counts a goal once, celebrates it, then kicks off from the centre spot at rest', () => {
    const { authority, run } = match(shotFor('starks'));
    const events = run(400);
    expect(events).toEqual([{ kind: 'goal', side: 'starks' }]);
    expect(authority.snapshot()).toMatchObject({ starks: 1, snarks: 0, phase: 'goal' });
    // The ball stays dead in the net for the celebration, and nothing is counted twice.
    // The goal went in during the first 400 ms, so its celebration runs past 2.5 s.
    expect(run(FOOTBALL_GOAL_MS - 600)).toEqual([]);
    expect(authority.snapshot()).toMatchObject({ starks: 1, snarks: 0, phase: 'goal' });
    expect(run(800)).toEqual([{ kind: 'kick-off' }]);
    expect(authority.snapshot()).toMatchObject({ x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0, starks: 1, snarks: 0, phase: 'live' });
  });

  it('plays to FOOTBALL_WIN_SCORE, holds a FULL TIME moment naming the winner, then starts again from 0-0', () => {
    const authority = createFootballAuthority({ ball: shotFor('snarks') });
    let clock = 0;
    authority.resume(clock);
    const events: FootballEvent[] = [];
    const run = (ms: number): void => {
      const until = clock + ms;
      while (clock < until) {
        clock += FOOTBALL_TICK_MS;
        events.push(...authority.advance(clock, []));
      }
    };
    for (let goal = 1; goal <= FOOTBALL_WIN_SCORE; goal++) {
      run(400);
      expect(authority.snapshot().snarks).toBe(goal);
      run(FOOTBALL_GOAL_MS);
      if (goal < FOOTBALL_WIN_SCORE) {
        expect(authority.snapshot().phase).toBe('live');
        // The next shot, from where the kick-off left the ball.
        const spot = authority.snapshot();
        expect(authority.kick({ x: spot.x + 20, y: spot.y })).toBe(true);
        run(1800);
      }
    }
    expect(authority.snapshot()).toMatchObject({ snarks: FOOTBALL_WIN_SCORE, starks: 0, phase: 'full-time' });
    expect(events.filter((event) => event.kind === 'full-time')).toEqual([{ kind: 'full-time', winner: 'snarks' }]);
    run(FOOTBALL_FULL_TIME_MS);
    expect(authority.snapshot()).toMatchObject({ starks: 0, snarks: 0, phase: 'live', x: FOOTBALL_CENTRE.x, vx: 0 });
    expect(events.map((event) => event.kind).filter((kind) => kind !== 'kick-off')).toEqual([
      ...Array.from({ length: FOOTBALL_WIN_SCORE }, () => 'goal'),
      'full-time',
    ]);
  });

  it('names no player anywhere: a snapshot holds the ball, the score and the phase', () => {
    const { authority, run } = match(shotFor('starks'));
    run(400, [{ key: 'secret-session', x: 1, y: 1, at: 0 }]);
    const snapshot = authority.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['phase', 'snarks', 'starks', 'tick', 'vx', 'vy', 'x', 'y']);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe('the clock', () => {
  it('steps on whole ticks of the caller\'s clock, and dates each snapshot by its tick', () => {
    const authority = createFootballAuthority({ ball: ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y, 100, 0) });
    authority.resume(1000);
    expect(authority.snapshot().tick).toBe(1000 / FOOTBALL_TICK_MS);
    authority.advance(1039, []);
    expect(authority.snapshot().tick).toBe(25);
    authority.advance(1040, []);
    expect(authority.snapshot().tick).toBe(26);
    authority.advance(1200, []);
    expect(authority.snapshot().tick).toBe(30);
  });

  it('comes to rest when paused, simulates none of the pause, and keeps a celebration\'s time left', () => {
    const { authority, now, run } = match(ball(X1 - 2 * T, MID, FOOTBALL_KICK_SPEED, 0));
    // Step to the goal, then 400 ms into its celebration.
    while (run(FOOTBALL_TICK_MS).length === 0) {
      // keep stepping
    }
    expect(authority.snapshot().phase).toBe('goal');
    run(400);
    const left = Math.ceil(FOOTBALL_GOAL_MS / FOOTBALL_TICK_MS) * FOOTBALL_TICK_MS - 400;
    authority.pause();
    expect(authority.running).toBe(false);
    expect(authority.snapshot()).toMatchObject({ vx: 0, vy: 0 });
    expect(authority.advance(now() + 60_000, [])).toEqual([]);
    const back = now() + 60_000;
    authority.resume(back);
    expect(authority.snapshot().tick).toBe(Math.floor(back / FOOTBALL_TICK_MS));
    // The celebration picks up where it stopped: not over at once, over after what was left.
    const events: Array<[number, FootballEvent]> = [];
    for (let t = back + FOOTBALL_TICK_MS; t <= back + left + 200; t += FOOTBALL_TICK_MS) {
      for (const event of authority.advance(t, [])) events.push([t - back, event]);
    }
    expect(events).toEqual([[left, { kind: 'kick-off' }]]);
  });

  it('catches up at most FOOTBALL_MAX_CATCH_UP steps and drops the rest of a stall', () => {
    const authority = createFootballAuthority({ ball: ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y, 100, 0) });
    authority.resume(0);
    const before = authority.snapshot().x;
    authority.advance(10_000, []);
    const moved = authority.snapshot().x - before;
    expect(moved).toBeLessThan((100 * FOOTBALL_MAX_CATCH_UP * FOOTBALL_TICK_MS) / 1000 + 1e-6);
    expect(authority.snapshot().tick).toBe(10_000 / FOOTBALL_TICK_MS);
  });

  it('ignores a clock that is not a number, and does the same thing twice from the same inputs', () => {
    const first = match(ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y, 250, 120));
    const second = match(ball(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y, 250, 120));
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '5' as never]) expect(first.authority.advance(bad, [])).toEqual([]);
    const players = [{ key: 'p', x: FOOTBALL_CENTRE.x + 120, y: FOOTBALL_CENTRE.y + 40, at: 0 }];
    first.run(3000, players);
    second.run(3000, players);
    expect(first.authority.snapshot()).toEqual(second.authority.snapshot());
  });
});
