import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOOTBALL_TICK_MS,
  FOOTBALL_WIN_SCORE,
  PITCH_FIELD,
  PITCH_GATES,
  STREET_ORIGIN_X,
  pitchTileCentre,
  type FootballGoal,
  type FootballSnapshot,
  type WorldEvents,
} from '@strkworld/shared';
import { FOOTBALL_CENTRE, FOOTBALL_KICK_SPEED, FOOTBALL_TILE_SIZE } from '@strkworld/lobby/football';
import { LobbyPresence } from '@strkworld/lobby/server';
import type { FootballMoment } from '@strkworld/world';
import { createEventBus } from '../bus/event-bus.js';
import { attachDebugTap, type DebugTap } from '../debug/debug-tap.js';
import { createFootballController, type FootballLobbyClient } from './football-controller.js';

/**
 * The Shell side of the football (D-078): the solo ball run on the lobby's
 * own rules, the lobby's ball when connected, one channel for the World
 * throughout, and the debug lines — by side at most.
 */

const T = FOOTBALL_TILE_SIZE;
const X1 = (PITCH_FIELD.x + PITCH_FIELD.width) * T;

/** A clock and timers the test drives: time moves only when it says so. */
function manualTime(start = 40_000) {
  let now = start;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      next += 1;
      pending.set(next, { at: now + ms, callback });
      return next;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Move the clock on by `ms`, running every timer that falls due, in order. */
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of pending) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = until;
    },
    get size() {
      return pending.size;
    },
  };
}

