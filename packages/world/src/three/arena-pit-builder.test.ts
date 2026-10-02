import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3, type Material, type MeshBasicMaterial, type Object3D } from 'three';
import { ARENA_PIT_AREA, ARENA_PIT_DOOR } from '../map/arena-pit.js';
import { createStreetMap, isSolidAt, type DistrictMap } from '../map/street.js';
import { ARENA_PIT_ARCH_SPRING, ARENA_PIT_SIGN_TEXT, arenaFlameOpacity, type ArenaPitOccluder } from './arena-pit-builder.js';
import { createNullLabelFactory } from './labels.js';
import { PAVEMENT_HEIGHT, buildStreet, streetSurfaceHeightAt, type StreetOccluder } from './street-builder.js';
import type { StreetView } from './types.js';

/**
 * The gladiator pit in the street scene (D-114): four draw calls of its own,
 * nothing in the way on a walkable tile, its arch an occluder that fades
 * alone, and braziers that flicker, deterministically, and never go out.
 */

function build(map: DistrictMap = createStreetMap(), reducedMotion?: () => boolean): { map: DistrictMap; view: StreetView } {
  return { map, view: buildStreet(map, createNullLabelFactory(), reducedMotion ? { reducedMotion } : {}) };
}

function named(root: Object3D, name: string): Mesh | undefined {
  return root.getObjectByName(name) as Mesh | undefined;
}

function materialsOf(root: Object3D): Material[] {
  const found = new Set<Material>();
  root.traverse((object) => {
    if (object instanceof Mesh) for (const material of [object.material].flat()) found.add(material);
  });
  return [...found];
}

function streetCalls(view: StreetView): number {
  let calls = 0;
  for (const group of [view.ground, view.doors, view.labels]) {
    group.traverse((object) => {
      if (object instanceof Mesh || (object as { isSprite?: boolean }).isSprite) calls += 1;
    });
  }
  // The null labels are not meshes; a canvas sign costs one call each.
  return calls + view.labels.children.length;
}

