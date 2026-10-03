import { describe, expect, it } from 'vitest';
import { FOOTBALL_TICK_MS, JUMP_PASS_WINDOW_MS } from '@strkworld/shared';
import { JUMP_MIN_INTERVAL_MS } from './config';
import {
  FOOTBALL_CENTRE,
  FOOTBALL_PLAYER_MAX_SPEED,
  createFootballAuthority,
  type FootballPlayer,
} from './football-rules';
import { LobbyPresence } from './presence';

/**
 * D-128: jumping over the football, as the room judges it.
 *
 * The room is the authority on who is in the air: it times the jumps it
 * accepted, and a client has no field to claim an airborne pass in. So the
 * only way over the ball is to actually jump, within the window the room
 * opened, and the move floor and the speed the ball reads off a player are
 * exactly what they were.
 */

/** Walking speed in World pixels a second, as `calculateMovementVelocity` sends it. */
const WALK = 160;
/** How far a walking client moves between two moves sent on the ball's tick. */
const STRIDE = (WALK * FOOTBALL_TICK_MS) / 1000;

/** A registry with the ball at rest on the centre spot, and a clock to step it with. */
function pitch() {
  const registry = new LobbyPresence();
  let now = 10_000;
  const step = (ms: number): void => {
    const until = now + ms;
    while (now < until) {
      now += FOOTBALL_TICK_MS;
      registry.footballTick(now);
    }
  };
  return { registry, step, now: () => now };
}

/**
 * One session runs due east through the centre spot at walking pace, sending
 * a move every tick as a client does. With `jump`, it jumps first — the
 * message order a real client always produces, since the jump leaves on the
 * key press and the move that carries it over the ball comes after.
 */
function runThroughTheBall(options: { readonly jump: boolean; readonly ticks?: number }) {
  const { registry, step, now } = pitch();
  const y = FOOTBALL_CENTRE.y;
  let x = FOOTBALL_CENTRE.x - 3 * STRIDE - 24;
  const outcome = registry.admit('runner', { x, y, facing: 'right' });
  if (!outcome.ok) throw new Error(outcome.reason);
  registry.keepFootballRunning(now());
  if (options.jump) expect(registry.jump('runner', now())).toBe('applied');
  const ticks = options.ticks ?? 10;
  for (let tick = 0; tick < ticks; tick += 1) {
    x += STRIDE;
    registry.move('runner', { x, y, facing: 'right' }, now());
    step(FOOTBALL_TICK_MS);
  }
  return { ball: registry.footballSnapshot(), playerX: x };
}

