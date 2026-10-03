import { Box3, Mesh, Vector3, type Object3D } from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { avatarPartBoxes, createAvatarFigure } from './avatar-figure.js';
import type { AvatarMotion } from './types.js';

/**
 * Where a seated figure's body actually is (D-133, 2026-10-03).
 *
 * The sixteen looks are three builds at three scales, so "sit the avatar on
 * the seat" is not one number: a small figure's hips are 12 cm above its feet
 * and a large one's 30, and a seat height picked for the middle leaves one
 * sunk into the board and the other hovering over it. So nothing picks a
 * height — this measures the look itself, once, from the same figure the
 * scene draws, and the swing (and anything else with a seat) places the
 * rider from what it finds.
 *
 * TODO (integration): `claude/benchsit` landed on `origin/main` while this
 * branch was in flight (D-127 amended, 2026-10-03). It adds
 * `avatarSeatedContact()` and an `AvatarMotion.seat` that raises a figure onto
 * a surface, and it changes the seated pose itself — the thighs now lie level
 * along the seat instead of hanging from the hip pivot. That is the same
 * measurement this module makes, done better, and it is a different body to
 * measure. On merge: take `avatarSeatedContact()` as the one helper, drop
 * this module's measuring, and re-run `tools/swing-fit.ts` — it re-measures
 * every look from the figure, so it will report what the new pose does to the
 * plank, the backrest and the rail rather than letting it pass silently.
 *
 * Measured, not derived: a robe's hem, a coat's tail and a cuirass all change
 * where the body meets a seat, and none of them are in the build table.
 */

/** The pose a seat puts a figure in: settled, sitting, looking straight ahead. */
const SEATED: AvatarMotion = Object.freeze({ moving: false, sprinting: false, seated: true });
/** Frames of 25 ms to settle the seat's ease-in; the weight is well past 1 - 1e-3 by then. */
const SETTLE_FRAMES = 80;

export interface SeatedFit {
  /**
   * How far the figure's origin (where its feet stand) is below the seat's
   * top face when it sits on it: the underside of its seated body, which is
   * its hips, or the hem of whatever it is wearing over them.
   */
  readonly hipDrop: number;
  /** How far below the seat's top face the lowest point of the figure hangs (its boots). */
  readonly footDrop: number;
  /** How far forward of the seat's hanging axis the knees reach. */
  readonly kneeReach: number;
  /** How far behind it the back reaches: what a backrest bar has to clear. */
  readonly backReach: number;
  /** Where the hands come to rest: forward of the axis, and above the seat's top face. */
  readonly handReach: number;
  readonly handHeight: number;
  /** Half the seated figure's width across the shoulders: what the hangers have to clear. */
  readonly halfWidth: number;
  /** The top of the head above the seat's top face. */
  readonly headTop: number;
}

const MEASURED = new Map<AvatarSpriteKey, SeatedFit>();

/**
 * The world-space box of every piece whose mesh and tag pass `wanted`, or
 * null for none. Measuring by the pieces' own tags rather than by whole
 * meshes is what keeps a coat's tail out of the hips and a halberd out of
 * the hands.
 */
function boxOf(root: Object3D, wanted: (mesh: string, tag: string) => boolean): Box3 | null {
  const box = new Box3();
  const point = new Vector3();
  let found = false;
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (const part of avatarPartBoxes(object.geometry)) {
      if (!wanted(object.name, part.tag)) continue;
      for (let v = part.first * 3; v < (part.first + part.count) * 3; v += 1) {
        point.fromBufferAttribute(position, v).applyMatrix4(object.matrixWorld);
        box.expandByPoint(point);
        found = true;
      }
    }
  });
  return found ? box : null;
}

/**
 * The piece a figure meets a seat with: the hip band every look has, whatever
 * it wears over it. Not a robe's bell or a coat's tail — those are cloth, and
 * a figure sat by its hem would hover over the board with its hem through it.
 */
const SEAT_CONTACT: ReadonlySet<string> = new Set(['hips']);
/** The pieces that are a hand: what a grab rail or a hanger has to come to. */
const HANDS: ReadonlySet<string> = new Set(['hand', 'cuff']);

/**
 * Measure one look seated. The result is cached: sixteen looks is sixteen
 * figures built once each over a session, and a ride asks for one of them.
 */
export function seatedFit(key: AvatarSpriteKey): SeatedFit {
  const cached = MEASURED.get(key);
  if (cached) return cached;
  const figure = createAvatarFigure(key);
  try {
    for (let i = 0; i < SETTLE_FRAMES; i += 1) figure.update(25, SEATED);
    const root = figure.object;
    const seat = boxOf(root, (mesh, tag) => mesh === 'avatar-torso' && SEAT_CONTACT.has(tag));
    const torso = boxOf(root, (mesh) => mesh === 'avatar-torso');
    const legs = boxOf(root, (mesh) => mesh.startsWith('avatar-leg'));
    const hands = boxOf(root, (mesh, tag) => mesh.startsWith('avatar-arm') && HANDS.has(tag));
    const head = boxOf(root, (mesh) => mesh === 'avatar-head');
    const whole = boxOf(root, (mesh) => mesh.startsWith('avatar-')) ?? new Box3(new Vector3(), new Vector3());
    // The body's underside is what rests on the board: the hips, or a robe's
    // bell over them. Not the legs, which hang off the front, and not a
    // coat's tail, which hangs behind the board altogether.
    const hipDrop = seat ? seat.min.y : torso ? torso.min.y : 0;
    const fit: SeatedFit = Object.freeze({
      hipDrop,
      footDrop: hipDrop - whole.min.y,
      kneeReach: legs ? legs.max.z : 0,
      backReach: -(torso ? torso.min.z : 0),
      handReach: hands ? hands.max.z : 0,
      handHeight: (hands ? hands.min.y : 0) - hipDrop,
      halfWidth: Math.max(whole.max.x, -whole.min.x),
      headTop: (head ? head.max.y : 0) - hipDrop,
    });
    MEASURED.set(key, fit);
    return fit;
  } finally {
    figure.dispose();
  }
}

/** Forget every measurement. Tests use it; nothing in the game does. */
export function resetSeatedFits(): void {
  MEASURED.clear();
}
