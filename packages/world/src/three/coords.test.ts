import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  directionToYaw,
  facingToYaw,
  pixelToGround,
  tileCenterToGround,
} from './coords.js';
import { tileToWorld } from '../map/street.js';
import { ROOM_ORIGIN } from '../world-layout.js';

describe('World-to-scene coordinates', () => {
  it('maps one 32 px tile to one world unit with +Z pointing south', () => {
    expect(pixelToGround(32, 64)).toEqual({ x: 1, z: 2 });
    const spawn = tileToWorld(24, 15);
    expect(pixelToGround(spawn.x, spawn.y)).toEqual(tileCenterToGround(24, 15));
  });

  it('offsets interior tiles by the shared room origin', () => {
    expect(tileCenterToGround(0, 0, ROOM_ORIGIN)).toEqual({ x: 2.5, z: 2.5 });
  });

  it('faces each wire direction along its World axis', () => {
    const front = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
    expect(front(facingToYaw('down')).z).toBeCloseTo(1);
    expect(front(facingToYaw('up')).z).toBeCloseTo(-1);
    expect(front(facingToYaw('right')).x).toBeCloseTo(1);
    expect(front(facingToYaw('left')).x).toBeCloseTo(-1);
  });

  it('turns a pixel direction into a yaw, and no motion into null', () => {
    expect(directionToYaw(0, 1)).toBeCloseTo(facingToYaw('down'));
    expect(directionToYaw(1, 0)).toBeCloseTo(facingToYaw('right'));
    expect(directionToYaw(0, 0)).toBeNull();
    expect(directionToYaw(Number.NaN, 1)).toBeNull();
  });

  it('takes the short way round', () => {
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDelta(1, 1)).toBe(0);
  });
});
