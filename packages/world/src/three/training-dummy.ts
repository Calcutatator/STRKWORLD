import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The straw training dummy, as one figure both the ring and the pitch use.
 *
 * It began as the arena's (D-114, `arena-fx.ts`), which is the only thing that
 * toppled or flashed it. D-135 gives the gated football pitch three of them so
 * one person can test a 2v2 alone, and a second copy of a sixteen-box figure
 * would be a figure that drifts, so the shape lives here and both callers
 * build from it.
 *
 * Geometry only: no material, no scene, no behaviour. `arena-fx.ts` still owns
 * the wobble, the topple and the HP bar; `pitch-builder.ts` owns the pitch's
 * four, which only ever stand and slide.
 *
 * The figure stands on the origin, facing +Z, about 1.7 world units tall.
 */

export type TrainingDummyBox = readonly [
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  colour: number,
];

/** The figure's own palette. `body` is the sack, which a caller may re-colour. */
export const TRAINING_DUMMY_COLOURS = Object.freeze({
  post: 0x7a5232,
  postDark: 0x5c3c22,
  sack: 0xc9a46a,
  sackDark: 0xa8834e,
  straw: 0xf0cf6a,
  target: 0xc8321e,
  targetLight: 0xf6ecd9,
  rope: 0x8a6a40,
});

/**
 * The figure: a post on a cross foot, a sack body with a painted target, a
 * crossbar for arms, and straw poking out underneath.
 */
export const TRAINING_DUMMY_BOXES: readonly TrainingDummyBox[] = Object.freeze([
  [[0.7, 0.08, 0.12], [0, 0.04, 0], TRAINING_DUMMY_COLOURS.postDark],
  [[0.12, 0.08, 0.7], [0, 0.04, 0], TRAINING_DUMMY_COLOURS.postDark],
  [[0.12, 1.3, 0.12], [0, 0.65, 0], TRAINING_DUMMY_COLOURS.post],
  [[0.52, 0.62, 0.36], [0, 0.98, 0], TRAINING_DUMMY_COLOURS.sack],
  [[0.54, 0.06, 0.38], [0, 0.72, 0], TRAINING_DUMMY_COLOURS.rope],
  [[0.54, 0.06, 0.38], [0, 1.24, 0], TRAINING_DUMMY_COLOURS.rope],
  [[1.0, 0.09, 0.09], [0, 1.17, 0], TRAINING_DUMMY_COLOURS.post],
  [[0.12, 0.14, 0.14], [0.53, 1.17, 0], TRAINING_DUMMY_COLOURS.straw],
  [[0.12, 0.14, 0.14], [-0.53, 1.17, 0], TRAINING_DUMMY_COLOURS.straw],
  [[0.34, 0.32, 0.32], [0, 1.46, 0], TRAINING_DUMMY_COLOURS.sackDark],
  [[0.36, 0.06, 0.34], [0, 1.6, 0], TRAINING_DUMMY_COLOURS.straw],
  // The target, painted on the front (+Z).
  [[0.36, 0.36, 0.012], [0, 0.98, 0.186], TRAINING_DUMMY_COLOURS.target],
  [[0.24, 0.24, 0.012], [0, 0.98, 0.194], TRAINING_DUMMY_COLOURS.targetLight],
  [[0.12, 0.12, 0.012], [0, 0.98, 0.202], TRAINING_DUMMY_COLOURS.target],
  // Straw poking out under the sack.
  [[0.4, 0.08, 0.26], [0, 0.64, 0], TRAINING_DUMMY_COLOURS.straw],
]);

/** How tall the figure stands, in world units: the top of its straw hair. */
export const TRAINING_DUMMY_HEIGHT = 1.66;

export function trainingDummyBox(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  colour: number,
): BufferGeometry {
  const box = new BoxGeometry(size[0], size[1], size[2]).toNonIndexed();
  box.translate(at[0], at[1], at[2]);
  const c = new Color(colour);
  const count = box.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) colours.set([c.r, c.g, c.b], i * 3);
  box.setAttribute('color', new Float32BufferAttribute(colours, 3));
  box.deleteAttribute('uv');
  return box;
}

export function mergeTrainingDummyBoxes(boxes: readonly TrainingDummyBox[]): BufferGeometry {
  const parts = boxes.map(([size, at, colour]) => trainingDummyBox(size, at, colour));
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('training-dummy: could not merge geometry');
  return merged;
}

/**
 * The figure as one vertex-coloured geometry. `body` re-colours the sack and
 * its darker head — D-135 puts the pitch's dummies in their team's colours —
 * and leaves the post, ropes and straw alone, so it still reads as the same
 * straw dummy in a shirt rather than a differently coloured object.
 */
export function trainingDummyGeometry(body?: { readonly sack: number; readonly sackDark: number }): BufferGeometry {
  if (!body) return mergeTrainingDummyBoxes(TRAINING_DUMMY_BOXES);
  const recoloured = TRAINING_DUMMY_BOXES.map(([size, at, colour]): TrainingDummyBox => {
    if (colour === TRAINING_DUMMY_COLOURS.sack) return [size, at, body.sack];
    if (colour === TRAINING_DUMMY_COLOURS.sackDark) return [size, at, body.sackDark];
    return [size, at, colour];
  });
  return mergeTrainingDummyBoxes(recoloured);
}
