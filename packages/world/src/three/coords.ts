import type { Facing } from '@strkworld/shared';
import { TILE_SIZE } from '../map/street.js';

/**
 * The one mapping between World gameplay space and the 3D scene (D-059).
 *
 * Gameplay stays tile-authored in 2D pixel space — x east, y south — which is
 * what the lobby, door triggers, room controllers and the Studio already use.
 * The renderer draws that plane in 3D: one 32 px tile is one world unit, +X is
 * east, +Z is south and +Y is up. Nothing outside the renderer ever sees a 3D
 * coordinate, so no seam changes shape.
 */
export const PIXELS_PER_UNIT = TILE_SIZE;

export interface GroundPoint {
  readonly x: number;
  readonly z: number;
}

/** A World pixel position as a ground-plane point in world units. */
export function pixelToGround(x: number, y: number): GroundPoint {
  return { x: x / PIXELS_PER_UNIT, z: y / PIXELS_PER_UNIT };
}

/** The centre of a tile, optionally offset by a pixel origin (rooms, Studio). */
export function tileCenterToGround(
  tileX: number,
  tileY: number,
  originPx: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): GroundPoint {
  return {
    x: originPx.x / PIXELS_PER_UNIT + tileX + 0.5,
    z: originPx.y / PIXELS_PER_UNIT + tileY + 0.5,
  };
}

/**
 * Presentation yaw for a wire facing.
 *
 * Yaw 0 faces +Z (south, towards a north-up camera: the 2D 'down' facing).
 * Positive yaw turns counter-clockwise seen from above, matching
 * `Object3D.rotation.y`, so a figure's front is `(sin yaw, cos yaw)` in (x, z).
 */
export function facingToYaw(facing: Facing): number {
  switch (facing) {
    case 'right':
      return Math.PI / 2;
    case 'up':
      return Math.PI;
    case 'left':
      return -Math.PI / 2;
    case 'down':
    default:
      return 0;
  }
}

/** Yaw that faces along a pixel-space direction. Returns null for no motion. */
export function directionToYaw(dx: number, dy: number): number | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  return Math.atan2(dx, dy);
}

/** Shortest signed angle from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}
