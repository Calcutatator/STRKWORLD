import { describe, expect, it } from 'vitest';
import { BUNKER_PRESENCE_GRID, ROOF_PRESENCE_GRID, STUDIO_PRESENCE_GRID } from '@strkworld/shared';
import {
  AREA_STEP_SLACK_PX,
  isAreaStepAllowed,
  isAreaWalkable,
  isOverAreaGrid,
  normalizePresenceArea,
} from './areas';

/** The World pixel centre of a shared room's tile. */
function roof(tileX: number, tileY: number): { x: number; y: number } {
  return { x: ROOF_PRESENCE_GRID.originX + tileX * 32 + 16, y: ROOF_PRESENCE_GRID.originY + tileY * 32 + 16 };
}
function studio(tileX: number, tileY: number): { x: number; y: number } {
  return { x: STUDIO_PRESENCE_GRID.originX + tileX * 32 + 16, y: STUDIO_PRESENCE_GRID.originY + tileY * 32 + 16 };
}
function bunker(tileX: number, tileY: number): { x: number; y: number } {
  return { x: BUNKER_PRESENCE_GRID.originX + tileX * 32 + 16, y: BUNKER_PRESENCE_GRID.originY + tileY * 32 + 16 };
}

describe('normalizePresenceArea (D-087)', () => {
  it('accepts the four areas, defaults a missing one to the street, and rejects anything else', () => {
    expect(normalizePresenceArea('street')).toBe('street');
    expect(normalizePresenceArea('roof')).toBe('roof');
    expect(normalizePresenceArea('studio')).toBe('studio');
    // D-112: the hidden bunker.
    expect(normalizePresenceArea('bunker')).toBe('bunker');
    expect(normalizePresenceArea(undefined)).toBe('street');
    for (const hostile of [null, '', 'ROOF', 'vault', 'bank', 0, 1, {}, ['roof'], 'roof ']) {
      expect(normalizePresenceArea(hostile)).toBeNull();
    }
  });

  it('D-114: refuses the arena until its ring authority lands (stream B lifts this)', () => {
    expect(normalizePresenceArea('arena')).toBeNull();
  });
});

describe('isAreaWalkable (D-087)', () => {
  it('holds the roof to its 5 by 4 deck inside the ledge ring', () => {
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const deck = x >= 1 && x <= 5 && y >= 1 && y <= 4;
        const { x: px, y: py } = roof(x, y);
        expect(isAreaWalkable('roof', px, py), `roof tile ${x},${y}`).toBe(deck);
      }
    }
    // The deck's exact pixel edges.
    const left = ROOF_PRESENCE_GRID.originX + 32;
    const top = ROOF_PRESENCE_GRID.originY + 32;
    expect(isAreaWalkable('roof', left, top)).toBe(true);
    expect(isAreaWalkable('roof', left - 1, top)).toBe(false);
    expect(isAreaWalkable('roof', left + 5 * 32 - 1, top + 4 * 32 - 1)).toBe(true);
    expect(isAreaWalkable('roof', left + 5 * 32, top)).toBe(false);
  });

  it('holds the Studio to its floor and the return portal in its top wall', () => {
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 18; x += 1) {
        const floor = x >= 1 && x <= 16 && y >= 1 && y <= 10;
        const portal = y === 0 && (x === 8 || x === 9);
        const { x: px, y: py } = studio(x, y);
        expect(isAreaWalkable('studio', px, py), `studio tile ${x},${y}`).toBe(floor || portal);
      }
    }
  });

  it('holds the bunker to its floor between the booths, and its stair (D-112)', () => {
    // The hidden room's floor plan, '.' walkable: the World test pins it to BUNKER_ROOM_DEFINITION.
    const plan = [
      '################',
      '###.############',
      '###............#',
      '###.#####.....##',
      '###.#####..#..##',
      '###...........##',
      '###.#####...#.##',
      '#...#####.######',
      '#..............#',
      '#..#############',
    ];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const { x: px, y: py } = bunker(x, y);
        expect(isAreaWalkable('bunker', px, py), `bunker tile ${x},${y}`).toBe(plan[y]![x] === '.');
      }
    }
    // Its grid is over the hidden street, so a street position never reads as the bunker's.
    expect(isOverAreaGrid('bunker', bunker(5, 5).x, bunker(5, 5).y)).toBe(true);
    expect(isOverAreaGrid('bunker', bunker(16, 5).x, bunker(16, 5).y)).toBe(false);
    // A step through a booth row is refused; a step along a corridor is not.
    expect(isAreaStepAllowed('bunker', bunker(6, 2), bunker(6, 5))).toBe(false);
    expect(isAreaStepAllowed('bunker', bunker(4, 2), bunker(8, 2))).toBe(true);
  });

  it('refuses non-finite positions', () => {
    expect(isAreaWalkable('roof', Number.NaN, 200)).toBe(false);
    expect(isAreaWalkable('studio', 200, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('isOverAreaGrid (D-087)', () => {
  it('covers the roof’s whole grid, ledge ring included: the tower’s street footprint', () => {
    for (let y = -1; y <= 6; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const over = x >= 0 && x < 7 && y >= 0 && y < 6;
        const { x: px, y: py } = roof(x, y);
        expect(isOverAreaGrid('roof', px, py), `roof tile ${x},${y}`).toBe(over);
      }
    }
    expect(isOverAreaGrid('roof', Number.NaN, 0)).toBe(false);
  });
});

describe('isAreaStepAllowed (D-087)', () => {
  it('allows a walk across the room and refuses a step off its tiles', () => {
    expect(isAreaStepAllowed('roof', roof(1, 1), roof(5, 4))).toBe(true);
    expect(isAreaStepAllowed('roof', roof(5, 4), roof(6, 4))).toBe(false);
    expect(isAreaStepAllowed('studio', studio(1, 1), studio(16, 10))).toBe(true);
    expect(isAreaStepAllowed('studio', studio(9, 1), studio(9, 0))).toBe(true);
    expect(isAreaStepAllowed('studio', studio(9, 1), studio(9, -1))).toBe(false);
  });

  it('refuses a long step whose straight line crosses a wall', () => {
    // From the portal in the top wall to the floor's far west: the line runs
    // through the wall west of the portal.
    const from = studio(8, 0);
    const to = { x: studio(1, 1).x, y: studio(1, 1).y - 15 };
    expect(isAreaWalkable('studio', to.x, to.y)).toBe(true);
    expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThan(AREA_STEP_SLACK_PX);
    expect(isAreaStepAllowed('studio', from, to)).toBe(false);
  });

  it('lets a step within one tile clip a corner, as two samples a patch apart can', () => {
    // Around the portal's west jamb: both ends walkable, the line clips the
    // wall tile at (7, 0) for a few pixels.
    const grid = STUDIO_PRESENCE_GRID;
    const from = { x: grid.originX + 7.6 * 32, y: grid.originY + 1.05 * 32 };
    const to = { x: grid.originX + 8.2 * 32, y: grid.originY + 0.7 * 32 };
    expect(isAreaWalkable('studio', from.x, from.y)).toBe(true);
    expect(isAreaWalkable('studio', to.x, to.y)).toBe(true);
    expect(isAreaWalkable('studio', (from.x + to.x) / 2, (from.y + to.y) / 2)).toBe(false);
    expect(isAreaStepAllowed('studio', from, to)).toBe(true);
  });
});
