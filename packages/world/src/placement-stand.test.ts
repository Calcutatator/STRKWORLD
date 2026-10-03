import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Object3D } from 'three';
import {
  PLACEMENT_PATH,
  PLACEMENT_STAND,
  PLAZA_AREA,
  PLAZA_FIXTURES,
  PLAZA_NEARBY,
  PLAZA_PLACEMENT_STATION,
  PLAZA_STATIONS,
  hasPlacementStand,
  inPlazaRect,
  plazaStationAtApproach,
  plazaStations,
} from './map/plaza.js';
import { COLOSSEUM_AREA, COLOSSEUM_PATH } from './map/colosseum.js';
import { createStreetMap, isSolidAt } from './map/street.js';
import { createNullLabelFactory } from './three/labels.js';
import { PLACEMENT_BOARD_TEXT } from './three/plaza-builder.js';
import { buildStreet } from './three/street-builder.js';
import type { StreetView } from './three/types.js';

/**
 * Leaderboard phase 1: the placement stand, a small pedestal out on the
 * plaza's open east lawn with a one-tile paved path to it (D-122, amended
 * 2026-10-02), inside the plaza's camera frame, built only behind the Shell's
 * switch, and showing no placement of its own.
 */

/** Every tile of a rect. */
function tilesOf(rect: { x: number; y: number; width: number; height: number }): [number, number][] {
  const tiles: [number, number][] = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) tiles.push([x, y]);
  }
  return tiles;
}

/** The ring of tiles round a rect, which is where E answers. */
function ringOf(rect: { x: number; y: number; width: number; height: number }): [number, number][] {
  return tilesOf({ x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 })
    .filter(([x, y]) => !inPlazaRect(rect, x, y));
}

