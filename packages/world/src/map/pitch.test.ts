import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_KICK_RANGE,
  PITCH_AREA,
  PITCH_FIELD,
  PITCH_GOAL,
  SANDBOX_AREA,
  SANDBOX_ENTRANCE,
  STREET_ORIGIN_X,
  type TileRect,
} from '@strkworld/shared';
import {
  PITCH_CENTRE_SPOT,
  PITCH_FIXTURES,
  PITCH_GATE,
  PITCH_MIDDLE_Z,
  inPitchRect,
  isPitchTile,
  pitchScoreText,
  pitchWinnerText,
  withinKickRange,
} from './pitch.js';
import { createStreetMap, isSolidAt, TILES, TILE_SIZE } from './street.js';

/**
 * The football pitch square's layout (D-078): where it sits, what is solid,
 * and that a player walks in through the gate onto a walkway round a field
 * they can cross from end to end.
 */

const map = createStreetMap();

function tilesOf(rect: TileRect): [number, number][] {
  const tiles: [number, number][] = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) tiles.push([x, y]);
  }
  return tiles;
}

const inGate = (y: number): boolean => y >= PITCH_GATE.y && y < PITCH_GATE.y + PITCH_GATE.height;

/** Every walkable tile reachable from spawn, optionally with the pitch gate shut. */
function reachable(gateShut = false): Set<string> {
  const solid = (x: number, y: number) => isSolidAt(map, x, y) || (gateShut && x === PITCH_GATE.x && inGate(y));
  const seen = new Set<string>([`${map.spawn.x},${map.spawn.y}`]);
  const queue = [map.spawn];
  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (solid(nx, ny) || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe('the pitch square at the road\'s west end (D-078)', () => {
  it('is as big as the sandbox square, at the other end of the road', () => {
    expect(PITCH_AREA).toEqual({ x: 0, y: 0, width: 28, height: 28 });
    expect([PITCH_AREA.width, PITCH_AREA.height]).toEqual([SANDBOX_AREA.width, SANDBOX_AREA.height]);
    expect(PITCH_AREA.x).toBe(0);
    expect(SANDBOX_AREA.x + SANDBOX_AREA.width).toBe(map.width);
    // Its fence stands one tile east of it, as the sandbox's wall stands one tile west of it.
    expect(PITCH_GATE.x).toBe(PITCH_AREA.x + PITCH_AREA.width);
    expect(STREET_ORIGIN_X).toBe(PITCH_GATE.x + 1);
    for (const [x, y] of tilesOf(PITCH_AREA)) {
      expect(['turf', 'walkway', 'footing'], `${x},${y}`).toContain(map.tiles[y]![x]);
    }
  });

  it('walls its street side except for the gate, in line with the road and both pavements', () => {
    for (let y = 0; y < map.height; y++) {
      expect(isSolidAt(map, PITCH_GATE.x, y), `row ${y}`).toBe(!inGate(y));
      if (!inGate(y)) expect(map.tiles[y]![PITCH_GATE.x]).toBe('railing');
    }
    const street: number[] = [];
    for (let y = 0; y < map.height; y++) {
      const kind = map.tiles[y]![PITCH_GATE.x + 1];
      if (kind === 'road' || kind === 'pavement') street.push(y);
    }
    expect(street[0]).toBe(PITCH_GATE.y);
    expect(street).toHaveLength(PITCH_GATE.height);
    // The same rows as the sandbox's gate at the other end.
    expect([PITCH_GATE.y, PITCH_GATE.height]).toEqual([SANDBOX_ENTRANCE.y, SANDBOX_ENTRANCE.height]);
    // The road runs through the gate itself.
    for (let y = PITCH_GATE.y; y < PITCH_GATE.y + PITCH_GATE.height; y++) {
      expect(['road', 'pavement']).toContain(map.tiles[y]![PITCH_GATE.x]);
    }
    expect(TILES.railing.solid).toBe(true);
  });

  it('opens the gate onto the walkway, clear of both goals', () => {
    for (let y = PITCH_GATE.y; y < PITCH_GATE.y + PITCH_GATE.height; y++) {
      const inside = PITCH_GATE.x - 1;
      expect(map.tiles[y]![inside], `inside the gate ${y}`).toBe('walkway');
      expect(map.tiles[y]![inside - 1], `a step further ${y}`).toBe('walkway');
    }
    // The east goal stands between the gate and the field: the walkway goes round it.
    const east = PITCH_FIXTURES.find((piece) => piece.kind === 'goal' && piece.side === 'east')!;
    expect(east.x + east.width).toBeLessThan(PITCH_GATE.x - 1);
  });

  it('reaches every walkable pitch tile from spawn, and only through the gate', () => {
    const open = reachable();
    const shut = reachable(true);
    for (const [x, y] of tilesOf(PITCH_AREA)) {
      if (isSolidAt(map, x, y)) continue;
      expect(open.has(`${x},${y}`), `${x},${y}`).toBe(true);
      expect(shut.has(`${x},${y}`), `${x},${y}`).toBe(false);
    }
  });

  it('lays the field as walkable turf, east to west, with the centre spot on the road\'s line', () => {
    expect(PITCH_FIELD.width).toBeGreaterThan(PITCH_FIELD.height);
    expect(TILES.turf.solid).toBe(false);
    for (const [x, y] of tilesOf(PITCH_FIELD)) expect(map.tiles[y]![x], `${x},${y}`).toBe('turf');
    // A walkway all round it.
    for (let x = PITCH_FIELD.x; x < PITCH_FIELD.x + PITCH_FIELD.width; x++) {
      expect(map.tiles[PITCH_FIELD.y - 1]![x]).toBe('walkway');
      expect(map.tiles[PITCH_FIELD.y + PITCH_FIELD.height]![x]).toBe('walkway');
    }
    // Centred on the road's middle, like the gate.
    expect(PITCH_MIDDLE_Z).toBe(PITCH_GATE.y + PITCH_GATE.height / 2);
    expect(PITCH_CENTRE_SPOT).toEqual({ x: PITCH_FIELD.x + PITCH_FIELD.width / 2, z: PITCH_MIDDLE_Z });
  });

  it('makes each goal\'s net and posts solid from behind, and its mouth open from the field', () => {
    const half = PITCH_GOAL.width / 2;
    for (const [side, lineX, behind] of [
      ['west', PITCH_FIELD.x, PITCH_FIELD.x - 1],
      ['east', PITCH_FIELD.x + PITCH_FIELD.width, PITCH_FIELD.x + PITCH_FIELD.width],
    ] as const) {
      const goal = PITCH_FIXTURES.find((piece) => piece.kind === 'goal' && piece.side === side)!;
      expect(goal).toMatchObject({ x: behind, width: PITCH_GOAL.depth });
      // Both posts: the tiles behind the line on either side of each post are solid.
      for (const postZ of [PITCH_MIDDLE_Z - half, PITCH_MIDDLE_Z + half]) {
        expect(isSolidAt(map, behind, postZ - 1), `${side} post ${postZ}, north of it`).toBe(true);
        expect(isSolidAt(map, behind, postZ), `${side} post ${postZ}, south of it`).toBe(true);
      }
      // The net behind the mouth is solid; the field in front of it is turf.
      const field = side === 'west' ? lineX : lineX - 1;
      for (let z = PITCH_MIDDLE_Z - half; z < PITCH_MIDDLE_Z + half; z++) {
        expect(isSolidAt(map, behind, z), `${side} net ${z}`).toBe(true);
        expect(map.tiles[z]![field], `${side} mouth ${z}`).toBe('turf');
      }
      // Beside the goal the walkway carries on behind the goal line.
      expect(isSolidAt(map, behind, goal.y - 1)).toBe(false);
      expect(isSolidAt(map, behind, goal.y + goal.height)).toBe(false);
    }
  });

  it('puts every fixture on its own solid footing inside the square, off the field', () => {
    const owner = new Map<string, string>();
    for (const piece of PITCH_FIXTURES) {
      for (const [x, y] of tilesOf(piece)) {
        expect(inPitchRect(PITCH_AREA, x, y), `${piece.kind} ${x},${y}`).toBe(true);
        expect(inPitchRect(PITCH_FIELD, x, y), `${piece.kind} ${x},${y}`).toBe(false);
        expect(map.tiles[y]![x], `${piece.kind} ${x},${y}`).toBe('footing');
        expect(owner.has(`${x},${y}`), `${piece.kind} overlaps ${owner.get(`${x},${y}`)}`).toBe(false);
        owner.set(`${x},${y}`, piece.kind);
      }
    }
    for (const [x, y] of tilesOf(PITCH_AREA)) {
      if (map.tiles[y]![x] === 'footing') expect(owner.has(`${x},${y}`), `${x},${y}`).toBe(true);
    }
    expect(TILES.footing.solid).toBe(true);
    expect(PITCH_FIXTURES.map((piece) => piece.kind).sort()).toEqual([
      'bleacher', 'bleacher', 'floodlight', 'floodlight', 'floodlight', 'floodlight', 'goal', 'goal', 'stand',
    ]);
  });

  it('fills the north side with the stand to the square\'s edge, so nobody stands out of sight behind it', () => {
    const stand = PITCH_FIXTURES.find((piece) => piece.kind === 'stand')!;
    expect(stand.y).toBe(PITCH_AREA.y);
    expect(stand.y + stand.height).toBe(PITCH_FIELD.y - 2);
    // Centred on the halfway line.
    expect(stand.x + stand.width / 2).toBe(PITCH_CENTRE_SPOT.x);
    // The south side, nearest the camera, holds only low bleachers, either side of an aisle.
    const south = PITCH_FIXTURES.filter((piece) => piece.y > PITCH_FIELD.y + PITCH_FIELD.height);
    expect(south.map((piece) => piece.kind).sort()).toEqual(['bleacher', 'bleacher', 'floodlight', 'floodlight']);
    const [west, east] = south.filter((piece) => piece.kind === 'bleacher');
    expect(west!.x + west!.width).toBeLessThan(PITCH_CENTRE_SPOT.x);
    expect(east!.x).toBeGreaterThan(PITCH_CENTRE_SPOT.x);
  });

  it('keeps the plaza, the sandbox and the rest of the street out of the square', () => {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const kind = map.tiles[y]![x]!;
        const pitchKind = kind === 'turf' || kind === 'walkway' || kind === 'footing';
        expect(pitchKind, `${kind} at ${x},${y}`).toBe(isPitchTile(x, y));
        if (kind === 'railing') expect(x, `railing at ${x},${y}`).toBe(PITCH_GATE.x);
      }
    }
    expect(isPitchTile(map.spawn.x, map.spawn.y)).toBe(false);
    expect(isPitchTile(-1, 5)).toBe(false);
    expect(isPitchTile(1.5, 5)).toBe(false);
  });
});

