import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARENA_DUMMY_TILE,
  ARENA_EXIT,
  ARENA_RING_RETURN,
  ARENA_RING_SPAWN,
  ARENA_SPAWN,
  arenaTileCentre,
  type ShellEvents,
  type WorldEvents,
} from '@strkworld/shared';
import type { ArenaChannel, ArenaSessionHost, ArenaViewFrame } from './arena-channel.js';
import { ARENA_PIT_DOOR, ARENA_PIT_RETURN } from './map/arena-pit.js';
import { TILE_SIZE } from './map/street.js';
import { FIXED_ROOM_TILE_SIZE } from './fixed-room.js';
import type { MovementInput } from './street-movement.js';
import { ROOM_ORIGIN } from './world-layout.js';
import { createWorldSession, type WorldActionKey, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * The gladiator pit's arena in the gameplay session (D-114): walking (or
 * jumping) onto the pit's arch enters the arena, a shared presence area like
 * the bunker; its exit puts the player back on the pit's path facing north;
 * the ring is solid unless the arena session (stream C) says the local player
 * is its fighter; the session's host leaps the player to the ring's tiles and
 * publishes the new place; and E and a primary click reach the session only
 * in the arena.
 */

// The arena session is stream C's; here it is a stand-in the test steers.
const ring = vi.hoisted(() => ({
  walkable: false,
  host: null as ArenaSessionHost | null,
  asked: [] as Array<[number, number]>,
  interacts: 0,
  primaries: 0,
  updates: 0,
  frame: null as ArenaViewFrame | null,
  destroyed: 0,
}));

vi.mock('./arena-session.js', () => ({
  createArenaSession: (_channel: unknown, host: ArenaSessionHost) => {
    ring.host = host;
    return {
      update: () => void (ring.updates += 1),
      isRingTileWalkable: (x: number, y: number) => {
        ring.asked.push([x, y]);
        return ring.walkable;
      },
      onInteract: () => {
        ring.interacts += 1;
        return true;
      },
      onPrimary: () => {
        ring.primaries += 1;
        return true;
      },
      frame: () => ring.frame,
      destroy: () => void (ring.destroyed += 1),
    };
  },
}));

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });

const CHANNEL: ArenaChannel = Object.freeze({
  ring: () => null,
  subscribe: () => () => {},
  selfId: () => null,
  claim: () => {},
  attack: () => {},
  leave: () => {},
});

function setup(options: { readonly arena?: boolean; readonly reducedMotion?: boolean } = {}) {
  let pressed: MovementInput = NO_KEYS;
  const handlers = new Map<WorldActionKey, Set<(event: { repeat: boolean; target: unknown }) => void>>();
  const keyboard: WorldKeyboard & { hold(keys: Partial<MovementInput>): void; press(key: WorldActionKey): void } = {
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
      const set = handlers.get(event) ?? new Set();
      set.add(handler as never);
      handlers.set(event, set);
      return undefined;
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler as never);
      return undefined;
    },
    hold(keys) {
      pressed = { ...NO_KEYS, ...keys };
    },
    press(key) {
      for (const handler of [...(handlers.get(key) ?? [])]) handler({ repeat: false, target: null });
    },
  };
  const emitted: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  const shell = new Map<keyof ShellEvents, Set<(payload: unknown) => void>>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
    },
  });
  const session = createWorldSession({
    view,
    keyboard,
    ...(options.arena === false ? {} : { arena: CHANNEL }),
    reducedMotion: () => options.reducedMotion === true,
    config: {
      out: { emit: (event, payload) => void emitted.push({ event, payload }) },
      in: {
        on(event, handler) {
          const set = shell.get(event) ?? new Set();
          set.add(handler as (payload: unknown) => void);
          shell.set(event, set);
          return () => set.delete(handler as (payload: unknown) => void);
        },
      },
    },
  });
  const internals = session as unknown as { position: { x: number; y: number } };
  const step = (x: number, y: number): void => {
    internals.position = { x, y };
    // One tiny step reports the tile, then stand still.
    keyboard.hold({ up: true });
    session.update(1);
    keyboard.hold({});
    session.update(16);
  };
  const roomTile = (x: number, y: number) => ({
    x: ROOM_ORIGIN.x + x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    y: ROOM_ORIGIN.y + y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
  });
  return {
    session,
    keyboard,
    emitted,
    calls,
    position: () => ({ ...internals.position }),
    place: (x: number, y: number) => {
      internals.position = { x, y };
    },
    walk: (keys: Partial<MovementInput>, ms: number) => {
      keyboard.hold(keys);
      for (let t = 0; t < ms; t += 16) session.update(16);
      keyboard.hold({});
      session.update(16);
    },
    roomTile,
    events: (name: keyof WorldEvents) => emitted.filter((entry) => entry.event === name).map((entry) => entry.payload),
    count: (method: string) => calls.filter((call) => call.method === method).length,
    last: (method: string) => [...calls].reverse().find((call) => call.method === method)?.args,
    onStreet: (x: number, y: number) => step(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2 + 2),
    inRoom: (x: number, y: number) => {
      const at = roomTile(x, y);
      step(at.x, at.y + 2);
    },
    shellEmit: (event: keyof ShellEvents, payload: unknown) => {
      for (const handler of [...(shell.get(event) ?? [])]) handler(payload);
    },
  };
}

