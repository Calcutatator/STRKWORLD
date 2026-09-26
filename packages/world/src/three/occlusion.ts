import type { Occluder } from './types.js';

/** Does the segment from `from` to `to` pass through the occluder's box? */
export function segmentHitsBox(
  from: { readonly x: number; readonly y: number; readonly z: number },
  to: { readonly x: number; readonly y: number; readonly z: number },
  occluder: Pick<Occluder, 'bounds'>,
): boolean {
  const { bounds } = occluder;
  const min = [bounds.minX, 0, bounds.minZ] as const;
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
