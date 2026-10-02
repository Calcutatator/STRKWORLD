import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  PLACEMENT_APRON,
  PLACEMENT_STAND,
  PLAZA_NEARBY,
  PLAZA_PLACEMENT_STATION,
  PLAZA_STATIONS,
  hasPlacementStand,
  inPlazaRect,
  plazaStationAtApproach,
  plazaStations,
} from './map/plaza.js';
import { createStreetMap, isSolidAt } from './map/street.js';
import { createNullLabelFactory } from './three/labels.js';
import { PLACEMENT_BOARD_TEXT } from './three/plaza-builder.js';
import { buildStreet } from './three/street-builder.js';

/**
 * Leaderboard phase 1: the placement stand east of the plaza, on its own
 * apron, inside the plaza's camera frame, built only behind the Shell's
 * switch, and showing no placement of its own.
 */

describe('the placement stand on the map', () => {
  it('is absent by default: the lawn is untouched', () => {
    const map = createStreetMap();
    expect(hasPlacementStand(map.tiles)).toBe(false);
    for (let x = PLACEMENT_APRON.x; x < PLACEMENT_APRON.x + PLACEMENT_APRON.width; x++) {
      for (let y = PLACEMENT_APRON.y; y < PLACEMENT_APRON.y + PLACEMENT_APRON.height; y++) {
        expect(map.tiles[y]![x], `${x},${y}`).toBe('grass');
      }
    }
    expect(plazaStations()).toBe(PLAZA_STATIONS);
  });

  it('stands on two solid tiles on a paved apron when switched on, in the plaza frame', () => {
    const map = createStreetMap({ placementStand: true });
    expect(hasPlacementStand(map.tiles)).toBe(true);
    for (let x = PLACEMENT_STAND.x; x < PLACEMENT_STAND.x + PLACEMENT_STAND.width; x++) {
      expect(isSolidAt(map, x, PLACEMENT_STAND.y)).toBe(true);
      expect(inPlazaRect(PLAZA_NEARBY, x, PLACEMENT_STAND.y)).toBe(true);
    }
    // Every apron tile but the stand's is walkable paving.
    for (let x = PLACEMENT_APRON.x; x < PLACEMENT_APRON.x + PLACEMENT_APRON.width; x++) {
      for (let y = PLACEMENT_APRON.y; y < PLACEMENT_APRON.y + PLACEMENT_APRON.height; y++) {
        if (inPlazaRect(PLACEMENT_STAND, x, y)) continue;
        expect(map.tiles[y]![x], `${x},${y}`).toBe('plaza');
      }
    }
    // Nothing else on the street changed.
    const plain = createStreetMap();
    let changed = 0;
    plain.tiles.forEach((row, y) => row.forEach((kind, x) => { if (map.tiles[y]![x] !== kind) changed += 1; }));
    expect(changed).toBe(PLACEMENT_APRON.width * PLACEMENT_APRON.height);
  });

  it('has an approach ring of its own, so E is never ambiguous', () => {
    const stations = plazaStations({ placementStand: true });
    expect(stations.map((station) => station.station)).toEqual([...PLAZA_STATIONS.map((station) => station.station), PLAZA_PLACEMENT_STATION]);
    for (let x = PLACEMENT_STAND.x - 1; x <= PLACEMENT_STAND.x + PLACEMENT_STAND.width; x++) {
      for (let y = PLACEMENT_STAND.y - 1; y <= PLACEMENT_STAND.y + PLACEMENT_STAND.height; y++) {
        if (inPlazaRect(PLACEMENT_STAND, x, y)) continue;
        expect(plazaStationAtApproach(x, y, stations)?.station, `${x},${y}`).toBe(PLAZA_PLACEMENT_STATION);
        expect(plazaStationAtApproach(x, y), `${x},${y}`).toBeNull();
      }
    }
  });
});

describe('the placement stand in 3D', () => {
  const labelsOf = (root: Object3D) => root.children.filter((child) => child.userData['area'] === 'plaza');

  it('builds a scoreboard whose board shows a title and hidden digits, never a placement', () => {
    const view = buildStreet(createStreetMap({ placementStand: true }), createNullLabelFactory());
    const board = labelsOf(view.labels).find((child) => child.userData['plaza'] === 'placement-board');
    expect(board).toBeDefined();
    expect(PLACEMENT_BOARD_TEXT).not.toMatch(/[0-9]/);
    expect(board!.position.x).toBeCloseTo(PLACEMENT_STAND.x + PLACEMENT_STAND.width / 2);
  });

  it('is one mesh of its own, tagged with its station, for the interaction cue to find', () => {
    const view = buildStreet(createStreetMap({ placementStand: true }), createNullLabelFactory());
    const mesh = view.ground.getObjectByName('plaza:placement-stand');
    expect(mesh?.userData['station']).toBe(PLAZA_PLACEMENT_STATION);
    expect(buildStreet(createStreetMap(), createNullLabelFactory()).ground.getObjectByName('plaza:placement-stand')).toBeUndefined();
  });

  it('builds nothing of it without the switch', () => {
    const view = buildStreet(createStreetMap(), createNullLabelFactory());
    expect(labelsOf(view.labels).some((child) => child.userData['plaza'] === 'placement-board')).toBe(false);
  });

  it('glows like the other plaza stations: its pieces join the affordance shells, and none without the switch (D-123)', () => {
    const on = buildStreet(createStreetMap({ placementStand: true }), createNullLabelFactory());
    expect(on.plaza!.affordances!.ids).toContain(PLAZA_PLACEMENT_STATION);
    const off = buildStreet(createStreetMap(), createNullLabelFactory());
    expect(off.plaza!.affordances?.ids ?? []).not.toContain(PLAZA_PLACEMENT_STATION);
  });
});
