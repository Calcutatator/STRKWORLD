import { Group } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ARENA_BOX, arenaTileCentre, type AvatarSpriteKey } from '@strkworld/shared';
import { createRemotePeerSource, type RemotePeerSnapshot } from '../remote-peer.js';
import { ARENA_SEAT_IDLE_MS, isArenaSeatAt } from '../arena-swing.js';
import { createRemoteAvatarLayer3D } from './remote-avatars.js';
import { ARENA_SURFACE, ARENA_THRONE_SEAT } from './arena-room.js';
import type { AvatarFigure, AvatarMotion } from './types.js';

const TIER = arenaTileCentre({ x: 20, y: 29 });
const SAND = arenaTileCentre({ x: 10, y: 16 });

function fakeFigures() {
  const motions: AvatarMotion[] = [];
  const factory = (key: AvatarSpriteKey): AvatarFigure => ({
    object: new Group(),
    look: key,
    setLook: vi.fn(),
    update: (_dt: number, motion: AvatarMotion) => {
      motions.push(motion);
    },
    dispose: vi.fn(),
  });
  return { factory, motions };
}

function peer(over: Partial<RemotePeerSnapshot> = {}): RemotePeerSnapshot {
  return { id: 'g-fighter', x: SAND.x, y: SAND.y, facing: 'up', sprite: 'avatar-9', ...over };
}

describe('remote avatars in the arena (D-114)', () => {
  it('playSwing plays one swing through its three stages on that peer only', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    source.publish([peer()]);
    layer.playSwing('g-fighter');
    layer.playSwing('g-nobody');
    const stages: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      layer.update(16);
      const stage = motions.at(-1)?.attack?.stage;
      if (stage && stages.at(-1) !== stage) stages.push(stage);
    }
    expect(stages).toEqual(['windup', 'strike', 'recover']);
    expect(motions.at(-1)?.attack ?? null).toBeNull();
    layer.destroy();
  });

  it('setFighter puts that peer in the battle stance until the ring frees', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    source.publish([peer()]);
    layer.setFighter('g-fighter');
    layer.update(16);
    expect(motions.at(-1)?.guard).toBe(true);
    layer.setFighter(null);
    layer.update(16);
    expect(motions.at(-1)?.guard ?? false).toBe(false);
    layer.destroy();
  });

  it('setBlocker puts that peer in the block stance, and only that peer (D-128)', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    source.publish([peer()]);
    // A spectator sees the guard the server published, over the battle stance.
    layer.setFighter('g-fighter');
    layer.setBlocker('g-fighter');
    layer.update(16);
    expect(motions.at(-1)).toMatchObject({ guard: true, blocking: true });
    // Somebody else's block is not this peer's.
    layer.setBlocker('g-nobody');
    layer.update(16);
    expect(motions.at(-1)?.blocking ?? false).toBe(false);
    expect(motions.at(-1)?.guard).toBe(true);
    layer.setBlocker(null);
    layer.update(16);
    expect(motions.at(-1)?.blocking ?? false).toBe(false);
    layer.destroy();
  });

  it('setThroned seats the champion at once, with no idle wait, wherever they stand (D-128)', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    // On the box's own tile, which is not a tier seat: only the server's word seats them.
    source.publish([peer()]);
    layer.update(16);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.setThroned('g-fighter');
    layer.update(16);
    expect(motions.at(-1)?.seated).toBe(true);
    // Deposed: the next frame has them standing again.
    layer.setThroned('g-other');
    layer.update(16);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.setThroned(null);
    layer.update(16);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.destroy();
  });

  /*
   * D-128, amended 2026-10-03: a peer on the throne sits on it rather than
   * inside it, by the same seat system the local champion uses (D-127) — the
   * throne's own `SeatPlace` on the motion, so the two views agree and there
   * is no second height for them to drift apart on.
   */
  it('gives a throned peer the throne\'s seat, from the first frame', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const figures: AvatarFigure[] = [];
    const layer = createRemoteAvatarLayer3D({
      source: source.source,
      figures: (key) => {
        const figure = factory(key);
        figures.push(figure);
        return figure;
      },
      // The arena's own surface: the box's tile is the podium's top.
      surfaceHeight: () => ARENA_SURFACE.podium,
    });
    const box = arenaTileCentre(ARENA_BOX);
    source.publish([peer({ x: box.x, y: box.y, sprite: 'avatar-12' })]);
    layer.update(16);
    // Standing: the podium, like anybody else on that tile, and no seat.
    expect(figures[0]!.object.position.y).toBeCloseTo(ARENA_SURFACE.podium, 3);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.setThroned('g-fighter');
    // The server put them on it, so they are on it: no tier idle wait.
    layer.update(16);
    expect(motions.at(-1)?.seated).toBe(true);
    expect(motions.at(-1)?.seat).toBe(ARENA_THRONE_SEAT);
    // The feet keep the podium; the rise onto the pad is the figure's own.
    for (let t = 0; t < 40; t += 1) layer.update(16);
    expect(figures[0]!.object.position.y).toBeCloseTo(ARENA_SURFACE.podium, 2);
    layer.setThroned(null);
    layer.update(16);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    expect(motions.at(-1)?.seat ?? null).toBeNull();
    layer.destroy();
  });

  it('a peer standing still on a tier for 1.5 s sits, and stands to walk', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory, seatAt: isArenaSeatAt });
    source.publish([peer({ id: 'g-fan', x: TIER.x, y: TIER.y })]);
    for (let t = 0; t < ARENA_SEAT_IDLE_MS - 100; t += 50) layer.update(50);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    for (let t = 0; t < 200; t += 50) layer.update(50);
    expect(motions.at(-1)?.seated).toBe(true);
    source.publish([peer({ id: 'g-fan', x: TIER.x + 12, y: TIER.y })]);
    layer.update(16);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.destroy();
  });

  it('nobody sits on the sand, or anywhere without a seat function', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory, seatAt: isArenaSeatAt });
    source.publish([peer({ id: 'g-fan' })]);
    for (let t = 0; t < 3000; t += 50) layer.update(50);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.destroy();
    const bare = fakeFigures();
    const plain = createRemoteAvatarLayer3D({ source: source.source, figures: bare.factory });
    source.publish([peer({ id: 'g-fan', x: TIER.x, y: TIER.y })]);
    for (let t = 0; t < 3000; t += 50) plain.update(50);
    expect(bare.motions.at(-1)?.seated ?? false).toBe(false);
    plain.destroy();
  });

  it('is inert after destroy', () => {
    const source = createRemotePeerSource();
    const { factory } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    layer.destroy();
    expect(() => {
      layer.playSwing('g-fighter');
      layer.setFighter('g-fighter');
    }).not.toThrow();
  });
});
