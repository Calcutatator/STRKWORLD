import { describe, expect, it, vi } from 'vitest';
import {
  Box3,
  BufferGeometry,
  Color,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Texture,
  Vector3,
} from 'three';
import { SANDBOX_AREA } from '@strkworld/shared';
import { createStreetMap, isSolidAt, type DistrictMap } from '../map/street.js';
import { createNullLabelFactory } from './labels.js';
import { AVNU, STRK20, boxGeometry } from './palette.js';
import {
  PAVEMENT_HEIGHT,
  SANDBOX_SIGN_TEXT,
  buildStreet,
  streetSurfaceHeightAt,
  type BuildingOccluder,
} from './street-builder.js';
import type { StreetView } from './types.js';

const PLAN = [
  { building: 'bank', x: 3 },
  { building: 'exchange', x: 12 },
  { building: 'post-office', x: 21 },
  { building: 'bridge', x: 30 },
  { building: 'vault', x: 39 },
] as const;

function build(map: DistrictMap = createStreetMap()): { map: DistrictMap; view: StreetView } {
  return { map, view: buildStreet(map, createNullLabelFactory()) };
}

describe('buildStreet', () => {
  it('splits the district into ground, door and label groups', () => {
    const { view } = build();
    expect(view.ground.children.length).toBeGreaterThan(0);
    expect(view.doors.children).toHaveLength(5);
    // Five facade signs and the sandbox square's sign.
    expect(view.labels.children).toHaveLength(6);
    const names = view.ground.children.map((child) => child.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'street:grass',
        'street:road',
        'street:pavement',
        'street:markings',
        'street:sandbox-floor',
      ]),
    );
    view.dispose();
  });

  it('gives each building one occluder whose bounds match its solid footprint', () => {
    const { map, view } = build();
    const occluders = view.occluders as readonly BuildingOccluder[];
    expect(occluders).toHaveLength(PLAN.length);
    for (const { building, x } of PLAN) {
      const occluder = occluders.find((candidate) => candidate.building === building);
      expect(occluder, building).toBeDefined();
      expect(occluder!.bounds).toMatchObject({ minX: x, maxX: x + 7, minZ: 5, maxZ: 11 });
      expect(occluder!.bounds.height).toBeGreaterThanOrEqual(3.5);
      expect(occluder!.bounds.height).toBeLessThanOrEqual(8);
    }
    // Every solid tile belongs to exactly one occluder footprint.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!isSolidAt(map, x, y)) continue;
        const owners = occluders.filter(
          ({ bounds }) => x >= bounds.minX && x < bounds.maxX && y >= bounds.minZ && y < bounds.maxZ,
        );
        expect(owners, `tile ${x},${y}`).toHaveLength(1);
      }
    }
    view.dispose();
  });

  it('fades only the occluded building and restores its materials exactly', () => {
    const { view } = build();
    const occluders = view.occluders as readonly BuildingOccluder[];
    const bank = occluders.find((occluder) => occluder.building === 'bank')!;
    const exchange = occluders.find((occluder) => occluder.building === 'exchange')!;
    const bankMaterials = materialsOf(bank.object);
    const exchangeMaterials = materialsOf(exchange.object);
    expect(bankMaterials.length).toBeGreaterThan(0);
    for (const material of bankMaterials) expect(exchangeMaterials).not.toContain(material);

    bank.setOpacity(0.3);
    for (const material of bankMaterials) {
      expect(material.opacity).toBeCloseTo(0.3);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
    for (const material of exchangeMaterials) {
      expect(material.opacity).toBe(1);
      expect(material.transparent).toBe(false);
    }

    bank.setOpacity(1);
    for (const material of bankMaterials) {
      expect(material.opacity).toBe(1);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }
    view.dispose();
  });

  it('positions a door portal over each door zone, the Vault marked locked', () => {
    const { map, view } = build();
    view.doors.updateMatrixWorld(true);
    for (const door of map.doors) {
      const portal = view.doors.children.find((child) => child.userData['building'] === door.building);
      expect(portal, door.building).toBeDefined();
      expect(portal!.position.x).toBeCloseTo(door.x + door.width / 2);
      expect(portal!.position.z).toBeGreaterThanOrEqual(door.y);
      expect(portal!.position.z).toBeLessThanOrEqual(door.y + door.height);
      expect(portal!.userData['locked']).toBe(door.locked);
      const box = new Box3().setFromObject(portal!);
      expect(box.min.x).toBeGreaterThanOrEqual(door.x - 0.5);
      expect(box.max.x).toBeLessThanOrEqual(door.x + door.width + 0.5);
      expect(box.min.z).toBeGreaterThanOrEqual(door.y - 0.05);
    }
    expect(map.doors.find((door) => door.building === 'vault')?.locked).toBe(true);
    view.dispose();
  });

  it('mounts a facade sign per exterior label above its door, facing the street', () => {
    const { map, view } = build();
    for (const exterior of map.exteriorLabels) {
      const sign = view.labels.children.find((child) => child.userData['text'] === exterior.text);
      expect(sign, exterior.text).toBeDefined();
      const plan = PLAN.find((entry) => entry.building === exterior.building)!;
      expect(sign!.position.x).toBeGreaterThan(plan.x);
      expect(sign!.position.x).toBeLessThan(plan.x + 7);
      expect(sign!.position.y).toBeGreaterThan(2.3);
      expect(sign!.position.y).toBeLessThan(4.2);
      expect(sign!.position.z).toBeGreaterThan(10.4);
      expect(sign!.position.z).toBeLessThanOrEqual(11.05);
      expect(sign!.rotation.y).toBe(0);
      expect(sign!.userData['kind']).toBe('sign');
      expect(sign!.userData['options']).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    }
    view.dispose();
  });

  it('lays the sandbox square as a flat build plate that the road runs into', () => {
    const { map, view } = build();
    view.ground.updateMatrixWorld(true);
    const plate = new Box3().setFromObject(meshNamed(view.ground, 'street:sandbox-floor'));
    expect(plate.min.x).toBeCloseTo(SANDBOX_AREA.x);
    expect(plate.max.x).toBeCloseTo(SANDBOX_AREA.x + SANDBOX_AREA.width);
    expect(plate.min.z).toBeCloseTo(SANDBOX_AREA.y);
    expect(plate.max.z).toBeCloseTo(SANDBOX_AREA.y + SANDBOX_AREA.height);
    expect(plate.max.y).toBeLessThan(0.02);
    // Road paint runs off the west edge but stops where the road meets the square.
    const paint = new Box3().setFromObject(meshNamed(view.ground, 'street:markings'));
    expect(paint.min.x).toBeLessThan(0);
    expect(paint.max.x).toBeLessThanOrEqual(SANDBOX_AREA.x + 1e-6);
    // The west end is closed by a barrier; the east end is open into the square.
    const boards = (x: number) => verticesNear(meshNamed(view.ground, 'street:decor'), (v) =>
      Math.abs(v.x - x) < 0.2 && v.z > 11 && v.z < 19 && v.y > 0.5 && v.y < 0.8,
    );
    expect(boards(-0.6)).toBeGreaterThan(0);
    expect(boards(map.width + 0.6)).toBe(0);
    view.dispose();
  });

  it('hangs the sandbox sign off the map above the north hedge, facing the street', () => {
    const { view } = build();
    const sign = view.labels.children.find((child) => child.userData['area'] === 'sandbox');
    expect(sign).toBeDefined();
    expect(sign!.userData['text']).toBe(SANDBOX_SIGN_TEXT);
    expect(sign!.position.z).toBeLessThan(0);
    expect(sign!.position.x).toBeGreaterThan(SANDBOX_AREA.x);
    expect(sign!.position.x).toBeLessThan(SANDBOX_AREA.x + SANDBOX_AREA.width);
    expect(sign!.position.y).toBeGreaterThan(1);
    expect(sign!.rotation.y).toBe(0);
    view.dispose();
  });

  it('dresses the Bank in STRK20 and the Exchange in avnu', () => {
    const { view } = build();
    const bank = view.ground.getObjectByName('building:bank')!;
    const exchange = view.ground.getObjectByName('building:exchange')!;
    const emissive = (root: Object3D, suffix: string) =>
      (meshNamed(root, suffix).material as MeshStandardMaterial).emissive.getHex();
    expect(emissive(bank, ':glow')).toBe(new Color(STRK20.orange).getHex());
    expect(emissive(exchange, ':lit')).toBe(new Color(AVNU.blue).getHex());
    const portal = (building: string) =>
      view.doors.children.find((child) => child.userData['building'] === building)!;
    expect(emissive(portal('bank'), ':frame')).toBe(new Color(STRK20.orange).getHex());
    expect(emissive(portal('exchange'), ':frame')).toBe(new Color(AVNU.blue).getHex());
    const signOptions = (building: string) =>
      view.labels.children.find((child) => child.userData['building'] === building)!.userData['options'];
    expect(signOptions('bank')).toMatchObject({
      gradient: ['#fffdf1', '#f4ece8', '#ffcdb6'],
      titleFont: 'display',
      subtitleFont: 'mono',
      uppercase: true,
      background: '#141414',
    });
    expect(signOptions('exchange')).toMatchObject({ background: '#1b1e2d', foreground: '#ffffff' });
    view.dispose();
  });

  it('keeps every volume off walkable tiles below head height', () => {
    const { map, view } = build();
    const walkable = (x: number, z: number) => !isSolidAt(map, Math.floor(x), Math.floor(z));
    const found = [
      ...findWalkableIntrusions(view.ground, walkable, map),
      ...findWalkableIntrusions(view.doors, walkable, map),
    ];
    expect(found).toEqual([]);
    view.dispose();
  });

  it('has an intrusion check that catches a planted prop and allows a boundary-flush wall', () => {
    const map = createStreetMap();
    const walkable = (x: number, z: number) => !isSolidAt(map, Math.floor(x), Math.floor(z));
    const planted = new Object3D();
    const prop = new Mesh(boxGeometry(10.3, 0, 11.3, 10.7, 1, 11.7));
    prop.name = 'planted';
    planted.add(prop);
    expect(findWalkableIntrusions(planted, walkable, map)).toEqual([
      expect.stringContaining('planted'),
    ]);
    // The sandbox square is walkable ground too.
    const square = new Object3D();
    const block = new Mesh(boxGeometry(68.2, 0, 14.2, 68.8, 0.6, 14.8));
    block.name = 'block';
    square.add(block);
    expect(findWalkableIntrusions(square, walkable, map)).toEqual([expect.stringContaining('block')]);
    // An alcove side wall standing exactly on the solid/walkable boundary.
    const flush = new Object3D();
    flush.add(new Mesh(boxGeometry(4, 0, 9.8, 5, 2, 11)));
    expect(findWalkableIntrusions(flush, walkable, map)).toEqual([]);
  });

  it('stays under the draw-call budget', () => {
    const { map, view } = build();
    let calls = 0;
    for (const group of [view.ground, view.doors, view.labels]) {
      group.traverse((object) => {
        if (object instanceof Mesh || (object as { isSprite?: boolean }).isSprite) calls += 1;
      });
    }
    // The null labels are not meshes; a canvas sign costs one call each.
    calls += view.labels.children.length;
    void map;
    expect(calls).toBeLessThan(150);
    view.dispose();
  });

  it('animates door glow and the ticker deterministically', () => {
    const first = build().view;
    const second = build().view;
    const sample = (view: StreetView) => {
      const values: number[] = [];
      view.doors.traverse((object) => {
        if (object instanceof Mesh && object.material instanceof MeshStandardMaterial) {
          values.push(object.material.emissiveIntensity);
        }
      });
      view.ground.traverse((object) => {
        if (object instanceof Mesh && object.name.endsWith(':ticker')) {
          const map = (object.material as { map: Texture | null }).map;
          values.push(map?.offset.x ?? Number.NaN);
        }
      });
      return values;
    };
    const before = sample(first);
    for (const delta of [16, 33, 250, 999, 16]) {
      first.update(delta);
      second.update(delta);
    }
    expect(sample(first)).toEqual(sample(second));
    expect(sample(first)).not.toEqual(before);
    first.update(Number.NaN);
    first.update(-5);
    expect(sample(first)).toEqual(sample(second));
    first.dispose();
    second.dispose();
  });

  it('disposes every geometry, material, texture and instance buffer exactly once', () => {
    const { view } = build();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    const instanced = new Set<InstancedMesh>();
    for (const group of [view.ground, view.doors, view.labels]) {
      group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
        }
        if (object instanceof InstancedMesh) instanced.add(object);
      });
    }
    expect(geometries.size).toBeGreaterThan(20);
    expect(textures.size).toBeGreaterThan(0);
    const spies = [...geometries, ...materials, ...textures, ...instanced].map((value) =>
      vi.spyOn(value, 'dispose'),
    );
    const parent = new Object3D();
    parent.add(view.ground, view.doors, view.labels);

    view.dispose();
    view.dispose();

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
    expect(view.ground.children).toHaveLength(0);
    view.update(16);
  });

  it('reports raised pavement so the avatar can stand on the kerb', () => {
    const map = createStreetMap();
    expect(streetSurfaceHeightAt(map, 10, 11)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, 10, 18)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, 5, 10)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, 10, 14)).toBe(0);
    expect(streetSurfaceHeightAt(map, 5, 14)).toBe(0);
    expect(streetSurfaceHeightAt(map, 10, 2)).toBe(0);
    expect(streetSurfaceHeightAt(map, 23, 22)).toBe(0);
  });
});

