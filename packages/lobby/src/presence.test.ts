import { describe, expect, it } from 'vitest';
import type { GameId } from '@strkworld/shared';
import { DEFAULT_SPRITE_KEYS, GAME_ID_PATTERN } from './config';
import { LobbyPresence } from './presence';

/**
 * Admit a session and return the server-minted identifier.
 *
 * The identifier is the server's to choose now (see `admit`), so tests capture
 * it from the outcome rather than supplying one.
 */
function join(
  registry: LobbyPresence,
  session: string,
  x = 0,
  y = 0,
): GameId {
  const outcome = registry.admit(session, { x, y });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.gameId;
}

describe('admission', () => {
  it('snapshots a configured sprite allowlist at construction', () => {
    const spriteKeys = ['avatar-1', 'avatar-2'];
    const registry = new LobbyPresence({ spriteKeys });
    spriteKeys.push('avatar-3');

    const outcome = registry.admit('s1', { x: 0, y: 0, sprite: 'avatar-3' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const gameId = outcome.gameId;
    expect(registry.peers.get(gameId)?.sprite).toBe('avatar-1');
  });

  it('publishes exactly D-047\'s sixteen opaque sprite keys', () => {
    expect(DEFAULT_SPRITE_KEYS).toEqual([
      'avatar-1',
      'avatar-2',
      'avatar-3',
      'avatar-4',
      'avatar-5',
      'avatar-6',
      'avatar-7',
      'avatar-8',
      'avatar-9',
      'avatar-10',
      'avatar-11',
      'avatar-12',
      'avatar-13',
      'avatar-14',
      'avatar-15',
      'avatar-16',
    ]);
  });

  it.each(['avatar-9', 'avatar-16'])('admits the approved D-047 sprite key %s', (sprite) => {
    const registry = new LobbyPresence();
    const outcome = registry.admit('s1', { x: 0, y: 0, sprite });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(registry.peers.get(outcome.gameId)?.sprite).toBe(sprite);
  });

  it('admits a well-formed request and puts one entry on the street', () => {
    const registry = new LobbyPresence();
    const outcome = registry.admit('s1', {
      x: 12.6,
      y: -3.2,
      facing: 'left',
      sprite: 'avatar-3',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(GAME_ID_PATTERN.test(outcome.gameId)).toBe(true);
    expect(registry.peers.size).toBe(1);
    const entry = registry.peers.get(outcome.gameId);
    expect(entry?.position.x).toBe(13);
    expect(entry?.position.y).toBe(-3);
    expect(entry?.facing).toBe('left');
    expect(entry?.sprite).toBe('avatar-3');
  });

  it('mints the identifier on the server and ignores a client-supplied one', () => {
    const registry = new LobbyPresence();
    // A client-supplied gameId has no field in PlacementRequest, but an object
    // on the wire could still carry one; it must not become the identity.
    const outcome = registry.admit('s1', {
      x: 0,
      y: 0,
      // @ts-expect-error — gameId is deliberately not part of PlacementRequest
      gameId: 'ffffffffffffffff',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.gameId).not.toBe('ffffffffffffffff');
    expect(registry.peers.has('ffffffffffffffff' as GameId)).toBe(false);
  });

  it('mints a distinct identifier per session', () => {
    const registry = new LobbyPresence();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(join(registry, `s${i}`));
    expect(ids.size).toBe(20);
  });

  it('refuses a second admission on one connection', () => {
    const registry = new LobbyPresence();
    join(registry, 's1');
    expect(registry.admit('s1', { x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'session-in-use',
    });
  });

  it('refuses a placement that is not a finite position', () => {
    const registry = new LobbyPresence();
    expect(registry.admit('s1', { x: Number.NaN, y: 0 })).toEqual({
      ok: false,
      reason: 'bad-placement',
    });
  });

  it.each([null, undefined])(
    'fails closed for %s placement payloads on every public placement path',
    (payload) => {
      const registry = new LobbyPresence();
      expect(registry.admit('malformed', payload as never)).toEqual({
        ok: false,
        reason: 'bad-placement',
      });

      join(registry, 's1');
      expect(registry.move('s1', payload as never, 0)).toBe('rejected');
      registry.suspend('s1');
      expect(registry.resume('s1', payload as never, 0)).toBe(false);
    },
  );

  it('refuses once the room is full', () => {
    const registry = new LobbyPresence({ capacity: 2 });
    join(registry, 's1');
    join(registry, 's2');
    expect(registry.admit('s3', { x: 0, y: 0 })).toEqual({
      ok: false,
      reason: 'at-capacity',
    });
  });

  it.each(['anything-else', 'avatar-17'])(
    'substitutes the default sprite for the unrecognised key %s',
    (sprite) => {
      const registry = new LobbyPresence();
      const id = join(registry, 's1');
      registry.release('s1');
      const outcome = registry.admit('s1', { x: 0, y: 0, sprite });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      expect(registry.peers.get(outcome.gameId)?.sprite).toBe('avatar-1');
      void id;
    },
  );
});

describe('movement', () => {
  it('applies a due update', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 's1');
    expect(registry.move('s1', { x: 100, y: 200, facing: 'up' }, 1000)).toBe(
      'applied',
    );
    const entry = registry.peers.get(id);
    expect(entry?.position.x).toBe(100);
    expect(entry?.facing).toBe('up');
  });

  it('drops an update that arrives inside the rate floor', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 's1');
    registry.move('s1', { x: 10, y: 10 }, 1000);
    expect(registry.move('s1', { x: 20, y: 20 }, 1010)).toBe('throttled');
    expect(registry.peers.get(id)?.position.x).toBe(10);
    expect(registry.move('s1', { x: 30, y: 30 }, 1050)).toBe('applied');
    expect(registry.peers.get(id)?.position.x).toBe(30);
  });

  it('keeps the server move floor through a rollback and lets it progress later', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 's1');

    expect(registry.move('s1', { x: 10, y: 10 }, 1000)).toBe('applied');
    expect(registry.move('s1', { x: 20, y: 20 }, 900)).toBe('throttled');
    expect(registry.move('s1', { x: 30, y: 30 }, 1000)).toBe('throttled');
    expect(registry.move('s1', { x: 40, y: 40 }, 1050)).toBe('applied');
    expect(registry.peers.get(id)?.position.x).toBe(40);
  });

  it('fails closed for an invalid clock sample without changing placement', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    const id = join(registry, 's1');

    expect(registry.move('s1', { x: 10, y: 10 }, Number.NaN)).toBe('throttled');
    expect(registry.peers.get(id)?.position.x).toBe(0);
    expect(registry.move('s1', { x: 10, y: 10 }, 0)).toBe('applied');
  });

  it('rejects a position that is not finite, without spending the rate floor', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    join(registry, 's1');
    expect(registry.move('s1', { x: Infinity, y: 0 }, 1000)).toBe('rejected');
    expect(registry.move('s1', { x: 5, y: 5 }, 1000)).toBe('applied');
  });

  it('ignores a move from an unknown or suspended session', () => {
    const registry = new LobbyPresence();
    expect(registry.move('ghost', { x: 1, y: 1 }, 1000)).toBe('absent');
    join(registry, 's1');
    registry.suspend('s1');
    expect(registry.move('s1', { x: 1, y: 1 }, 1000)).toBe('absent');
  });
});

