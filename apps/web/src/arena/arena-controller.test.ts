import { describe, expect, it, vi } from 'vitest';
import { ARENA_MAX_HP, arenaTileCentre, type ArenaRingSnapshot, type GameId, type WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import {
  SOLO_ARENA_ID,
  SOLO_ARENA_TICK_MS,
  createArenaController,
  type ArenaLobbyClient,
  type SoloArenaAuthority,
} from './arena-controller.js';

const SELF = 'g-self' as GameId;
const APPROACH = arenaTileCentre({ x: 20, y: 11 });

function ring(phase: ArenaRingSnapshot['phase'] = 'idle', over: Partial<{ round: number; hp: number; gameId: GameId; seconds: number }> = {}): ArenaRingSnapshot {
  const busy = phase !== 'idle';
  const hp = over.hp ?? ARENA_MAX_HP;
  return {
    phase,
    round: over.round ?? 0,
    challenger: busy ? { kind: 'player', gameId: over.gameId ?? SELF, hp: ARENA_MAX_HP, swings: 0, hits: 0 } : { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 },
    opponent: busy ? { kind: 'dummy', gameId: null, hp, swings: 0, hits: 0 } : { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 },
    secondsLeft: over.seconds ?? 0,
    outcome: phase === 'ended' ? { reason: 'knockout', winner: 'challenger' } : null,
  };
}

function fakeClient(gameId: GameId | null = SELF) {
  let current: unknown = null;
  const arenaListeners = new Set<(ring: ArenaRingSnapshot | null) => void>();
  const statusListeners = new Set<(event: { status: string }) => void>();
  const client = {
    gameId,
    arena: () => current as ArenaRingSnapshot | null,
    onArena(listener: (ring: ArenaRingSnapshot | null) => void) {
      arenaListeners.add(listener);
      return () => arenaListeners.delete(listener);
    },
    arenaClaim: vi.fn(() => true),
    arenaAttack: vi.fn(() => true),
    arenaLeave: vi.fn(() => true),
    onStatus(listener: (event: { status: string }) => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  } satisfies ArenaLobbyClient;
  return {
    client,
    ring(next: unknown) {
      current = next;
      for (const listener of [...arenaListeners]) listener(next as ArenaRingSnapshot | null);
    },
    status(status: string) {
      for (const listener of [...statusListeners]) listener({ status });
    },
    listenerCount: () => arenaListeners.size + statusListeners.size,
  };
}

function manualTime(start = 50_000) {
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
    get size() {
      return pending.size;
    },
  };
}

describe('arena controller: the lobby is the authority while connected', () => {
  it('hands the World the lobby’s ring, validated, and its own presence id', () => {
    const controller = createArenaController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    const seen: Array<ArenaRingSnapshot | null> = [];
    controller.channel.subscribe((r) => seen.push(r));
    lobby.ring(ring('countdown', { round: 1, seconds: 3 }));
    expect(controller.channel.ring()?.phase).toBe('countdown');
    expect(controller.channel.selfId()).toBe(SELF);
    expect(seen.at(-1)?.round).toBe(1);
    // A malformed ring fails closed.
    lobby.ring({ phase: 'fighting', round: 'x' });
    expect(controller.channel.ring()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it('the same reading returns the same object (a stable store for the HUD)', () => {
    const controller = createArenaController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    lobby.ring(ring('fighting', { round: 1, seconds: 40 }));
    expect(controller.channel.ring()).toBe(controller.channel.ring());
  });

  it('sends the three payload-less intents through the client', () => {
    const controller = createArenaController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    controller.channel.claim();
    controller.channel.attack();
    controller.channel.leave();
    expect(lobby.client.arenaClaim).toHaveBeenCalledWith();
    expect(lobby.client.arenaAttack).toHaveBeenCalledWith();
    expect(lobby.client.arenaLeave).toHaveBeenCalledWith();
  });

  it('STRIKE goes through the World’s click path when it listens, else straight to an attack', () => {
    const controller = createArenaController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    controller.channel.strike();
    expect(lobby.client.arenaAttack).toHaveBeenCalledTimes(1);
    const world = vi.fn();
    const stop = controller.channel.subscribeStrikes!(world);
    controller.channel.strike();
    expect(world).toHaveBeenCalledTimes(1);
    expect(lobby.client.arenaAttack).toHaveBeenCalledTimes(1);
    stop();
    controller.channel.strike();
    expect(lobby.client.arenaAttack).toHaveBeenCalledTimes(2);
  });

  it('without a solo authority, a closed connection leaves no ring', () => {
    const controller = createArenaController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    lobby.ring(ring('fighting', { round: 2 }));
    lobby.status('closed');
    expect(controller.channel.ring()).toBeNull();
    expect(controller.channel.selfId()).toBeNull();
  });

  it('destroy stops listening and goes quiet', () => {
    const controller = createArenaController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    controller.destroy();
    expect(lobby.listenerCount()).toBe(0);
    expect(controller.channel.ring()).toBeNull();
    controller.channel.claim();
    expect(lobby.client.arenaClaim).not.toHaveBeenCalled();
  });
});

describe('arena controller: solo play runs the injected authority', () => {
  /** A stand-in with the lobby authority's shape, recording what it is asked. */
  function fakeAuthority() {
    let phase: ArenaRingSnapshot['phase'] = 'idle';
    let round = 0;
    let hp = ARENA_MAX_HP;
    let claimedAt = 0;
    const calls: string[] = [];
    const authority: SoloArenaAuthority = {
      snapshot: () => ring(phase, { round, hp, gameId: SOLO_ARENA_ID }),
      get active() {
        return phase !== 'idle';
      },
      claim(claimant, now) {
        claimedAt = now;
        calls.push(`claim ${claimant.key} ${claimant.area} ${claimant.x},${claimant.y}`);
        phase = 'countdown';
        round += 1;
        return 'applied';
      },
      attack(key, _now, locate) {
        calls.push(`attack ${key} ${locate(key)?.facing}`);
        hp -= 10;
        return 'hit';
      },
      leave(key) {
        calls.push(`leave ${key}`);
        phase = 'ended';
        return 'applied';
      },
      gone(key, reason) {
        calls.push(`gone ${key} ${reason}`);
        return true;
      },
      advance(now) {
        if (phase === 'countdown' && now - claimedAt >= SOLO_ARENA_TICK_MS) {
          phase = 'fighting';
          return [{ kind: 'place', key: 'local', tile: { x: 20, y: 14 }, facing: 'down' }];
        }
        return [];
      },
    };
    return { authority, calls };
  }

  it('shows the solo ring only inside the arena, with the solo stand-in id', () => {
    const time = manualTime();
    const { authority } = fakeAuthority();
    const controller = createArenaController({ solo: () => authority, ...time });
    const world = createEventBus<WorldEvents>();
    controller.listen(world);
    expect(controller.channel.ring()).toBeNull();
    world.emit('area:moved', { position: APPROACH, facing: 'down' });
    world.emit('building:entered', { building: 'arena' });
    expect(controller.channel.inArena()).toBe(true);
    expect(controller.channel.ring()?.phase).toBe('idle');
    expect(controller.channel.selfId()).toBe(SOLO_ARENA_ID);
    world.emit('building:exited', { building: 'arena' });
    expect(controller.channel.ring()).toBeNull();
  });

  it('claims from where the player stands, ticks the deadlines and attacks with the facing', () => {
    const time = manualTime();
    const { authority, calls } = fakeAuthority();
    const controller = createArenaController({ solo: () => authority, ...time });
    const world = createEventBus<WorldEvents>();
    controller.listen(world);
    world.emit('area:moved', { position: APPROACH, facing: 'down' });
    world.emit('building:entered', { building: 'arena' });
    const seen: string[] = [];
    controller.channel.subscribe((r) => seen.push(r?.phase ?? 'none'));
    controller.channel.claim();
    expect(calls[0]).toBe(`claim local arena ${APPROACH.x},${APPROACH.y}`);
    expect(seen.at(-1)).toBe('countdown');
    time.advance(SOLO_ARENA_TICK_MS);
    expect(seen.at(-1)).toBe('fighting');
    controller.channel.attack();
    expect(calls.at(-1)).toBe('attack local down');
    expect(controller.channel.ring()?.opponent.hp).toBe(90);
  });

  it('leaving the arena mid-fight tells the authority the player left', () => {
    const time = manualTime();
    const { authority, calls } = fakeAuthority();
    const controller = createArenaController({ solo: () => authority, ...time });
    const world = createEventBus<WorldEvents>();
    controller.listen(world);
    world.emit('area:moved', { position: APPROACH, facing: 'down' });
    world.emit('building:entered', { building: 'arena' });
    controller.channel.claim();
    world.emit('building:exited', { building: 'arena' });
    expect(calls.at(-1)).toBe('gone local left');
    expect(time.size).toBe(0);
  });

  it('a lobby connection takes over from solo play, and solo resumes when it closes', () => {
    const time = manualTime();
    const { authority, calls } = fakeAuthority();
    const controller = createArenaController({ solo: () => authority, ...time });
    const world = createEventBus<WorldEvents>();
    controller.listen(world);
    world.emit('area:moved', { position: APPROACH, facing: 'down' });
    world.emit('building:entered', { building: 'arena' });
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.status('connected');
    expect(calls.at(-1)).toBe('gone local disconnect');
    lobby.ring(ring('fighting', { round: 7 }));
    expect(controller.channel.ring()?.round).toBe(7);
    expect(controller.channel.selfId()).toBe(SELF);
    lobby.status('closed');
    expect(controller.channel.selfId()).toBe(SOLO_ARENA_ID);
  });
});
