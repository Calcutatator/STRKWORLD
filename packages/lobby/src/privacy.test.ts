/**
 * The tests this lane exists for.
 *
 * Everything else in the package can be rewritten. These three properties
 * cannot change without a decision entry:
 *
 *   1. The room schema's field set is exactly the frozen `PresenceState`.
 *   2. Suspending takes a player out of every other observer's view.
 *   3. No sequence of client input puts a financial-looking string into room
 *      state or onto the wire.
 *
 * The vocabulary they scan for lives in `testing/forbidden-vocabulary.json`
 * rather than in this file, because check 5 of `scripts/check-invariants.sh`
 * fails the build on those words appearing in any lobby `.ts` file — see the
 * `why` note inside the fixture.
 */

import { Encoder, Metadata } from '@colyseus/schema';
import { describe, expect, it } from 'vitest';
import type { Position, PresenceState } from '@strkworld/shared';
import { LobbyPresence } from './presence';
import { LobbyState, PositionSchema, PresenceEntry } from './state';
import vocabulary from './testing/forbidden-vocabulary.json';

/**
 * The frozen field set, written out as a value.
 *
 * `Record<keyof PresenceState, true>` makes this a compile-time assertion as
 * well as a runtime one: adding a field to the frozen seam without adding it
 * here fails the typecheck, and adding one here that the seam does not have
 * fails it too.
 */
const FROZEN_PRESENCE_FIELDS: Record<keyof PresenceState, true> = {
  gameId: true,
  position: true,
  facing: true,
  sprite: true,
};

const FROZEN_POSITION_FIELDS: Record<keyof Position, true> = {
  x: true,
  y: true,
};

function fieldNames(klass: unknown): string[] {
  return Object.keys(Metadata.getFields(klass) as Record<string, unknown>).sort();
}

/** What the room holds, as the room itself would serialise it. */
function stateOf(registry: LobbyPresence): string {
  return JSON.stringify(registry.state);
}

/**
 * What the room would actually put on the wire.
 *
 * Stronger than the JSON view and slower, so the randomised sequence samples
 * it rather than running it on every step.
 */
function wireOf(encoder: Encoder): string {
  return Buffer.from(encoder.encodeAll()).toString('latin1');
}

function findLeak(surface: string): string | null {
  const haystack = surface.toLowerCase();
  for (const word of vocabulary.substrings) {
    if (haystack.includes(word)) return `substring "${word}"`;
  }
  for (const pattern of vocabulary.patterns) {
    if (new RegExp(pattern.regex).test(surface)) return `pattern "${pattern.name}"`;
  }
  return null;
}

/**
 * A well-formed identifier from a small number.
 *
 * Prefixed with hex letters so the digits never form a run long enough to look
 * like a wei-scale integer to the scan — a real generated identifier is 16
 * random hex characters and has the same property with overwhelming odds.
 */
