import { describe, expect, it } from 'vitest';
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
  fixedRoomStationPresentations,
  isFixedRoomApproach,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  normalizeFixedRoomStations,
  type FixedRoomDefinition,
} from './fixed-room.js';

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

function harness(definition: FixedRoomDefinition = POST_OFFICE_ROOM_DEFINITION) {
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
  });
  return { out, shell, inputCalls, events, controller };
}

describe('fixed room definitions', () => {
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
