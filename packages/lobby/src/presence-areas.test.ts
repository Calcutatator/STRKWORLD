/**
 * D-087: presence areas in the registry. A live session is in exactly one of
 * the street, the Exchange roof or the Avatar Studio; it sees and is seen
 * by sessions in the same one, and a roof session also sees the street below
 * (one way); a shared room holds its players to its own walkable tiles; and
 * every other interior still suspends.
 */

import { describe, expect, it } from 'vitest';
import { Encoder } from '@colyseus/schema';
import {
  ROOF_PRESENCE_GRID,
  SANDBOX_AREA,
  STUDIO_PRESENCE_GRID,
  type GameId,
  type SandboxColumn,
  type SandboxTile,
} from '@strkworld/shared';
import { LobbyPresence } from './presence';

const T = 32;

function roof(tileX: number, tileY: number): { x: number; y: number } {
  return { x: ROOF_PRESENCE_GRID.originX + tileX * T + T / 2, y: ROOF_PRESENCE_GRID.originY + tileY * T + T / 2 };
}
function studio(tileX: number, tileY: number): { x: number; y: number } {
  return { x: STUDIO_PRESENCE_GRID.originX + tileX * T + T / 2, y: STUDIO_PRESENCE_GRID.originY + tileY * T + T / 2 };
}
function centre(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * T + T / 2, y: tileY * T + T / 2 };
}

function join(registry: LobbyPresence, session: string, at: { x: number; y: number }): GameId {
  const outcome = registry.admit(session, at);
  if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
  return outcome.gameId;
}

function visibleIds(registry: LobbyPresence, session: string): string[] {
  return registry.visibleTo(session).map((entry) => entry.gameId).sort();
}

