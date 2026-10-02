import { describe, expect, it } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { BUNKER_DOOR } from './map/bunker.js';
import { TILE_SIZE } from './map/street.js';
import { BUNKER_ELEVATOR_STATION, BUNKER_ROOM_DEFINITION, FIXED_ROOM_TILE_SIZE, type FixedRoomStationPresentation } from './fixed-room.js';
import type { MovementInput } from './street-movement.js';
import { ROOM_ORIGIN } from './world-layout.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * The hidden room inside the gameplay session (D-107): the stair's top step
 * is a door like any other, the room is a private interior (the Shell hears
 * `building:entered` and suspends presence, D-019, D-087), the lift only
 * says it is out of order, and the stair leads back up to the alley's mouth.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });

function setup() {
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & { hold(keys: Partial<MovementInput>): void } = {
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
    on: () => undefined,
    off: () => undefined,
    hold(keys) {
      pressed = { ...NO_KEYS, ...keys };
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
  const position = (): { x: number; y: number } => (session as unknown as { position: { x: number; y: number } }).position;
  const step = (x: number, y: number): void => {
    (session as unknown as { position: { x: number; y: number } }).position = { x, y };
    // One tiny step reports the tile, then stand still.
    keyboard.hold({ up: true });
    session.update(1);
    keyboard.hold({});
    session.update(16);
  };
  return {
    session,
    emitted,
    calls,
    position,
    shellEmit: (event: keyof ShellEvents, payload: unknown) => {
      for (const handler of [...(shell.get(event) ?? [])]) handler(payload);
    },
    events: (name: keyof WorldEvents) => emitted.filter((entry) => entry.event === name).map((entry) => entry.payload),
    last: (method: string) => [...calls].reverse().find((call) => call.method === method)?.args,
    onStreet: (x: number, y: number) => step(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2 + 2),
    inRoom: (x: number, y: number) =>
      step(ROOM_ORIGIN.x + x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2, ROOM_ORIGIN.y + y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2 + 2),
  };
}

describe('the hidden room in the session (D-107)', () => {
  it('goes down the stair\'s top step into the room, and back up the stair to the alley\'s mouth', () => {
    const world = setup();
    world.onStreet(BUNKER_DOOR.x, BUNKER_DOOR.y + 1);
    expect(world.session.area).toBe('street');
    world.onStreet(BUNKER_DOOR.x, BUNKER_DOOR.y);
    expect(world.events('building:entered')).toEqual([{ building: 'bunker' }]);
    expect(world.session.area).toBe('bunker');
    expect(world.session.level).toBe('ground');
    expect(world.last('showRoom')).toEqual(['bunker']);
    // A private interior: the street, its passers-by and its signs are hidden.
    expect(world.last('setStreetVisible')).toEqual([false]);
    expect(world.last('setRemoteVisible')).toEqual([false]);
    expect(world.last('setLabelsVisible')).toEqual([false]);
    // The player is at the foot of the stair.
    const spawn = BUNKER_ROOM_DEFINITION.spawn;
    expect(world.position()).toEqual({
      x: ROOM_ORIGIN.x + spawn.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
      y: ROOM_ORIGIN.y + spawn.y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    });
    // Nothing shared is announced from inside (D-087).
    const insideFrom = world.emitted.length;
    world.inRoom(5, 8);
    world.inRoom(9, 5);
    expect(world.emitted.slice(insideFrom).map((entry) => entry.event)).toEqual([]);

    const exit = BUNKER_ROOM_DEFINITION.exit;
    world.inRoom(exit.x, exit.y);
    expect(world.events('building:exited')).toEqual([{ building: 'bunker' }]);
    expect(world.session.area).toBe('street');
    expect(world.last('showRoom')).toEqual([null]);
    expect(world.position()).toEqual({
      x: BUNKER_DOOR.x * TILE_SIZE + TILE_SIZE / 2,
      y: (BUNKER_DOOR.y + 1) * TILE_SIZE + TILE_SIZE / 2,
    });
  });

  it('shows the lift out of order as the player walks up, and does nothing else', () => {
    const world = setup();
    world.onStreet(BUNKER_DOOR.x, BUNKER_DOOR.y);
    const lift = BUNKER_ROOM_DEFINITION.stations[0];
    world.inRoom(lift.x, lift.y + 1);
    const rendered = world.last('renderRoom') as [string, readonly FixedRoomStationPresentation[]];
    expect(rendered[0]).toBe('bunker');
    expect(rendered[1]).toEqual([expect.objectContaining({ station: BUNKER_ELEVATOR_STATION, status: 'locked', highlighted: true })]);
    // Even a Shell that called it available cannot make it open.
    world.shellEmit('world:stations', {
      building: 'bunker',
      stations: [{ station: BUNKER_ELEVATOR_STATION, label: 'GOING DOWN', status: 'available' }],
    });
    world.inRoom(lift.x + 1, lift.y + 1);
    world.inRoom(lift.x + 2, lift.y);
    expect(world.events('station:activated')).toEqual([]);
    expect(world.session.inputSuspended).toBe(false);
    expect(world.session.area).toBe('bunker');
    const after = world.last('renderRoom') as [string, readonly FixedRoomStationPresentation[]];
    expect(after[1][0]).toMatchObject({ status: 'locked', label: lift.label });
  });
});
