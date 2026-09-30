import { Encoder, Reflection } from '@colyseus/schema';
import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_TICK_MS,
  PITCH_FIELD,
  PITCH_GOAL,
  STREET_ORIGIN_X,
  type FootballSnapshot,
} from '@strkworld/shared';
import {
  DEFAULT_ROOM_CONFIG,
  FOOTBALL_CLIENT_KICK_INTERVAL_MS,
  FOOTBALL_MIN_KICK_INTERVAL_MS,
  resolveRoomConfig,
} from './config';
import { FOOTBALL_PHASE_CODES, FOOTBALL_WIRE_SCALE, toWire } from './football';
import {
  FOOTBALL_CENTRE,
  FOOTBALL_KICK_SPEED,
  FOOTBALL_TILE_SIZE,
  type BallState,
} from './football-rules';
import { LobbyPresence } from './presence';

/**
 * The room's football without a transport (D-078): the kick floor and rules
 * behind the registry, the mirror in the room schema, and what a real decoder
 * reads from it.
 */

const T = FOOTBALL_TILE_SIZE;
const X1 = (PITCH_FIELD.x + PITCH_FIELD.width) * T;
const MID = (PITCH_FIELD.y + PITCH_FIELD.height / 2) * T;
const FLOOR = FOOTBALL_MIN_KICK_INTERVAL_MS;

/** A registry, a session beside the centre spot, and a clock to step it with. */
function pitchWith(ball?: BallState) {
  const registry = new LobbyPresence(ball ? { footballBall: ball } : {});
  let now = 10_000;
  const join = (key: string, x: number, y: number): void => {
    const outcome = registry.admit(key, { x, y, facing: 'right' });
    if (!outcome.ok) throw new Error(outcome.reason);
  };
  const step = (ms: number) => {
    const events = [];
    const until = now + ms;
    while (now < until) {
      now += FOOTBALL_TICK_MS;
      events.push(...registry.footballTick(now));
    }
    return events;
  };
  return { registry, join, step, now: () => now, advanceClock: (ms: number) => (now += ms) };
}

/** What the mirror in room state holds, as the room would encode it. */
function mirrorOf(registry: LobbyPresence): Record<string, number> {
  return (registry.state as unknown as { football: { toJSON(): Record<string, number> } }).football.toJSON();
}

describe('the kick (D-078)', () => {
  it('kicks from the position the registry holds, away from the kicker, and names nobody in state', () => {
    const { registry, join, now } = pitchWith();
    join('a', FOOTBALL_CENTRE.x - 24, FOOTBALL_CENTRE.y);
    expect(registry.keepFootballRunning(now())).toBe(true);
    expect(registry.kickBall('a', now())).toBe('applied');
    const snapshot = registry.footballSnapshot();
    expect(snapshot.vx).toBeCloseTo(FOOTBALL_KICK_SPEED, 6);
    expect(snapshot.vy).toBe(0);
    expect(JSON.stringify(registry.state)).not.toContain('"a"');
  });

  it('refuses a kick from out of reach, from a suspended or unknown session, and while nobody is near', () => {
    const { registry, join, now } = pitchWith();
    join('far', FOOTBALL_CENTRE.x - 3 * T, FOOTBALL_CENTRE.y);
    registry.keepFootballRunning(now());
    expect(registry.kickBall('far', now())).toBe('rejected');
    expect(registry.kickBall('ghost', now())).toBe('absent');
    join('near', FOOTBALL_CENTRE.x - 24, FOOTBALL_CENTRE.y);
    registry.suspend('near');
    expect(registry.kickBall('near', now() + FLOOR)).toBe('absent');
    // Nobody left near the pitch: the ball is at rest and takes no kicks.
    registry.release('far');
    expect(registry.keepFootballRunning(now())).toBe(false);
    expect(registry.footballSnapshot()).toMatchObject({ vx: 0, vy: 0 });
  });

  it('holds each session to its floor, even for a kick the rules refuse', () => {
    const { registry, join, now } = pitchWith();
    join('a', FOOTBALL_CENTRE.x - 3 * T, FOOTBALL_CENTRE.y);
    join('b', FOOTBALL_CENTRE.x + 24, FOOTBALL_CENTRE.y);
    registry.keepFootballRunning(now());
    expect(registry.kickBall('a', now())).toBe('rejected');
    // The refusal cost a's floor; b has its own.
    expect(registry.kickBall('a', now() + FLOOR - 1)).toBe('throttled');
    expect(registry.kickBall('b', now() + 1)).toBe('applied');
    expect(registry.kickBall('b', now() + FLOOR)).toBe('throttled');
    expect(registry.kickBall('b', now() + FLOOR + 1)).toBe('applied');
  });

  it('keeps the kick floor clamped to [50, the client\'s own floor], and never off', () => {
    expect(DEFAULT_ROOM_CONFIG.footballKickIntervalMs).toBe(FOOTBALL_MIN_KICK_INTERVAL_MS);
    expect(FOOTBALL_MIN_KICK_INTERVAL_MS).toBeLessThan(FOOTBALL_CLIENT_KICK_INTERVAL_MS);
    expect(resolveRoomConfig({ footballKickIntervalMs: 0 }).footballKickIntervalMs).toBe(50);
    expect(resolveRoomConfig({ footballKickIntervalMs: 10_000 }).footballKickIntervalMs).toBe(FOOTBALL_CLIENT_KICK_INTERVAL_MS);
    expect(resolveRoomConfig({ footballKickIntervalMs: Number.NaN }).footballKickIntervalMs).toBe(FOOTBALL_MIN_KICK_INTERVAL_MS);
  });
});

