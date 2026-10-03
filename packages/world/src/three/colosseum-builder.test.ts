import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3, type Material, type MeshBasicMaterial, type Object3D } from 'three';
import { COLOSSEUM_AREA, COLOSSEUM_DOOR, COLOSSEUM_GATEPOSTS, COLOSSEUM_PATH, colosseumTileAt } from '../map/colosseum.js';
import { createStreetMap, isSolidAt, type DistrictMap, type TileKind } from '../map/street.js';
import {
  COLOSSEUM_ARCH_SPRING,
  COLOSSEUM_SIGN_TEXT,
  COLOSSEUM_WALL_TOP,
  arenaFlameOpacity,
  type ColosseumOccluder,
} from './colosseum-builder.js';
import * as colosseumStyle from './colosseum-style.js';
import { COLOSSEUM_ARCADE_TOP, COLOSSEUM_ATTIC_TOP, COLOSSEUM_PLINTH } from './colosseum-style.js';
import { createNullLabelFactory } from './labels.js';
import { PAVEMENT_HEIGHT, buildStreet, streetSurfaceHeightAt, type StreetOccluder } from './street-builder.js';
import type { StreetView } from './types.js';

/**
 * The Colosseum in the street scene (D-114, D-129): four draw calls of its
 * own, nothing in the way on a walkable tile, a shell and a grand arch that
 * fade as two occluders with a box per row (so no corner of the oval is an
 * invisible wall), a silhouette that tops out where the arena room's own wall
 * does, and cressets that flicker, deterministically, and never go out.
 */

function build(map: DistrictMap = createStreetMap(), reducedMotion?: () => boolean): { map: DistrictMap; view: StreetView } {
  return { map, view: buildStreet(map, createNullLabelFactory(), reducedMotion ? { reducedMotion } : {}) };
}

