import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three';
import { STREET_ORIGIN_X } from '@strkworld/shared';
import { EXCHANGE_ROOF_HEIGHT, EXCHANGE_ROOF_LEVEL, createFixedRoomLevel } from '../fixed-room.js';
import { createStreetMap } from '../map/street.js';
import { createNullLabelFactory } from './labels.js';
import { buildStreet } from './street-builder.js';
import {
  CAMERA_AIM_HEIGHT,
  CAMERA_DISTANCE,
  CAMERA_FOV,
  CAMERA_PITCH,
  CAMERA_PRESETS,
  CAMERA_YAW,
  ROOFTOP_CAMERA_AIM_HEIGHT,
  ROOFTOP_CAMERA_DISTANCE,
  ROOFTOP_CAMERA_PITCH,
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

  it('never turns, tilts or zooms on its own, so W stays north', () => {
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
    // Each place has one angle; only the preset changes it, and never the yaw.
    rig.update(16, { x: 15, z: 8 }, null, EXCHANGE_ROOF_HEIGHT, 'rooftop');
    expect(angle()).toEqual([CAMERA_YAW, ROOFTOP_CAMERA_PITCH, ROOFTOP_CAMERA_DISTANCE]);
    rig.update(16, { x: 16, z: 9 }, null, EXCHANGE_ROOF_HEIGHT, 'rooftop');
    expect(angle()).toEqual([CAMERA_YAW, ROOFTOP_CAMERA_PITCH, ROOFTOP_CAMERA_DISTANCE]);
  });

  it('looks steeply down from the roof, still facing north, and jumps when the place changes', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 15.5, z: 12 }, null);
    expect(rig.preset).toBe('street');
    // Riding up: the first frame on the roof is already there, not an ease.
    rig.update(16, { x: 17.5, z: 8.5 }, null, EXCHANGE_ROOF_HEIGHT, 'rooftop');
    expect(rig.preset).toBe('rooftop');
    expect(camera.position.toArray()).toEqual(Object.values(cameraPositionFor({ x: 17.5, z: 8.5 }, EXCHANGE_ROOF_HEIGHT, 'rooftop')));
    const forward = camera.getWorldDirection(new Vector3());
    expect(Math.asin(-forward.y)).toBeCloseTo(ROOFTOP_CAMERA_PITCH, 5);
    expect(ROOFTOP_CAMERA_PITCH).toBeGreaterThan((70 * Math.PI) / 180);
    expect(forward.x).toBeCloseTo(0, 5);
    expect(forward.z).toBeLessThan(0);
    // Aimed at the player's chest on the deck, from above it.
    const aim = new Vector3(17.5, EXCHANGE_ROOF_HEIGHT + ROOFTOP_CAMERA_AIM_HEIGHT, 8.5);
    expect(camera.position.distanceTo(aim)).toBeCloseTo(ROOFTOP_CAMERA_DISTANCE);
    expect(camera.position.y).toBeGreaterThan(EXCHANGE_ROOF_HEIGHT + 10);
    // Riding down: back to the level street angle in one frame.
    rig.update(16, { x: 5.5, z: 5.5 }, null, 0, 'street');
    expect(rig.preset).toBe('street');
    expect(camera.position.toArray()).toEqual(Object.values(cameraPositionFor({ x: 5.5, z: 5.5 })));
    // An update that names no preset is on the street.
    rig.update(16, { x: 17.5, z: 8.5 }, null, EXCHANGE_ROOF_HEIGHT, 'rooftop');
    rig.update(16, { x: 17.5, z: 8.5 }, null);
    expect(rig.preset).toBe('street');
    expect(Object.keys(CAMERA_PRESETS)).toEqual(['street', 'rooftop']);
  });

  it('frames the player anywhere on the roof deck, with the street far below in view', () => {
    const roof = createFixedRoomLevel(EXCHANGE_ROOF_LEVEL);
    const origin = roof.rooftop!;
    const bounds = { minX: origin.x, maxX: origin.x + roof.width, minZ: origin.y, maxZ: origin.y + roof.height };
    let streetInView = 0;
    for (let y = 0; y < roof.height; y++) {
      for (let x = 0; x < roof.width; x++) {
        if (roof.tiles[y]![x] === 'wall') continue;
        const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
        const target = { x: origin.x + x + 0.5, z: origin.y + y + 0.5 };
        createCameraRig({ camera }).update(16, target, bounds, EXCHANGE_ROOF_HEIGHT, 'rooftop');
        camera.updateMatrixWorld(true);
        // The player, feet to head, well inside the frame.
        for (const height of [0, 2]) {
          const ndc = new Vector3(target.x, EXCHANGE_ROOF_HEIGHT + height, target.z).project(camera);
          expect(Math.abs(ndc.x)).toBeLessThan(0.5);
          expect(Math.abs(ndc.y)).toBeLessThan(0.6);
        }
        // The whole deck and its ledge.
        for (const [cx, cz] of [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.minX, bounds.maxZ - 0.45], [bounds.maxX, bounds.maxZ - 0.45]] as const) {
          const ndc = new Vector3(cx, EXCHANGE_ROOF_HEIGHT, cz).project(camera);
          expect(Math.abs(ndc.x)).toBeLessThan(1);
          expect(Math.abs(ndc.y)).toBeLessThan(1);
        }
        // And the road far below, straight down past the facade.
        const road = new Vector3(target.x, 0, 15).project(camera);
        if (Math.abs(road.y) < 1 && Math.abs(road.x) < 1 && road.z < 1) streetInView += 1;
      }
    }
    expect(streetInView).toBeGreaterThanOrEqual(15);
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

/**
 * Buildings the framing check exempts, by design: the Exchange is a tower
 * whose top runs out of the street camera's frame. Its signage is still
 * checked, below; every other building stays strictly framed.
 */
const FRAMING_EXEMPT: ReadonlySet<string> = new Set(['building:exchange']);

/** In front of each facade's centre: the street's x 6.5 to 42.5, counted from its first column (D-078). */
const FACADE_CENTRES = [6.5, 15.5, 24.5, 33.5, 42.5].map((x) => STREET_ORIGIN_X + x);

const STREET_SPOTS = [
  ['the north pavement', 11.6],
  ['the north pavement kerb', 12.9],
  ['the road', 15],
  ['the far lane', 16.8],
  ['the south pavement', 18.4],
] as const;

describe('fixed camera framing', () => {
  // Every street building, rooftop to kerb, stays in frame while the player
  // walks the pavement and road in front of it, and the player stays in view.
  const view = buildStreet(createStreetMap(), createNullLabelFactory());
  view.ground.updateMatrixWorld(true);
  const tops: { y: number; z: number; building: string }[] = [];
  const tower: { y: number; z: number }[] = [];
  const highest = new Map<string, number>();
  for (const group of view.ground.children.filter((child) => child.name.startsWith('building:'))) {
    let top = -Infinity;
    const points: Vector3[] = [];
    group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const position = object.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const vertex = new Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        points.push(vertex);
        top = Math.max(top, vertex.y);
      }
    });
    // At yaw 0 a vertex's height on screen depends only on its y and z.
    const exempt = FRAMING_EXEMPT.has(group.name);
    for (const point of points) {
      if (exempt) tower.push({ y: point.y, z: point.z });
      else tops.push({ y: point.y, z: point.z, building: group.name });
    }
    highest.set(group.name, top);
    expect(top, group.name).toBeGreaterThan(3.5);
  }
  // What the Exchange shows the street: its sign, its avnu plate and the LED band.
  const exchangeSign = view.labels.children.find((child) => child.userData['building'] === 'exchange' && !child.userData['lift'])!;
  const exchangePlate = view.labels.children.find((child) => child.userData['brand'] === 'exchange')!;
  const band = view.ground.getObjectByName('building:exchange:podium-ticker') as Mesh;
  const boards = [exchangeSign, exchangePlate].map((board) => {
    const { width, height } = board.userData['options'] as { width: number; height: number };
    return { name: String(board.userData['text']), x: board.position.x, y: board.position.y, z: board.position.z, width, height };
  });
  const bandSize = (band.geometry as PlaneGeometry).parameters;
  boards.push({ name: 'LED band', x: band.position.x, y: band.position.y, z: band.position.z, width: bandSize.width, height: bandSize.height });
  view.dispose();

  it('exempts only the Exchange, the one building taller than the frame', () => {
    expect([...FRAMING_EXEMPT]).toEqual(['building:exchange']);
    expect(highest.size).toBe(5);
    for (const [name, top] of highest) {
      if (FRAMING_EXEMPT.has(name)) expect(top, name).toBeGreaterThan(EXCHANGE_ROOF_HEIGHT);
      else expect(top, name).toBeLessThan(8);
    }
  });

  it.each(STREET_SPOTS)('runs the Exchange tower out of frame from %s (z %d), its sign, plate and LED band whole', (_where, z) => {
    for (const x of FACADE_CENTRES) {
      const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
      createCameraRig({ camera }).update(16, { x, z }, null);
      camera.updateMatrixWorld(true);
      const top = Math.max(...tower.map((point) => new Vector3(x, point.y, point.z).project(camera).y));
      expect(top, `tower from (${x}, ${z})`).toBeGreaterThan(1.5);
    }
    // In front of the tower its street-facing signage is whole in frame.
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
    createCameraRig({ camera }).update(16, { x: STREET_ORIGIN_X + 15.5, z }, null);
    camera.updateMatrixWorld(true);
    for (const board of boards) {
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const ndc = new Vector3(board.x + (dx * board.width) / 2, board.y + (dy * board.height) / 2, board.z).project(camera);
        expect(Math.abs(ndc.x), `${board.name} from z ${z}`).toBeLessThan(1);
        expect(Math.abs(ndc.y), `${board.name} from z ${z}`).toBeLessThan(0.97);
      }
    }
  });

  it.each(STREET_SPOTS)('shows every other rooftop whole from %s (z %d)', (_where, z) => {
    for (const x of FACADE_CENTRES) {
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

describe('a near-eye shot (D-133, amended 2026-10-03)', () => {
  /**
   * A shot with `distance` 0 stands the lens on its focus, which is how the
   * roof swing's ride looks out from the rider's own eye instead of at the
   * back of their head. There is nothing to look *back* at from there, so the
   * rig points the lens out along the shot's own yaw and pitch.
   */
  const shotAt = (yaw: number, pitch: number) => ({ yaw, pitch, distance: 0, aimHeight: 0, cut: true });

  const forwardOf = (camera: PerspectiveCamera): Vector3 =>
    new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

  it('puts the lens exactly on the focus', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 7, z: -3 }, null, 12, 'rooftop', shotAt(Math.PI, 0.3));
    expect(camera.position.x).toBeCloseTo(7, 9);
    expect(camera.position.y).toBeCloseTo(12, 9);
    expect(camera.position.z).toBeCloseTo(-3, 9);
  });

  it('looks out along the shot, not back at what it stands on', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      for (const pitch of [0, 0.26, -0.2]) {
        const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
        createCameraRig({ camera }).update(16, { x: 2, z: 5 }, null, 1, 'street', shotAt(yaw, pitch));
        const forward = forwardOf(camera);
        // The same direction a shot standing back would have looked: the
        // negative of the rig's own offset. Only the standing place changed.
        const back = cameraOffset(yaw, pitch, 1);
        expect(forward.x, `yaw ${yaw} pitch ${pitch}`).toBeCloseTo(-back.x, 6);
        expect(forward.y, `yaw ${yaw} pitch ${pitch}`).toBeCloseTo(-back.y, 6);
        expect(forward.z, `yaw ${yaw} pitch ${pitch}`).toBeCloseTo(-back.z, 6);
      }
    }
  });

  it('is the same heading a shot standing back from the focus gives', () => {
    // The point of the change is the standing place, not the heading: a
    // camera placed along a yaw and pointed at its focus already looks down
    // that yaw. So the ride turns exactly as it did; it just stopped having
    // the A-frame and the rider in the way.
    const near = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
    const far = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
    createCameraRig({ camera: near }).update(16, { x: 0, z: 0 }, null, 2, 'street', shotAt(Math.PI, 0.26));
    createCameraRig({ camera: far }).update(16, { x: 0, z: 0 }, null, 2, 'street', {
      ...shotAt(Math.PI, 0.26),
      distance: 7,
    });
    const a = forwardOf(near);
    const b = forwardOf(far);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.z).toBeCloseTo(b.z, 6);
  });

  it('still aims at the focus for every shot that stands back from it', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
    createCameraRig({ camera }).update(16, { x: 4, z: 9 }, null, 0, 'street', {
      yaw: 0,
      pitch: CAMERA_PITCH,
      distance: CAMERA_DISTANCE,
      aimHeight: CAMERA_AIM_HEIGHT,
      cut: true,
    });
    const forward = forwardOf(camera);
    const toFocus = new Vector3(4 - camera.position.x, CAMERA_AIM_HEIGHT - camera.position.y, 9 - camera.position.z)
      .normalize();
    expect(forward.x).toBeCloseTo(toFocus.x, 6);
    expect(forward.y).toBeCloseTo(toFocus.y, 6);
    expect(forward.z).toBeCloseTo(toFocus.z, 6);
  });

  it('sweeps into one without the heading tumbling on the way', () => {
    // Easing from the preset (eleven units back) to a near-eye shot takes the
    // distance to zero; the heading has to stay sane through every frame of
    // it, or the ride would start with a spin.
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
    const rig = createCameraRig({ camera });
    rig.update(16, { x: 0, z: 0 }, null, 0, 'street');
    const headings: Vector3[] = [];
    for (let frame = 0; frame < 120; frame += 1) {
      rig.update(16, { x: 0, z: 0 }, null, 0, 'street', { yaw: Math.PI, pitch: 0.26, distance: 0, aimHeight: 0 });
      const forward = forwardOf(camera);
      expect(Number.isFinite(forward.x) && Number.isFinite(forward.y) && Number.isFinite(forward.z)).toBe(true);
      headings.push(forward);
    }
    // No frame turns by more than a few degrees from the one before it.
    for (let i = 1; i < headings.length; i += 1) {
      expect(headings[i]!.angleTo(headings[i - 1]!)).toBeLessThan(0.2);
    }
    // And it arrives looking south and a little down.
    const last = headings.at(-1)!;
    expect(last.z).toBeGreaterThan(0.9);
    expect(last.y).toBeLessThan(0);
  });
});
