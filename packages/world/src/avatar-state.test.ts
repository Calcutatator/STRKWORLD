import { describe, expect, it } from 'vitest';
import {
  AVATAR_SPRITE_KEYS,
  DEFAULT_AVATAR_SPRITE,
  avatarSpriteForFigure,
  isAvatarSpriteKey,
  pairedAvatarSprite,
  validateAvatarSprite,
} from './avatar-state.js';

describe('Avatar Studio cosmetic state registry', () => {
  it('contains sixteen opaque states with cosy figures and fighting pairs', () => {
    expect(AVATAR_SPRITE_KEYS).toHaveLength(16);
    expect(AVATAR_SPRITE_KEYS[0]).toBe('avatar-1');
    expect(AVATAR_SPRITE_KEYS[15]).toBe('avatar-16');
    for (let figure = 1; figure <= 8; figure += 1) {
      const cosy = avatarSpriteForFigure(figure);
      expect(cosy).toBe(`avatar-${figure}`);
      expect(pairedAvatarSprite(cosy)).toBe(`avatar-${figure + 8}`);
      expect(pairedAvatarSprite(`avatar-${figure + 8}` as never)).toBe(cosy);
    }
  });

  it('uses avatar-1 as the default and fail-closed fallback', () => {
    expect(DEFAULT_AVATAR_SPRITE).toBe('avatar-1');
    expect(validateAvatarSprite('avatar-12')).toBe('avatar-12');
    expect(validateAvatarSprite('avatar-99')).toBe(DEFAULT_AVATAR_SPRITE);
    expect(validateAvatarSprite(undefined)).toBe(DEFAULT_AVATAR_SPRITE);
    expect(isAvatarSpriteKey('avatar-16')).toBe(true);
    expect(isAvatarSpriteKey('avatar-0')).toBe(false);
  });
});
