import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';

const sceneBusAtCreate: Array<unknown> = [];

vi.mock('phaser', () => {
  class Scene {}

  class Game {
    registry = new MapRegistry();

    constructor(config: {
      callbacks?: { preBoot?: (game: Game) => void; postBoot?: (game: Game) => void };
      scene?: unknown[];
    }) {
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

describe('world runtime boot ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    sceneBusAtCreate.length = 0;
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('installs the shell bus before a scene is created', async () => {
    const bus = fakeBus();
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld({} as HTMLElement, bus);

    expect(sceneBusAtCreate).toEqual([bus]);
    expect(bus.in.on).toHaveBeenCalledWith('world:stations', expect.any(Function));
    releaseWorld();
  });

  it('binds a replacement world to the current config after complete teardown', async () => {
    const first = fakeBus();
    const second = fakeBus();
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld({} as HTMLElement, first);
    releaseWorld();
    await vi.runAllTimersAsync();
    await acquireWorld({} as HTMLElement, second);

    expect(sceneBusAtCreate.at(-1)).toBe(second);
    expect(second.in.on).toHaveBeenCalledWith('world:stations', expect.any(Function));

    releaseWorld();
    await vi.runAllTimersAsync();
  });
});
