import { TILE_SIZE } from './map/street.js';
import { FIXED_ROOM_TILE_SIZE } from './fixed-room.js';

/**
 * Where the fixed rooms and the Avatar Studio sit in World pixel space.
 *
 * Interiors are data, not separate scenes (D-039): they are drawn at this
 * offset over the hidden street, and entering one swaps visibility, collision
 * and camera bounds. Keeping the offset here, outside any renderer, means the
 * gameplay session and the 3D presentation read one value.
 */
export const ROOM_ORIGIN = Object.freeze({ x: 2 * TILE_SIZE, y: 2 * TILE_SIZE });

/** Room-local tile under a World pixel position. */
export function worldToRoomTile(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.floor((x - ROOM_ORIGIN.x) / FIXED_ROOM_TILE_SIZE),
    y: Math.floor((y - ROOM_ORIGIN.y) / FIXED_ROOM_TILE_SIZE),
  };
}