describe('the pitch\'s words and the kick rule (D-078)', () => {
  it('reads the scoreboard as "WEST 0 – 0 EAST", and names a winner at full time', () => {
    expect(pitchScoreText(0, 0)).toBe('WEST 0 – 0 EAST');
    expect(pitchScoreText(3, 5)).toBe('WEST 3 – 5 EAST');
    expect(pitchScoreText(Number.NaN, -1)).toBe('WEST 0 – 0 EAST');
    expect(pitchWinnerText(5, 3)).toBe('WEST WIN 5 – 3');
    expect(pitchWinnerText(2, 5)).toBe('EAST WIN 5 – 2');
    expect(pitchWinnerText(1, 1)).toBe('WEST 1 – 1 EAST');
  });

  it('kicks within FOOTBALL_KICK_RANGE tiles of the ball\'s centre, and never on a bad position', () => {
    const reach = FOOTBALL_KICK_RANGE * TILE_SIZE;
    const ball = { x: 400, y: 480 };
    expect(withinKickRange({ x: 400 - reach + 0.01, y: 480 }, ball, TILE_SIZE)).toBe(true);
    expect(withinKickRange({ x: 400 - reach - 0.5, y: 480 }, ball, TILE_SIZE)).toBe(false);
    // Measured round, not square: a corner of the box is out of range.
    expect(withinKickRange({ x: 400 + reach * 0.7, y: 480 + reach * 0.7 }, ball, TILE_SIZE)).toBe(true);
    expect(withinKickRange({ x: 400 + reach * 0.9, y: 480 + reach * 0.9 }, ball, TILE_SIZE)).toBe(false);
    expect(withinKickRange({ x: Number.NaN, y: 480 }, ball, TILE_SIZE)).toBe(false);
  });
});
