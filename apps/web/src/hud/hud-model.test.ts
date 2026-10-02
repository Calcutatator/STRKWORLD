import { describe, expect, it, vi } from 'vitest';
import type { ShellEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { EMPTY_HUD, applyHudEvent, createHudModel } from './hud-model.js';

describe('HUD model', () => {
  it('shows exactly what the two Shell events carry', () => {
    const bus = createEventBus<ShellEvents>();
    const model = createHudModel();
    const stop = model.listen(bus);

    bus.emit('wallet:status', { status: 'connected' });
    bus.emit('hud:pending', { count: 2 });
    expect(model.store.getState()).toEqual({ wallet: 'connected', pending: 2 });

    bus.emit('hud:pending', { count: 0 });
    expect(model.store.getState()).toEqual({ wallet: 'connected', pending: 0 });

    stop();
    bus.emit('hud:pending', { count: 5 });
    expect(model.store.getState().pending).toBe(0);
  });

  it('D-119: holds no balance, whatever the Bank publishes', () => {
    const bus = createEventBus<ShellEvents>();
    const model = createHudModel();
    model.listen(bus);
    const listener = vi.fn();
    model.store.subscribe(listener);
    bus.emit('wallet:status', { status: 'connected' });
    listener.mockClear();
    bus.emit('hud:balance', { display: '12.5 STRK' });
    expect(listener).not.toHaveBeenCalled();
    expect(model.store.getState()).toEqual({ wallet: 'connected', pending: 0 });
    expect(JSON.stringify(model.store.getState())).not.toContain('STRK');
  });

  it('keeps the last good value when a payload is malformed', () => {
    const good = Object.freeze({ wallet: 'connected' as const, pending: 1 });
    const malformed = [
      { name: 'hud:pending', payload: { count: -1 } },
      { name: 'hud:pending', payload: { count: 1.5 } },
      { name: 'hud:pending', payload: { count: Number.NaN } },
      { name: 'hud:pending', payload: { count: '2' } },
      { name: 'hud:pending', payload: { count: 1_000_000 } },
      { name: 'wallet:status', payload: { status: 'owned' } },
      { name: 'wallet:status', payload: 'connected' },
      {
        name: 'wallet:status',
        payload: Object.defineProperty({}, 'status', { get: () => 'connected', enumerable: true }),
      },
    ] as const;
    for (const event of malformed) {
      expect(applyHudEvent(good, event), JSON.stringify(event.payload)).toBe(good);
    }
  });

  it('does not wake subscribers when nothing changed', () => {
    const bus = createEventBus<ShellEvents>();
    const model = createHudModel();
    model.listen(bus);
    const listener = vi.fn();
    model.store.subscribe(listener);

    bus.emit('hud:pending', { count: 0 });
    expect(listener).not.toHaveBeenCalled();

    bus.emit('hud:pending', { count: 1 });
    bus.emit('hud:pending', { count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('only listens: it publishes nothing on the bus it reads', () => {
    const bus = createEventBus<ShellEvents>();
    const emit = vi.spyOn(bus, 'emit');
    const model = createHudModel();
    const stop = model.listen(bus);
    stop();
    expect(emit).not.toHaveBeenCalled();
  });

  describe('a HUD that subscribes after the status was published (D-072)', () => {
    it('shows the current status at once, not "Checking wallet…"', () => {
      const bus = createEventBus<ShellEvents>();
      // Published before anyone listened: the bus does not replay it (D-038).
      bus.emit('wallet:status', { status: 'disconnected' });
      const late = createHudModel();
      late.listen(bus);
      expect(late.store.getState().wallet).toBeNull();

      const model = createHudModel();
      model.listen(bus, () => 'disconnected');
      expect(model.store.getState().wallet).toBe('disconnected');
    });

    it('takes every later change from the bus', () => {
      const bus = createEventBus<ShellEvents>();
      const model = createHudModel();
      model.listen(bus, () => 'connecting');
      bus.emit('wallet:status', { status: 'connected' });
      expect(model.store.getState()).toEqual({ wallet: 'connected', pending: 0 });
    });

    it('ignores a snapshot it cannot read or does not recognise', () => {
      const bus = createEventBus<ShellEvents>();
      const throwing = createHudModel();
      expect(() => throwing.listen(bus, () => { throw new Error('gone'); })).not.toThrow();
      expect(throwing.store.getState().wallet).toBeNull();
      const odd = createHudModel();
      odd.listen(bus, () => 'online' as never);
      expect(odd.store.getState().wallet).toBeNull();
      const none = createHudModel();
      none.listen(bus, () => null);
      expect(none.store.getState()).toEqual(EMPTY_HUD);
    });

    it('still publishes nothing while reading the snapshot', () => {
      const bus = createEventBus<ShellEvents>();
      const emit = vi.spyOn(bus, 'emit');
      createHudModel().listen(bus, () => 'connected')();
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
