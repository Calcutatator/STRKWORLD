/**
 * D-133: the World's side of the lookout swing. It never decides who rides —
 * the lobby does — so what is pinned here is that it obeys the snapshot it is
 * given: the press-E target it offers, mounting and dismounting on the
 * server's rounds, holding movement and E for the ride and handing both back
 * (and the camera with them) at the end, and sending nothing it should not.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ROOF_SWING_TARGET_ID,
  SWING_INTENT_CLIENT_INTERVAL_MS,
  SWING_RIDE_MS,
  SWING_SEAT_FACING,
  SWING_SEAT_TILE,
  SWING_STEP_OFF_FACING,
  SWING_STEP_OFF_TILE,
  roofTileCentre,
  type Facing,
  type GameId,
  type RoofSwingSnapshot,
} from '@strkworld/shared';
import type { RoofSwingChannel, RoofSwingSessionHost } from './roof-swing-channel';
import {
  SWING_BUSY_LABEL,
  SWING_LABEL,
  createRoofSwingSession,
} from './roof-swing-session';
import { SWING_CAMERA_YAW } from './roof-swing';

const SELF = 'self' as GameId;
const OTHER = 'other' as GameId;
const APPROACH = roofTileCentre({ x: 3, y: 4 });
const AWAY = roofTileCentre({ x: 1, y: 1 });

const idle = (round = 1): RoofSwingSnapshot =>
  Object.freeze({ phase: 'idle', round, riderId: null, secondsLeft: 0, reason: null });
const riding = (riderId: GameId, round = 2, secondsLeft = 20): RoofSwingSnapshot =>
  Object.freeze({ phase: 'riding', round, riderId, secondsLeft, reason: null });
const cooling = (round = 2): RoofSwingSnapshot =>
  Object.freeze({ phase: 'cooldown', round, riderId: null, secondsLeft: 0, reason: 'timeout' });

/** A channel the test drives, recording every intent sent through it. */
function harness(options: { reducedMotion?: boolean; selfId?: GameId | null } = {}) {
  let swing: RoofSwingSnapshot | null = null;
  const listeners = new Set<(value: RoofSwingSnapshot | null) => void>();
  const sent: string[] = [];
  const placed: { tile: { x: number; y: number }; facing: Facing }[] = [];
  const held: string[] = [];
  let at = { x: APPROACH.x, y: APPROACH.y, facing: 'up' as Facing };
  let clock = 0;
  let inputSuspended = false;

  const channel: RoofSwingChannel = {
    swing: () => swing,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selfId: () => (options.selfId === undefined ? SELF : options.selfId),
    claim: () => void sent.push('claim'),
    leave: () => void sent.push('leave'),
  };

  const host: RoofSwingSessionHost = {
    position: () => at,
    placeAt: (tile, facing) => void placed.push({ tile: { x: tile.x, y: tile.y }, facing }),
    reducedMotion: () => options.reducedMotion === true,
    swingObject: () => null,
    inputSuspended: () => inputSuspended,
    suspendInteractions: (reason) => {
      held.push(`interactions:${reason}`);
      return () => held.splice(held.indexOf(`interactions:${reason}`), 1);
    },
    suspendInput: (reason) => {
      held.push(`input:${reason}`);
      return () => held.splice(held.indexOf(`input:${reason}`), 1);
    },
  };

  const session = createRoofSwingSession(channel, host, { now: () => clock });

  return {
    session,
    sent,
    placed,
    held,
    /** Push a snapshot, as the lobby would. */
    push(next: RoofSwingSnapshot | null) {
      swing = next;
      for (const listener of listeners) listener(next);
    },
    advance(ms: number) {
      clock += ms;
      session.update(ms);
    },
    stand(x: number, y: number) {
      at = { x, y, facing: 'up' };
    },
    suspendInput(on: boolean) {
      inputSuspended = on;
    },
    listeners,
  };
}