describe('suspend and resume', () => {
  it('erases the entry on suspend and keeps the connection', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 300, 400);
    expect(registry.suspend('s1')).toBe(true);
    expect(registry.peers.size).toBe(0);
    expect(registry.gameIdFor('s1')).toBe(id);
    expect(registry.entryFor('s1')).toBeUndefined();
  });

  it('is idempotent', () => {
    const registry = new LobbyPresence();
    join(registry, 's1');
    expect(registry.suspend('s1')).toBe(true);
    expect(registry.suspend('s1')).toBe(false);
  });

  it('takes a fresh placement on resume, because the old one is gone', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 300, 400);
    registry.suspend('s1');
    expect(registry.resume('s1', { x: 10, y: 20, facing: 'right' }, 1000)).toBe(true);
    const entry = registry.peers.get(id);
    expect(entry?.position.x).toBe(10);
    expect(entry?.position.y).toBe(20);
    expect(entry?.facing).toBe('right');
  });

  it('falls back rather than storing an unknown resumed sprite', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1');
    registry.suspend('s1');

    expect(registry.resume('s1', { x: 10, y: 20, sprite: 'avatar-17' }, 1000)).toBe(true);
    expect(registry.peers.get(id)?.sprite).toBe('avatar-1');
  });

  it('refuses to resume a session that is not suspended', () => {
    const registry = new LobbyPresence();
    join(registry, 's1');
    expect(registry.resume('s1', { x: 0, y: 0 }, 1000)).toBe(false);
    expect(registry.resume('unknown', { x: 0, y: 0 }, 1000)).toBe(false);
  });

  it('does not reset the rate floor across a suspend/resume (DEFECT 7)', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    join(registry, 's1');
    // Accept a move at t=1000, consuming the floor.
    expect(registry.move('s1', { x: 1, y: 1 }, 1000)).toBe('applied');
    // Suspend then resume at t=1010 — inside the floor.
    registry.suspend('s1');
    expect(registry.resume('s1', { x: 2, y: 2 }, 1010)).toBe(true);
    // A move immediately after resume must still respect the floor: the
    // suspend/resume did not hand the client a free write.
    expect(registry.move('s1', { x: 3, y: 3 }, 1015)).toBe('throttled');
    expect(registry.move('s1', { x: 4, y: 4 }, 1070)).toBe('applied');
  });

  it('refuses an invalid-time resume so it cannot bypass the move floor', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    join(registry, 's1');
    registry.suspend('s1');

    expect(registry.resume('s1', { x: 2, y: 2 }, Infinity)).toBe(false);
    expect(registry.entryFor('s1')).toBeUndefined();
    expect(registry.resume('s1', { x: 2, y: 2 }, 1000)).toBe(true);
    expect(registry.move('s1', { x: 3, y: 3 }, 1049)).toBe('throttled');
    expect(registry.move('s1', { x: 4, y: 4 }, 1050)).toBe('applied');
  });
});

