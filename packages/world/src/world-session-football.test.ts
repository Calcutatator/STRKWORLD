import { describe, expect, it } from 'vitest';
import { FOOTBALL_KICK_RANGE, PITCH_FIELD, type WorldEvents } from '@strkworld/shared';
import {
  normalizeFootballFrame,
  normalizeFootballMoment,
  type FootballChannel,
  type FootballFrame,
  type FootballMoment,
} from './football-channel.js';
import { PITCH_CENTRE_SPOT } from './map/pitch.js';
import { TILE_SIZE } from './map/street.js';
import type { MovementInput } from './street-movement.js';
import { createWorldSession, type WorldKeyboard, type WorldSession, type WorldSessionView } from './world-session.js';

/**
 * The football inside the gameplay session (D-078): the ball drawn where the
 * channel says, "E · KICK" exactly while a kick would reach it, E sending the
 * kick, and the pitch's moments reaching the view. The session never moves
 * the ball.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const T = TILE_SIZE;
/** The centre spot in World pixels. */
const SPOT = { x: PITCH_CENTRE_SPOT.x * T, y: PITCH_CENTRE_SPOT.z * T };

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    press(event: 'keydown-E' | 'keydown-F', repeat?: boolean): void;
    count(event: string): number;
  } = {
    enabled: true,
    get held() {
      return this.enabled ? pressed : NO_KEYS;
    },
    sprinting: false,
    disableGlobalCapture() {},
    enableGlobalCapture() {},
    resetKeys() {
      pressed = NO_KEYS;
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return undefined;
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
      return undefined;
    },
    hold(keys) {
      pressed = { ...NO_KEYS, ...keys };
    },
    press(event, repeat = false) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ repeat, target: null });
    },
    count(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
  return keyboard;
}

/** A channel the test steers: the frame it hands out, the kicks it hears, and moments it sends. */
function fakeChannel(initial: FootballFrame | null) {
  let frame: unknown = initial;
  const listeners = new Set<(moment: FootballMoment) => void>();
  const channel = {
    kicks: 0,
    frames: 0,
    frame() {
      channel.frames += 1;
      return frame as FootballFrame | null;
    },
    subscribeMoments(listener: (moment: FootballMoment) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    kick() {
      channel.kicks += 1;
    },
  } satisfies FootballChannel & { kicks: number; frames: number };
  return {
    channel,
    set(next: unknown) {
      frame = next;
    },
    moment(value: unknown) {
      for (const listener of [...listeners]) listener(value as FootballMoment);
    },
    listening: () => listeners.size,
  };
}

const ball = (x: number, y: number, phase: FootballFrame['phase'] = 'live'): FootballFrame =>
  Object.freeze({ x, y, vx: 0, vy: 0, west: 0, east: 0, phase });

function setup(frame: FootballFrame | null = ball(SPOT.x, SPOT.y)) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
    },
  });
  const keyboard = fakeKeyboard();
  const football = fakeChannel(frame);
  const emitted: Array<keyof WorldEvents> = [];
  const session = createWorldSession({
    view,
    keyboard,
    football: football.channel,
    config: { out: { emit: (event) => emitted.push(event) } },
  });
  /** Put the player at World pixels (x, y) and run one frame there. */
  const standAt = (x: number, y: number): void => {
    (session as unknown as { position: { x: number; y: number } }).position = { x, y };
    session.update(16);
  };
  return {
    session: session as WorldSession,
    keyboard,
    football,
    emitted,
    calls,
    standAt,
    of: (method: string) => calls.filter((call) => call.method === method).map((call) => call.args),
  };
}

