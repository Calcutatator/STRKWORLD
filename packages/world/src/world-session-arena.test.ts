import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARENA_BOX,
  ARENA_DUMMY_TILE,
  ARENA_EXIT,
  ARENA_GATE_APPROACH,
  ARENA_HEIGHT,
  ARENA_RING_GATE,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  ARENA_RING_WALKABLE,
  ARENA_SPAWN,
  ARENA_SPAWN_FACING,
  ARENA_WIDTH,
  arenaTileCentre,
  type ShellEvents,
  type WorldEvents,
} from '@strkworld/shared';
import type { ArenaChannel, ArenaSessionHost, ArenaViewFrame } from './arena-channel.js';
import { DOOR_REENTRY_HOLD_MS } from './door-trigger.js';
import { COLOSSEUM_DOOR, COLOSSEUM_RETURN, COLOSSEUM_RETURN_FACING } from './map/colosseum.js';
import { TILE_SIZE } from './map/street.js';
import { FIXED_ROOM_TILE_SIZE } from './fixed-room.js';
import type { MovementInput } from './street-movement.js';
import { ROOM_ORIGIN } from './world-layout.js';
import { createWorldSession, type WorldActionKey, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * The gladiator pit's arena in the gameplay session (D-114): walking (or
 * jumping) onto the pit's west arch enters the arena, a shared presence area
 * like the bunker; its exit puts the player back on the pit's branch facing west;
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
  /** Whether the stand-in offers C's press-E members (gateTargets, onAttack). */
  pressE: false,
  gate: [] as Array<{ id: string; label: string; rect: { x: number; y: number; width: number; height: number }; activate(): unknown }>,
  attacks: 0,
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
      ...(ring.pressE
        ? {
          gateTargets: () => ring.gate,
          onAttack: () => {
            ring.attacks += 1;
            return true;
          },
        }
        : {}),
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
  ring.pressE = false;
  ring.gate = [];
  ring.attacks = 0;
});

