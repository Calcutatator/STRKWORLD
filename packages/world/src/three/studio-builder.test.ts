import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { AVATAR_STUDIO_DEFINITION, isAvatarStudioSolidAt, studioFigureTargetId } from '../avatar-studio.js';
import { avatarSpriteForFigure } from '../avatar-state.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { createNullLabelFactory } from './labels.js';
import { STUDIO_PAD_TOP, buildAvatarStudio } from './studio-builder.js';
import type { InteriorOccluder } from './room-builder.js';
import type { AvatarFigure, AvatarFigureFactory, AvatarMotion, StudioView } from './types.js';

const OX = ROOM_ORIGIN.x / 32;
const OZ = ROOM_ORIGIN.y / 32;

interface FakeFigure extends AvatarFigure {
  readonly object: Group;
  readonly setLook: Mock<(key: AvatarSpriteKey) => void>;
  readonly update: Mock<(deltaMs: number, motion: AvatarMotion) => void>;
  readonly dispose: Mock<() => void>;
}

function fakeFigures(options: { failAt?: number; failDisposeAt?: readonly number[]; body?: boolean } = {}) {
  const created: FakeFigure[] = [];
  const keys: AvatarSpriteKey[] = [];
  let count = 0;
  const factory: AvatarFigureFactory = (key) => {
    count += 1;
    keys.push(key);
    if (count === options.failAt) throw new Error('construction failed');
    const object = new Group();
    // A stand-in body, for the affordance shells to copy (D-123).
    if (options.body) object.add(new Mesh(new BoxGeometry(0.5, 1.6, 0.3).translate(0, 0.8, 0), new MeshBasicMaterial()));
    const figure: FakeFigure = {
      object,
      look: key,
      setLook: vi.fn<(key: AvatarSpriteKey) => void>(),
      update: vi.fn<(deltaMs: number, motion: AvatarMotion) => void>(),
      dispose: vi.fn<() => void>(),
    };
    if (options.failDisposeAt?.includes(count)) {
      figure.dispose.mockImplementationOnce(() => {
        throw new Error('figure dispose failed');
      });
    }
    created.push(figure);
    return figure;
  };
  return { factory, created, keys };
}

/** D-117's floor rings under the figure in reach; D-123 removed them. */
function floorRings(studio: StudioView): Object3D[] {
  const found: Object3D[] = [];
  studio.group.traverse((child) => child.name.startsWith('studio:highlight-') && found.push(child));
  return found;
}

