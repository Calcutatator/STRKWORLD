/**
 * D-114: the arena as a presence area, through the registry. Its grid, the
 * ring's walls for everyone but the challenger, the server's own moves in and
 * out of the ring, the refresh rule, whole-room interest with the fighter
 * pinned, and that no other area is ever sent an arena player.
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_ATTACK_MIN_INTERVAL_MS,
  ARENA_COUNTDOWN_MS,
  ARENA_HEIGHT,
  ARENA_INTENT_MIN_INTERVAL_MS,
  ARENA_PRESENCE_GRID,
  ARENA_RESULT_MS,
  ARENA_RING_RETURN,
  ARENA_RING_SPAWN,
  ARENA_WIDTH,
  BUNKER_PRESENCE_GRID,
  ROOF_PRESENCE_GRID,
  STUDIO_PRESENCE_GRID,
  arenaTileAt,
  arenaTileCentre,
  isArenaFloorKind,
  type GameId,
  type PresenceArea,
} from '@strkworld/shared';
import { isAreaWalkable } from './areas';
import { LobbyPresence } from './presence';

const at = (x: number, y: number) => arenaTileCentre({ x, y });
const APPROACH = at(20, 10);

function admitInArena(registry: LobbyPresence, key: string, tile: { x: number; y: number }, now = 0): GameId {
  const outcome = registry.admit(key, { x: 100, y: 100 });
  if (!outcome.ok) throw new Error(outcome.reason);
  const place = at(tile.x, tile.y);
  expect(registry.enterArea(key, { area: 'arena', ...place, facing: 'down', sprite: 'avatar-2' }, now)).toBe(true);
  return outcome.gameId;
}

function positionOf(registry: LobbyPresence, key: string): { x: number; y: number; facing: string } | null {
  const entry = registry.entryFor(key);
  return entry === undefined ? null : { x: entry.position.x, y: entry.position.y, facing: entry.facing };
}

describe('the arena grid (D-114)', () => {
  it('is walkable or solid at every tile exactly as arenaTileAt says', () => {
    for (let y = -1; y <= ARENA_HEIGHT; y += 1) {
      for (let x = -1; x <= ARENA_WIDTH; x += 1) {
        const centre = {
          x: ARENA_PRESENCE_GRID.originX + x * 32 + 16,
          y: ARENA_PRESENCE_GRID.originY + y * 32 + 16,
        };
        expect(isAreaWalkable('arena', centre.x, centre.y), `tile ${x},${y}`).toBe(isArenaFloorKind(arenaTileAt(x, y)));
      }
    }
  });

  it('accepts an arena placement on the floor and suspends one in the ring, the fence or the void', () => {
    const registry = new LobbyPresence();
    admitInArena(registry, 'a', { x: 20, y: 2 });
    expect(registry.areaFor('a')).toBe('arena');
    for (const [label, tile] of [
      ['ring', { x: 20, y: 14 }],
      ['dummy', { x: 20, y: 18 }],
      ['fence', { x: 15, y: 16 }],
      ['gate', { x: 20, y: 12 }],
      ['void', { x: 0, y: 32 }],
    ] as const) {
      const key = `x-${label}`;
      registry.admit(key, { x: 100, y: 100 });
      expect(registry.enterArea(key, { area: 'arena', ...at(tile.x, tile.y) }, 0), label).toBe(false);
      expect(registry.areaFor(key), label).toBeNull();
    }
  });
});

describe('the ring is a wall to everyone but its challenger (D-114)', () => {
  it('a non-fighter cannot step across the gate, the fence or into the ring', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 20, y: 11 });
    let now = 10;
    // Straight up through the gate.
    expect(registry.move('a', at(20, 13), (now += 10))).toBe('rejected');
    // A short step onto the gate tile itself.
    expect(registry.move('a', { x: APPROACH.x, y: at(20, 12).y }, (now += 10))).toBe('rejected');
    // Round to the west of the fence and across it.
    admitInArena(registry, 'b', { x: 13, y: 16 });
    expect(registry.move('b', at(16, 16), (now += 10))).toBe('rejected');
    expect(registry.move('b', at(15, 16), (now += 10))).toBe('rejected');
    expect(positionOf(registry, 'b')).toMatchObject(at(13, 16));
  });

  it('the fighter walks the ring but not out through the fence, the gate or the dummy', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 20, y: 10 });
    expect(registry.arenaClaim('a', 10)).toBe('applied');
    expect(positionOf(registry, 'a')).toEqual({ ...at(ARENA_RING_SPAWN.x, ARENA_RING_SPAWN.y), facing: 'down' });
    let now = 100;
    // Around inside the ring, step by step.
    for (const tile of [{ x: 21, y: 14 }, { x: 22, y: 14 }, { x: 22, y: 15 }, { x: 22, y: 16 }, { x: 21, y: 16 }]) {
      expect(registry.move('a', at(tile.x, tile.y), (now += 60)), `${tile.x},${tile.y}`).toBe('applied');
    }
    // Not onto the dummy, nor across the fence.
    expect(registry.move('a', at(21, 18), (now += 60))).toBe('applied');
    expect(registry.move('a', at(20, 18), (now += 60))).toBe('rejected');
    expect(registry.move('a', at(25, 18), (now += 60))).toBe('rejected');
    expect(registry.move('a', at(21, 11), (now += 60))).toBe('rejected');
    expect(registry.areaFor('a')).toBe('arena');
  });

  it('the claim writes the ring spawn, and the close writes the return tile', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 21, y: 11 });
    expect(registry.arenaClaim('a', 0)).toBe('applied');
    expect(positionOf(registry, 'a')).toEqual({ ...at(20, 14), facing: 'down' });
    // Ten hits from just north of the dummy.
    let now = ARENA_COUNTDOWN_MS;
    expect(registry.arenaTick(now)).toBe(false);
    expect(registry.move('a', at(20, 15), now + 1)).toBe('applied');
    expect(registry.move('a', at(20, 16), now + 70)).toBe('applied');
    expect(registry.move('a', { ...at(20, 17), facing: 'down' }, now + 140)).toBe('applied');
    now += 200;
    for (let n = 0; n < 10; n += 1) expect(registry.arenaAttack('a', (now += ARENA_ATTACK_MIN_INTERVAL_MS))).toBe('hit');
    expect(registry.arenaSnapshot(now).outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    expect(registry.arenaTick(now + ARENA_RESULT_MS - 1)).toBe(false);
    expect(registry.arenaTick(now + ARENA_RESULT_MS)).toBe(true);
    expect(positionOf(registry, 'a')).toEqual({ ...at(ARENA_RING_RETURN.x, ARENA_RING_RETURN.y), facing: 'up' });
    // Back on the sand, the ring is a wall again.
    expect(registry.move('a', at(20, 13), now + ARENA_RESULT_MS + 100)).toBe('rejected');
  });

  it('a move the client sent before it heard of the claim is refused, and the server keeps the ring spawn', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 20, y: 10 });
    registry.arenaClaim('a', 0);
    // The client still thinks it is on the approach, a step east.
    expect(registry.move('a', at(21, 10), 100)).toBe('rejected');
    expect(positionOf(registry, 'a')).toMatchObject(at(20, 14));
  });
});

describe('the refresh rule (D-114)', () => {
  it('a look change during a fight updates the sprite, keeps the held position and facing, and does not suspend', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 20, y: 10 });
    registry.arenaClaim('a', 0);
    const held = positionOf(registry, 'a');
    // The refresh races the claim: it carries the approach position it was sent from.
    expect(registry.enterArea('a', { area: 'arena', ...APPROACH, facing: 'left', sprite: 'avatar-12' }, 50)).toBe(true);
    expect(positionOf(registry, 'a')).toEqual(held);
    expect(registry.entryFor('a')?.sprite).toBe('avatar-12');
    // Even one placed off the grid, or malformed, keeps the fighter where they are.
    expect(registry.enterArea('a', { area: 'arena', x: 0, y: 0, sprite: 'avatar-13' }, 100)).toBe(true);
    expect(registry.enterArea('a', { area: 'arena', x: 'nope', y: null, sprite: 'avatar-14' }, 150)).toBe(true);
    expect(registry.areaFor('a')).toBe('arena');
    expect(positionOf(registry, 'a')).toEqual(held);
    expect(registry.entryFor('a')?.sprite).toBe('avatar-14');
    expect(registry.arenaSnapshot(150).phase).toBe('countdown');
  });

  it('a non-fighter’s refresh is an ordinary placement', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 20, y: 10 });
    admitInArena(registry, 'b', { x: 20, y: 4 });
    registry.arenaClaim('a', 0);
    expect(registry.enterArea('b', { area: 'arena', ...at(20, 5), sprite: 'avatar-3' }, 50)).toBe(true);
    expect(positionOf(registry, 'b')).toMatchObject(at(20, 5));
    // And into the ring it is refused, like any off-grid placement.
    expect(registry.enterArea('b', { area: 'arena', ...at(20, 14) }, 100)).toBe(false);
    expect(registry.areaFor('b')).toBeNull();
  });

  it.each([
    ['an area change', (registry: LobbyPresence) => registry.enterArea('a', { area: 'street', x: 100, y: 100 }, 500), 'left'],
    ['a suspend', (registry: LobbyPresence) => registry.suspend('a', 500), 'left'],
    ['a release', (registry: LobbyPresence) => registry.release('a', 500), 'disconnect'],
    ['a leave intent', (registry: LobbyPresence) => registry.arenaLeave('a', ARENA_INTENT_MIN_INTERVAL_MS), 'left'],
  ] as const)('%s ends the fight', (_label, act, reason) => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 0 });
    admitInArena(registry, 'a', { x: 20, y: 10 });
    registry.arenaClaim('a', 0);
    act(registry);
    expect(registry.arenaSnapshot(ARENA_INTENT_MIN_INTERVAL_MS).outcome).toEqual({ reason, winner: null });
  });
});

describe('interest in the arena (D-114)', () => {
  it('48 in the arena: each is sent 24, the fighter always among them, the rest nearest first', () => {
    const registry = new LobbyPresence();
    const floor: { x: number; y: number }[] = [];
    for (let y = 0; y < ARENA_HEIGHT && floor.length < 47; y += 1) {
      for (let x = 0; x < ARENA_WIDTH && floor.length < 47; x += 1) {
        // Spread round the stands, never on the approach.
        if (isArenaFloorKind(arenaTileAt(x, y)) && (x + y) % 3 === 0 && !(x >= 19 && x <= 21 && y >= 21 && y <= 22)) floor.push({ x, y });
      }
    }
    expect(floor).toHaveLength(47);
    const fighter = admitInArena(registry, 'fighter', { x: 20, y: 10 });
    floor.forEach((tile, n) => admitInArena(registry, `s${n}`, tile));
    expect(registry.arenaClaim('fighter', 0)).toBe('applied');
    for (let n = 0; n < 47; n += 1) {
      const key = `s${n}`;
      const seen = registry.visibleTo(key);
      expect(seen, key).toHaveLength(24);
      expect(seen[0]?.gameId, key).toBe(fighter);
      // The rest, nearest first by the room's square distance.
      const self = registry.entryFor(key)!.position;
      const distances = seen.slice(1).map((entry) => Math.max(Math.abs(entry.position.x - self.x), Math.abs(entry.position.y - self.y)));
      expect(distances, key).toEqual([...distances].sort((a, b) => a - b));
    }
    expect(registry.visibleTo('fighter')).toHaveLength(24);
  });

  it('a spectator beyond the interest box still sees every arena player, the fighter first', () => {
    const registry = new LobbyPresence();
    const fighter = admitInArena(registry, 'fighter', { x: 20, y: 10 });
    admitInArena(registry, 'west', { x: 2, y: 16 });
    admitInArena(registry, 'east', { x: 38, y: 16 });
    registry.arenaClaim('fighter', 0);
    // 36 tiles apart: 1152 px, well past the 640 px box.
    expect(registry.visibleTo('west').map((entry) => entry.gameId)).toEqual([fighter, registry.gameIdFor('east')]);
  });

  it.each([
    ['street', { x: 100, y: 100 }],
    ['roof', { x: ROOF_PRESENCE_GRID.originX + 48, y: ROOF_PRESENCE_GRID.originY + 48 }],
    ['studio', { x: STUDIO_PRESENCE_GRID.originX + 48 + 64, y: STUDIO_PRESENCE_GRID.originY + 48 + 64 }],
    ['bunker', { x: BUNKER_PRESENCE_GRID.originX + 48 + 64, y: BUNKER_PRESENCE_GRID.originY + 48 + 64 }],
  ] as const)('a %s observer is never sent an arena player, nor an arena observer one of theirs', (area, place) => {
    const registry = new LobbyPresence();
    admitInArena(registry, 'fighter', { x: 20, y: 10 });
    registry.arenaClaim('fighter', 0);
    admitInArena(registry, 'spectator', { x: 20, y: 8 });
    registry.admit('other', { x: 100, y: 100 });
    if (area !== 'street') {
      const walkable = isAreaWalkable(area as Exclude<PresenceArea, 'street'>, place.x, place.y);
      expect(walkable, `${area} placement`).toBe(true);
      expect(registry.enterArea('other', { area, ...place }, 0)).toBe(true);
    }
    expect(registry.isArenaMember('other')).toBe(false);
    expect(registry.isArenaMember('spectator')).toBe(true);
    expect(registry.visibleTo('other')).toEqual([]);
    expect(registry.visibleTo('spectator').map((entry) => entry.gameId)).not.toContain(registry.gameIdFor('other'));
  });
});
