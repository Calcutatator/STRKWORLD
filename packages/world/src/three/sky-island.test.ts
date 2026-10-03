import { describe, expect, it } from 'vitest';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { PITCH_AREA, SANDBOX_AREA, STREET_ORIGIN_X } from '@strkworld/shared';
import { createStreetMap } from '../map/street.js';
import { HINTERLAND, OUTSKIRT, RIM_SETBACK, backdropSurface } from './backdrop.js';
import { FAR_QUAY_Z, SOUTH_SHORE_Z, WATER_Y, createSouthVista } from './south-vista.js';
import {
  FALL_TOP_Y,
  FALL_Z0,
  FALL_Z1,
  ROCK_CENTRE,
  ROCK_DEPTH,
  ROCK_RADIUS,
  createSkyIsland,
  onRockTop,
  rockRadiusAt,
  rockSpanAtZ,
} from './sky-island.js';
import { buildStreet } from './street-builder.js';
import type { LabelFactory, TextLabel } from './types.js';

/**
 * The sky island (D-132).
 *
 * What is pinned here is what the change is for and what it must not cost: the
 * whole world stands on the rock and nothing is laid off it, there is no
 * ground below it, the river's falls hold still under reduced motion, a frame
 * writes into buffers that already exist, and the whole thing is five draw
 * calls, three on a phone.
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

/** Every vertex of every mesh under `root`, in world space. */
function vertices(root: Mesh[]): Vector3[] {
  const out: Vector3[] = [];
  const point = () => new Vector3();
  for (const mesh of root) {
    mesh.updateMatrixWorld(true);
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      out.push(point().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    }
  }
  return out;
}

