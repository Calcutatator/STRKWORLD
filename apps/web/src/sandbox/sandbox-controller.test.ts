import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_AREA,
  SANDBOX_BURST_HEIGHT,
  SANDBOX_ENTRANCE,
  type SandboxSnapshot,
  type SandboxTile,
  type WorldEvents,
} from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { attachDebugTap, type DebugTap } from '../debug/debug-tap.js';
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

function fakeLobby(initial: SandboxSnapshot = { columns: [], carrying: null }, options: { bursts?: boolean } = {}) {
  let status: ((event: { status: string }) => void) | undefined;
  let state: ((snapshot: SandboxSnapshot) => void) | undefined;
  let drops: ((tile: SandboxTile) => void) | undefined;
  let bursts: ((tile: SandboxTile) => void) | undefined;
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
    ...(options.bursts === false
      ? {}
      : {
        onSandboxBurst: (listener: (tile: SandboxTile) => void) => {
          bursts = listener;
          return () => {
            bursts = undefined;
          };
        },
      }),
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
    burst: (tile: SandboxTile) => bursts?.(tile),
    get listening() {
      return Boolean(state || drops || bursts);
    },
  };
}

function setup(random?: () => number) {
  const timers = manualTimers();
  let seed = 0;
  const controller = createSandboxController({
    random: random ?? (() => ((seed = (seed * 9301 + 49297) % 233280) / 233280)),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const world = createEventBus<WorldEvents>();
  controller.listen(world);
  const snapshots: SandboxSnapshot[] = [];
  const drops: SandboxTile[] = [];
  const bursts: SandboxTile[] = [];
  /** Snapshots and hints in the order they reached the World. */
  const order: string[] = [];
  controller.channel.subscribe((snapshot) => {
    snapshots.push(snapshot);
    order.push(`state ${snapshot.columns.length}`);
  });
  controller.channel.subscribeDrops?.((tile) => {
    drops.push(tile);
    order.push(`drop ${tile.x},${tile.y}`);
  });
  controller.channel.subscribeBursts?.((tile) => {
    bursts.push(tile);
    order.push(`burst ${tile.x},${tile.y}`);
  });
  const move = (tile: { x: number; y: number }) =>
    world.emit('player:moved', { position: centre(tile.x, tile.y), facing: 'right' });
  return { controller, world, timers, snapshots, drops, bursts, order, move, last: () => snapshots.at(-1)! };
}

/**
 * A random source that drops solo spawns on `targets`, in order, while the
 * player stands on `standing`: each spawn's tile draw indexes the open tiles
 * in `(y, x)` order (the area minus the entrance and the player's 3x3), and
 * its colour draw is 0.5.
 */
function rainOnto(targets: readonly SandboxTile[], standing: SandboxTile): () => number {
  const open: SandboxTile[] = [];
  for (let y = SANDBOX_AREA.y; y < SANDBOX_AREA.y + SANDBOX_AREA.height; y += 1) {
    for (let x = SANDBOX_AREA.x; x < SANDBOX_AREA.x + SANDBOX_AREA.width; x += 1) {
      const entrance = x >= SANDBOX_ENTRANCE.x && x < SANDBOX_ENTRANCE.x + SANDBOX_ENTRANCE.width &&
        y >= SANDBOX_ENTRANCE.y && y < SANDBOX_ENTRANCE.y + SANDBOX_ENTRANCE.height;
      const beside = Math.max(Math.abs(x - standing.x), Math.abs(y - standing.y)) <= 1;
      if (!entrance && !beside) open.push({ x, y });
    }
  }
  const draws = targets.flatMap((tile) => {
    const index = open.findIndex((candidate) => candidate.x === tile.x && candidate.y === tile.y);
    if (index < 0) throw new Error(`tile ${tile.x},${tile.y} is not open`);
    return [(index + 0.5) / open.length, 0.5];
  });
  return () => draws.shift() ?? 0.5;
}

afterEach(() => {
  attachDebugTap(null);
});

/** A debug tap that records only sandbox bursts. */
function tapBursts(): ReturnType<typeof vi.fn> {
  const sandboxBurst = vi.fn();
  const ignore = () => undefined;
  const tap: DebugTap = { failure: ignore, connectState: ignore, walletSession: ignore, visit: ignore, bank: ignore, sandboxBurst, gate: ignore };
  attachDebugTap(tap);
  return sandboxBurst;
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

  it('relays a lobby burst to the World and the debug log, before the lobby state that empties the board (D-071)', () => {
    const tap = tapBursts();
    const world = setup();
    const lobby = fakeLobby({ columns: [{ x: X, y: 1, colours: [2] }], carrying: null });
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    world.order.length = 0;
    lobby.burst({ x: X, y: 1 });
    lobby.publish({ columns: [], carrying: null });
    expect(world.order).toEqual([`burst ${X},1`, 'state 0']);
    expect(world.bursts).toEqual([{ x: X, y: 1 }]);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledWith({ x: X, y: 1 });

    // A closed client's late burst reaches nobody.
    lobby.status('closed');
    lobby.burst({ x: X, y: 2 });
    expect(world.bursts).toHaveLength(1);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('still adopts a lobby client without bursts: its blocks go with the state', () => {
    const world = setup();
    const lobby = fakeLobby({ columns: [{ x: X, y: 1, colours: [2] }], carrying: null }, { bursts: false });
    world.controller.adopt(lobby.client);
    lobby.status('connected');
    expect(world.last().columns).toEqual([{ x: X, y: 1, colours: [2] }]);
    lobby.publish({ columns: [], carrying: null });
    expect(world.last().columns).toEqual([]);
    expect(world.bursts).toEqual([]);
  });

  it('bursts solo when the rain lands on a full column: the burst, then the empty board (D-071)', () => {
    const tap = tapBursts();
    const pillar = { x: SANDBOX_AREA.x, y: SANDBOX_AREA.y };
    // A draw of 0 drops every block on the first open tile.
    const world = setup(() => 0);
    world.move({ x: X, y: Y });
    for (let n = 0; n < SANDBOX_BURST_HEIGHT; n += 1) world.timers.runNext();
    expect(world.last().columns).toEqual([{ ...pillar, colours: Array.from({ length: SANDBOX_BURST_HEIGHT }, () => 0) }]);
    world.order.length = 0;

    world.timers.runNext();

    expect(world.order).toEqual([`burst ${pillar.x},${pillar.y}`, 'state 0']);
    expect(world.drops).toHaveLength(SANDBOX_BURST_HEIGHT);
    expect(world.last()).toEqual({ columns: [], carrying: null });
    expect(tap).toHaveBeenCalledWith(pillar);
    // The rain goes on over the empty square.
    expect(world.timers.size).toBe(1);
  });

  it('bursts solo when the player places a 15th block, and ends empty-handed', () => {
    const stand = { x: 61, y: 11 };
    const column = { x: 62, y: 11 };
    const supply = { x: 61, y: 10 };
    const far = { x: 80, y: 26 };
    const targets = [
      ...Array.from({ length: SANDBOX_BURST_HEIGHT - 1 }, () => stand),
      ...Array.from({ length: SANDBOX_BURST_HEIGHT }, () => column),
      ...Array.from({ length: SANDBOX_BURST_HEIGHT - 1 }, () => supply),
    ];
    const world = setup(rainOnto(targets, far));
    world.move(far);
    for (let n = 0; n < targets.length; n += 1) world.timers.runNext();
    world.move(stand);
    world.controller.channel.pick(supply);
    expect(world.last().carrying).not.toBeNull();
    world.order.length = 0;

    world.controller.channel.place(column);

    expect(world.order).toEqual([`burst ${column.x},${column.y}`, 'state 0']);
    expect(world.last()).toEqual({ columns: [], carrying: null });
  });

  it('publishes the empty board even when a burst listener throws', () => {
    const world = setup(() => 0);
    world.controller.channel.subscribeBursts?.(() => {
      throw new Error('view failed');
    });
    world.move({ x: X, y: Y });
    for (let n = 0; n < SANDBOX_BURST_HEIGHT; n += 1) world.timers.runNext();
    expect(() => world.timers.runNext()).toThrow('view failed');
    expect(world.last()).toEqual({ columns: [], carrying: null });
    expect(world.timers.size).toBe(1);
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
