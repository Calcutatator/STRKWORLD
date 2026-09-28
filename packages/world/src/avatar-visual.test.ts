import { describe, expect, it } from 'vitest';
import {
  AVATAR_BODY_SIZE,
  AVATAR_ONE_WALK_COLUMNS,
  AVATAR_VISUAL_CATALOG,
  AVATAR_WALK_COLUMNS,
  resolveAvatarSheet,
} from './avatar-visual.js';

describe('D-052 avatar visual catalog', () => {
  it('maps every opaque key to one fixed final sheet contract', () => {
    expect(AVATAR_VISUAL_CATALOG.map((sheet) => ({
      sprite: sheet.sprite,
      file: new URL(sheet.url).pathname.split('/').at(-1),
      sheet: [sheet.width, sheet.height],
      cell: [sheet.frameWidth, sheet.frameHeight],
      columns: sheet.columns,
      walkColumns: sheet.walkColumns,
      origin: [sheet.originX, sheet.originY],
    }))).toEqual(Array.from({ length: 16 }, (_, index) => {
      const avatarOne = index === 0;
      return {
        sprite: `avatar-${index + 1}`,
        file: `avatar-${index + 1}.png`,
        sheet: [avatarOne ? 384 : 320, 256],
        cell: [64, 64],
        columns: avatarOne ? 6 : 5,
        walkColumns: avatarOne ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4],
        origin: [0.5, 0.875],
      };
    }));
  });

  it('resolves an unknown runtime key to the safe avatar-1 sheet', () => {
    expect(resolveAvatarSheet('avatar-16').sprite).toBe('avatar-16');
    expect(resolveAvatarSheet('review-sheet').sprite).toBe('avatar-1');
    expect(resolveAvatarSheet(undefined).sprite).toBe('avatar-1');
  });

  it('freezes public per-sheet playback columns against runtime contract mutation', () => {
    const avatarOne = AVATAR_VISUAL_CATALOG[0]!;
    const avatarTwo = AVATAR_VISUAL_CATALOG[1]!;

    expect(Object.isFrozen(AVATAR_ONE_WALK_COLUMNS)).toBe(true);
    expect(Object.isFrozen(AVATAR_WALK_COLUMNS)).toBe(true);
    expect(Object.isFrozen(avatarOne.walkColumns)).toBe(true);
    expect(Object.isFrozen(avatarTwo.walkColumns)).toBe(true);
    expect(() => {
      (avatarOne.walkColumns as number[])[0] = 5;
    }).toThrow(TypeError);
  });

  it('keeps the gameplay collision body at the prior 24px footprint', () => {
    expect(AVATAR_BODY_SIZE).toBe(24);
  });
});
