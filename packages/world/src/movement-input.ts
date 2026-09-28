import type { MovementInput } from './street-movement.js';

export type DirectionInput = MovementInput;

export interface MovementVelocity {
  readonly x: number;
  readonly y: number;
}

export const PLAYER_WALK_SPEED = 160;
export const PLAYER_SPRINT_MULTIPLIER = 1.5;

export function movementSpeed(sprinting: boolean): number {
  return PLAYER_WALK_SPEED * (sprinting ? PLAYER_SPRINT_MULTIPLIER : 1);
}

/** Return a normalized velocity so cardinal and diagonal movement share a speed. */
export function calculateMovementVelocity(
  input: DirectionInput,
  sprinting: boolean,
): MovementVelocity {
  let x = 0;
  let y = 0;
  if (input.left) x -= 1;
  if (input.right) x += 1;
  if (input.up) y -= 1;
  if (input.down) y += 1;
  if (x === 0 && y === 0) return { x: 0, y: 0 };

  const length = Math.hypot(x, y);
  const speed = movementSpeed(sprinting);
  return { x: (x / length) * speed, y: (y / length) * speed };
}
