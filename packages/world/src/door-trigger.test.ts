import { describe, expect, it } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import { createDoorTrigger, DOOR_REENTRY_HOLD_MS } from './door-trigger.js';
import { ARENA_PIT_DOOR, ARENA_PIT_RETURN } from './map/arena-pit.js';
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
  it('rolls back occupancy when an entry event fails', () => {
    let fail = true;
    const events: Emitted[] = [];
    const bus = {
      emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
        events.push({ event, payload } as Emitted);
        if (fail && event === 'building:entered') throw new Error('entry consumer failed');
      },
    };
    const trigger = createDoorTrigger(map, bus);

    expect(() => trigger.update(doorTile('bank'))).toThrow('entry consumer failed');
    expect(trigger.inside).toBeNull();

    fail = false;
    trigger.update(doorTile('bank'));
    expect(trigger.inside).toBe('bank');
    expect(events).toHaveLength(2);
  });

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

  it('preserves a reentrant door transition from the enter callback', () => {
    const events: Emitted[] = [];
    let trigger!: ReturnType<typeof createDoorTrigger>;
    const bus = {
      emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
        events.push({ event, payload } as Emitted);
        if (
          event === 'building:entered' &&
          (payload as WorldEvents['building:entered']).building === 'bank'
        ) {
          trigger.update(doorTile('post-office'));
        }
      },
    };
    trigger = createDoorTrigger(map, bus);

    trigger.update(doorTile('bank'));

    expect(events).toEqual([
      { event: 'building:entered', payload: { building: 'bank' } },
      { event: 'building:exited', payload: { building: 'bank' } },
      { event: 'building:entered', payload: { building: 'post-office' } },
    ]);
    expect(trigger.inside).toBe('post-office');
  });

  it('treats the opened Vault as any open building: entered, then exited, never locked (D-077)', () => {
    const open = createStreetMap({ vaultOpen: true });
    const vault = open.doors.find((d: DoorZone) => d.building === 'vault')!;
    const bus = fakeBus();
    const trigger = createDoorTrigger(open, bus);

    trigger.update(AWAY);
    trigger.update({ x: vault.x, y: vault.y });
    expect(trigger.inside).toBe('vault');
    trigger.update({ x: vault.x + 1, y: vault.y });
    trigger.update(AWAY);

    expect(bus.events).toEqual([
      { event: 'building:entered', payload: { building: 'vault' } },
      { event: 'building:exited', payload: { building: 'vault' } },
    ]);
    expect(trigger.inside).toBeNull();
    // The default street's Vault is still D-007's locked facade.
    const closed = fakeBus();
    createDoorTrigger(map, closed).update(doorTile('vault'));
    expect(closed.events).toEqual([
      { event: 'building:locked', payload: { building: 'vault', reason: 'coming-soon' } },
    ]);
  });

  it('does not emit a stale entry after an exit callback changes occupancy', () => {
    const events: Emitted[] = [];
    let trigger!: ReturnType<typeof createDoorTrigger>;
    let redirectOnExit = false;
    const bus = {
      emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
        events.push({ event, payload } as Emitted);
        if (redirectOnExit && event === 'building:exited') trigger.update(AWAY);
      },
    };
    trigger = createDoorTrigger(map, bus);

    trigger.update(doorTile('bank'));
    redirectOnExit = true;
    trigger.update(doorTile('post-office'));

    expect(events).toEqual([
      { event: 'building:entered', payload: { building: 'bank' } },
      { event: 'building:exited', payload: { building: 'bank' } },
      { event: 'building:exited', payload: { building: 'post-office' } },
    ]);
    expect(trigger.inside).toBeNull();
  });
});

describe('the re-entry hold after a room exit (D-114, 2026-10-02)', () => {
  const ARCH = { x: ARENA_PIT_DOOR.x, y: ARENA_PIT_DOOR.y };
  const PATH = { x: ARENA_PIT_RETURN.x, y: ARENA_PIT_RETURN.y };

  it('never fires while the player stands where the exit put them, however long', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);
    trigger.update(ARCH);
    expect(trigger.inside).toBe('arena');
    trigger.reset({ holdMs: DOOR_REENTRY_HOLD_MS });
    for (let t = 0; t < 5_000; t += 16) {
      trigger.advance(16);
      trigger.update(PATH);
    }
    expect(bus.events).toEqual([{ event: 'building:entered', payload: { building: 'arena' } }]);
    expect(trigger.inside).toBeNull();
  });

  it('swallows a door reached during the hold until the player steps off it, then enters as usual', () => {
    const bus = fakeBus();
    const trigger = createDoorTrigger(map, bus);
    trigger.reset({ holdMs: DOOR_REENTRY_HOLD_MS });
    trigger.update(PATH);
    // A key held through the handoff carries them straight back onto the arch.
    trigger.advance(DOOR_REENTRY_HOLD_MS - 1);
    trigger.update(ARCH);
    trigger.update({ x: ARCH.x + 1, y: ARCH.y });
    // The hold runs out while they are still on it: it stays shut.
    trigger.advance(1_000);
    trigger.update(ARCH);
    expect(bus.events).toEqual([]);
    expect(trigger.inside).toBeNull();
    // Off it and back on: in, as any door.
    trigger.update(PATH);
    trigger.update(ARCH);
    expect(bus.events).toEqual([{ event: 'building:entered', payload: { building: 'arena' } }]);
    expect(trigger.inside).toBe('arena');
  });

  it('lets a door fire once the hold has run out, and a plain reset holds nothing', () => {
    const held = fakeBus();
    const trigger = createDoorTrigger(map, held);
    trigger.reset({ holdMs: DOOR_REENTRY_HOLD_MS });
    trigger.update(PATH);
    trigger.advance(DOOR_REENTRY_HOLD_MS);
    trigger.update(ARCH);
    expect(held.events).toEqual([{ event: 'building:entered', payload: { building: 'arena' } }]);

    const plain = fakeBus();
    const other = createDoorTrigger(map, plain);
    other.reset();
    other.update(doorTile('bank'));
    expect(plain.events).toEqual([{ event: 'building:entered', payload: { building: 'bank' } }]);
    // Junk holds and frames are ignored.
    for (const junk of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const bus = fakeBus();
      const t = createDoorTrigger(map, bus);
      t.reset({ holdMs: junk });
      t.advance(junk);
      t.update(doorTile('bank'));
      expect(bus.events).toHaveLength(1);
    }
  });
});
