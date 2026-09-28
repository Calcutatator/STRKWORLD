import { describe, expect, it, vi } from 'vitest';
import { Vector3, type PerspectiveCamera, type WebGLRenderer } from 'three';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { EXCHANGE_ROOF_HEIGHT } from '../fixed-room.js';
import { CAMERA_PITCH, ROOFTOP_CAMERA_PITCH } from './camera-rig.js';
import { createWorldEngine, prefersReducedMotion } from './world-engine.js';

/**
 * Engine lifecycle in node (D-059). WebGL does not exist here, so the renderer
 * is a stand-in with the surface the engine touches; everything else — the
 * presenter, builders, session and keyboard — is real.
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

function fakeDom() {
  const win = Object.assign(eventHost(), {
    devicePixelRatio: 2,
    performance: { now: () => 0 },
    setTimeout: vi.fn(),
  });
  const doc = Object.assign(eventHost(), {
    defaultView: win,
    visibilityState: 'visible',
    createElement: () => ({ getContext: () => null, style: {} }),
  });
  const children: unknown[] = [];
  const mount = {
    ownerDocument: doc,
    clientWidth: 800,
    clientHeight: 600,
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
  return { win, doc, mount };
}

function fakeRenderer() {
  const canvas = Object.assign(eventHost(), {
    style: {} as Record<string, string>,
    parentNode: null as unknown,
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: () => false,
  });
  let loop: ((time: number) => void) | null = null;
  const renderer = {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0 },
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
  return {
    renderer,
    canvas,
    frame(time: number) {
      loop?.(time);
    },
    get looping() {
      return loop !== null;
    },
  };
}

function fakeBus() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const bus = {
    out: {
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
      on: () => () => undefined,
      once: () => () => undefined,
      off: () => undefined,
      clear: () => undefined,
    } as unknown as EventBus<WorldEvents>,
    in: {
      emit: () => undefined,
      on: () => () => undefined,
      once: () => () => undefined,
      off: () => undefined,
      clear: () => undefined,
    } as unknown as EventBus<ShellEvents>,
  };
  return { bus, emitted };
}

function start() {
  const dom = fakeDom();
  const gl = fakeRenderer();
  const { bus, emitted } = fakeBus();
  const engine = createWorldEngine({
    mount: dom.mount as unknown as HTMLElement,
    config: bus,
    createRenderer: () => gl.renderer as unknown as WebGLRenderer,
  });
  return { dom, gl, engine, emitted };
}

describe('prefersReducedMotion (D-071)', () => {
  it("reads the window's media query live, and is false wherever it cannot be read", () => {
    let reduce = true;
    const query = vi.fn(() => ({ matches: reduce }));
    const win = { matchMedia: query } as unknown as Window;
    expect(prefersReducedMotion(win)).toBe(true);
    expect(query).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    reduce = false;
    expect(prefersReducedMotion(win)).toBe(false);
    expect(prefersReducedMotion({} as Window)).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => { throw new Error('no media'); } } as unknown as Window)).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: 'yes' }) } as unknown as Window)).toBe(false);
  });
});

describe('world engine lifecycle', () => {
  it('mounts one canvas, sizes it, starts a session and a render loop', () => {
    const world = start();
    expect(world.dom.mount.children).toEqual([world.gl.canvas]);
    expect(world.gl.renderer.setSize).toHaveBeenCalledWith(800, 600, false);
    expect(world.gl.renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(world.gl.looping).toBe(true);
    // The session publishes the spawn placement on construction.
    expect(world.emitted.some(({ event }) => event === 'player:moved')).toBe(true);
    world.engine.destroy();
  });

  it('renders every frame and keeps rendering when a stage throws', () => {
    const world = start();
    world.gl.frame(0);
    world.gl.frame(16);
    expect(world.gl.renderer.render).toHaveBeenCalledTimes(2);
    world.gl.renderer.render.mockImplementationOnce(() => {
      throw new Error('lost context');
    });
    world.gl.frame(32);
    world.gl.frame(48);
    expect(world.gl.renderer.render).toHaveBeenCalledTimes(4);
    // The failure is surfaced asynchronously, once, not rethrown into the loop.
    expect(world.dom.win.setTimeout).toHaveBeenCalledTimes(1);
    world.engine.destroy();
  });

  it('rebinds to a new Shell config without a second canvas or context', () => {
    const world = start();
    const next = fakeBus();
    world.engine.rebind(next.bus);
    expect(world.dom.mount.children).toEqual([world.gl.canvas]);
    expect(next.emitted.some(({ event }) => event === 'player:moved')).toBe(true);
    expect(world.gl.renderer.dispose).not.toHaveBeenCalled();
    world.engine.destroy();
  });

  it('tears down synchronously and completely, once', () => {
    const world = start();
    world.engine.destroy();
    world.engine.destroy();
    expect(world.gl.looping).toBe(false);
    expect(world.gl.renderer.dispose).toHaveBeenCalledOnce();
    expect(world.gl.renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(world.dom.mount.children).toEqual([]);
    expect(world.gl.canvas.count()).toBe(0);
    expect(world.dom.win.count()).toBe(0);
    expect(world.dom.doc.count()).toBe(0);
  });

  it('walks up the Exchange tower on real keys and looks down from its roof', () => {
    const world = start();
    let time = 0;
    world.gl.frame(time);
    const key = (type: 'keydown' | 'keyup', code: string) =>
      world.dom.win.dispatch(type, { code, key: code, repeat: false, target: null, preventDefault: () => undefined });
    // One walking step is 8 px at the engine's 50 ms frame cap.
    const walk = (code: string, frames: number, until: () => boolean = () => false) => {
      key('keydown', code);
      for (let i = 0; i < frames && !until(); i++) world.gl.frame((time += 50));
      key('keyup', code);
      world.gl.frame((time += 50));
    };
    const camera = () => world.gl.renderer.render.mock.calls.at(-1)![1] as PerspectiveCamera;
    const pitch = () => Math.asin(-camera().getWorldDirection(new Vector3()).y);
    const entered = () => world.emitted.some(({ event }) => event === 'building:entered');
    // From the spawn (24, 15) west along the road to the door's middle (x 15),
    // then north through the Exchange door.
    walk('KeyA', 38);
    walk('KeyW', 40, entered);
    expect(entered()).toBe(true);
    expect(pitch()).toBeCloseTo(CAMERA_PITCH, 3);
    // The ground floor: west to the lift's column, north onto its pad.
    walk('KeyA', 30);
    walk('KeyW', 31);
    // The Degen floor: east to the lift up, north onto its pad.
    walk('KeyD', 54);
    expect(pitch()).toBeCloseTo(CAMERA_PITCH, 3);
    walk('KeyW', 31);
    // On the roof: the camera looks steeply down from high over the street.
    expect(pitch()).toBeCloseTo(ROOFTOP_CAMERA_PITCH, 3);
    expect(camera().position.y).toBeGreaterThan(EXCHANGE_ROOF_HEIGHT + 10);
    // One building entered the whole way up; nothing left it.
    expect(world.emitted.filter(({ event }) => event === 'building:entered')).toHaveLength(1);
    expect(world.emitted.filter(({ event }) => event === 'building:exited')).toHaveLength(0);
    world.engine.destroy();
  });

  it('leaves nothing behind when the renderer cannot start', () => {
    const dom = fakeDom();
    const { bus } = fakeBus();
    expect(() => createWorldEngine({
      mount: dom.mount as unknown as HTMLElement,
      config: bus,
      createRenderer: () => {
        throw new Error('WebGL unavailable');
      },
    })).toThrow('WebGL unavailable');
    expect(dom.mount.children).toEqual([]);
    expect(dom.win.count()).toBe(0);
    expect(dom.doc.count()).toBe(0);
  });
});
