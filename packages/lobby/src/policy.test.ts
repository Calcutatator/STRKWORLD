import { describe, expect, it } from 'vitest';
import { STREET_ORIGIN_X } from '@strkworld/shared';
import {
  DEFAULT_ROOM_CONFIG,
  DEFAULT_SPRITE_KEYS,
  GAME_ID_PATTERN,
  MESSAGE,
  SERVER_MESSAGE,
  WORLD_LIMIT,
} from './config';
import {
  UpdateThrottle,
  createGameId,
  distanceBetween,
  isWithinInterest,
  normalizeCoordinate,
  normalizeFacing,
  normalizeGameId,
  normalizeSandboxColour,
  normalizeSandboxTile,
  normalizeSprite,
  selectVisible,
} from './policy';

/**
 * D-078 moved the street, the sandbox with it, east by the pitch square. The
 * tiles here keep D-060's numbering: `S(n)` is the street's column `n`, so the
 * square is `S(54)` to `S(81)`.
 */
const S = (column: number): number => STREET_ORIGIN_X + column;

const SPRITES = ['avatar-1', 'avatar-2'];

describe('default lobby vocabulary ownership', () => {
  it('does not expose a mutable default sprite allowlist', () => {
    expect(Reflect.set(DEFAULT_SPRITE_KEYS, 0, 'not-a-sprite')).toBe(false);
    expect(DEFAULT_SPRITE_KEYS[0]).toBe('avatar-1');
    expect(DEFAULT_ROOM_CONFIG.spriteKeys[0]).toBe('avatar-1');
  });

  it('does not expose mutable wire protocol names', () => {
    expect(Reflect.set(MESSAGE, 'move', 'untrusted-move')).toBe(false);
    expect(Reflect.set(MESSAGE, 'resume', 'untrusted-resume')).toBe(false);
    expect(Reflect.set(SERVER_MESSAGE, 'welcome', 'untrusted-welcome')).toBe(false);
    expect(MESSAGE.move).toBe('move');
    expect(MESSAGE.resume).toBe('resume');
    expect(SERVER_MESSAGE.welcome).toBe('welcome');
  });

  it('does not expose mutable sandbox protocol names (D-060)', () => {
    expect(Reflect.set(MESSAGE, 'sandboxPick', 'untrusted')).toBe(false);
    expect(Reflect.set(SERVER_MESSAGE, 'sandboxDrop', 'untrusted')).toBe(false);
    expect(Reflect.set(SERVER_MESSAGE, 'sandboxBurst', 'untrusted')).toBe(false);
    expect(MESSAGE.sandboxPick).toBe('sandbox:pick');
    expect(MESSAGE.sandboxPlace).toBe('sandbox:place');
    expect(SERVER_MESSAGE.sandboxDrop).toBe('sandbox:drop');
    // D-071.
    expect(SERVER_MESSAGE.sandboxBurst).toBe('sandbox:burst');
    expect(Object.keys(SERVER_MESSAGE).sort()).toEqual(['goal', 'sandboxBurst', 'sandboxDrop', 'welcome']);
  });

  it('does not expose mutable football protocol names (D-078)', () => {
    expect(Reflect.set(MESSAGE, 'kick', 'untrusted')).toBe(false);
    expect(Reflect.set(SERVER_MESSAGE, 'goal', 'untrusted')).toBe(false);
    expect(MESSAGE.kick).toBe('football:kick');
    expect(SERVER_MESSAGE.goal).toBe('football:goal');
    expect(Object.keys(MESSAGE).sort()).toEqual(['kick', 'move', 'resume', 'sandboxPick', 'sandboxPlace', 'suspend']);
  });
});

describe('normalizeSandboxTile', () => {
  it('accepts an integer tile inside the sandbox and returns a frozen copy', () => {
    const raw = { x: S(54), y: 0, extra: 'dropped' };
    const tile = normalizeSandboxTile(raw);
    expect(tile).toEqual({ x: S(54), y: 0 });
    expect(Object.isFrozen(tile)).toBe(true);
    expect(tile).not.toBe(raw);
    expect(normalizeSandboxTile({ x: S(81), y: 27 })).toEqual({ x: S(81), y: 27 });
  });

  it('rejects everything else without invoking accessors or traps', () => {
    let touched = false;
    const accessor = Object.defineProperty({ y: 1 }, 'x', {
      enumerable: true,
      get: () => {
        touched = true;
        return S(60);
      },
    });
    const trap = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        touched = true;
        throw new Error('hostile trap');
      },
    });
    for (const raw of [
      null,
      undefined,
      S(60),
      `${S(60)},1`,
      [S(60), 1],
      {},
      { x: S(60) },
      { x: S(53), y: 1 },
      { x: S(82), y: 1 },
      { x: S(60), y: -1 },
      { x: S(60), y: 28 },
      { x: S(60) + 0.5, y: 1 },
      { x: Number.NaN, y: 1 },
      { x: S(60), y: Number.POSITIVE_INFINITY },
      { x: String(S(60)), y: '1' },
      Object.create({ x: S(60), y: 1 }),
      accessor,
    ]) {
      expect(normalizeSandboxTile(raw)).toBeNull();
    }
    expect(touched).toBe(false);
    expect(normalizeSandboxTile(trap)).toBeNull();
  });
});