describe('buildAvatarStudio', () => {
  it('stands one injected avatar on each walk-on pad at the fixed selector centres', () => {
    const { factory, created, keys } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    const figures = AVATAR_STUDIO_DEFINITION.figures;
    // One pad per authored figure: the definition has eight (validateAvatarStudioDefinition).
    expect(figures).toHaveLength(8);
    expect(floorRings(studio)).toEqual([]);
    expect(keys).toEqual(figures.map((figure) => avatarSpriteForFigure(figure.figure)));
    studio.group.updateMatrixWorld(true);
    // Same centres as the 2D layer: (144, 176) ... (528, 272) px.
    const expectedPixels = [
      [144, 176],
      [240, 176],
      [336, 176],
      [432, 176],
      [528, 176],
      [208, 272],
      [368, 272],
      [528, 272],
    ];
    created.forEach((figure, index) => {
      const position = figure.object.getWorldPosition(new Vector3());
      expect(position.x).toBeCloseTo(expectedPixels[index]![0]! / 32);
      expect(position.z).toBeCloseTo(expectedPixels[index]![1]! / 32);
      expect(position.y).toBeCloseTo(STUDIO_PAD_TOP);
      expect(figure.object.rotation.y).toBe(0);
      expect(figure.object.visible).toBe(false);
    });
    studio.dispose();
  });

  it('gives every figure an affordance shell that shimmers, and lights no ring on the floor (D-123)', () => {
    const { factory, created } = fakeFigures({ body: true });
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    const shells = studio.affordances!;
    expect(shells.ids).toEqual(AVATAR_STUDIO_DEFINITION.figures.map((figure) => studioFigureTargetId(figure.figure)));
    expect(shells.mesh.parent).toBe(studio.group);
    for (const id of shells.ids) expect(shells.isUsable(id)).toBe(true);
    // Figure 8's shell stands where figure 8 does, as tall as its body.
    studio.group.updateMatrixWorld(true);
    const slot = shells.mesh.geometry.getAttribute('aSlot');
    const position = shells.mesh.geometry.getAttribute('position');
    const box = new Box3();
    const vertex = new Vector3();
    for (let i = 0; i < slot.count; i++) {
      if (slot.getX(i) === 7) box.expandByPoint(vertex.fromBufferAttribute(position, i).applyMatrix4(shells.mesh.matrixWorld));
    }
    const at = created[7]!.object.getWorldPosition(new Vector3());
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(at.x);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(at.z);
    expect(box.max.y).toBeCloseTo(STUDIO_PAD_TOP + 1.6);
    // The figure in reach glows only once the interaction system chooses it.
    studio.sync({ visible: true, highlightedFigure: 8 });
    expect(floorRings(studio)).toEqual([]);
    shells.focus(studioFigureTargetId(8));
    shells.update(250);
    expect(shells.glowLevel(studioFigureTargetId(8))).toBe(1);
    expect(shells.glowLevel(studioFigureTargetId(1))).toBe(0);
    studio.dispose();
  });

  it('mirrors visibility without touching avatar art', () => {
    const { factory, created } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    // The room itself is hidden until synced visible, like the figures.
    expect(studio.group.visible).toBe(false);

    studio.sync({ visible: true, highlightedFigure: 8 });
    expect(studio.group.visible).toBe(true);
    expect(created.every((figure) => figure.object.visible)).toBe(true);

    studio.sync({ visible: true, highlightedFigure: 99 });
    expect(created.every((figure) => figure.object.visible)).toBe(true);

    studio.sync({ visible: false, highlightedFigure: 1 });
    expect(studio.group.visible).toBe(false);
    expect(created.every((figure) => !figure.object.visible)).toBe(true);

    for (const figure of created) {
      expect(figure.setLook).not.toHaveBeenCalled();
      expect(figure.object.scale.toArray()).toEqual([1, 1, 1]);
    }
    studio.dispose();
  });

  it('rolls back partial visibility when a figure sync fails', () => {
    const { factory, created } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    studio.sync({ visible: true, highlightedFigure: 2 });
    const target = created[3]!.object;
    let visible = target.visible;
    let failNext = true;
    Object.defineProperty(target, 'visible', {
      configurable: true,
      get: () => visible,
      set: (value: boolean) => {
        if (failNext) {
          failNext = false;
          throw new Error('figure visibility failed');
        }
        visible = value;
      },
    });

    expect(() => studio.sync({ visible: false, highlightedFigure: null })).toThrow('figure visibility failed');
    expect(studio.group.visible).toBe(true);
    expect(created.slice(0, 4).every((figure) => figure.object.visible)).toBe(true);
    studio.dispose();
  });

  it('reuses figures across re-entry and makes teardown idempotent with no late resurrection', () => {
    const { factory, created, keys } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    const parent = new Object3D();
    parent.add(studio.group);

    studio.sync({ visible: true, highlightedFigure: 1 });
    studio.sync({ visible: false, highlightedFigure: null });
    studio.sync({ visible: true, highlightedFigure: 8 });
    expect(keys).toHaveLength(8);
    expect(created.every((figure) => figure.object.visible)).toBe(true);

    studio.dispose();
    studio.dispose();
    for (const figure of created) expect(figure.dispose).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);

    const visibility = created.map((figure) => figure.object.visible);
    studio.sync({ visible: false, highlightedFigure: 1 });
    studio.update(16);
    expect(created.map((figure) => figure.object.visible)).toEqual(visibility);
    for (const figure of created) expect(figure.update).not.toHaveBeenCalled();
  });

  it('releases every figure it made when construction fails part-way', () => {
    const { factory, created } = fakeFigures({ failAt: 4 });
    expect(() => buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory())).toThrow(
      'construction failed',
    );
    expect(created).toHaveLength(3);
    for (const figure of created) {
      expect(figure.dispose).toHaveBeenCalledTimes(1);
      expect(figure.object.parent).toBeNull();
    }
  });

  it('attempts every teardown and stays idempotent after one failure', () => {
    const { factory, created } = fakeFigures({ failDisposeAt: [1] });
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    expect(() => studio.dispose()).toThrow('figure dispose failed');
    for (const figure of created) expect(figure.dispose).toHaveBeenCalledTimes(1);
    studio.dispose();
    for (const figure of created) expect(figure.dispose).toHaveBeenCalledTimes(1);
  });

  it('aggregates multiple teardown failures after all attempts', () => {
    const { factory, created } = fakeFigures({ failDisposeAt: [1, 5] });
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    expect(() => studio.dispose()).toThrow(AggregateError);
    for (const figure of created) expect(figure.dispose).toHaveBeenCalledTimes(1);
  });

  it('idles visible figures', () => {
    const { factory, created } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    studio.update(16);
    for (const figure of created) expect(figure.update).not.toHaveBeenCalled();

    studio.sync({ visible: true, highlightedFigure: 3 });
    studio.update(16);
    studio.update(300);
    for (const figure of created) {
      expect(figure.update).toHaveBeenCalledWith(16, { moving: false, sprinting: false });
      expect(figure.update).toHaveBeenCalledWith(250, { moving: false, sprinting: false });
    }
    studio.dispose();
  });

  it('copies the injected room origin at construction', () => {
    const origin = { x: 64, y: 64 };
    const { factory, created } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory(), origin);
    origin.x = 1;
    studio.sync({ visible: true, highlightedFigure: 8 });
    studio.group.updateMatrixWorld(true);
    expect(created[7]!.object.getWorldPosition(new Vector3()).x).toBeCloseTo(528 / 32);
    studio.dispose();
  });

  it('keeps the south wall low, tall walls as occluders, and volumes off the floor', () => {
    const { factory } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    const definition = AVATAR_STUDIO_DEFINITION;
    expect((studio.occluders as readonly InteriorOccluder[]).map((occluder) => occluder.side).sort()).toEqual([
      'east',
      'north',
      'west',
    ]);
    studio.group.updateMatrixWorld(true);
    const southEdge = OZ + definition.height - 1 + 0.01;
    const vertex = new Vector3();
    let tallest = -Infinity;
    studio.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const position = object.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        if (vertex.z > southEdge) tallest = Math.max(tallest, vertex.y);
      }
    });
    expect(tallest).toBeLessThanOrEqual(0.55);
    // Figures stand on their pads by design; everything else stays off walkable tiles.
    const figureRoots = new Set(studio.group.children.filter((child) => child instanceof Group && child.name === ''));
    const walkable = (x: number, z: number) =>
      !isAvatarStudioSolidAt(definition, Math.floor(x - OX), Math.floor(z - OZ));
    expect(findWalkableIntrusions(studio.group, walkable, figureRoots)).toEqual([]);
    studio.dispose();
  });

  it('disposes its own geometry and materials exactly once', () => {
    const { factory } = fakeFigures();
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, factory, createNullLabelFactory());
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    studio.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      materials.add(object.material as Material);
    });
    expect(geometries.size).toBeGreaterThan(5);
    const spies = [...geometries, ...materials].map((value) => vi.spyOn(value, 'dispose'));
    studio.dispose();
    studio.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});

