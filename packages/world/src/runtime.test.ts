import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';

const sceneBusAtCreate: Array<unknown> = [];
const sceneBusAtRestart: Array<unknown> = [];
const gameInstances: Array<{
  canvas: { parentNode: unknown };
  domContainer: { parentNode: unknown };
  scale: { parent: unknown; parentIsWindow: boolean; refresh: ReturnType<typeof vi.fn> };
}> = [];

vi.mock('phaser', () => {
  class Scene {}

  class Game {
    registry = new MapRegistry();
    canvas = { parentNode: null as unknown };
    domContainer = { parentNode: null as unknown };
    scale = {
      parent: null as unknown,
      parentIsWindow: false,
      refresh: vi.fn(),
    };
    scene = {
      getScene: vi.fn(() => ({
        scene: {
          restart: vi.fn(() => sceneBusAtRestart.push(this.registry.get('bus'))),
        },
      })),
    };

    constructor(config: {
      parent?: { appendChild(node: unknown): void };
      callbacks?: { preBoot?: (game: Game) => void; postBoot?: (game: Game) => void };
      scene?: unknown[];
    }) {
      config.parent?.appendChild(this.canvas);
      config.parent?.appendChild(this.domContainer);
      this.scale.parent = config.parent ?? null;
      gameInstances.push(this);
      config.callbacks?.preBoot?.(this);
      for (const SceneType of config.scene ?? []) {
        const scene = new (SceneType as new () => unknown)() as unknown as {
          game: Game;
          resolveBus(): unknown;
          createFixedRooms(): void;
        };
        scene.game = this;
        // Invoke the real StreetScene seam after Phaser has assigned its
        // Game. This is the same registry lookup used by createFixedRooms().
        sceneBusAtCreate.push(scene.resolveBus());
        scene.createFixedRooms();
      }
      config.callbacks?.postBoot?.(this);
    }

    destroy(): void {}
  }

  return {
    Game,
    Scene,
    WEBGL: 1,
    Scale: { RESIZE: 1, CENTER_BOTH: 1 },
  };
});

class MapRegistry {
  private values = new Map<string, unknown>();
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  get(key: string): unknown {
    return this.values.get(key);
  }
}

function fakeBus(): { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } {
  return {
    out: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), clear: vi.fn() },
    in: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), clear: vi.fn() },
  };
}

function fakeParent(name: string): HTMLElement & { readonly name: string; children: unknown[] } {
  const parent = {
    name,
    children: [] as unknown[],
    ownerDocument: { body: {} },
    appendChild(node: { parentNode?: { removeChild(child: unknown): void } | null }) {
      node.parentNode?.removeChild(node);
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    removeChild(node: { parentNode?: unknown }) {
      this.children = this.children.filter((child) => child !== node);
      node.parentNode = null;
      return node;
    },
  };
  return parent as unknown as HTMLElement & { readonly name: string; children: unknown[] };
}

describe('world runtime boot ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    sceneBusAtCreate.length = 0;
    sceneBusAtRestart.length = 0;
    gameInstances.length = 0;
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('installs the shell bus before a scene is created', async () => {
    const bus = fakeBus();
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(fakeParent('first-wallet-tree'), bus);

    expect(sceneBusAtCreate).toEqual([bus]);
    expect(bus.in.on).toHaveBeenCalledWith('world:stations', expect.any(Function));
    releaseWorld();
  });

  it('binds a replacement world to the current config after complete teardown', async () => {
    const first = fakeBus();
    const second = fakeBus();
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(fakeParent('first-wallet-tree'), first);
    releaseWorld();
    await vi.runAllTimersAsync();
    await acquireWorld(fakeParent('replacement-wallet-tree'), second);

    expect(sceneBusAtCreate.at(-1)).toBe(second);
    expect(second.in.on).toHaveBeenCalledWith('world:stations', expect.any(Function));

    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('rebinds a retained world to a new host and config before deferred teardown', async () => {
    const first = fakeBus();
    const second = fakeBus();
    const firstParent = fakeParent('old-wallet-tree');
    const secondParent = fakeParent('new-wallet-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    const firstGame = await acquireWorld(firstParent, first);
    releaseWorld();
    const secondGame = await acquireWorld(secondParent, second);

    expect(secondGame).toBe(firstGame);
    expect(gameInstances).toHaveLength(1);
    expect(firstParent.children).not.toContain(gameInstances[0]?.canvas);
    expect(secondParent.children).toContain(gameInstances[0]?.canvas);
    expect(gameInstances[0]?.scale.parent).toBe(secondParent);
    expect(gameInstances[0]?.scale.refresh).toHaveBeenCalledOnce();
    expect(sceneBusAtRestart).toEqual([second]);

    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('keeps a same-owner StrictMode remount on the current scene cycle', async () => {
    const bus = fakeBus();
    const parent = fakeParent('same-wallet-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    const firstGame = await acquireWorld(parent, bus);
    releaseWorld();
    const secondGame = await acquireWorld(parent, bus);

    expect(secondGame).toBe(firstGame);
    expect(gameInstances).toHaveLength(1);
    expect(sceneBusAtRestart).toEqual([]);
    expect(gameInstances[0]?.scale.refresh).not.toHaveBeenCalled();

    releaseWorld();
    await vi.runAllTimersAsync();
  });
});
