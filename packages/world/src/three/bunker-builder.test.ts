import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { BUNKER_DOOR, BUNKER_STAIRWELL, BUNKER_VENDING } from '../map/bunker.js';
import { createStreetMap, type DistrictMap } from '../map/street.js';
import { createNullLabelFactory } from './labels.js';
import { PAVEMENT_HEIGHT, buildStreet, streetSurfaceHeightAt } from './street-builder.js';
import type { StreetView } from './types.js';

/**
 * The hidden stair in the street scene (D-107): three draw calls of its own
 * standing on its own tiles, no portal, no sign and no label anywhere that
 * names it.
 */

function build(map: DistrictMap = createStreetMap()): { map: DistrictMap; view: StreetView } {
  return { map, view: buildStreet(map, createNullLabelFactory()) };
}

function named(root: Object3D, name: string): Mesh | undefined {
  return root.getObjectByName(name) as Mesh | undefined;
}

describe('the hidden stair in the street scene (D-107)', () => {
  it('stands on its own three tiles, its lit parts no further, its neon spilling a step onto the pavement', () => {
    const { view } = build();
    view.ground.updateMatrixWorld(true);
    const body = named(view.ground, 'street:hidden-stair')!;
    const lights = named(view.ground, 'street:hidden-stair-lights')!;
    const glow = named(view.ground, 'street:hidden-stair-glow')!;
    for (const mesh of [body, lights, glow]) expect(mesh).toBeInstanceOf(Mesh);
    const solid = new Box3().setFromObject(body).union(new Box3().setFromObject(lights));
    expect(solid.min.x).toBeGreaterThanOrEqual(BUNKER_DOOR.x - 1e-6);
    expect(solid.max.x).toBeLessThanOrEqual(BUNKER_VENDING.x + 1 + 1e-6);
    expect(solid.min.z).toBeGreaterThanOrEqual(BUNKER_STAIRWELL.y - 1e-6);
    expect(solid.max.z).toBeLessThanOrEqual(BUNKER_DOOR.y + 1 + 1e-6);
    // Down a storey's worth of steps, and no taller than the vending machine and its cat.
    expect(solid.min.y).toBeLessThan(-1);
    expect(solid.max.y).toBeLessThan(2.3);
    const spill = new Box3().setFromObject(glow);
    expect(spill.max.z).toBeLessThanOrEqual(BUNKER_DOOR.y + 2);
    view.dispose();
  });

  it('has no door portal, no sign and no label: nothing on the street names it', () => {
    const { view } = build();
    expect(view.doors.children.some((child) => child.userData['building'] === 'bunker')).toBe(false);
    const texts: string[] = [];
    view.labels.traverse((object) => {
      if (object.userData['building'] === 'bunker' || object.userData['area'] === 'bunker') texts.push('tagged');
      if (typeof object.userData['text'] === 'string') texts.push(object.userData['text'] as string);
    });
    expect(texts).not.toContain('tagged');
    for (const text of texts) expect(text).not.toMatch(/bunker|gaming|hideout|secret|net ?cafe|ネットカフェ|ゲーム/i);
    // Nor does any label stand over the alley.
    view.labels.updateMatrixWorld(true);
    for (const label of view.labels.children) {
      const x = label.getWorldPosition(label.position.clone()).x;
      expect(x >= BUNKER_DOOR.x && x <= BUNKER_VENDING.x + 1, String(label.userData['text'])).toBe(false);
    }
    view.dispose();
  });

  it('costs the street three draw calls, and its top step is level with the pavement', () => {
    const { map, view } = build();
    let calls = 0;
    view.ground.traverse((object) => {
      if (object instanceof Mesh && object.name.startsWith('street:hidden-stair')) calls += 1;
    });
    expect(calls).toBe(3);
    expect(streetSurfaceHeightAt(map, BUNKER_DOOR.x + 0.5, BUNKER_DOOR.y + 0.5)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, BUNKER_VENDING.x + 0.5, BUNKER_VENDING.y + 0.5)).toBe(0);
    view.dispose();
  });

  it('breathes its neon slowly, never off', () => {
    const { view } = build();
    const material = named(view.ground, 'street:hidden-stair-glow')!.material as MeshBasicMaterial;
    const seen: number[] = [];
    for (let k = 0; k < 40; k++) {
      view.update(250);
      seen.push(material.opacity);
    }
    expect(Math.min(...seen)).toBeGreaterThan(0.5);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.1);
    view.dispose();
  });

  it('builds nothing on a map without the stair', () => {
    const map = createStreetMap();
    const plain: DistrictMap = {
      ...map,
      tiles: map.tiles.map((row, y) => row.map((kind, x) => (kind === 'stairhead' || kind === 'service' ? 'grass' : kind))),
      doors: map.doors.filter((door) => door.building !== 'bunker'),
    };
    const { view } = build(plain);
    expect(named(view.ground, 'street:hidden-stair')).toBeUndefined();
    view.dispose();
  });
});
