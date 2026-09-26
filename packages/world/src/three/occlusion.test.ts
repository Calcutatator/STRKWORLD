import { describe, expect, it } from 'vitest';
import { segmentHitsBox } from './occlusion.js';

const building = {
  bounds: { minX: 3, maxX: 10, minZ: 5, maxZ: 11, height: 4.5 },
};

describe('camera line-of-sight occlusion', () => {
  it('reports a building standing between the camera and the player', () => {
    // Player north of the building, camera south of it looking over the roof line.
    expect(segmentHitsBox({ x: 6, y: 8, z: 18 }, { x: 6, y: 1.25, z: 3 }, building)).toBe(true);
  });

  it('ignores a building beside the line of sight', () => {
    expect(segmentHitsBox({ x: 20, y: 8, z: 18 }, { x: 20, y: 1.25, z: 12 }, building)).toBe(false);
  });

  it('ignores a building the line passes over', () => {
    expect(segmentHitsBox({ x: 6, y: 30, z: 18 }, { x: 6, y: 20, z: 3 }, building)).toBe(false);
  });

  it('does not fade a building in front of which the player stands', () => {
    // Player on the pavement south of the facade; the camera is further south.
    expect(segmentHitsBox({ x: 6, y: 8, z: 22 }, { x: 6, y: 1.25, z: 12 }, building)).toBe(false);
  });

  it('handles an axis-parallel segment', () => {
    expect(segmentHitsBox({ x: 6, y: 2, z: 20 }, { x: 6, y: 2, z: 0 }, building)).toBe(true);
    expect(segmentHitsBox({ x: 1, y: 2, z: 20 }, { x: 1, y: 2, z: 0 }, building)).toBe(false);
  });
});