describe('normalizeSandboxColour', () => {
  it('accepts exactly the integer palette indices', () => {
    for (let colour = 0; colour < 8; colour += 1) expect(normalizeSandboxColour(colour)).toBe(colour);
    for (const raw of [-1, 8, 2.5, Number.NaN, '3', null, undefined, {}]) {
      expect(normalizeSandboxColour(raw)).toBeNull();
    }
  });
});

describe('normalizeGameId', () => {
  it('accepts exactly 16 lowercase hex characters', () => {
    expect(normalizeGameId('0123456789abcdef')).toBe('0123456789abcdef');
  });

  it('rejects an injected randomness source with the wrong byte length', () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(9)]) {
      expect(() => createGameId(() => bytes)).toThrow(
        'Lobby game id randomness must return exactly 8 bytes',
      );
    }
  });

  it('rejects anything else', () => {
    const rejected = [
      '',
      '0123456789ABCDEF',
      '0123456789abcde',
      '0123456789abcdef0',
      '0123456789abcdeg',
      '0x0123456789abcd',
      42,
      null,
      undefined,
      { toString: () => '0123456789abcdef' },
    ];
    for (const candidate of rejected) {
      expect(normalizeGameId(candidate)).toBeNull();
    }
  });

  it('generates identifiers it would accept', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(GAME_ID_PATTERN.test(createGameId())).toBe(true);
    }
  });

  it('generates a different identifier every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(createGameId());
    expect(seen.size).toBe(200);
  });
});

describe('normalizeSprite', () => {
  it('passes through a recognised key', () => {
    expect(normalizeSprite('avatar-2', SPRITES)).toBe('avatar-2');
  });

  it('falls back rather than rejecting, so a lane mismatch is cosmetic', () => {
    expect(normalizeSprite('avatar-99', SPRITES, 'avatar-1')).toBe('avatar-1');
    expect(normalizeSprite(undefined, SPRITES, 'avatar-1')).toBe('avatar-1');
    expect(normalizeSprite(7, SPRITES, 'avatar-1')).toBe('avatar-1');
  });

  it('uses the first allowed key when the fallback is not allowed either', () => {
    expect(normalizeSprite('nope', SPRITES, 'also-nope')).toBe('avatar-1');
  });
});

describe('normalizeFacing', () => {
  it('passes through the four legal facings', () => {
    for (const facing of ['up', 'down', 'left', 'right'] as const) {
      expect(normalizeFacing(facing)).toBe(facing);
    }
  });

  it('substitutes the default for anything else', () => {
    expect(normalizeFacing('northwest')).toBe('down');
    expect(normalizeFacing(null)).toBe('down');
  });
});

describe('normalizeCoordinate', () => {
  it('rounds to whole pixels', () => {
    expect(normalizeCoordinate(10.4)).toBe(10);
    expect(normalizeCoordinate(-10.6)).toBe(-11);
  });

  it('clamps to the world limit', () => {
    expect(normalizeCoordinate(WORLD_LIMIT + 5000)).toBe(WORLD_LIMIT);
    expect(normalizeCoordinate(-WORLD_LIMIT - 5000)).toBe(-WORLD_LIMIT);
  });

  it('rejects rather than clamping what is not a finite number', () => {
    for (const candidate of [Number.NaN, Infinity, -Infinity, '10', null, undefined]) {
      expect(normalizeCoordinate(candidate)).toBeNull();
    }
  });
});