/** The same district with the building scrubbed off it: bare lawn and no door. */
function withoutColosseum(map: DistrictMap): DistrictMap {
  const colosseum = (kind: TileKind): boolean => kind === 'colwall' || kind === 'colcore' || kind === 'colstep';
  return {
    ...map,
    tiles: map.tiles.map((row) => row.map((kind) => (colosseum(kind) ? 'grass' : kind))),
    doors: map.doors.filter((door) => door.building !== 'arena'),
  };
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

describe('the Colosseum in the street scene (D-114, D-129)', () => {
  it('costs the street four draw calls: stone, the grand arch, flames and the nameplate', () => {
    const { map, view } = build();
    const meshes: string[] = [];
    view.ground.traverse((object) => {
      if (object instanceof Mesh && object.name.startsWith('colosseum:')) meshes.push(object.name);
    });
    expect(meshes.sort()).toEqual(['colosseum:arch', 'colosseum:flames', 'colosseum:stone']);
    const signs = view.labels.children.filter((child) => child.userData['area'] === 'colosseum');
    expect(signs).toHaveLength(1);
    // The sign reads COLOSSEUM, not the pit's old "GLADIATOR PIT": the lot now
    // carries the building the arena room is the inside of.
    expect(signs[0]!.userData['text']).toBe(COLOSSEUM_SIGN_TEXT);
    expect(COLOSSEUM_SIGN_TEXT).toBe('COLOSSEUM');
    // The whole street stays inside its budget, four calls above the street
    // without the building.
    const without = build(withoutColosseum(map)).view;
    expect(named(without.ground, 'colosseum:stone')).toBeUndefined();
    expect(streetCalls(view)).toBe(streetCalls(without) + 4);
    // Headroom, not the building's own cost: the south vista's six merged
    // meshes (D-124) and the sky island's five (D-132) joined the street's
    // ground group since.
    expect(streetCalls(view)).toBeLessThanOrEqual(101);
    expect(streetCalls(view)).toBeLessThan(150);
    without.dispose();
    view.dispose();
  });

  it('stands only on its own lot, and nothing of it hangs over a walkable tile', () => {
    const { map, view } = build();
    for (const name of ['colosseum:stone', 'colosseum:arch', 'colosseum:flames']) {
      const mesh = named(view.ground, name)!;
      expect(intrusions(mesh, map), name).toEqual([]);
      // On its lot but for the cornices and the banners' rods, which stand a
      // hand proud of the wall high above any head.
      const PROUD = 0.2;
      const box = new Box3().setFromObject(mesh);
      expect(box.min.x, name).toBeGreaterThanOrEqual(COLOSSEUM_AREA.x - PROUD);
      expect(box.max.x, name).toBeLessThanOrEqual(COLOSSEUM_AREA.x + COLOSSEUM_AREA.width + PROUD);
      expect(box.min.z, name).toBeGreaterThanOrEqual(COLOSSEUM_AREA.y - PROUD);
      expect(box.max.z, name).toBeLessThanOrEqual(COLOSSEUM_AREA.y + COLOSSEUM_AREA.height + PROUD);
    }
    // The whole threshold is level with the pavement; the lot east of it is
    // solid ground level, as the branch path approaching it is.
    for (let row = 0; row < COLOSSEUM_DOOR.height; row++) {
      expect(streetSurfaceHeightAt(map, COLOSSEUM_DOOR.x + 0.5, COLOSSEUM_DOOR.y + row + 0.5), `row ${row}`).toBe(PAVEMENT_HEIGHT);
    }
    expect(streetSurfaceHeightAt(map, COLOSSEUM_DOOR.x + 1.5, COLOSSEUM_DOOR.y + 0.5)).toBe(0);
    // The branch to the arch is a flush path across the lawn, not a kerbed
    // sidewalk, so it must not raise the Studio's path it leaves (D-114).
    expect(streetSurfaceHeightAt(map, COLOSSEUM_PATH.x + 0.5, COLOSSEUM_PATH.y + 1.5)).toBe(0);
    view.dispose();
  });

  it('rises as a landmark, to the same height the arena room\'s own wall reaches', () => {
    const { view } = build();
    const stone = new Box3().setFromObject(named(view.ground, 'colosseum:stone')!);
    // An arcade, an attic and a cornice: the wall tops out at exactly the
    // height arena-room.ts carries its attic colonnade to, so standing inside
    // and standing outside are the same building.
    // The wall caps at `COLOSSEUM_WALL_TOP`; only the four cressets standing
    // on its cornice rise past it, and not by much.
    expect(stone.max.y).toBeGreaterThanOrEqual(COLOSSEUM_WALL_TOP);
    expect(stone.max.y).toBeLessThan(COLOSSEUM_WALL_TOP + 0.8);
    expect(COLOSSEUM_ATTIC_TOP).toBeLessThan(COLOSSEUM_WALL_TOP);
    // Nothing of it is sunk: the pit's bowl went below the lawn, the building
    // stands on it.
    expect(stone.min.y).toBeGreaterThan(-0.1);
    const arch = new Box3().setFromObject(named(view.ground, 'colosseum:arch')!);
    expect(arch.max.y).toBeCloseTo(COLOSSEUM_WALL_TOP, 1);
    view.dispose();
  });

  it('stands two floors, not three, and lets the street behind it be seen over it (D-129 amended 2026-10-03)', () => {
    // The middle storey of arches came off: the stack is the ground arcade and
    // the attic over it, and nothing between them.
    expect(COLOSSEUM_PLINTH).toBeLessThan(COLOSSEUM_ARCADE_TOP);
    expect(COLOSSEUM_ARCADE_TOP).toBe(2.5);
    expect(COLOSSEUM_ATTIC_TOP).toBe(4.6);
    expect(COLOSSEUM_WALL_TOP).toBe(4.8);
    // No third floor hiding in the shared heights: one arcade top, one attic.
    expect(Object.keys(colosseumStyle).filter((key) => /TIER|STOREY/.test(key))).toEqual([]);
    // The ground arcade is exactly what it was, so the grand arch under it and
    // the arches either side of it read as they did.
    expect(COLOSSEUM_ARCADE_TOP - COLOSSEUM_PLINTH).toBeCloseTo(2.05, 5);
    expect(COLOSSEUM_ARCH_SPRING).toBe(1.9);

    // The lead's complaint: it hid the buildings across the street. Every
    // shopfront on the far side of the road now stands taller than the wall.
    const { view } = build();
    const behind = (view.occluders as readonly StreetOccluder[]).filter(
      (occluder) => occluder.kind === 'building' && occluder.bounds.maxZ <= COLOSSEUM_AREA.y - 1,
    );
    expect(behind.length).toBeGreaterThan(3);
    for (const building of behind) {
      expect(building.bounds.height, `a building at z ${building.bounds.minZ}`).toBeGreaterThan(COLOSSEUM_WALL_TOP);
    }
    view.dispose();
  });

  it('clears every head under the grand arch, and fades its shell and arch as two occluders', () => {
    const { map, view } = build();
    const arch = named(view.ground, 'colosseum:arch')!;
    const stone = named(view.ground, 'colosseum:stone')!;
    // Over the threshold the arch is all above the spring line.
    expect(intrusions(arch, map, { min: 0, max: COLOSSEUM_ARCH_SPRING - 0.01 })).toEqual([]);

    const occluders = (view.occluders as readonly StreetOccluder[]).filter(
      (occluder): occluder is ColosseumOccluder => occluder.kind === 'colosseum',
    );
    expect(occluders.map((occluder) => occluder.part).sort()).toEqual(['arch', 'shell']);
    const shell = occluders.find((occluder) => occluder.part === 'shell')!;
    const gate = occluders.find((occluder) => occluder.part === 'arch')!;
    expect(shell.object).toBe(stone);
    expect(gate.object).toBe(arch);

    // The shell fades per row, so the oval's rounded east end is not a square
    // invisible wall to the camera's sight lines either — and every tile under
    // one of those boxes is solid, so a player can never stand inside one.
    expect(shell.boxes!).toHaveLength(COLOSSEUM_AREA.height);
    for (const box of shell.boxes!) {
      expect(box.height).toBe(COLOSSEUM_WALL_TOP);
      for (let x = Math.floor(box.minX); x < box.maxX; x++) {
        for (let y = Math.floor(box.minZ); y < box.maxZ; y++) {
          expect(isSolidAt(map, x, y), `(${x}, ${y}) under the shell`).toBe(true);
        }
      }
    }
    // The rows are not all the same width: row 20 and the three door rows end
    // in different columns, which is what a per-row occluder is for.
    expect(new Set(shell.boxes!.map((box) => box.maxX)).size).toBeGreaterThan(1);

    // The grand arch's own boxes: a pier either side of the opening, and over
    // the opening only what stands above the spring line.
    expect(gate.boxes!).toHaveLength(3);
    const [north, south] = COLOSSEUM_GATEPOSTS;
    expect(gate.bounds.minZ).toBeLessThanOrEqual(north!.y);
    expect(gate.bounds.maxZ).toBeGreaterThanOrEqual(south!.y + 1);
    // And only through the door's own column in x.
    expect(gate.bounds.minX).toBeGreaterThanOrEqual(COLOSSEUM_DOOR.x);
    expect(gate.bounds.maxX).toBeLessThanOrEqual(COLOSSEUM_DOOR.x + 1);
    const span = gate.boxes!.find((box) => box.minZ === COLOSSEUM_DOOR.y && box.maxZ === COLOSSEUM_DOOR.y + COLOSSEUM_DOOR.height)!;
    expect(span.minY).toBe(COLOSSEUM_ARCH_SPRING);

    // Each fades its own materials and nothing else: the shell takes its
    // nameplate with it (both stand on the south face), the arch goes alone.
    const archMaterials = materialsOf(arch);
    const shellMaterials = [...materialsOf(stone), ...materialsOf(view.labels.children.find((child) => child.userData['area'] === 'colosseum')!)];
    const all = materialsOf(view.ground);
    gate.setOpacity(0.3);
    for (const material of archMaterials) expect(material.opacity).toBeCloseTo(0.3);
    for (const material of shellMaterials) expect(material.opacity).toBe(1);
    gate.setOpacity(1);
    shell.setOpacity(0.4);
    for (const material of shellMaterials) expect(material.opacity).toBeCloseTo(0.4);
    for (const material of all.filter((material) => !shellMaterials.includes(material))) expect(material.opacity).toBe(1);
    shell.setOpacity(1);
    for (const material of all) expect(material.opacity).toBe(1);
    view.dispose();
  });

  it('has no door portal: its grand arch is its door', () => {
    const { view } = build();
    expect(view.doors.children.some((child) => child.userData['building'] === 'arena')).toBe(false);
    view.dispose();
  });

  it('flickers its cressets deterministically, never out, slower for reduced motion', () => {
    const sample = (reduced: boolean): number[] => {
      const { view } = build(createStreetMap(), () => reduced);
      const material = named(view.ground, 'colosseum:flames')!.material as MeshBasicMaterial;
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

  it('draws masonry on every solid tile of the lot: no corner is an invisible wall', () => {
    const { map, view } = build();
    const stone = named(view.ground, 'colosseum:stone')!;
    stone.updateMatrixWorld(true);
    // Every tile the map calls wall or core carries geometry above the lawn.
    const position = stone.geometry.getAttribute('position');
    const covered = new Set<string>();
    const p = new Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(stone.matrixWorld);
      if (p.y < 0.2) continue;
      covered.add(`${Math.floor(p.x)},${Math.floor(p.z)}`);
    }
    const missing: string[] = [];
    for (let y = COLOSSEUM_AREA.y; y < COLOSSEUM_AREA.y + COLOSSEUM_AREA.height; y++) {
      for (let x = COLOSSEUM_AREA.x; x < COLOSSEUM_AREA.x + COLOSSEUM_AREA.width; x++) {
        const kind = colosseumTileAt(x, y);
        if (kind !== 'colwall' && kind !== 'colcore') continue;
        expect(isSolidAt(map, x, y), `(${x}, ${y}) is solid`).toBe(true);
        // A tile's own column, or either of its neighbours' — a vertex on a
        // shared edge rounds into the tile next door.
        const near = [`${x},${y}`, `${x - 1},${y}`, `${x},${y - 1}`, `${x - 1},${y - 1}`];
        if (!near.some((key) => covered.has(key))) missing.push(`${x},${y}`);
      }
    }
    expect(missing).toEqual([]);
    view.dispose();
  });

  it('builds nothing on a map without the building', () => {
    const { view } = build(withoutColosseum(createStreetMap()));
    expect(named(view.ground, 'colosseum:stone')).toBeUndefined();
    expect(named(view.ground, 'colosseum:arch')).toBeUndefined();
    expect(view.labels.children.some((child) => child.userData['area'] === 'colosseum')).toBe(false);
    view.dispose();
  });
});
