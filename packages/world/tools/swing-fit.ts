import { Box3, Mesh, Vector3, type Object3D } from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS } from '../src/avatar-state.js';
import { avatarPartBoxes, createAvatarFigure } from '../src/three/avatar-figure.js';
import { seatedFit } from '../src/three/avatar-seating.js';
import { SWING_SEAT } from '../src/three/roof-swing.js';
import { SWING_LOOK_MAX_YAW } from '../src/roof-swing.js';
import type { AvatarMotion } from '../src/three/types.js';

/**
 * An offline fit check for the roof swing's seat (D-133, 2026-10-03), in the
 * style of `avatar-clipping.ts`: does every one of the sixteen looks — cosy
 * and battle-dressed — actually sit *on* the swing?
 *
 * The seat is the one `three/roof-swing.ts` builds (`SWING_SEAT`), and the
 * rider is placed exactly as the presenter places it: the figure's origin
 * `seatedFit(look).hipDrop` below the board's top face, so its hips rest on
 * the board. Everything is measured in the seat's own frame, where the
 * board's top is y = 0 and the hanging axis is z = 0 — which is also the
 * frame the rider rides in, since the figure swings with the seat rather
 * than hanging upright beside it.
 *
 * Four things are checked, in every look, in both outfits, looking straight
 * ahead and at each end of the look-around (`headYaw`):
 *
 * - **On the board.** The hips rest on it and the seat's footprint is under
 *   them: nothing sunk into the board and nothing hovering over it.
 * - **Nothing through anything.** No piece of the figure crosses the board,
 *   the backrest, the rail, the foot bar or a hanger. Two exceptions, both
 *   named: cloth (a cloak, a robe's bell, a coat's tail) drapes over a seat
 *   rather than stopping at it, and a weapon or a slung bag is carried, not
 *   seated — neither can be re-posed from here, and both read as they should.
 * - **Hands on something.** The hands come to the grab rail or a hanger,
 *   rather than to air.
 * - **Legs in front.** The knees are over the board's front edge and the feet
 *   hang below it, clear of the foot bar.
 */

/** How far one piece may stand through another before it counts: one pixel, as the clipping check. */
export const FIT_TOLERANCE = 0.011;
/** How far from the board's top the hips may rest and still read as sitting on it. */
export const SEAT_CONTACT_TOLERANCE = 0.02;
/** How near a rod a hand has to come to read as holding on. */
export const HAND_REACH = 0.3;
/** How near the backrest the rider's back has to come to read as sitting back. */
export const BACK_REACH = 0.42;

/** Cloth: it drapes over a seat rather than stopping at its surface. */
const CLOTH: ReadonlySet<string> = new Set([
  'cloak', 'cloak-yoke', 'coat-tail', 'robe', 'scarf', 'mantle', 'mantle-shoulder', 'fur-collar',
]);
/** Carried, not seated: a weapon, a shield and what they are slung in. */
const CARRIED: ReadonlySet<string> = new Set([
  'sword', 'dagger', 'mace', 'hammer', 'staff', 'halberd', 'bow', 'shield', 'sheath', 'quiver', 'satchel',
]);
/** The hip band: what rests on the board. */
const HIPS = 'hips';
/** The hands, and the cuffs around them. */
const HANDS: ReadonlySet<string> = new Set(['hand', 'cuff']);

export type FitCheck = 'seated' | 'intersect' | 'grip' | 'legs' | 'back';

export interface FitFinding {
  readonly key: AvatarSpriteKey;
  readonly pose: string;
  readonly check: FitCheck;
  /** The piece at fault, as `mesh:tag`. */
  readonly piece: string;
  /** The seat part it is wrong about, where there is one. */
  readonly part: string;
  /** How wrong, in world units: how deep through, how far off, how far short. */
  readonly depth: number;
  readonly point: readonly [number, number, number];
}

interface Piece {
  readonly mesh: string;
  readonly tag: string;
  readonly box: Box3;
}

interface Part {
  readonly name: string;
  readonly box: Box3;
}

