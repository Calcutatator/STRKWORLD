import { describe, expect, it } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import {
  AVATAR_STUDIO_DEFINITION,
  isAvatarStudioSolidAt,
} from './avatar-studio.js';
import {
  BANK_ROOM_DEFINITION,
  createFixedRoom,
  isFixedRoomSolidAt,
} from './fixed-room.js';
import {
  createStreetMovementAdapter,
  createStreetMovementReporter,
  moveWithCollisionSubsteps,
  resolveMovementFacing,
  type MovementInput,
} from './street-movement.js';

const idle: MovementInput = { left: false, right: false, up: false, down: false };

function capture() {
  const events: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  const out = { emit: (event: keyof WorldEvents, payload: unknown) => events.push({ event, payload }) };
  return { events, reporter: createStreetMovementReporter(out) };
}

describe('street movement seam', () => {
  it('uses one facing rule for street and interior avatar animation', () => {
    expect(resolveMovementFacing({ ...idle, left: true }, 'down')).toBe('left');
    expect(resolveMovementFacing({ ...idle, left: true, up: true }, 'right')).toBe('up');
    expect(resolveMovementFacing(idle, 'right')).toBe('right');
  });

  it.each([
    ['right', { x: 160, y: 0 }, { x: 16, y: 0 }],
    ['left', { x: -160, y: 0 }, { x: -16, y: 0 }],
    ['down', { x: 0, y: 160 }, { x: 0, y: 16 }],
  ])('preserves exact small-delta %s displacement', (_direction, velocity, expected) => {
    expect(
      moveWithCollisionSubsteps({
        position: { x: 100, y: 100 },
        velocity,
        delta: 100,
        tileSize: 32,
        toTile: (x, y) => ({ x: Math.floor(x / 32), y: Math.floor(y / 32) }),
        isSolidAt: () => false,
      }),
    ).toEqual({ x: 100 + expected.x, y: 100 + expected.y });
  });

  it('preserves normal and sprint displacement at the movement speeds', () => {
    const move = (speed: number) =>
      moveWithCollisionSubsteps({
        position: { x: 100, y: 100 },
        velocity: { x: speed, y: 0 },
        delta: 100,
        tileSize: 32,
        toTile: (x, y) => ({ x: Math.floor(x / 32), y: Math.floor(y / 32) }),
        isSolidAt: () => false,
      });

    expect(move(160)).toEqual({ x: 116, y: 100 });
    expect(move(240)).toEqual({ x: 124, y: 100 });
  });

  it('checks horizontal collision before the vertical diagonal candidate', () => {
    const checked: Array<[number, number]> = [];
    const position = moveWithCollisionSubsteps({
      position: { x: 0, y: 0 },
      velocity: { x: 160, y: 160 },
      delta: 100,
      tileSize: 32,
      toTile: (x, y) => ({ x: Math.floor(x / 16), y: Math.floor(y / 16) }),
      isSolidAt: (x, y) => {
        checked.push([x, y]);
        return x === 1 && y === 0;
      },
    });

    expect(position).toEqual({ x: 8, y: 16 });
    expect(checked.slice(0, 2)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(checked).toContainEqual([1, 0]);
  });

  it('fails closed for malformed inputs and truncates extreme finite travel', () => {
    const base = { x: 100, y: 100 };
    const options = {
      position: base,
      velocity: { x: 160, y: 0 },
      delta: 100,
      tileSize: 32,
      toTile: (x: number, y: number) => ({ x: Math.floor(x / 32), y: Math.floor(y / 32) }),
      isSolidAt: () => false,
    };

    expect(moveWithCollisionSubsteps({ ...options, delta: Number.POSITIVE_INFINITY })).toEqual(base);
    expect(moveWithCollisionSubsteps({ ...options, velocity: { x: Number.NaN, y: 0 } })).toEqual(base);
    expect(moveWithCollisionSubsteps({ ...options, tileSize: 0 })).toEqual(base);

    let checks = 0;
    const extreme = moveWithCollisionSubsteps({
      ...options,
      delta: Number.MAX_VALUE,
      isSolidAt: () => {
        checks++;
        return false;
      },
    });
    expect(Number.isFinite(extreme.x)).toBe(true);
    expect(extreme.x).toBeGreaterThan(base.x);
    expect(checks).toBeLessThan(1_100);
  });

  it('does not tunnel through a solid interior tile during a large fixed-room delta', () => {
    const room = createFixedRoom(BANK_ROOM_DEFINITION);
    const position = moveWithCollisionSubsteps({
      position: { x: 9 * 32 + 16, y: 9 * 32 + 16 },
      velocity: { x: 0, y: -160 },
      delta: 1400,
      tileSize: 32,
      toTile: (x, y) => ({ x: Math.floor(x / 32), y: Math.floor(y / 32) }),
      isSolidAt: (x, y) => isFixedRoomSolidAt(room, x, y),
    });

    expect(position).toEqual({ x: 9 * 32 + 16, y: 4 * 32 });
  });

  it('keeps the authoritative 24px body clear of a solid tile, not only its anchor', () => {
    const room = createFixedRoom(BANK_ROOM_DEFINITION);
    const position = moveWithCollisionSubsteps({
      position: { x: 9 * 32 + 16, y: 5 * 32 + 16 },
      velocity: { x: 0, y: -160 },
      delta: 1_000,
      tileSize: 32,
      // The local player and Studio contact body are both 24x24.
      collisionHalfSize: 12,
      toTile: (x: number, y: number) => ({ x: Math.floor(x / 32), y: Math.floor(y / 32) }),
      isSolidAt: (x: number, y: number) => isFixedRoomSolidAt(room, x, y),
    });

    // The station occupies row 3 (world y 96..128 in this origin-free map).
    // With 16px collision substeps, the body must stop at center y=144 rather
    // than entering row 4's lower edge-adjacent position at y=128.
    expect(position).toEqual({ x: 9 * 32 + 16, y: 144 });
  });

  it('uses the supplied world-to-tile transform for body collision checks', () => {
    const room = createFixedRoom(BANK_ROOM_DEFINITION);
    const origin = 64;
    const position = moveWithCollisionSubsteps({
      position: { x: origin + 9 * 32 + 16, y: origin + 5 * 32 + 16 },
      velocity: { x: 0, y: -160 },
      delta: 1_000,
      tileSize: 32,
      collisionHalfSize: 12,
      toTile: (x: number, y: number) => ({
        x: Math.floor((x - origin) / 32),
        y: Math.floor((y - origin) / 32),
      }),
      isSolidAt: (x: number, y: number) => isFixedRoomSolidAt(room, x, y),
    });

    expect(position).toEqual({ x: origin + 9 * 32 + 16, y: origin + 144 });
  });

  it('uses the same bounded collision seam for Avatar Studio movement', () => {
    const position = moveWithCollisionSubsteps({
      position: { x: 5 * 32 + 16, y: 9 * 32 + 16 },
      velocity: { x: 0, y: -160 },
      delta: 2200,
      tileSize: 32,
      toTile: (x, y) => ({ x: Math.floor(x / 32), y: Math.floor(y / 32) }),
      isSolidAt: (x, y) => isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, x, y),
    });

    expect(position).toEqual({ x: 5 * 32 + 16, y: 32 });
  });

  it('emits the initial placement with only the frozen movement payload', () => {
    const h = capture();
    h.reporter.initial({ x: 784, y: 496 });

    expect(h.events).toEqual([
      { event: 'player:moved', payload: { position: { x: 784, y: 496 }, facing: 'down' } },
    ]);
    expect(Object.keys(h.events[0]!.payload as object)).toEqual(['position', 'facing']);
  });

  it('tracks input facing and retains it while stopped', () => {
    const h = capture();
    h.reporter.update({ x: 100, y: 100 }, { ...idle, right: true });
    h.reporter.update({ x: 100, y: 100 }, idle);

    expect(h.events.map((event) => event.payload)).toEqual([
      { position: { x: 100, y: 100 }, facing: 'right' },
      { position: { x: 100, y: 100 }, facing: 'right' },
    ]);
  });

  it('never adds building, room, station, mode, or financial fields', () => {
    const h = capture();
    h.reporter.update({ x: 1, y: 2 }, { ...idle, up: true });
    const payload = h.events[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['facing', 'position']);
    expect(payload).not.toHaveProperty('building');
    expect(payload).not.toHaveProperty('station');
    expect(payload).not.toHaveProperty('mode');
  });

  it('orders the initial placement and street movement before door events', () => {
    const h = capture();
    const adapter = createStreetMovementAdapter({
      emit: (event, payload) => h.events.push({ event, payload }),
    });
    adapter.initial({ x: 10, y: 20 });
    adapter.streetUpdate({ x: 11, y: 20 }, { ...idle, right: true }, () => {
      h.events.push({ event: 'building:entered', payload: { building: 'bank' } });
    });

    expect(h.events.map(({ event }) => event)).toEqual([
      'player:moved',
      'player:moved',
      'building:entered',
    ]);
  });

  it('keeps interior updates silent and does not change street facing', () => {
    const h = capture();
    const adapter = createStreetMovementAdapter({
      emit: (event, payload) => h.events.push({ event, payload }),
    });
    adapter.initial({ x: 10, y: 20 });
    adapter.streetUpdate({ x: 11, y: 20 }, { ...idle, right: true }, () => {});
    adapter.interiorUpdate(() => {
      h.events.push({ event: 'station:activated', payload: { building: 'bank', station: 'bank:shielding' } });
    });

    expect(h.events.map(({ event }) => event)).toEqual([
      'player:moved',
      'player:moved',
      'station:activated',
    ]);
    expect(adapter.facing).toBe('right');
  });

  it('orders restored street placement before building exit', () => {
    const h = capture();
    const adapter = createStreetMovementAdapter({
      emit: (event, payload) => h.events.push({ event, payload }),
    });
    adapter.streetUpdate({ x: 11, y: 20 }, { ...idle, left: true }, () => {});
    adapter.exit({ x: 12, y: 20 }, () => {
      h.events.push({ event: 'building:exited', payload: { building: 'bank' } });
    });

    expect(h.events.map(({ event }) => event)).toEqual([
      'player:moved',
      'player:moved',
      'building:exited',
    ]);
    expect(h.events[1]!.payload).toEqual({ position: { x: 12, y: 20 }, facing: 'left' });
  });
});