/** Deterministic PRNG, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('area isolation (D-087)', () => {
  it('keeps the street from the roof and the Studio from both, however close their coordinates; the roof sees the street below', () => {
    const registry = new LobbyPresence();
    // The roof lies over the Exchange's street footprint, and the Studio is
    // drawn over the hidden street by the pitch: each pair below stands at
    // the same World pixels in two areas. `below` stands inside the tower's
    // footprint, where only a hostile client can.
    const below = join(registry, 'below', roof(3, 3));
    const outside = join(registry, 'outside', { x: roof(3, 3).x, y: roof(3, 3).y + 3 * T });
    const up1 = join(registry, 'up1', centre(0, 0));
    const up2 = join(registry, 'up2', centre(0, 0));
    const pitch = join(registry, 'pitch', studio(6, 5));
    const dresser1 = join(registry, 'dresser1', centre(0, 0));
    const dresser2 = join(registry, 'dresser2', centre(0, 0));
    registry.suspend('up1');
    registry.suspend('up2');
    expect(registry.enterArea('up1', { area: 'roof', ...roof(3, 3) }, 1000)).toBe(true);
    expect(registry.enterArea('up2', { area: 'roof', ...roof(4, 2) }, 1000)).toBe(true);
    expect(registry.enterArea('dresser1', { area: 'studio', ...studio(6, 5) }, 1000)).toBe(true);
    expect(registry.enterArea('dresser2', { area: 'studio', ...studio(9, 1) }, 1000)).toBe(true);

    // The pitch is far from the Exchange, so street players see only their
    // street neighbours: nobody on the roof above, nobody in the Studio.
    expect(visibleIds(registry, 'below')).toEqual([outside]);
    expect(visibleIds(registry, 'outside')).toEqual([below]);
    expect(visibleIds(registry, 'pitch')).toEqual([]);
    // Roof players see each other and the street below — but never a street
    // peer over the tower's footprint, nor the Studio.
    expect(visibleIds(registry, 'up1')).toEqual([up2, outside].sort());
    expect(visibleIds(registry, 'up2')).toEqual([up1, outside].sort());
    // Studio players see each other with their current look, and nobody else.
    expect(visibleIds(registry, 'dresser1')).toEqual([dresser2]);
    expect(visibleIds(registry, 'dresser2')).toEqual([dresser1]);
    expect(registry.areaFor('below')).toBe('street');
    expect(registry.areaFor('up1')).toBe('roof');
    expect(registry.areaFor('dresser1')).toBe('studio');
  });

  it('fills a roof view with roof players first, then the nearest street players, within one cap', () => {
    const registry = new LobbyPresence({ maxVisiblePeers: 4 });
    const roofIds: string[] = [];
    for (const [n, at] of [roof(1, 1), roof(5, 4)].entries()) {
      const session = `roof${n}`;
      roofIds.push(join(registry, session, centre(0, 0)));
      registry.enterArea(session, { area: 'roof', ...at }, 1000);
    }
    const observer = join(registry, 'observer', centre(0, 0));
    registry.enterArea('observer', { area: 'roof', ...roof(3, 2) }, 1000);
    // Six street players in front of the tower, nearer to the observer than
    // the far roof corner is, and one out of the interest box.
    const street: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      street.push(join(registry, `street${n}`, { x: roof(3, 2).x + (n - 3) * 8, y: roof(3, 2).y + (5 + n) * T }));
    }
    join(registry, 'far', { x: roof(3, 2).x + 30 * T, y: roof(3, 2).y + 6 * T });
    const seen = visibleIds(registry, 'observer');
    expect(seen).toHaveLength(4);
    for (const id of roofIds) expect(seen).toContain(id);
    // The two nearest street players take the rest.
    expect(seen.filter((id) => street.includes(id)).sort()).toEqual([street[0], street[1]].sort());
    // And nobody on the street sees anyone on the roof.
    for (let n = 0; n < 6; n += 1) {
      const view = visibleIds(registry, `street${n}`);
      expect(view).not.toContain(observer);
      for (const id of roofIds) expect(view).not.toContain(id);
    }
  });

  it('keeps the Studio strict both ways, with no one-way view of the street', () => {
    const registry = new LobbyPresence();
    const walker = join(registry, 'walker', studio(6, 5));
    const dresser = join(registry, 'dresser', studio(6, 6));
    registry.enterArea('dresser', { area: 'studio', ...studio(6, 6) }, 1000);
    const climber = join(registry, 'climber', centre(0, 0));
    registry.enterArea('climber', { area: 'roof', ...roof(2, 2) }, 1000);
    expect(visibleIds(registry, 'dresser')).toEqual([]);
    expect(visibleIds(registry, 'walker')).toEqual([]);
    expect(visibleIds(registry, 'climber')).not.toContain(dresser);
    expect(visibleIds(registry, 'climber')).not.toContain(walker);
  });

  it('applies the interest radius and cap inside a shared room as on the street', () => {
    const registry = new LobbyPresence({ maxVisiblePeers: 2 });
    for (const session of ['a', 'b', 'c', 'd']) {
      join(registry, session, centre(0, 0));
      registry.enterArea(session, { area: 'studio', ...studio(2, 2) }, 1000);
    }
    expect(registry.visibleTo('a')).toHaveLength(2);
  });

  it('never puts a player’s area on the room state or the wire', () => {
    const registry = new LobbyPresence();
    const encoder = new Encoder(registry.state);
    join(registry, 'walker', centre(40, 12));
    join(registry, 'climber', centre(41, 12));
    join(registry, 'dresser', centre(42, 12));
    registry.suspend('climber');
    registry.enterArea('climber', { area: 'roof', ...roof(2, 2) }, 1000);
    registry.enterArea('dresser', { area: 'studio', ...studio(9, 1) }, 1000);
    const state = JSON.stringify(registry.state).toLowerCase();
    const wire = Buffer.from(encoder.encodeAll()).toString('latin1').toLowerCase();
    for (const word of ['roof', 'studio', 'street', 'area']) {
      expect(state).not.toContain(word);
      expect(wire).not.toContain(word);
    }
  });
});

describe('movement is validated against the area’s own tiles (D-087)', () => {
  it('holds a roof player to the deck, step by step', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 'climber', centre(0, 0));
    registry.suspend('climber');
    registry.enterArea('climber', { area: 'roof', ...roof(5, 3) }, 1000);
    expect(registry.move('climber', roof(4, 3), 1100)).toBe('applied');
    expect(registry.move('climber', roof(1, 1), 1200)).toBe('applied');
    // Over the ledge, onto the street below, or anywhere else on the street.
    expect(registry.move('climber', roof(0, 1), 1300)).toBe('rejected');
    expect(registry.move('climber', { x: roof(1, 1).x, y: roof(1, 1).y + 6 * T }, 1400)).toBe('rejected');
    expect(registry.move('climber', centre(60, 14), 1500)).toBe('rejected');
    expect(registry.peers.get(id)?.position.toJSON()).toEqual(roof(1, 1));
    expect(registry.counters().rejected).toBe(3);
  });

  it('holds a Studio player to its floor and portal, and refuses a jump through a wall', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 'dresser', centre(40, 12));
    registry.enterArea('dresser', { area: 'studio', ...studio(15, 1) }, 1000);
    expect(registry.move('dresser', studio(15, 0), 1100)).toBe('applied');
    // From the gate straight to the far west of row one crosses the top hedge.
    expect(registry.move('dresser', { x: studio(1, 1).x, y: studio(1, 1).y - 15 }, 1200)).toBe('rejected');
    expect(registry.move('dresser', studio(15, -1), 1300)).toBe('rejected');
    expect(registry.move('dresser', studio(15, 1), 1400)).toBe('applied');
    expect(registry.move('dresser', studio(1, 1), 1500)).toBe('applied');
    expect(registry.move('dresser', studio(0, 1), 1600)).toBe('rejected');
    expect(registry.peers.get(id)?.position.toJSON()).toEqual(studio(1, 1));
  });

  it('keeps the street’s rule, a clamp to the world, for street players', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 'walker', centre(40, 12));
    // A Studio or roof position is just another street coordinate here.
    expect(registry.move('walker', studio(0, 0), 1000)).toBe('applied');
    expect(registry.move('walker', roof(0, 0), 1100)).toBe('applied');
    expect(registry.peers.get(id)?.position.toJSON()).toEqual(roof(0, 0));
  });

  it('refuses a rejected move without spending the move floor', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    join(registry, 'climber', centre(0, 0));
    registry.enterArea('climber', { area: 'roof', ...roof(3, 3) }, 1000);
    for (let n = 0; n < 10; n += 1) expect(registry.move('climber', roof(0, 0), 1100)).toBe('rejected');
    expect(registry.move('climber', roof(3, 2), 1100)).toBe('applied');
  });
});

describe('switching areas (D-087)', () => {
  it('moves one entry between areas, keeping its identifier, and refreshes the sprite', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 'dresser', centre(40, 12));
    const watcher = join(registry, 'watcher', centre(41, 12));
    const entry = registry.peers.get(id);
    expect(visibleIds(registry, 'watcher')).toEqual([id]);

    expect(registry.enterArea('dresser', { area: 'studio', ...studio(9, 1), facing: 'down', sprite: 'avatar-3' }, 1000)).toBe(true);
    expect(registry.peers.get(id)).toBe(entry);
    expect(registry.gameIdFor('dresser')).toBe(id);
    expect(visibleIds(registry, 'watcher')).toEqual([]);
    expect(visibleIds(registry, 'dresser')).toEqual([]);

    // A look change in the Studio re-enters the same area with the new sprite.
    expect(registry.enterArea('dresser', { area: 'studio', ...studio(4, 6), facing: 'left', sprite: 'avatar-12' }, 1100)).toBe(true);
    expect(entry?.sprite).toBe('avatar-12');
    expect(entry?.facing).toBe('left');

    expect(registry.enterArea('dresser', { area: 'street', ...centre(41, 13), sprite: 'avatar-12' }, 1200)).toBe(true);
    expect(registry.areaFor('dresser')).toBe('street');
    expect(visibleIds(registry, 'watcher')).toEqual([id]);
    expect(visibleIds(registry, 'dresser')).toEqual([watcher]);
    expect(registry.counters().areaSwitches).toBe(2);
  });

  it('enters the roof from a suspend and suspends again on the way down', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 'climber', centre(41, 12));
    join(registry, 'other', centre(0, 0));
    registry.suspend('other');
    registry.enterArea('other', { area: 'roof', ...roof(2, 2) }, 500);
    registry.suspend('climber');
    expect(registry.peers.has(id)).toBe(false);
    expect(registry.enterArea('climber', { area: 'roof', ...roof(5, 3), sprite: 'avatar-5' }, 1000)).toBe(true);
    expect(registry.peers.get(id)?.sprite).toBe('avatar-5');
    expect(registry.counters().suspended).toBe(0);
    expect(visibleIds(registry, 'other')).toEqual([id]);

    expect(registry.suspend('climber')).toBe(true);
    expect(registry.peers.has(id)).toBe(false);
    expect(visibleIds(registry, 'other')).toEqual([]);
    expect(registry.resume('climber', centre(41, 12), 2000)).toBe(true);
    expect(registry.areaFor('climber')).toBe('street');
  });

  it('suspends a session whose switch is malformed or lands off the area’s tiles', () => {
    const registry = new LobbyPresence();
    for (const request of [
      { area: 'roof', ...centre(41, 12) },
      { area: 'studio', ...studio(0, 0) },
      { area: 'vault', ...centre(41, 12) },
      { area: 'roof', x: Number.NaN, y: 10 },
      { area: { toString: () => 'roof' }, ...roof(2, 2) },
    ]) {
      const session = `s${Math.random()}`;
      const id = join(registry, session, centre(41, 12));
      expect(registry.enterArea(session, request, 1000)).toBe(false);
      expect(registry.peers.has(id)).toBe(false);
      expect(registry.areaFor(session)).toBeNull();
      expect(registry.move(session, centre(41, 12), 2000)).toBe('absent');
    }
    expect(registry.enterArea('unknown', { area: 'street', x: 0, y: 0 }, 1000)).toBe(false);
  });

  it('stamps the move floor, so switching is no faster a write channel than moving', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    join(registry, 'dresser', centre(40, 12));
    expect(registry.enterArea('dresser', { area: 'studio', ...studio(9, 1) }, 1000)).toBe(true);
    expect(registry.move('dresser', studio(9, 2), 1010)).toBe('throttled');
    expect(registry.move('dresser', studio(9, 2), 1200)).toBe('applied');
  });

  it('puts a carried block back and leaves the ball when a player leaves the street for a room', () => {
    const drops: SandboxTile[] = [];
    const registry = new LobbyPresence({
      sandboxRandom: mulberry32(87),
      onSandboxDrop: (tile) => drops.push(tile),
    });
    for (let n = 0; n < 200; n += 1) registry.spawnBlock();
    const id = join(registry, 'carrier', centre(40, 12));
    let now = 1000;
    let carried = false;
    for (const column of registry.sandboxColumns() as SandboxColumn[]) {
      const spot = { x: column.x + 1, y: column.y };
      if (spot.x >= SANDBOX_AREA.x + SANDBOX_AREA.width) continue;
      now += 200;
      registry.move('carrier', centre(spot.x, spot.y), now);
      if (registry.pickBlock('carrier', { x: column.x, y: column.y }, now) === 'applied') {
        carried = true;
        break;
      }
    }
    expect(carried).toBe(true);
    expect(registry.peers.get(id)?.carrying).toBeGreaterThanOrEqual(0);
    drops.length = 0;
    expect(registry.enterArea('carrier', { area: 'studio', ...studio(9, 1) }, now + 200)).toBe(true);
    expect(drops).toHaveLength(1);
    expect(registry.peers.get(id)?.carrying).toBe(-1);
    expect(registry.sandboxCarrying('carrier')).toBeNull();
    expect(registry.sandboxBlocks).toBe(200);
  });

  it('keeps shared-room players off the sandbox, the ball and the spawner', () => {
    const registry = new LobbyPresence({ footballKickIntervalMs: 0 });
    join(registry, 'dresser', centre(40, 12));
    registry.enterArea('dresser', { area: 'studio', ...studio(6, 5) }, 1000);
    // The Studio is drawn over the hidden street by the pitch, but its
    // players are not on the pitch or the street.
    expect(registry.hasLivePlayers).toBe(false);
    expect(registry.kickBall('dresser', 2000)).toBe('absent');
    expect(registry.pickBlock('dresser', { x: SANDBOX_AREA.x + 1, y: 1 }, 2000)).toBe('absent');
    expect(registry.placeBlock('dresser', { x: SANDBOX_AREA.x + 1, y: 1 }, 2000)).toBe('absent');
    expect(registry.keepFootballRunning(2000)).toBe(false);
    join(registry, 'walker', centre(40, 12));
    expect(registry.hasLivePlayers).toBe(true);
  });
});

describe('every other interior still suspends (D-019, D-087)', () => {
  it('takes a suspended player out of every area’s views and refuses its moves until it comes back', () => {
    const registry = new LobbyPresence();
    const banker = join(registry, 'banker', centre(40, 12));
    join(registry, 'walker', centre(41, 12));
    join(registry, 'climber', centre(41, 12));
    join(registry, 'dresser', centre(41, 12));
    registry.enterArea('climber', { area: 'roof', ...roof(2, 2) }, 1000);
    registry.enterArea('dresser', { area: 'studio', ...studio(2, 2) }, 1000);

    expect(registry.suspend('banker')).toBe(true);
    expect(registry.peers.has(banker)).toBe(false);
    for (const observer of ['walker', 'climber', 'dresser']) {
      expect(visibleIds(registry, observer)).not.toContain(banker);
    }
    expect(registry.visibleTo('banker')).toEqual([]);
    expect(registry.move('banker', centre(40, 12), 2000)).toBe('absent');
    expect(registry.areaFor('banker')).toBeNull();
    expect(registry.resume('banker', centre(40, 12), 3000)).toBe(true);
    expect(visibleIds(registry, 'walker')).toContain(banker);
  });
});