describe('the placement stand on the map', () => {
  it('is absent by default: the lawn is untouched', () => {
    const map = createStreetMap();
    expect(hasPlacementStand(map.tiles)).toBe(false);
    for (const [x, y] of [...tilesOf(PLACEMENT_PATH), ...tilesOf(PLACEMENT_STAND)]) {
      expect(map.tiles[y]![x], `${x},${y}`).toBe('grass');
    }
    expect(plazaStations()).toBe(PLAZA_STATIONS);
  });

  it('stands on one solid tile at the end of a one-tile paved path when switched on, in the plaza frame', () => {
    const map = createStreetMap({ placementStand: true });
    expect(hasPlacementStand(map.tiles)).toBe(true);
    expect(PLACEMENT_STAND).toEqual({ x: PLAZA_AREA.x + 15, y: 23, width: 1, height: 1 });
    expect(PLACEMENT_PATH).toEqual({ x: PLAZA_AREA.x + 11, y: 23, width: 4, height: 1 });
    for (const [x, y] of tilesOf(PLACEMENT_STAND)) {
      expect(isSolidAt(map, x, y)).toBe(true);
      expect(inPlazaRect(PLAZA_NEARBY, x, y)).toBe(true);
    }
    // The path is walkable plaza paving, one tile wide, running east along one row.
    expect(PLACEMENT_PATH.height).toBe(1);
    expect(PLACEMENT_PATH.y).toBe(PLACEMENT_STAND.y);
    for (const [x, y] of tilesOf(PLACEMENT_PATH)) {
      expect(map.tiles[y]![x], `${x},${y}`).toBe('plaza');
      expect(isSolidAt(map, x, y), `${x},${y}`).toBe(false);
    }
    // It starts against the plaza's east edge and ends in the pedestal's ring.
    expect(PLACEMENT_PATH.x).toBe(PLAZA_AREA.x + PLAZA_AREA.width);
    expect(map.tiles[PLACEMENT_PATH.y]![PLACEMENT_PATH.x - 1]).toBe('plaza');
    expect(PLACEMENT_PATH.x + PLACEMENT_PATH.width).toBe(PLACEMENT_STAND.x);
    const ring = ringOf(PLACEMENT_STAND).map(([x, y]) => `${x},${y}`);
    expect(ring).toContain(`${PLACEMENT_PATH.x + PLACEMENT_PATH.width - 1},${PLACEMENT_PATH.y}`);
    // Nothing else on the street changed, and the old apron's rows are grass again.
    const plain = createStreetMap();
    let changed = 0;
    plain.tiles.forEach((row, y) => row.forEach((kind, x) => { if (map.tiles[y]![x] !== kind) changed += 1; }));
    expect(changed).toBe(PLACEMENT_PATH.width * PLACEMENT_PATH.height + 1);
  });

  it('keeps its path and pedestal clear of every other fixture, station ring and path', () => {
    const map = createStreetMap({ placementStand: true });
    const mine = [...tilesOf(PLACEMENT_PATH), ...tilesOf(PLACEMENT_STAND)];
    const ring = new Set(ringOf(PLACEMENT_STAND).map(([x, y]) => `${x},${y}`));
    // Nothing of the plaza's own — benches, lamps, trees, planters, the monument, the table.
    for (const piece of PLAZA_FIXTURES) {
      for (const [x, y] of tilesOf(piece)) {
        expect(mine.some(([mx, my]) => mx === x && my === y), `${piece.kind} ${x},${y}`).toBe(false);
        expect(ring.has(`${x},${y}`), `${piece.kind} ${x},${y}`).toBe(false);
      }
    }
    // No other station's ring is touched, and none of them reaches the pedestal's.
    for (const station of PLAZA_STATIONS) {
      for (const [x, y] of ringOf(station)) {
        expect(mine.some(([mx, my]) => mx === x && my === y), `${station.station} ${x},${y}`).toBe(false);
        expect(ring.has(`${x},${y}`), `${station.station} ${x},${y}`).toBe(false);
      }
    }
    // Every ring tile is open ground the player can stand on.
    for (const [x, y] of ringOf(PLACEMENT_STAND)) expect(isSolidAt(map, x, y), `${x},${y}`).toBe(false);
    // West of the Avatar Studio's path, so the pit that branches off it (D-114) is clear too.
    const studio = map.avatarStudioEntrance;
    for (const [x] of [...mine, ...ringOf(PLACEMENT_STAND)]) expect(x).toBeLessThan(studio.x);
    expect(PLACEMENT_STAND.x + 1).toBeLessThan(Math.min(COLOSSEUM_AREA.x, COLOSSEUM_PATH.x));
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

  it('is walked to: the path joins the plaza to the ring, and both reach the spawn', () => {
    const map = createStreetMap({ placementStand: true });
    const open = new Set<string>([`${map.spawn.x},${map.spawn.y}`]);
    const queue = [map.spawn];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (isSolidAt(map, nx, ny) || open.has(`${nx},${ny}`)) continue;
        open.add(`${nx},${ny}`);
        queue.push({ x: nx, y: ny });
      }
    }
    for (const [x, y] of tilesOf(PLACEMENT_PATH)) expect(open.has(`${x},${y}`), `path ${x},${y}`).toBe(true);
    for (const [x, y] of ringOf(PLACEMENT_STAND)) expect(open.has(`${x},${y}`), `ring ${x},${y}`).toBe(true);
    // And each path tile touches the next, from the plaza's east edge to the ring.
    for (let x = PLACEMENT_PATH.x - 1; x < PLACEMENT_STAND.x; x++) {
      expect(isSolidAt(map, x, PLACEMENT_PATH.y), `${x}`).toBe(false);
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

  it('is a small pedestal: nothing of it leaves its tile or stands as tall as the monument', () => {
    const view = buildStreet(createStreetMap({ placementStand: true }), createNullLabelFactory());
    const mesh = view.ground.getObjectByName('plaza:placement-stand')!;
    const box = new Box3().setFromObject(mesh);
    expect(box.min.x).toBeGreaterThanOrEqual(PLACEMENT_STAND.x - 1e-6);
    expect(box.max.x).toBeLessThanOrEqual(PLACEMENT_STAND.x + PLACEMENT_STAND.width + 1e-6);
    expect(box.min.z).toBeGreaterThanOrEqual(PLACEMENT_STAND.y - 1e-6);
    expect(box.max.z).toBeLessThanOrEqual(PLACEMENT_STAND.y + PLACEMENT_STAND.height + 1e-6);
    // Lower than the plaza's lamps (2.97) and well under the monument's tip (5.05).
    expect(box.max.y).toBeLessThan(2.4);
    // The board hangs on it, inside the tile too.
    const board = labelsOf(view.labels).find((child) => child.userData['plaza'] === 'placement-board')!;
    expect(board.position.y).toBeLessThan(box.max.y);
    expect(board.position.z).toBeLessThan(PLACEMENT_STAND.y + PLACEMENT_STAND.height);
  });

  it('costs the plaza two more draw calls with the stand on, and the street stays inside its budget', () => {
    const count = (view: StreetView): number => {
      const labels = view.labels.children.filter((child) => child.userData['area'] === 'plaza');
      return view.ground.children.filter((child) => child.name.startsWith('plaza:')).length + labels.length;
    };
    const off = buildStreet(createStreetMap(), createNullLabelFactory());
    const on = buildStreet(createStreetMap({ placementStand: true }), createNullLabelFactory());
    // Its own merged mesh and its board, on top of D-123's eleven.
    expect(count(off)).toBe(11);
    expect(count(on)).toBe(13);
    let street = on.labels.children.length;
    for (const group of [on.ground, on.doors, on.labels]) {
      group.traverse((object) => { if (object instanceof Mesh) street += 1; });
    }
    expect(street).toBeLessThan(150);
    off.dispose();
    on.dispose();
  });
});