describe('jumping over the football (D-128)', () => {
  it('carries the player over the ball and leaves it exactly where it was', () => {
    const run = runThroughTheBall({ jump: true });
    // Past it, and far enough that the body covered the ball on the way.
    expect(run.playerX).toBeGreaterThan(FOOTBALL_CENTRE.x);
    expect(run.ball.x).toBe(FOOTBALL_CENTRE.x);
    expect(run.ball.y).toBe(FOOTBALL_CENTRE.y);
    expect(run.ball.vx).toBe(0);
    expect(run.ball.vy).toBe(0);
    // Nothing else about play moved either: no kick, no goal.
    expect(run.ball.phase).toBe('live');
    expect(run.ball.west).toBe(0);
    expect(run.ball.east).toBe(0);
  });

  it('dribbles it away on the very same run without a jump', () => {
    const run = runThroughTheBall({ jump: false });
    expect(run.playerX).toBeGreaterThan(FOOTBALL_CENTRE.x);
    expect(run.ball.vx).toBeGreaterThan(0);
    expect(run.ball.x).toBeGreaterThan(FOOTBALL_CENTRE.x);
  });

  it('holds the pass to the window the room opened: one tick later and the ball comes off them again', () => {
    /** The ball after a step `tickAt` ms past the jump, with the jumper on its centre. */
    const onTheBall = (tickAt: number): number => {
      const { registry, step, now } = pitch();
      const start = { x: FOOTBALL_CENTRE.x - 40, y: FOOTBALL_CENTRE.y };
      expect(registry.admit('a', { ...start, facing: 'right' }).ok).toBe(true);
      registry.keepFootballRunning(now());
      expect(registry.jump('a', now())).toBe('applied');
      step(tickAt - FOOTBALL_TICK_MS);
      // Stand on the ball's centre: a body there pushes it, airborne or not.
      registry.move('a', { x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, facing: 'right' }, now());
      step(FOOTBALL_TICK_MS);
      return registry.footballSnapshot().x;
    };
    // The window is the pass phase of the air time plus the move-floor latency.
    expect(JUMP_PASS_WINDOW_MS).toBe(870);
    // Stepped on the tick, so the last step inside the window is at 840 ms.
    expect(onTheBall(840)).toBe(FOOTBALL_CENTRE.x);
    expect(onTheBall(880)).not.toBe(FOOTBALL_CENTRE.x);
  });

  it('never opens on a jump the room refused, so the floor still bounds how long anyone is in the air', () => {
    const { registry, step, now } = pitch();
    expect(registry.admit('a', { x: FOOTBALL_CENTRE.x - 40, y: FOOTBALL_CENTRE.y, facing: 'right' }).ok).toBe(true);
    registry.keepFootballRunning(now());
    expect(registry.jump('a', now())).toBe('applied');
    // The floor is the whole air time, so no second jump can extend the window.
    expect(JUMP_MIN_INTERVAL_MS).toBe(800);
    step(JUMP_PASS_WINDOW_MS - FOOTBALL_TICK_MS);
    expect(registry.jump('a', now())).toBe('applied');
    // ... and a throttled one opens nothing at all.
    expect(registry.jump('a', now())).toBe('throttled');
  });

  it('is forgotten when the jumper leaves the street, so they come back as a body', () => {
    const { registry, step, now } = pitch();
    expect(registry.admit('a', { x: FOOTBALL_CENTRE.x - 40, y: FOOTBALL_CENTRE.y, facing: 'right' }).ok).toBe(true);
    registry.keepFootballRunning(now());
    expect(registry.jump('a', now())).toBe('applied');
    expect(registry.suspend('a', now())).toBe(true);
    expect(registry.resume('a', { x: FOOTBALL_CENTRE.x - 40, y: FOOTBALL_CENTRE.y, facing: 'right' }, now())).toBe(true);
    registry.keepFootballRunning(now());
    registry.move('a', { x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, facing: 'right' }, now() + 60);
    step(FOOTBALL_TICK_MS);
    expect(registry.footballSnapshot().x).not.toBe(FOOTBALL_CENTRE.x);
  });

  it('gives an airborne session no extra moves: the floor is the same either way', () => {
    const applied = (jump: boolean): number => {
      const registry = new LobbyPresence();
      let now = 10_000;
      expect(registry.admit('a', { x: 100, y: 100, facing: 'right' }).ok).toBe(true);
      if (jump) expect(registry.jump('a', now)).toBe('applied');
      let count = 0;
      for (let i = 0; i < 100; i += 1) {
        now += 10;
        if (registry.move('a', { x: 100 + i, y: 100, facing: 'right' }, now) === 'applied') count += 1;
      }
      return count;
    };
    const plain = applied(false);
    expect(plain).toBeGreaterThan(0);
    expect(plain).toBeLessThan(100);
    expect(applied(true)).toBe(plain);
  });

  it('still reads a landed player at no more than the player speed cap', () => {
    const { registry, step, now } = pitch();
    expect(registry.admit('a', { x: FOOTBALL_CENTRE.x - 2000, y: FOOTBALL_CENTRE.y, facing: 'right' }).ok).toBe(true);
    registry.keepFootballRunning(now());
    expect(registry.jump('a', now())).toBe('applied');
    step(JUMP_PASS_WINDOW_MS + FOOTBALL_TICK_MS);
    // A hostile client jumping in from 2000 px away in one move: whatever it
    // claims, the ball reads it at the cap, so a jump buys no extra shot.
    registry.move('a', { x: FOOTBALL_CENTRE.x - 24, y: FOOTBALL_CENTRE.y, facing: 'right' }, now());
    step(FOOTBALL_TICK_MS * 2);
    const ball = registry.footballSnapshot();
    // The dribble keeps a share of the closing speed on top of the body's own.
    expect(Math.hypot(ball.vx, ball.vy)).toBeLessThanOrEqual(FOOTBALL_PLAYER_MAX_SPEED * 2);
  });
});

describe('the rules an airborne player is handed to (D-128)', () => {
  const still = { x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, vx: 0, vy: 0 };

  /** The ball after someone sits on its centre for a step, as `player` describes them. */
  const afterAStep = (player: Partial<FootballPlayer> & { key: string }) => {
    const authority = createFootballAuthority({ ball: still });
    authority.resume(0);
    authority.advance(FOOTBALL_TICK_MS, [
      { x: FOOTBALL_CENTRE.x, y: FOOTBALL_CENTRE.y, at: 0, ...player } as FootballPlayer,
    ]);
    return authority.snapshot();
  };

  it('leaves the ball alone for an airborne player and pushes it for a standing one', () => {
    expect(afterAStep({ key: 'a', airborne: true }).x).toBe(FOOTBALL_CENTRE.x);
    expect(afterAStep({ key: 'a' }).x).not.toBe(FOOTBALL_CENTRE.x);
  });

  it('takes nothing but exactly true as airborne, so a malformed flag never lifts anyone', () => {
    for (const value of ['yes', 1, {}, [], 'true']) {
      expect(afterAStep({ key: 'a', airborne: value as unknown as boolean }).x).not.toBe(FOOTBALL_CENTRE.x);
    }
  });

  it('keeps following an airborne player, so they land pushing the ball at the speed they ran', () => {
    const authority = createFootballAuthority({ ball: still });
    authority.resume(0);
    let at = 0;
    let x = FOOTBALL_CENTRE.x - 60;
    const run = (airborne: boolean): void => {
      at += FOOTBALL_TICK_MS;
      x += STRIDE;
      authority.advance(at, [
        { key: 'a', x, y: FOOTBALL_CENTRE.y, at, ...(airborne ? { airborne: true } : {}) },
      ]);
    };
    // Three steps of the run spent in the air: the ball does not stir.
    for (let tick = 0; tick < 3; tick += 1) run(true);
    expect(authority.snapshot().x).toBe(FOOTBALL_CENTRE.x);
    // Landed, closing on it: the push reads the speed of the whole run, so
    // there is no dead moment after a jump.
    for (let tick = 0; tick < 4; tick += 1) run(false);
    expect(authority.snapshot().vx).toBeGreaterThan(WALK);
  });
});
