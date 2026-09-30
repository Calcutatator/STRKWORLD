import { describe, expect, it } from 'vitest';
import { FOOTBALL_TICK_MS, type FootballSnapshot } from '@strkworld/shared';
import {
  FOOTBALL_CENTRE,
  FOOTBALL_KICK_SPEED,
  FOOTBALL_PLAYER_RADIUS,
  FOOTBALL_TILE_SIZE,
  createFootballAuthority,
  type BallState,
} from '@strkworld/lobby/football';
import {
  CORRECTION_MS,
  KICK_RESPONSE_MS,
  MAX_EXTRAPOLATION_MS,
  SNAP_DISTANCE,
  createBallPresenter,
  type LocalPlayer,
} from './ball-presenter.js';

/**
 * The ball the Shell draws (D-078): the authority's latest state carried on
 * to the present, whatever latency and jitter do to its patches, corrections
 * eased in, and the local player's own touches answered at once.
 */

const T = FOOTBALL_TILE_SIZE;
const R = 0.25 * T;

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

const snapshot = (tick: number, ball: BallState, extra: Partial<FootballSnapshot> = {}): FootballSnapshot =>
  Object.freeze({ tick, x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, west: 0, east: 0, phase: 'live', ...extra });

/**
 * A room: a real authority stepping a ball on its own clock, its states
 * dated by tick and sent at the patch rate (50 ms) with `latency` and up to
 * `jitter` ms of delay, never overtaking one another — what a websocket does.
 */
function room(options: { start: BallState; latency: number; jitter: number; seed?: number; untilMs: number }) {
  const authority = createFootballAuthority({ ball: options.start });
  authority.resume(0);
  const random = mulberry32(options.seed ?? 1);
  const truth = new Map<number, FootballSnapshot>();
  const arrivals: Array<{ at: number; snapshot: FootballSnapshot }> = [];
  let lastArrival = 0;
  for (let t = FOOTBALL_TICK_MS; t <= options.untilMs; t += FOOTBALL_TICK_MS) {
    authority.advance(t, []);
    truth.set(authority.snapshot().tick, authority.snapshot());
  }
  const replay = createFootballAuthority({ ball: options.start });
  replay.resume(0);
  for (let patch = 50; patch <= options.untilMs; patch += 50) {
    replay.advance(patch, []);
    const at = Math.max(lastArrival, patch + options.latency + random() * options.jitter);
    lastArrival = at;
    arrivals.push({ at, snapshot: replay.snapshot() });
  }
  /** Where the authority's ball truly is at server time `ms` (between two ticks, the earlier). */
  const at = (ms: number): FootballSnapshot => truth.get(Math.floor(ms / FOOTBALL_TICK_MS)) ?? authority.snapshot();
  return { arrivals, at };
}

/** Run a presenter over a room's arrivals, drawing at 60 fps from `from` to `to`. */
function watch(
  presenter: ReturnType<typeof createBallPresenter>,
  arrivals: ReadonlyArray<{ at: number; snapshot: FootballSnapshot }>,
  from: number,
  to: number,
  local: LocalPlayer | null = null,
): Array<{ t: number; x: number; y: number }> {
  const drawn: Array<{ t: number; x: number; y: number }> = [];
  let next = 0;
  for (let t = from; t <= to; t += 1000 / 60) {
    while (next < arrivals.length && arrivals[next]!.at <= t) {
      presenter.push(arrivals[next]!.snapshot, arrivals[next]!.at);
      next += 1;
    }
    const frame = presenter.frame(t, local);
    if (frame) drawn.push({ t, x: frame.x, y: frame.y });
  }
  return drawn;
}

