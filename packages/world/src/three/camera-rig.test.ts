import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Vector3 } from 'three';
import { createStreetMap } from '../map/street.js';
import { createNullLabelFactory } from './labels.js';
import { buildStreet } from './street-builder.js';
import {
  CAMERA_AIM_HEIGHT,
  CAMERA_DISTANCE,
  CAMERA_FOV,
  CAMERA_PITCH,
  CAMERA_YAW,
  cameraOffset,
  cameraPositionFor,
  createCameraRig,
} from './camera-rig.js';

describe('camera offset', () => {
  it('sits south of the aim point at yaw 0, so north is up the screen', () => {
    const offset = cameraOffset(0, 0.9, 10);
    expect(offset.x).toBeCloseTo(0);
    expect(offset.z).toBeGreaterThan(0);
    expect(offset.y).toBeGreaterThan(0);
    expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(10);
  });
});

describe('camera rig', () => {
  it('looks north at a point above the player from one fixed angle', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 24, z: 15 }, null);
    const aim = new Vector3(24, CAMERA_AIM_HEIGHT, 15);
    expect(camera.position.x).toBeCloseTo(24);
    expect(camera.position.z).toBeGreaterThan(15);
    expect(camera.position.distanceTo(aim)).toBeCloseTo(CAMERA_DISTANCE);
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    expect(forward.dot(aim.clone().sub(camera.position).normalize())).toBeCloseTo(1, 5);
    // Pitched down by the fixed angle, facing due north.
    expect(Math.asin(-forward.y)).toBeCloseTo(CAMERA_PITCH, 5);
    expect(forward.x).toBeCloseTo(0, 5);
    expect(camera.position.toArray()).toEqual(Object.values(cameraPositionFor({ x: 24, z: 15 })));
  });

  it('never turns, tilts or zooms, so W stays north', () => {
    const rig = createCameraRig({ camera: new PerspectiveCamera(CAMERA_FOV) });
    const angle = () => [rig.yaw, rig.pitch, rig.distance];
    const fixed = [CAMERA_YAW, CAMERA_PITCH, CAMERA_DISTANCE];
    expect(angle()).toEqual(fixed);
    for (const [x, z, elevation] of [
      [0, 0, 0],
      [40, 5, 3],
      [70, 20, 12],
    ] as const) {
      rig.update(16, { x, z }, null, elevation);
      rig.snap();
    }
    expect(angle()).toEqual(fixed);
    expect(CAMERA_YAW).toBe(0);
  });

  it('reads no pointer or wheel input: nothing to drag, scroll or bind', () => {
    const source = readFileSync(fileURLToPath(new URL('./camera-rig.ts', import.meta.url)), 'utf8');
    for (const binding of ['addEventListener', "'pointerdown'", "'wheel'", "'contextmenu'", 'setPointerCapture']) {
      expect(source).not.toContain(binding);
    }
  });

  it('eases towards a moving target and jumps after snap', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 0, z: 0 }, null);
    rig.update(16, { x: 10, z: 0 }, null);
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.x).toBeLessThan(10);
    rig.snap();
    rig.update(16, { x: 40, z: 5 }, null);
    expect(camera.position.x).toBeCloseTo(40);
  });

  it('rises with the player on sandbox blocks, so a tall tower stays framed', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 60, z: 12 }, null, 0);
    const ground = camera.position.y;
    rig.snap();
    rig.update(16, { x: 60, z: 12 }, null, 8);
    expect(camera.position.y).toBeCloseTo(ground + 8);
  });

  it('keeps its aim inside the active bounds', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 100, z: -5 }, { minX: 2, maxX: 20, minZ: 2, maxZ: 14 });
    expect(camera.position.x).toBeCloseTo(20);
  });

  it('ignores non-finite targets instead of poisoning the camera', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 3, z: 4 }, null);
    const before = camera.position.clone();
    rig.update(16, { x: Number.NaN, z: 4 }, null);
    expect(camera.position.equals(before)).toBe(true);
    rig.destroy();
    rig.update(16, { x: 30, z: 4 }, null);
    expect(camera.position.equals(before)).toBe(true);
  });
});

describe('fixed camera framing', () => {
  // Every street building, rooftop to kerb, stays in frame while the player
  // walks the pavement and road in front of it, and the player stays in view.
  const view = buildStreet(createStreetMap(), createNullLabelFactory());
  view.ground.updateMatrixWorld(true);
  const tops: { y: number; z: number; building: string }[] = [];
  for (const group of view.ground.children.filter((child) => child.name.startsWith('building:'))) {
    let highest = -Infinity;
    const points: Vector3[] = [];
    group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const position = object.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const vertex = new Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        points.push(vertex);
        highest = Math.max(highest, vertex.y);
      }
    });
    // At yaw 0 a vertex's height on screen depends only on its y and z.
    for (const point of points) tops.push({ y: point.y, z: point.z, building: group.name });
    expect(highest, group.name).toBeGreaterThan(3.5);
  }
  view.dispose();

  it.each([
    ['the north pavement', 11.6],
    ['the north pavement kerb', 12.9],
    ['the road', 15],
    ['the far lane', 16.8],
    ['the south pavement', 18.4],
  ])('shows every rooftop whole from %s (z %d)', (_where, z) => {
    for (const x of [6.5, 15.5, 24.5, 33.5, 42.5]) {
      const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
      const rig = createCameraRig({ camera });
      rig.update(16, { x, z }, null);
      camera.updateMatrixWorld(true);
      let top = -Infinity;
      let worst = '';
      for (const point of tops) {
        const ndc = new Vector3(x, point.y, point.z).project(camera);
        if (ndc.y > top) {
          top = ndc.y;
          worst = point.building;
        }
      }
      expect(top, `${worst} from (${x}, ${z})`).toBeLessThan(0.97);
      // The player stands in the lower half, feet to head in frame.
      const feet = new Vector3(x, 0, z).project(camera).y;
      const head = new Vector3(x, 2, z).project(camera).y;
      expect(feet).toBeGreaterThan(-0.9);
      expect(head).toBeLessThan(0);
    }
  });
});
