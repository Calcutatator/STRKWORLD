import type { AvatarSpriteKey } from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS, validateAvatarSprite } from './avatar-state.js';

/**
 * The approved 2D avatar sheets (D-049/D-052) as data.
 *
 * The World no longer renders these (D-059): in-World avatars are procedural
 * 3D figures coloured from them. The catalog stays because the Shell's wallet
 * attention cue draws Avatar 1's idle frame from it (D-058), and because
 * `AVATAR_BODY_SIZE` is still the gameplay collision body.
 */

export const AVATAR_SHEET_WIDTH = 320;
export const AVATAR_SHEET_HEIGHT = 256;
export const AVATAR_CELL_SIZE = 64;
export const AVATAR_CELL_COLUMNS = 5;
export const AVATAR_CELL_ROWS = 4;
export const AVATAR_FEET_X = 32;
export const AVATAR_FEET_Y = 56;
export const AVATAR_BODY_SIZE = 24;
export const AVATAR_ORIGIN_X = AVATAR_FEET_X / AVATAR_CELL_SIZE;
export const AVATAR_ORIGIN_Y = AVATAR_FEET_Y / AVATAR_CELL_SIZE;
export const AVATAR_WALK_COLUMNS = Object.freeze([0, 1, 2, 3, 4] as const);
export const AVATAR_ONE_SHEET_WIDTH = 384;
export const AVATAR_ONE_CELL_COLUMNS = 6;
export const AVATAR_ONE_WALK_COLUMNS = Object.freeze([0, 1, 2, 3, 4, 5] as const);
export const AVATAR_NORMAL_WALK_FPS = 8;
export const AVATAR_SPRINT_WALK_FPS = 12;

interface AvatarSheetGeometry {
  readonly width: number;
  readonly columns: number;
  readonly walkColumns: readonly number[];
}

const DEFAULT_AVATAR_SHEET_GEOMETRY: AvatarSheetGeometry = Object.freeze({
  width: AVATAR_SHEET_WIDTH,
  columns: AVATAR_CELL_COLUMNS,
  walkColumns: AVATAR_WALK_COLUMNS,
});

const AVATAR_ONE_SHEET_GEOMETRY: AvatarSheetGeometry = Object.freeze({
  width: AVATAR_ONE_SHEET_WIDTH,
  columns: AVATAR_ONE_CELL_COLUMNS,
  walkColumns: AVATAR_ONE_WALK_COLUMNS,
});

export const AVATAR_SPRITE_ASSET_URLS: Readonly<Record<AvatarSpriteKey, string>> =
  Object.fromEntries(
    AVATAR_SPRITE_KEYS.map((key) => [
      key,
      new URL(`../assets/player-sprites/v1/${key}.png`, import.meta.url).href,
    ]),
  ) as Record<AvatarSpriteKey, string>;

export interface AvatarVisualSheet {
  readonly sprite: AvatarSpriteKey;
  readonly textureKey: AvatarSpriteKey;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly walkColumns: readonly number[];
  readonly originX: number;
  readonly originY: number;
}

export const AVATAR_VISUAL_CATALOG: readonly AvatarVisualSheet[] = Object.freeze(
  AVATAR_SPRITE_KEYS.map((sprite) => {
    const geometry = sprite === 'avatar-1'
      ? AVATAR_ONE_SHEET_GEOMETRY
      : DEFAULT_AVATAR_SHEET_GEOMETRY;
    return Object.freeze({
      sprite,
      textureKey: sprite,
      url: AVATAR_SPRITE_ASSET_URLS[sprite],
      width: geometry.width,
      height: AVATAR_SHEET_HEIGHT,
      frameWidth: AVATAR_CELL_SIZE,
      frameHeight: AVATAR_CELL_SIZE,
      columns: geometry.columns,
      walkColumns: geometry.walkColumns,
      originX: AVATAR_ORIGIN_X,
      originY: AVATAR_ORIGIN_Y,
    });
  }),
);

export function resolveAvatarSheet(sprite: unknown): AvatarVisualSheet {
  const key = validateAvatarSprite(sprite);
  return AVATAR_VISUAL_CATALOG[AVATAR_SPRITE_KEYS.indexOf(key)]!;
}
