import type { AvatarSpriteKey } from '@strkworld/shared';
import { DEFAULT_AVATAR_SPRITE } from './avatar-state.js';

/**
 * The default figure walking towards the viewer, as one strip of frames: the
 * D-058 presentational projection behind the Shell's wallet-attention cue.
 *
 * `tools/render-avatar-walker.ts` draws it offline from the 3D figure (D-059):
 * Avatar 1's look and its real walk cycle, shaded as the engine shades it, on a
 * transparent background with a soft contact shadow. The Shell plays it with
 * CSS steps, so the cue needs no Three.js and can show before the World's
 * engine has loaded. The strip is one row of square cells: the figure standing
 * still, then one stride of walking at the game's cadence.
 *
 * Presentation only: an asset URL and frame geometry. Nothing here carries
 * movement authority, wallet state or anything a player did, and this module
 * must never import three.js, since the Shell's entry chunk loads it.
 */

/** Whose walk it is: the figure every player starts as. */
export const AVATAR_WALKER_SPRITE: AvatarSpriteKey = DEFAULT_AVATAR_SPRITE;
/** One square cell, in CSS pixels. */
export const AVATAR_WALKER_CELL = 64;
/** Device pixels per CSS pixel in the file, for sharp retina screens. */
export const AVATAR_WALKER_DENSITY = 2;
/** Walking cells after the standing one: one stride, a step on each foot. */
export const AVATAR_WALKER_FRAMES = 12;
/** One stride at the figure's 1.6 strides a second (`three/avatar-figure.ts`). */
export const AVATAR_WALKER_STRIDE_MS = 625;

export interface AvatarWalkerStrip {
  readonly url: string;
  /** One square cell, in CSS pixels. */
  readonly cellSize: number;
  /** Cells in the strip, left to right: standing, then `walkFrames` of walking. */
  readonly cells: number;
  readonly walkFrames: number;
  /** How long the walking cells take to play once. */
  readonly strideMs: number;
}

export const AVATAR_WALKER: AvatarWalkerStrip = Object.freeze({
  url: new URL('../assets/avatar-walker/walk.png', import.meta.url).href,
  cellSize: AVATAR_WALKER_CELL,
  cells: AVATAR_WALKER_FRAMES + 1,
  walkFrames: AVATAR_WALKER_FRAMES,
  strideMs: AVATAR_WALKER_STRIDE_MS,
});
