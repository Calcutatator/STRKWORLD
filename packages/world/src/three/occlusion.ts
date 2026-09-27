import type { Occluder, OccluderBounds } from './types.js';

type Point = { readonly x: number; readonly y: number; readonly z: number };

/**
 * Does the segment from `from` to `to` pass through the occluder? Through
 * any of its `boxes` when it lists them, else through its `bounds`. A box
 * stands on the ground unless it gives a floor (`minY`).
 */
export function segmentHitsBox(from: Point, to: Point, occluder: Pick<Occluder, 'bounds' | 'boxes'>): boolean {
  const boxes = occluder.boxes ?? [occluder.bounds];
  for (const box of boxes) if (segmentHitsBounds(from, to, box)) return true;
  return false;
}

function segmentHitsBounds(from: Point, to: Point, bounds: OccluderBounds): boolean {
  const min = [bounds.minX, bounds.minY ?? 0, bounds.minZ] as const;
  const max = [bounds.maxX, bounds.height, bounds.maxZ] as const;
  const start = [from.x, from.y, from.z] as const;
  const end = [to.x, to.y, to.z] as const;
  let enter = 0;
  let exit = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const origin = start[axis]!;
    const delta = end[axis]! - origin;
    if (Math.abs(delta) < 1e-9) {
      if (origin < min[axis]! || origin > max[axis]!) return false;
      continue;
    }
    let near = (min[axis]! - origin) / delta;
    let far = (max[axis]! - origin) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    exit = Math.min(exit, far);
    if (enter > exit) return false;
  }
  return true;
}
