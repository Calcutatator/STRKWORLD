import { describe, expect, it, vi } from 'vitest';
import type { ShellEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { EMPTY_HUD, applyHudEvent, createHudModel } from './hud-model.js';

describe('HUD model', () => {
  it('shows exactly what the three Shell events carry', () => {
    const bus = createEventBus<ShellEvents>();
    const model = createHudModel();
    const stop = model.listen(bus);

    bus.emit('wallet:status', { status: 'connected' });
    bus.emit('hud:balance', { display: '12.5 STRK' });
    bus.emit('hud:pending', { count: 2 });
    expect(model.store.getState()).toEqual({ wallet: 'connected', balance: '12.5 STRK', pending: 2 });

    // Null is the Bank saying "unknown" — after a submission, or before a read.
    bus.emit('hud:balance', { display: null });
    bus.emit('hud:pending', { count: 0 });
    expect(model.store.getState()).toEqual({ wallet: 'connected', balance: null, pending: 0 });

    stop();
    bus.emit('hud:pending', { count: 5 });
    expect(model.store.getState().pending).toBe(0);
  });

  it('forgets the balance the moment the wallet stops being connected', () => {
    let state = applyHudEvent(EMPTY_HUD, { name: 'wallet:status', payload: { status: 'connected' } });
    state = applyHudEvent(state, { name: 'hud:balance', payload: { display: '3 STRK' } });
    for (const status of ['disconnected', 'connecting', 'unsupported', 'unregistered'] as const) {
      const next = applyHudEvent(state, { name: 'wallet:status', payload: { status } });
      expect(next.wallet).toBe(status);
      expect(next.balance).toBeNull();
    }
  });

  it('never shows a figure against a wallet known to be elsewhere', () => {
    const disconnected = applyHudEvent(EMPTY_HUD, { name: 'wallet:status', payload: { status: 'disconnected' } });
    expect(
      applyHudEvent(disconnected, { name: 'hud:balance', payload: { display: '9 STRK' } }).balance,
    ).toBeNull();
    // Before any status arrives the Bank is the only authority, and it only
    // publishes after a read the player asked for.
    expect(applyHudEvent(EMPTY_HUD, { name: 'hud:balance', payload: { display: '9 STRK' } }).balance).toBe('9 STRK');
  });

  it('keeps the last good value when a payload is malformed', () => {
    const good = Object.freeze({ wallet: 'connected' as const, balance: '1 STRK', pending: 1 });
    const malformed = [
      { name: 'hud:balance', payload: { display: 12.5 } },
      { name: 'hud:balance', payload: { display: '' } },
      { name: 'hud:balance', payload: { display: 'x'.repeat(97) } },
      { name: 'hud:balance', payload: { display: '1 STRK\u0007' } },
      { name: 'hud:balance', payload: {} },
      { name: 'hud:balance', payload: null },
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
    bus.emit('hud:balance', { display: null });
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
});
