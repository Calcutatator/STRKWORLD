import {
  SANDBOX_MAX_HEIGHT,
  SANDBOX_REACH_ABOVE,
  SANDBOX_REACH_BELOW,
  SANDBOX_STEP_HEIGHT,
  type Facing,
  type SandboxColumn,
  type SandboxTile,
} from '@strkworld/shared';
import { isEntranceTile, isSandboxTile } from './sandbox-channel.js';
import {
  moveWithCollisionSubsteps,
  type CollisionSubstepOptions,
  type MovementPosition,
} from './street-movement.js';

/**
 * Block sandbox gameplay rules on the World side (D-060).
 *
 * Heights come from the shared snapshot; nothing here decides whether a pick
 * or place succeeds — the authority does. These rules decide how the local
 * player walks on the stacks and which tile `E` aims at, using the same
 * shared constants the authority validates against.
 */

export interface SandboxHeights {
  /** Blocks stacked on a street tile; 0 outside the sandbox. */
  heightAt(tileX: number, tileY: number): number;
  /** Top colour of a stack, or null when empty. */
  topColourAt(tileX: number, tileY: number): number | null;
}

export const FLAT_SANDBOX: SandboxHeights = Object.freeze({
  heightAt: () => 0,
  topColourAt: () => null,
});

export function createSandboxHeights(columns: readonly SandboxColumn[]): SandboxHeights {
  const stacks = new Map<string, readonly number[]>();
  for (const column of columns) stacks.set(`${column.x},${column.y}`, column.colours);
  return Object.freeze({
    heightAt(tileX: number, tileY: number): number {
      return stacks.get(`${tileX},${tileY}`)?.length ?? 0;
    },
    topColourAt(tileX: number, tileY: number): number | null {
      const stack = stacks.get(`${tileX},${tileY}`);
      return stack && stack.length > 0 ? stack[stack.length - 1]! : null;
    },
  });
}

/** Tiles a square body overlaps; touching a boundary exactly does not count. */
function bodyTileRange(
  position: MovementPosition,
  halfSize: number,
  tileSize: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const inset = Math.min(halfSize / 2, 1e-6 * Math.max(1, tileSize));
  return {
    minX: Math.floor((position.x - halfSize + inset) / tileSize),
    maxX: Math.floor((position.x + halfSize - inset) / tileSize),
    minY: Math.floor((position.y - halfSize + inset) / tileSize),
    maxY: Math.floor((position.y + halfSize - inset) / tileSize),
  };
}

/**
 * The level a body stands on: the tallest stack it overlaps. Touching a stack
 * one block higher therefore lifts you onto it — the "bounce up" — and you
 * only come down once you have fully left it.
 */
export function levelUnderBody(
  heights: SandboxHeights,
  position: MovementPosition,
  halfSize: number,
  tileSize: number,
): number {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return 0;
  const range = bodyTileRange(position, Math.max(0, halfSize), tileSize);
  let level = 0;
  for (let tileY = range.minY; tileY <= range.maxY; tileY += 1) {
    for (let tileX = range.minX; tileX <= range.maxX; tileX += 1) {
      if (!isSandboxTile(tileX, tileY)) continue;
      level = Math.max(level, heights.heightAt(tileX, tileY));
    }
  }
  return Math.min(level, SANDBOX_MAX_HEIGHT);
}

/** Whether a body is within `margin` tiles of any sandbox tile. */
export function bodyNearSandbox(
  position: MovementPosition,
  halfSize: number,
  tileSize: number,
  margin = 1,
): boolean {
  const range = bodyTileRange(position, Math.max(0, halfSize), tileSize);
  for (let tileY = range.minY - margin; tileY <= range.maxY + margin; tileY += 1) {
    for (let tileX = range.minX - margin; tileX <= range.maxX + margin; tileX += 1) {
      if (isSandboxTile(tileX, tileY)) return true;
    }
  }
  return false;
}

/**
 * Move through tile collision plus stacks. A stack more than one block above
 * the level the body stands on is a wall; anything lower is walkable, so
 * stepping down is free and stepping up is one block at a time. The level is
 * re-read before every substep, and each substep is exactly one step of
 * `moveWithCollisionSubsteps`, so with no blocks the result is identical.
 */