function meshNamed(root: Object3D, suffix: string): Mesh {
  let found: Mesh | undefined;
  root.traverse((object) => {
    if (!found && object instanceof Mesh && object.name.endsWith(suffix)) found = object;
  });
  if (!found) throw new Error(`no mesh ${suffix}`);
  return found;
}

function verticesNear(mesh: Mesh, test: (vertex: Vector3) => boolean): number {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const vertex = new Vector3();
  let count = 0;
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (test(vertex)) count++;
  }
  return count;
}

function materialsOf(root: Object3D): Material[] {
  const found = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      found.add(material);
    }
  });
  return [...found];
}

/**
 * Sample every triangle between ankle and head height; a sample is an
 * intrusion when it sits more than a hair inside a walkable tile. Tile
 * boundaries (alcove walls, door faces) are allowed.
 */
function findWalkableIntrusions(
  root: Object3D,
  walkable: (x: number, z: number) => boolean,
  map: DistrictMap,
): string[] {
  const MIN_Y = 0.15;
  const MAX_Y = 1.9;
  const EPS = 0.04;
  const STEP = 0.12;
  root.updateMatrixWorld(true);
  const found: string[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const p = new Vector3();
  const instance = new Matrix4();
  const world = new Matrix4();
  root.traverse((object) => {
    if (!(object instanceof Mesh) || found.length > 20) return;
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
        const ia = index ? index.getX(t * 3) : t * 3;
        const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(position, ia).applyMatrix4(world);
        b.fromBufferAttribute(position, ib).applyMatrix4(world);
        c.fromBufferAttribute(position, ic).applyMatrix4(world);
        if (Math.max(a.y, b.y, c.y) < MIN_Y || Math.min(a.y, b.y, c.y) > MAX_Y) continue;
        if (Math.max(a.x, b.x, c.x) < 0 || Math.min(a.x, b.x, c.x) > map.width) continue;
        if (Math.max(a.z, b.z, c.z) < 0 || Math.min(a.z, b.z, c.z) > map.height) continue;
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
