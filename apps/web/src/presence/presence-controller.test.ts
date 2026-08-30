import { describe, expect, it, vi } from 'vitest';
import type { AvatarSpriteKey, Facing, WorldEvents } from '@strkworld/shared';
import type { RemotePeerSnapshot } from '@strkworld/world';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceClient, type PresenceAvailability } from './presence-controller.js';

function fakeClient() {
  const statuses = new Set<(event: { status: string; reason?: string }) => void>();
  const peerListeners = new Set<(peers: readonly { gameId: string; x: number; y: number; facing: Facing; sprite: string }[]) => void>();
  const calls: unknown[][] = [];
  let status = 'idle';
  const client: PresenceClient = {
    connect: vi.fn(async () => { status = 'connected'; statuses.forEach((fn) => fn({ status })); }),
    updatePosition: vi.fn((...args: [number, number, Facing]) => calls.push(['updatePosition', ...args])),
    suspend: vi.fn(() => { status = 'suspended'; }),
    resume: vi.fn((...args: [{ x: number; y: number; facing: Facing }, AvatarSpriteKey]) => { status = 'connected'; calls.push(['resume', ...args]); }),
    disconnect: vi.fn(async () => { status = 'closed'; }),
    onStatus: vi.fn((fn) => { statuses.add(fn); fn({ status }); return () => statuses.delete(fn); }),
    onPeers: vi.fn((fn) => { peerListeners.add(fn); fn([]); return () => peerListeners.delete(fn); }),
  };
  return {
    client,
    calls,
    publishPeers: (peers: readonly { gameId: string; x: number; y: number; facing: Facing; sprite: string }[]) => peerListeners.forEach((fn) => fn(peers)),
    capturePeerListener: () => [...peerListeners][0],
    peerListenerCount: () => peerListeners.size,
    emitStatus: (event: { status: string; reason?: string }) => statuses.forEach((fn) => fn(event)),
    drop: () => { status = 'closed'; statuses.forEach((fn) => fn({ status, reason: 'server-dropped' })); },
  };
}

type StatusListener = Parameters<PresenceClient['onStatus']>[0];
type StatusEvent = Parameters<StatusListener>[0];

function controlledClient() {
  const made = fakeClient();
  let statusListener: StatusListener | undefined;
  made.client.onStatus = vi.fn((listener: StatusListener) => {
    statusListener = listener;
    return () => {
      if (statusListener === listener) statusListener = undefined;
    };
  });
  made.client.connect = vi.fn(() => new Promise<void>(() => {}));
  return {
    ...made,
    emitStatus: (event: StatusEvent) => statusListener?.(event),
  };
}

const moved = { position: { x: 40, y: 72 }, facing: 'left' as const };

