/**
 * D-112: the hidden bunker (D-107) is a shared presence area like the roof
 * and the Studio. Its players see each other move and jump, scoped to the
 * bunker alone; entering and leaving switches scope; positions are held to
 * the bunker's own walkable grid; and a crowd is bounded by the same view
 * cap as every other area.
 */

import { describe, expect, it } from 'vitest';
import { BUNKER_PRESENCE_GRID, STUDIO_PRESENCE_GRID, type GameId } from '@strkworld/shared';
import { MAX_CLIENTS_PER_ROOM, MAX_VISIBLE_PEERS } from './config';
import { LobbyPresence } from './presence';

const T = 32;

function bunker(tileX: number, tileY: number): { x: number; y: number } {
  return { x: BUNKER_PRESENCE_GRID.originX + tileX * T + T / 2, y: BUNKER_PRESENCE_GRID.originY + tileY * T + T / 2 };
}
function studio(tileX: number, tileY: number): { x: number; y: number } {
  return { x: STUDIO_PRESENCE_GRID.originX + tileX * T + T / 2, y: STUDIO_PRESENCE_GRID.originY + tileY * T + T / 2 };
}

function join(registry: LobbyPresence, session: string, at: { x: number; y: number }): GameId {
  const outcome = registry.admit(session, at);
  if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
  return outcome.gameId;
}

const sees = (registry: LobbyPresence, observer: string): string[] =>
  registry.visibleTo(observer).map((entry) => entry.gameId).sort();

/** Two players down the stair, a street player and a Studio player on the very same World pixels. */
function scene() {
  const registry = new LobbyPresence();
  const a = join(registry, 'a', { x: 400, y: 380 });
  const b = join(registry, 'b', { x: 440, y: 380 });
  // The bunker and the Studio are both drawn at the interiors' origin, over
  // the hidden street: these two stand where the bunker's players stand.
  const street = join(registry, 'street', bunker(2, 8));
  const dresser = join(registry, 'dresser', { x: 100, y: 100 });
  expect(registry.enterArea('dresser', { area: 'studio', ...studio(2, 8) }, 1000)).toBe(true);
  expect(studio(2, 8)).toEqual(bunker(2, 8));
  expect(registry.enterArea('a', { area: 'bunker', ...bunker(2, 8) }, 1000)).toBe(true);
  expect(registry.enterArea('b', { area: 'bunker', ...bunker(3, 8) }, 1000)).toBe(true);
  return { registry, a, b, street, dresser };
}

