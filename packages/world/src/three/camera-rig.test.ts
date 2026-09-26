import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  CAMERA_FOCUS_HEIGHT,
  DEFAULT_CAMERA_DISTANCE,
  MAX_CAMERA_DISTANCE,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_DISTANCE,
  cameraOffset,
  createCameraRig,
  type CameraPointerHost,
} from './camera-rig.js';

type Listener = EventListener;

function fakeElement(): CameraPointerHost & {
  fire(type: string, event: Record<string, unknown>): void;
  count(): number;
  captured: Set<number>;
} {
  const listeners = new Map<string, Set<Listener>>();
  const captured = new Set<number>();
  return {
    captured,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setPointerCapture(id) {
      captured.add(id);
    },
    releasePointerCapture(id) {
      captured.delete(id);
    },
    hasPointerCapture(id) {
      return captured.has(id);
    },
    fire(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event as unknown as Event);
    },
    count() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
  };
}

function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return { type, pointerId: 1, button: 0, clientX: x, clientY: y, ...extra };
}

describe('camera offset', () => {
  it('sits south of the focus at yaw 0, so north is up the screen', () => {
    const offset = cameraOffset(0, 0.9, 10);
    expect(offset.x).toBeCloseTo(0);
    expect(offset.z).toBeGreaterThan(0);
    expect(offset.y).toBeGreaterThan(0);
    expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(10);
  });

  it('orbits to the east at yaw π/2', () => {
    const offset = cameraOffset(Math.PI / 2, 0.9, 10);
    expect(offset.x).toBeGreaterThan(0);
    expect(offset.z).toBeCloseTo(0);
  });
});

describe('camera rig', () => {
  it('looks at the player chest from the default orbit', () => {
    const camera = new PerspectiveCamera();
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 24, z: 15 }, null);
    expect(camera.position.x).toBeCloseTo(24);
    expect(camera.position.z).toBeGreaterThan(15);
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    const toFocus = new Vector3(24, CAMERA_FOCUS_HEIGHT, 15).sub(camera.position).normalize();
    expect(forward.dot(toFocus)).toBeCloseTo(1, 5);
    expect(camera.position.distanceTo(new Vector3(24, CAMERA_FOCUS_HEIGHT, 15))).toBeCloseTo(DEFAULT_CAMERA_DISTANCE);
  });

  it('eases towards a moving target and jumps after snap', () => {
    const camera = new PerspectiveCamera();
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 0, z: 0 }, null);
    rig.update(16, { x: 10, z: 0 }, null);
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.x).toBeLessThan(10);
    rig.snap();
    rig.update(16, { x: 40, z: 5 }, null);
    expect(camera.position.x).toBeCloseTo(40);
  });

  it('keeps its focus inside the active bounds', () => {
    const camera = new PerspectiveCamera();
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 100, z: -5 }, { minX: 2, maxX: 20, minZ: 2, maxZ: 14 });
    expect(camera.position.x).toBeCloseTo(20);
  });

  it('ignores non-finite targets instead of poisoning the camera', () => {
    const camera = new PerspectiveCamera();
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 3, z: 4 }, null);
    const before = camera.position.clone();
    rig.update(16, { x: Number.NaN, z: 4 }, null);
    expect(camera.position.equals(before)).toBe(true);
  });

  it('orbits on drag, clamps pitch, and never changes yaw on its own', () => {
    const element = fakeElement();
    const rig = createCameraRig({ camera: new PerspectiveCamera(), element });
    element.fire('pointerdown', pointer('pointerdown', 100, 100));
    expect(element.captured.has(1)).toBe(true);
    element.fire('pointermove', pointer('pointermove', 150, 100));
    expect(rig.yaw).toBeLessThan(0);
    element.fire('pointermove', pointer('pointermove', 150, 5000));
    expect(rig.pitch).toBe(MAX_CAMERA_PITCH);
    element.fire('pointerup', pointer('pointerup', 150, 5000));
    expect(element.captured.has(1)).toBe(false);
    const yaw = rig.yaw;
    rig.snap();
    rig.update(16, { x: 1, z: 1 }, null);
    expect(rig.yaw).toBe(yaw);
  });

  it('zooms with the wheel within limits and blocks page scroll', () => {
    const element = fakeElement();
    const rig = createCameraRig({ camera: new PerspectiveCamera(), element });
    const preventDefault = vi.fn();
    element.fire('wheel', { deltaY: 100_000, preventDefault });
    expect(rig.distance).toBe(MAX_CAMERA_DISTANCE);
    element.fire('wheel', { deltaY: -100_000, preventDefault });
    expect(rig.distance).toBe(MIN_CAMERA_DISTANCE);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it('drops an active drag and ignores input while the World does not own it', () => {
    const element = fakeElement();
    const rig = createCameraRig({ camera: new PerspectiveCamera(), element });
    element.fire('pointerdown', pointer('pointerdown', 0, 0));
    rig.setInputEnabled(false);
    expect(element.captured.size).toBe(0);
    element.fire('pointermove', pointer('pointermove', 400, 0));
    expect(rig.yaw).toBe(0);
    element.fire('pointerdown', pointer('pointerdown', 0, 0));
    element.fire('pointermove', pointer('pointermove', 400, 0));
    expect(rig.yaw).toBe(0);
    const preventDefault = vi.fn();
    element.fire('wheel', { deltaY: 500, preventDefault });
    expect(rig.distance).toBe(DEFAULT_CAMERA_DISTANCE);
  });

  it('removes every listener on destroy', () => {
    const element = fakeElement();
    const rig = createCameraRig({ camera: new PerspectiveCamera(), element });
    expect(element.count()).toBeGreaterThan(0);
    rig.destroy();
    rig.destroy();
    expect(element.count()).toBe(0);
  });
});
