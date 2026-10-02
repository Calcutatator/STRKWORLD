// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The title backdrop's lifecycle: one shared backdrop for every title screen,
 * taken over across steps of the way in, and torn down after the last
 * release's grace. The scene itself is a stand-in; node has no WebGL.
 */

interface FakeBackdrop {
  readonly mount: HTMLElement;
  readonly resize: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  ready(): void;
}

const backdrops: FakeBackdrop[] = [];
const build = { fail: false };

vi.mock('./three/title-backdrop.js', () => ({
  prefersReducedMotion: () => false,
  createTitleBackdrop: (options: { mount: HTMLElement; onReady?: () => void }) => {
    if (build.fail) throw new Error('WebGL unavailable');
    const backdrop: FakeBackdrop = {
      mount: options.mount,
      resize: vi.fn(),
      destroy: vi.fn(),
      ready: () => options.onReady?.(),
    };
    backdrops.push(backdrop);
    return backdrop;
  },
}));

async function load() {
  return import('./title.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  backdrops.length = 0;
  build.fail = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the title backdrop (D-115)', () => {
  it('builds after the menu paints, fades in when the first frame is drawn, and reports each status', async () => {
    const title = await load();
    const parent = document.createElement('div');
    const statuses: string[] = [];
    await title.acquireTitleBackdrop(parent, { onStatus: (status) => statuses.push(status) });
    const mount = parent.querySelector<HTMLElement>('[data-title-backdrop]')!;
    expect(mount).not.toBeNull();
    expect(mount.style.opacity).toBe('0');
    expect(backdrops).toHaveLength(0);
    vi.advanceTimersByTime(0);
    expect(backdrops).toHaveLength(1);
    backdrops[0]!.ready();
    expect(mount.style.opacity).toBe('1');
    expect(statuses).toEqual(['loading', 'ready']);
    title.releaseTitleBackdrop();
    vi.advanceTimersByTime(title.TITLE_RELEASE_GRACE_MS);
  });

  it('hands one backdrop from step to step, so the drift carries on', async () => {
    const title = await load();
    const first = document.createElement('div');
    const second = document.createElement('div');
    await title.acquireTitleBackdrop(first);
    vi.advanceTimersByTime(0);
    backdrops[0]!.ready();
    const told: string[] = [];
    // The next step's screen mounts as the last one unmounts.
    title.releaseTitleBackdrop();
    await title.acquireTitleBackdrop(second, { onStatus: (status) => told.push(status) });
    vi.advanceTimersByTime(title.TITLE_RELEASE_GRACE_MS * 2);
    expect(backdrops).toHaveLength(1);
    expect(backdrops[0]!.destroy).not.toHaveBeenCalled();
    expect(second.contains(backdrops[0]!.mount)).toBe(true);
    expect(first.childElementCount).toBe(0);
    expect(backdrops[0]!.resize).toHaveBeenCalled();
    expect(told).toEqual(['ready']);
    expect(title.titleBackdropDebugState()).toEqual({ refCount: 1, alive: true, status: 'ready' });
  });

  it('tears everything down after the last release, when the city takes the page', async () => {
    const title = await load();
    const parent = document.createElement('div');
    await title.acquireTitleBackdrop(parent);
    vi.advanceTimersByTime(0);
    title.releaseTitleBackdrop();
    vi.advanceTimersByTime(title.TITLE_RELEASE_GRACE_MS - 1);
    expect(backdrops[0]!.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(backdrops[0]!.destroy).toHaveBeenCalledOnce();
    expect(parent.childElementCount).toBe(0);
    expect(title.titleBackdropDebugState()).toEqual({ refCount: 0, alive: false, status: null });
  });

  it('never builds a scene once the backdrop has been torn down', async () => {
    const title = await load();
    const parent = document.createElement('div');
    await title.acquireTitleBackdrop(parent);
    title.releaseTitleBackdrop();
    vi.advanceTimersByTime(title.TITLE_RELEASE_GRACE_MS);
    expect(backdrops.every((backdrop) => backdrop.destroy.mock.calls.length === 1)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(backdrops.length).toBeLessThanOrEqual(1);
    expect(parent.childElementCount).toBe(0);
  });

  it('retires an acquire released while the scene module was still loading', async () => {
    const title = await load();
    const parent = document.createElement('div');
    const pending = title.acquireTitleBackdrop(parent);
    title.releaseTitleBackdrop();
    await pending;
    vi.advanceTimersByTime(title.TITLE_RELEASE_GRACE_MS);
    expect(title.titleBackdropDebugState().alive).toBe(false);
  });

  it('falls back to the gradient, and says so, when the scene cannot start', async () => {
    build.fail = true;
    const title = await load();
    const parent = document.createElement('div');
    const statuses: string[] = [];
    await title.acquireTitleBackdrop(parent, { onStatus: (status) => statuses.push(status) });
    vi.advanceTimersByTime(0);
    expect(statuses).toEqual(['loading', 'unavailable']);
    title.releaseTitleBackdrop();
    vi.advanceTimersByTime(title.TITLE_RELEASE_GRACE_MS);
    expect(parent.childElementCount).toBe(0);
  });
});
