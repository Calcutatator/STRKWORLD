import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';

interface FakeElement {
  parentNode: FakeElement | null;
  children: unknown[];
  style: Record<string, string>;
  appendChild(node: unknown): unknown;
  removeChild(node: unknown): unknown;
}

interface FakeEngine {
  readonly mount: FakeElement;
  readonly canvas: { parentNode: unknown };
  readonly configs: unknown[];
  readonly resize: ReturnType<typeof vi.fn>;
  readonly rebind: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
}

const engines: FakeEngine[] = [];
const engineStart = { fail: false };

vi.mock('./three/world-engine.js', () => ({
  createWorldEngine: (options: { mount: FakeElement; config: unknown }) => {
    if (engineStart.fail) throw new Error('WebGL unavailable');
    const canvas = { parentNode: null as unknown };
    options.mount.appendChild(canvas);
    const engine: FakeEngine = {
      mount: options.mount,
      canvas,
      configs: [options.config],
      resize: vi.fn(),
      rebind: vi.fn((config: unknown) => {
        engine.configs.push(config);
      }),
      destroy: vi.fn(),
    };
    engines.push(engine);
    return engine;
  },
}));

function fakeBus(): { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } {
  return {
    out: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), clear: vi.fn() },
    in: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), clear: vi.fn() },
  };
}

function fakeElement(): FakeElement {
  return {
    parentNode: null,
    children: [],
    style: {},
    appendChild(node: { parentNode?: FakeElement | null }) {
      node.parentNode?.removeChild(node);
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    removeChild(node: { parentNode?: FakeElement | null }) {
      this.children = this.children.filter((child) => child !== node);
      node.parentNode = null;
      return node;
    },
  };
}

function fakeParent(name: string): HTMLElement & FakeElement & { readonly name: string } {
  const parent = Object.assign(fakeElement(), {
    name,
    ownerDocument: { createElement: () => fakeElement() },
  });
  return parent as unknown as HTMLElement & FakeElement & { readonly name: string };
}

describe('world runtime boot ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    engines.length = 0;
    engineStart.fail = false;
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('starts the engine with the shell bus inside a stable World-owned mount', async () => {
    const bus = fakeBus();
    const parent = fakeParent('first-wallet-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(parent, bus);

    expect(engines).toHaveLength(1);
    expect(engines[0]?.configs).toEqual([bus]);
    expect(parent.children).toEqual([engines[0]?.mount]);
    expect(engines[0]?.mount.style).toMatchObject({ position: 'absolute', inset: '0' });
    expect(engines[0]?.mount.children).toContain(engines[0]?.canvas);
    releaseWorld();
  });

  it('binds a replacement world to the current config after complete teardown', async () => {
    const first = fakeBus();
    const second = fakeBus();
    const firstParent = fakeParent('first-wallet-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(firstParent, first);
    releaseWorld();
    await vi.runAllTimersAsync();
    await acquireWorld(fakeParent('replacement-wallet-tree'), second);

    expect(engines).toHaveLength(2);
    expect(engines[0]?.destroy).toHaveBeenCalledOnce();
    expect(firstParent.children).toEqual([]);
    expect(engines[1]?.configs).toEqual([second]);

    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('rebinds a retained world to a new host and config before deferred teardown', async () => {
    const first = fakeBus();
    const second = fakeBus();
    const firstParent = fakeParent('old-wallet-tree');
    const secondParent = fakeParent('new-wallet-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(firstParent, first);
    releaseWorld();
    await acquireWorld(secondParent, second);

    expect(engines).toHaveLength(1);
    const engine = engines[0]!;
    expect(firstParent.children).not.toContain(engine.mount);
    expect(secondParent.children).toContain(engine.mount);
    expect(engine.mount.children).toContain(engine.canvas);
    expect(engine.resize).toHaveBeenCalledOnce();
    expect(engine.rebind).toHaveBeenCalledOnce();
    expect(engine.resize.mock.invocationCallOrder[0]).toBeLessThan(
      engine.rebind.mock.invocationCallOrder[0] ?? 0,
    );
    expect(engine.configs).toEqual([first, second]);
    expect(engine.destroy).not.toHaveBeenCalled();

    releaseWorld();
    await vi.runAllTimersAsync();
    expect(engine.destroy).toHaveBeenCalledOnce();
  });

  it('keeps a same-owner StrictMode remount on the current session', async () => {
    const bus = fakeBus();
    const parent = fakeParent('same-wallet-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(parent, bus);
    releaseWorld();
    await acquireWorld(parent, bus);

    expect(engines).toHaveLength(1);
    expect(engines[0]?.rebind).not.toHaveBeenCalled();
    expect(engines[0]?.resize).not.toHaveBeenCalled();
    expect(engines[0]?.destroy).not.toHaveBeenCalled();

    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('treats a changed Vault switch as a new binding, and absent the same as false (D-077)', async () => {
    const bus = fakeBus();
    const parent = fakeParent('vault-tree');
    const { acquireWorld, releaseWorld } = await import('./runtime.js');

    await acquireWorld(parent, bus);
    releaseWorld();
    await acquireWorld(parent, { ...bus, vaultOpen: false });
    expect(engines[0]?.rebind).not.toHaveBeenCalled();

    releaseWorld();
    const opened = { ...bus, vaultOpen: true };
    await acquireWorld(parent, opened);
    expect(engines).toHaveLength(1);
    expect(engines[0]?.rebind).toHaveBeenCalledOnce();
    expect(engines[0]?.configs).toEqual([bus, opened]);

    // The same switch again is the same binding.
    releaseWorld();
    await acquireWorld(parent, { ...opened });
    expect(engines[0]?.rebind).toHaveBeenCalledOnce();

    releaseWorld();
    await vi.runAllTimersAsync();
  });

  it('removes the World mount when the engine cannot start', async () => {
    engineStart.fail = true;
    const parent = fakeParent('no-webgl-tree');
    const { acquireWorld } = await import('./runtime.js');

    await expect(acquireWorld(parent, fakeBus())).rejects.toThrow('WebGL unavailable');

    expect(parent.children).toEqual([]);
    expect(engines).toHaveLength(0);
  });

  it('destroys the engine synchronously on deferred teardown and removes its mount', async () => {
    const parent = fakeParent('closing-wallet-tree');
    const { acquireWorld, releaseWorld, worldDebugState } = await import('./runtime.js');

    await acquireWorld(parent, fakeBus());
    releaseWorld();
    expect(engines[0]?.destroy).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    expect(engines[0]?.destroy).toHaveBeenCalledOnce();
    expect(parent.children).toEqual([]);
    expect(worldDebugState()).toEqual({ refCount: 0, alive: false });
  });
});
