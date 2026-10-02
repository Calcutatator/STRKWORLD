/**
 * D-087: the lobby holds shared-room players to the walkable grids in
 * `@strkworld/shared`. Those grids must be the World's own rooms, tile for
 * tile, or the lobby would refuse real moves (or accept impossible ones).
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_PRESENCE_GRID,
  ARENA_RING_INTERIOR,
  BUNKER_PRESENCE_GRID,
  ROOF_PRESENCE_GRID,
  STUDIO_PRESENCE_GRID,
  presenceAreaOfBuilding,
  type PresenceAreaGrid,
} from '@strkworld/shared';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_TILE_SIZE,
  isAvatarStudioSolidAt,
} from './avatar-studio.js';
import {
  ARENA_ROOM_DEFINITION,
  BUNKER_ROOM_DEFINITION,
  EXCHANGE_ROOF_LEVEL,
  FIXED_ROOM_LEVELS,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  isFixedRoomSolidAt,
} from './fixed-room.js';
import { TILE_SIZE, createStreetMap, isSolidAt } from './map/street.js';
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
    // The whole grid is the tower's footprint: the lobby sends roof players
    // no street peer over it, and the presenter stands any peer over it on the deck.
    expect([ROOF_PRESENCE_GRID.width, ROOF_PRESENCE_GRID.height]).toEqual([roof.width, roof.height]);
    for (let y = -1; y <= roof.height; y += 1) {
      for (let x = -1; x <= roof.width; x += 1) {
        expect(walkable(ROOF_PRESENCE_GRID, x, y), `roof tile ${x},${y}`).toBe(!isFixedRoomSolidAt(roof, x, y));
      }
    }
  });

  it('no street player can stand over the tower’s footprint except on its door, which takes them inside', () => {
    const street = createStreetMap();
    const door = street.doors.find((candidate) => candidate.building === 'exchange')!;
    const originX = ROOF_PRESENCE_GRID.originX / TILE_SIZE;
    const originY = ROOF_PRESENCE_GRID.originY / TILE_SIZE;
    for (let y = originY; y < originY + ROOF_PRESENCE_GRID.height; y += 1) {
      for (let x = originX; x < originX + ROOF_PRESENCE_GRID.width; x += 1) {
        const onDoor = x >= door.x && x < door.x + door.width && y >= door.y && y < door.y + door.height;
        expect(isSolidAt(street, x, y) || onDoor, `street tile ${x},${y}`).toBe(true);
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
    expect([STUDIO_PRESENCE_GRID.width, STUDIO_PRESENCE_GRID.height]).toEqual([width, height]);
    for (let y = -1; y <= height; y += 1) {
      for (let x = -1; x <= width; x += 1) {
        expect(walkable(STUDIO_PRESENCE_GRID, x, y), `studio tile ${x},${y}`).toBe(
          !isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, x, y),
        );
      }
    }
  });

  it('the bunker grid is the hidden room (D-112), at the interiors’ origin, tile for tile', () => {
    const room = createFixedRoom(BUNKER_ROOM_DEFINITION);
    expect(BUNKER_PRESENCE_GRID.originX).toBe(ROOM_ORIGIN.x);
    expect(BUNKER_PRESENCE_GRID.originY).toBe(ROOM_ORIGIN.y);
    expect(BUNKER_PRESENCE_GRID.tileSize).toBe(FIXED_ROOM_TILE_SIZE);
    expect([BUNKER_PRESENCE_GRID.width, BUNKER_PRESENCE_GRID.height]).toEqual([room.width, room.height]);
    for (let y = -1; y <= room.height; y += 1) {
      for (let x = -1; x <= room.width; x += 1) {
        expect(walkable(BUNKER_PRESENCE_GRID, x, y), `bunker tile ${x},${y}`).toBe(!isFixedRoomSolidAt(room, x, y));
      }
    }
    // The out-of-order lift's doors stay solid: nobody stands in them.
    const lift = BUNKER_ROOM_DEFINITION.stations[0];
    for (let x = lift.x; x < lift.x + lift.width; x += 1) expect(walkable(BUNKER_PRESENCE_GRID, x, lift.y)).toBe(false);
    // No two walkable rectangles overlap, so the list reads as the floor plan.
    const seen = new Set<string>();
    for (const rect of BUNKER_PRESENCE_GRID.walkable) {
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
          expect(seen.has(`${x},${y}`), `overlap at ${x},${y}`).toBe(false);
          seen.add(`${x},${y}`);
        }
      }
    }
  });

  it('the arena grid is the gladiator pit\'s arena (D-114), at the interiors\' origin, tile for tile', () => {
    const room = createFixedRoom(ARENA_ROOM_DEFINITION);
    expect(ARENA_PRESENCE_GRID.originX).toBe(ROOM_ORIGIN.x);
    expect(ARENA_PRESENCE_GRID.originY).toBe(ROOM_ORIGIN.y);
    expect(ARENA_PRESENCE_GRID.tileSize).toBe(FIXED_ROOM_TILE_SIZE);
    expect([ARENA_PRESENCE_GRID.width, ARENA_PRESENCE_GRID.height]).toEqual([room.width, room.height]);
    for (let y = -1; y <= room.height; y += 1) {
      for (let x = -1; x <= room.width; x += 1) {
        expect(walkable(ARENA_PRESENCE_GRID, x, y), `arena tile ${x},${y}`).toBe(!isFixedRoomSolidAt(room, x, y));
      }
    }
    // The ring's interior is solid for everyone in both: only the fighter's
    // own session opens it (the World's ring hook, the lobby's extra rects).
    for (let y = ARENA_RING_INTERIOR.y; y < ARENA_RING_INTERIOR.y + ARENA_RING_INTERIOR.height; y += 1) {
      for (let x = ARENA_RING_INTERIOR.x; x < ARENA_RING_INTERIOR.x + ARENA_RING_INTERIOR.width; x += 1) {
        expect(walkable(ARENA_PRESENCE_GRID, x, y)).toBe(false);
        expect(isFixedRoomSolidAt(room, x, y)).toBe(true);
      }
    }
    // The emperor's box is the reserved station: solid in both.
    const box = ARENA_ROOM_DEFINITION.stations[0];
    expect(walkable(ARENA_PRESENCE_GRID, box.x, box.y)).toBe(false);
  });

  it('the bunker and the arena are the only buildings whose interiors are shared; every other ground floor stays private', () => {
    for (const definition of fixedRoomDefinitionsFor({ vaultOpen: true })) {
      const shared = definition.building === 'bunker' || definition.building === 'arena';
      expect(presenceAreaOfBuilding(definition.building), definition.building).toBe(shared ? definition.building : null);
    }
  });
});