describe('the arena in the session (D-114)', () => {
  it('walks from the path onto the arch into the arena, publishing the spawn before the entry', () => {
    const world = setup();
    world.onStreet(COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y);
    expect(world.session.area).toBe('street');
    const before = world.emitted.length;
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    expect(world.events('building:entered')).toEqual([{ building: 'arena' }]);
    expect(world.session.area).toBe('arena');
    expect(world.session.level).toBe('ground');
    expect(world.last('showRoom')).toEqual(['arena']);
    // The street is hidden; the remote layer stays on, for the arena's own players.
    expect(world.last('setStreetVisible')).toEqual([false]);
    expect(world.last('setRemoteVisible')).toEqual([true]);
    // In the west tunnel at the spawn, facing east, into the arena,
    // whichever way the player stepped onto the arch.
    const spawn = world.roomTile(ARENA_SPAWN.x, ARENA_SPAWN.y);
    expect(world.position()).toEqual(spawn);
    const entry = world.emitted.slice(before).filter((e) => e.event !== 'player:moved');
    expect(entry.map((e) => e.event)).toEqual(['area:moved', 'building:entered']);
    expect(entry[0]!.payload).toEqual({ position: spawn, facing: ARENA_SPAWN_FACING });
    // The drop through the arch is a leap, facing in.
    expect(world.last('setPlayerFacing')).toEqual([ARENA_SPAWN_FACING]);
    expect(world.count('playerJump')).toBe(1);
    // Every move inside is published.
    const from = world.emitted.length;
    world.inRoom(20, 6);
    world.inRoom(12, 14);
    expect(new Set(world.emitted.slice(from).map((e) => e.event))).toEqual(new Set(['area:moved']));
  });

  it('enters on a jump onto the arch too: the tile is what counts (D-097)', () => {
    const world = setup();
    world.onStreet(COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y);
    world.keyboard.press('keydown-Space');
    expect(world.session.jump).toBe('airborne');
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y + 1);
    expect(world.events('building:entered')).toEqual([{ building: 'arena' }]);
    expect(world.session.area).toBe('arena');
  });

  it('drops in without the leap under reduced motion', () => {
    const world = setup({ reducedMotion: true });
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    expect(world.session.area).toBe('arena');
    expect(world.count('playerJump')).toBe(0);
  });

  it('leaves by the west tunnel onto the pit\'s branch, facing west, never into the bowl', () => {
    const world = setup();
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    ring.frame = { phase: 'idle', gate: 'open', dummy: null, challengerId: null, challengerSwings: 0, selfIsChallenger: false, challengerGuarding: false, challengerBlocks: 0, championId: null, throneId: null, selfIsChampion: false, selfOnThrone: false };
    world.inRoom(20, 4);
    expect(world.last('syncArena')).toEqual([ring.frame]);
    const from = world.emitted.length;
    world.inRoom(ARENA_EXIT.x, ARENA_EXIT.y + 1);
    expect(world.events('building:exited')).toEqual([{ building: 'arena' }]);
    const leaving = world.emitted.slice(from).map((e) => e.event).filter((e) => e !== 'area:moved');
    expect(leaving.slice(0, leaving.indexOf('building:exited') + 1)).toEqual(['player:moved', 'building:exited']);
    expect(world.session.area).toBe('street');
    expect(world.position()).toEqual({
      x: COLOSSEUM_RETURN.x * TILE_SIZE + TILE_SIZE / 2,
      y: COLOSSEUM_RETURN.y * TILE_SIZE + TILE_SIZE / 2,
    });
    expect(world.last('setPlayerFacing')).toEqual([COLOSSEUM_RETURN_FACING]);
    // Leaving clears the ring frame and the prompt off the view.
    expect(world.last('syncArena')).toEqual([null]);
    expect(world.last('setArenaPrompt')).toEqual([null]);
    // Standing on the branch does not re-enter; stepping back onto the arch does.
    world.onStreet(COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y);
    expect(world.session.area).toBe('street');
  });

  it('enters walking east off the Studio branch and leaves walking west the same way, with no bounce back in', () => {
    const world = setup();
    /** Hold keys frame by frame until `done`, at most `limit` ms; then let go. */
    const holdUntil = (keys: Partial<MovementInput>, done: () => boolean, limit = 3_000): void => {
      world.keyboard.hold(keys);
      for (let t = 0; t < limit && !done(); t += 16) world.session.update(16);
      world.keyboard.hold({});
    };
    const tileOf = (p: { x: number; y: number }) => ({
      x: Math.floor((p.x - ROOM_ORIGIN.x) / FIXED_ROOM_TILE_SIZE),
      y: Math.floor((p.y - ROOM_ORIGIN.y) / FIXED_ROOM_TILE_SIZE),
    });
    const streetMoves = () => world.events('player:moved') as Array<{ facing: string }>;
    world.onStreet(COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y);

    // East off the branch through the west arch: in.
    holdUntil({ right: true }, () => world.session.area === 'arena');
    expect(world.session.area).toBe('arena');
    expect(world.events('building:entered')).toEqual([{ building: 'arena' }]);
    // At the west tunnel's spawn, facing east, into the arena.
    expect(world.position()).toEqual(world.roomTile(ARENA_SPAWN.x, ARENA_SPAWN.y));
    expect(tileOf(world.position()).x).toBeLessThan(5);
    expect(world.last('setPlayerFacing')).toEqual([ARENA_SPAWN_FACING]);
    expect(world.events('area:moved').at(-1)).toMatchObject({ facing: ARENA_SPAWN_FACING });
    // Still holding east walks on into the arena, never back out.
    holdUntil({ right: true }, () => false, 600);
    expect(world.session.area).toBe('arena');
    expect(tileOf(world.position()).x).toBeGreaterThan(ARENA_SPAWN.x);

    // West, back down the tunnel the way they came: out.
    holdUntil({ left: true }, () => world.session.area === 'street');
    expect(world.session.area).toBe('street');
    expect(world.events('building:exited')).toEqual([{ building: 'arena' }]);
    // On the branch just outside the arch, facing west, back to the Studio path.
    expect(world.position()).toEqual({
      x: COLOSSEUM_RETURN.x * TILE_SIZE + TILE_SIZE / 2,
      y: COLOSSEUM_RETURN.y * TILE_SIZE + TILE_SIZE / 2,
    });
    expect(world.last('setPlayerFacing')).toEqual([COLOSSEUM_RETURN_FACING]);
    expect(streetMoves().at(-1)).toMatchObject({ facing: COLOSSEUM_RETURN_FACING });

    // Standing there, or holding west on along the branch, never goes back in.
    for (let t = 0; t < 2_000; t += 16) world.session.update(16);
    holdUntil({ left: true }, () => false, 400);
    for (let t = 0; t < 1_000; t += 16) world.session.update(16);
    expect(world.session.area).toBe('street');
    expect(world.events('building:entered')).toHaveLength(1);

    // Walking back east re-enters, as intended.
    holdUntil({ right: true }, () => world.session.area === 'arena');
    expect(world.session.area).toBe('arena');
    expect(world.events('building:entered')).toHaveLength(2);
    expect(world.last('setPlayerFacing')).toEqual([ARENA_SPAWN_FACING]);
  });

  it('holds the arch shut just after an exit: a key carried through the handoff cannot bounce the player back in', () => {
    const world = setup();
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    expect(world.session.area).toBe('arena');
    world.inRoom(ARENA_EXIT.x, ARENA_EXIT.y + 1);
    expect(world.session.area).toBe('street');
    // Straight back onto the arch inside the hold: swallowed.
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    expect(world.session.area).toBe('street');
    // Standing on it past the hold still does nothing until they step off.
    for (let t = 0; t < DOOR_REENTRY_HOLD_MS + 200; t += 16) world.session.update(16);
    expect(world.session.area).toBe('street');
    expect(world.events('building:entered')).toHaveLength(1);
    world.onStreet(COLOSSEUM_RETURN.x, COLOSSEUM_RETURN.y);
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    expect(world.session.area).toBe('arena');
    expect(world.events('building:entered')).toHaveLength(2);
  });

  it('keeps the ring solid unless the arena session opens it, and the dummy solid always', () => {
    const world = setup();
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
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
    const above = world.roomTile(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y - 2);
    world.place(above.x, above.y);
    world.walk({ down: true }, 800);
    const dummyTop = ROOM_ORIGIN.y + ARENA_DUMMY_TILE.y * FIXED_ROOM_TILE_SIZE;
    expect(world.position().y).toBeLessThanOrEqual(dummyTop);
    // And the fence holds the fighter in.
    const west = world.roomTile(16, 16);
    world.place(west.x, west.y);
    world.walk({ left: true }, 800);
    expect(world.position().x).toBeGreaterThanOrEqual(ROOM_ORIGIN.x + 16 * FIXED_ROOM_TILE_SIZE);
  });

  it('opens exactly the lobby\'s challenger rects (ARENA_RING_WALKABLE), and only when the session says so', () => {
    const world = setup();
    const open = (x: number, y: number): boolean =>
      (world.session as unknown as { ringTileOpen(x: number, y: number): boolean }).ringTileOpen(x, y);
    const inRects = (x: number, y: number): boolean =>
      ARENA_RING_WALKABLE.some((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
    for (const walkable of [false, true]) {
      ring.walkable = walkable;
      for (let y = -1; y <= ARENA_HEIGHT; y++) {
        for (let x = -1; x <= ARENA_WIDTH; x++) {
          expect(open(x, y), `${x},${y} (${walkable})`).toBe(walkable && inRects(x, y));
        }
      }
    }
  });

  it('leaps to the ring\'s spawn and back to its return tile when the session says so, publishing each', () => {
    const world = setup();
    const host = ring.host!;
    expect(host).not.toBeNull();
    // Outside the arena a leap does nothing.
    const street = world.position();
    host.leapTo(ARENA_RING_SPAWN, ARENA_RING_SPAWN_FACING);
    expect(world.position()).toEqual(street);
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    world.inRoom(20, 10);
    const jumps = world.count('playerJump');
    const from = world.emitted.length;
    // In through the west gate, facing east at the dummy.
    host.leapTo(ARENA_RING_SPAWN, ARENA_RING_SPAWN_FACING);
    expect(world.position()).toEqual(arenaTileCentre(ARENA_RING_SPAWN));
    expect(world.emitted.slice(from).at(-1)).toEqual({
      event: 'area:moved',
      payload: { position: arenaTileCentre(ARENA_RING_SPAWN), facing: ARENA_RING_SPAWN_FACING },
    });
    expect(world.count('playerJump')).toBe(jumps + 1);
    expect(world.last('setPlayerFacing')).toEqual([ARENA_RING_SPAWN_FACING]);
    expect(host.position()).toEqual({ ...arenaTileCentre(ARENA_RING_SPAWN), facing: ARENA_RING_SPAWN_FACING });
    // Out onto the approach, facing west, back down the tunnel.
    host.leapTo(ARENA_RING_RETURN, ARENA_RING_RETURN_FACING);
    expect(world.position()).toEqual(arenaTileCentre(ARENA_RING_RETURN));
    expect(world.emitted.at(-1)).toEqual({
      event: 'area:moved',
      payload: { position: arenaTileCentre(ARENA_RING_RETURN), facing: ARENA_RING_RETURN_FACING },
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
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
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
    // D-117: E is interact, so a station in reach (the emperor's box) takes
    // the press first; the ring's claim and strikes are an action behind it.
    world.inRoom(ARENA_BOX.x, ARENA_BOX.y + 2);
    world.walk({ up: true }, 120);
    expect(world.session.interactionPrompt).toMatchObject({ id: 'arena:box' });
    const before = ring.interacts;
    world.keyboard.press('keydown-E');
    expect(ring.interacts).toBe(before);
    world.session.destroy();
    expect(ring.destroyed).toBe(1);
  });

  it('puts the ring gate on press-E as a station, E in a fight as the attack, and lends the session the combat yield', () => {
    ring.pressE = true;
    const world = setup();
    // C's optional host members, read structurally (they join the contract with C).
    const host = ring.host! as ArenaSessionHost & {
      suspendInteractions?(reason: string): () => void;
      inputSuspended?(): boolean;
      gateObject?(): unknown;
    };
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    world.inRoom(ARENA_GATE_APPROACH.x, 16);
    // C's gate target: CLAIM, on the gate's footprint (World pixels).
    let claimed = 0;
    const gate = world.roomTile(ARENA_RING_GATE.x, 16);
    ring.gate = [{ id: 'arena:gate', label: 'CLAIM', rect: { x: gate.x - 16, y: gate.y - 48, width: 32, height: 96 }, activate: () => void (claimed += 1) }];
    world.walk({ right: true }, 60);
    expect(world.session.interactionPrompt).toMatchObject({ id: 'arena:gate', label: 'CLAIM' });
    world.keyboard.press('keydown-E');
    expect([claimed, ring.attacks, ring.interacts]).toEqual([1, 0, 0]);
    // A fight: the session holds the yield, so no station is prompted and E attacks.
    const release = host.suspendInteractions!('combat');
    world.session.update(16);
    expect(world.session.interactionPrompt).toBeNull();
    world.keyboard.press('keydown-E');
    expect([claimed, ring.attacks]).toEqual([1, 1]);
    release();
    world.session.update(16);
    expect(world.session.interactionPrompt).toMatchObject({ id: 'arena:gate' });
    // The host reports a Shell claim on the keys, and hands over the gate's mesh.
    expect(host.inputSuspended!()).toBe(false);
    world.shellEmit('world:control-owner', { building: 'arena', owner: 'shell' });
    expect(host.inputSuspended!()).toBe(true);
    world.shellEmit('world:control-owner', { building: 'arena', owner: 'world' });
    host.gateObject!();
    expect(world.count('arenaGateObject')).toBe(1);
    // Off the arena, the gate offers nothing.
    world.inRoom(ARENA_EXIT.x, ARENA_EXIT.y + 1);
    expect(world.session.area).toBe('street');
    expect(world.session.interactionPrompt).toBeNull();
  });

  it('locks F while the session says so, and switches into the paired fighting look and back', () => {
    const world = setup();
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
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
    world.onStreet(COLOSSEUM_DOOR.x, COLOSSEUM_DOOR.y);
    expect(world.session.area).toBe('arena');
    const inside = world.roomTile(18, 16);
    world.place(inside.x, inside.y);
    world.walk({ right: true }, 200);
    expect(world.position()).toEqual(inside);
  });
});