/** See street-builder.test.ts; `skip` roots (the figures) are exempt. */
function findWalkableIntrusions(
  root: Object3D,
  walkable: (x: number, z: number) => boolean,
  skip: ReadonlySet<Object3D>,
): string[] {
  const MIN_Y = 0.15;
  const MAX_Y = 1.9;
  const EPS = 0.04;
  const STEP = 0.1;
  root.updateMatrixWorld(true);
  const found: string[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const p = new Vector3();
  const instance = new Matrix4();
  const world = new Matrix4();
  const skipped = (object: Object3D): boolean => {
    for (let node: Object3D | null = object; node; node = node.parent) if (skip.has(node)) return true;
    return false;
  };
  root.traverse((object) => {
    if (!(object instanceof Mesh) || found.length > 20 || skipped(object)) return;
    const position = object.geometry.getAttribute('position');
    const index = object.geometry.getIndex();
    const triangles = (index ? index.count : position.count) / 3;
    const instances = object instanceof InstancedMesh ? object.count : 1;
    for (let n = 0; n < instances; n++) {
      if (object instanceof InstancedMesh) {
        object.getMatrixAt(n, instance);
        world.multiplyMatrices(object.matrixWorld, instance);
      } else {
        world.copy(object.matrixWorld);
      }
      for (let t = 0; t < triangles; t++) {
        a.fromBufferAttribute(position, index ? index.getX(t * 3) : t * 3).applyMatrix4(world);
        b.fromBufferAttribute(position, index ? index.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(world);
        c.fromBufferAttribute(position, index ? index.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(world);
        if (Math.max(a.y, b.y, c.y) < MIN_Y || Math.min(a.y, b.y, c.y) > MAX_Y) continue;
        const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
        const steps = Math.max(1, Math.ceil(edge / STEP));
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps - i; j++) {
            const u = i / steps;
            const v = j / steps;
            const w = 1 - u - v;
            p.set(a.x * w + b.x * u + c.x * v, a.y * w + b.y * u + c.y * v, a.z * w + b.z * u + c.z * v);
            if (p.y < MIN_Y || p.y > MAX_Y) continue;
            if (
              walkable(p.x - EPS, p.z - EPS) &&
              walkable(p.x + EPS, p.z - EPS) &&
              walkable(p.x - EPS, p.z + EPS) &&
              walkable(p.x + EPS, p.z + EPS)
            ) {
              found.push(`${object.name} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
              return;
            }
          }
        }
      }
    }
  });
  return found;
}