export function moveOnHeightmap(
  options: CollisionSubstepOptions & { readonly heights: SandboxHeights },
): MovementPosition {
  const { position, velocity, delta, tileSize } = options;
  const halfSize = options.collisionHalfSize ?? 0;
  if (
    !position || !velocity ||
    !Number.isFinite(position.x) || !Number.isFinite(position.y) ||
    !Number.isFinite(velocity.x) || !Number.isFinite(velocity.y) ||
    !Number.isFinite(delta) || delta <= 0 ||
    !Number.isFinite(tileSize) || tileSize <= 0
  ) {
    // Defer the exact invalid-input contract to the shared mover.
    return moveWithCollisionSubsteps(options);
  }
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed === 0) return { x: position.x, y: position.y };
  // Mirror moveWithCollisionSubsteps' partition so each call below is one substep.
  const maxStep = Math.min(tileSize / 2, 16);
  const maxTravel = maxStep * 256;
  const requestedTravel = speed * (delta / 1000);
  const travel = Math.min(requestedTravel, maxTravel);
  const steps = Math.max(1, Math.ceil(travel / maxStep));
  const stepDelta = ((travel / speed) * 1000) / steps;
  let current: MovementPosition = { x: position.x, y: position.y };
  for (let step = 0; step < steps; step += 1) {
    const level = levelUnderBody(options.heights, current, halfSize, tileSize);
    current = moveWithCollisionSubsteps({
      ...options,
      position: current,
      delta: stepDelta,
      isSolidAt: (tileX, tileY) =>
        options.isSolidAt(tileX, tileY) ||
        (isSandboxTile(tileX, tileY) &&
          options.heights.heightAt(tileX, tileY) > level + SANDBOX_STEP_HEIGHT),
    });
  }
  return current;
}

const FACING_OFFSET: Readonly<Record<Facing, { x: number; y: number }>> = Object.freeze({
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
});

export interface SandboxAim {
  readonly tile: SandboxTile;
  readonly mode: 'pick' | 'place';
  /** Height of the face acted on: the column height for both modes. */
  readonly level: number;
  /** Whether the shared reach rules allow it from where the player stands. */
  readonly valid: boolean;
}

/** Is a block top at `top` within reach of someone standing at `level`? */
export function withinReach(level: number, top: number): boolean {
  return top >= level - SANDBOX_REACH_BELOW && top <= level + SANDBOX_REACH_ABOVE;
}

/**
 * The tile `E` acts on: the neighbour in the facing direction, if it is part
 * of the sandbox. Carrying means place; empty hands mean pick. With empty
 * hands and nothing on the tile there is nothing to aim at, so no highlight
 * follows the player across bare floor.
 */
export function sandboxAim(options: {
  readonly heights: SandboxHeights;
  readonly position: MovementPosition;
  readonly facing: Facing;
  readonly carrying: number | null;
  readonly halfSize: number;
  readonly tileSize: number;
}): SandboxAim | null {
  const { position, tileSize } = options;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const here = { x: Math.floor(position.x / tileSize), y: Math.floor(position.y / tileSize) };
  const offset = FACING_OFFSET[options.facing] ?? FACING_OFFSET.down;
  const tile = { x: here.x + offset.x, y: here.y + offset.y };
  if (!isSandboxTile(tile.x, tile.y)) return null;
  // Reach is judged from the stack under the player's centre — the authority's
  // rule — so the highlight never promises what the server will refuse. (The
  // body-overlap level decides where you stand, not what you can reach.)
  const level = options.heights.heightAt(here.x, here.y);
  const height = options.heights.heightAt(tile.x, tile.y);
  if (options.carrying === null) {
    if (height === 0) return null;
    return Object.freeze({
      tile: Object.freeze(tile),
      mode: 'pick',
      level: height,
      valid: height >= 1 && withinReach(level, height),
    });
  }
  // The entrance stays one step deep at most, as the authority enforces.
  const cap = isEntranceTile(tile.x, tile.y) ? SANDBOX_STEP_HEIGHT : SANDBOX_MAX_HEIGHT;
  return Object.freeze({
    tile: Object.freeze(tile),
    mode: 'place',
    level: height,
    valid: height + 1 <= cap && withinReach(level, height + 1),
  });
}
