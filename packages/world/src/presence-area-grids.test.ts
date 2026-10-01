/**
 * D-087: the lobby holds shared-room players to the walkable grids in
 * `@strkworld/shared`. Those grids must be the World's own rooms, tile for
 * tile, or the lobby would refuse real moves (or accept impossible ones).
 */

import { describe, expect, it } from 'vitest';
import { ROOF_PRESENCE_GRID, STUDIO_PRESENCE_GRID, type PresenceAreaGrid } from '@strkworld/shared';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_TILE_SIZE,
  isAvatarStudioSolidAt,
} from './avatar-studio.js';
import {
  EXCHANGE_ROOF_LEVEL,
  FIXED_ROOM_LEVELS,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoomLevel,
  isFixedRoomSolidAt,
} from './fixed-room.js';
import { TILE_SIZE } from './map/street.js';
import { ROOM_ORIGIN } from './world-layout.js';

function walkable(grid: PresenceAreaGrid, x: number, y: number): boolean {
  return grid.walkable.some(
    (rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height,
  );
}

describe('shared presence-area grids match the World (D-087)', () => {
  it('the roof grid is the Exchange roof, laid over its street footprint', () => {
    const roof = createFixedRoomLevel(EXCHANGE_ROOF_LEVEL);
    expect(roof.rooftop).not.toBeNull();
    expect(ROOF_PRESENCE_GRID.originX).toBe(roof.rooftop!.x * TILE_SIZE);
    expect(ROOF_PRESENCE_GRID.originY).toBe(roof.rooftop!.y * TILE_SIZE);
    expect(ROOF_PRESENCE_GRID.tileSize).toBe(FIXED_ROOM_TILE_SIZE);
    for (let y = -1; y <= roof.height; y += 1) {
      for (let x = -1; x <= roof.width; x += 1) {
        expect(walkable(ROOF_PRESENCE_GRID, x, y), `roof tile ${x},${y}`).toBe(!isFixedRoomSolidAt(roof, x, y));
      }
    }
  });

  it('the Exchange roof is the only roof, so it is the only shared floor', () => {
    const roofs = Object.values(FIXED_ROOM_LEVELS).flatMap((levels) => (levels ?? []).filter((level) => level.rooftop));
    expect(roofs).toEqual([EXCHANGE_ROOF_LEVEL]);
  });

  it('the Studio grid is the Avatar Studio, at the interiors’ origin', () => {
    expect(STUDIO_PRESENCE_GRID.originX).toBe(ROOM_ORIGIN.x);
    expect(STUDIO_PRESENCE_GRID.originY).toBe(ROOM_ORIGIN.y);
    expect(STUDIO_PRESENCE_GRID.tileSize).toBe(AVATAR_STUDIO_TILE_SIZE);
    const { width, height } = AVATAR_STUDIO_DEFINITION;
    for (let y = -1; y <= height; y += 1) {
      for (let x = -1; x <= width; x += 1) {
        expect(walkable(STUDIO_PRESENCE_GRID, x, y), `studio tile ${x},${y}`).toBe(
          !isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, x, y),
        );
      }
    }
  });
});
