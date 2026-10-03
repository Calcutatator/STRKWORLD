import { describe, expect, it } from 'vitest';
import { Box3, BufferAttribute, BufferGeometry, InstancedMesh, Material, Mesh, PlaneGeometry, MeshBasicMaterial, DoubleSide, Vector3 } from 'three';
import { createStreetMap } from '../map/street.js';
import { backdropSurface } from './backdrop.js';
import { buildStreet } from './street-builder.js';
import { MAP_SOUTH_EDGE, SOUTH_SHORE_Z, createSouthVista } from './south-vista.js';
import { ROCK_CENTRE, ROCK_RADIUS, onRockTop } from './sky-island.js';
import type { LabelFactory, TextLabel } from './types.js';

/**
 * The south vista (D-124).
 *
 * What is pinned here is what the Exchange roof's swing depends on and what
 * the street cannot afford: the group stands entirely south of the map, it
 * costs a small fixed number of draw calls, a frame writes into buffers that
 * already exist rather than making new ones, reduced motion stops it dead, and
 * building then disposing it leaves nothing behind.
 */

const MESHES = (root: { traverse(fn: (object: unknown) => void): void }): Mesh[] => {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
};

const stubLabels = (): LabelFactory => {
  const make = (): TextLabel => {
    const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ side: DoubleSide }));
    return { object: mesh, setText() {}, dispose() { mesh.removeFromParent(); } };
  };
  return { sign: () => make(), floating: () => make() };
};