describe('the ball the Shell draws (D-078)', () => {
  it('draws nothing before the authority has said anything, and a still ball where it says', () => {
    const presenter = createBallPresenter();
    expect(presenter.frame(0)).toBeNull();
    presenter.push(snapshot(10, { x: 400, y: 300, vx: 0, vy: 0 }, { west: 2, east: 1, phase: 'goal' }), 500);
    expect(presenter.frame(520)).toEqual({ x: 400, y: 300, vx: 0, vy: 0, west: 2, east: 1, phase: 'goal' });
    expect(Object.isFrozen(presenter.frame(520))).toBe(true);
    expect(presenter.frame(Number.NaN)).toBeNull();
  });

  it('carries a rolling ball on to the present through 100 ms of latency and 40 ms of jitter, smoothly', () => {
    const start: BallState = { x: FOOTBALL_CENTRE.x - 8 * T, y: FOOTBALL_CENTRE.y - 3 * T, vx: FOOTBALL_KICK_SPEED * 0.8, vy: FOOTBALL_KICK_SPEED * 0.45 };
    const latency = 100;
    const jitter = 40;
    const { arrivals, at } = room({ start, latency, jitter, untilMs: 3000 });
    const presenter = createBallPresenter();
    const drawn = watch(presenter, arrivals, 0, 3000);
    // Once a few patches have set the clocks, the ball is drawn where the authority has it
    // less than the fastest delivery ago, give or take a pixel or two.
    let worst = 0;
    for (const { t, x, y } of drawn.filter((d) => d.t > 400 && d.t < 2800)) {
      const truth = at(t - latency);
      const later = at(t - latency + FOOTBALL_TICK_MS);
      // Between two ticks the drawn ball lies between where the authority had it at each.
      const error = Math.min(Math.hypot(x - truth.x, y - truth.y), Math.hypot(x - later.x, y - later.y));
      worst = Math.max(worst, error);
    }
    expect(worst).toBeLessThan(0.5 * T);
    // Smooth: no frame jumps further than the ball could roll in it, plus a hair.
    let jump = 0;
    for (let i = 1; i < drawn.length; i++) {
      const step = Math.hypot(drawn[i]!.x - drawn[i - 1]!.x, drawn[i]!.y - drawn[i - 1]!.y);
      jump = Math.max(jump, step);
    }
    expect(jump).toBeLessThan((FOOTBALL_KICK_SPEED * (1000 / 60)) / 1000 + 3);
  });

  it('comes back off the boards as the authority does, while it waits for the next patch', () => {
    // Straight at the north touchline: the carried-on ball bounces, it does not go through.
    const start: BallState = { x: FOOTBALL_CENTRE.x, y: 7 * T + R + 20, vx: 0, vy: -FOOTBALL_KICK_SPEED };
    const presenter = createBallPresenter();
    presenter.push(snapshot(0, start), 0);
    const later = presenter.frame(MAX_EXTRAPOLATION_MS)!;
    expect(later.vy).toBeGreaterThan(0);
    expect(later.y).toBeGreaterThan(7 * T + R - 1e-6);
  });

  it('carries a ball on for at most MAX_EXTRAPOLATION_MS past its snapshot, then waits there', () => {
    const presenter = createBallPresenter();
    presenter.push(snapshot(0, { x: FOOTBALL_CENTRE.x - 5 * T, y: FOOTBALL_CENTRE.y, vx: 200, vy: 0 }), 0);
    const capped = presenter.frame(MAX_EXTRAPOLATION_MS)!;
    expect(presenter.frame(MAX_EXTRAPOLATION_MS + 2000)).toEqual(capped);
    expect(capped.x).toBeGreaterThan(FOOTBALL_CENTRE.x - 5 * T);
  });

  it('eases a correction in rather than jumping to it', () => {
    const presenter = createBallPresenter();
    const ball: BallState = { x: FOOTBALL_CENTRE.x - 5 * T, y: FOOTBALL_CENTRE.y, vx: 200, vy: 0 };
    presenter.push(snapshot(0, ball), 0);
    const before = presenter.frame(80)!;
    // Someone else pushed it sideways: the authority's next patch has it a tile north.
    presenter.push(snapshot(2, { x: before.x, y: before.y - T, vx: 200, vy: 0 }), 80);
    const now = presenter.frame(80)!;
    expect(now.y).toBeCloseTo(before.y, 6);
    const soon = presenter.frame(80 + CORRECTION_MS)!;
    expect(soon.y).toBeLessThan(before.y - T * 0.5);
    expect(soon.y).toBeGreaterThan(before.y - T);
    const settled = presenter.frame(80 + 6 * CORRECTION_MS)!;
    expect(settled.y).toBeCloseTo(before.y - T, 0);
  });

  it('draws a kick-off at the centre spot at once, and a jump past SNAP_DISTANCE likewise', () => {
    const presenter = createBallPresenter();
    presenter.push(snapshot(0, { x: 26 * T, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0 }, { phase: 'goal', west: 1 }), 0);
    presenter.push(snapshot(70, { ...FOOTBALL_CENTRE, vx: 0, vy: 0 }, { phase: 'live', west: 1 }), 2800);
    expect(presenter.frame(2800)).toMatchObject({ x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, phase: 'live', west: 1 });
    presenter.push(snapshot(71, { x: FOOTBALL_CENTRE.x - SNAP_DISTANCE - 10, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0 }), 2840);
    expect(presenter.frame(2840)!.x).toBe(FOOTBALL_CENTRE.x - SNAP_DISTANCE - 10);
  });

  it('answers the local player\'s kick at once, then hands back to the authority when it agrees', () => {
    const presenter = createBallPresenter();
    const still: BallState = { ...FOOTBALL_CENTRE, vx: 0, vy: 0 };
    presenter.push(snapshot(100, still), 4000);
    const kicker: LocalPlayer = { x: FOOTBALL_CENTRE.x - 24, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0, facing: 'right' };
    expect(presenter.kick(4010, kicker)).toBe(true);
    const moving = presenter.frame(4027, kicker)!;
    expect(moving.x).toBeGreaterThan(FOOTBALL_CENTRE.x + 4);
    // The room takes the kick 50 ms later, on its tick 101, and its patches follow
    // every 50 ms with 50 ms of latency: the kicked ball is dated a tick after the kick.
    const authority = createFootballAuthority({ ball: still });
    authority.resume(101 * FOOTBALL_TICK_MS);
    expect(authority.kick(kicker, 'right')).toBe(true);
    const patches: Array<{ at: number; snapshot: FootballSnapshot }> = [];
    for (let server = 101 * FOOTBALL_TICK_MS; server <= 4800; server += 50) {
      authority.advance(server, []);
      patches.push({ at: server + 50, snapshot: authority.snapshot() });
    }
    let previous = moving.x;
    let next = 0;
    for (let t = 4044; t <= 4010 + KICK_RESPONSE_MS + 400; t += 1000 / 60) {
      while (next < patches.length && patches[next]!.at <= t) {
        presenter.push(patches[next]!.snapshot, patches[next]!.at);
        next += 1;
      }
      const x = presenter.frame(t, kicker)!.x;
      // Never back toward the kicker, and never faster than the kick.
      expect(x).toBeGreaterThanOrEqual(previous - 1e-6);
      expect(x - previous).toBeLessThan((FOOTBALL_KICK_SPEED * 1.2) / 60 + 2);
      previous = x;
    }
  });

  it('eases the ball back when the authority refused the kick, and refuses to kick from out of reach or a dead ball', () => {
    const presenter = createBallPresenter();
    const still: BallState = { ...FOOTBALL_CENTRE, vx: 0, vy: 0 };
    presenter.push(snapshot(100, still), 4000);
    const far: LocalPlayer = { x: FOOTBALL_CENTRE.x - 3 * T, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0, facing: 'right' };
    expect(presenter.kick(4010, far)).toBe(false);
    const near: LocalPlayer = { ...far, x: FOOTBALL_CENTRE.x - 24 };
    expect(presenter.kick(4010, near)).toBe(true);
    // No kicked ball ever arrives: after the response the ball goes back where the authority has it.
    expect(presenter.frame(4010 + KICK_RESPONSE_MS + 10 * CORRECTION_MS, near)!.x).toBeCloseTo(FOOTBALL_CENTRE.x, 0);
    presenter.push(snapshot(101, still, { phase: 'goal' }), 5000);
    expect(presenter.kick(5010, near)).toBe(false);
  });

  it('pushes the ball on ahead of a local player who walks into it, without waiting for the authority', () => {
    const presenter = createBallPresenter();
    presenter.push(snapshot(100, { ...FOOTBALL_CENTRE, vx: 0, vy: 0 }), 4000);
    let x = FOOTBALL_CENTRE.x - 40;
    let pushed = false;
    for (let t = 4000; t < 4400; t += 1000 / 60) {
      x += 160 / 60;
      const walker: LocalPlayer = { x, y: FOOTBALL_CENTRE.y, vx: 160, vy: 0, facing: 'right' };
      const frame = presenter.frame(t, walker)!;
      // Never drawn inside the player.
      expect(Math.hypot(frame.x - x, frame.y - FOOTBALL_CENTRE.y)).toBeGreaterThanOrEqual(R + FOOTBALL_PLAYER_RADIUS - 1e-6);
      if (frame.vx > 160) pushed = true;
    }
    expect(pushed).toBe(true);
  });

  it('starts over for another authority: a tick from before the latest', () => {
    const presenter = createBallPresenter();
    presenter.push(snapshot(500, { x: 300, y: 300, vx: 0, vy: 0 }, { west: 4 }), 20_000);
    presenter.push(snapshot(3, { ...FOOTBALL_CENTRE, vx: 0, vy: 0 }), 20_100);
    expect(presenter.frame(20_100)).toMatchObject({ x: FOOTBALL_CENTRE.x, west: 0 });
    presenter.reset();
    expect(presenter.frame(20_200)).toBeNull();
  });
});