function id(n: number): string {
  return `ab${String(n).padStart(14, '0')}`;
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

describe('the schema is the enforcement point', () => {
  it('carries exactly the frozen PresenceState field set', () => {
    expect(fieldNames(PresenceEntry)).toEqual(
      Object.keys(FROZEN_PRESENCE_FIELDS).sort(),
    );
  });

  it('carries exactly the frozen Position field set', () => {
    expect(fieldNames(PositionSchema)).toEqual(
      Object.keys(FROZEN_POSITION_FIELDS).sort(),
    );
  });

  it('has one field at the root, holding presence entries', () => {
    expect(fieldNames(LobbyState)).toEqual(['peers']);
  });

  it('declares no field type that could hold a structured payload', () => {
    const fields = Metadata.getFields(PresenceEntry) as Record<string, unknown>;
    expect(fields['gameId']).toBe('string');
    expect(fields['facing']).toBe('string');
    expect(fields['sprite']).toBe('string');
    expect(fields['position']).toBe(PositionSchema);
  });

  it('does not encode a property that is not declared', () => {
    const registry = new LobbyPresence();
    registry.admit('s1', { gameId: id(1), x: 1, y: 2 });
    const entry = registry.peers.get(id(1));
    expect(entry).toBeDefined();

    for (const attempt of vocabulary.smuggleAttempts) {
      Reflect.set(entry as object, 'extra', attempt);
    }

    expect(stateOf(registry)).not.toContain('extra');
    expect(findLeak(stateOf(registry))).toBeNull();
    expect(findLeak(wireOf(new Encoder(registry.state)))).toBeNull();
  });
});

describe('suspend removes a player from every other view', () => {
  it('takes the entry out of a nearby observer’s interest set', () => {
    const registry = new LobbyPresence({ interestRadius: 500 });
    registry.admit('watcher', { gameId: id(1), x: 0, y: 0 });
    registry.admit('walker', { gameId: id(2), x: 20, y: 20 });

    expect(registry.visibleTo('watcher').map((e) => e.gameId)).toEqual([id(2)]);

    registry.suspend('walker');

    expect(registry.visibleTo('watcher')).toEqual([]);
    expect(registry.peers.has(id(2))).toBe(false);
  });

  it('leaves nothing behind about where the player was standing', () => {
    const registry = new LobbyPresence();
    registry.admit('walker', { gameId: id(2), x: 1234, y: 5678 });
    registry.suspend('walker');
    expect(stateOf(registry)).not.toContain('1234');
    expect(stateOf(registry)).not.toContain('5678');
  });

  it('puts the player back only where the client says, on an explicit resume', () => {
    const registry = new LobbyPresence({ interestRadius: 500 });
    registry.admit('watcher', { gameId: id(1), x: 0, y: 0 });
    registry.admit('walker', { gameId: id(2), x: 20, y: 20 });
    registry.suspend('walker');
    registry.resume('walker', { x: 30, y: 30 });

    const seen = registry.visibleTo('watcher');
    expect(seen.map((e) => e.gameId)).toEqual([id(2)]);
    expect(seen[0]?.position.x).toBe(30);
  });
});

describe('no sequence of client input reaches state with money in it', () => {
  it('refuses every hostile value offered as an identifier', () => {
    const registry = new LobbyPresence();
    vocabulary.smuggleAttempts.forEach((attempt, index) => {
      const outcome = registry.admit(`s${index}`, { gameId: attempt, x: 0, y: 0 });
      expect(outcome).toEqual({ ok: false, reason: 'malformed-id' });
    });
    expect(registry.peers.size).toBe(0);
    expect(findLeak(stateOf(registry))).toBeNull();
  });

  it('replaces every hostile value offered as a sprite or a facing', () => {
    const registry = new LobbyPresence();
    vocabulary.smuggleAttempts.forEach((attempt, index) => {
      registry.admit(`s${index}`, {
        gameId: id(index),
        x: 0,
        y: 0,
        sprite: attempt,
        facing: attempt,
      });
    });
    expect(registry.peers.size).toBe(vocabulary.smuggleAttempts.length);
    expect(findLeak(stateOf(registry))).toBeNull();
    expect(findLeak(wireOf(new Encoder(registry.state)))).toBeNull();
  });

  it('stays clean across a long randomised sequence of operations', () => {
    const registry = new LobbyPresence({
      interestRadius: 400,
      minUpdateIntervalMs: 50,
      capacity: 12,
    });
    const encoder = new Encoder(registry.state);
    const random = mulberry32(20260816);
    const sessions = Array.from({ length: 12 }, (_unused, n) => `s${n}`);
    const attempts = vocabulary.smuggleAttempts;
    let clock = 0;

    for (let step = 0; step < 4000; step += 1) {
      clock += Math.floor(random() * 120);
      const session = sessions[Math.floor(random() * sessions.length)] as string;
      const index = sessions.indexOf(session);
      const hostile = random() < 0.4;
      const payload = hostile
        ? attempts[Math.floor(random() * attempts.length)]
        : undefined;

      switch (Math.floor(random() * 5)) {
        case 0:
          registry.admit(session, {
            gameId: hostile ? payload : id(index),
            x: hostile ? payload : Math.floor(random() * 2000) - 1000,
            y: hostile ? payload : Math.floor(random() * 2000) - 1000,
            facing: hostile ? payload : 'up',
            sprite: hostile ? payload : 'avatar-2',
          });
          break;
        case 1:
          registry.move(
            session,
            {
              x: hostile ? payload : Math.floor(random() * 2000) - 1000,
              y: hostile ? payload : Math.floor(random() * 2000) - 1000,
              facing: hostile ? payload : 'left',
            },
            clock,
          );
          break;
        case 2:
          registry.suspend(session);
          break;
        case 3:
          registry.resume(session, {
            x: hostile ? payload : Math.floor(random() * 2000) - 1000,
            y: hostile ? payload : Math.floor(random() * 2000) - 1000,
            sprite: hostile ? payload : 'avatar-4',
          });
          break;
        default:
          registry.release(session);
          break;
      }

      const leak = findLeak(stateOf(registry));
      expect(leak, `step ${step} leaked ${leak}`).toBeNull();
      if (step % 250 === 0) {
        const onWire = findLeak(wireOf(encoder));
        expect(onWire, `step ${step} put ${onWire} on the wire`).toBeNull();
      }
    }

    const counters = registry.counters();
    expect(counters.admitted).toBeGreaterThan(0);
    expect(counters.refused).toBeGreaterThan(0);
    expect(counters.suspensions).toBeGreaterThan(0);
  });
});
