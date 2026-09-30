import { FOOTBALL_BALL_RADIUS, FOOTBALL_TICK_MS, type Facing, type FootballSnapshot } from '@strkworld/shared';
import {
  FOOTBALL_PLAYER_RADIUS,
  FOOTBALL_TILE_SIZE,
  kickBall,
  stepBall,
  type BallState,
  type FootballPusher,
} from '@strkworld/lobby/football';
import type { FootballFrame } from '@strkworld/world';

/**
 * The ball as the Shell draws it (D-078): carried on smoothly from the
 * authority's latest state, whatever the network does to it.
 *
 * Each authoritative snapshot is dated by its simulation tick, so it can be
 * placed in the authority's time exactly however late or bunched its patch
 * arrived. The presenter keeps the smallest gap it has seen between a
 * snapshot's arrival and its tick — the fastest delivery, which jitter can
 * only make slower — as the offset between the two clocks, and draws the
 * ball where the shared rules (`stepBall`) say the latest snapshot has rolled
 * to by now: through the boards, the posts and the net as the authority will
 * play them. So the ball is drawn at the authority's present, never an
 * interpolation delay behind it, and a snapshot that corrects the carried-on
 * ball is eased in over `CORRECTION_MS` rather than jumped to.
 *
 * The local player's own touches answer at once: a kick, or walking into
 * the ball, plays out in the same rules from the ball as drawn for a moment
 * (`KICK_RESPONSE_MS`, `DRIBBLE_RESPONSE_MS`) and then hands back to the
 * authority's ball, easing in whatever difference is left. A kick the
 * authority refused eases back the same way.
 */

/** Where the local player stands and how they move: World pixels, pixels per second. */
export interface LocalPlayer {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly facing: Facing;
}

export interface BallPresenter {
  /** A new authoritative snapshot, which arrived at `receivedAt` (local ms). */
  push(snapshot: FootballSnapshot, receivedAt: number): void;
  /** Forget everything: a new room, a dropped connection, a switch to solo play. */
  reset(): void;
  /** The ball to draw at local time `now`, with the local player where they stand; null before any snapshot. */
  frame(now: number, local?: LocalPlayer | null): FootballFrame | null;
  /** The local player kicked at `now`: play the kick at once, as the rules would. Whether it reached the ball. */
  kick(now: number, local: LocalPlayer): boolean;
}

/** Snapshots the clock offset is the smallest over: about a second and a half of a moving ball. */
export const OFFSET_SAMPLES = 40;
/** The furthest past the latest snapshot the ball is carried on, in ms; then it waits for the next. */
export const MAX_EXTRAPOLATION_MS = 400;
/** A correction's time constant, in ms: most of it gone in a tenth of a second. */
export const CORRECTION_MS = 90;
/** A correction bigger than this, in World pixels, is a jump (a kick-off, a lost stretch): drawn at once. */
export const SNAP_DISTANCE = 3 * FOOTBALL_TILE_SIZE;
/** How long a local kick plays out before the authority's ball takes over, in ms. */
export const KICK_RESPONSE_MS = 260;
/** How long a local push plays out after the last touch, in ms. */
export const DRIBBLE_RESPONSE_MS = 180;

const BALL_R = FOOTBALL_BALL_RADIUS * FOOTBALL_TILE_SIZE;

interface Latest {
  readonly snapshot: FootballSnapshot;
  /** Its time in the authority's clock, in ms. */
  readonly at: number;
}

interface Prediction {
  ball: BallState;
  /** Local time the ball above is at. */
  at: number;
  /** Local time the authority takes over again. */
  until: number;
}

interface Correction {
  readonly x: number;
  readonly y: number;
  /** Local time it was measured. */
  readonly at: number;
}

