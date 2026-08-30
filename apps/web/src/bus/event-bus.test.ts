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

  it('publishes an immutable payload snapshot to every subscriber', () => {
    const bus = createEventBus<WorldEvents>();
    const original = { position: { x: 1, y: 2 }, facing: 'right' } as const;
    let observed!: WorldEvents['player:moved'];
    bus.on('player:moved', (payload) => {
      Reflect.set(payload.position, 'x', 99);
      Reflect.set(payload, 'facing', 'up');
    });
    bus.on('player:moved', (payload) => {
      observed = payload;
    });

    bus.emit('player:moved', original);

    expect(original).toEqual({ position: { x: 1, y: 2 }, facing: 'right' });
    expect(observed).toEqual(original);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.position)).toBe(true);
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

  it('does not deliver to a handler unsubscribed before its snapshot turn', () => {
    const bus = createEventBus<WorldEvents>();
    const second = vi.fn();
    let stopSecond!: () => void;
    bus.on('world:ready', () => stopSecond());
    stopSecond = bus.on('world:ready', second);

    bus.emit('world:ready', {});

    expect(second).not.toHaveBeenCalled();
  });

  it('does not let stale cleanup remove a newer subscription for the same handler', () => {
    const bus = createEventBus<WorldEvents>();
    const handler = vi.fn();
    const staleStop = bus.on('world:ready', handler);
    bus.on('world:ready', handler);

    staleStop();
    bus.emit('world:ready', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not deliver a same-handler resubscription during the in-flight emit', () => {
    const bus = createEventBus<WorldEvents>();
    let stop!: () => void;
    let resubscribed = false;
    const handler = vi.fn(() => {
      if (!resubscribed) {
        resubscribed = true;
        stop();
        stop = bus.on('world:ready', handler);
      }
    });
    stop = bus.on('world:ready', handler);

    bus.emit('world:ready', {});
    expect(handler).toHaveBeenCalledOnce();

    bus.emit('world:ready', {});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not deliver a replacement before the captured handler turn', () => {
    const bus = createEventBus<WorldEvents>();
    const second = vi.fn();
    let stopSecond!: () => void;
    let replaced = false;
    bus.on('world:ready', () => {
      if (replaced) return;
      replaced = true;
      stopSecond();
      stopSecond = bus.on('world:ready', second);
    });
    stopSecond = bus.on('world:ready', second);

    bus.emit('world:ready', {});
    expect(second).not.toHaveBeenCalled();

    bus.emit('world:ready', {});
    expect(second).toHaveBeenCalledOnce();
  });

  it('does not deliver remaining handlers after clear() during an emit', () => {
    const bus = createEventBus<WorldEvents>();
    const remaining = vi.fn();
    bus.on('world:ready', () => bus.clear());
    bus.on('world:ready', remaining);

    bus.emit('world:ready', {});

    expect(remaining).not.toHaveBeenCalled();
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
