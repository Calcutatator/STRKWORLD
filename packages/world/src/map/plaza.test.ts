import { describe, expect, it } from 'vitest';
import { PITCH_AREA, SANDBOX_AREA, STREET_ORIGIN_X } from '@strkworld/shared';
import {
  PLAZA_AREA,
  PLAZA_FIXTURES,
  PLAZA_MONUMENT_STATION,
  PLAZA_NEARBY,
  PLAZA_SHELLS_STATION,
  PLAZA_SIGN_TEXT,
  PLAZA_STATIONS,
  inPlazaRect,
  isPlazaNearby,
  plazaStationAtApproach,
  type PlazaRect,
} from './plaza.js';
import { createStreetMap, isSolidAt, TILES } from './street.js';

/**
 * The Privacy Plaza's layout (D-076): where it sits, what is solid, and that
 * a player can walk in from the pavement and reach both stations.
 */

const map = createStreetMap();
/** D-078: the street's first column; the plaza is laid out from it. */
const X = STREET_ORIGIN_X;

function tilesOf(rect: PlazaRect): [number, number][] {
  const tiles: [number, number][] = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) tiles.push([x, y]);
  }
  return tiles;
}

/** Every walkable street tile reachable from spawn. */
function reachable(): Set<string> {
  const seen = new Set<string>([`${map.spawn.x},${map.spawn.y}`]);
  const queue = [map.spawn];
  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (isSolidAt(map, nx, ny) || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}

function approachOf(rect: PlazaRect): [number, number][] {
  return tilesOf({ x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 })
    .filter(([x, y]) => !inPlazaRect(rect, x, y));
}

describe('the Privacy Plaza is placed on the street (D-076)', () => {
  it('paves the street\'s x 0-10, y 19-27: the empty grass below the south pavement at its west end', () => {
    expect(PLAZA_AREA).toEqual({ x: X, y: 19, width: 11, height: 9 });
    // D-134 pushed the map's south edge five rows further out for the
    // Garden's gate; the plaza keeps its own nine rows and the south lawn
    // now runs on below it.
    expect(PLAZA_AREA.y + PLAZA_AREA.height).toBe(map.height - 5);
    expect(map.tiles[PLAZA_AREA.y + PLAZA_AREA.height]![PLAZA_AREA.x]).toBe('grass');
    for (const [x, y] of tilesOf(PLAZA_AREA)) {
      expect(['plaza', 'plinth'], `${x},${y}`).toContain(map.tiles[y]![x]);
    }
    // The south pavement runs along its whole north edge.
    for (let x = PLAZA_AREA.x; x < PLAZA_AREA.x + PLAZA_AREA.width; x++) {
      expect(map.tiles[PLAZA_AREA.y - 1]![x], `pavement ${x}`).toBe('pavement');
    }
    // And the grass is still grass beside it.
    expect(map.tiles[22]![PLAZA_AREA.x + PLAZA_AREA.width]).toBe('grass');
  });

  it('keeps the plaza walkable and its furniture solid', () => {
    expect(TILES.plaza.solid).toBe(false);
    expect(TILES.plinth.solid).toBe(true);
    const walkable = tilesOf(PLAZA_AREA).filter(([x, y]) => map.tiles[y]![x] === 'plaza');
    // 99 tiles, 30 of them under furniture.
    expect(walkable).toHaveLength(PLAZA_AREA.width * PLAZA_AREA.height - 30);
    const open = reachable();
    for (const [x, y] of walkable) expect(open.has(`${x},${y}`), `${x},${y}`).toBe(true);
  });

  it('is entered from the south pavement through its gateway', () => {
    const [west, east] = PLAZA_FIXTURES.filter((piece) => piece.kind === 'arch-post');
    expect(west).toMatchObject({ x: X + 3, y: 19 });
    expect(east).toMatchObject({ x: X + 7, y: 19 });
    for (let x = west!.x + 1; x < east!.x; x++) {
      expect(isSolidAt(map, x, PLAZA_AREA.y), `gateway ${x}`).toBe(false);
      expect(map.tiles[PLAZA_AREA.y - 1]![x]).toBe('pavement');
    }
    // Planters close the rest of the pavement side.
    for (let x = PLAZA_AREA.x; x < PLAZA_AREA.x + PLAZA_AREA.width; x++) {
      if (x > west!.x && x < east!.x) continue;
      expect(isSolidAt(map, x, PLAZA_AREA.y), `north edge ${x}`).toBe(true);
    }
  });

  it('stays clear of the Avatar Studio path, the spawn, every door and the sandbox', () => {
    const studio = map.avatarStudioEntrance;
    for (const rect of [PLAZA_AREA, PLAZA_NEARBY]) {
      expect(rect.x + rect.width).toBeLessThan(studio.x);
      expect(inPlazaRect(rect, map.spawn.x, map.spawn.y)).toBe(false);
      for (const door of map.doors) expect(inPlazaRect(rect, door.x, door.y), door.building).toBe(false);
    }
    // The Studio's path is untouched pavement all the way down.
    for (let y = 17; y < map.height; y++) {
      expect(map.tiles[y]![studio.x]).toBe('pavement');
      expect(map.tiles[y]![studio.x + 1]).toBe('pavement');
    }
    expect(PLAZA_AREA.x + PLAZA_AREA.width).toBeLessThan(SANDBOX_AREA.x - 1);
  });

  it('moved east with the street and nowhere else when the pitch square took the road\'s west end (D-078)', () => {
    // D-076's layout, counted from the street's first column: nothing in it moved.
    const layout = PLAZA_FIXTURES.map(({ kind, x, y, width, height }) => [kind, x - X, y, width, height]);
    expect(layout).toEqual([
      ['monument', 4, 22, 3, 3],
      ['table', 9, 23, 1, 1],
      ['arch-post', 3, 19, 1, 1],
      ['arch-post', 7, 19, 1, 1],
      ['planter', 0, 19, 3, 1],
      ['planter', 8, 19, 3, 1],
      ['tree', 0, 20, 1, 1],
      ['tree', 10, 20, 1, 1],
      ['bench', 0, 23, 1, 2],
      ['bench', 10, 25, 1, 2],
      ['bench', 2, 27, 2, 1],
      ['bench', 7, 27, 2, 1],
      ['lamp', 0, 27, 1, 1],
      ['lamp', 10, 27, 1, 1],
    ]);
    expect(PLAZA_STATIONS.map(({ x, y }) => [x - X, y])).toEqual([[4, 22], [9, 23]]);
    expect(PLAZA_NEARBY).toEqual({ x: X, y: 14, width: 16, height: 14 });
    // The pitch square and its fence lie wholly west of it: the fence is its west neighbour.
    expect(PLAZA_AREA.x).toBeGreaterThan(PITCH_AREA.x + PITCH_AREA.width);
    for (let y = PLAZA_AREA.y; y < PLAZA_AREA.y + PLAZA_AREA.height; y++) {
      expect(map.tiles[y]![PLAZA_AREA.x - 1], `fence ${y}`).toBe('railing');
    }
  });

  it('puts every fixture on its own solid plinth tiles inside the plaza', () => {
    const owner = new Map<string, string>();
    for (const piece of PLAZA_FIXTURES) {
      for (const [x, y] of tilesOf(piece)) {
        expect(inPlazaRect(PLAZA_AREA, x, y), `${piece.kind} ${x},${y}`).toBe(true);
        expect(map.tiles[y]![x], `${piece.kind} ${x},${y}`).toBe('plinth');
        expect(owner.has(`${x},${y}`), `${piece.kind} overlaps ${owner.get(`${x},${y}`)}`).toBe(false);
        owner.set(`${x},${y}`, piece.kind);
      }
    }
    // Every plinth tile belongs to a fixture.
    for (const [x, y] of tilesOf(PLAZA_AREA)) {
      if (map.tiles[y]![x] === 'plinth') expect(owner.has(`${x},${y}`), `${x},${y}`).toBe(true);
    }
    expect(PLAZA_FIXTURES.map((piece) => piece.kind)).toEqual(expect.arrayContaining(['monument', 'table', 'bench', 'lamp', 'tree', 'planter']));
  });

  it('has a monument and a shell-game table as its two stations, on their fixtures', () => {
    expect(PLAZA_STATIONS.map((station) => station.station)).toEqual([PLAZA_MONUMENT_STATION, PLAZA_SHELLS_STATION]);
    expect(PLAZA_MONUMENT_STATION).toBe('plaza:monument');
    expect(PLAZA_SHELLS_STATION).toBe('plaza:shells');
    const monument = PLAZA_FIXTURES.find((piece) => piece.kind === 'monument')!;
    const table = PLAZA_FIXTURES.find((piece) => piece.kind === 'table')!;
    expect(PLAZA_STATIONS[0]).toMatchObject({ x: monument.x, y: monument.y, width: monument.width, height: monument.height });
    expect(PLAZA_STATIONS[1]).toMatchObject({ x: table.x, y: table.y, width: table.width, height: table.height });
    // The monument is the centrepiece.
    expect(monument.x + monument.width / 2).toBe(PLAZA_AREA.x + PLAZA_AREA.width / 2);
    expect(monument.y + monument.height / 2).toBe(PLAZA_AREA.y + PLAZA_AREA.height / 2);
  });

  it('leaves each station an open, reachable approach that no other station shares', () => {
    const open = reachable();
    const seen = new Map<string, string>();
    for (const station of PLAZA_STATIONS) {
      const approach = approachOf(station);
      const standable = approach.filter(([x, y]) => open.has(`${x},${y}`));
      // Nothing solid stands in an approach.
      expect(standable, station.station).toHaveLength(approach.length);
      for (const [x, y] of approach) {
        expect(plazaStationAtApproach(x, y)?.station, `${x},${y}`).toBe(station.station);
        expect(seen.has(`${x},${y}`), `${station.station} shares ${x},${y} with ${seen.get(`${x},${y}`)}`).toBe(false);
        seen.set(`${x},${y}`, station.station);
      }
      // Standing on the station itself is not an approach.
      expect(plazaStationAtApproach(station.x, station.y)).toBeNull();
    }
    expect(plazaStationAtApproach(map.spawn.x, map.spawn.y)).toBeNull();
    expect(plazaStationAtApproach(X + 5, 20)).toBeNull();
  });

  it('counts the plaza near from the road, the south pavement and the plaza itself', () => {
    for (const [x, y] of tilesOf(PLAZA_AREA)) expect(isPlazaNearby(x, y), `${x},${y}`).toBe(true);
    expect(isPlazaNearby(X + 5, 17)).toBe(true);
    expect(isPlazaNearby(X + 5, 14)).toBe(true);
    // From the north pavement the camera looks away from it; the spawn is far off.
    expect(isPlazaNearby(X + 5, 12)).toBe(false);
    expect(isPlazaNearby(map.spawn.x, map.spawn.y)).toBe(false);
    expect(isPlazaNearby(X + 30, 20)).toBe(false);
    // Nor from the pitch square, west past its fence.
    expect(isPlazaNearby(X - 3, 20)).toBe(false);
  });

  it('names itself on the gateway sign', () => {
    expect(PLAZA_SIGN_TEXT.split('\n')[0]).toBe('PRIVACY PLAZA');
  });
});
