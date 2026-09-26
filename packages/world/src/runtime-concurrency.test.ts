import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';

const engines: unknown[] = [];

vi.mock('./three/world-engine.js', () => ({
  createWorldEngine: () => {
    const engine = { rebind: vi.fn(), resize: vi.fn(), destroy: vi.fn() };
    engines.push(engine);
    return engine;
  },
}));

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
    engines.length = 0;
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('coalesces concurrent first acquires while the engine is lazy-loading', async () => {
    const { acquireWorld, releaseWorld, worldDebugState } = await import('./runtime.js');
    const parent = fakeParent();
    const bus = fakeBus();

    await Promise.all([acquireWorld(parent, bus), acquireWorld(parent, bus)]);

    expect(engines).toHaveLength(1);
    expect(worldDebugState()).toEqual({ refCount: 2, alive: true });

    releaseWorld();
    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('retires an acquire released while the engine is lazy-loading', async () => {
    const { acquireWorld, releaseWorld, worldDebugState } = await import('./runtime.js');
    const acquire = acquireWorld(fakeParent(), fakeBus());

    // The owner can unmount before the lazy engine import settles. That
    // release must apply to the late lease rather than becoming a no-op.
    releaseWorld();
    await acquire;

    expect(worldDebugState()).toEqual({ refCount: 0, alive: true });
    await vi.runAllTimersAsync();
    expect(worldDebugState()).toEqual({ refCount: 0, alive: false });
  });
});
