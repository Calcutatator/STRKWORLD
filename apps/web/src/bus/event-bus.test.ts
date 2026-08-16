import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './event-bus.js';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';

describe('event bus', () => {
  it('delivers a payload to a subscriber', () => {
    const bus = createEventBus<WorldEvents>();
    const handler = vi.fn();
    bus.on('building:entered', handler);
    bus.emit('building:entered', { building: 'bank' });
    expect(handler).toHaveBeenCalledWith({ building: 'bank' });
  });

  it('returns an unsubscribe function from on()', () => {
    const bus = createEventBus<WorldEvents>();
    const handler = vi.fn();
    const stop = bus.on('player:moved', handler);
    stop();
    bus.emit('player:moved', { position: { x: 1, y: 2 }, facing: 'up' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires a once() handler exactly once', () => {
    const bus = createEventBus<WorldEvents>();
    const handler = vi.fn();
    bus.once('world:ready', handler);
    bus.emit('world:ready', {});
    bus.emit('world:ready', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('survives a handler unsubscribing itself mid-emit', () => {
    // once() does exactly this, so iterating the live set would skip listeners.
    const bus = createEventBus<WorldEvents>();
    const second = vi.fn();
    bus.once('world:ready', () => {});
    bus.on('world:ready', second);
    bus.emit('world:ready', {});
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering after a handler throws', () => {
    const bus = createEventBus<ShellEvents>();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    bus.on('hud:balance', () => {
      throw new Error('bad listener');
    });
    bus.on('hud:balance', good);
    bus.emit('hud:balance', { display: '12.5 STRK' });
    expect(good).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('clear() drops every listener', () => {
    const bus = createEventBus<ShellEvents>();
    const handler = vi.fn();
    bus.on('hud:pending', handler);
    bus.clear();
    bus.emit('hud:pending', { count: 3 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('emitting with no listeners is a no-op', () => {
    const bus = createEventBus<WorldEvents>();
    expect(() => bus.emit('building:exited', { building: 'vault' })).not.toThrow();
  });
});
