import { Group } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { STREET_SEATS, type AvatarSpriteKey } from '@strkworld/shared';
import { createRemotePeerSource, type RemotePeerSnapshot } from '../remote-peer.js';
import { createRemoteAvatarLayer3D } from './remote-avatars.js';
import type { AvatarFigure, AvatarMotion } from './types.js';

/**
 * D-127: a peer sitting on a bench in a shared area. Unlike the arena's tiers,
 * which the layer derives from standing still on one (D-114), a bench seat
 * arrives on the wire, so the figure sits from the very first snapshot.
 */

const SEAT = STREET_SEATS[2]!;

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
  return { id: 'g-sitter', x: SEAT.x, y: SEAT.y, facing: SEAT.facing, sprite: 'avatar-3', ...over };
}

describe('remote avatars on benches (D-127)', () => {
  it('draws a peer the room says is sitting, at once, facing the way it says', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    source.publish([peer({ seat: 2 })]);
    layer.update(16);
    expect(motions.at(-1)?.seated).toBe(true);
    expect(motions.at(-1)?.moving).toBe(false);
    layer.destroy();
  });

  it('stands the peer up when the room stops saying they sit', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    source.publish([peer({ seat: 2 })]);
    layer.update(16);
    expect(motions.at(-1)?.seated).toBe(true);
    source.publish([peer({ x: SEAT.x, y: SEAT.y + 32, facing: 'down', seat: null })]);
    layer.update(16);
    expect(motions.at(-1)?.seated ?? false).toBe(false);
    layer.destroy();
  });

  it('never sits a peer on a seat that does not exist', () => {
    const source = createRemotePeerSource();
    const { factory, motions } = fakeFigures();
    const layer = createRemoteAvatarLayer3D({ source: source.source, figures: factory });
    // The lobby's standing value, an index past the table, and a fraction.
    for (const seat of [-1, STREET_SEATS.length, 1.5, Number.NaN]) {
      source.publish([peer({ seat })]);
      layer.update(16);
      expect(motions.at(-1)?.seated ?? false).toBe(false);
    }
    layer.destroy();
  });
});