describe('the football in the session (D-078)', () => {
  it('draws the ball the channel hands out, every street frame, and never moves it itself', () => {
    const world = setup();
    world.standAt(SPOT.x - 5 * T, SPOT.y + 3 * T);
    world.standAt(SPOT.x - 5 * T, SPOT.y + 3 * T);
    expect(world.of('setFootball')).toEqual([[ball(SPOT.x, SPOT.y)], [ball(SPOT.x, SPOT.y)]]);
    world.football.set(ball(SPOT.x + 40, SPOT.y));
    world.standAt(SPOT.x - 5 * T, SPOT.y + 3 * T);
    expect(world.of('setFootball').at(-1)).toEqual([ball(SPOT.x + 40, SPOT.y)]);
    expect(world.football.channel.kicks).toBe(0);
  });

  it('shows "E · KICK" exactly while the player is within kick range of a ball in play', () => {
    const world = setup();
    const reach = FOOTBALL_KICK_RANGE * T;
    world.standAt(SPOT.x - reach - 4, SPOT.y);
    expect(world.of('setKickPrompt')).toEqual([]);
    world.standAt(SPOT.x - reach + 4, SPOT.y);
    world.standAt(SPOT.x - 10, SPOT.y);
    expect(world.of('setKickPrompt')).toEqual([[true]]);
    world.standAt(SPOT.x - reach - 4, SPOT.y);
    expect(world.of('setKickPrompt')).toEqual([[true], [false]]);
    // No prompt while the ball is dead after a goal, or at full time.
    for (const phase of ['goal', 'full-time'] as const) {
      world.football.set(ball(SPOT.x, SPOT.y, phase));
      world.standAt(SPOT.x - 10, SPOT.y);
      expect(world.of('setKickPrompt').at(-1)).toEqual([false]);
    }
  });

  it('kicks on E while the prompt shows, and only then', () => {
    const world = setup();
    world.standAt(SPOT.x - 4 * T, SPOT.y);
    world.keyboard.press('keydown-E');
    expect(world.football.channel.kicks).toBe(0);
    world.standAt(SPOT.x - 20, SPOT.y);
    world.keyboard.press('keydown-E');
    expect(world.football.channel.kicks).toBe(1);
    // A held key repeats: that is not a second kick.
    world.keyboard.press('keydown-E', true);
    expect(world.football.channel.kicks).toBe(1);
    // Nothing the World emits says the player kicked.
    expect(world.emitted.filter((event) => event !== 'player:moved')).toEqual([]);
  });

  it('draws no ball, and no prompt, for a frame that is not a frame', () => {
    const world = setup();
    world.standAt(SPOT.x - 20, SPOT.y);
    expect(world.of('setKickPrompt')).toEqual([[true]]);
    for (const bad of [null, { ...ball(SPOT.x, SPOT.y), x: Number.NaN }, { ...ball(SPOT.x, SPOT.y), west: 9 }, { ...ball(SPOT.x, SPOT.y), phase: 'extra-time' }, 'ball']) {
      world.football.set(bad);
      world.standAt(SPOT.x - 20, SPOT.y);
      expect(world.of('setFootball').at(-1)).toEqual([null]);
    }
    expect(world.of('setKickPrompt').at(-1)).toEqual([false]);
    world.keyboard.press('keydown-E');
    expect(world.football.channel.kicks).toBe(0);
    // A missing ball is cleared once, not every frame.
    const cleared = world.of('setFootball').length;
    world.standAt(SPOT.x - 20, SPOT.y);
    expect(world.of('setFootball')).toHaveLength(cleared);
  });

  it('survives a channel that throws, drawing no ball', () => {
    const world = setup();
    world.football.channel.frame = () => {
      throw new Error('channel failed');
    };
    expect(() => world.standAt(SPOT.x - 20, SPOT.y)).not.toThrow();
  });

  it('hands the view each goal and full time, validated, and drops anything else', () => {
    const world = setup();
    world.football.moment({ kind: 'goal', side: 'west' });
    world.football.moment({ kind: 'goal', side: 'north' });
    world.football.moment({ kind: 'full-time', winner: 'east', west: 2, east: 5 });
    world.football.moment({ kind: 'full-time', winner: 'west', west: 2, east: 5 });
    world.football.moment({ kind: 'goal', side: 'east', scorer: 'someone' });
    expect(world.of('footballMoment')).toEqual([
      [{ kind: 'goal', side: 'west' }],
      [{ kind: 'full-time', winner: 'east', west: 2, east: 5 }],
      [{ kind: 'goal', side: 'east' }],
    ]);
    expect(JSON.stringify(world.of('footballMoment'))).not.toContain('someone');
  });

  it('lets go of the channel and the key on destroy', () => {
    const world = setup();
    expect(world.football.listening()).toBe(1);
    // The plaza's E and the ball's.
    expect(world.keyboard.count('keydown-E')).toBe(2);
    world.session.destroy();
    expect(world.football.listening()).toBe(0);
    expect(world.keyboard.count('keydown-E')).toBe(0);
    world.football.moment({ kind: 'goal', side: 'west' });
    expect(world.of('footballMoment')).toEqual([]);
  });
});

describe('the football channel\'s frames and moments (D-078)', () => {
  it('accepts a ball on the pitch and freezes it, and refuses a ball off it', () => {
    const good = normalizeFootballFrame({ x: SPOT.x, y: SPOT.y, vx: 100, vy: -40, west: 3, east: 5, phase: 'goal', extra: 1 });
    expect(good).toEqual({ x: SPOT.x, y: SPOT.y, vx: 100, vy: -40, west: 3, east: 5, phase: 'goal' });
    expect(Object.isFrozen(good)).toBe(true);
    const bad = [
      { ...ball(SPOT.x, SPOT.y), x: 40 * T },
      { ...ball(SPOT.x, SPOT.y), y: -2 * T },
      { ...ball(SPOT.x, SPOT.y), vx: 5_000 },
      { ...ball(SPOT.x, SPOT.y), east: -1 },
      { ...ball(SPOT.x, SPOT.y), west: 1.5 },
      { ...ball(SPOT.x, SPOT.y), phase: 1 },
      { ...ball(SPOT.x, SPOT.y), x: String(SPOT.x) },
      Object.defineProperty({ ...ball(SPOT.x, SPOT.y) }, 'x', { get: () => { throw new Error('trap'); } }),
    ];
    for (const value of bad) expect(normalizeFootballFrame(value)).toBeNull();
    // The goals' nets lie just past the field, inside the square.
    expect(normalizeFootballFrame(ball((PITCH_FIELD.x - 0.8) * T, SPOT.y))).not.toBeNull();
  });

  it('believes a full-time moment only when its winner is ahead', () => {
    expect(normalizeFootballMoment({ kind: 'full-time', winner: 'west', west: 5, east: 3 })).toEqual({ kind: 'full-time', winner: 'west', west: 5, east: 3 });
    expect(normalizeFootballMoment({ kind: 'full-time', winner: 'west', west: 3, east: 5 })).toBeNull();
    expect(normalizeFootballMoment({ kind: 'full-time', winner: 'east', west: 4, east: 4 })).toBeNull();
    expect(normalizeFootballMoment({ kind: 'full-time', winner: 'east', west: 1, east: 9 })).toBeNull();
    expect(normalizeFootballMoment({ kind: 'kick-off' })).toBeNull();
    expect(normalizeFootballMoment(null)).toBeNull();
  });
});