describe('the ball runs while someone is near the pitch (D-078)', () => {
  it('starts with someone on the pitch or the street in sight of it, and stops when they go', () => {
    const { registry, join, now } = pitchWith();
    expect(registry.keepFootballRunning(now())).toBe(false);
    join('spawn', (STREET_ORIGIN_X + 24) * T + 16, 15 * T + 16);
    expect(registry.keepFootballRunning(now())).toBe(false);
    join('gate', (STREET_ORIGIN_X + 2) * T, 15 * T);
    expect(registry.keepFootballRunning(now())).toBe(true);
    expect(registry.footballRunning).toBe(true);
    registry.suspend('gate');
    expect(registry.keepFootballRunning(now())).toBe(false);
  });

  it('pushes the ball with a player who walks into it, reading their speed from their moves', () => {
    const { registry, join, step, now } = pitchWith();
    const y = FOOTBALL_CENTRE.y;
    let x = FOOTBALL_CENTRE.x - 60;
    join('walker', x, y);
    registry.keepFootballRunning(now());
    // Walking east at 160 px/s: a move every tick, as a client sends them.
    for (let t = 0; t < 30 && registry.footballSnapshot().vx === 0; t++) {
      x += (160 * FOOTBALL_TICK_MS) / 1000;
      registry.move('walker', { x, y, facing: 'right' }, now());
      step(FOOTBALL_TICK_MS);
    }
    const snapshot = registry.footballSnapshot();
    // The ball goes on ahead, faster than the walker.
    expect(snapshot.vx).toBeGreaterThan(160);
    expect(snapshot.x).toBeGreaterThan(x);
  });
});

describe('the mirror in room state (D-078)', () => {
  it('holds the ball, the score, the phase byte and the tick, and nothing else', () => {
    const { registry } = pitchWith();
    const mirror = mirrorOf(registry);
    expect(Object.keys(mirror).sort()).toEqual(['east', 'phase', 'tick', 'vx', 'vy', 'west', 'x', 'y']);
    // In whole 64ths of a pixel, so the state holds whole numbers only.
    expect(FOOTBALL_WIRE_SCALE).toBe(64);
    expect(mirror).toMatchObject({ x: FOOTBALL_CENTRE.x * 64, y: FOOTBALL_CENTRE.y * 64, vx: 0, vy: 0, west: 0, east: 0, phase: 0 });
    expect(Object.values(mirror).every(Number.isInteger)).toBe(true);
    expect(FOOTBALL_PHASE_CODES).toEqual({ live: 0, goal: 1, 'full-time': 2 });
    expect(toWire(1.2345)).toBe(79);
  });

  it('writes nothing while the ball is at rest, so a still ball costs no patch', () => {
    const { registry, join, step, now } = pitchWith();
    join('a', FOOTBALL_CENTRE.x - 3 * T, FOOTBALL_CENTRE.y);
    registry.keepFootballRunning(now());
    const encoder = new Encoder(registry.state);
    encoder.encodeAll();
    encoder.discardChanges();
    step(400);
    expect(encoder.hasChanges).toBe(false);
    // A kick is a change, dated by the tick it happened on.
    registry.move('a', { x: FOOTBALL_CENTRE.x - 24, y: FOOTBALL_CENTRE.y, facing: 'right' }, now());
    encoder.discardChanges();
    expect(registry.kickBall('a', now())).toBe('applied');
    expect(encoder.hasChanges).toBe(true);
    expect(mirrorOf(registry).tick).toBe(registry.footballSnapshot().tick);
  });

  it('reaches a real decoder as the authority holds it, through a goal and the kick-off', () => {
    const shot: BallState = { x: X1 - 2 * T, y: MID, vx: FOOTBALL_KICK_SPEED, vy: 0 };
    const { registry, join, step, now } = pitchWith(shot);
    join('a', FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y + 5 * T);
    registry.keepFootballRunning(now());
    const encoder = new Encoder(registry.state);
    const decoder = Reflection.decode(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());
    const read = (): Record<string, number> => {
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      return (decoder.state as unknown as { football: { toJSON(): Record<string, number> } }).football.toJSON();
    };
    // A moving ball is dated by the step it is from; a still one by when it stopped.
    const same = (wire: Record<string, number>, truth: FootballSnapshot): void => {
      if (truth.vx !== 0 || truth.vy !== 0) expect(wire.tick).toBe(truth.tick);
      else expect(wire.tick).toBeLessThanOrEqual(truth.tick);
      for (const key of ['x', 'y', 'vx', 'vy'] as const) {
        expect(Number.isInteger(wire[key])).toBe(true);
        expect(Math.abs(wire[key]! / FOOTBALL_WIRE_SCALE - truth[key])).toBeLessThanOrEqual(0.5 / FOOTBALL_WIRE_SCALE);
      }
      expect([wire.west, wire.east, wire.phase]).toEqual([truth.west, truth.east, FOOTBALL_PHASE_CODES[truth.phase]]);
    };
    same(read(), registry.footballSnapshot());
    const events = step(400);
    expect(events).toEqual([{ kind: 'goal', side: 'west' }]);
    same(read(), registry.footballSnapshot());
    expect(read()).toMatchObject({ west: 1, east: 0, phase: 1 });
    step(3000);
    same(read(), registry.footballSnapshot());
    expect(read()).toMatchObject({ x: FOOTBALL_CENTRE.x * FOOTBALL_WIRE_SCALE, phase: 0 });
    // The mouth the goal went into: between the posts.
    expect(Math.abs(shot.y - MID)).toBeLessThan((PITCH_GOAL.width / 2) * T);
  });
});