export function createBallPresenter(): BallPresenter {
  let latest: Latest | null = null;
  const offsets: number[] = [];
  let offset = 0;
  let correction: Correction | null = null;
  let prediction: Prediction | null = null;
  /** The last extrapolation, reused within a frame. */
  let cache: { readonly latest: Latest; readonly now: number; readonly ball: BallState } | null = null;

  /** The authority's ball carried on to local time `now`. */
  const carried = (now: number): BallState | null => {
    if (latest === null) return null;
    if (cache !== null && cache.latest === latest && cache.now === now) return cache.ball;
    const { snapshot } = latest;
    let ball: BallState = { x: snapshot.x, y: snapshot.y, vx: snapshot.vx, vy: snapshot.vy };
    let remaining = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, now - offset - latest.at));
    if (ball.vx !== 0 || ball.vy !== 0) {
      while (remaining >= FOOTBALL_TICK_MS) {
        ball = stepBall(ball, FOOTBALL_TICK_MS).ball;
        remaining -= FOOTBALL_TICK_MS;
      }
      if (remaining > 0) ball = stepBall(ball, remaining).ball;
    }
    cache = { latest, now, ball };
    return ball;
  };

  /** What is drawn at `now` apart from a prediction: the carried-on ball, plus what is left of a correction. */
  const settled = (now: number): BallState | null => {
    const ball = carried(now);
    if (ball === null) return null;
    if (correction === null) return ball;
    const left = Math.exp(-Math.max(0, now - correction.at) / CORRECTION_MS);
    if (left < 0.01) {
      correction = null;
      return ball;
    }
    return { x: ball.x + correction.x * left, y: ball.y + correction.y * left, vx: ball.vx, vy: ball.vy };
  };

  const pusher = (local: LocalPlayer | null | undefined): FootballPusher[] =>
    local && [local.x, local.y, local.vx, local.vy].every(Number.isFinite)
      ? [{ x: local.x, y: local.y, vx: local.vx, vy: local.vy }]
      : [];

  /** Play a prediction on to `now`, with the local player as the one body it meets. */
  const advance = (now: number, local: LocalPlayer | null | undefined): void => {
    if (prediction === null) return;
    const dt = now - prediction.at;
    if (dt > 0) {
      prediction.ball = stepBall(prediction.ball, dt, pusher(local)).ball;
      prediction.at = now;
    }
  };

  /** End a prediction: the authority's ball takes over, easing in the difference. */
  const handBack = (now: number): void => {
    if (prediction === null) return;
    const ball = carried(now);
    if (ball !== null) {
      const dx = prediction.ball.x - ball.x;
      const dy = prediction.ball.y - ball.y;
      correction = Math.hypot(dx, dy) > SNAP_DISTANCE ? null : { x: dx, y: dy, at: now };
    }
    prediction = null;
  };

  const reset = (): void => {
    latest = null;
    offsets.length = 0;
    offset = 0;
    correction = null;
    prediction = null;
    cache = null;
  };

  const shown = (now: number, local: LocalPlayer | null | undefined): BallState | null => {
    if (prediction !== null) {
      // Played on to now either way, so the hand-back measures from where it is drawn now.
      advance(now, local);
      if (now < prediction.until) return prediction.ball;
      handBack(now);
    }
    return settled(now);
  };

  return {
    push(snapshot, receivedAt) {
      if (!Number.isFinite(receivedAt)) return;
      const at = snapshot.tick * FOOTBALL_TICK_MS;
      if (latest !== null && snapshot.tick < latest.snapshot.tick) {
        // An older tick is another authority: a new room, or solo play.
        reset();
      }
      const before = latest === null ? null : settled(receivedAt);
      const previousPhase = latest?.snapshot.phase ?? null;
      offsets.push(receivedAt - at);
      if (offsets.length > OFFSET_SAMPLES) offsets.shift();
      offset = Math.min(...offsets);
      latest = { snapshot, at };
      cache = null;
      const after = carried(receivedAt);
      // A kick-off moves the ball to the centre spot: draw it there at once.
      const kickOff = previousPhase !== null && previousPhase !== 'live' && snapshot.phase === 'live';
      if (before === null || after === null || kickOff) {
        correction = null;
        if (kickOff) prediction = null;
        return;
      }
      const dx = before.x - after.x;
      const dy = before.y - after.y;
      correction = Math.hypot(dx, dy) > SNAP_DISTANCE ? null : { x: dx, y: dy, at: receivedAt };
    },
    reset,
    frame(now, local) {
      if (latest === null || !Number.isFinite(now)) return null;
      let ball = shown(now, local);
      if (ball === null) return null;
      const { snapshot } = latest;
      // Walking into the ball answers at once: the push plays out here first.
      if (snapshot.phase === 'live' && local && pusher(local).length > 0) {
        const touching = Math.hypot(ball.x - local.x, ball.y - local.y) < BALL_R + FOOTBALL_PLAYER_RADIUS;
        if (touching) {
          if (prediction === null) prediction = { ball, at: now, until: now + DRIBBLE_RESPONSE_MS };
          else prediction.until = Math.max(prediction.until, now + DRIBBLE_RESPONSE_MS);
          // Resolve the touch now, so the ball never sits inside the player.
          prediction.ball = stepBall(prediction.ball, 1, pusher(local)).ball;
          ball = prediction.ball;
        }
      }
      return Object.freeze({
        x: ball.x,
        y: ball.y,
        vx: ball.vx,
        vy: ball.vy,
        west: snapshot.west,
        east: snapshot.east,
        phase: snapshot.phase,
      });
    },
    kick(now, local) {
      if (latest === null || latest.snapshot.phase !== 'live' || !Number.isFinite(now)) return false;
      const ball = shown(now, local);
      if (ball === null) return false;
      const kicked = kickBall(ball, local, local.facing);
      if (kicked === null) return false;
      prediction = { ball: kicked, at: now, until: now + KICK_RESPONSE_MS };
      return true;
    },
  };
}