/** Points of `mesh` between ankle and head height that lie inside a walkable tile, beyond a hair. */
function intrusions(mesh: Mesh, map: DistrictMap, band = { min: 0.15, max: 1.9 }): string[] {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const p = new Vector3();
  const EPS = 0.04;
  const walkable = (x: number, z: number) => !isSolidAt(map, Math.floor(x), Math.floor(z));
  const found: string[] = [];
  for (let t = 0; t < position.count / 3 && found.length < 5; t++) {
    a.fromBufferAttribute(position, t * 3).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
    if (Math.max(a.y, b.y, c.y) < band.min || Math.min(a.y, b.y, c.y) > band.max) continue;
    const steps = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / 0.1));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps;
        const v = j / steps;
        p.set(a.x * (1 - u - v) + b.x * u + c.x * v, a.y * (1 - u - v) + b.y * u + c.y * v, a.z * (1 - u - v) + b.z * u + c.z * v);
        if (p.y < band.min || p.y > band.max) continue;
        if (walkable(p.x - EPS, p.z - EPS) && walkable(p.x + EPS, p.z - EPS) && walkable(p.x - EPS, p.z + EPS) && walkable(p.x + EPS, p.z + EPS)) {
          found.push(`${mesh.name} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
          i = steps + 1;
          break;
        }
      }
    }
  }
  return found;
}

describe('the gladiator pit in the street scene (D-114)', () => {
  it('costs the street four draw calls: stone, arch, flames and the sign', () => {
    const { map, view } = build();
    const meshes: string[] = [];
    view.ground.traverse((object) => {
      if (object instanceof Mesh && object.name.startsWith('pit:')) meshes.push(object.name);
    });
    expect(meshes.sort()).toEqual(['pit:arch', 'pit:flames', 'pit:stone']);
    const signs = view.labels.children.filter((child) => child.userData['area'] === 'arena-pit');
    expect(signs).toHaveLength(1);
    expect(signs[0]!.userData['text']).toBe(ARENA_PIT_SIGN_TEXT);
    // The whole street stays inside its budget, four calls above the street without the pit.
    const plain: DistrictMap = {
      ...map,
      tiles: map.tiles.map((row) => row.map((kind) => (kind === 'pitrim' || kind === 'pitbowl' || kind === 'pitstep' ? 'grass' : kind))),
      doors: map.doors.filter((door) => door.building !== 'arena'),
    };
    const without = build(plain).view;
    expect(named(without.ground, 'pit:stone')).toBeUndefined();
    expect(streetCalls(view)).toBe(streetCalls(without) + 4);
    // Headroom, not the pit's own cost: the south vista's six merged meshes
    // joined the street's ground group since (D-124).
    expect(streetCalls(view)).toBeLessThanOrEqual(96);
    expect(streetCalls(view)).toBeLessThan(150);
    without.dispose();
    view.dispose();
  });

  it('stands on its own tiles: the bowl sunk below the lawn, nothing in the way on a walkable tile', () => {
    const { map, view } = build();
    for (const name of ['pit:stone', 'pit:arch', 'pit:flames']) {
      const mesh = named(view.ground, name)!;
      expect(intrusions(mesh, map), name).toEqual([]);
      const box = new Box3().setFromObject(mesh);
      expect(box.min.x, name).toBeGreaterThanOrEqual(ARENA_PIT_AREA.x - 0.1);
      expect(box.max.x, name).toBeLessThanOrEqual(ARENA_PIT_AREA.x + ARENA_PIT_AREA.width + 0.1);
      expect(box.min.z, name).toBeGreaterThanOrEqual(ARENA_PIT_AREA.y - 0.1);
      expect(box.max.z, name).toBeLessThanOrEqual(ARENA_PIT_AREA.y + ARENA_PIT_AREA.height + 0.1);
    }
    const stone = new Box3().setFromObject(named(view.ground, 'pit:stone')!);
    expect(stone.min.y).toBeLessThan(-1.15);
    // Nothing but the arch rises above knee height.
    expect(stone.max.y).toBeLessThan(1.4);
    // The whole threshold is level with the pavement; the bowl east of it is
    // solid ground level.
    for (let row = 0; row < ARENA_PIT_DOOR.height; row++) {
      expect(streetSurfaceHeightAt(map, ARENA_PIT_DOOR.x + 0.5, ARENA_PIT_DOOR.y + row + 0.5), `row ${row}`).toBe(PAVEMENT_HEIGHT);
    }
    expect(streetSurfaceHeightAt(map, ARENA_PIT_DOOR.x + 1.5, ARENA_PIT_DOOR.y + 0.5)).toBe(0);
    view.dispose();
  });

  it('clears every head under the arch, and fades the arch and its sign alone as an occluder', () => {
    const { map, view } = build();
    const arch = named(view.ground, 'pit:arch')!;
    // Over the threshold the arch is all above the spring line.
    expect(intrusions(arch, map, { min: 0, max: ARENA_PIT_ARCH_SPRING - 0.01 })).toEqual([]);
    const occluders = (view.occluders as readonly StreetOccluder[]).filter(
      (occluder): occluder is ArenaPitOccluder => occluder.kind === 'arena-pit',
    );
    expect(occluders).toHaveLength(1);
    const occluder = occluders[0]!;
    expect(occluder.object).toBe(arch);
    expect(occluder.boxes).toHaveLength(3);
    // The arch stands across the west front, so its span runs north to south:
    // past the opening at both ends, onto its two gateposts.
    expect(occluder.bounds.minZ).toBeLessThanOrEqual(ARENA_PIT_DOOR.y - 0.5);
    expect(occluder.bounds.maxZ).toBeGreaterThanOrEqual(ARENA_PIT_DOOR.y + ARENA_PIT_DOOR.height + 0.5);
    // And only through the door's own column in x.
    expect(occluder.bounds.minX).toBeGreaterThanOrEqual(ARENA_PIT_DOOR.x);
    expect(occluder.bounds.maxX).toBeLessThanOrEqual(ARENA_PIT_DOOR.x + 1);
    const own = materialsOf(arch);
    const others = materialsOf(view.ground).filter((material) => !own.includes(material));
    occluder.setOpacity(0.3);
    for (const material of own) expect(material.opacity).toBeCloseTo(0.3);
    for (const material of others) expect(material.opacity).toBe(1);
    occluder.setOpacity(1);
    for (const material of own) expect(material.opacity).toBe(1);
    view.dispose();
  });

  it('has no door portal: its arch is its door', () => {
    const { view } = build();
    expect(view.doors.children.some((child) => child.userData['building'] === 'arena')).toBe(false);
    view.dispose();
  });

  it('flickers its braziers deterministically, never out, slower for reduced motion', () => {
    const sample = (reduced: boolean): number[] => {
      const { view } = build(createStreetMap(), () => reduced);
      const material = named(view.ground, 'pit:flames')!.material as MeshBasicMaterial;
      const seen: number[] = [];
      for (let k = 0; k < 60; k++) {
        view.update(50);
        seen.push(material.opacity);
      }
      view.dispose();
      return seen;
    };
    const full = sample(false);
    expect(sample(false)).toEqual(full);
    expect(Math.min(...full)).toBeGreaterThan(0.55);
    expect(Math.max(...full) - Math.min(...full)).toBeGreaterThan(0.1);
    const slow = sample(true);
    expect(Math.min(...slow)).toBeGreaterThan(0.55);
    const swing = (values: number[]) => values.slice(1).reduce((sum, value, i) => sum + Math.abs(value - values[i]!), 0);
    expect(swing(slow)).toBeLessThan(swing(full) / 2);
    for (let t = 0; t < 60; t += 0.01) expect(arenaFlameOpacity(t)).toBeGreaterThan(0.6);
  });

  it('builds nothing on a map without the pit', () => {
    const map = createStreetMap();
    const plain: DistrictMap = {
      ...map,
      tiles: map.tiles.map((row) => row.map((kind) => (kind === 'pitrim' || kind === 'pitbowl' || kind === 'pitstep' ? 'grass' : kind))),
      doors: map.doors.filter((door) => door.building !== 'arena'),
    };
    const { view } = build(plain);
    expect(named(view.ground, 'pit:stone')).toBeUndefined();
    expect(view.labels.children.some((child) => child.userData['area'] === 'arena-pit')).toBe(false);
    view.dispose();
  });
});
