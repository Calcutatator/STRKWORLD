import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';

const games: unknown[] = [];

vi.mock('phaser', () => {
  class Scene {}
  class Game {
    registry = { set: vi.fn() };

    constructor(config: { callbacks?: { preBoot?: (game: Game) => void } }) {
      games.push(this);
      config.callbacks?.preBoot?.(this);
    }

    destroy(): void {}
  }

  return {
    Game,
    Scene,
    WEBGL: 2,
    Scale: { RESIZE: 5, CENTER_BOTH: 1 },
  };
});

function fakeBus(): { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } {
  return {
    out: {
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      clear: vi.fn(),
    },
    in: {
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      clear: vi.fn(),
    },
  };
}

function fakeParent(): HTMLElement {
  const document = {
    createElement: () => ({
      style: {},
      parentNode: null as FakeParent | null,
    }),
  };
  const parent: FakeParent = {
    ownerDocument: document,
    appendChild(node: { parentNode: FakeParent | null }) {
      node.parentNode = parent;
      return node;
    },
    removeChild(node: { parentNode: FakeParent | null }) {
      node.parentNode = null;
      return node;
    },
  };
  return parent as unknown as HTMLElement;
}

interface FakeParent {
  ownerDocument: {
    createElement(): {
      style: Record<string, string>;
      parentNode: FakeParent | null;
    };
  };
  appendChild(node: { parentNode: FakeParent | null }): unknown;
  removeChild(node: { parentNode: FakeParent | null }): unknown;
}

describe('world runtime lazy host ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    games.length = 0;
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('coalesces concurrent first acquires while Phaser is lazy-loading', async () => {
    const { acquireWorld, releaseWorld } = await import('./runtime.js');
    const parent = fakeParent();
    const bus = fakeBus();

    const firstAcquire = acquireWorld(parent, bus);
    const secondAcquire = acquireWorld(parent, bus);
    const [firstGame, secondGame] = await Promise.all([
      firstAcquire,
      secondAcquire,
    ]);

    expect(secondGame).toBe(firstGame);
    expect(games).toHaveLength(1);

    releaseWorld();
    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('retires an acquire released while Phaser is lazy-loading', async () => {
    const { acquireWorld, releaseWorld, worldDebugState } = await import('./runtime.js');
    const acquire = acquireWorld(fakeParent(), fakeBus());

    // The owner can unmount before the lazy Phaser import settles. That
    // release must apply to the late lease rather than becoming a no-op.
    releaseWorld();
    await acquire;

    expect(worldDebugState()).toEqual({ refCount: 0, alive: true });
    await vi.runAllTimersAsync();
    expect(worldDebugState()).toEqual({ refCount: 0, alive: false });
  });
});