describe('the south vista (D-124)', () => {
  it('builds, and disposing it releases every geometry and material and empties the group', () => {
    const vista = createSouthVista();
    const meshes = MESHES(vista.group);
    expect(meshes.length).toBeGreaterThan(0);

    const released = new Set<BufferGeometry | Material>();
    const watch = (resource: BufferGeometry | Material): void => {
      resource.addEventListener('dispose', () => released.add(resource));
    };
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const mesh of meshes) {
      geometries.add(mesh.geometry);
      materials.add(mesh.material as Material);
    }
    for (const resource of [...geometries, ...materials]) watch(resource);

    vista.dispose();
    expect(vista.group.children).toEqual([]);
    expect(released).toEqual(new Set([...geometries, ...materials]));
    // Disposing twice is a no-op, not a second pass over freed resources.
    expect(() => vista.dispose()).not.toThrow();
    // And so is updating a disposed vista.
    expect(() => vista.update(1000)).not.toThrow();
  });

  it('costs eight draw calls at most, and fewer on a phone: six merged meshes, five without the boats', () => {
    const high = createSouthVista({ quality: 'high' });
    const low = createSouthVista({ quality: 'low' });
    // The whole vista's budget, the figure the roof branch inherits.
    expect(MESHES(high.group).length).toBeLessThanOrEqual(8);
    expect(MESHES(high.group).length).toBe(6);
    // 'low' drops the boats, which are the only thing that moves.
    expect(MESHES(low.group).length).toBe(5);
    expect(MESHES(low.group).some((mesh) => mesh instanceof InstancedMesh)).toBe(false);
    expect(MESHES(high.group).filter((mesh) => mesh instanceof InstancedMesh)).toHaveLength(1);
    // One mesh per bin, and every one merged: no bin becomes a pile of meshes.
    expect(MESHES(high.group).map((mesh) => mesh.name).sort()).toEqual([
      'south-vista:banks',
      'south-vista:city',
      'south-vista:ferries',
      'south-vista:glass',
      'south-vista:station',
      'south-vista:water',
    ]);
    // Low quality is cheaper in triangles too, not just in meshes.
    const triangles = (root: typeof high.group): number =>
      MESHES(root).reduce((total, mesh) => {
        const index = mesh.geometry.getIndex();
        const count = index ? index.count : mesh.geometry.getAttribute('position').count;
        return total + (count / 3) * (mesh instanceof InstancedMesh ? mesh.count : 1);
      }, 0);
    expect(triangles(low.group)).toBeLessThan(triangles(high.group) * 0.75);
    high.dispose();
    low.dispose();
  });

  it('stands entirely south of the map, and never reaches past the camera\'s far plane from the roof', () => {
    const map = createStreetMap();
    // The module takes no map, so the edge it is laid out from is pinned here.
    expect(MAP_SOUTH_EDGE).toBe(map.height);
    expect(SOUTH_SHORE_Z).toBeGreaterThan(MAP_SOUTH_EDGE);

    for (const quality of ['high', 'low'] as const) {
      const vista = createSouthVista({ quality });
      const box = new Box3().setFromObject(vista.group);
      // Nothing of it is on, or north of, a map tile.
      expect(box.min.z, quality).toBeGreaterThanOrEqual(MAP_SOUTH_EDGE);
      // Nor north of the shore the backdrop stops its own ground at, bar the
      // quay edge that holds the bank up.
      expect(box.min.z, quality).toBeGreaterThan(SOUTH_SHORE_Z - 5);
      // The engine's camera is a 360 far plane (D-132 pushed it out for the
      // cloud sea); from the roof deck (z about 11) the whole vista has to be
      // inside it or its back edge would clip.
      expect(box.max.z - 11, quality).toBeLessThan(360);
      // And it ends at the rock's rim, not at a straight line of its own: the
      // far bank runs out to the drop and the water goes over both flanks
      // (D-132). Every vertex of it is on the rock, to within rounding.
      expect(box.max.z, quality).toBeLessThanOrEqual(ROCK_CENTRE.z + ROCK_RADIUS * 1.06);
      const off: string[] = [];
      const point = new Vector3();
      for (const mesh of MESHES(vista.group)) {
        mesh.updateMatrixWorld(true);
        const position = mesh.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i += 3) {
          point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
          if (!onRockTop(point.x, point.z, -0.5)) off.push(`${mesh.name} (${point.x.toFixed(1)}, ${point.z.toFixed(1)})`);
        }
      }
      expect(off.slice(0, 5), quality).toEqual([]);
      // And it sits on the water, not over the district: nothing towers.
      expect(box.max.y, quality).toBeLessThan(32);
      vista.dispose();
    }
  });

  it('is what the backdrop makes room for: no hinterland ground past the shore', () => {
    const map = createStreetMap();
    // Out past the street's own outskirts, where the backdrop lays the ground
    // itself, it still has fields inshore of the shore...
    for (const x of [-80, -60, 170, 200]) {
      expect(backdropSurface(map, x, SOUTH_SHORE_Z - 6), `${x} inshore`).not.toBeNull();
    }
    // ...and nothing at all past it, anywhere along the bank. Nothing to
    // stand a hedgerow, a tree line or a hill in the river.
    for (const x of [-80, -60, 0, 44, 110, 170, 200]) {
      for (const z of [SOUTH_SHORE_Z, SOUTH_SHORE_Z + 4, SOUTH_SHORE_Z + 9]) {
        expect(backdropSurface(map, x, z), `${x},${z}`).toBeNull();
      }
    }
  });

  it('writes a frame into the buffers it already has: update allocates nothing', () => {
    const vista = createSouthVista();
    const water = MESHES(vista.group).find((mesh) => mesh.name === 'south-vista:water')!;
    const ferries = MESHES(vista.group).find((mesh) => mesh instanceof InstancedMesh) as InstancedMesh;
    const colour = water.geometry.getAttribute('color') as BufferAttribute;
    const colourArray = colour.array;
    const matrixArray = ferries.instanceMatrix.array;

    const before = Float32Array.from(colourArray as Float32Array);
    const beforeMatrices = Float32Array.from(matrixArray as Float32Array);
    vista.update(4000);

    // The same typed arrays, written through — not replaced.
    expect(water.geometry.getAttribute('color')).toBe(colour);
    expect(colour.array).toBe(colourArray);
    expect(ferries.instanceMatrix.array).toBe(matrixArray);
    // And it really did move: the glitter and both boats.
    expect(Array.from(colourArray as Float32Array)).not.toEqual(Array.from(before));
    expect(Array.from(matrixArray as Float32Array)).not.toEqual(Array.from(beforeMatrices));
    // `needsUpdate` is write-only on a BufferAttribute; the version it bumps
    // is what tells three to re-upload.
    expect(colour.version).toBeGreaterThan(0);
    expect(ferries.instanceMatrix.version).toBeGreaterThan(0);

    // A stalled tab, a NaN clock: neither may poison the water or the boats.
    vista.update(Number.NaN);
    expect(Array.from(colourArray as Float32Array).every(Number.isFinite)).toBe(true);
    expect(Array.from(matrixArray as Float32Array).every(Number.isFinite)).toBe(true);
    vista.dispose();
  });

  it('holds still under reduced motion, from the first frame on', () => {
    const vista = createSouthVista({ reducedMotion: true });
    const water = MESHES(vista.group).find((mesh) => mesh.name === 'south-vista:water')!;
    const ferries = MESHES(vista.group).find((mesh) => mesh instanceof InstancedMesh) as InstancedMesh;
    const colour = Float32Array.from(water.geometry.getAttribute('color').array as Float32Array);
    const matrices = Float32Array.from(ferries.instanceMatrix.array as Float32Array);
    // The boats are still built and still moored somewhere sensible.
    expect(ferries.count).toBe(2);

    for (const elapsed of [16, 5_000, 120_000]) vista.update(elapsed);
    expect(Array.from(water.geometry.getAttribute('color').array as Float32Array)).toEqual(Array.from(colour));
    expect(Array.from(ferries.instanceMatrix.array as Float32Array)).toEqual(Array.from(matrices));

    // Still water is the same water, not a different colour: a vista built
    // with motion looks like this on its first frame.
    const moving = createSouthVista({ reducedMotion: false });
    const movingWater = MESHES(moving.group).find((mesh) => mesh.name === 'south-vista:water')!;
    expect(Array.from(movingWater.geometry.getAttribute('color').array as Float32Array)).toEqual(Array.from(colour));
    moving.dispose();
    vista.dispose();
  });

  it('goes into the street scene, where the Exchange roof is, and stays out of the street\'s way', () => {
    const map = createStreetMap();
    const view = buildStreet(map, stubLabels());
    const vista = view.ground.getObjectByName('south-vista');
    // The roof is the building's top in the street scene, not a room of its
    // own (presenter.ts), so mounting it here is what puts it under the swing.
    expect(vista, 'the street mounts the vista in its ground group').toBeDefined();
    expect(MESHES(vista!)).toHaveLength(6);
    // Hiding the street indoors hides the vista with it.
    expect(vista!.parent).toBe(view.ground);
    // Scenery only: it casts and receives nothing, and the shadow camera is
    // nowhere near it anyway.
    for (const mesh of MESHES(vista!)) {
      expect(mesh.castShadow, mesh.name).toBe(false);
      expect(mesh.receiveShadow, mesh.name).toBe(false);
      // Its own haze, not the engine's fog, which moves with the player's
      // elevation and would erase the far bank from the roof.
      expect((mesh.material as Material & { fog?: boolean }).fog, mesh.name).toBe(false);
    }
    // A street animator drives it: the water moves when the street does.
    const water = MESHES(vista!).find((mesh) => mesh.name === 'south-vista:water')!;
    const before = Float32Array.from(water.geometry.getAttribute('color').array as Float32Array);
    view.update(3000);
    expect(Array.from(water.geometry.getAttribute('color').array as Float32Array)).not.toEqual(Array.from(before));

    view.dispose();
    expect(view.ground.getObjectByName('south-vista')).toBeUndefined();
  });
});