describe('the swing\'s press-E target (D-133)', () => {
  it('offers SWING on the approach while the swing is free', () => {
    const h = harness();
    h.push(idle());
    const [target] = h.session.targets();
    expect(target?.id).toBe(ROOF_SWING_TARGET_ID);
    expect(target?.label).toBe(SWING_LABEL);
  });

  it('reads IN USE while somebody else is on it, and sends nothing on a press', () => {
    const h = harness();
    h.push(riding(OTHER));
    const [target] = h.session.targets();
    expect(target?.label).toBe(SWING_BUSY_LABEL);
    // The press is taken and nothing goes to the server: it is not free.
    expect(target?.activate()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('still reads IN USE through the cooldown, so nobody claims into the step-off', () => {
    const h = harness();
    h.push(cooling());
    expect(h.session.targets()[0]?.label).toBe(SWING_BUSY_LABEL);
  });

  it('offers nothing off the approach, however free the swing is', () => {
    const h = harness();
    h.push(idle());
    h.stand(AWAY.x, AWAY.y);
    expect(h.session.targets()).toEqual([]);
  });

  it('offers nothing before any snapshot has arrived', () => {
    const h = harness();
    expect(h.session.targets()).toEqual([]);
  });

  it('offers nothing to the rider: they are on the seat, not in front of it', () => {
    const h = harness();
    h.push(riding(SELF));
    expect(h.session.targets()).toEqual([]);
  });

  it('sends one claim on a press, and holds a flood to the client floor', () => {
    const h = harness();
    h.push(idle());
    const target = h.session.targets()[0];
    expect(target?.activate()).toBe(true);
    expect(h.sent).toEqual(['claim']);
    // A second press inside the floor is taken but not sent.
    expect(h.session.targets()[0]?.activate()).toBe(true);
    expect(h.sent).toEqual(['claim']);
    h.advance(SWING_INTENT_CLIENT_INTERVAL_MS);
    h.session.targets()[0]?.activate();
    expect(h.sent).toEqual(['claim', 'claim']);
  });

  it('sends nothing while a panel or Shell claim owns the keyboard', () => {
    const h = harness();
    h.push(idle());
    h.suspendInput(true);
    expect(h.session.targets()[0]?.activate()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe('the ride, on the server\'s rounds (D-133)', () => {
  it('sits the player on the seat when a round names them the rider', () => {
    const h = harness();
    h.push(riding(SELF));
    expect(h.placed).toEqual([{ tile: { x: SWING_SEAT_TILE.x, y: SWING_SEAT_TILE.y }, facing: SWING_SEAT_FACING }]);
    expect(h.session.frame()).toMatchObject({ selfRiding: true, busy: true, riderId: SELF });
  });

  it('does not mount for somebody else\'s ride', () => {
    const h = harness();
    h.push(riding(OTHER));
    expect(h.placed).toEqual([]);
    expect(h.session.frame()).toMatchObject({ selfRiding: false, busy: true, shot: null });
  });

  it('holds movement and the press-E system for the whole ride', () => {
    const h = harness();
    h.push(riding(SELF));
    expect(h.held).toEqual(['interactions:swing', 'input:swing']);
  });

  it('hands movement, E and the camera back when the round ends', () => {
    const h = harness();
    h.push(riding(SELF));
    h.push(cooling());
    // Back on the step-off tile, facing the deck.
    expect(h.placed.at(-1)).toEqual({
      tile: { x: SWING_STEP_OFF_TILE.x, y: SWING_STEP_OFF_TILE.y },
      facing: SWING_STEP_OFF_FACING,
    });
    // Nothing is still held, and the camera is no longer the swing's.
    expect(h.held).toEqual([]);
    expect(h.session.frame()?.shot).toBeNull();
    expect(h.session.frame()?.selfRiding).toBe(false);
  });

  it('hands everything back when the swing goes straight to idle', () => {
    const h = harness();
    h.push(riding(SELF));
    h.push(idle(3));
    expect(h.held).toEqual([]);
    expect(h.session.frame()?.shot).toBeNull();
  });

  it('hands everything back when the snapshot stops arriving altogether', () => {
    const h = harness();
    h.push(riding(SELF));
    h.push(null);
    expect(h.held).toEqual([]);
    expect(h.session.frame()).toBeNull();
  });

  it('remounts for a new round rather than running the old ride on', () => {
    const h = harness();
    h.push(riding(SELF, 2));
    h.advance(5_000);
    const mid = h.session.frame()?.angle ?? 0;
    expect(Math.abs(mid)).toBeGreaterThan(0);
    // A new round is a new ride: the timeline restarts from rest.
    h.push(riding(SELF, 3));
    expect(h.session.frame()?.angle).toBeCloseTo(0, 6);
  });

  it('turns the rider\'s camera south over the edge, and follows the arc', () => {
    const h = harness();
    h.push(riding(SELF));
    h.advance(6_000);
    const shot = h.session.frame()?.shot;
    expect(shot?.yaw).toBe(SWING_CAMERA_YAW);
    expect(shot?.cut).toBe(false);
  });

  it('animates a spectator\'s swing from the seconds the server has left', () => {
    const h = harness();
    // Ten seconds in: the spectator's seat is mid-arc, not at rest.
    h.push(riding(OTHER, 2, 10));
    const frame = h.session.frame();
    expect(frame?.selfRiding).toBe(false);
    expect(Math.abs(frame?.angle ?? 0)).toBeGreaterThan(0);
  });

  it('leaves the seat at rest while nobody rides', () => {
    const h = harness();
    h.push(idle());
    h.advance(5_000);
    expect(h.session.frame()).toMatchObject({ angle: 0, busy: false, shot: null });
  });

  it('runs no further than the ride: the angle settles by the end', () => {
    const h = harness();
    h.push(riding(SELF));
    h.advance(SWING_RIDE_MS);
    expect(h.session.frame()?.angle).toBeCloseTo(0, 6);
  });
});

describe('getting off (D-133)', () => {
  it('sends the leave on Esc, and never ends its own ride', () => {
    const h = harness();
    h.push(riding(SELF));
    expect(h.session.onLeave()).toBe(true);
    expect(h.sent).toEqual(['leave']);
    // The ride is the server's to end: nothing moved until it says so.
    expect(h.session.frame()?.selfRiding).toBe(true);
    expect(h.held).toEqual(['interactions:swing', 'input:swing']);
  });

  it('sends nothing when this client is not the rider', () => {
    const h = harness();
    h.push(riding(OTHER));
    expect(h.session.onLeave()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the swing is idle', () => {
    const h = harness();
    h.push(idle());
    expect(h.session.onLeave()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe('reduced motion, and shutting down (D-133)', () => {
  it('sways gently and cuts to a still south-facing shot', () => {
    const h = harness({ reducedMotion: true });
    h.push(riding(SELF));
    h.advance(3_000);
    const frame = h.session.frame();
    expect(frame?.shot?.cut).toBe(true);
    expect(frame?.shot?.yaw).toBe(SWING_CAMERA_YAW);
    // A sway, not an arc.
    expect(Math.abs(frame?.angle ?? 0)).toBeLessThan(0.15);
  });

  it('releases movement, E and the camera on destroy, mid-ride', () => {
    const h = harness();
    h.push(riding(SELF));
    h.session.destroy();
    expect(h.held).toEqual([]);
    expect(h.session.frame()).toBeNull();
    expect(h.session.targets()).toEqual([]);
    // And it unsubscribes, so a late snapshot reaches nothing.
    expect(h.listeners.size).toBe(0);
  });

  it('sends nothing once destroyed', () => {
    const h = harness();
    h.push(riding(SELF));
    h.session.destroy();
    expect(h.session.onLeave()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('never mounts when this client\'s own id is unknown', () => {
    const h = harness({ selfId: null });
    h.push(riding(SELF));
    expect(h.placed).toEqual([]);
    expect(h.session.frame()?.selfRiding).toBe(false);
  });

  it('survives a host that throws, rather than stranding the ride', () => {
    const thrower = vi.fn(() => {
      throw new Error('no');
    });
    const channel: RoofSwingChannel = {
      swing: () => riding(SELF),
      subscribe: () => () => {},
      selfId: () => SELF,
      claim: () => {},
      leave: () => {},
    };
    const session = createRoofSwingSession(
      channel,
      {
        position: thrower as unknown as RoofSwingSessionHost['position'],
        placeAt: thrower,
        reducedMotion: thrower as unknown as RoofSwingSessionHost['reducedMotion'],
      },
      { now: () => 0 },
    );
    expect(() => session.update(16)).not.toThrow();
    expect(session.targets()).toEqual([]);
    expect(() => session.destroy()).not.toThrow();
  });
});
