import { describe, expect, it } from 'vitest';
import type { AvatarSpriteKey } from '@strkworld/shared';
import {
  AVATAR_SPRITE_KEYS,
  DEFAULT_AVATAR_SPRITE,
  pairedAvatarSprite,
} from '../avatar-state.js';
import { AVATAR_LOOKS, avatarLook } from './avatar-looks.js';

const COSY_KEYS = AVATAR_SPRITE_KEYS.slice(0, 8);

/** Every number in the look data except character ids is a colour. */
function colourEntries(value: unknown, path: string): Array<readonly [string, number]> {
  if (typeof value === 'number') return [[path, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'id' ? [] : colourEntries(child, `${path}.${key}`),
  );
}

describe('avatar looks', () => {
  it('defines exactly one look per opaque wire key', () => {
    expect(Object.keys(AVATAR_LOOKS).sort()).toEqual([...AVATAR_SPRITE_KEYS].sort());
    for (const key of AVATAR_SPRITE_KEYS) {
      expect(AVATAR_LOOKS[key].key).toBe(key);
    }
  });

  it('marks 1-8 cosy and 9-16 fighting, and only fighting looks carry a weapon', () => {
    AVATAR_SPRITE_KEYS.forEach((key, index) => {
      const look = AVATAR_LOOKS[key];
      const fighting = index >= 8;
      expect(look.stance).toBe(fighting ? 'fighting' : 'cosy');
      expect(look.outfit.weapon !== null).toBe(fighting);
    });
  });

  it('pairs each cosy and fighting state on one shared character', () => {
    for (const key of AVATAR_SPRITE_KEYS) {
      const look = AVATAR_LOOKS[key];
      const pair = AVATAR_LOOKS[pairedAvatarSprite(key)];
      expect(pair.character).toBe(look.character);
      expect(pair.character.skin).toBe(look.character.skin);
      expect(pair.character.hair).toEqual(look.character.hair);
      expect(pair.outfit).not.toEqual(look.outfit);
    }
  });

  it('changes clothes in every fighting look, not only adding a weapon (D-096)', () => {
    for (const key of COSY_KEYS) {
      const cosy = AVATAR_LOOKS[key].outfit;
      const fighting = AVATAR_LOOKS[pairedAvatarSprite(key)].outfit;
      const garments = (['top', 'sleeves', 'gloves', 'trousers', 'boots'] as const).filter(
        (garment) => cosy[garment] !== fighting[garment],
      );
      expect(garments.length, key).toBeGreaterThanOrEqual(3);
      expect(fighting.gear, key).not.toEqual(cosy.gear);
    }
  });

  it('gives the eight fighting looks distinct archetypes: gear and weapon never repeat', () => {
    const archetypes = COSY_KEYS.map((key) => {
      const { gear, weapon } = AVATAR_LOOKS[pairedAvatarSprite(key)].outfit;
      return JSON.stringify([gear.map((item) => item.kind).sort(), weapon?.kind]);
    });
    expect(new Set(archetypes).size).toBe(8);
  });

  it('gives the eight characters distinct skin, hair colour and hair style', () => {
    const characters = COSY_KEYS.map((key) => AVATAR_LOOKS[key].character);
    expect(characters.map((character) => character.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(characters.map((character) => character.skin)).size).toBe(8);
    expect(new Set(characters.map((character) => character.hair.color)).size).toBe(8);
    expect(new Set(characters.map((character) => character.hair.style)).size).toBe(8);
  });

  it('makes all sixteen looks distinct', () => {
    const fingerprints = AVATAR_SPRITE_KEYS.map((key) =>
      JSON.stringify({ character: AVATAR_LOOKS[key].character, outfit: AVATAR_LOOKS[key].outfit }),
    );
    expect(new Set(fingerprints).size).toBe(16);
  });

  it('keeps the approved size classes: only 6/14 small, only 4/7/12/15 large', () => {
    const small: readonly AvatarSpriteKey[] = ['avatar-6', 'avatar-14'];
    const large: readonly AvatarSpriteKey[] = ['avatar-4', 'avatar-7', 'avatar-12', 'avatar-15'];
    for (const key of AVATAR_SPRITE_KEYS) {
      const expected = small.includes(key) ? 'small' : large.includes(key) ? 'large' : 'standard';
      expect(AVATAR_LOOKS[key].character.build, key).toBe(expected);
    }
  });

  it('stores every colour as a 24-bit integer', () => {
    const entries = colourEntries(AVATAR_LOOKS, 'looks');
    expect(entries.length).toBeGreaterThan(16 * 6);
    for (const [path, colour] of entries) {
      expect(Number.isInteger(colour), path).toBe(true);
      expect(colour, path).toBeGreaterThanOrEqual(0);
      expect(colour, path).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('falls back to the default look for untrusted input, like validateAvatarSprite', () => {
    const fallback = AVATAR_LOOKS[DEFAULT_AVATAR_SPRITE];
    for (const input of [undefined, null, 7, '', 'avatar-0', 'avatar-17', 'AVATAR-2', {}, ['avatar-2']]) {
      expect(avatarLook(input)).toBe(fallback);
    }
    expect(avatarLook('avatar-12')).toBe(AVATAR_LOOKS['avatar-12']);
  });

  it('is deeply frozen, because every figure shares it', () => {
    const look = AVATAR_LOOKS['avatar-9'];
    expect(Object.isFrozen(AVATAR_LOOKS)).toBe(true);
    expect(Object.isFrozen(look)).toBe(true);
    expect(Object.isFrozen(look.character.hair)).toBe(true);
    expect(Object.isFrozen(look.outfit.gear)).toBe(true);
    expect(Object.isFrozen(look.outfit.weapon)).toBe(true);
  });
});
