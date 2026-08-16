import { describe, expect, it } from 'vitest';
import { LobbyPresence } from './presence';

/** A well-formed identifier from a small number. Digits are valid hex. */
function id(n: number): string {
  return String(n).padStart(16, '0');
}

function joined(
  registry: LobbyPresence,
  session: string,
  n: number,
  x = 0,
  y = 0,
): void {
  const outcome = registry.admit(session, { gameId: id(n), x, y });
  expect(outcome.ok).toBe(true);
}

describe('admission', () => {
  it('admits a well-formed request and puts one entry on the street', () => {
    const registry = new LobbyPresence();
    const outcome = registry.admit('s1', {
      gameId: id(1),
      x: 12.6,
      y: -3.2,
      facing: 'left',
      sprite: 'avatar-3',
    });

    expect(outcome).toEqual({ ok: true, gameId: id(1) });
    expect(registry.peers.size).toBe(1);
    const entry = registry.peers.get(id(1));
    expect(entry?.position.x).toBe(13);
    expect(entry?.position.y).toBe(-3);
    expect(entry?.facing).toBe('left');
    expect(entry?.sprite).toBe('avatar-3');
  });

  it('refuses a malformed identifier', () => {
    const registry = new LobbyPresence();
    expect(registry.admit('s1', { gameId: 'not-hex', x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'malformed-id',
    });
    expect(registry.peers.size).toBe(0);
  });

  it('refuses an identifier another live session already holds', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    expect(registry.admit('s2', { gameId: id(1), x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'id-in-use',
    });
    expect(registry.peers.size).toBe(1);
  });

  it('refuses a second admission on one connection', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    expect(registry.admit('s1', { gameId: id(2), x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'session-in-use',
    });
  });

  it('refuses a placement that is not a finite position', () => {
    const registry = new LobbyPresence();
    expect(registry.admit('s1', { gameId: id(1), x: Number.NaN, y: 0 })).toEqual({
      ok: false,
      reason: 'bad-placement',
    });
  });

  it('refuses once the room is full', () => {
    const registry = new LobbyPresence({ capacity: 2 });
    joined(registry, 's1', 1);
    joined(registry, 's2', 2);
    expect(registry.admit('s3', { gameId: id(3), x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'at-capacity',
    });
  });

  it('substitutes the default sprite for an unrecognised key', () => {
    const registry = new LobbyPresence();
    registry.admit('s1', { gameId: id(1), x: 0, y: 0, sprite: 'anything-else' });
    expect(registry.peers.get(id(1))?.sprite).toBe('avatar-1');
  });
});

describe('movement', () => {
  it('applies a due update', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    joined(registry, 's1', 1);
    expect(registry.move('s1', { x: 100, y: 200, facing: 'up' }, 1000)).toBe(
      'applied',
    );
    const entry = registry.peers.get(id(1));
    expect(entry?.position.x).toBe(100);
    expect(entry?.facing).toBe('up');
  });

  it('drops an update that arrives inside the rate floor', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    joined(registry, 's1', 1);
    registry.move('s1', { x: 10, y: 10 }, 1000);
    expect(registry.move('s1', { x: 20, y: 20 }, 1010)).toBe('throttled');
    expect(registry.peers.get(id(1))?.position.x).toBe(10);
    expect(registry.move('s1', { x: 30, y: 30 }, 1050)).toBe('applied');
    expect(registry.peers.get(id(1))?.position.x).toBe(30);
  });

  it('rejects a position that is not finite, without spending the rate floor', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    joined(registry, 's1', 1);
    expect(registry.move('s1', { x: Infinity, y: 0 }, 1000)).toBe('rejected');
    expect(registry.move('s1', { x: 5, y: 5 }, 1000)).toBe('applied');
  });

  it('ignores a move from an unknown or suspended session', () => {
    const registry = new LobbyPresence();
    expect(registry.move('ghost', { x: 1, y: 1 }, 1000)).toBe('absent');
    joined(registry, 's1', 1);
    registry.suspend('s1');
    expect(registry.move('s1', { x: 1, y: 1 }, 1000)).toBe('absent');
  });
});