describe('release', () => {
  it('forgets everything about a connection', () => {
    const registry = new LobbyPresence();
    join(registry, 's1');
    registry.release('s1');
    expect(registry.peers.size).toBe(0);
    expect(registry.gameIdFor('s1')).toBeUndefined();
    join(registry, 's2');
    expect(registry.peers.size).toBe(1);
  });

  it('is a no-op on an unknown session (as after a failed join)', () => {
    const registry = new LobbyPresence();
    expect(() => registry.release('never-admitted')).not.toThrow();
    expect(registry.peers.size).toBe(0);
  });
});

describe('interest', () => {
  it('shows only peers inside the radius, and never the observer itself', () => {
    const registry = new LobbyPresence({ interestRadius: 100 });
    join(registry, 's1', 0, 0);
    const near = join(registry, 's2', 50, 0);
    join(registry, 's3', 5000, 0);

    const visible = registry.visibleTo('s1').map((entry) => entry.gameId);
    expect(visible).toEqual([near]);
  });

  it('caps a crowd at the configured ceiling', () => {
    const registry = new LobbyPresence({
      interestRadius: 10_000,
      maxVisiblePeers: 3,
    });
    join(registry, 'observer', 0, 0);
    for (let n = 1; n <= 10; n += 1) join(registry, `s${n}`, n * 10, 0);
    expect(registry.visibleTo('observer')).toHaveLength(3);
  });

  it('shows nothing to a suspended observer', () => {
    const registry = new LobbyPresence({ interestRadius: 100 });
    join(registry, 's1', 0, 0);
    join(registry, 's2', 10, 0);
    registry.suspend('s1');
    expect(registry.visibleTo('s1')).toEqual([]);
  });
});

describe('counters', () => {
  it('reports aggregates only', () => {
    const registry = new LobbyPresence({ minUpdateIntervalMs: 50 });
    join(registry, 's1');
    join(registry, 's2');
    registry.admit('s1', { x: 0, y: 0 }); // session-in-use → refused
    registry.move('s1', { x: 1, y: 1 }, 1000);
    registry.move('s1', { x: 2, y: 2 }, 1001); // throttled
    registry.suspend('s2');
    registry.resume('s2', { x: 0, y: 0 }, 2000);
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
    join(registry, 's1');
    for (const value of Object.values(registry.counters())) {
      expect(typeof value).toBe('number');
    }
  });
});
