import { describe, expect, it } from 'vitest';
import {
  calculateMovementVelocity,
  movementSpeed,
  type DirectionInput,
} from './movement-input.js';

const idle: DirectionInput = { left: false, right: false, up: false, down: false };

describe('movement input', () => {
  it('uses walk speed for a cardinal direction and exactly 1.5x while sprinting', () => {
    expect(movementSpeed(false)).toBe(160);
    expect(movementSpeed(true)).toBe(240);
    expect(calculateMovementVelocity({ ...idle, right: true }, false)).toEqual({ x: 160, y: 0 });
    expect(calculateMovementVelocity({ ...idle, right: true }, true)).toEqual({ x: 240, y: 0 });
  });

  it('normalizes diagonal sprinting to the same 240-pixel magnitude', () => {
    const velocity = calculateMovementVelocity({ ...idle, up: true, right: true }, true);
    expect(velocity.x).toBeCloseTo(240 / Math.sqrt(2));
    expect(velocity.y).toBeCloseTo(-240 / Math.sqrt(2));
    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(240);
  });

  it('returns to walk speed as soon as sprint is released', () => {
    const input = { ...idle, down: true };
    expect(calculateMovementVelocity(input, true)).toEqual({ x: 0, y: 240 });
    expect(calculateMovementVelocity(input, false)).toEqual({ x: 0, y: 160 });
  });

  it('provides the same step arithmetic for outdoor and fixed-room movement', () => {
    const input = { ...idle, left: true, down: true };
    const velocity = calculateMovementVelocity(input, true);
    const delta = 100;
    expect({ x: velocity.x * delta / 1000, y: velocity.y * delta / 1000 }).toEqual({
      x: -240 / Math.sqrt(2) / 10,
      y: 240 / Math.sqrt(2) / 10,
    });
  });
});
