import { describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import {
  BANK_ROOM_DEFINITION,
  BRIDGE_ROOM_DEFINITION,
  EXCHANGE_ROOM_DEFINITION,
  FIXED_ROOM_DEFINITIONS,
  FixedRoomDefinitionError,
  POST_OFFICE_ROOM_DEFINITION,
  createFixedRoom,
  createFixedRoomController,
  createFixedRoomPresentation,
  fixedRoomStationPresentations,
  isFixedRoomApproach,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  normalizeFixedRoomStations,
  type FixedRoomDefinition,
  type FixedRoomController,
  type FixedRoomState,
} from './fixed-room.js';

describe('fixed room presentation transaction', () => {
  function presentationHarness() {
    const calls: string[] = [];
    let presentation!: ReturnType<typeof createFixedRoomPresentation>;
    const port = {
      setPlayerVelocity: () => calls.push('velocity'),
      setBodyEnabled: (enabled: boolean) => calls.push(`body:${enabled}`),
      setGroundVisible: (visible: boolean) => calls.push(`ground:${visible}`),
      setDoorsVisible: (visible: boolean) => calls.push(`doors:${visible}`),
      setRemoteVisible: (visible: boolean) => calls.push(`remote:${visible}`),
      setLabelsVisible: (visible: boolean) => calls.push(`labels:${visible}`),
      setRoomVisible: (visible: boolean) => { calls.push(`room:${visible}`); },
      setWorldBounds: (room: boolean) => { calls.push(`world:${room}`); },
      setCameraBounds: (room: boolean) => { calls.push(`camera:${room}`); },
      setPlayerPosition: (room: boolean) => { calls.push(`position:${room}`); },
      resetDoors: () => { calls.push('reset'); },
      resumeStreet: () => { calls.push('resume'); },
    };
    presentation = createFixedRoomPresentation(port);
    return { calls, port, get presentation() { return presentation; } };
  }

  it('retires a stale enter when a nested exit takes ownership', () => {
    const h = presentationHarness();
    const original = h.port.setRoomVisible;
    h.port.setRoomVisible = (visible) => {
      original(visible);
      if (visible) h.presentation.exit();
    };

    h.presentation.enter();

    expect(h.calls.at(-1)).toBe('resume');
    expect(h.calls).not.toContain('position:true');
  });

  it('compensates partial entry before allowing a retry', () => {
    const h = presentationHarness();
    const error = new Error('room bounds failed');
    let fail = true;
    const original = h.port.setWorldBounds;
    h.port.setWorldBounds = (room) => {
      if (room && fail) {
        fail = false;
        throw error;
      }
      original(room);
    };

    expect(() => h.presentation.enter()).toThrow(error);
    expect(h.calls.at(-1)).toBe('position:false');
    expect(() => h.presentation.enter()).not.toThrow();
    expect(h.calls.at(-1)).toBe('position:true');
  });
});

function bus<Events extends Record<string, unknown>>(): EventBus<Events> {
  const listeners = new Map<keyof Events, Set<(payload: never) => void>>();
  return {
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload as never);
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as (payload: never) => void);
      return () => set?.delete(listener as (payload: never) => void);
    },
    once(event, listener) {
      const stop = this.on(event, (payload) => {
        stop();
        listener(payload);
      });
      return stop;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as (payload: never) => void);
    },
    clear() {
      listeners.clear();
    },
  } as EventBus<Events>;
}

function harness(
  definition: FixedRoomDefinition = POST_OFFICE_ROOM_DEFINITION,
  onChange?: (state: FixedRoomState) => void,
) {
  const out = bus<WorldEvents>();
  const inputCalls: string[] = [];
  const shell = bus<ShellEvents>();
  const events: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  out.on('station:activated', (payload) => events.push({ event: 'station:activated', payload }));
  out.on('building:exited', (payload) => events.push({ event: 'building:exited', payload }));
  const controller = createFixedRoomController({
    definition,
    out,
    in: shell,
    input: {
      suspend: () => inputCalls.push('suspend'),
      resume: () => inputCalls.push('resume'),
    },
    onChange,
  });
  return { out, shell, inputCalls, events, controller };
}