function fakeLobby(initial: FootballSnapshot | null = null) {
  let status: ((event: { status: string }) => void) | undefined;
  let state: ((snapshot: FootballSnapshot | null) => void) | undefined;
  let goals: ((goal: FootballGoal) => void) | undefined;
  let current = initial;
  const client: FootballLobbyClient & { kicks: number; accept: boolean } = {
    kicks: 0,
    accept: true,
    football: () => current,
    onFootball: (listener) => {
      state = listener;
      listener(current);
      return () => {
        state = undefined;
      };
    },
    onGoal: (listener) => {
      goals = listener;
      return () => {
        goals = undefined;
      };
    },
    kick() {
      this.kicks += 1;
      return this.accept;
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
  };
  return {
    client,
    status: (next: string) => status?.({ status: next }),
    publish: (snapshot: FootballSnapshot | null) => {
      current = snapshot;
      state?.(snapshot);
    },
    goal: (side: 'starks' | 'snarks') => goals?.({ side }),
    get listening() {
      return Boolean(state || goals);
    },
  };
}

function setup() {
  const time = manualTime();
  const controller = createFootballController({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const world = createEventBus<WorldEvents>();
  controller.listen(world);
  const moments: FootballMoment[] = [];
  controller.channel.subscribeMoments?.((moment) => moments.push(moment));
  const move = (
    x: number,
    y: number,
    facing: 'up' | 'down' | 'left' | 'right' = 'right',
    airborne = false,
  ) => world.emit('player:moved', { position: { x, y }, facing, ...(airborne ? { airborne: true } : {}) });
  return { controller, world, time, moments, move, frame: () => controller.channel.frame() };
}

/**
 * A room whose pitch is open and holds one player, for the comparisons below:
 * D-135 puts the ball inside a fence, so only a session the match says is
 * playing can dribble or kick it. Dummy fill is off, which leaves the match
 * `open` on one entrant — the phase where whoever is inside kicks freely,
 * which is the play these tests compare against. The player presses E at the
 * north gate, then walks to `at`.
 */
function roomWithPlayerOnPitch(at: { x: number; y: number }, now: number): LobbyPresence {
  const registry = new LobbyPresence({ minUpdateIntervalMs: 0, pitchDummyFill: false });
  const approach = pitchTileCentre({ x: PITCH_GATES[0]!.approach.x, y: PITCH_GATES[0]!.approach.y });
  expect(registry.admit('p', { x: Math.round(approach.x), y: Math.round(approach.y), facing: 'down' }).ok).toBe(true);
  expect(registry.pitchGate('p', now)).toBe('entered');
  expect(registry.pitchHoldsSlot('p')).toBe(true);
  expect(registry.move('p', { x: at.x, y: at.y, facing: 'right' }, now)).toBe('applied');
  registry.keepFootballRunning(now);
  return registry;
}

afterEach(() => attachDebugTap(null));

describe('the solo ball (D-078)', () => {
  it('stands on the centre spot from the start, drawn before anyone comes near', () => {
    const solo = setup();
    expect(solo.frame()).toMatchObject({ x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0, starks: 0, snarks: 0, phase: 'live' });
    expect(solo.time.size).toBe(0);
  });

  it('steps only while the player is on or near the pitch, and never in a building', () => {
    const solo = setup();
    solo.move((STREET_ORIGIN_X + 24) * T, 15 * T);
    expect(solo.time.size).toBe(0);
    solo.move(FOOTBALL_CENTRE.x - 5 * T, FOOTBALL_CENTRE.y);
    expect(solo.time.size).toBe(1);
    solo.time.advance(200);
    expect(solo.time.size).toBe(1);
    solo.world.emit('building:entered', { building: 'bank' });
    solo.time.advance(200);
    expect(solo.time.size).toBe(0);
    solo.world.emit('building:exited', { building: 'bank' });
    solo.move(FOOTBALL_CENTRE.x - 5 * T, FOOTBALL_CENTRE.y);
    expect(solo.time.size).toBe(1);
  });

  it('kicks from where the player stands, and only within reach', () => {
    const solo = setup();
    const taps: unknown[] = [];
    attachDebugTap({ football: (step: unknown) => taps.push(step) } as unknown as DebugTap);
    solo.move(FOOTBALL_CENTRE.x - 3 * T, FOOTBALL_CENTRE.y);
    solo.controller.channel.kick();
    solo.time.advance(100);
    expect(solo.frame()).toMatchObject({ vx: 0 });
    solo.move(FOOTBALL_CENTRE.x - 24, FOOTBALL_CENTRE.y);
    solo.time.advance(100);
    solo.controller.channel.kick();
    solo.time.advance(40);
    expect(solo.frame()!.vx).toBeGreaterThan(FOOTBALL_KICK_SPEED * 0.9);
    expect(taps).toEqual([{ event: 'kick' }]);
  });

  it('scores, celebrates, kicks off again, and plays to full time', () => {
    const solo = setup();
    const taps: unknown[] = [];
    attachDebugTap({ football: (step: unknown) => taps.push(step) } as unknown as DebugTap);
    for (let goal = 1; goal <= FOOTBALL_WIN_SCORE; goal++) {
      // Walk up behind the ball, west of it, and shoot east.
      const ball = solo.frame()!;
      solo.move(ball.x - 24, ball.y);
      solo.time.advance(40);
      solo.controller.channel.kick();
      solo.time.advance(3000);
      expect(solo.frame()!.starks).toBe(goal);
      // Out of the way of the kick-off, but still on the pitch, until play restarts.
      solo.move(FOOTBALL_CENTRE.x, FOOTBALL_CENTRE.y + 6 * T);
      solo.time.advance(1500);
      if (goal < FOOTBALL_WIN_SCORE) expect(solo.frame()).toMatchObject({ phase: 'live', x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y });
    }
    expect(solo.moments).toEqual([
      ...Array.from({ length: FOOTBALL_WIN_SCORE }, () => ({ kind: 'goal', side: 'starks' })),
      { kind: 'full-time', winner: 'starks', starks: FOOTBALL_WIN_SCORE, snarks: 0 },
    ]);
    expect(solo.frame()!.phase).toBe('full-time');
    solo.time.advance(5000);
    expect(solo.frame()).toMatchObject({ starks: 0, snarks: 0, phase: 'live', x: FOOTBALL_CENTRE.x });
    expect(taps.filter((step) => (step as { event: string }).event !== 'kick')).toEqual([
      ...Array.from({ length: FOOTBALL_WIN_SCORE }, () => ({ event: 'goal', side: 'starks' })),
      { event: 'full-time', winner: 'starks' },
    ]);
  });
});

describe('the lobby\'s ball (D-078)', () => {
  const lobbyBall = (tick: number, extra: Partial<FootballSnapshot> = {}): FootballSnapshot =>
    Object.freeze({ tick, x: FOOTBALL_CENTRE.x + 64, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0, starks: 1, snarks: 2, phase: 'live', ...extra });

  it('draws the lobby\'s ball while connected, and the solo one again when the connection closes', () => {
    const world = setup();
    const lobby = fakeLobby(lobbyBall(2000));
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    expect(world.frame()).toMatchObject({ x: FOOTBALL_CENTRE.x + 64, starks: 1, snarks: 2 });
    // No solo stepping while the lobby is the authority.
    world.move(FOOTBALL_CENTRE.x - 5 * T, FOOTBALL_CENTRE.y);
    expect(world.time.size).toBe(0);
    lobby.status('closed');
    expect(lobby.listening).toBe(false);
    expect(world.frame()).toMatchObject({ x: FOOTBALL_CENTRE.x, starks: 0, snarks: 0 });
    expect(world.time.size).toBe(1);
  });

  it('sends kicks to the lobby and shows each at once, and nothing when the lobby would not send it', () => {
    const world = setup();
    const lobby = fakeLobby(lobbyBall(2000, { x: FOOTBALL_CENTRE.x }));
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    world.move(FOOTBALL_CENTRE.x - 24, FOOTBALL_CENTRE.y);
    world.controller.channel.kick();
    expect(lobby.client.kicks).toBe(1);
    world.time.advance(17);
    expect(world.frame()!.x).toBeGreaterThan(FOOTBALL_CENTRE.x + 2);
    // A kick inside the client's floor is not sent, and not shown.
    lobby.client.accept = false;
    world.time.advance(1000);
    const before = world.frame()!;
    world.controller.channel.kick();
    world.time.advance(17);
    expect(world.frame()!.x).toBeCloseTo(before.x, 6);
  });

  it('celebrates the lobby\'s goals by their side, and full time when play reaches it, not on joining during it', () => {
    const world = setup();
    const lobby = fakeLobby(lobbyBall(2000, { phase: 'full-time', starks: 5, snarks: 1 }));
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    expect(world.moments).toEqual([]);
    lobby.publish(lobbyBall(2100, { starks: 0, snarks: 0 }));
    lobby.goal('snarks');
    lobby.publish(lobbyBall(2101, { starks: 0, snarks: 1, phase: 'goal' }));
    lobby.publish(lobbyBall(2200, { starks: 3, snarks: 4, phase: 'goal' }));
    lobby.goal('snarks');
    lobby.publish(lobbyBall(2300, { starks: 3, snarks: 5, phase: 'full-time' }));
    expect(world.moments).toEqual([
      { kind: 'goal', side: 'snarks' },
      { kind: 'goal', side: 'snarks' },
      { kind: 'full-time', winner: 'snarks', starks: 3, snarks: 5 },
    ]);
  });

  it('draws no ball while the lobby has none, and stops listening on destroy', () => {
    const world = setup();
    const lobby = fakeLobby(null);
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    expect(world.frame()).toBeNull();
    lobby.publish(lobbyBall(10));
    expect(world.frame()).not.toBeNull();
    world.controller.destroy();
    expect(lobby.listening).toBe(false);
    expect(world.frame()).toBeNull();
    world.controller.channel.kick();
    expect(lobby.client.kicks).toBe(0);
  });
});

describe('solo play is the lobby\'s play (D-078)', () => {
  it('moves the ball exactly as the lobby would, from the same moves and the same kick', () => {
    // The Shell, solo: the controller's own authority from player:moved.
    const solo = setup();
    const start = solo.time.now();
    // The lobby: a registry stepping the room's ball from the same moves (every move
    // accepted: the solo player moves every frame, and this compares steps, not floors).
    const registry = roomWithPlayerOnPitch(
      { x: Math.round(FOOTBALL_CENTRE.x - 120), y: Math.round(FOOTBALL_CENTRE.y - 3) },
      start,
    );
    solo.move(Math.round(FOOTBALL_CENTRE.x - 120), Math.round(FOOTBALL_CENTRE.y - 3));
    const trace: Array<{ lobby: FootballSnapshot; solo: FootballSnapshot }> = [];
    let x = Math.round(FOOTBALL_CENTRE.x - 120);
    // Walk east into the ball at 150 px/s, a whole pixel a move, then shoot it into the east goal.
    for (let step = 1; step <= 150; step++) {
      const t = start + step * FOOTBALL_TICK_MS;
      if (step <= 20) x += 6;
      registry.move('p', { x, y: Math.round(FOOTBALL_CENTRE.y - 3), facing: 'right' }, t - 1);
      solo.time.advance(FOOTBALL_TICK_MS - 1);
      solo.move(x, Math.round(FOOTBALL_CENTRE.y - 3));
      solo.time.advance(1);
      registry.footballTick(t);
      if (step === 30) {
        // Up behind the rolling ball, and kick.
        const ball = registry.footballSnapshot();
        x = Math.round(ball.x - 20);
        registry.move('p', { x, y: Math.round(ball.y), facing: 'right' }, t);
        solo.move(x, Math.round(ball.y));
        expect(registry.kickBall('p', t)).toBe('applied');
        solo.controller.channel.kick();
      }
      trace.push({ lobby: registry.footballSnapshot(), solo: solo.controller.snapshot()! });
    }
    for (const { lobby, solo: ours } of trace) {
      expect(ours.tick).toBe(lobby.tick);
      expect(ours.x).toBeCloseTo(lobby.x, 6);
      expect(ours.y).toBeCloseTo(lobby.y, 6);
      expect([ours.starks, ours.snarks, ours.phase]).toEqual([lobby.starks, lobby.snarks, lobby.phase]);
    }
    // It went in, for the Starks (who attack the east goal), in both, and play kicked off again.
    const scored = trace.findIndex(({ lobby }) => lobby.phase === 'goal');
    expect(scored).toBeGreaterThan(30);
    expect(trace[scored]!.lobby.starks).toBe(1);
    expect(trace[scored]!.lobby.x).toBeGreaterThan(X1);
    expect(trace.at(-1)!.lobby).toMatchObject({ starks: 1, phase: 'live', x: FOOTBALL_CENTRE.x });
    expect(solo.moments).toEqual([{ kind: 'goal', side: 'starks' }]);
  });
});

describe('jumping over the ball (D-130)', () => {
  it('runs the solo ball exactly as the room does: over it in the air, dribbled on the ground', () => {
    /** One run due east through the centre spot, in the room and in solo play at once. */
    const over = (jump: boolean) => {
      const solo = setup();
      const start = solo.time.now();
      const y = Math.round(FOOTBALL_CENTRE.y);
      let x = Math.round(FOOTBALL_CENTRE.x - 60);
      const registry = roomWithPlayerOnPitch({ x, y }, start);
      // The jump leaves on the key press, before the moves it carries.
      if (jump) expect(registry.jump('p', start)).toBe('applied');
      solo.move(x, y, 'right', jump);
      for (let step = 1; step <= 16; step++) {
        const t = start + step * FOOTBALL_TICK_MS;
        x += 6;
        registry.move('p', { x, y, facing: 'right' }, t - 1);
        solo.time.advance(FOOTBALL_TICK_MS - 1);
        solo.move(x, y, 'right', jump);
        solo.time.advance(1);
        registry.footballTick(t);
      }
      return {
        lobby: registry.footballSnapshot(),
        solo: solo.controller.snapshot()!,
        drawn: solo.frame()!,
        playerX: x,
      };
    };

    const jumped = over(true);
    // Past the ball, which neither authority moved an inch.
    expect(jumped.playerX).toBeGreaterThan(FOOTBALL_CENTRE.x);
    expect(jumped.lobby).toMatchObject({ x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0 });
    expect(jumped.solo.x).toBeCloseTo(jumped.lobby.x, 6);
    expect(jumped.solo.vx).toBeCloseTo(jumped.lobby.vx, 6);
    // And the drawn ball agrees: no local push answer for a jumper.
    expect(jumped.drawn.x).toBeCloseTo(FOOTBALL_CENTRE.x, 6);

    const walked = over(false);
    expect(walked.lobby.vx).toBeGreaterThan(0);
    expect(walked.solo.x).toBeCloseTo(walked.lobby.x, 6);
    expect(walked.solo.vx).toBeCloseTo(walked.lobby.vx, 6);
  });

  it('forgets the air when the player steps off the street, so they come back as a body', () => {
    const solo = setup();
    const y = Math.round(FOOTBALL_CENTRE.y);
    solo.move(Math.round(FOOTBALL_CENTRE.x - 60), y, 'right', true);
    solo.world.emit('building:entered', { building: 'bank' });
    solo.world.emit('building:exited', { building: 'bank' });
    let x = Math.round(FOOTBALL_CENTRE.x - 40);
    for (let step = 0; step < 12; step++) {
      x += 6;
      solo.move(x, y);
      solo.time.advance(FOOTBALL_TICK_MS);
    }
    expect(solo.controller.snapshot()!.x).not.toBe(FOOTBALL_CENTRE.x);
  });
});

void vi;
