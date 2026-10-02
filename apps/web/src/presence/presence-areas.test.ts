/**
 * D-087: how the presence controller maps the World's events onto presence
 * areas. The Avatar Studio, the Exchange roof and the bunker (D-112) switch
 * the client's area; every other interior (and the Exchange's ground and
 * degen floors) still suspends it.
 */

import { describe, expect, it, vi } from 'vitest';
import { BUILDINGS, type AvatarSpriteKey, type Facing, type PresenceArea, type WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { createPresenceController, type PresenceClient } from './presence-controller.js';

type Placement = { x: number; y: number; facing: Facing };

function areaClient(options: { shares?: boolean } = {}) {
  const statuses = new Set<(event: { status: string; reason?: string }) => void>();
  const calls: unknown[][] = [];
  let status = 'idle';
  const client: PresenceClient = {
    connect: vi.fn(async () => {
      status = 'connected';
      statuses.forEach((fn) => fn({ status }));
    }),
    updatePosition: vi.fn((x: number, y: number, facing: Facing) => calls.push(['updatePosition', x, y, facing])),
    suspend: vi.fn(() => {
      status = 'suspended';
      calls.push(['suspend']);
    }),
    resume: vi.fn((placement: Placement, sprite: AvatarSpriteKey) => {
      status = 'connected';
      calls.push(['resume', placement, sprite]);
    }),
    disconnect: vi.fn(async () => {
      status = 'closed';
    }),
    onStatus: vi.fn((fn) => {
      statuses.add(fn);
      fn({ status });
      return () => statuses.delete(fn);
    }),
    onPeers: vi.fn((fn) => {
      fn([]);
      return () => undefined;
    }),
  };
  if (options.shares !== false) {
    client.enterArea = vi.fn((area: PresenceArea, placement: Placement, sprite: AvatarSpriteKey) => {
      const was = status;
      status = 'connected';
      calls.push(['enterArea', area, placement, sprite]);
      // As LobbyClient: going live from a suspend reports `connected`.
      if (was === 'suspended') statuses.forEach((fn) => fn({ status }));
    });
  }
  return { client, calls };
}

const street: WorldEvents['player:moved'] = { position: { x: 1400, y: 400 }, facing: 'up' };
const studioSpawn: WorldEvents['area:moved'] = { position: { x: 368, y: 112 }, facing: 'down' };
const roofArrival: WorldEvents['area:moved'] = { position: { x: 1488, y: 272 }, facing: 'up' };
/** D-112: the bunker's spawn, room tile (2, 8) at the interiors' origin. */
const bunkerSpawn: WorldEvents['area:moved'] = { position: { x: 144, y: 336 }, facing: 'up' };

async function connectedOnStreet(shares = true) {
  const world = createEventBus<WorldEvents>();
  const made = areaClient({ shares });
  const presence = createPresenceController({ endpoint: 'ws://example', factory: () => made.client });
  const stop = presence.listen(world);
  world.emit('player:moved', street);
  await Promise.resolve();
  await Promise.resolve();
  expect(presence.getState().status).toBe('connected');
  made.calls.length = 0;
  return { world, made, presence, stop };
}

describe('presence areas in the controller (D-087)', () => {
  it('switches the client into the Studio and back to the street instead of suspending', async () => {
    const { world, made, presence, stop } = await connectedOnStreet();

    world.emit('area:moved', studioSpawn);
    world.emit('avatar-studio:entered', {});
    expect(made.calls).toEqual([['enterArea', 'studio', { x: 368, y: 112, facing: 'down' }, 'avatar-1']]);
    expect(presence.getState().status).toBe('connected');

    world.emit('area:moved', { position: { x: 368, y: 140 }, facing: 'down' });
    expect(made.calls.at(-1)).toEqual(['updatePosition', 368, 140, 'down']);

    // A look change in the Studio is shown to the others at once.
    world.emit('avatar:selected', { sprite: 'avatar-5' });
    expect(made.calls.at(-1)).toEqual(['enterArea', 'studio', { x: 368, y: 140, facing: 'down' }, 'avatar-5']);

    // The street placement comes before the exit, as the World emits it.
    world.emit('player:moved', { position: { x: 1100, y: 600 }, facing: 'down' });
    expect(made.calls.at(-1)?.[0]).not.toBe('updatePosition');
    world.emit('avatar-studio:exited', {});
    expect(made.calls.at(-1)).toEqual(['enterArea', 'street', { x: 1100, y: 600, facing: 'down' }, 'avatar-5']);
    expect(made.client.suspend).not.toHaveBeenCalled();
    expect(made.client.resume).not.toHaveBeenCalled();
    expect(presence.getState().status).toBe('connected');

    // Back on the street, moves are street moves again.
    world.emit('player:moved', { position: { x: 1110, y: 600 }, facing: 'right' });
    expect(made.calls.at(-1)).toEqual(['updatePosition', 1110, 600, 'right']);
    stop();
  });

  it('suspends in the Exchange, goes live on its roof, and suspends again on the way down', async () => {
    const { world, made, presence, stop } = await connectedOnStreet();

    world.emit('building:entered', { building: 'exchange' });
    expect(made.calls).toEqual([['suspend']]);
    expect(presence.getState().status).toBe('suspended');

    world.emit('area:moved', roofArrival);
    // Not on the roof yet: the degen floor's lift is still between.
    expect(made.calls).toEqual([['suspend']]);
    world.emit('rooftop:entered', {});
    expect(made.calls.at(-1)).toEqual(['enterArea', 'roof', { x: 1488, y: 272, facing: 'up' }, 'avatar-1']);
    expect(presence.getState().status).toBe('connected');

    world.emit('area:moved', { position: { x: 1460, y: 272 }, facing: 'left' });
    expect(made.calls.at(-1)).toEqual(['updatePosition', 1460, 272, 'left']);

    world.emit('rooftop:exited', {});
    expect(made.calls.at(-1)).toEqual(['suspend']);
    expect(presence.getState().status).toBe('suspended');
    // The degen floor is private: a stray area move sends nothing.
    world.emit('area:moved', roofArrival);
    expect(made.calls.at(-1)).toEqual(['suspend']);

    world.emit('player:moved', street);
    world.emit('building:exited', { building: 'exchange' });
    expect(made.calls.at(-1)).toEqual(['resume', { x: 1400, y: 400, facing: 'up' }, 'avatar-1']);
    expect(presence.getState().status).toBe('connected');
    stop();
  });

  it('resumes the street from the roof when a release skips the roof’s own exit', async () => {
    const { world, made, stop } = await connectedOnStreet();
    world.emit('building:entered', { building: 'exchange' });
    world.emit('area:moved', roofArrival);
    world.emit('rooftop:entered', {});
    world.emit('player:moved', street);
    world.emit('building:exited', { building: 'exchange' });
    expect(made.calls.at(-1)).toEqual(['enterArea', 'street', { x: 1400, y: 400, facing: 'up' }, 'avatar-1']);
    stop();
  });

  it('waits for the roof’s first placement when the announcement comes first', async () => {
    const { world, made, stop } = await connectedOnStreet();
    world.emit('building:entered', { building: 'exchange' });
    world.emit('rooftop:entered', {});
    expect(made.calls).toEqual([['suspend']]);
    world.emit('area:moved', roofArrival);
    expect(made.calls.at(-1)).toEqual(['enterArea', 'roof', { x: 1488, y: 272, facing: 'up' }, 'avatar-1']);
    stop();
  });

  // D-112: the hidden room under the alley (D-107) is shared; every building's interior stays private.
  it.each([...BUILDINGS])('still suspends inside %s, and never switches area there', async (building) => {
    const { world, made, presence, stop } = await connectedOnStreet();
    world.emit('building:entered', { building });
    // Walking about inside a private interior publishes no area moves; even
    // if one arrived, no room was announced.
    world.emit('area:moved', studioSpawn);
    world.emit('avatar:selected', { sprite: 'avatar-9' });
    expect(made.calls).toEqual([['suspend']]);
    expect(made.client.enterArea).not.toHaveBeenCalled();
    expect(presence.getState().status).toBe('suspended');
    world.emit('building:exited', { building });
    expect(made.calls.at(-1)).toEqual(['resume', { x: 1400, y: 400, facing: 'up' }, 'avatar-9']);
    stop();
  });

  it('goes live in the bunker on its door instead of suspending, and straight back to the street up its stair (D-112)', async () => {
    const { world, made, presence, stop } = await connectedOnStreet();
    // As the World emits it: the spawn first, then the door's entry.
    world.emit('area:moved', bunkerSpawn);
    expect(made.calls).toEqual([]);
    world.emit('building:entered', { building: 'bunker' });
    expect(made.calls).toEqual([['enterArea', 'bunker', { x: 144, y: 336, facing: 'up' }, 'avatar-1']]);
    expect(made.client.suspend).not.toHaveBeenCalled();
    expect(presence.getState().status).toBe('connected');

    world.emit('area:moved', { position: { x: 176, y: 336 }, facing: 'right' });
    expect(made.calls.at(-1)).toEqual(['updatePosition', 176, 336, 'right']);
    // A look change is shown to the bunker's other players at once.
    world.emit('avatar:selected', { sprite: 'avatar-4' });
    expect(made.calls.at(-1)).toEqual(['enterArea', 'bunker', { x: 176, y: 336, facing: 'right' }, 'avatar-4']);

    world.emit('player:moved', street);
    expect(made.calls.at(-1)?.[0]).not.toBe('updatePosition');
    world.emit('building:exited', { building: 'bunker' });
    expect(made.calls.at(-1)).toEqual(['enterArea', 'street', { x: 1400, y: 400, facing: 'up' }, 'avatar-4']);
    expect(made.client.suspend).not.toHaveBeenCalled();
    expect(made.client.resume).not.toHaveBeenCalled();
    expect(presence.getState().status).toBe('connected');
    // Back on the street, a stray area move sends nothing.
    world.emit('area:moved', bunkerSpawn);
    expect(made.calls.at(-1)?.[0]).toBe('enterArea');
    world.emit('player:moved', { position: { x: 1410, y: 400 }, facing: 'right' });
    expect(made.calls.at(-1)).toEqual(['updatePosition', 1410, 400, 'right']);
    stop();
  });

  it('suspends in the bunker until its first placement arrives, then goes live there', async () => {
    const { world, made, presence, stop } = await connectedOnStreet();
    world.emit('building:entered', { building: 'bunker' });
    expect(made.calls).toEqual([['suspend']]);
    expect(presence.getState().status).toBe('suspended');
    world.emit('area:moved', bunkerSpawn);
    expect(made.calls.at(-1)).toEqual(['enterArea', 'bunker', { x: 144, y: 336, facing: 'up' }, 'avatar-1']);
    expect(presence.getState().status).toBe('connected');
    stop();
  });

  it('keeps the player solo in the bunker with a client that cannot share', async () => {
    const { world, made, presence, stop } = await connectedOnStreet(false);
    world.emit('area:moved', bunkerSpawn);
    world.emit('building:entered', { building: 'bunker' });
    expect(made.calls).toEqual([['suspend']]);
    expect(presence.getState().status).toBe('suspended');
    world.emit('area:moved', { position: { x: 176, y: 336 }, facing: 'right' });
    expect(made.calls).toEqual([['suspend']]);
    world.emit('building:exited', { building: 'bunker' });
    expect(made.calls.at(-1)).toEqual(['resume', { x: 1400, y: 400, facing: 'up' }, 'avatar-1']);
    stop();
  });

  it('reads the bunker only from an own building field: anything else is a private interior', async () => {
    const { world, made, stop } = await connectedOnStreet();
    world.emit('area:moved', bunkerSpawn);
    let read = false;
    const hostile = {};
    Object.defineProperty(hostile, 'building', { get() { read = true; return 'bunker'; } });
    world.emit('building:entered', hostile as never);
    expect(read).toBe(false);
    expect(made.calls).toEqual([['suspend']]);
    expect(made.client.enterArea).not.toHaveBeenCalled();
    stop();
  });

  it('keeps the player solo in the Studio with a client that cannot share', async () => {
    const { world, made, presence, stop } = await connectedOnStreet(false);
    world.emit('area:moved', studioSpawn);
    world.emit('avatar-studio:entered', {});
    expect(made.calls).toEqual([['suspend']]);
    expect(presence.getState().status).toBe('suspended');
    world.emit('area:moved', { position: { x: 368, y: 140 }, facing: 'down' });
    expect(made.calls).toEqual([['suspend']]);
    world.emit('avatar-studio:exited', {});
    expect(made.calls.at(-1)).toEqual(['resume', { x: 1400, y: 400, facing: 'up' }, 'avatar-1']);
    stop();
  });

  it('ignores malformed area moves without invoking accessors', async () => {
    const { world, made, stop } = await connectedOnStreet();
    world.emit('avatar-studio:entered', {});
    made.calls.length = 0;
    let read = false;
    const hostile = {};
    Object.defineProperty(hostile, 'position', { get() { read = true; throw new Error('read'); } });
    world.emit('area:moved', hostile as never);
    world.emit('area:moved', { position: { x: Number.NaN, y: 1 }, facing: 'down' });
    world.emit('area:moved', { position: { x: 1, y: 1 }, facing: 'sideways' as never });
    expect(read).toBe(false);
    expect(made.calls).toEqual([]);
    stop();
  });

  it('retires a client whose area switch throws, so the Shell can offer a fresh join', async () => {
    const { world, made, presence, stop } = await connectedOnStreet();
    vi.mocked(made.client.enterArea!).mockImplementationOnce(() => {
      throw new Error('transport');
    });
    world.emit('area:moved', studioSpawn);
    // The bus isolates the handler's throw; the controller has retired the client.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.emit('avatar-studio:entered', {});
    expect(presence.getState()).toEqual({ status: 'unavailable', canReconnect: true });
    expect(made.client.disconnect).toHaveBeenCalled();
    stop();
  });
});
