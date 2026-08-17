import { describe, expect, it } from 'vitest';
import { GAME_ID_PATTERN, WORLD_LIMIT } from './config';
import {
  UpdateThrottle,
  createGameId,
  distanceBetween,
  isWithinInterest,
  normalizeCoordinate,
  normalizeFacing,
  normalizeGameId,
  normalizeSprite,
  selectVisible,
} from './policy';

const SPRITES = ['avatar-1', 'avatar-2'];

describe('normalizeGameId', () => {
  it('accepts exactly 16 lowercase hex characters', () => {
    expect(normalizeGameId('0123456789abcdef')).toBe('0123456789abcdef');
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
