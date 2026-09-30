import {
  FOOTBALL_WIN_SCORE,
  PITCH_AREA,
  type FootballPhase,
  type FootballSide,
} from '@strkworld/shared';
import { TILE_SIZE } from './map/street.js';

/**
 * The World's view of the shared football (D-078).
 *
 * The Shell supplies it — backed by the lobby in multiplayer and by the same
 * rules run locally when playing solo — so the World never imports the
 * lobby. The World asks where to draw the ball each frame, draws the
 * celebrations it is told about and sends the local player's kicks; the
 * authority decides, and the World never simulates the ball itself.
 */

/** The ball to draw this frame, and the scoreboard. World pixels and pixels per second. */
export interface FootballFrame {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly west: number;
  readonly east: number;
  readonly phase: FootballPhase;
}

/**
 * A moment the pitch celebrates: a goal for a side, or full time, who won and
 * the final score. Neither names a player.
 */
export type FootballMoment =
  | { readonly kind: 'goal'; readonly side: FootballSide }
  | { readonly kind: 'full-time'; readonly winner: FootballSide; readonly west: number; readonly east: number };

export interface FootballChannel {
  /**
   * Where the ball is to be drawn now, carried on smoothly from the
   * authority's latest state, or null while there is none to draw.
   */
  frame(): FootballFrame | null;
  /** Goals and full time as they happen: celebration cues only; the frame's score is the truth. */
  subscribeMoments?(listener: (moment: FootballMoment) => void): () => void;
  /** The local player kicks. The authority decides whether they reached the ball. */
  kick(): void;
}

const PHASES: readonly FootballPhase[] = Object.freeze(['live', 'goal', 'full-time']);

/** The pitch square in World pixels, with a tile to spare: nowhere else can the ball be drawn. */
const BOUNDS = Object.freeze({
  minX: (PITCH_AREA.x - 1) * TILE_SIZE,
  maxX: (PITCH_AREA.x + PITCH_AREA.width + 1) * TILE_SIZE,
  minY: (PITCH_AREA.y - 1) * TILE_SIZE,
  maxY: (PITCH_AREA.y + PITCH_AREA.height + 1) * TILE_SIZE,
});

/** The fastest a drawn ball may be said to move, in pixels per second: well past any kick. */
const MAX_DRAWN_SPEED = 40 * TILE_SIZE;

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= FOOTBALL_WIN_SCORE;
}

function isSide(value: unknown): value is FootballSide {
  return value === 'west' || value === 'east';
}

/**
 * Validate an untrusted frame. Anything not exactly a frame is not drawn: a
 * ball off the pitch square, a speed no kick gives, a score past the winning
 * one or a phase the rules do not have. The result is frozen.
 */
export function normalizeFootballFrame(value: unknown): FootballFrame | null {
  if (value === null || typeof value !== 'object') return null;
  let record: Partial<Record<keyof FootballFrame, unknown>>;
  try {
    const { x, y, vx, vy, west, east, phase } = value as Partial<Record<keyof FootballFrame, unknown>>;
    record = { x, y, vx, vy, west, east, phase };
  } catch {
    return null;
  }
  const { x, y, vx, vy, west, east, phase } = record;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof vx !== 'number' || typeof vy !== 'number') return null;
  if (![x, y, vx, vy].every(Number.isFinite)) return null;
  if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) return null;
  if (Math.hypot(vx, vy) > MAX_DRAWN_SPEED) return null;
  if (!isScore(west) || !isScore(east)) return null;
  if (typeof phase !== 'string' || !PHASES.includes(phase as FootballPhase)) return null;
  return Object.freeze({ x, y, vx, vy, west, east, phase: phase as FootballPhase });
}

/** Validate an untrusted moment; anything else is not celebrated. Frozen. */
export function normalizeFootballMoment(value: unknown): FootballMoment | null {
  if (value === null || typeof value !== 'object') return null;
  let kind: unknown;
  let side: unknown;
  let winner: unknown;
  let west: unknown;
  let east: unknown;
  try {
    ({ kind, side, winner, west, east } = value as { kind?: unknown; side?: unknown; winner?: unknown; west?: unknown; east?: unknown });
  } catch {
    return null;
  }
  if (kind === 'goal' && isSide(side)) return Object.freeze({ kind, side });
  if (kind === 'full-time' && isSide(winner) && isScore(west) && isScore(east)) {
    // The winner is the side ahead: a moment that says otherwise is not believed.
    if ((winner === 'west') !== west > east || west === east) return null;
    return Object.freeze({ kind, winner, west, east });
  }
  return null;
}