describe('the sky island (D-132)', () => {
  it('is about three times the playable map across, with the map near the middle', () => {
    const map = createStreetMap();
    // The lead asked for a rock about 3x the playable area. The map is 111
    // tiles across, and the rock's mean diameter is 364.
    expect(map.width).toBe(SANDBOX_AREA.x + SANDBOX_AREA.width);
    expect((2 * ROCK_RADIUS) / map.width).toBeGreaterThan(2.8);
    expect((2 * ROCK_RADIUS) / map.width).toBeLessThan(3.6);
    // And the map sits near the axis rather than off to one side: every corner
    // of it is well inside, and the axis is within a map width of its centre.
    expect(Math.hypot(ROCK_CENTRE.x - map.width / 2, ROCK_CENTRE.z - map.height / 2)).toBeLessThan(map.width / 2);
  });

  it('holds the whole playable map, the pitch, the sandbox and the backdrop, with room at the rim', () => {
    const map = createStreetMap();
    // Every corner of everything the player can stand on.
    const areas: ReadonlyArray<readonly [string, number, number, number, number]> = [
      ['map', 0, 0, map.width, map.height],
      ['pitch', PITCH_AREA.x, PITCH_AREA.y, PITCH_AREA.x + PITCH_AREA.width, PITCH_AREA.y + PITCH_AREA.height],
      ['sandbox', SANDBOX_AREA.x, SANDBOX_AREA.y, SANDBOX_AREA.x + SANDBOX_AREA.width, SANDBOX_AREA.y + SANDBOX_AREA.height],
      // The street's own outskirts, which run a fixed distance past the map.
      ['outskirts', -OUTSKIRT, -OUTSKIRT, map.width + OUTSKIRT, map.height + OUTSKIRT],
    ];
    for (const [name, x0, z0, x1, z1] of areas) {
      for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) {
        expect(onRockTop(x, z, RIM_SETBACK + 10), `${name} (${x}, ${z})`).toBe(true);
      }
    }
    // And the backdrop's own ground is on it everywhere it is laid, with the
    // setback kept: nothing of the town or the country overhangs the drop.
    for (let x = -HINTERLAND; x <= map.width + HINTERLAND; x += 7) {
      for (let z = -HINTERLAND; z < SOUTH_SHORE_Z; z += 7) {
        if (backdropSurface(map, x, z) === null) continue;
        expect(onRockTop(x, z, RIM_SETBACK - 1), `backdrop (${x}, ${z})`).toBe(true);
      }
    }
  });

  it('cuts the country off at the rim: past it there is no ground at all', () => {
    const map = createStreetMap();
    for (const angle of [0, 0.7, 1.6, 2.4, 3.3, 4.1, 5.2, 6]) {
      const r = rockRadiusAt(angle);
      for (const out of [2, 20, 90]) {
        const x = ROCK_CENTRE.x + Math.cos(angle) * (r + out);
        const z = ROCK_CENTRE.z + Math.sin(angle) * (r + out);
        expect(onRockTop(x, z), `${angle} + ${out}`).toBe(false);
        expect(backdropSurface(map, x, z), `backdrop ${angle} + ${out}`).toBeNull();
      }
    }
  });

  it('puts nothing at all below the rock except its own cliffs, falls and cloud', () => {
    const island = createSkyIsland();
    const map = createStreetMap();
    const view = buildStreet(map, stubLabels());
    // Everything the street draws stands on the top: the only things that
    // reach below the water's surface are the island's own.
    for (const mesh of MESHES(view.ground)) {
      if (mesh.name.startsWith('sky-island:')) continue;
      mesh.updateMatrixWorld(true);
      const box = new Box3().setFromObject(mesh);
      // The river's bed and the piles under the far bank's piers are the
      // deepest of it; nothing goes near the rock's own skirt.
      expect(box.min.y, mesh.name).toBeGreaterThan(-8);
    }
    // And the island's own underside tapers to one point on the axis.
    const rock = MESHES(island.group).find((mesh) => mesh.name === 'sky-island:rock')!;
    const deep = vertices([rock]).filter((v) => v.y < -ROCK_DEPTH * 0.92);
    expect(deep.length).toBeGreaterThan(0);
    for (const v of deep) {
      expect(Math.hypot(v.x - ROCK_CENTRE.x, v.z - ROCK_CENTRE.z)).toBeLessThan(ROCK_RADIUS * 0.2);
    }
    view.dispose();
    island.dispose();
  });

  it('costs five draw calls, and three on a phone: one merged mesh per bin', () => {
    const high = createSkyIsland({ quality: 'high' });
    const low = createSkyIsland({ quality: 'low' });
    expect(MESHES(high.group).map((mesh) => mesh.name).sort()).toEqual([
      'sky-island:clouds',
      'sky-island:falls',
      'sky-island:islets',
      'sky-island:mist',
      'sky-island:rock',
    ]);
    expect(MESHES(low.group).map((mesh) => mesh.name).sort()).toEqual([
      'sky-island:clouds',
      'sky-island:falls',
      'sky-island:rock',
    ]);
    const triangles = (meshes: Mesh[]): number =>
      meshes.reduce((total, mesh) => {
        const index = mesh.geometry.getIndex();
        return total + (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
      }, 0);
    // Cheap in triangles as well as in calls, and much cheaper on a phone.
    expect(triangles(MESHES(high.group))).toBeLessThan(20_000);
    expect(triangles(MESHES(low.group))).toBeLessThan(triangles(MESHES(high.group)) * 0.45);
    // None of it is lit by the shadow camera or fogged by the engine: it
    // stands far past the fog, which moves with the player's elevation.
    for (const mesh of MESHES(high.group)) {
      expect(mesh.castShadow, mesh.name).toBe(false);
      expect(mesh.receiveShadow, mesh.name).toBe(false);
      expect((mesh.material as Material & { fog?: boolean }).fog, mesh.name).toBe(false);
      // Nothing shares a half-faded material with the street: the occluder
      // fade walks every material it can reach.
      expect(mesh.material as Material & { opacity: number }).toHaveProperty('opacity', 1);
    }
    high.dispose();
    low.dispose();
  });

  it('hangs the falls where the river meets the rim, at the water\'s own level', () => {
    const island = createSkyIsland();
    const falls = MESHES(island.group).find((mesh) => mesh.name === 'sky-island:falls')!;
    const points = vertices([falls]);
    const lip = points.filter((v) => v.y > FALL_TOP_Y - 0.01);
    expect(lip.length).toBeGreaterThan(0);
    // Every lip vertex sits on the rim, within the river's band, on one flank
    // or the other — never across the rock's north or south.
    for (const v of lip) {
      expect(v.z).toBeGreaterThanOrEqual(FALL_Z0 - 0.01);
      expect(v.z).toBeLessThanOrEqual(FALL_Z1 + 0.01);
      const span = rockSpanAtZ(v.z)!;
      // Within a row's own width of the rim it is solved at: the rim wanders
      // a little across the five units a row covers.
      expect(Math.min(Math.abs(v.x - span[0]), Math.abs(v.x - span[1]))).toBeLessThan(1.5);
    }
    // And the water really does run out to them: the vista's river reaches the
    // same rim, so there is no gap between the river and its fall.
    const vista = createSouthVista();
    const water = MESHES(vista.group).find((mesh) => mesh.name === 'south-vista:water')!;
    const box = new Box3().setFromObject(water);
    const widest = rockSpanAtZ((FALL_Z0 + FALL_Z1) / 2)!;
    expect(box.min.x).toBeLessThan(widest[0] + 6);
    expect(box.max.x).toBeGreaterThan(widest[1] - 6);
    vista.dispose();
    island.dispose();
  });

  it('is laid out from the same river the vista is', () => {
    // The two modules hold these as values of their own rather than importing
    // one from the other, so the pair is pinned here instead.
    expect(FALL_Z0).toBe(SOUTH_SHORE_Z);
    expect(FALL_Z1).toBe(FAR_QUAY_Z);
    expect(FALL_TOP_Y).toBe(WATER_Y);
  });

  it('writes a frame into the buffers it already has: update allocates nothing', () => {
    const island = createSkyIsland();
    const falls = MESHES(island.group).find((mesh) => mesh.name === 'sky-island:falls')!;
    const colour = falls.geometry.getAttribute('color') as BufferAttribute;
    const array = colour.array;
    const before = Float32Array.from(array as Float32Array);

    island.update(4000);
    expect(falls.geometry.getAttribute('color')).toBe(colour);
    expect(colour.array).toBe(array);
    expect(Array.from(array as Float32Array)).not.toEqual(Array.from(before));
    expect(colour.version).toBeGreaterThan(0);

    // A stalled tab, a NaN clock: neither may poison the water.
    island.update(Number.NaN);
    expect(Array.from(array as Float32Array).every(Number.isFinite)).toBe(true);
    island.dispose();
  });

  it('holds the falls still under reduced motion, from the first frame on', () => {
    const still = createSkyIsland({ reducedMotion: true });
    const falls = MESHES(still.group).find((mesh) => mesh.name === 'sky-island:falls')!;
    const colour = Float32Array.from(falls.geometry.getAttribute('color').array as Float32Array);
    for (const elapsed of [16, 5_000, 120_000]) still.update(elapsed);
    expect(Array.from(falls.geometry.getAttribute('color').array as Float32Array)).toEqual(Array.from(colour));

    // Still water is the same water, not a different colour: a fall built with
    // motion looks like this on its first frame.
    const moving = createSkyIsland({ reducedMotion: false });
    const movingFalls = MESHES(moving.group).find((mesh) => mesh.name === 'sky-island:falls')!;
    expect(Array.from(movingFalls.geometry.getAttribute('color').array as Float32Array)).toEqual(Array.from(colour));
    moving.dispose();
    still.dispose();
  });

  it('builds, and disposing it releases every geometry and material and empties the group', () => {
    const island = createSkyIsland();
    const meshes = MESHES(island.group);
    expect(meshes.length).toBeGreaterThan(0);

    const released = new Set<BufferGeometry | Material>();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const mesh of meshes) {
      geometries.add(mesh.geometry);
      materials.add(mesh.material as Material);
    }
    for (const resource of [...geometries, ...materials]) {
      resource.addEventListener('dispose', () => released.add(resource));
    }

    island.dispose();
    expect(island.group.children).toEqual([]);
    expect(released).toEqual(new Set([...geometries, ...materials]));
    expect(() => island.dispose()).not.toThrow();
    expect(() => island.update(1000)).not.toThrow();
  });

  it('goes into the street scene, where every camera that sees it is', () => {
    const map = createStreetMap();
    const view = buildStreet(map, stubLabels());
    const island = view.ground.getObjectByName('sky-island');
    expect(island, 'the street mounts the island in its ground group').toBeDefined();
    expect(island!.parent).toBe(view.ground);
    expect(MESHES(island!)).toHaveLength(5);
    // A street animator drives the falls: the water moves when the street does.
    const falls = MESHES(island!).find((mesh) => mesh.name === 'sky-island:falls')!;
    const before = Float32Array.from(falls.geometry.getAttribute('color').array as Float32Array);
    view.update(3000);
    expect(Array.from(falls.geometry.getAttribute('color').array as Float32Array)).not.toEqual(Array.from(before));
    view.dispose();
    expect(view.ground.getObjectByName('sky-island')).toBeUndefined();
  });

  it('thins for a phone without losing the rock, the falls or the cloud', () => {
    const map = createStreetMap();
    const view = buildStreet(map, stubLabels(), { quality: 'low' });
    const island = view.ground.getObjectByName('sky-island')!;
    expect(MESHES(island)).toHaveLength(3);
    // The rim is the same rim either way: the low path is detail, not layout.
    const rock = MESHES(island).find((mesh) => mesh.name === 'sky-island:rock')!;
    const box = new Box3().setFromObject(rock);
    expect(box.max.x - box.min.x).toBeGreaterThan(ROCK_RADIUS * 1.8);
    view.dispose();
  });

  it('keeps the street origin, the plaza and the arena where they were', () => {
    // The rock is laid out around the map, never the other way round.
    expect(STREET_ORIGIN_X).toBe(29);
    const map = createStreetMap();
    expect(map.width).toBe(111);
    // D-134: the Garden arch moved south, so the map runs five rows deeper.
    expect(map.height).toBe(33);
  });
});
