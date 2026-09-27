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

  describe('with several boxes, like the sandbox gate', () => {
    // Two pillar tops over the wall and a lintel over the gap between them.
    const bounds = { minX: 53, maxX: 54, minZ: 10, maxZ: 20, minY: 2, height: 5.24 };
    const gate = {
      bounds,
      boxes: [
        { ...bounds, maxZ: 11, height: 4 },
        { ...bounds, minZ: 19, height: 4 },
        { ...bounds, minY: 4 },
      ],
    };

    it('is blocked when the line hits any box', () => {
      // Rising south through the south pillar's top.
      expect(segmentHitsBox({ x: 53.5, y: 1.2, z: 18.5 }, { x: 53.5, y: 3.2, z: 21 }, gate)).toBe(true);
      // Rising north through the lintel.
      expect(segmentHitsBox({ x: 53.5, y: 1.2, z: 15 }, { x: 53.5, y: 9, z: 25 }, gate)).toBe(true);
    });

    it('is clear through the empty gap that one box would cover', () => {
      // From the street, east through the opening at head height, to the apron.
      const from = { x: 45, y: 7.5, z: 15.5 };
      const to = { x: 55.5, y: 1.25, z: 15.5 };
      expect(segmentHitsBox(from, to, gate)).toBe(false);
      expect(segmentHitsBox(from, to, { bounds })).toBe(true);
    });
  });

  describe('with a floor, like the sandbox gate over its opening', () => {
    // The lintel and pillar tops: a box from y = 2 up, over a one-tile column.
    const gate = { bounds: { minX: 53, maxX: 54, minZ: 10, maxZ: 20, minY: 2, height: 5.24 } };
    const player = { x: 53.5, y: 1.25, z: 15.5 };

    it('is blocked when the sight line rises through the superstructure', () => {
      // Default camera: south of the player, looking north along the lintel.
      expect(segmentHitsBox({ x: 53.5, y: 9.3, z: 25.4 }, player, gate)).toBe(true);
    });

    it('is clear when the sight line leaves under the floor, through the opening', () => {
      // Camera orbited east: the line leaves the column at about y = 1.7.
      expect(segmentHitsBox({ x: 63.4, y: 9.3, z: 15.5 }, player, gate)).toBe(false);
      // The same line with the box standing on the ground, as before the floor.
      const grounded = { bounds: { ...gate.bounds, minY: undefined } };
      expect(segmentHitsBox({ x: 63.4, y: 9.3, z: 15.5 }, player, grounded)).toBe(true);
    });

    it('treats a missing floor as the ground, as buildings always have', () => {
      // Below 2, inside the footprint: only a grounded box stops it.
      const low = [{ x: 3.5, y: 1, z: 18 }, { x: 3.5, y: 1, z: 3 }] as const;
      expect(segmentHitsBox(low[0], low[1], building)).toBe(true);
      expect(segmentHitsBox(low[0], low[1], { bounds: { ...building.bounds, minY: 2 } })).toBe(false);
      expect(segmentHitsBox(low[0], low[1], { bounds: { ...building.bounds, minY: 0 } })).toBe(true);
    });
  });
});
