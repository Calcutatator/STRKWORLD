import { describe, expect, it, vi } from 'vitest';
import type { WebGLRenderer } from 'three';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { createWorldEngine } from './world-engine.js';

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
