import { describe, expect, it } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import { createDoorTrigger } from './door-trigger.js';
import { createStreetMap, type DoorZone } from './map/street.js';

/**
 * Headless: the scene reports a tile, the trigger emits onto a fake bus, and we
 * assert against what the bus received. No Phaser, no canvas, no game loop.
 */
type Emitted = { [K in keyof WorldEvents]: { event: K; payload: WorldEvents[K] } }[keyof WorldEvents];

function fakeBus() {
  const events: Emitted[] = [];
  return {
    events,
    emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
      events.push({ event, payload } as Emitted);
    },
  };
}

const map = createStreetMap();

/** A tile that lies inside the given building's door zone. */
function doorTile(building: string): { x: number; y: number } {
  const door = map.doors.find((d: DoorZone) => d.building === building)!;
  return { x: door.x, y: door.y };
}

const AWAY = { x: map.spawn.x, y: map.spawn.y }; // road, not a door

describe('door triggers', () => {
  it('emits building:entered with the right id on entering an unlocked door', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);

    trigger.update(AWAY);
    trigger.update(doorTile('bank'));

    expect(bus.events).toEqual([{ event: 'building:entered', payload: { building: 'bank' } }]);
    expect(trigger.inside).toBe('bank');
  });

  it('emits building:exited with the right id on leaving', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);

    trigger.update(doorTile('exchange'));
    trigger.update(AWAY);

    expect(bus.events).toEqual([
      { event: 'building:entered', payload: { building: 'exchange' } },
      { event: 'building:exited', payload: { building: 'exchange' } },
    ]);
    expect(trigger.inside).toBeNull();
  });

  it('emits building:locked for the Vault and never entered/exited', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);

    trigger.update(doorTile('vault'));
    expect(bus.events).toEqual([
      { event: 'building:locked', payload: { building: 'vault', reason: 'coming-soon' } },
    ]);
    // A locked door was never "inside".
    expect(trigger.inside).toBeNull();

    // Leaving a locked door emits nothing — there was no interior to leave.
    trigger.update(AWAY);
    expect(bus.events).toHaveLength(1);
  });

  it('does not re-emit while moving within the same multi-tile door', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);
    const bank = map.doors.find((d: DoorZone) => d.building === 'bank')!;

    trigger.update({ x: bank.x, y: bank.y });
    trigger.update({ x: bank.x + 1, y: bank.y }); // still inside the 2-wide door

    expect(bus.events).toEqual([{ event: 'building:entered', payload: { building: 'bank' } }]);
  });

  it('emits nothing while away from every door', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);

    trigger.update(AWAY);
    trigger.update({ x: AWAY.x + 1, y: AWAY.y });

    expect(bus.events).toEqual([]);
  });

  it('exits the old building then enters the new when stepping door-to-door', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);

    trigger.update(doorTile('bank'));
    trigger.update(doorTile('post-office'));

    expect(bus.events).toEqual([
      { event: 'building:entered', payload: { building: 'bank' } },
      { event: 'building:exited', payload: { building: 'bank' } },
      { event: 'building:entered', payload: { building: 'post-office' } },
    ]);
  });
});
