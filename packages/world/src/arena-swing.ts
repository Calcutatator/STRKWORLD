import {
  ARENA_ORIGIN_PX,
  ARENA_SWING_MS,
  ARENA_TILE_SIZE,
  arenaTileAt,
} from '@strkworld/shared';
import type { AttackPose } from './three/types.js';

/**
 * D-114: the arena swing's timeline and the spectators' seats, as pure
 * presentation helpers shared by the local figure (the presenter), the remote
 * avatar layer and the combat session. Nothing here decides a hit: the lobby
 * does, from its own held position and facing.
 */

/** The swing's three stages, ms: 100 + 120 + 130 = `ARENA_SWING_MS` (350). */
export const ARENA_SWING_WINDUP_MS = 100;
export const ARENA_SWING_STRIKE_MS = 120;
export const ARENA_SWING_RECOVER_MS = ARENA_SWING_MS - ARENA_SWING_WINDUP_MS - ARENA_SWING_STRIKE_MS;

/** A peer or the player standing this long on a tier sits down (derived locally, no wire field). */
export const ARENA_SEAT_IDLE_MS = 1_500;

/**
 * The swing pose `elapsedMs` into a swing, or null before it starts and once
 * it is over. `progress` runs 0..1 within the current stage.
 */
export function attackPoseAt(elapsedMs: number): AttackPose | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= ARENA_SWING_MS) return null;
  if (elapsedMs < ARENA_SWING_WINDUP_MS) {
    return { stage: 'windup', progress: elapsedMs / ARENA_SWING_WINDUP_MS };
  }
  const struck = elapsedMs - ARENA_SWING_WINDUP_MS;
  if (struck < ARENA_SWING_STRIKE_MS) return { stage: 'strike', progress: struck / ARENA_SWING_STRIKE_MS };
  return { stage: 'recover', progress: (struck - ARENA_SWING_STRIKE_MS) / ARENA_SWING_RECOVER_MS };
}

/** One figure's swing: started by input or a server counter, stepped by the frame. */
export interface SwingClock {
  /** Start a swing; a swing already playing restarts from the wind-up. */
  start(): void;
  /** Advance by one frame and return this frame's pose, or null when not swinging. */
  step(deltaMs: number): AttackPose | null;
  readonly active: boolean;
}

export function createSwingClock(): SwingClock {
  let elapsed: number | null = null;
  return {
    start() {
      elapsed = 0;
    },
    step(deltaMs) {
      if (elapsed === null) return null;
      const pose = attackPoseAt(elapsed);
      elapsed += Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
      if (pose === null) elapsed = null;
      return pose;
    },
    get active() {
      return elapsed !== null;
    },
  };
}

/**
 * Whether a World pixel point in the arena room (room origin included, as the
 * lobby holds positions) stands on a tier seat.
 */
export function isArenaSeatAt(xPx: number, yPx: number): boolean {
  if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) return false;
  const tx = Math.floor((xPx - ARENA_ORIGIN_PX) / ARENA_TILE_SIZE);
  const ty = Math.floor((yPx - ARENA_ORIGIN_PX) / ARENA_TILE_SIZE);
  return arenaTileAt(tx, ty) === 'tier';
}

/**
 * Sits a figure down once it has stood still on a seat for `ARENA_SEAT_IDLE_MS`;
 * any step stands it up at once.
 */
export interface SeatTracker {
  /** Advance one frame; returns whether the figure is seated this frame. */
  step(deltaMs: number, moving: boolean, onSeat: boolean): boolean;
}

export function createSeatTracker(): SeatTracker {
  let still = 0;
  return {
    step(deltaMs, moving, onSeat) {
      if (moving || !onSeat) {
        still = 0;
        return false;
      }
      still += Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
      return still >= ARENA_SEAT_IDLE_MS;
    },
  };
}
