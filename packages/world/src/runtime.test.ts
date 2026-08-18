import { describe, expect, it, vi } from 'vitest';
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
          createBankRoom(): void;
        };
        scene.game = this;
        // Invoke the real StreetScene seam after Phaser has assigned its
        // Game. This is the same registry lookup used by createBankRoom().
        sceneBusAtCreate.push(scene.resolveBus());
        scene.createBankRoom();
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

const fakeBus: { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } = {
  out: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), clear: vi.fn() },
  in: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), clear: vi.fn() },
};

describe('world runtime boot ordering', () => {
  it('installs the shell bus before a scene is created', async () => {
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld({} as HTMLElement, fakeBus);

    expect(sceneBusAtCreate).toEqual([fakeBus]);
    expect(fakeBus.in.on).toHaveBeenCalledWith('world:stations', expect.any(Function));
    releaseWorld();
  });
});
