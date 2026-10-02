import { describe, expect, it, vi } from 'vitest';
import type { WebGLRenderer } from 'three';
import {
  createTitleBackdrop,
  TITLE_FPS,
  TITLE_MAX_PIXEL_RATIO,
  titleCameraPose,
  type TitleFraming,
} from './title-backdrop.js';

/**
 * The title backdrop in node (D-115). WebGL does not exist here, so the
 * renderer is a stand-in; the street, its builders and the lights are real.
 */

type Listener = (event: unknown) => void;

function eventHost() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    count(): number {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
    dispatch(type: string, event: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

function setup({ reduced = false, dpr = 2 } = {}) {
  const motion = Object.assign(eventHost(), { matches: reduced });
  const win = Object.assign(eventHost(), {
    devicePixelRatio: dpr,
    matchMedia: () => motion,
  });
  const doc = Object.assign(eventHost(), {
    defaultView: win,
    visibilityState: 'visible' as DocumentVisibilityState,
    createElement: () => ({ getContext: () => null, style: {} }),
  });
  const children: unknown[] = [];
  const mount = {
    ownerDocument: doc,
    clientWidth: 1440,
    clientHeight: 900,
    children,
    appendChild(node: { parentNode?: unknown }) {
      children.push(node);
      node.parentNode = mount;
      return node;
    },
    removeChild(node: { parentNode?: unknown }) {
      children.splice(children.indexOf(node), 1);
      node.parentNode = null;
      return node;
    },
  };
  const canvas = { style: {} as Record<string, string>, parentNode: null as unknown, setAttribute: vi.fn() };
  let loop: ((time: number) => void) | null = null;
  const renderer = {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0, autoUpdate: true, needsUpdate: false },
    renderLists: { dispose: vi.fn() },
    outputColorSpace: '',
    toneMapping: 0,
    toneMappingExposure: 1,
    setPixelRatio: vi.fn(),
    setClearColor: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
    setAnimationLoop: vi.fn((callback: ((time: number) => void) | null) => {
      loop = callback;
    }),
  };
  const onReady = vi.fn();
  const backdrop = createTitleBackdrop({
    mount: mount as unknown as HTMLElement,
    onReady,
    createRenderer: () => renderer as unknown as WebGLRenderer,
  });
  return {
    backdrop,
    renderer,
    canvas,
    mount,
    doc,
    win,
    motion,
    onReady,
    frame: (time: number) => loop?.(time),
    get looping() {
      return loop !== null;
    },
  };
}

const framing: TitleFraming = { centre: { x: 40, z: 14 }, sweep: 20 };

describe('the title backdrop scene (D-115)', () => {
  it('draws the real street into one canvas, at a capped pixel ratio', () => {
    const t = setup({ dpr: 3 });
    expect(t.mount.children).toEqual([t.canvas]);
    expect(t.renderer.setPixelRatio).toHaveBeenCalledWith(TITLE_MAX_PIXEL_RATIO);
    expect(t.renderer.setPixelRatio).not.toHaveBeenCalledWith(3);
    expect(t.renderer.setSize).toHaveBeenCalledWith(1440, 900, false);
    // Nothing that casts a shadow moves: one shadow pass, never redrawn.
    expect(t.renderer.shadowMap.autoUpdate).toBe(false);
    expect(t.renderer.shadowMap.needsUpdate).toBe(true);
    t.frame(0);
    const drawn = t.renderer.render.mock.calls.at(-1)![0] as { getObjectByName(name: string): unknown };
    expect(drawn.getObjectByName('sky')).toBeTruthy();
    expect(drawn.getObjectByName('title-clouds')).toBeTruthy();
    t.backdrop.destroy();
  });

  it(`limits itself to ${TITLE_FPS} frames a second and says it is ready after the first`, () => {
    const t = setup();
    expect(t.looping).toBe(true);
    const before = t.renderer.render.mock.calls.length;
    for (let time = 0; time <= 1000; time += 1000 / 120) t.frame(time);
    const drawn = t.renderer.render.mock.calls.length - before;
    expect(drawn).toBeGreaterThanOrEqual(TITLE_FPS - 1);
    expect(drawn).toBeLessThanOrEqual(TITLE_FPS + 1);
    expect(t.onReady).toHaveBeenCalledOnce();
    t.backdrop.destroy();
  });

  it('stops while the tab is hidden and picks up when it is back', () => {
    const t = setup();
    t.doc.visibilityState = 'hidden';
    t.doc.dispatch('visibilitychange', {});
    expect(t.looping).toBe(false);
    t.doc.visibilityState = 'visible';
    t.doc.dispatch('visibilitychange', {});
    expect(t.looping).toBe(true);
    t.backdrop.destroy();
  });

  it('holds one still frame for a player who prefers reduced motion', () => {
    const t = setup({ reduced: true });
    expect(t.looping).toBe(false);
    expect(t.renderer.render).toHaveBeenCalled();
    expect(t.onReady).toHaveBeenCalledOnce();
    // Turning motion back on starts the drift; turning it off stops it.
    t.motion.matches = false;
    t.motion.dispatch('change', {});
    expect(t.looping).toBe(true);
    t.motion.matches = true;
    t.motion.dispatch('change', {});
    expect(t.looping).toBe(false);
    t.backdrop.destroy();
  });

  it('frees the GPU and leaves nothing behind, once', () => {
    const t = setup();
    t.frame(0);
    t.backdrop.destroy();
    t.backdrop.destroy();
    expect(t.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(t.renderer.renderLists.dispose).toHaveBeenCalledOnce();
    expect(t.renderer.dispose).toHaveBeenCalledOnce();
    expect(t.renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(t.mount.children).toEqual([]);
    expect(t.doc.count()).toBe(0);
    expect(t.motion.count()).toBe(0);
  });
});

describe('titleCameraPose', () => {
  it('drifts slowly along the street, high and looking down', () => {
    const start = titleCameraPose(framing, 0, false);
    const later = titleCameraPose(framing, 20_000, false);
    expect(later.target.x).not.toBeCloseTo(start.target.x, 1);
    expect(start.position.y).toBeGreaterThan(20);
    expect(start.position.y).toBeGreaterThan(start.target.y);
    // A second of drift moves the aim by well under a world unit.
    const next = titleCameraPose(framing, 1000, false);
    expect(Math.abs(next.target.x - start.target.x)).toBeLessThan(1);
  });

  it('stands still for reduced motion', () => {
    const a = titleCameraPose(framing, 0, true);
    const b = titleCameraPose(framing, 50_000, true);
    expect(b.position.toArray()).toEqual(a.position.toArray());
    expect(b.target.toArray()).toEqual(a.target.toArray());
  });

  it('pulls back for a tall frame', () => {
    const wide = titleCameraPose(framing, 0, true);
    const tall = titleCameraPose({ ...framing, pullBack: 1.2 }, 0, true);
    expect(tall.position.distanceTo(tall.target)).toBeCloseTo(wide.position.distanceTo(wide.target) * 1.2, 5);
  });
});
