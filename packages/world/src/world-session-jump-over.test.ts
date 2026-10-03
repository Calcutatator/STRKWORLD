import { describe, expect, it } from 'vitest';
import {
  JUMP_PASS_FROM_PHASE,
  JUMP_PASS_UNTIL_PHASE,
  PITCH_FIELD,
  type WorldEvents,
} from '@strkworld/shared';
import { JUMP_AIR_MS } from './jump.js';
import { TILE_SIZE, createStreetMap, isSolidAt, worldToTile } from './map/street.js';
import { createRemotePeerSource } from './remote-peer.js';
import type { MovementInput } from './street-movement.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * D-128: a jump that carries you over things, in the session.
 *
 * The jump has never changed the avatar's speed or direction (D-097), so a
 * running jump already covers the same ground as the run — four tiles walking
 * over the 800 ms of air, six sprinting. What D-128 adds is the one thing the
 * ground-level world reads off it: while the feet are clear, every street
 * placement says `airborne`, and the Shell's ball leaves the jumper alone.
 *
 * Walls, fixtures and blocks are untouched: they are authored tile collision,
 * and a jump has never been able to cross one.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const STREET = createStreetMap();
/** The centre spot, where the ball sits at every kick-off, in World pixels. */
const BALL = Object.freeze({
  x: (PITCH_FIELD.x + PITCH_FIELD.width / 2) * TILE_SIZE,
  y: (PITCH_FIELD.y + PITCH_FIELD.height / 2) * TILE_SIZE,
});

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    space(): void;
    sprinting: boolean;
  } = {
    enabled: true,
    get held() {
      return pressed;
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
    space() {
      for (const handler of [...(handlers.get('keydown-Space') ?? [])]) handler({ repeat: false, target: null });
    },
  };
  return keyboard;
}

type Moved = WorldEvents['player:moved'];

function setup(options: { readonly reducedMotion?: boolean; readonly peerAt?: { x: number; y: number } } = {}) {
  const view = new Proxy({} as WorldSessionView, {
    get: () => () => {},
  });
  const keyboard = fakeKeyboard();
  const moves: Moved[] = [];
  const peers = options.peerAt
    ? createRemotePeerSource([
        { id: 'peer', x: options.peerAt.x, y: options.peerAt.y, facing: 'down', sprite: 'avatar-1' },
      ]).source
    : undefined;
  const session = createWorldSession({
    view,
    keyboard,
    ...(options.reducedMotion ? { reducedMotion: () => true } : {}),
    ...(peers ? { peers } : {}),
    config: {
      out: {
        emit: (event, payload) => {
          if (event === 'player:moved') moves.push(payload as Moved);
        },
      },
      in: { on: () => () => {} },
    },
  });
  const internals = session as unknown as { position: { x: number; y: number } };
  return {
    session,
    keyboard,
    moves,
    placeAt(position: { x: number; y: number }) {
      internals.position = { x: position.x, y: position.y };
      session.update(16);
    },
    /** `frames` frames of `ms` each; returns the airborne flag published on each. */
    run(frames: number, ms: number): boolean[] {
      const seen: boolean[] = [];
      for (let frame = 0; frame < frames; frame += 1) {
        const before = moves.length;
        session.update(ms);
        for (const move of moves.slice(before)) seen.push(move.airborne === true);
      }
      return seen;
    },
  };
}