async function drainAsyncWork() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('presence controller', () => {
  it('does not notify a listener added during a transition until the next transition', () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const first = vi.fn();
    const second = vi.fn();
    let added = false;
    first.mockImplementation(() => {
      if (!added) {
        added = true;
        presence.subscribe(second);
      }
    });
    presence.subscribe(first);
    const stopWorld = presence.listen(world);

    world.emit('player:moved', moved);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    made.emitStatus({ status: 'connected' });
    expect(second).toHaveBeenCalledTimes(1);
    stopWorld();
  });

  it('skips a listener unsubscribed before its turn in the same transition', () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const first = vi.fn();
    const second = vi.fn();
    let stopSecond!: () => void;
    first.mockImplementation(() => stopSecond());
    presence.subscribe(first);
    stopSecond = presence.subscribe(second);
    const stopWorld = presence.listen(world);

    world.emit('player:moved', moved);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    stopWorld();
  });

  it('does not revive an old recipient when the same function is resubscribed', () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const first = vi.fn();
    const second = vi.fn();
    let stopSecond!: () => void;
    let replaced = false;
    first.mockImplementation(() => {
      if (!replaced) {
        replaced = true;
        stopSecond();
        presence.subscribe(second);
      }
    });
    presence.subscribe(first);
    stopSecond = presence.subscribe(second);
    const stopWorld = presence.listen(world);

    world.emit('player:moved', moved);

    expect(second).not.toHaveBeenCalled();
    stopWorld();
  });

  it('keeps a replacement owned when an older unsubscribe settles later', () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const listener = vi.fn();
    const staleStop = presence.subscribe(listener);
    presence.subscribe(listener);
    staleStop();
    const stopWorld = presence.listen(world);

    world.emit('player:moved', moved);

    expect(listener).toHaveBeenCalledTimes(1);
    stopWorld();
  });

  it('keeps reentrant public status transitions synchronous with current state', () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const seen: PresenceAvailability[] = [];
    let reentered = false;
    const first = vi.fn(() => {
      if (!reentered) {
        reentered = true;
        made.emitStatus({ status: 'connected' });
      }
      seen.push(presence.getState().status);
    });
    const second = vi.fn(() => seen.push(presence.getState().status));
    presence.subscribe(first);
    presence.subscribe(second);
    const stopWorld = presence.listen(world);

    world.emit('player:moved', moved);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['connected', 'connected', 'connected', 'connected']);
    stopWorld();
  });

  it('exposes a replaying opaque remote-peer source adapted from lobby snapshots', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const snapshots: RemotePeerSnapshot[][] = [];
    const rawSnapshots: (readonly RemotePeerSnapshot[])[] = [];
    const stopSource = presence.remotePeers.subscribe((peers) => {
      rawSnapshots.push(peers);
      snapshots.push([...peers]);
    });

    expect(snapshots).toEqual([[]]);
    const stopWorld = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    expect(made.client.onPeers).toHaveBeenCalledTimes(1);
    made.publishPeers([{ gameId: 'peer-7', x: 40, y: 72, facing: 'left', sprite: 'avatar-2' }]);

    expect(snapshots.at(-1)).toEqual([{ id: 'peer-7', x: 40, y: 72, facing: 'left', sprite: 'avatar-2' }]);
    expect(Object.isFrozen(rawSnapshots.at(-1))).toBe(true);
    expect(Object.isFrozen(rawSnapshots.at(-1)?.[0])).toBe(true);
    stopSource();
    stopWorld();
  });

  it('sanitizes malformed lobby peers before exposing the retained source', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const snapshots: RemotePeerSnapshot[][] = [];
    const stopSource = presence.remotePeers.subscribe((peers) => snapshots.push([...peers]));
    const stopWorld = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();

    made.publishPeers([
      { gameId: 'not valid', x: 40, y: 72, facing: 'down', sprite: 'avatar-1' },
      { gameId: 'nan', x: Number.NaN, y: 72, facing: 'down', sprite: 'avatar-1' },
      { gameId: 'infinite', x: 40, y: Number.POSITIVE_INFINITY, facing: 'down', sprite: 'avatar-1' },
      { gameId: 'bad-facing', x: 40, y: 72, facing: 'diagonal' as never, sprite: 'avatar-1' },
      { gameId: 'bad-sprite', x: 40, y: 72, facing: 'down', sprite: 'not-allowlisted' },
    ]);

    expect(snapshots.at(-1)).toEqual([{
      id: 'bad-sprite',
      x: 40,
      y: 72,
      facing: 'down',
      sprite: 'avatar-1',
    }]);
    stopSource();
    stopWorld();
  });

  it('publishes complete replacements and clears on a lobby drop', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const snapshots: RemotePeerSnapshot[][] = [];
    const stopSource = presence.remotePeers.subscribe((peers) => snapshots.push([...peers]));
    const stopWorld = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();

    made.publishPeers([
      { gameId: 'peer-1', x: 40, y: 72, facing: 'down', sprite: 'avatar-1' },
      { gameId: 'peer-2', x: 80, y: 72, facing: 'left', sprite: 'avatar-2' },
    ]);
    made.publishPeers([{ gameId: 'peer-2', x: 88, y: 72, facing: 'left', sprite: 'avatar-2' }]);
    made.drop();

    expect(snapshots.at(-3)).toEqual([
      { id: 'peer-1', x: 40, y: 72, facing: 'down', sprite: 'avatar-1' },
      { id: 'peer-2', x: 80, y: 72, facing: 'left', sprite: 'avatar-2' },
    ]);
    expect(snapshots.at(-2)).toEqual([{ id: 'peer-2', x: 88, y: 72, facing: 'left', sprite: 'avatar-2' }]);
    expect(snapshots.at(-1)).toEqual([]);
    stopSource();
    stopWorld();
  });

  it('does not install peer delivery after status subscription synchronously drops the client', () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    let peerListener: Parameters<PresenceClient['onPeers']>[0] | undefined;
    const stopPeers = vi.fn();
    made.client.onStatus = vi.fn((listener) => {
      listener({ status: 'idle' });
      listener({ status: 'closed', reason: 'server-dropped' });
      return () => undefined;
    });
    made.client.onPeers = vi.fn((listener) => {
      peerListener = listener;
      return stopPeers;
    });
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const snapshots: RemotePeerSnapshot[][] = [];
    presence.remotePeers.subscribe((peers) => snapshots.push([...peers]));
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    peerListener?.([{ gameId: 'stale', x: 1, y: 2, facing: 'up', sprite: 'avatar-1' }]);

    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: true });
    expect(made.client.onPeers).not.toHaveBeenCalled();
    expect(stopPeers).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([]);
    stop();
  });

  it('keeps a synchronous close authoritative when connected status suspends inside', async () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    world.emit('building:entered', { building: 'bank' });
    vi.mocked(made.client.suspend).mockImplementationOnce(() => {
      made.emitStatus({ status: 'closed', reason: 'server-dropped' });
    });

    made.emitStatus({ status: 'connected' });

    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: true });
    stop();
  });

  it('keeps a synchronous close authoritative when building entry suspends', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    vi.mocked(made.client.suspend).mockImplementationOnce(() => {
      made.emitStatus({ status: 'closed', reason: 'server-dropped' });
    });

    world.emit('building:entered', { building: 'bank' });

    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: true });
    stop();
  });

  it('keeps a synchronous close authoritative when building exit resumes', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    world.emit('building:entered', { building: 'bank' });
    vi.mocked(made.client.resume).mockImplementationOnce(() => {
      made.emitStatus({ status: 'closed', reason: 'server-dropped' });
    });

    world.emit('building:exited', { building: 'bank' });

    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: true });
    stop();
  });

  it('ignores a retired client status callback after replacement begins', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = controlledClient();
    let staleStatus!: StatusListener;
    first.client.onStatus = vi.fn((listener) => {
      staleStatus = listener;
      listener({ status: 'idle' });
      return () => undefined;
    });
    let created = 0;
    const presence = createPresenceController({
      endpoint: 'ws://example',
      factory: () => (created++ === 0 ? first.client : second.client),
    });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    staleStatus({ status: 'closed', reason: 'server-dropped' });
    presence.reconnect();
    await Promise.resolve();
    staleStatus({ status: 'connected' });

    expect(second.client.connect).toHaveBeenCalledOnce();
    expect(presence.getState()).toEqual({ status: 'connecting', canReconnect: true });
    stop();
  });

  it('owns a connect attempt before publishing its connecting state', () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    presence.subscribe(() => {
      if (presence.getState().status === 'connecting') presence.reconnect();
    });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);

    expect(made.client.connect).toHaveBeenCalledOnce();
    stop();
  });

  it('does not start a connect after synchronous destroy during connecting publication', async () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    let destroying: Promise<void> | undefined;
    presence.subscribe(() => {
      if (presence.getState().status === 'connecting') destroying = presence.destroy();
    });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    await destroying;

    expect(made.client.connect).not.toHaveBeenCalled();
    expect(made.client.disconnect).toHaveBeenCalledOnce();
    stop();
  });

  it('keeps a synchronous close authoritative when a resolved join suspends inside', async () => {
    const world = createEventBus<WorldEvents>();
    const made = controlledClient();
    let resolveConnect!: () => void;
    made.client.connect = vi.fn(() => new Promise<void>((resolve) => { resolveConnect = resolve; }));
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    made.emitStatus({ status: 'connecting' });
    world.emit('building:entered', { building: 'bank' });
    vi.mocked(made.client.suspend).mockImplementationOnce(() => {
      made.emitStatus({ status: 'closed', reason: 'server-dropped' });
    });

    await vi.waitFor(() => expect(made.client.connect).toHaveBeenCalledOnce());
    resolveConnect();
    await Promise.resolve();

    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: true });
    stop();
  });

  it('detaches stale peer callbacks on drop and replacement', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    let calls = 0;
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => (calls++ === 0 ? first.client : second.client) });
    const snapshots: RemotePeerSnapshot[][] = [];
    presence.remotePeers.subscribe((peers) => snapshots.push([...peers]));
    const stopWorld = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    const stale = first.capturePeerListener();
    first.drop();
    stale?.([{ gameId: 'stale', x: 1, y: 2, facing: 'up', sprite: 'avatar-1' }]);
    expect(snapshots.at(-1)).toEqual([]);

    presence.reconnect();
    await Promise.resolve();
    expect(first.peerListenerCount()).toBe(0);
    expect(second.peerListenerCount()).toBe(1);
    first.publishPeers([{ gameId: 'stale-again', x: 3, y: 4, facing: 'up', sprite: 'avatar-1' }]);
    second.publishPeers([{ gameId: 'fresh', x: 5, y: 6, facing: 'down', sprite: 'avatar-2' }]);
    expect(snapshots.at(-1)).toEqual([{ id: 'fresh', x: 5, y: 6, facing: 'down', sprite: 'avatar-2' }]);
    stopWorld();
  });

  it('clears the retained source on destroy', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const snapshots: RemotePeerSnapshot[][] = [];
    presence.remotePeers.subscribe((peers) => snapshots.push([...peers]));
    const stopWorld = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    made.publishPeers([{ gameId: 'peer-1', x: 40, y: 72, facing: 'down', sprite: 'avatar-1' }]);
    await presence.destroy();

    expect(snapshots.at(-1)).toEqual([]);
    expect(made.peerListenerCount()).toBe(0);
    stopWorld();
  });

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

  it('queues reconnect before the first placement without inventing coordinates', async () => {
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

  it('retains a pre-placement reconnect through an interior visit and joins after exit', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);

    presence.reconnect();
    world.emit('building:entered', { building: 'bank' });
    world.emit('player:moved', moved);
    expect(made.client.connect).not.toHaveBeenCalled();

    world.emit('building:exited', { building: 'bank' });
    await Promise.resolve();
    expect(made.client.connect).toHaveBeenCalledTimes(1);
    expect(made.client.connect).toHaveBeenCalledWith();
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
    expect(made.calls).toContainEqual(['resume', { x: 999, y: 999, facing: 'up' }, 'avatar-1']);
    stop();
  });

  it('keeps an Avatar Studio selection local until exit, then resumes with it', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await Promise.resolve();
    await Promise.resolve();
    made.calls.length = 0;
    vi.mocked(made.client.updatePosition).mockClear();
    vi.mocked(made.client.resume).mockClear();

    world.emit('avatar-studio:entered', {});
    world.emit('avatar:selected', { sprite: 'avatar-11' });
    world.emit('player:moved', { position: { x: 700, y: 800 }, facing: 'up' });

    expect(made.client.suspend).toHaveBeenCalledTimes(1);
    expect(made.client.updatePosition).not.toHaveBeenCalled();
    expect(made.client.resume).not.toHaveBeenCalled();

    world.emit('player:moved', { position: { x: 72, y: 104 }, facing: 'down' });
    expect(made.client.updatePosition).not.toHaveBeenCalled();
    world.emit('avatar-studio:exited', {});
    expect(made.calls).toEqual([
      ['resume', { x: 72, y: 104, facing: 'down' }, 'avatar-11'],
    ]);
    stop();
  });

  it('uses the selected avatar when reconnecting outside the studio', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    const clients = [first, second];
    let created = 0;
    const factory = vi.fn(() => clients[created++]!.client);
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    await Promise.resolve();
    world.emit('avatar-studio:entered', {});
    world.emit('avatar:selected', { sprite: 'avatar-16' });
    world.emit('player:moved', { position: { x: 700, y: 800 }, facing: 'up' });
    world.emit('player:moved', { position: { x: 56, y: 104 }, facing: 'down' });
    world.emit('avatar-studio:exited', {});
    expect(first.calls).toContainEqual([
      'resume',
      { x: 56, y: 104, facing: 'down' },
      'avatar-16',
    ]);
    expect(first.calls).not.toContainEqual([
      'resume',
      { x: 700, y: 800, facing: 'up' },
      'avatar-16',
    ]);
    expect(first.calls).not.toContainEqual(['updatePosition', 700, 800, 'up']);
    first.drop();
    presence.reconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(factory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      start: { x: 56, y: 104, facing: 'down' },
      sprite: 'avatar-16',
    }));
    expect(second.client.connect).toHaveBeenCalledTimes(1);
    stop();
  });

  it('replaces an in-flight join that captured the pre-selection sprite', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    let resolveInitial!: () => void;
    first.client.connect = vi.fn(() => new Promise<void>((resolve) => { resolveInitial = resolve; }));
    const clients = [first, second];
    let created = 0;
    const factory = vi.fn(() => clients[created++]!.client);
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    world.emit('avatar-studio:entered', {});
    world.emit('avatar:selected', { sprite: 'avatar-14' });
    world.emit('player:moved', { position: { x: 700, y: 800 }, facing: 'up' });
    world.emit('player:moved', { position: { x: 48, y: 96 }, facing: 'down' });
    world.emit('avatar-studio:exited', {});

    expect(first.client.updatePosition).not.toHaveBeenCalled();
    expect(first.client.resume).not.toHaveBeenCalled();

    resolveInitial();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(first.client.disconnect).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      start: { x: 48, y: 96, facing: 'down' },
      sprite: 'avatar-14',
    }));
    expect(second.client.connect).toHaveBeenCalledTimes(1);
    expect(first.client.updatePosition).not.toHaveBeenCalled();
    stop();
  });

  it('retains one stale-sprite replacement when entry defers it until exit', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    let resolveInitial!: () => void;
    let resolveDisconnect!: () => void;
    first.client.connect = vi.fn(() => new Promise<void>((resolve) => { resolveInitial = resolve; }));
    first.client.disconnect = vi.fn(() => new Promise<void>((resolve) => { resolveDisconnect = resolve; }));
    const clients = [first, second];
    let created = 0;
    const factory = vi.fn(() => clients[created++]!.client);
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    world.emit('avatar-studio:entered', {});
    world.emit('avatar:selected', { sprite: 'avatar-14' });
    world.emit('player:moved', { position: { x: 48, y: 96 }, facing: 'down' });
    world.emit('avatar-studio:exited', {});
    resolveInitial();
    await vi.waitFor(() => expect(first.client.disconnect).toHaveBeenCalledTimes(1));

    world.emit('building:entered', { building: 'bank' });
    world.emit('player:moved', { position: { x: 700, y: 800 }, facing: 'up' });
    resolveDisconnect();
    await drainAsyncWork();
    expect(factory).toHaveBeenCalledTimes(1);

    const restored = { position: { x: 120, y: 136 }, facing: 'left' as const };
    world.emit('player:moved', restored);
    world.emit('building:exited', { building: 'bank' });
    await vi.waitFor(() => expect(second.client.connect).toHaveBeenCalledTimes(1));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      start: { x: 120, y: 136, facing: 'left' },
      sprite: 'avatar-14',
    }));
    expect(first.client.resume).not.toHaveBeenCalled();
    expect(first.client.updatePosition).not.toHaveBeenCalledWith(700, 800, 'up');
    stop();
  });

  it('ignores a malformed avatar selection at the runtime boundary', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    await Promise.resolve();
    world.emit('avatar-studio:entered', {});
    world.emit('avatar:selected', { sprite: 'account-shaped-free-form-value' } as never);
    world.emit('avatar-studio:exited', {});

    expect(made.client.resume).toHaveBeenCalledWith(
      { x: 40, y: 72, facing: 'left' },
      'avatar-1',
    );
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

  it('deduplicates reconnect clicks already covered by an active replacement', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    const unexpectedThird = fakeClient();
    let resolveDisconnect!: () => void;
    let resolveSecondConnect!: () => void;
    first.client.disconnect = vi.fn(() => new Promise<void>((resolve) => { resolveDisconnect = resolve; }));
    second.client.connect = vi.fn(() => new Promise<void>((resolve) => { resolveSecondConnect = resolve; }));
    const clients = [first, second, unexpectedThird];
    let created = 0;
    const factory = vi.fn(() => clients[created++]!.client);
    const presence = createPresenceController({ endpoint: 'ws://example', factory });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    await drainAsyncWork();
    first.drop();
    presence.reconnect();
    expect(first.client.disconnect).toHaveBeenCalledTimes(1);

    presence.reconnect();
    presence.reconnect();
    resolveDisconnect();
    await vi.waitFor(() => expect(second.client.connect).toHaveBeenCalledTimes(1));
    resolveSecondConnect();
    await drainAsyncWork();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.client.disconnect).toHaveBeenCalledTimes(1);
    expect(second.client.disconnect).not.toHaveBeenCalled();
    expect(second.client.connect).toHaveBeenCalledTimes(1);
    expect(unexpectedThird.client.connect).not.toHaveBeenCalled();
    expect(presence.getState().status).toBe('connected');
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

  it('rolls back world listeners when a later listener registration fails', () => {
    const world = createEventBus<WorldEvents>();
    const originalOn = world.on;
    const stopCalls: Array<ReturnType<typeof vi.fn>> = [];
    let registrations = 0;
    const failure = new Error('world listener registration failed');
    world.on = ((event, handler) => {
      registrations += 1;
      if (registrations === 3) throw failure;
      const stop = originalOn(event, handler);
      const trackedStop = vi.fn(stop);
      if (stopCalls.length === 0) {
        trackedStop.mockImplementation(() => {
          stop();
          throw new Error('listener cleanup failed');
        });
      }
      stopCalls.push(trackedStop);
      return trackedStop;
    }) as typeof world.on;

    const presence = createPresenceController({ endpoint: undefined, factory: vi.fn() });

    expect(() => presence.listen(world)).toThrow(failure);
    expect(stopCalls).toHaveLength(2);
    expect(stopCalls.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it('finishes cleanup before surfacing an asynchronous disconnect rejection', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const failure = new Error('disconnect failed');
    made.client.disconnect = vi.fn(async () => { throw failure; });
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await drainAsyncWork();

    await expect(presence.destroy()).rejects.toBe(failure);
    await expect(presence.destroy()).rejects.toBe(failure);
    expect(made.client.disconnect).toHaveBeenCalledOnce();
    expect(made.peerListenerCount()).toBe(0);
    stop();
  });

  it('retains a deterministic destroy rejection when disconnect throws synchronously', async () => {
    const world = createEventBus<WorldEvents>();
    const made = fakeClient();
    const failure = new Error('synchronous disconnect failed');
    made.client.disconnect = vi.fn(() => { throw failure; });
    const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
    const stop = presence.listen(world);
    world.emit('player:moved', moved);
    await drainAsyncWork();

    await expect(presence.destroy()).rejects.toBe(failure);
    await expect(presence.destroy()).rejects.toBe(failure);
    expect(made.client.disconnect).toHaveBeenCalledOnce();
    expect(made.peerListenerCount()).toBe(0);
    stop();
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

  it('retries a failed join when reconnect was requested while it was settling', async () => {
    const world = createEventBus<WorldEvents>();
    const first = fakeClient();
    const second = fakeClient();
    let rejectInitial!: (error: unknown) => void;
    first.client.connect = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectInitial = reject; }));
    const clients = [first, second];
    let created = 0;
    const presence = createPresenceController({
      endpoint: 'ws://example',
      factory: vi.fn(() => clients[created++]!.client),
    });
    const stop = presence.listen(world);

    world.emit('player:moved', moved);
    expect(first.client.connect).toHaveBeenCalledTimes(1);
    // A real LobbyClient reports idle before its connect() promise rejects.
    // The status layer is therefore already showing the reconnect action while
    // the failed join is still unwinding.
    first.emitStatus({ status: 'idle' });
    presence.reconnect();
    rejectInitial(new Error('server unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(second.client.connect).toHaveBeenCalledTimes(1);
    expect(presence.getState().status).toBe('connected');
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
