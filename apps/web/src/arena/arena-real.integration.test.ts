/**
 * D-114 end to end: two real shell presence controllers, each with its own
 * arena controller adopting its real `LobbyClient`, and a real lobby. One
 * player claims the ring and fights the dummy; the other watches from the
 * sand and sees the same HP sequence. Driven only by the World events the
 * session emits, and the channel calls the World's arena session makes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARENA_COUNTDOWN_MS,
  ARENA_MAX_HP,
  arenaTileCentre,
  type ArenaRingSnapshot,
  type Facing,
  type WorldEvents,
} from '@strkworld/shared';
import { LobbyClient } from '@strkworld/lobby/client';
import { startPresenceServer, type PresenceServer } from '@strkworld/lobby/server';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceController } from '../presence/presence-controller.js';
import { createArenaController, type ArenaController } from './arena-controller.js';

let server: PresenceServer | null = null;
const opened: Array<{ presence: PresenceController; arena: ArenaController; stop: () => void }> = [];

async function waitFor<T>(read: () => T, ready: (value: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 52_000 + Math.floor(Math.random() * 3_000),
    portAttempts: 40,
    room: { interestRadius: 2_000 },
  });
});

afterAll(async () => {
  for (const { presence, arena, stop } of opened.splice(0)) {
    stop();
    arena.destroy();
    await presence.destroy().catch(() => undefined);
  }
  await server?.shutdown().catch(() => undefined);
});

function player() {
  const world = createEventBus<WorldEvents>();
  const arena = createArenaController();
  const stopArena = arena.listen(world);
  const presence = createPresenceController({
    endpoint: server!.endpoint,
    factory: (options) => arena.adopt(new LobbyClient(options)),
    arena: arena.channel,
  });
  const stopPresence = presence.listen(world);
  const stop = () => {
    stopPresence();
    stopArena();
  };
  opened.push({ presence, arena, stop });
  const hp: number[] = [];
  arena.channel.subscribe((ring: ArenaRingSnapshot | null) => {
    if (ring && ring.opponent.kind === 'dummy' && ring.phase !== 'idle' && hp.at(-1) !== ring.opponent.hp) hp.push(ring.opponent.hp);
  });
  /** One tile at a time, as the World walks, past the move floor. */
  const walk = async (tiles: ReadonlyArray<readonly [number, number]>, facing: Facing) => {
    for (const [x, y] of tiles) {
      world.emit('area:moved', { position: arenaTileCentre({ x, y }), facing });
      await pause(70);
    }
  };
  return { world, presence, arena, hp, walk };
}

describe('the arena ring over a real lobby (D-114)', () => {
  it('one player fights the dummy to a knockout while a spectator sees the same HP sequence', async () => {
    const fighter = player();
    const fan = player();
    for (const who of [fighter, fan]) {
      who.world.emit('player:moved', { position: { x: 1300, y: 420 }, facing: 'down' });
    }
    await waitFor(() => fighter.presence.getState().status, (s) => s === 'connected', 'the fighter connected');
    await waitFor(() => fan.presence.getState().status, (s) => s === 'connected', 'the fan connected');

    // Both drop into the arena's west tunnel: the spawn first, then the door's entry.
    for (const who of [fighter, fan]) {
      who.world.emit('area:moved', { position: arenaTileCentre({ x: 2, y: 16 }), facing: 'right' });
      who.world.emit('building:entered', { building: 'arena' });
    }
    await waitFor(() => fighter.arena.channel.ring(), (r) => r !== null && r.phase === 'idle', 'the fighter to see the idle ring');
    await waitFor(() => fan.arena.channel.ring(), (r) => r !== null, 'the fan to see the ring');
    expect(fighter.arena.channel.selfId()).not.toBeNull();

    // The fighter walks east up the west tunnel to the gate approach; the fan onto the sand beside it.
    await fighter.walk([[3, 16], [4, 16], [5, 16], [6, 16], [7, 16], [8, 16], [9, 16], [10, 16], [11, 16], [12, 16], [13, 16], [14, 16]], 'right');
    await fan.walk([[3, 16], [4, 16], [5, 16], [6, 16], [7, 16], [8, 16], [9, 16], [9, 15], [9, 14], [9, 13]], 'right');

    // A claim from the approach: a new round with this client as challenger.
    fighter.arena.channel.claim();
    const claimed = await waitFor(() => fighter.arena.channel.ring(), (r) => r?.phase === 'countdown', 'the countdown');
    expect(claimed!.challenger.gameId).toBe(fighter.arena.channel.selfId());
    await waitFor(() => fan.arena.channel.ring(), (r) => r?.phase === 'countdown', 'the fan to see the countdown');
    // The fan's claim while busy changes nothing.
    fan.arena.channel.claim();

    // The World snaps itself to the ring spawn (the server already moved it), then steps east to the dummy.
    await fighter.walk([[17, 16], [18, 16], [19, 16], [20, 16]], 'right');
    await waitFor(() => fighter.arena.channel.ring(), (r) => r?.phase === 'fighting', 'the fight', ARENA_COUNTDOWN_MS + 3_000);

    // Ten swings at the client floor.
    for (let i = 0; i < 12; i += 1) {
      fighter.arena.channel.attack();
      await pause(470);
      if (fighter.arena.channel.ring()?.phase === 'ended') break;
    }
    const ended = await waitFor(() => fighter.arena.channel.ring(), (r) => r?.phase === 'ended', 'the knockout');
    expect(ended!.outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    await waitFor(() => fan.arena.channel.ring(), (r) => r?.phase === 'ended', 'the fan to see the knockout');

    const expected = Array.from({ length: 11 }, (_, i) => ARENA_MAX_HP - i * 10);
    expect(fighter.hp).toEqual(expected);
    // The spectator may see two hits in one patch, but never a number the fighter did not.
    expect(fan.hp.at(0)).toBe(ARENA_MAX_HP);
    expect(fan.hp.at(-1)).toBe(0);
    expect(fan.hp.every((value) => expected.includes(value))).toBe(true);
    expect(fan.arena.channel.ring()?.challenger.gameId).toBe(fighter.arena.channel.selfId());
  }, 40_000);
});