describe('interest', () => {
  it('measures a square box, not a circle', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 30, y: 40 })).toBe(40);
    expect(isWithinInterest({ x: 0, y: 0 }, { x: 40, y: 40 }, 40)).toBe(true);
    expect(isWithinInterest({ x: 0, y: 0 }, { x: 41, y: 0 }, 40)).toBe(false);
  });

  it('returns everything inside the radius, nearest first', () => {
    const observer = { position: { x: 0, y: 0 } };
    const near = { position: { x: 10, y: 0 } };
    const middle = { position: { x: 50, y: 0 } };
    const far = { position: { x: 500, y: 0 } };
    expect(selectVisible(observer, [far, middle, near], 100, 10)).toEqual([
      near,
      middle,
    ]);
  });

  it('caps a crowd, keeping the nearest', () => {
    const observer = { position: { x: 0, y: 0 } };
    const crowd = Array.from({ length: 40 }, (_unused, index) => ({
      position: { x: index + 1, y: 0 },
    }));
    const chosen = selectVisible(observer, crowd, 1000, 5);
    expect(chosen).toHaveLength(5);
    expect(chosen.map((item) => item.position.x)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('UpdateThrottle', () => {
  it('accepts the first update from a session', () => {
    expect(new UpdateThrottle(50).accept('a', 1000)).toBe(true);
  });

  it('drops updates inside the floor and accepts the next one after it', () => {
    const throttle = new UpdateThrottle(50);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.accept('a', 1020)).toBe(false);
    expect(throttle.accept('a', 1049)).toBe(false);
    expect(throttle.accept('a', 1050)).toBe(true);
  });

  it('keeps the floor monotonic through a rollback and repeated oscillation', () => {
    const throttle = new UpdateThrottle(50);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.accept('a', 900)).toBe(false);
    expect(throttle.accept('a', 1000)).toBe(false);
    expect(throttle.accept('a', 900)).toBe(false);
    expect(throttle.accept('a', 1000)).toBe(false);
    // The floor eventually progresses once the clock source itself does.
    expect(throttle.accept('a', 1050)).toBe(true);
  });

  it('fails closed for invalid samples without poisoning a session', () => {
    const throttle = new UpdateThrottle(50);
    for (const invalid of [Number.NaN, Infinity, -Infinity, -1]) {
      expect(throttle.accept('a', invalid)).toBe(false);
      expect(throttle.tracked).toBe(0);
    }

    // Zero is a valid monotonic-clock origin, not an invalid sentinel.
    expect(throttle.accept('a', 0)).toBe(true);
    for (const invalid of [Number.NaN, Infinity, -Infinity, -1]) {
      expect(throttle.accept('a', invalid)).toBe(false);
    }
    expect(throttle.accept('a', 49)).toBe(false);
    expect(throttle.accept('a', 50)).toBe(true);
  });

  it('stamps a valid forward floor but never moves it backward', () => {
    const throttle = new UpdateThrottle(50);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.stamp('a', 900)).toBe(true);
    expect(throttle.accept('a', 1049)).toBe(false);
    expect(throttle.accept('a', 1050)).toBe(true);

    expect(throttle.stamp('a', Number.NaN)).toBe(false);
    expect(throttle.accept('a', 1099)).toBe(false);
    expect(throttle.accept('a', 1100)).toBe(true);
  });

  it('with a burst, keeps a move that is early only because the last was late (D-086)', () => {
    const throttle = new UpdateThrottle(50, 3);
    // Sent every 50 ms; jitter delivers them at 0, 70, 95, 150, 190.
    for (const at of [1000, 1070, 1095, 1150, 1190]) {
      expect(throttle.accept('a', at)).toBe(true);
    }
  });

  it('with a burst, still holds the long-run rate to one per interval', () => {
    const throttle = new UpdateThrottle(50, 3);
    let accepted = 0;
    // A client that ignores the floor and sends every 10 ms for one second.
    for (let at = 1000; at < 2000; at += 10) {
      if (throttle.accept('a', at)) accepted += 1;
    }
    // One per 50 ms, plus the burst allowance of two.
    expect(accepted).toBeLessThanOrEqual(1000 / 50 + 2);
    expect(accepted).toBeGreaterThanOrEqual(1000 / 50);
  });

  it('with a burst, refuses the burst-plus-first arrival at once', () => {
    const throttle = new UpdateThrottle(50, 3);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.accept('a', 1000)).toBe(false);
    expect(throttle.accept('a', 1049)).toBe(false);
    expect(throttle.accept('a', 1050)).toBe(true);
  });

  it('a stamp drains the burst: the next update waits a full interval', () => {
    const throttle = new UpdateThrottle(50, 3);
    expect(throttle.stamp('a', 1000)).toBe(true);
    expect(throttle.accept('a', 1049)).toBe(false);
    expect(throttle.accept('a', 1050)).toBe(true);
  });

  it('treats a nonsense burst as a strict floor', () => {
    for (const burst of [0, -1, 1.5, Number.NaN, Infinity]) {
      const throttle = new UpdateThrottle(50, burst);
      expect(throttle.accept('a', 1000)).toBe(true);
      expect(throttle.accept('a', 1049)).toBe(false);
    }
  });

  it('throttles each session independently', () => {
    const throttle = new UpdateThrottle(50);
    expect(throttle.accept('a', 1000)).toBe(true);
    expect(throttle.accept('b', 1000)).toBe(true);
  });

  it('does not grow once a session is forgotten', () => {
    const throttle = new UpdateThrottle(50);
    throttle.accept('a', 1000);
    throttle.accept('b', 1000);
    expect(throttle.tracked).toBe(2);
    throttle.forget('a');
    throttle.forget('b');
    expect(throttle.tracked).toBe(0);
  });
});