describe('the bunker as a shared area (D-112)', () => {
  it('shows its two players to each other, and to nobody on the street or in the Studio', () => {
    const { registry, a, b, street, dresser } = scene();
    expect(registry.areaFor('a')).toBe('bunker');
    expect(sees(registry, 'a')).toEqual([b]);
    expect(sees(registry, 'b')).toEqual([a]);
    // Same coordinates, other areas: neither way.
    expect(sees(registry, 'street')).toEqual([]);
    expect(sees(registry, 'dresser')).toEqual([]);
    expect(sees(registry, 'a')).not.toContain(street);
    expect(sees(registry, 'a')).not.toContain(dresser);
  });

  it('carries a move and a jump to the other bunker player only', () => {
    const { registry, a } = scene();
    expect(registry.move('a', bunker(3, 7), 1100)).toBe('applied');
    expect(registry.visibleTo('b').find((entry) => entry.gameId === a)?.position).toMatchObject(bunker(3, 7));
    expect(registry.jump('a', 2000)).toBe('applied');
    expect(registry.visibleTo('b').find((entry) => entry.gameId === a)?.jumps).toBe(1);
    // The same rate floor as every other area.
    expect(registry.jump('a', 2001)).toBe('throttled');
    expect(registry.visibleTo('street').map((entry) => entry.gameId)).not.toContain(a);
    expect(registry.visibleTo('dresser').map((entry) => entry.gameId)).not.toContain(a);
  });

  it('switches scope on entry and exit: from the street into the bunker, and back up the stair', () => {
    const { registry, a, b, street } = scene();
    // B goes back up the stair: live on the street at the alley's mouth.
    expect(registry.enterArea('b', { area: 'street', x: 432, y: 380 }, 2000)).toBe(true);
    expect(registry.areaFor('b')).toBe('street');
    expect(sees(registry, 'a')).toEqual([]);
    expect(sees(registry, 'b')).not.toContain(a);
    // And the street player comes down: now the bunker's, gone from the street.
    expect(registry.enterArea('street', { area: 'bunker', ...bunker(1, 9) }, 2000)).toBe(true);
    expect(registry.areaFor('street')).toBe('bunker');
    expect(sees(registry, 'a')).toEqual([street]);
    expect(sees(registry, 'street')).toEqual([a]);
    expect(sees(registry, 'b')).not.toContain(street);
    // From a suspend (a solo fallback that caught up) as well.
    registry.suspend('b');
    expect(registry.areaFor('b')).toBeNull();
    expect(registry.enterArea('b', { area: 'bunker', ...bunker(2, 7) }, 3000)).toBe(true);
    expect(sees(registry, 'a')).toEqual([b, street].sort());
  });

  it('refuses an entry off its walkable tiles by suspending, never by repairing it', () => {
    const registry = new LobbyPresence();
    const a = join(registry, 'a', { x: 400, y: 380 });
    join(registry, 'watcher', { x: 100, y: 100 });
    expect(registry.enterArea('watcher', { area: 'bunker', ...bunker(2, 8) }, 1000)).toBe(true);
    // The lift's doors (out of order), a booth, the wall ring, and outside the grid.
    for (const [n, at] of [bunker(1, 6), bunker(5, 3), bunker(0, 5), bunker(16, 5), { x: 0, y: 0 }].entries()) {
      expect(registry.enterArea('a', { area: 'bunker', ...at }, 1000 + n * 100), `${at.x},${at.y}`).toBe(false);
      expect(registry.areaFor('a')).toBeNull();
      expect(sees(registry, 'watcher')).not.toContain(a);
    }
    // An unknown area name is refused the same way.
    expect(registry.enterArea('a', { area: 'Bunker', ...bunker(2, 8) }, 2000)).toBe(false);
  });

  it('rejects a move onto a solid tile or through the booths, and keeps the last good position', () => {
    const { registry, a } = scene();
    const before = registry.counters().rejected;
    // Onto the reception desk, onto the lift's doors, and out through the wall.
    expect(registry.move('a', bunker(4, 7), 1100)).toBe('rejected');
    expect(registry.move('a', bunker(1, 6), 1200)).toBe('rejected');
    expect(registry.move('a', { x: bunker(2, 8).x, y: bunker(2, 8).y + 2 * T }, 1300)).toBe('rejected');
    // From the north corridor to the south one, straight through two booth rows.
    expect(registry.move('a', bunker(3, 8), 1400)).toBe('applied');
    expect(registry.move('a', bunker(3, 5), 1500)).toBe('applied');
    expect(registry.move('a', bunker(3, 2), 1600)).toBe('applied');
    expect(registry.move('a', bunker(6, 2), 1700)).toBe('applied');
    expect(registry.move('a', bunker(6, 5), 1800)).toBe('rejected');
    // Through the one-tile manga shelf, from the gap above it to the lobby.
    expect(registry.enterArea('b', { area: 'bunker', ...bunker(10, 6) }, 1900)).toBe(true);
    expect(registry.move('b', bunker(10, 8), 2000)).toBe('rejected');
    expect(registry.counters().rejected - before).toBe(5);
    expect(registry.visibleTo('b').find((entry) => entry.gameId === a)?.position).toMatchObject(bunker(6, 2));
  });

  it('degrades gracefully under a crowd: the room fills, and each player sees at most the view cap, nearest first', () => {
    const registry = new LobbyPresence();
    // The whole room's capacity down there, packed onto the first dozen
    // walkable tiles (the spine and the north corridor), several to a tile.
    const tiles: Array<{ x: number; y: number }> = [];
    for (const rect of BUNKER_PRESENCE_GRID.walkable) {
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) tiles.push({ x, y });
      }
    }
    const PACKED = 12;
    const ids: GameId[] = [];
    for (let n = 0; n < MAX_CLIENTS_PER_ROOM; n += 1) {
      const session = `p${n}`;
      ids.push(join(registry, session, { x: 400, y: 380 }));
      const tile = tiles[n % PACKED]!;
      expect(registry.enterArea(session, { area: 'bunker', ...bunker(tile.x, tile.y) }, 1000)).toBe(true);
    }
    // The 16 by 10 room is inside one interest box, so the cap is what binds.
    for (let n = 0; n < MAX_CLIENTS_PER_ROOM; n += 1) {
      const view = registry.visibleTo(`p${n}`);
      expect(view).toHaveLength(MAX_VISIBLE_PEERS);
      expect(view.map((entry) => entry.gameId)).not.toContain(ids[n]);
    }
    // Nearest first: everyone sharing the observer's own tile is in its view.
    const self = tiles[0]!;
    const sameTile = ids.filter((_, n) => {
      const tile = tiles[n % PACKED]!;
      return n !== 0 && tile.x === self.x && tile.y === self.y;
    });
    expect(sameTile.length).toBeGreaterThan(0);
    for (const id of sameTile) expect(registry.visibleTo('p0').map((entry) => entry.gameId)).toContain(id);
    // Nobody on the street is shown the crowd: one of them goes back up.
    expect(registry.enterArea('p47', { area: 'street', ...bunker(9, 5) }, 2000)).toBe(true);
    expect(registry.visibleTo('p47')).toEqual([]);
    expect(registry.visibleTo('p0').map((entry) => entry.gameId)).not.toContain(ids[47]);
  });
});
