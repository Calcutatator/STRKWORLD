import { describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_AREA,
  type SandboxSnapshot,
  type SandboxTile,
  type WorldEvents,
} from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { createSandboxController, type SandboxLobbyClient } from './sandbox-controller.js';

const X = SANDBOX_AREA.x + 5;
const Y = 14;
const centre = (tileX: number, tileY: number) => ({ x: tileX * 32 + 16, y: tileY * 32 + 16 });

/** Deterministic timers: run the next scheduled callback on demand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (callback: () => void) => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    runNext(): boolean {
      const entry = pending.entries().next().value as [number, () => void] | undefined;
      if (!entry) return false;
      pending.delete(entry[0]);
      entry[1]();
      return true;
    },
    get size() {
      return pending.size;
    },
  };
}

function fakeLobby(initial: SandboxSnapshot = { columns: [], carrying: null }) {
  let status: ((event: { status: string }) => void) | undefined;
  let state: ((snapshot: SandboxSnapshot) => void) | undefined;
  let drops: ((tile: SandboxTile) => void) | undefined;
  const client: SandboxLobbyClient & { picks: SandboxTile[]; places: SandboxTile[] } = {
    picks: [],
    places: [],
    sandbox: () => initial,
    onSandbox: (listener) => {
      state = listener;
      return () => {
        state = undefined;
      };
    },
    onSandboxDrop: (listener) => {
      drops = listener;
      return () => {
        drops = undefined;
      };
    },
    pickBlock(tile) {
      this.picks.push(tile);
    },
    placeBlock(tile) {
      this.places.push(tile);
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
  };
  return {
    client,
    status: (next: string) => status?.({ status: next }),
    publish: (snapshot: SandboxSnapshot) => state?.(snapshot),
    drop: (tile: SandboxTile) => drops?.(tile),
    get listening() {
      return Boolean(state || drops);
    },
  };
}

function setup() {
  const timers = manualTimers();
  let seed = 0;
  const controller = createSandboxController({
    random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const world = createEventBus<WorldEvents>();
  controller.listen(world);
  const snapshots: SandboxSnapshot[] = [];
  const drops: SandboxTile[] = [];
  controller.channel.subscribe((snapshot) => snapshots.push(snapshot));
  controller.channel.subscribeDrops?.((tile) => drops.push(tile));
  const move = (tile: { x: number; y: number }) =>
    world.emit('player:moved', { position: centre(tile.x, tile.y), facing: 'right' });
  return { controller, world, timers, snapshots, drops, move, last: () => snapshots.at(-1)! };
}

describe('sandbox controller (D-060)', () => {
  it('rains blocks locally once the player is on the street, never before', () => {
    const world = setup();
    world.timers.runNext();
    expect(world.drops).toEqual([]);
    world.move({ x: X, y: Y });
    world.timers.runNext();
    expect(world.drops).toHaveLength(1);
    const drop = world.drops[0]!;
    expect(world.last().columns.some((column) => column.x === drop.x && column.y === drop.y)).toBe(true);
    // Never on or next to the player.
    expect(Math.max(Math.abs(drop.x - X), Math.abs(drop.y - Y))).toBeGreaterThan(1);
  });

  it('picks and places locally through the shared rules', () => {
    const world = setup();
    world.move({ x: X, y: Y });
    // Rain until a block lands, then walk next to it.
    for (let i = 0; i < 5; i += 1) world.timers.runNext();
    const target = world.drops[0]!;
    world.move({ x: target.x - 1, y: target.y });
    world.controller.channel.pick(target);
    expect(world.last().carrying).not.toBeNull();
    world.controller.channel.place(target);
    expect(world.last().carrying).toBeNull();
  });

  it('ignores requests while the player is inside a building, and returns what they carry', () => {
    const world = setup();
    world.move({ x: X, y: Y });
    for (let i = 0; i < 5; i += 1) world.timers.runNext();
    const target = world.drops[0]!;
    world.move({ x: target.x - 1, y: target.y });
    const blocks = () => world.last().columns.reduce((sum, column) => sum + column.colours.length, 0);
    const total = blocks();
    world.controller.channel.pick(target);
    expect(world.last().carrying).not.toBeNull();
    const dropsBefore = world.drops.length;
    world.world.emit('building:entered', { building: 'bank' });
    expect(world.last().carrying).toBeNull();
    // Conserved: the block fell back onto the board, away from the player.
    expect(blocks()).toBe(total);
    expect(world.drops.length).toBe(dropsBefore + 1);
    const returned = world.drops.at(-1)!;
    expect(Math.max(Math.abs(returned.x - (target.x - 1)), Math.abs(returned.y - target.y))).toBeGreaterThan(1);
    const before = world.snapshots.length;
    world.controller.channel.pick(target);
    expect(world.snapshots.length).toBe(before);
  });

  it('hands authority to a connected lobby client and back to solo when it closes', () => {
    const world = setup();
    const lobby = fakeLobby({ columns: [{ x: X, y: 1, colours: [2] }], carrying: null });
    expect(world.controller.adopt(lobby.client)).toBe(lobby.client);
    lobby.status('connecting');
    expect(lobby.listening).toBe(false);

    lobby.status('connected');
    expect(world.last()).toEqual({ columns: [{ x: X, y: 1, colours: [2] }], carrying: null });
    world.controller.channel.pick({ x: X, y: 1 });
    world.controller.channel.place({ x: X, y: 2 });
    expect(lobby.client.picks).toEqual([{ x: X, y: 1 }]);
    expect(lobby.client.places).toEqual([{ x: X, y: 2 }]);
    lobby.publish({ columns: [], carrying: 4 });
    expect(world.last().carrying).toBe(4);
    lobby.drop({ x: X, y: 3 });
    expect(world.drops.at(-1)).toEqual({ x: X, y: 3 });

    // The local rain pauses while the lobby is the authority.
    world.move({ x: X, y: Y });
    const dropsBefore = world.drops.length;
    while (world.timers.runNext()) { /* drain */ }
    expect(world.drops.length).toBe(dropsBefore);

    lobby.status('closed');
    expect(lobby.listening).toBe(false);
    expect(world.last().carrying).toBeNull();
    expect(world.timers.size).toBe(1);
  });

  it('keeps raining when a listener throws', () => {
    const world = setup();
    // Subscribing replays the current state; fail only on later changes.
    let replayed = false;
    world.controller.channel.subscribe(() => {
      if (!replayed) {
        replayed = true;
        return;
      }
      throw new Error('view failed');
    });
    world.move({ x: X, y: Y });
    expect(() => world.timers.runNext()).toThrow('view failed');
    // The next drop is still scheduled, and healthy listeners still receive
    // the new stacks even though a neighbour threw.
    expect(world.timers.size).toBe(1);
    const blocksBefore = world.last().columns.length;
    expect(() => world.timers.runNext()).toThrow('view failed');
    expect(world.last().columns.length).toBe(blocksBefore + 1);
    expect(world.timers.size).toBe(1);
  });

  it('does not carry a solo block into the lobby, or back out of it', () => {
    const world = setup();
    world.move({ x: X, y: Y });
    for (let i = 0; i < 5; i += 1) world.timers.runNext();
    const target = world.drops[0]!;
    world.move({ x: target.x - 1, y: target.y });
    world.controller.channel.pick(target);
    expect(world.last().carrying).not.toBeNull();
    const lobby = fakeLobby();
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    lobby.status('closed');
    expect(world.last().carrying).toBeNull();
  });

  it('forgets replaced clients once they have closed', () => {
    const world = setup();
    const first = fakeLobby();
    world.controller.adopt(first.client);
    first.status('connected');
    first.status('closed');
    const second = fakeLobby();
    world.controller.adopt(second.client);
    // The replaced client's status no longer reaches the controller.
    first.status('connected');
    expect(first.listening).toBe(false);
    second.status('connected');
    expect(second.listening).toBe(true);
  });

  it('leaves clients without the sandbox surface alone', () => {
    const world = setup();
    const plain = { onStatus: vi.fn() };
    expect(world.controller.adopt(plain)).toBe(plain);
    expect(plain.onStatus).not.toHaveBeenCalled();
  });

  it('stops everything on destroy', () => {
    const world = setup();
    const lobby = fakeLobby();
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    world.controller.destroy();
    expect(lobby.listening).toBe(false);
    expect(world.timers.size).toBe(0);
    world.controller.channel.pick({ x: X, y: 1 });
    expect(lobby.client.picks).toEqual([]);
  });
});