describe('fixed room definitions', () => {
  it('rolls back room ownership when enter presentation fails', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('room presentation failed');
    const onEnter = vi.fn().mockImplementationOnce(() => { throw error; });
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume: vi.fn() },
      onEnter,
    });

    expect(() => controller.enter()).toThrow(error);
    expect(controller.state.inRoom).toBe(false);
    expect(controller.state.building).toBeNull();
    expect(() => controller.enter()).not.toThrow();
    expect(controller.state.inRoom).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(2);
  });

  it('rolls back room ownership when input restoration fails on entry', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('input restoration failed');
    const resume = vi.fn().mockImplementationOnce(() => { throw error; });
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
    });

    expect(() => controller.enter()).toThrow(error);
    expect(controller.state.inRoom).toBe(false);
    expect(controller.state.building).toBeNull();

    expect(() => controller.enter()).not.toThrow();
    expect(controller.state.inRoom).toBe(true);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('rolls back room ownership when entry state publication fails', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('room state publication failed');
    let shouldThrow = true;
    const onChange = vi.fn(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw error;
      }
    });
    const onExit = vi.fn();
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume: vi.fn() },
      onEnter: vi.fn(),
      onExit,
      onChange,
    });

    expect(() => controller.enter()).toThrow(error);
    expect(controller.state.inRoom).toBe(false);
    expect(controller.state.building).toBeNull();
    expect(onExit).toHaveBeenCalledOnce();

    expect(() => controller.enter()).not.toThrow();
    expect(controller.state.inRoom).toBe(true);
  });

  it('owns generated room maps independently of injected definitions', () => {
    const definition = {
      ...POST_OFFICE_ROOM_DEFINITION,
      spawn: { ...POST_OFFICE_ROOM_DEFINITION.spawn },
      exit: { ...POST_OFFICE_ROOM_DEFINITION.exit },
      stations: POST_OFFICE_ROOM_DEFINITION.stations.map((station) => ({ ...station })),
    };
    const room = createFixedRoom(definition);

    Reflect.set(definition.spawn, 'x', 1);
    Reflect.set(definition.exit, 'x', 1);
    Reflect.set(definition.stations[0]!, 'label', 'FORGED');
    Reflect.set(definition.stations[0]!, 'x', 14);

    expect(room.spawn).toEqual({ x: 9, y: 9 });
    expect(room.exit.x).toBe(8);
    expect(room.stations[0]).toMatchObject({ label: 'TRANSFER', x: 3 });
  });

  it('restores input when station delivery throws', () => {
    const h = harness();
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    const deliveryError = new Error('station consumer failed');
    h.out.on('station:activated', () => {
      throw deliveryError;
    });

    expect(() => h.controller.update({ x: 3, y: 4 })).toThrow(deliveryError);
    expect(h.inputCalls).toEqual(['resume', 'suspend', 'resume']);
    expect(h.controller.state.inRoom).toBe(true);
  });

  it('rearms the station approach when station delivery throws', () => {
    const h = harness();
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [{
        station: 'post-office:transfer',
        label: 'TRANSFER',
        status: 'available',
      }],
    });
    let attempts = 0;
    h.out.on('station:activated', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('station consumer failed');
    });

    expect(() => h.controller.update({ x: 3, y: 4 })).toThrow('station consumer failed');
    h.controller.update({ x: 3, y: 4 });

    expect(attempts).toBe(2);
    expect(h.inputCalls).toEqual(['resume', 'suspend', 'resume', 'suspend', 'resume']);
  });

  it('rearms after delivery and input restoration both fail', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const deliveryError = new Error('station consumer failed');
    const restorationError = new Error('input restoration failed');
    const resume = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw restorationError; })
      .mockImplementationOnce(() => {});
    let attempts = 0;
    out.on('station:activated', () => {
      attempts += 1;
      if (attempts === 1) throw deliveryError;
    });
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
    });
    controller.enter();
    shell.emit('world:stations', {
      building: 'post-office',
      stations: [{ station: 'post-office:transfer', label: 'TRANSFER', status: 'available' }],
    });

    expect(() => controller.update({ x: 3, y: 4 })).toThrow(AggregateError);
    controller.update({ x: 3, y: 4 });

    expect(attempts).toBe(2);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('does not activate a station after input suspension retires the room', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const events: unknown[] = [];
    out.on('station:activated', (payload) => events.push(payload));
    let controller!: FixedRoomController;
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: {
        suspend: () => controller.destroy(),
        resume: vi.fn(),
      },
    });
    controller.enter();
    shell.emit('world:stations', {
      building: 'post-office',
      stations: [{ station: 'post-office:transfer', label: 'TRANSFER', status: 'available' }],
    });

    controller.update({ x: 3, y: 4 });

    expect(events).toEqual([]);
    expect(controller.state.inRoom).toBe(false);
  });

  it('keeps room ownership when input restoration fails on exit so it can retry', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('input restoration failed');
    const resume = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw error; })
      .mockImplementationOnce(() => {});
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
    });

    controller.enter();
    const exit = POST_OFFICE_ROOM_DEFINITION.exit;
    expect(() => controller.update({ x: exit.x, y: exit.y })).toThrow(error);
    expect(controller.state.inRoom).toBe(true);

    expect(() => controller.update({ x: exit.x, y: exit.y })).not.toThrow();
    expect(controller.state.inRoom).toBe(false);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('keeps room ownership when exit presentation fails so it can retry', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('exit presentation failed');
    const onExit = vi.fn().mockImplementationOnce(() => { throw error; });
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume: vi.fn() },
      onExit,
    });

    controller.enter();
    const exit = POST_OFFICE_ROOM_DEFINITION.exit;
    expect(() => controller.update({ x: exit.x, y: exit.y })).toThrow(error);
    expect(controller.state.inRoom).toBe(true);
    expect(controller.state.building).toBe('post-office');

    expect(() => controller.update({ x: exit.x, y: exit.y })).not.toThrow();
    expect(controller.state.inRoom).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('rolls back room ownership when exit state publication fails', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('room exit state publication failed');
    let shouldThrow = false;
    const onChange = vi.fn(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw error;
      }
    });
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume: vi.fn() },
      onEnter,
      onExit,
      onChange,
    });

    controller.enter();
    shouldThrow = true;
    const exit = POST_OFFICE_ROOM_DEFINITION.exit;
    expect(() => controller.update({ x: exit.x, y: exit.y })).toThrow(error);
    expect(controller.state.inRoom).toBe(true);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onEnter).toHaveBeenCalledTimes(2);

    expect(() => controller.update({ x: exit.x, y: exit.y })).not.toThrow();
    expect(controller.state.inRoom).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('does not announce a stale exit after onChange re-enters the room', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const events: Array<keyof WorldEvents> = [];
    out.on('building:exited', () => events.push('building:exited'));
    let controller!: FixedRoomController;
    let reentered = false;
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume: vi.fn() },
      onChange: (state) => {
        if (!reentered && !state.inRoom) {
          reentered = true;
          controller.enter();
        }
      },
    });
    controller.enter();
    controller.update({
      x: POST_OFFICE_ROOM_DEFINITION.exit.x,
      y: POST_OFFICE_ROOM_DEFINITION.exit.y,
    });

    expect(controller.state.inRoom).toBe(true);
    expect(events).toEqual([]);
  });

  it('preserves both station delivery and input restoration failures', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const deliveryError = new Error('station consumer failed');
    const restorationError = new Error('input restoration failed');
    const resume = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw restorationError; });
    out.on('station:activated', () => { throw deliveryError; });
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
    });
    controller.enter();
    shell.emit('world:stations', {
      building: 'post-office',
      stations: [{ station: 'post-office:transfer', label: 'TRANSFER', status: 'available' }],
    });

    let thrown: unknown;
    try {
      controller.update({ x: 3, y: 4 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([deliveryError, restorationError]);
  });

  it('isolates station activation payloads from synchronous listener mutation', () => {
    const h = harness();
    const seen: Array<{ building: string; station: string }> = [];
    h.out.on('station:activated', (payload) => {
      expect(Reflect.set(payload, 'station', 'bank:shielding')).toBe(false);
    });
    h.out.on('station:activated', (payload) => seen.push(payload));
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [{ station: 'post-office:transfer', label: 'TRANSFER', status: 'available' }],
    });

    h.controller.update({ x: 3, y: 4 });

    expect(seen).toEqual([{ building: 'post-office', station: 'post-office:transfer' }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('keeps canonical room definitions immutable at runtime', () => {
    expect(Object.isFrozen(FIXED_ROOM_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(POST_OFFICE_ROOM_DEFINITION)).toBe(true);
    expect(Object.isFrozen(POST_OFFICE_ROOM_DEFINITION.spawn)).toBe(true);
    expect(Object.isFrozen(POST_OFFICE_ROOM_DEFINITION.exit)).toBe(true);
    expect(Object.isFrozen(POST_OFFICE_ROOM_DEFINITION.stations)).toBe(true);
    expect(Object.isFrozen(POST_OFFICE_ROOM_DEFINITION.stations[0])).toBe(true);
    expect(Reflect.set(POST_OFFICE_ROOM_DEFINITION.stations[0], 'label', 'FORGED')).toBe(false);
    expect(POST_OFFICE_ROOM_DEFINITION.stations[0].label).toBe('TRANSFER');
  });

  it.each([
    ['bank', BANK_ROOM_DEFINITION],
    ['exchange', EXCHANGE_ROOM_DEFINITION],
    ['post office', POST_OFFICE_ROOM_DEFINITION],
    ['bridge', BRIDGE_ROOM_DEFINITION],
  ])('%s uses the fixed walkable envelope', (_name, definition) => {
    const room = createFixedRoom(definition);
    expect(room.width).toBe(18);
    expect(room.height).toBe(12);
    expect(isFixedRoomSolidAt(room, room.spawn.x, room.spawn.y)).toBe(false);
    expect(isFixedRoomExit(room, room.exit.x, room.exit.y)).toBe(true);
    expect(isFixedRoomSolidAt(room, room.exit.x, room.exit.y)).toBe(false);
    expect(room.stations).toHaveLength(1);
    expect(isFixedRoomSolidAt(room, room.stations[0]!.x, room.stations[0]!.y)).toBe(true);
    expect(isFixedRoomApproach(room, room.stations[0]!.x, room.stations[0]!.y + 1)).toBe(true);
  });

  it('registers the Exchange swap station at the authored coordinates', () => {
    expect(EXCHANGE_ROOM_DEFINITION.stations).toEqual([
      {
        station: 'exchange:swap',
        label: 'SWAP',
        x: 13,
        y: 3,
        width: 2,
        height: 1,
      },
    ]);
    expect(FIXED_ROOM_DEFINITIONS).toMatchObject({ exchange: EXCHANGE_ROOM_DEFINITION });
  });

  it('places the Post Office transfer station at the accepted coordinates', () => {
    expect(POST_OFFICE_ROOM_DEFINITION.stations).toEqual([
      {
        station: 'post-office:transfer',
        label: 'TRANSFER',
        x: 3,
        y: 3,
        width: 2,
        height: 1,
      },
    ]);
  });

  it('pins the Bridge deposit station at the accepted coordinates', () => {
    expect(BRIDGE_ROOM_DEFINITION).toEqual({
      building: 'bridge',
      width: 18,
      height: 12,
      spawn: { x: 9, y: 9 },
      exit: { x: 8, y: 11, width: 2, height: 1 },
      stations: [
        {
          station: 'bridge:deposit',
          label: 'DEPOSIT',
          x: 8,
          y: 3,
          width: 2,
          height: 1,
        },
      ],
    });
    expect(FIXED_ROOM_DEFINITIONS).toMatchObject({ bridge: BRIDGE_ROOM_DEFINITION });
  });

  it.each([
    [{ ...BANK_ROOM_DEFINITION, width: 0 }, 'invalid-dimensions'],
    [{ ...BANK_ROOM_DEFINITION, height: 12.5 }, 'invalid-dimensions'],
    [{ ...BANK_ROOM_DEFINITION, spawn: { x: 0, y: 5 } }, 'invalid-spawn'],
    [{ ...BANK_ROOM_DEFINITION, spawn: { x: 8, y: 3 } }, 'invalid-spawn'],
    [{ ...BANK_ROOM_DEFINITION, exit: { x: 8, y: 10, width: 2, height: 1 } }, 'invalid-exit'],
    [{ ...BANK_ROOM_DEFINITION, exit: { x: 17, y: 11, width: 2, height: 1 } }, 'invalid-exit'],
    [{ ...BANK_ROOM_DEFINITION, exit: { x: 8, y: 11, width: 0, height: 1 } }, 'invalid-exit'],
  ] as const)('rejects invalid envelope geometry before construction', (definition, code) => {
    expectDefinitionError(definition as FixedRoomDefinition, code);
  });

  it.each([
    [[], 'invalid-station'],
    [[{ station: 'bank:bad', label: 'BAD', x: 0, y: 3, width: 1, height: 1 }], 'invalid-station'],
    [[{ station: 'bank:bad', label: 'BAD', x: 3, y: 3, width: 0, height: 1 }], 'invalid-station'],
    [
      [
        {
          station: 'post-office:bad',
          label: 'BAD',
          x: 3,
          y: 3,
          width: 1,
          height: 1,
        },
      ],
      'invalid-station',
    ],
    [
      [
        { station: 'bank:same', label: 'A', x: 3, y: 3, width: 1, height: 1 },
        { station: 'bank:same', label: 'B', x: 10, y: 3, width: 1, height: 1 },
      ],
      'duplicate-station',
    ],
    [
      [
        { station: 'bank:a', label: 'A', x: 3, y: 3, width: 2, height: 1 },
        { station: 'bank:b', label: 'B', x: 4, y: 3, width: 2, height: 1 },
      ],
      'overlapping-stations',
    ],
    [
      [
        { station: 'bank:a', label: 'A', x: 3, y: 3, width: 1, height: 1 },
        { station: 'bank:b', label: 'B', x: 5, y: 3, width: 1, height: 1 },
      ],
      'overlapping-approaches',
    ],
  ] as const)('rejects invalid or ambiguous stations', (stations, code) => {
    expectDefinitionError({ ...BANK_ROOM_DEFINITION, stations } as FixedRoomDefinition, code);
  });

  it('rejects an exit that overlaps a station', () => {
    expectDefinitionError(
      {
        ...BANK_ROOM_DEFINITION,
        stations: [
          {
            station: 'bank:exit',
            label: 'EXIT',
            x: 8,
            y: 11,
            width: 1,
            height: 1,
          },
        ],
      },
      'invalid-station',
    );
  });

  it('retains one independent presentation for every configured station', () => {
    const definition: FixedRoomDefinition = {
      ...BANK_ROOM_DEFINITION,
      stations: [
        { station: 'bank:first', label: 'FIRST', x: 3, y: 3, width: 1, height: 1 },
        { station: 'bank:second', label: 'SECOND', x: 10, y: 3, width: 1, height: 1 },
      ],
    };
    const map = createFixedRoom(definition);
    const presentations = fixedRoomStationPresentations(map, {
      inRoom: true,
      building: 'bank',
      controlOwner: 'world',
      highlightedStation: 'bank:second',
      stations: [
        { station: 'bank:first', label: 'FIRST LIVE', status: 'available' },
        { station: 'bank:second', label: 'SECOND LIVE', status: 'locked' },
      ],
    });
    expect(
      presentations.map(({ station, label, highlighted }) => ({
        station,
        label,
        highlighted,
      })),
    ).toEqual([
      { station: 'bank:first', label: 'FIRST LIVE', highlighted: false },
      { station: 'bank:second', label: 'SECOND LIVE', highlighted: true },
    ]);
  });

  it('fails closed when a malformed station snapshot reaches the render projection', () => {
    const map = createFixedRoom(BANK_ROOM_DEFINITION);

    expect(() => fixedRoomStationPresentations(map, {
      inRoom: true,
      building: 'bank',
      controlOwner: 'world',
      highlightedStation: null,
      stations: null as unknown as FixedRoomState['stations'],
    })).not.toThrow();

    expect(fixedRoomStationPresentations(map, {
      inRoom: true,
      building: 'bank',
      controlOwner: 'world',
      highlightedStation: null,
      stations: [null] as unknown as FixedRoomState['stations'],
    }).map(({ status, label }) => ({ status, label }))).toEqual(
      map.stations.map(({ label }) => ({ status: 'locked', label })),
    );
  });
});

function expectDefinitionError(definition: FixedRoomDefinition, code: string): void {
  try {
    createFixedRoom(definition);
    throw new Error('definition unexpectedly accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(FixedRoomDefinitionError);
    expect((error as FixedRoomDefinitionError).code).toBe(code);
  }
}

describe('fixed room station admission', () => {
  it('fails closed for missing, malformed, unknown, and duplicate snapshots', () => {
    const known = POST_OFFICE_ROOM_DEFINITION.stations;
    for (const input of [
      undefined,
      [],
      [{ station: 'post-office:unknown', label: 'x', status: 'available' }],
      [
        { station: 'post-office:transfer', label: 'x', status: 'available' },
        { station: 'post-office:transfer', label: 'y', status: 'available' },
      ],
      [{ station: 'post-office:transfer', label: ' ', status: 'available' }],
    ] as const) {
      expect(normalizeFixedRoomStations(POST_OFFICE_ROOM_DEFINITION, input as never)).toEqual([
        { station: known[0]!.station, label: 'TRANSFER', status: 'locked' },
      ]);
    }
  });

  it('normalizes the configured stations without accepting extra commands', () => {
    expect(
      normalizeFixedRoomStations(POST_OFFICE_ROOM_DEFINITION, [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
        { station: 'bank:shielding', label: 'forged', status: 'available' },
      ]),
    ).toEqual([
      {
        station: 'post-office:transfer',
        label: 'TRANSFER',
        status: 'available',
      },
    ]);
  });

  it('admits only the Bridge deposit station', () => {
    expect(
      normalizeFixedRoomStations(BRIDGE_ROOM_DEFINITION, [
        { station: 'bridge:deposit', label: 'DEPOSIT', status: 'available' },
        { station: 'bank:shielding', label: 'forged', status: 'available' },
      ]),
    ).toEqual([{ station: 'bridge:deposit', label: 'DEPOSIT', status: 'available' }]);
  });
});

describe('fixed room controller', () => {
  it('rolls back shell listeners when a later listener registration throws', () => {
    const registrationError = new Error('shell listener registration failed');
    const firstStop = vi.fn();
    let registrations = 0;
    const shell = {
      on: vi.fn(() => {
        if (registrations === 1) throw registrationError;
        registrations += 1;
        return firstStop;
      }),
    };
    expect(() => createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out: bus<WorldEvents>(),
      in: shell as never,
      input: { suspend: vi.fn(), resume: vi.fn() },
    })).toThrow(registrationError);
    expect(firstStop).toHaveBeenCalledOnce();
  });
  it('does not activate a station after onChange destroys the controller', () => {
    let controller: ReturnType<typeof createFixedRoomController> | undefined;
    const h = harness(POST_OFFICE_ROOM_DEFINITION, (state) => {
      if (state.highlightedStation === 'post-office:transfer') controller?.destroy();
    });
    controller = h.controller;

    controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    controller.update({ x: 3, y: 4 });

    expect(controller.state.inRoom).toBe(false);
    expect(h.events.filter((event) => event.event === 'station:activated')).toEqual([]);
    expect(h.inputCalls).toEqual(['resume', 'resume']);
  });

  it('does not activate a station after onChange transfers control to Shell', () => {
    let shell: ReturnType<typeof bus<ShellEvents>> | undefined;
    let claimed = false;
    const h = harness(POST_OFFICE_ROOM_DEFINITION, (state) => {
      if (!claimed && state.highlightedStation === 'post-office:transfer') {
        claimed = true;
        shell?.emit('world:control-owner', { building: 'post-office', owner: 'shell' });
      }
    });
    shell = h.shell;

    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    h.controller.update({ x: 3, y: 4 });

    expect(h.controller.state.controlOwner).toBe('shell');
    expect(h.events.filter((event) => event.event === 'station:activated')).toEqual([]);
    expect(h.inputCalls).toEqual(['resume', 'suspend']);
  });

  it('does not activate a stale station after onChange re-enters update', () => {
    const definition: FixedRoomDefinition = {
      ...POST_OFFICE_ROOM_DEFINITION,
      stations: [
        POST_OFFICE_ROOM_DEFINITION.stations[0]!,
        {
          station: 'post-office:second',
          label: 'SECOND',
          x: 13,
          y: 3,
          width: 2,
          height: 1,
        },
      ],
    };
    let controller!: ReturnType<typeof createFixedRoomController>;
    let reentered = false;
    const h = harness(definition, (state) => {
      if (!reentered && state.highlightedStation === 'post-office:transfer') {
        reentered = true;
        controller.update({ x: 13, y: 4 });
      }
    });
    controller = h.controller;
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        { station: 'post-office:transfer', label: 'TRANSFER', status: 'available' },
        { station: 'post-office:second', label: 'SECOND', status: 'available' },
      ],
    });

    h.controller.update({ x: 3, y: 4 });

    expect(h.events.map((event) => event.payload)).toEqual([
      { building: 'post-office', station: 'post-office:second' },
    ]);
    expect(h.controller.state.highlightedStation).toBe('post-office:second');
  });

  it('does not expose station admission through the public state snapshot', () => {
    const h = harness();
    h.controller.enter();

    const exposed = h.controller.state;
    expect(exposed.stations[0]?.status).toBe('locked');
    expect(Reflect.set(exposed.stations[0]!, 'status', 'available')).toBe(false);
    expect(Reflect.set(exposed.stations, '0', {
      ...exposed.stations[0]!,
      status: 'available',
    })).toBe(false);

    h.controller.update({ x: 3, y: 4 });
    expect(h.events).toEqual([]);
    expect(h.controller.state.stations[0]?.status).toBe('locked');
  });

  it('does not expose station admission through an onChange snapshot', () => {
    let published: FixedRoomState | undefined;
    const h = harness(POST_OFFICE_ROOM_DEFINITION, (state) => {
      published = state;
    });
    h.controller.enter();

    expect(published?.stations[0]?.status).toBe('locked');
    expect(Reflect.set(published!.stations[0]!, 'status', 'available')).toBe(false);

    h.controller.update({ x: 3, y: 4 });
    expect(h.events).toEqual([]);
    expect(h.controller.state.stations[0]?.status).toBe('locked');
  });

  it('activates the Post Office station once, suspending before the synchronous claim', () => {
    const h = harness();
    const order: string[] = [];
    h.inputCalls.push = ((...items: string[]) => {
      order.push(...items);
      return h.inputCalls.length;
    }) as typeof h.inputCalls.push;
    h.out.on('station:activated', () => order.push('emit'));
    h.shell.on('world:stations', () => {});
    h.shell.on('world:control-owner', () => {});
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    h.out.on('station:activated', () =>
      h.shell.emit('world:control-owner', {
        building: 'post-office',
        owner: 'shell',
      }),
    );
    h.controller.update({ x: 3, y: 4 });
    expect(order.slice(-3)).toEqual(['suspend', 'emit', 'suspend']);
    expect(h.controller.state.controlOwner).toBe('shell');
    h.controller.update({ x: 3, y: 4 });
    expect(h.events.filter((event) => event.event === 'station:activated')).toHaveLength(1);
  });

  it('rearms station activation when input suspension fails', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const error = new Error('input suspension failed');
    let suspendAttempts = 0;
    const suspend = vi.fn(() => {
      suspendAttempts += 1;
      if (suspendAttempts === 1) throw error;
    });
    const events: unknown[] = [];
    out.on('station:activated', (payload) => events.push(payload));
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend, resume: vi.fn() },
    });
    controller.enter();
    shell.emit('world:stations', {
      building: 'post-office',
      stations: [{ station: 'post-office:transfer', label: 'TRANSFER', status: 'available' }],
    });

    expect(() => controller.update({ x: 3, y: 4 })).toThrow(error);
    expect(controller.state.inRoom).toBe(true);

    controller.update({ x: 3, y: 4 });
    expect(events).toHaveLength(1);
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it('does not resume twice after station delivery destroys the controller', () => {
    const h = harness();
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    h.out.on('station:activated', () => h.controller.destroy());

    h.controller.update({ x: 3, y: 4 });

    expect(h.inputCalls).toEqual(['resume', 'suspend', 'resume']);
  });

  it('ignores commands for another building and exits only once for a matching command', () => {
    const h = harness();
    h.controller.enter();
    h.shell.emit('world:control-owner', { building: 'bank', owner: 'shell' });
    h.shell.emit('world:exit-building', { building: 'bank' });
    expect(h.controller.state.inRoom).toBe(true);
    h.shell.emit('world:exit-building', { building: 'post-office' });
    h.shell.emit('world:exit-building', { building: 'post-office' });
    expect(h.events).toEqual([{ event: 'building:exited', payload: { building: 'post-office' } }]);
  });

  it.each([null, undefined])('fails closed when shell commands arrive with %s payloads', (payload) => {
    const h = harness();
    h.controller.enter();

    expect(() => h.shell.emit('world:stations', payload as never)).not.toThrow();
    expect(() => h.shell.emit('world:control-owner', payload as never)).not.toThrow();
    expect(() => h.shell.emit('world:exit-building', payload as never)).not.toThrow();

    expect(h.controller.state.inRoom).toBe(true);
    expect(h.controller.state.controlOwner).toBe('world');
    expect(h.events).toEqual([]);
  });

  it('fails closed without invoking accessor-backed station fields', () => {
    const h = harness();
    h.controller.enter();
    const error = new Error('station field should not be read');
    let getterRead = false;
    const hostile = {};
    Object.defineProperty(hostile, 'station', {
      get: () => {
        getterRead = true;
        throw error;
      },
    });

    expect(() => h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [hostile as never],
    })).not.toThrow();
    expect(getterRead).toBe(false);
    expect(h.controller.state.stations[0]?.status).toBe('locked');
  });

  it('ignores a control-owner command with an unknown owner', () => {
    const h = harness();
    h.controller.enter();
    const callsBefore = h.inputCalls.length;

    h.shell.emit('world:control-owner', {
      building: 'post-office',
      owner: 'forged' as never,
    });

    expect(h.controller.state.controlOwner).toBe('world');
    expect(h.inputCalls).toHaveLength(callsBefore);
    expect(h.events).toEqual([]);
  });

  it('rearms after leaving the station approach and resumes when no Shell claims', () => {
    const h = harness();
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    h.controller.update({ x: 3, y: 4 });
    h.controller.update({ x: 10, y: 8 });
    h.controller.update({ x: 3, y: 4 });
    expect(h.events.filter((event) => event.event === 'station:activated')).toHaveLength(2);
    expect(h.inputCalls.filter((call) => call === 'resume').length).toBeGreaterThanOrEqual(2);
  });

  it('destroys listeners and restores input without emitting an exit', () => {
    const h = harness();
    h.controller.enter();
    h.controller.destroy();
    const calls = h.inputCalls.length;
    h.shell.emit('world:control-owner', {
      building: 'post-office',
      owner: 'shell',
    });
    h.shell.emit('world:stations', {
      building: 'post-office',
      stations: [
        {
          station: 'post-office:transfer',
          label: 'TRANSFER',
          status: 'available',
        },
      ],
    });
    expect(h.inputCalls.length).toBe(calls);
    expect(h.inputCalls.at(-1)).toBe('resume');
    expect(h.events).toEqual([]);
  });

  it('attempts every listener cleanup when one stop callback throws', () => {
    const out = bus<WorldEvents>();
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const shell = {
      on: vi.fn(() => {
        const stop = vi.fn();
        stops.push(stop);
        return stop;
      }),
    };
    const input = { suspend: vi.fn(), resume: vi.fn() };
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell as never,
      input,
    });
    const cleanupError = new Error('station listener cleanup failed');
    stops[0]!.mockImplementationOnce(() => { throw cleanupError; });

    expect(() => controller.destroy()).toThrow(cleanupError);
    expect(stops).toHaveLength(3);
    for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
    expect(input.resume).toHaveBeenCalledOnce();

    controller.destroy();
    expect(stops[0]).toHaveBeenCalledTimes(2);
    for (const stop of stops.slice(1)) expect(stop).toHaveBeenCalledOnce();
  });

  it('retries failed listener and input cleanup after destroy', () => {
    const out = bus<WorldEvents>();
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const shell = {
      on: vi.fn(() => {
        const stop = vi.fn();
        stops.push(stop);
        return stop;
      }),
    };
    const cleanupError = new Error('listener cleanup failed');
    const inputError = new Error('input restoration failed');
    const input = {
      suspend: vi.fn(),
      resume: vi.fn().mockImplementationOnce(() => { throw inputError; }),
    };
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell as never,
      input,
    });
    // The first registered listener remains owned when its stop throws; the
    // input cleanup also remains retryable after its first failure.
    stops[0]!.mockImplementationOnce(() => { throw cleanupError; });

    expect(() => controller.destroy()).toThrow(AggregateError);
    expect(stops).toHaveLength(3);
    for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
    expect(input.resume).toHaveBeenCalledOnce();

    expect(() => controller.destroy()).not.toThrow();
    expect(stops[0]).toHaveBeenCalledTimes(2);
    for (const stop of stops.slice(1)) expect(stop).toHaveBeenCalledOnce();
    expect(input.resume).toHaveBeenCalledTimes(2);
  });

  it('stops the entry continuation when onEnter destroys the controller', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const inputCalls: string[] = [];
    const changes: FixedRoomState[] = [];
    let controller!: FixedRoomController;
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: {
        suspend: () => inputCalls.push('suspend'),
        resume: () => inputCalls.push('resume'),
      },
      onEnter: () => controller.destroy(),
      onChange: (state) => changes.push(state),
    });

    controller.enter();

    expect(controller.state.inRoom).toBe(false);
    expect(changes).toEqual([]);
    expect(inputCalls).toEqual(['resume', 'resume']);
  });

  it('stops the exit continuation when onExit destroys the controller', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const events: unknown[] = [];
    const changes: FixedRoomState[] = [];
    out.on('building:exited', (payload) => events.push(payload));
    let controller!: FixedRoomController;
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: () => {}, resume: () => {} },
      onExit: () => controller.destroy(),
      onChange: (state) => changes.push(state),
    });

    controller.enter();
    changes.length = 0;
    controller.update({
      x: POST_OFFICE_ROOM_DEFINITION.exit.x,
      y: POST_OFFICE_ROOM_DEFINITION.exit.y,
    });

    expect(controller.state.inRoom).toBe(false);
    expect(changes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rolls back room ownership when exit announcement fails', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    const announcementError = new Error('exit announcement failed');
    let fail = true;
    out.on('building:exited', () => {
      if (fail) throw announcementError;
    });
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume: vi.fn() },
      onEnter,
      onExit,
    });
    controller.enter();
    const exit = POST_OFFICE_ROOM_DEFINITION.exit;

    expect(() => controller.update({ x: exit.x, y: exit.y })).toThrow(announcementError);
    expect(controller.state.inRoom).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(2);

    fail = false;
    expect(() => controller.update({ x: exit.x, y: exit.y })).not.toThrow();
    expect(controller.state.inRoom).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('stops entry continuation when input resume destroys the controller', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    let controller!: FixedRoomController;
    const onEnter = vi.fn();
    const resume = vi.fn(() => controller.destroy());
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
      onEnter,
    });

    controller.enter();

    expect(controller.state.inRoom).toBe(false);
    expect(onEnter).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('stops exit continuation when input resume re-enters or destroys the controller', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    let controller!: FixedRoomController;
    let destroyOnResume = false;
    const onExit = vi.fn();
    const resume = vi.fn(() => {
      if (destroyOnResume) controller.destroy();
    });
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
      onExit,
    });
    controller.enter();
    destroyOnResume = true;

    controller.update({
      x: POST_OFFICE_ROOM_DEFINITION.exit.x,
      y: POST_OFFICE_ROOM_DEFINITION.exit.y,
    });

    expect(controller.state.inRoom).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('stops exit continuation when input resume synchronously re-enters', () => {
    const out = bus<WorldEvents>();
    const shell = bus<ShellEvents>();
    let controller!: FixedRoomController;
    let reenterOnResume = false;
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const resume = vi.fn(() => {
      if (reenterOnResume) {
        reenterOnResume = false;
        controller.enter();
      }
    });
    controller = createFixedRoomController({
      definition: POST_OFFICE_ROOM_DEFINITION,
      out,
      in: shell,
      input: { suspend: vi.fn(), resume },
      onEnter,
      onExit,
    });
    controller.enter();
    reenterOnResume = true;

    controller.update({
      x: POST_OFFICE_ROOM_DEFINITION.exit.x,
      y: POST_OFFICE_ROOM_DEFINITION.exit.y,
    });

    expect(controller.state.inRoom).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(2);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('uses the Bridge building and station ids for admission, activation, and exit', () => {
    const h = harness(BRIDGE_ROOM_DEFINITION);
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'bridge',
      stations: [{ station: 'bridge:deposit', label: 'DEPOSIT', status: 'available' }],
    });

    h.controller.update({ x: 8, y: 4 });
    expect(h.events).toEqual([
      { event: 'station:activated', payload: { building: 'bridge', station: 'bridge:deposit' } },
    ]);
    expect(h.controller.state.highlightedStation).toBe('bridge:deposit');

    h.controller.update({ x: 9, y: 11 });
    expect(h.events.at(-1)).toEqual({ event: 'building:exited', payload: { building: 'bridge' } });
    expect(h.controller.state.inRoom).toBe(false);
  });
});
