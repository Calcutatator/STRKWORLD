/**
 * D-132: the A-frame and its seat, as geometry. The steel merges into the
 * building's own bins (so it costs no draw call of its own); only the seat
 * is a separate object, because it has to move. What is pinned here is that
 * it hangs south of the deck out over the edge, that it swings like a
 * pendulum about one fixed pivot, and that it disposes cleanly.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, type Object3D } from 'three';
import { SWING_FRAME_TILES, SWING_SEAT_TILE } from '@strkworld/shared';
import { GeometryBin, ResourceBag } from './palette.js';
import {
  SWING_HANG,
  SWING_PIVOT_HEIGHT,
  SWING_PIVOT_REACH,
  SWING_RED,
  SWING_STEEL,
  buildRoofSwing,
  type RoofSwingView,
} from './roof-swing.js';

/** The roof grid's origin in world units, and the deck's heights. */
const ORIGIN = { originX: 10, originZ: 20, deckY: 40, ledgeY: 40.3 };

function build(): { swing: RoofSwingView; bin: GeometryBin; res: ResourceBag } {
  const bin = new GeometryBin();
  const res = new ResourceBag();
  const swing = buildRoofSwing(bin, res, ORIGIN);
  return { swing, bin, res };
}

/** Every mesh under an object, the object itself included. */
function meshes(object: Object3D): Mesh[] {
  const out: Mesh[] = [];
  object.traverse((child) => {
    if ((child as Mesh).isMesh) out.push(child as Mesh);
  });
  return out;
}

const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('the lookout swing\'s A-frame (D-132)', () => {
  it('hangs its pivot south of the deck\'s south edge, out over the void', () => {
    const { swing } = build();
    const southEdge = ORIGIN.originZ + SWING_SEAT_TILE.y;
    // +z is south, so a pivot past the edge is cantilevered over it.
    expect(swing.pivot.z).toBeCloseTo(southEdge + SWING_PIVOT_REACH, 6);
    expect(swing.pivot.z).toBeGreaterThan(southEdge);
    expect(swing.pivot.y).toBeCloseTo(ORIGIN.deckY + SWING_PIVOT_HEIGHT, 6);
  });

  it('centres on the frame\'s footprint, as the shared seam gives it', () => {
    const { swing } = build();
    expect(swing.pivot.x).toBeCloseTo(
      ORIGIN.originX + SWING_FRAME_TILES.x + SWING_FRAME_TILES.width / 2,
      6,
    );
  });

  it('merges its steel into the building\'s own body bin, so the frame costs no draw call', () => {
    const { swing, bin } = build();
    // The A-frame went into the key the tower's walls already use...
    expect(bin.take('body')).not.toBeNull();
    // ...and the swinging seat is the one object of its own, because it moves.
    expect(meshes(swing.object)).toHaveLength(1);
  });

  it('paints black steel and a signal-red seat, as the reference does', () => {
    expect(SWING_STEEL).toBe(0x16181c);
    expect(SWING_RED).toBe(0xcf2230);
  });
});

describe('the pendulum, as geometry (D-132)', () => {
  it('hangs the rider straight below the pivot at rest', () => {
    const { swing } = build();
    const rest = swing.riderAt(0);
    expect(rest.x).toBeCloseTo(swing.pivot.x, 6);
    expect(rest.z).toBeCloseTo(swing.pivot.z, 6);
    expect(rest.y).toBeLessThan(swing.pivot.y);
  });

  it('swings the rider south, out over the edge, on a positive angle', () => {
    const { swing } = build();
    const out = swing.riderAt(0.9);
    expect(out.z).toBeGreaterThan(swing.pivot.z);
    // And back over the deck on a negative one.
    expect(swing.riderAt(-0.9).z).toBeLessThan(swing.pivot.z);
  });

  it('rises as it swings either way, as a pendulum does', () => {
    const { swing } = build();
    const rest = swing.riderAt(0).y;
    expect(swing.riderAt(0.9).y).toBeGreaterThan(rest);
    expect(swing.riderAt(-0.9).y).toBeGreaterThan(rest);
  });

  it('keeps the rider a fixed distance from the pivot: one arc, not a stretch', () => {
    const { swing } = build();
    const radius = distance(swing.pivot, swing.riderAt(0));
    for (const angle of [-0.95, -0.4, 0, 0.4, 0.95]) {
      expect(distance(swing.pivot, swing.riderAt(angle))).toBeCloseTo(radius, 6);
    }
  });

  it('never moves the rider sideways: the swing is in one plane', () => {
    const { swing } = build();
    for (const angle of [-0.95, 0.5, 0.95]) {
      expect(swing.riderAt(angle).x).toBeCloseTo(swing.pivot.x, 6);
    }
  });

  it('turns the seat about the pivot when the angle is set', () => {
    const { swing } = build();
    swing.setAngle(0);
    const rest = swing.object.rotation.x;
    swing.setAngle(0.8);
    expect(swing.object.rotation.x).not.toBeCloseTo(rest, 3);
    // The same angle always gives the same pose: no accumulation.
    swing.setAngle(0);
    expect(swing.object.rotation.x).toBeCloseTo(rest, 9);
  });

  it('ignores an angle that is not a finite number rather than losing the seat', () => {
    const { swing } = build();
    swing.setAngle(0.5);
    expect(() => swing.setAngle(Number.NaN)).not.toThrow();
    expect(Number.isFinite(swing.object.rotation.x)).toBe(true);
    expect(Number.isFinite(swing.riderAt(Number.NaN).y)).toBe(true);
  });

  it('hangs the seat the hanger\'s length below the pivot', () => {
    const { swing } = build();
    expect(swing.pivot.y - swing.riderAt(0).y).toBeGreaterThan(SWING_HANG * 0.5);
  });

  it('disposes without throwing, and twice is harmless', () => {
    const { swing } = build();
    expect(() => swing.dispose()).not.toThrow();
    expect(() => swing.dispose()).not.toThrow();
  });
});
