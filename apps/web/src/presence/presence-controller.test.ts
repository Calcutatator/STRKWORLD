import { describe, expect, it, vi } from 'vitest';
import type { Facing, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceClient } from './presence-controller.js';

function fakeClient() {
  const statuses = new Set<(event: { status: string; reason?: string }) => void>();
  const calls: unknown[][] = [];
  let status = 'idle';
  const client: PresenceClient = {
    connect: vi.fn(async () => { status = 'connected'; statuses.forEach((fn) => fn({ status })); }),
    updatePosition: vi.fn((...args: [number, number, Facing]) => calls.push(['updatePosition', ...args])),
    suspend: vi.fn(() => { status = 'suspended'; }),
    resume: vi.fn((...args: [{ x: number; y: number; facing: Facing }]) => { status = 'connected'; calls.push(['resume', ...args]); }),
    disconnect: vi.fn(async () => { status = 'closed'; }),
    onStatus: vi.fn((fn) => { statuses.add(fn); fn({ status }); return () => statuses.delete(fn); }),
  };
  return { client, calls, drop: () => { status = 'closed'; statuses.forEach((fn) => fn({ status, reason: 'server-dropped' })); } };
}

const moved = { position: { x: 40, y: 72 }, facing: 'left' as const };

describe('presence controller', () => {
  it('does not construct or connect until the first real street movement', () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const factory = vi.fn(() => made.client);
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);
    expect(factory).not.toHaveBeenCalled();
    world.emit('player:moved', moved);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'ws://example', start: { ...moved.position, facing: 'left' } }));
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores reconnect requests before the first street placement', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    presence.reconnect();
    world.emit('player:moved', moved);
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    expect(made.client.disconnect).not.toHaveBeenCalled();
    stop();
  });

  it('forwards only street placement, suspends on entry, and resumes latest placement on exit', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    world.emit('player:moved', { position: { x: 44, y: 76 }, facing: 'down' });
    world.emit('building:entered', { building: 'bank' });
    world.emit('player:moved', { position: { x: 999, y: 999 }, facing: 'up' });
    world.emit('building:exited', { building: 'bank' });
    expect(made.client.suspend).toHaveBeenCalledTimes(1);
    expect(made.calls).toContainEqual(['updatePosition', 44, 76, 'down']);
    expect(made.calls).toContainEqual(['resume', { x: 999, y: 999, facing: 'up' }]);
    stop();
  });

  it('settles a connect-in-flight by suspending before becoming visible inside', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    const made = fakeClient();
    made.client.connect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    world.emit('building:entered', { building: 'bank' });
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(made.client.suspend).toHaveBeenCalledTimes(1);
    expect(presence.getState().status).toBe('suspended');
    stop();
  });

  it('suspends immediately when connected arrives before connect resolves, and exits safely', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    const made = fakeClient();
    made.client.connect = vi.fn(() => {
      // Real LobbyClient reports connected as soon as the room exists, before
      // its welcome-gated connect promise resolves.
      return new Promise<void>((done) => { resolve = done; });
    });
    const originalOnStatus = made.client.onStatus;
    let statusListener: ((event: { status: 'connected' }) => void) | undefined;
    made.client.onStatus = vi.fn((listener) => {
      statusListener = listener as (event: { status: 'connected' }) => void;
      return originalOnStatus(listener);
    });
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    world.emit('building:entered', { building: 'bank' });
    statusListener?.({ status: 'connected' });
    expect(made.client.suspend).toHaveBeenCalledTimes(1);
    expect(presence.getState().status).toBe('suspended');
    world.emit('player:moved', { position: { x: 48, y: 80 }, facing: 'right' });
    world.emit('building:exited', { building: 'bank' });
    expect(made.client.resume).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    expect(made.client.suspend).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reports a server drop as unavailable and reconnects only by explicit request', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    made.drop();
    expect(presence.getState().status).toBe('unavailable');
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    presence.reconnect();
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not reconnect automatically on later movement after a drop', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    made.drop();
    world.emit('player:moved', { position: { x: 50, y: 82 }, facing: 'up' });
    world.emit('player:moved', { position: { x: 52, y: 84 }, facing: 'right' });
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    presence.reconnect();
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reconnects with the latest placement on a fresh client after a drop', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    let resolveInitial!: () => void;
    first.client.connect = vi.fn(() => new Promise<void>((done) => { resolveInitial = done; }));
    const clients = [first, second];
    let made = 0;
    const factory = vi.fn((_options: unknown) => clients[made++]?.client ?? second.client);
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    resolveInitial();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    first.drop();
    const latest = { position: { x: 88, y: 96 }, facing: 'right' as const };
    world.emit('player:moved', latest);
    expect(factory).toHaveBeenCalledTimes(1);
    presence.reconnect();
    presence.reconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      endpoint: 'ws://example',
      start: { x: 88, y: 96, facing: 'right' },
    }));
    expect(first.client.disconnect).toHaveBeenCalledTimes(1);
    expect(second.client.connect).toHaveBeenCalledTimes(1);
    stop();
  });

  it('replaces a dropped suspended client on exit using the restored placement', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    let made = 0;
    let resolveDisconnect!: () => void;
    first.client.disconnect = vi.fn(() => new Promise<void>((done) => { resolveDisconnect = done; }));
    const factory = vi.fn((_options: unknown) => (made++ === 0 ? first.client : second.client));
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    world.emit('building:entered', { building: 'bank' });
    first.drop();
    presence.reconnect();
    const restored = { position: { x: 120, y: 136 }, facing: 'up' as const };
    world.emit('player:moved', restored);
    world.emit('building:exited', { building: 'bank' });
    expect(first.client.resume).not.toHaveBeenCalled();
    expect(first.client.disconnect).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    presence.reconnect();
    presence.reconnect();
    expect(factory).toHaveBeenCalledTimes(1);
    resolveDisconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      start: { x: 120, y: 136, facing: 'up' },
    }));
    expect(second.client.connect).toHaveBeenCalledTimes(1);
    stop();
  });

  it('defers manual reconnect while inside until the physical exit', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    world.emit('building:entered', { building: 'bank' });
    made.drop();
    presence.reconnect();
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    world.emit('building:exited', { building: 'bank' });
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(2);
    stop();
  });

  it('fails closed when the endpoint is missing', () => {
    const presence = createPresenceController({ endpoint: undefined, factory: vi.fn() });
    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: false });
  });

  it('cleanup is repeatable and explicit destroy disconnects once', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const first = presence.listen(world);
    first();
    presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    await presence.destroy();
    await presence.destroy();
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    expect(made.client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores late connected and rejected connect callbacks after destroy', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const made = fakeClient();
    let lateStatus!: (event: { status: 'connected' }) => void;
    const stopStatus = vi.fn();
    made.client.onStatus = vi.fn((listener) => {
      lateStatus = listener as (event: { status: 'connected' }) => void;
      return stopStatus;
    });
    made.client.connect = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    const notifications = vi.fn();
    presence.subscribe(notifications);
    world.emit('player:moved', moved);
    const destroying = presence.destroy();
    await destroying;
    const notificationsAfterDestroy = notifications.mock.calls.length;
    expect(made.client.disconnect).toHaveBeenCalledTimes(1);
    expect(stopStatus).toHaveBeenCalledTimes(1);
    lateStatus({ status: 'connected' });
    resolve();
    reject(new Error('late failure'));
    await Promise.resolve();
    expect(presence.getState().status).toBe('connecting');
    expect(notifications).toHaveBeenCalledTimes(notificationsAfterDestroy);
    stop();
  });

  it('closes a room acquired after destroy during a pending join', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    let live = false;
    const made = fakeClient();
    made.client.connect = vi.fn(() => new Promise<void>((done) => {
      resolve = () => { live = true; done(); };
    }));
    made.client.disconnect = vi.fn(async () => { if (live) live = false; });
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    const destroyed = presence.destroy();
    await destroyed;
    expect(live).toBe(false);
    resolve();
    await Promise.resolve();
    expect(made.client.disconnect).toHaveBeenCalledTimes(2);
    expect(live).toBe(false);
    expect(presence.getState().status).toBe('connecting');
    stop();
  });

  it('runs one explicitly requested reconnect after a stale join settles', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    const made = fakeClient();
    made.client.connect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    presence.reconnect();
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not resurrect a dropped pre-welcome connection inside a building', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    let statusListener!: (event: { status: 'connected' | 'closed'; reason?: 'server-dropped' }) => void;
    const made = fakeClient();
    made.client.onStatus = vi.fn((listener) => {
      statusListener = listener as typeof statusListener;
      return () => {};
    });
    made.client.connect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    world.emit('building:entered', { building: 'bank' });
    statusListener({ status: 'connected' });
    statusListener({ status: 'closed', reason: 'server-dropped' });
    resolve();
    await Promise.resolve();
    expect(presence.getState().status).toBe('unavailable');
    world.emit('building:exited', { building: 'bank' });
    expect(made.client.resume).not.toHaveBeenCalled();
    stop();
  });

  it('reconnects after that stale drop only when explicitly requested inside', async () => {
    const world = createEventBus<WorldEvents>();
    let resolve!: () => void;
    let statusListener!: (event: { status: 'connected' | 'closed'; reason?: 'server-dropped' }) => void;
    const made = fakeClient();
    made.client.onStatus = vi.fn((listener) => { statusListener = listener as typeof statusListener; return () => {}; });
    made.client.connect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    world.emit('building:entered', { building: 'bank' });
    statusListener({ status: 'connected' });
    statusListener({ status: 'closed', reason: 'server-dropped' });
    presence.reconnect();
    world.emit('building:exited', { building: 'bank' });
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(2);
    stop();
  });
});
