import { describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import {
  BANK_SHIELDING_STATION,
  createBankRoom,
  createBankRoomController,
  isBankRoomExit,
  isBankRoomSolidAt,
  isBankStationApproach,
  normalizeBankStationSnapshot,
  type RoomInputGate,
} from './bank-room.js';

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

function inputGate() {
  const calls: string[] = [];
  const input: RoomInputGate = {
    suspend: () => calls.push('suspend'),
    resume: () => calls.push('resume'),
  };
  return { input, calls };
}

describe('Bank room geometry', () => {
  it('is fixed, enclosed, and has a walkable physical exit', () => {
    const room = createBankRoom();
    expect(room.width).toBe(18);
    expect(room.height).toBe(12);
    expect(isBankRoomSolidAt(room, 0, 0)).toBe(true);
    expect(isBankRoomSolidAt(room, room.spawn.x, room.spawn.y)).toBe(false);
    expect(isBankRoomSolidAt(room, room.station.x, room.station.y)).toBe(true);
    expect(isBankRoomExit(room, room.exit.x, room.exit.y)).toBe(true);
    expect(isBankRoomSolidAt(room, room.exit.x, room.exit.y)).toBe(false);
    expect(isBankStationApproach(room, room.station.x, room.station.y + 1)).toBe(true);
  });

  it('does not let an approach overlap the solid station footprint', () => {
    const room = createBankRoom();
    expect(isBankStationApproach(room, room.station.x, room.station.y)).toBe(false);
    expect(isBankStationApproach(room, room.station.x + 1, room.station.y)).toBe(false);
  });
});

describe('station snapshot admission', () => {
  it('fails closed when the Shell sends no snapshot or an unknown station', () => {
    expect(normalizeBankStationSnapshot(undefined)).toMatchObject({
      station: BANK_SHIELDING_STATION,
      status: 'locked',
    });
    expect(
      normalizeBankStationSnapshot([
        { station: 'bank:forged', label: 'FORGED', status: 'available' },
      ] as never),
    ).toMatchObject({ status: 'locked' });
  });

  it('accepts only the known station and keeps the Shell label', () => {
    expect(
      normalizeBankStationSnapshot([
        { station: BANK_SHIELDING_STATION, label: 'SHIELD / UNSHIELD', status: 'available' },
      ]),
    ).toEqual({
      station: BANK_SHIELDING_STATION,
      label: 'SHIELD / UNSHIELD',
      status: 'available',
    });
  });

  it('locks ambiguous or malformed known-station snapshots', () => {
    expect(
      normalizeBankStationSnapshot([
        { station: BANK_SHIELDING_STATION, label: 'A', status: 'available' },
        { station: BANK_SHIELDING_STATION, label: 'B', status: 'available' },
      ]),
    ).toMatchObject({ status: 'locked' });
    expect(
      normalizeBankStationSnapshot([
        { station: BANK_SHIELDING_STATION, label: ' ', status: 'available' },
      ]),
    ).toMatchObject({ status: 'locked' });
  });
});

describe('Bank room controller', () => {
  function setup() {
    const out = bus<WorldEvents>();
    const input = inputGate();
    const shell = bus<ShellEvents>();
    const events: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
    for (const event of ['station:activated', 'building:exited'] as const) {
      out.on(event, (payload) => events.push({ event, payload }));
    }
    const controller = createBankRoomController({ out, in: shell, input: input.input });
    return { out, shell, controller, events, input };
  }

  it('starts every visit locked until a matching Shell snapshot arrives', () => {
    const h = setup();
    h.controller.enter();
    h.controller.update({ x: 8, y: 4 });
    expect(h.events).toEqual([]);
    expect(h.controller.state.station.status).toBe('locked');
  });

  it('highlights and activates once per approach, suspending before the emit', () => {
    const h = setup();
    const order: string[] = [];
    h.input.input.suspend = () => order.push('suspend');
    h.out.on('station:activated', () => order.push('emit'));
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'bank',
      stations: [{ station: BANK_SHIELDING_STATION, label: 'SHIELD / UNSHIELD', status: 'available' }],
    });

    h.controller.update({ x: 8, y: 4 });
    h.controller.update({ x: 9, y: 4 });
    expect(order).toEqual(['suspend', 'emit']);
    expect(h.events).toHaveLength(1);
    expect(h.controller.state.highlightedStation).toBe(BANK_SHIELDING_STATION);

    h.controller.update({ x: 9, y: 5 });
    expect(h.events).toHaveLength(1);
    h.controller.update({ x: 9, y: 6 });
    h.controller.update({ x: 9, y: 4 });
    expect(h.events).toHaveLength(2);
  });

  it('keeps controls suspended only when the matching Shell claims them', () => {
    const h = setup();
    h.controller.enter();
    h.shell.emit('world:stations', {
      building: 'bank',
      stations: [{ station: BANK_SHIELDING_STATION, label: 'SHIELD / UNSHIELD', status: 'available' }],
    });
    h.controller.update({ x: 9, y: 4 });
    expect(h.controller.state.controlOwner).toBe('world');
    expect(h.input.calls.at(-1)).toBe('resume');

    h.shell.emit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(h.controller.state.controlOwner).toBe('shell');
    expect(h.input.calls.at(-1)).toBe('suspend');
    h.shell.emit('world:control-owner', { building: 'bank', owner: 'world' });
    expect(h.controller.state.controlOwner).toBe('world');
    expect(h.input.calls.at(-1)).toBe('resume');
  });

  it('ignores stale building commands', () => {
    const h = setup();
    h.controller.enter();
    h.shell.emit('world:control-owner', { building: 'exchange', owner: 'shell' });
    h.shell.emit('world:exit-building', { building: 'exchange' });
    expect(h.controller.state.inRoom).toBe(true);
    expect(h.controller.state.controlOwner).toBe('world');
    expect(h.events).toEqual([]);
  });

  it('returns safely through the physical exit and emits one matching exit', () => {
    const h = setup();
    const exited = vi.fn();
    h.out.on('building:exited', exited);
    h.controller.enter();
    h.controller.update({ x: 8, y: 11 });
    expect(h.controller.state.inRoom).toBe(false);
    expect(h.controller.state.controlOwner).toBe('world');
    expect(exited).toHaveBeenCalledWith({ building: 'bank' });
    h.controller.update({ x: 8, y: 11 });
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it('accepts a matching Shell exit command and ignores a later duplicate', () => {
    const h = setup();
    h.controller.enter();
    h.shell.emit('world:exit-building', { building: 'bank' });
    expect(h.controller.state.inRoom).toBe(false);
    expect(h.events).toEqual([{ event: 'building:exited', payload: { building: 'bank' } }]);
    h.shell.emit('world:exit-building', { building: 'bank' });
    expect(h.events).toHaveLength(1);
  });

  it('cleans all Shell listeners and restores input on shutdown', () => {
    const h = setup();
    h.controller.enter();
    h.shell.emit('world:control-owner', { building: 'bank', owner: 'shell' });
    h.controller.destroy();
    const calls = h.input.calls.length;
    h.shell.emit('world:control-owner', { building: 'bank', owner: 'shell' });
    h.shell.emit('world:stations', {
      building: 'bank',
      stations: [{ station: BANK_SHIELDING_STATION, label: 'x', status: 'available' }],
    });
    expect(h.input.calls.length).toBe(calls);
    expect(h.controller.state.inRoom).toBe(false);
  });
});
