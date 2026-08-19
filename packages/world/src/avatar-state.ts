import type { AvatarSpriteKey } from '@strkworld/shared';

/** The complete D-047 wire vocabulary, kept local to the World registry. */
export const AVATAR_SPRITE_KEYS: readonly AvatarSpriteKey[] = [
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
] as const;

export const DEFAULT_AVATAR_SPRITE: AvatarSpriteKey = 'avatar-1';

const AVATAR_SPRITE_SET = new Set<string>(AVATAR_SPRITE_KEYS);

export function isAvatarSpriteKey(value: unknown): value is AvatarSpriteKey {
  return typeof value === 'string' && AVATAR_SPRITE_SET.has(value);
}

export function validateAvatarSprite(value: unknown): AvatarSpriteKey {
  return isAvatarSpriteKey(value) ? value : DEFAULT_AVATAR_SPRITE;
}

/** Return the cosy state represented by a 1-based figure number. */
export function avatarSpriteForFigure(figure: number): AvatarSpriteKey {
  if (!Number.isInteger(figure) || figure < 1 || figure > 8) {
    throw new Error('Avatar Studio figure must be an integer from 1 to 8');
  }
  return `avatar-${figure}` as AvatarSpriteKey;
}

/** Pair cosy 1..8 with fighting 9..16, with no stance on the wire. */
export function pairedAvatarSprite(value: AvatarSpriteKey): AvatarSpriteKey {
  const number = Number(value.slice('avatar-'.length));
  if (!Number.isInteger(number) || number < 1 || number > 16) {
    return DEFAULT_AVATAR_SPRITE;
  }
  return `avatar-${number <= 8 ? number + 8 : number - 8}` as AvatarSpriteKey;
}

/** Stable procedural palette shared by local and remote placeholder avatars. */
export function avatarPlaceholderTint(sprite: AvatarSpriteKey): number {
  const number = Number(sprite.slice('avatar-'.length));
  const palette = [
    0xf2e8c9,
    0xc7e8f2,
    0xf2c7d5,
    0xd9f2c7,
    0xf2e0c7,
    0xd3c7f2,
    0xf2f0c7,
    0xc7f2df,
  ];
  return palette[(number - 1) % palette.length] ?? palette[0]!;
}