/** The seat, as boxes in its own frame. */
export function swingSeatBoxes(): Part[] {
  const S = SWING_SEAT;
  const box = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Part => ({
    name,
    box: new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1)),
  });
  const parts: Part[] = [
    box('board', -S.halfWidth, -S.boardThickness, S.boardBack, S.halfWidth, 0, S.boardFront),
    box('backrest', -S.halfWidth, S.backrestLow, S.backrestBack, -S.backrestGap, S.backrestHigh, S.backrestFront),
    box('backrest', S.backrestGap, S.backrestLow, S.backrestBack, S.halfWidth, S.backrestHigh, S.backrestFront),
    box('rail', -S.halfWidth, S.railLow, S.railBack, S.halfWidth, S.railHigh, S.railFront),
    box('foot-bar', -S.halfWidth + 0.14, S.barLow, S.barBack, S.halfWidth - 0.14, S.barHigh, S.barFront),
  ];
  for (const side of [-1, 1]) {
    const x = side * S.hangerX;
    parts.push(box('hanger', x - 0.055, 0, -0.055, x + 0.055, 2.5, 0.055));
    const postX = side * (S.halfWidth - 0.06);
    parts.push(box('post', postX - 0.04, 0, S.backrestBack, postX + 0.04, S.backrestHigh, S.backrestFront));
    parts.push(box('stanchion', postX - 0.04, -S.boardThickness, S.railBack, postX + 0.04, S.railLow, S.boardFront));
  }
  return parts;
}

/** Every piece of a figure as a box in the figure's own frame. */
function piecesOf(root: Object3D): Piece[] {
  const pieces: Piece[] = [];
  const point = new Vector3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (const part of avatarPartBoxes(object.geometry)) {
      const box = new Box3();
      for (let v = part.first * 3; v < (part.first + part.count) * 3; v += 1) {
        box.expandByPoint(point.fromBufferAttribute(position, v).applyMatrix4(object.matrixWorld));
      }
      pieces.push({ mesh: object.name, tag: part.tag, box });
    }
  });
  return pieces;
}

/** How deep two boxes overlap: the smallest of the three axes, 0 if they miss. */
function overlapDepth(a: Box3, b: Box3): number {
  const x = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const y = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const z = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  if (x <= 0 || y <= 0 || z <= 0) return 0;
  return Math.min(x, y, z);
}

/** The gap between two boxes: 0 where they touch or overlap. */
function gapBetween(a: Box3, b: Box3): number {
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.hypot(dx, dy, dz);
}

const label = (piece: Piece): string => `${piece.mesh}:${piece.tag}`;
const at = (box: Box3): readonly [number, number, number] => {
  const centre = box.getCenter(new Vector3());
  return [centre.x, centre.y, centre.z];
};

/** The poses a rider is checked in: straight ahead and at each end of the look. */
export function swingPoses(): Array<{ readonly name: string; readonly headYaw: number }> {
  return [
    { name: 'ahead', headYaw: 0 },
    { name: 'looking left', headYaw: SWING_LOOK_MAX_YAW },
    { name: 'looking right', headYaw: -SWING_LOOK_MAX_YAW },
  ];
}

const SETTLE_FRAMES = 80;

/**
 * A test seam: place the rider this far off its measured height, to prove the
 * check has teeth. Nothing in the game passes it.
 */
export interface FitOptions {
  readonly offsetY?: number;
}

