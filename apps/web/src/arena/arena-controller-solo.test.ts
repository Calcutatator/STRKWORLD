import { describe, expect, it } from 'vitest';
import {
  ARENA_ATTACK_CLIENT_INTERVAL_MS,
  ARENA_COUNTDOWN_MS,
  ARENA_MAX_HP,
  ARENA_RESULT_MS,
  arenaTileCentre,
  normalizeArenaRing,
  type ArenaRingSnapshot,
  type WorldEvents,
} from '@strkworld/shared';
import { createArenaAuthority } from '@strkworld/lobby/arena';
import { createEventBus } from '../bus/event-bus.js';
import { SOLO_ARENA_ID, createArenaController } from './arena-controller.js';

/**
 * D-114: with no lobby, the ring runs the lobby's own rules
 * (`@strkworld/lobby/arena`) in the browser: a whole fight to a knockout,
 * every snapshot validated, and the close puts the player back on the floor.
 */

function manualTime(start = 80_000) {
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
    advance(ms: number) {
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
  };
}

describe('arena controller: the solo ring runs the lobby’s rules', () => {
  it('fights to a knockout with no lobby, and closes back to idle', () => {
    const time = manualTime();
    const controller = createArenaController({ solo: () => createArenaAuthority(), ...time });
    const world = createEventBus<WorldEvents>();
    controller.listen(world);
    const seen: ArenaRingSnapshot[] = [];
    controller.channel.subscribe((ring) => {
      if (ring) seen.push(ring);
    });
    world.emit('area:moved', { position: arenaTileCentre({ x: 20, y: 2 }), facing: 'down' });
    world.emit('building:entered', { building: 'arena' });
    expect(controller.channel.selfId()).toBe(SOLO_ARENA_ID);
    expect(controller.channel.ring()?.phase).toBe('idle');

    // Off the approach the claim is refused; on it, it is the player's.
    controller.channel.claim();
    expect(controller.channel.ring()?.phase).toBe('idle');
    time.advance(1_000);
    world.emit('area:moved', { position: arenaTileCentre({ x: 20, y: 11 }), facing: 'down' });
    controller.channel.claim();
    const claimed = controller.channel.ring()!;
    expect(claimed.phase).toBe('countdown');
    expect(claimed.challenger).toMatchObject({ kind: 'player', gameId: SOLO_ARENA_ID, hp: ARENA_MAX_HP });

    // The World leaps in and steps down to the dummy, facing it.
    world.emit('area:moved', { position: arenaTileCentre({ x: 20, y: 17 }), facing: 'down' });
    time.advance(ARENA_COUNTDOWN_MS);
    expect(controller.channel.ring()?.phase).toBe('fighting');
    for (let i = 0; i < 10; i += 1) {
      controller.channel.attack();
      time.advance(ARENA_ATTACK_CLIENT_INTERVAL_MS);
    }
    const ended = controller.channel.ring()!;
    expect(ended.phase).toBe('ended');
    expect(ended.opponent.hp).toBe(0);
    expect(ended.outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    // Every snapshot handed out passes the wire validator.
    for (const ring of seen) expect(normalizeArenaRing(ring)).toEqual(ring);
    const hp = [...new Set(seen.filter((r) => r.opponent.kind === 'dummy').map((r) => r.opponent.hp))];
    expect(hp).toEqual(Array.from({ length: 11 }, (_, i) => ARENA_MAX_HP - i * 10));

    time.advance(ARENA_RESULT_MS + 200);
    expect(controller.channel.ring()?.phase).toBe('idle');
  });

  it('a swing from out of reach misses: the client never decides a hit', () => {
    const time = manualTime();
    const controller = createArenaController({ solo: () => createArenaAuthority(), ...time });
    const world = createEventBus<WorldEvents>();
    controller.listen(world);
    world.emit('area:moved', { position: arenaTileCentre({ x: 20, y: 11 }), facing: 'down' });
    world.emit('building:entered', { building: 'arena' });
    controller.channel.claim();
    // Stays on the ring spawn, four tiles from the dummy.
    world.emit('area:moved', { position: arenaTileCentre({ x: 20, y: 14 }), facing: 'down' });
    time.advance(ARENA_COUNTDOWN_MS);
    controller.channel.attack();
    const ring = controller.channel.ring()!;
    expect(ring.challenger.swings).toBe(1);
    expect(ring.opponent.hp).toBe(ARENA_MAX_HP);
  });
});
