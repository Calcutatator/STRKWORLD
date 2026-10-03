import { describe, expect, it } from 'vitest';
import { STREET_SEATS, type ShellEvents, type WorldEvents } from '@strkworld/shared';
import { TILE_SIZE } from './map/street.js';
import { FIXED_ROOM_TILE_SIZE } from './fixed-room.js';
import { ROOM_ORIGIN } from './world-layout.js';
import type { InteractionPrompt } from './interaction.js';
import type { MovementInput } from './street-movement.js';
import { createRemotePeerSource, type RemotePeerSnapshot } from './remote-peer.js';
import { PLAZA_BENCH_PROFILE, SIT_LABEL, STREET_BENCHES, roomBenches } from './seats.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * Sittable benches inside the gameplay session — D-127.
 *
 * Stand by a bench and the chip reads "[E] SIT" and nothing lights up; E snaps
 * the player onto the nearest free seat facing out from it; a movement key,
 * Space or E again stands them up where they pressed it. On the street the seat
 * rides along on `player:moved`; in the Bridge room it is local and silent.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    press(event: 'keydown-E' | 'keydown-Space'): void;
  } = {
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
    press(event) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ repeat: false, target: null });
    },
  };
  return keyboard;
}

function setup(options: { peers?: readonly RemotePeerSnapshot[] } = {}) {
  const emitted: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  const shell = new Map<keyof ShellEvents, Set<(payload: unknown) => void>>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const prompts: Array<InteractionPrompt | null> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
      if (property === 'setInteractionPrompt') prompts.push(args[0] as InteractionPrompt | null);
    },
  });
  const keyboard = fakeKeyboard();
  const peerChannel = createRemotePeerSource(options.peers ?? []);
  const session = createWorldSession({
    view,
    keyboard,
    peers: peerChannel.source,
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
  /**
   * Stand exactly at `x, y` having last walked `facing` — the interaction
   * system only offers what the player roughly faces (D-117), and a bench is
   * approached from its front. The heading comes from one tiny step, then the
   * position is set exactly, so a test can compare pixels.
   */
  const at = (x: number, y: number, heading: Partial<MovementInput> = { down: true }): void => {
    keyboard.hold(heading);
    session.update(1);
    keyboard.hold({});
    (session as unknown as { position: { x: number; y: number } }).position = { x, y };
    session.update(16);
  };
  return {
    session,
    keyboard,
    emitted,
    calls,
    prompts,
    peerChannel,
    position: () => (session as unknown as { position: { x: number; y: number } }).position,
    at,
    onStreetTile: (x: number, y: number) => at(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2),
    events: (name: keyof WorldEvents) => emitted.filter((entry) => entry.event === name).map((entry) => entry.payload),
    last: (method: string) => [...calls].reverse().find((call) => call.method === method)?.args,
  };
}

/** Stand just off a bench's long side, in reach of it. */
function beside(bench: { rect: { x: number; y: number; width: number; height: number } }, seatX: number): { x: number; y: number } {
  return { x: seatX, y: bench.rect.y - 8 };
}

const PLAZA_ROW = STREET_BENCHES[2]!;
const BLEACHER = STREET_BENCHES[4]!;

describe('sittable benches in the session (D-127)', () => {
  it('shows "[E] SIT" at a bench, with no shimmer or glow object on the prompt', () => {
    const world = setup();
    world.at(PLAZA_ROW.seats[0]!.x, PLAZA_ROW.rect.y - 8);
    const prompt = world.session.interactionPrompt;
    expect(prompt?.id).toBe(PLAZA_ROW.id);
    expect(prompt?.label).toBe(SIT_LABEL);
    // D-123's two other cues are declined out loud: nothing to light.
    expect(prompt?.cue).toBe('none');
    expect(prompt?.object).toBeUndefined();
    // The chip is fed the same prompt the session reports.
    expect(world.last('setInteractionPrompt')).toEqual([prompt]);
    world.session.destroy();
  });

  it('shows nothing a tile and a half away from any bench', () => {
    const world = setup();
    world.at(PLAZA_ROW.seats[0]!.x, PLAZA_ROW.rect.y - 3 * TILE_SIZE);
    expect(world.session.interactionPrompt).toBeNull();
    world.session.destroy();
  });

  it('sits the player on the nearest free seat, facing out, and stands them up on a movement key', () => {
    const world = setup();
    const spot = beside(PLAZA_ROW, PLAZA_ROW.seats[1]!.x);
    world.at(spot.x, spot.y);
    expect(world.session.interact()).toBe(true);

    const seat = PLAZA_ROW.seats[1]!;
    expect(world.session.seat?.id).toBe(seat.id);
    expect(world.position()).toEqual({ x: seat.x, y: seat.y });
    expect(world.last('setPlayerFacing')).toEqual([seat.facing]);
    // The seat goes with it, so the view can lift the figure onto the bench
    // rather than leaving it on the ground, sunk into the slats (D-127 amended).
    expect(world.last('setPlayerSeated')).toEqual([seat.place]);
    expect(seat.place.surface).toBe(PLAZA_BENCH_PROFILE.surface);
    expect(seat.place.front).toBeCloseTo(0.225, 6);
    // Sitting holds the stations, so nothing else is focused and no chip shows.
    expect(world.session.interactions.suspended).toBe(true);
    expect(world.session.interactionPrompt).toBeNull();

    // Any movement key stands them up again, where they pressed E.
    world.keyboard.hold({ left: true });
    world.session.update(16);
    expect(world.session.seat).toBeNull();
    expect(world.last('setPlayerSeated')).toEqual([null]);
    expect(world.session.interactions.suspended).toBe(false);
    world.session.destroy();
  });

  it('stands the player up on E again, and on Space instead of jumping', () => {
    const world = setup();
    const spot = beside(BLEACHER, BLEACHER.seats[0]!.x);

    world.at(spot.x, spot.y);
    world.keyboard.press('keydown-E');
    expect(world.session.seat?.id).toBe(BLEACHER.seats[0]!.id);
    world.keyboard.press('keydown-E');
    expect(world.session.seat).toBeNull();
    expect(world.position()).toEqual(spot);

    world.at(spot.x, spot.y);
    world.keyboard.press('keydown-E');
    expect(world.session.seat).not.toBeNull();
    const jumps = world.events('player:jumped').length;
    world.keyboard.press('keydown-Space');
    expect(world.session.seat).toBeNull();
    expect(world.events('player:jumped')).toHaveLength(jumps);
    world.session.destroy();
  });

  it('carries the seat on the street placement, and drops it again on standing up', () => {
    const world = setup();
    const seat = PLAZA_ROW.seats[0]!;
    world.at(beside(PLAZA_ROW, seat.x).x, beside(PLAZA_ROW, seat.x).y);
    // Standing: the placement is exactly what it always was.
    expect(world.events('player:moved').at(-1)).toEqual({
      position: { x: beside(PLAZA_ROW, seat.x).x, y: beside(PLAZA_ROW, seat.x).y },
      facing: 'down',
    });

    world.session.interact();
    expect(world.events('player:moved').at(-1)).toEqual({
      position: { x: seat.x, y: seat.y },
      facing: seat.facing,
      seat: seat.index,
    });
    // It keeps being re-sent while they sit, so a dropped claim converges.
    world.session.update(16);
    expect(world.events('player:moved').at(-1)).toMatchObject({ seat: seat.index });

    world.keyboard.press('keydown-E');
    expect(world.events('player:moved').at(-1)).not.toHaveProperty('seat');
    world.session.destroy();
  });

  it('does not offer a bench whose every seat a peer already holds', () => {
    const world = setup();
    const spot = beside(PLAZA_ROW, PLAZA_ROW.seats[0]!.x);

    // One of the two seats taken: the other is still offered, and chosen.
    world.peerChannel.publish([peerOn(PLAZA_ROW.seats[0]!.index)]);
    world.at(spot.x, spot.y);
    expect(world.session.interactionPrompt?.id).toBe(PLAZA_ROW.id);
    expect(world.session.interact()).toBe(true);
    expect(world.session.seat?.id).toBe(PLAZA_ROW.seats[1]!.id);
    world.keyboard.press('keydown-E');

    // Both taken: the bench is not offered at all, and E does nothing there.
    world.peerChannel.publish(PLAZA_ROW.seats.map((seat) => peerOn(seat.index)));
    world.at(spot.x, spot.y);
    expect(world.session.interactionPrompt).toBeNull();
    expect(world.session.interact()).toBe(false);
    expect(world.session.seat).toBeNull();

    // The peers get up: it is offered again.
    world.peerChannel.publish([]);
    world.at(spot.x, spot.y);
    expect(world.session.interactionPrompt?.id).toBe(PLAZA_ROW.id);
    world.session.destroy();
  });

  it('works solo inside the Bridge room, with nothing published', () => {
    const world = setup();
    const doors = (world.session as unknown as { map: { doors: ReadonlyArray<{ building: string; x: number; y: number }> } }).map.doors;
    const door = doors.find((candidate) => candidate.building === 'bridge')!;
    world.onStreetTile(door.x, door.y + 1);
    world.onStreetTile(door.x, door.y);
    expect(world.session.area).toBe('bridge');

    const benches = roomBenches({ building: 'bridge', fixtures: bridgeFixtures(world) });
    const bench = benches[0]!;
    const seat = bench.seats[2]!;
    // Stand on the room floor just north of the lounge run's east end.
    world.at(seat.x, bench.rect.y - 8);
    expect(world.session.interactionPrompt?.label).toBe(SIT_LABEL);
    expect(world.session.interactionPrompt?.cue).toBe('none');

    const before = world.emitted.length;
    expect(world.session.interact()).toBe(true);
    expect(world.session.seat?.id).toBe(seat.id);
    // A solo interior: the seat is room-local and nothing at all is emitted.
    expect(world.session.seat?.index).toBe(-1);
    expect(world.emitted.slice(before)).toEqual([]);
    expect(world.position()).toEqual({ x: seat.x, y: seat.y });

    world.keyboard.hold({ down: true });
    world.session.update(16);
    expect(world.session.seat).toBeNull();
    expect(world.emitted.slice(before)).toEqual([]);
    world.session.destroy();
  });
});

function peerOn(index: number): RemotePeerSnapshot {
  const spot = STREET_SEATS[index]!;
  return { id: `peer-${index}`, x: spot.x, y: spot.y, facing: spot.facing, sprite: 'avatar-2', carrying: null, jumps: 0, seat: index };
}

function bridgeFixtures(world: ReturnType<typeof setup>) {
  const maps = (world.session as unknown as {
    roomMaps: Record<string, Map<string, { fixtures: readonly { x: number; y: number; width: number; height: number; prop?: string }[] }>>;
  }).roomMaps;
  return maps['bridge']!.get('ground')!.fixtures as never;
}