describe('the jump carries the player over the ball and over a peer (D-128)', () => {
  it('runs clean over the ball\'s tile and out the other side, at running speed', () => {
    const world = setup();
    // Three tiles west of the centre spot, running east through it.
    world.placeAt({ x: BALL.x - 3 * TILE_SIZE, y: BALL.y });
    const start = world.session.player.x;
    world.keyboard.hold({ right: true });
    world.keyboard.space();
    world.keyboard.sprinting = true;
    const crossed: boolean[] = [];
    for (let frame = 0; frame * 16 < JUMP_AIR_MS; frame += 1) {
      world.session.update(16);
      crossed.push(Math.abs(world.session.player.x - BALL.x) < TILE_SIZE / 2);
    }
    // The run passed over the ball's tile and finished well past it.
    expect(crossed.some(Boolean)).toBe(true);
    expect(world.session.player.x).toBeGreaterThan(BALL.x + TILE_SIZE);
    // A sprint over the 800 ms of air is six tiles, and the jump took none of it.
    expect(world.session.player.x - start).toBeCloseTo(6 * TILE_SIZE, 0);
    expect(world.session.player.y).toBe(BALL.y);
  });

  it('crosses the exact spot a peer stands on, because a peer is never collision', () => {
    const over = (peerAt: { x: number; y: number } | undefined) => {
      const world = setup(peerAt ? { peerAt } : {});
      world.placeAt({ x: BALL.x - 3 * TILE_SIZE, y: BALL.y });
      world.keyboard.hold({ right: true });
      world.keyboard.space();
      world.run(50, 16);
      return world.session.player.x;
    };
    const peerAt = { x: BALL.x, y: BALL.y };
    expect(isSolidAt(STREET, worldToTile(peerAt.x, peerAt.y).x, worldToTile(peerAt.x, peerAt.y).y)).toBe(false);
    expect(over(peerAt)).toBeGreaterThan(peerAt.x);
    // Exactly the ground a run with nobody there covers: a peer stops no one,
    // airborne or not, so there is nothing to be nudged out of on landing.
    expect(over(peerAt)).toBe(over(undefined));
  });

  it('publishes airborne for the pass window only, and never while walking', () => {
    const world = setup();
    world.placeAt({ x: BALL.x - 3 * TILE_SIZE, y: BALL.y });
    world.keyboard.hold({ right: true });
    // Walking: no flag on the wire at all, so the payload is what it was.
    const walking = world.run(10, 16);
    expect(walking.some(Boolean)).toBe(false);
    expect(world.moves.every((move) => !('airborne' in move))).toBe(true);

    world.keyboard.space();
    // 40 ms frames: the flag is off until the feet clear the ground, on across
    // the arc, and off again before landing.
    const flags = world.run(Math.ceil(JUMP_AIR_MS / 40) + 2, 40);
    // The flag on frame i was published after the jump advanced to (i + 1) frames.
    const elapsedOf = (index: number): number => (index + 1) * 40;
    const first = flags.indexOf(true);
    const last = flags.lastIndexOf(true);
    expect(first).toBeGreaterThan(0);
    expect(elapsedOf(first)).toBeGreaterThanOrEqual(JUMP_PASS_FROM_PHASE * JUMP_AIR_MS);
    expect(elapsedOf(first - 1)).toBeLessThan(JUMP_PASS_FROM_PHASE * JUMP_AIR_MS);
    expect(elapsedOf(last)).toBeLessThanOrEqual(JUMP_PASS_UNTIL_PHASE * JUMP_AIR_MS);
    expect(elapsedOf(last + 1)).toBeGreaterThan(JUMP_PASS_UNTIL_PHASE * JUMP_AIR_MS);
    // Landed: back to a plain payload.
    expect(flags[flags.length - 1]).toBe(false);
  });

  it('passes over the same things with reduced motion, whose arc is only lower', () => {
    const flagsFor = (reducedMotion: boolean): boolean[] => {
      const world = setup(reducedMotion ? { reducedMotion: true } : {});
      world.placeAt({ x: BALL.x - 3 * TILE_SIZE, y: BALL.y });
      world.keyboard.hold({ right: true });
      world.keyboard.space();
      return world.run(Math.ceil(JUMP_AIR_MS / 40) + 2, 40);
    };
    expect(flagsFor(true)).toEqual(flagsFor(false));
  });
});

describe('walls, fixtures and blocks are unchanged by the jump (D-128)', () => {
  it('stops a running jump at a wall exactly where a walk stops', () => {
    // The pitch's west goal line has the boards and the stand behind it; walk
    // west off the field until the authored collision stops the body.
    const intoTheWall = (jump: boolean): { x: number; y: number } => {
      const world = setup();
      world.placeAt({ x: (PITCH_FIELD.x + 1) * TILE_SIZE, y: BALL.y - 6 * TILE_SIZE });
      world.keyboard.hold({ up: true, left: true });
      if (jump) world.keyboard.space();
      world.run(120, 16);
      return { x: world.session.player.x, y: world.session.player.y };
    };
    const walked = intoTheWall(false);
    const jumped = intoTheWall(true);
    expect(jumped).toEqual(walked);
    // It really did come up against something, rather than running free.
    const tile = worldToTile(walked.x, walked.y);
    const blocked = [[-1, 0], [0, -1]].some(([dx, dy]) => isSolidAt(STREET, tile.x + dx!, tile.y + dy!));
    expect(blocked).toBe(true);
  });
});