/** How one look sits on the swing, in one head pose. */
function fitOnce(
  key: AvatarSpriteKey,
  pose: string,
  headYaw: number,
  parts: readonly Part[],
  options: FitOptions = {},
): FitFinding[] {
  const fit = seatedFit(key);
  const figure = createAvatarFigure(key);
  const findings: FitFinding[] = [];
  try {
    const motion: AvatarMotion = Object.freeze({ moving: false, sprinting: false, seated: true, headYaw });
    for (let i = 0; i < SETTLE_FRAMES; i += 1) figure.update(25, motion);
    // Placed as the presenter places the rider: hips on the board's top face.
    figure.object.position.set(0, -fit.hipDrop + (options.offsetY ?? 0), 0);
    const pieces = piecesOf(figure.object);
    const hips = pieces.filter((piece) => piece.mesh === 'avatar-torso' && piece.tag === HIPS);
    const board = parts.find((part) => part.name === 'board')!;

    // 1. On the board: resting on its top face, over its footprint.
    const lowest = Math.min(...hips.map((piece) => piece.box.min.y));
    if (Math.abs(lowest) > SEAT_CONTACT_TOLERANCE) {
      findings.push({
        key, pose, check: 'seated', piece: 'avatar-torso:hips', part: 'board',
        depth: Math.abs(lowest), point: at(hips[0]!.box),
      });
    }
    // The plank is under them: the hips' whole width, and the middle of their
    // depth, with the thighs taking the front of it (see `SWING_SEAT.board*`).
    for (const piece of hips) {
      const centre = piece.box.getCenter(new Vector3());
      const over = piece.box.min.x >= board.box.min.x && piece.box.max.x <= board.box.max.x &&
        centre.z >= board.box.min.z && centre.z <= board.box.max.z &&
        piece.box.min.z >= board.box.min.z;
      if (!over) {
        findings.push({
          key, pose, check: 'seated', piece: label(piece), part: 'board',
          depth: Math.max(
            board.box.min.x - piece.box.min.x,
            piece.box.max.x - board.box.max.x,
            board.box.min.z - piece.box.min.z,
            centre.z - board.box.max.z,
          ),
          point: at(piece.box),
        });
      }
    }

    // 2. Nothing through anything, cloth and carried gear aside.
    for (const piece of pieces) {
      if (CLOTH.has(piece.tag) || CARRIED.has(piece.tag)) continue;
      for (const part of parts) {
        // The hips rest *on* the board; that is contact, not a crossing. So
        // do the thighs over its front edge: the figures turn their legs
        // about a point below the hip band, so a leg always lies across the
        // plank it sits on. Every other part of the seat is strict.
        if (part.name === 'board' && (piece.tag === HIPS || piece.mesh.startsWith('avatar-leg'))) continue;
        const depth = overlapDepth(piece.box, part.box);
        if (depth > FIT_TOLERANCE) {
          findings.push({
            key, pose, check: 'intersect', piece: label(piece), part: part.name, depth, point: at(piece.box),
          });
        }
      }
    }

    // 3. Hands on something to hold.
    const hands = pieces.filter((piece) => piece.mesh.startsWith('avatar-arm') && HANDS.has(piece.tag));
    const holds = parts.filter((part) => part.name === 'rail' || part.name === 'hanger' || part.name === 'stanchion');
    for (const hand of hands) {
      const reach = Math.min(...holds.map((part) => gapBetween(hand.box, part.box)));
      if (reach > HAND_REACH) {
        findings.push({
          key, pose, check: 'grip', piece: label(hand), part: 'rail', depth: reach, point: at(hand.box),
        });
      }
    }

    // 4. Back near the backrest, legs out in front and feet hanging below.
    const backrests = parts.filter((part) => part.name === 'backrest');
    const torso = pieces.filter((piece) => piece.mesh === 'avatar-torso' && (piece.tag === HIPS || piece.tag === 'top'));
    const back = Math.min(...torso.flatMap((piece) => backrests.map((part) => gapBetween(piece.box, part.box))));
    if (back > BACK_REACH) {
      findings.push({
        key, pose, check: 'back', piece: 'avatar-torso', part: 'backrest', depth: back, point: at(torso[0]!.box),
      });
    }
    const legs = pieces.filter((piece) => piece.mesh.startsWith('avatar-leg'));
    const knee = Math.max(...legs.map((piece) => piece.box.max.z));
    const sole = Math.min(...legs.map((piece) => piece.box.min.y));
    if (knee < board.box.max.z) {
      findings.push({
        key, pose, check: 'legs', piece: 'avatar-leg', part: 'board', depth: board.box.max.z - knee,
        point: [0, sole, knee],
      });
    }
    if (sole > -SWING_SEAT.boardThickness) {
      findings.push({
        key, pose, check: 'legs', piece: 'avatar-leg', part: 'board', depth: sole, point: [0, sole, knee],
      });
    }
    return findings;
  } finally {
    figure.dispose();
  }
}

/** Every way one look fails to sit on the swing, across the head poses. */
export function findSwingFit(key: AvatarSpriteKey, options: FitOptions = {}): FitFinding[] {
  const parts = swingSeatBoxes();
  return swingPoses().flatMap((pose) => fitOnce(key, pose.name, pose.headYaw, parts, options));
}

/** Every look, cosy and battle-dressed. */
export function findAllSwingFit(): FitFinding[] {
  return AVATAR_SPRITE_KEYS.flatMap((key) => findSwingFit(key));
}

export function formatFit(finding: FitFinding): string {
  const point = finding.point.map((value) => value.toFixed(3)).join(', ');
  return `${finding.key} ${finding.check}: ${finding.piece} / ${finding.part}, ${finding.depth.toFixed(3)} at (${point}) ${finding.pose}`;
}