beforeEach(() => {
  ring.walkable = false;
  ring.host = null;
  ring.asked = [];
  ring.interacts = 0;
  ring.primaries = 0;
  ring.updates = 0;
  ring.frame = null;
  ring.destroyed = 0;
});

describe('the arena in the session (D-114)', () => {
  it('walks from the path onto the arch into the arena, publishing the spawn before the entry', () => {
    const world = setup();
    world.onStreet(ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y);
    expect(world.session.area).toBe('street');
    const before = world.emitted.length;
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    expect(world.events('building:entered')).toEqual([{ building: 'arena' }]);
    expect(world.session.area).toBe('arena');
    expect(world.session.level).toBe('ground');
    expect(world.last('showRoom')).toEqual(['arena']);
    // The street is hidden; the remote layer stays on, for the arena's own players.
    expect(world.last('setStreetVisible')).toEqual([false]);
    expect(world.last('setRemoteVisible')).toEqual([true]);
    // In the tunnel at the spawn, facing the sand.
    const spawn = world.roomTile(ARENA_SPAWN.x, ARENA_SPAWN.y);
    expect(world.position()).toEqual(spawn);
    const entry = world.emitted.slice(before).filter((e) => e.event !== 'player:moved');
    expect(entry.map((e) => e.event)).toEqual(['area:moved', 'building:entered']);
    expect(entry[0]!.payload).toEqual({ position: spawn, facing: 'up' });
    // The drop through the arch is a leap, facing in.
    expect(world.last('setPlayerFacing')).toEqual(['up']);
    expect(world.count('playerJump')).toBe(1);
    // Every move inside is published.
    const from = world.emitted.length;
    world.inRoom(20, 26);
    world.inRoom(12, 18);
    expect(new Set(world.emitted.slice(from).map((e) => e.event))).toEqual(new Set(['area:moved']));
  });

  it('enters on a jump onto the arch too: the tile is what counts (D-097)', () => {
    const world = setup();
    world.onStreet(ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y);
    world.keyboard.press('keydown-Space');
    expect(world.session.jump).toBe('airborne');
    world.onStreet(ARENA_PIT_DOOR.x + 1, ARENA_PIT_DOOR.y);
    expect(world.events('building:entered')).toEqual([{ building: 'arena' }]);
    expect(world.session.area).toBe('arena');
  });

  it('drops in without the leap under reduced motion', () => {
    const world = setup({ reducedMotion: true });
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    expect(world.session.area).toBe('arena');
    expect(world.count('playerJump')).toBe(0);
  });

  it('leaves by the tunnel onto the pit\'s path, facing north, never into the bowl', () => {
    const world = setup();
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    ring.frame = { phase: 'idle', gate: 'open', dummy: null, challengerId: null, challengerSwings: 0, selfIsChallenger: false };
    world.inRoom(20, 28);
    expect(world.last('syncArena')).toEqual([ring.frame]);
    const from = world.emitted.length;
    world.inRoom(ARENA_EXIT.x + 1, ARENA_EXIT.y);
    expect(world.events('building:exited')).toEqual([{ building: 'arena' }]);
    const leaving = world.emitted.slice(from).map((e) => e.event).filter((e) => e !== 'area:moved');
    expect(leaving.slice(0, leaving.indexOf('building:exited') + 1)).toEqual(['player:moved', 'building:exited']);
    expect(world.session.area).toBe('street');
    expect(world.position()).toEqual({
      x: ARENA_PIT_RETURN.x * TILE_SIZE + TILE_SIZE / 2,
      y: ARENA_PIT_RETURN.y * TILE_SIZE + TILE_SIZE / 2,
    });
    expect(world.last('setPlayerFacing')).toEqual(['up']);
    // Leaving clears the ring frame and the prompt off the view.
    expect(world.last('syncArena')).toEqual([null]);
    expect(world.last('setArenaPrompt')).toEqual([null]);
    // Standing on the path does not re-enter; stepping back onto the arch does.
    world.onStreet(ARENA_PIT_RETURN.x, ARENA_PIT_RETURN.y);
    expect(world.session.area).toBe('street');
  });

  it('keeps the ring solid unless the arena session opens it, and the dummy solid always', () => {
    const world = setup();
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    // Inside the ring, west of the dummy: closed, nobody moves on its tiles.
    const inside = world.roomTile(18, 16);
    world.place(inside.x, inside.y);
    world.walk({ right: true }, 200);
    expect(world.position()).toEqual(inside);
    expect(ring.asked.length).toBeGreaterThan(0);
    for (const [x, y] of ring.asked) {
      expect(x >= 16 && x <= 24 && y >= 13 && y <= 19, `${x},${y}`).toBe(true);
    }
    // Opened for the fighter: they walk the ring.
    ring.walkable = true;
    world.walk({ right: true }, 200);
    expect(world.position().x).toBeGreaterThan(inside.x + 20);
    // But never into the dummy, whatever the session says.
    const below = world.roomTile(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y + 2);
    world.place(below.x, below.y);
    world.walk({ up: true }, 800);
    const dummyBottom = ROOM_ORIGIN.y + (ARENA_DUMMY_TILE.y + 1) * FIXED_ROOM_TILE_SIZE;
    expect(world.position().y).toBeGreaterThanOrEqual(dummyBottom);
    // And the fence holds the fighter in.
    const west = world.roomTile(16, 16);
    world.place(west.x, west.y);
    world.walk({ left: true }, 800);
    expect(world.position().x).toBeGreaterThanOrEqual(ROOM_ORIGIN.x + 16 * FIXED_ROOM_TILE_SIZE);
  });

  it('leaps to the ring\'s spawn and back to its return tile when the session says so, publishing each', () => {
    const world = setup();
    const host = ring.host!;
    expect(host).not.toBeNull();
    // Outside the arena a leap does nothing.
    const street = world.position();
    host.leapTo(ARENA_RING_SPAWN, 'up');
    expect(world.position()).toEqual(street);
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    world.inRoom(20, 22);
    const jumps = world.count('playerJump');
    const from = world.emitted.length;
    host.leapTo(ARENA_RING_SPAWN, 'up');
    expect(world.position()).toEqual(arenaTileCentre(ARENA_RING_SPAWN));
    expect(world.emitted.slice(from).at(-1)).toEqual({
      event: 'area:moved',
      payload: { position: arenaTileCentre(ARENA_RING_SPAWN), facing: 'up' },
    });
    expect(world.count('playerJump')).toBe(jumps + 1);
    expect(world.last('setPlayerFacing')).toEqual(['up']);
    expect(host.position()).toEqual({ ...arenaTileCentre(ARENA_RING_SPAWN), facing: 'up' });
    host.leapTo(ARENA_RING_RETURN, 'down');
    expect(world.position()).toEqual(arenaTileCentre(ARENA_RING_RETURN));
    expect(world.emitted.at(-1)).toEqual({
      event: 'area:moved',
      payload: { position: arenaTileCentre(ARENA_RING_RETURN), facing: 'down' },
    });
    // The room's tile grid and the shared arena geometry are one frame.
    expect(arenaTileCentre(ARENA_RING_RETURN)).toEqual(world.roomTile(ARENA_RING_RETURN.x, ARENA_RING_RETURN.y));
    // A junk tile is ignored.
    host.leapTo({ x: 0.5, y: 3 }, 'up');
    host.leapTo({ x: -4, y: 3 }, 'up');
    expect(world.position()).toEqual(arenaTileCentre(ARENA_RING_RETURN));
  });

  it('hands E and a primary click to the arena session only in the arena, while the World owns input', () => {
    const world = setup();
    world.keyboard.press('keydown-E');
    world.keyboard.press('pointerdown-primary');
    expect([ring.interacts, ring.primaries]).toEqual([0, 0]);
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    world.keyboard.press('keydown-E');
    world.keyboard.press('pointerdown-primary');
    expect([ring.interacts, ring.primaries]).toEqual([1, 1]);
    // A Shell claim on the room's controls silences both.
    world.shellEmit('world:control-owner', { building: 'arena', owner: 'shell' });
    world.keyboard.press('keydown-E');
    world.keyboard.press('pointerdown-primary');
    expect([ring.interacts, ring.primaries]).toEqual([1, 1]);
    world.shellEmit('world:control-owner', { building: 'arena', owner: 'world' });
    world.keyboard.press('keydown-E');
    expect(ring.interacts).toBe(2);
    // The session updates only in the arena, and its prompt and swing reach the view there.
    expect(ring.updates).toBeGreaterThan(0);
    ring.host!.setPrompt('E · ENTER THE RING');
    expect(world.last('setArenaPrompt')).toEqual(['E · ENTER THE RING']);
    ring.host!.playLocalSwing();
    expect(world.count('playerSwing')).toBe(1);
    world.session.destroy();
    expect(ring.destroyed).toBe(1);
  });

  it('locks F while the session says so, and switches into the paired fighting look and back', () => {
    const world = setup();
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    const host = ring.host!;
    host.selectLook('fighting');
    expect(world.events('avatar:selected')).toEqual([{ sprite: 'avatar-9' }]);
    host.setOutfitLocked(true);
    world.keyboard.press('keydown-F');
    expect(world.events('avatar:selected')).toHaveLength(1);
    host.setOutfitLocked(false);
    host.selectLook('restore');
    expect(world.events('avatar:selected')).toEqual([{ sprite: 'avatar-9' }, { sprite: 'avatar-1' }]);
    // Already in a fighting look: nothing to switch, nothing to restore.
    host.selectLook('fighting');
    world.keyboard.press('keydown-F');
    expect(world.events('avatar:selected').at(-1)).toEqual({ sprite: 'avatar-1' });
    expect(host.reducedMotion()).toBe(false);
  });

  it('without a channel the arena is a room to walk and watch from: the ring stays shut', () => {
    const world = setup({ arena: false });
    expect(ring.host).toBeNull();
    world.onStreet(ARENA_PIT_DOOR.x, ARENA_PIT_DOOR.y);
    expect(world.session.area).toBe('arena');
    const inside = world.roomTile(18, 16);
    world.place(inside.x, inside.y);
    world.walk({ right: true }, 200);
    expect(world.position()).toEqual(inside);
  });
});