describe('suspend and resume', () => {
  it('erases the entry on suspend and keeps the connection', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1, 300, 400);
    expect(registry.suspend('s1')).toBe(true);
    expect(registry.peers.size).toBe(0);
    expect(registry.gameIdFor('s1')).toBe(id(1));
    expect(registry.entryFor('s1')).toBeUndefined();
  });

  it('keeps the identifier reserved while suspended', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    registry.suspend('s1');
    expect(registry.admit('s2', { gameId: id(1), x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'id-in-use',
    });
  });

  it('is idempotent', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    expect(registry.suspend('s1')).toBe(true);
    expect(registry.suspend('s1')).toBe(false);
  });

  it('takes a fresh placement on resume, because the old one is gone', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1, 300, 400);
    registry.suspend('s1');
    expect(registry.resume('s1', { x: 10, y: 20, facing: 'right' })).toBe(true);
    const entry = registry.peers.get(id(1));
    expect(entry?.position.x).toBe(10);
    expect(entry?.position.y).toBe(20);
    expect(entry?.facing).toBe('right');
  });

  it('refuses to resume a session that is not suspended', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    expect(registry.resume('s1', { x: 0, y: 0 })).toBe(false);
    expect(registry.resume('unknown', { x: 0, y: 0 })).toBe(false);
  });
});

describe('release', () => {
  it('forgets everything about a connection', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    registry.release('s1');
    expect(registry.peers.size).toBe(0);
    expect(registry.gameIdFor('s1')).toBeUndefined();
    joined(registry, 's2', 1);
    expect(registry.peers.size).toBe(1);
  });
});

describe('interest', () => {
  it('shows only peers inside the radius, and never the observer itself', () => {
    const registry = new LobbyPresence({ interestRadius: 100 });
    joined(registry, 's1', 1, 0, 0);
    joined(registry, 's2', 2, 50, 0);
    joined(registry, 's3', 3, 5000, 0);

    const visible = registry.visibleTo('s1').map((entry) => entry.gameId);
    expect(visible).toEqual([id(2)]);
  });

  it('caps a crowd at the configured ceiling', () => {
    const registry = new LobbyPresence({
      interestRadius: 10_000,
      maxVisiblePeers: 3,
    });
    joined(registry, 'observer', 0, 0, 0);
    for (let n = 1; n <= 10; n += 1) joined(registry, `s${n}`, n, n * 10, 0);
    expect(registry.visibleTo('observer')).toHaveLength(3);
  });

  it('shows nothing to a suspended observer', () => {
    const registry = new LobbyPresence({ interestRadius: 100 });
    joined(registry, 's1', 1, 0, 0);
    joined(registry, 's2', 2, 10, 0);
    registry.suspend('s1');
    expect(registry.visibleTo('s1')).toEqual([]);
  });
});

describe('counters', () => {
  it('reports aggregates only', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    joined(registry, 's1', 1);
    joined(registry, 's2', 2);
    registry.admit('s3', { gameId: 'bad', x: 0, y: 0 });
    registry.move('s1', { x: 1, y: 1 }, 1000);
    registry.move('s1', { x: 2, y: 2 }, 1001);
    registry.suspend('s2');
    registry.resume('s2', { x: 0, y: 0 });
    registry.release('s1');

    expect(registry.counters()).toEqual({
      present: 1,
      suspended: 0,
      admitted: 2,
      refused: 1,
      departed: 1,
      suspensions: 1,
      resumptions: 1,
      throttled: 1,
      peak: 2,
    });
  });

  it('exposes no key that could name a single player', () => {
    const registry = new LobbyPresence();
    joined(registry, 's1', 1);
    for (const value of Object.values(registry.counters())) {
      expect(typeof value).toBe('number');
    }
  });
});
