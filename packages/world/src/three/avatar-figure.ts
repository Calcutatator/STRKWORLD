import {
  Box3,
  BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS, validateAvatarSprite } from '../avatar-state.js';
import { PLAYER_SPRINT_MULTIPLIER } from '../movement-input.js';
import {
  avatarLook,
  type AvatarBuild,
  type AvatarEars,
  type AvatarFace,
  type AvatarGear,
  type AvatarHair,
  type AvatarLook,
  type AvatarOutfit,
  type AvatarTail,
  type AvatarWeapon,
} from './avatar-looks.js';
import type { AvatarFigure, AvatarMotion } from './types.js';

/**
 * Procedural low-poly chibi avatars (D-059): presentation only.
 *
 * Every body part is one merged, vertex-coloured box geometry, so a figure is
 * seven meshes sharing one material however much detail its look carries
 * (hair, goggles, belts, weapons). Geometry is cached per look and shared by
 * every figure wearing it; `setLook` swaps geometry references on the same
 * meshes, so the caller's `object` keeps its identity.
 *
 * Rig: root (caller-owned position and yaw) > body (uniform build scale) >
 * hips (bob) > legs, and hips > upper body (lean, twist, breath) > torso,
 * head, arms. Legs pivot just below the hip band's hem, arms at the shoulders.
 * The body scales about the feet, which sit on y = 0; the front faces +Z.
 *
 * No part passes through another in any pose: `tools/avatar-clipping.ts`
 * checks every look, using the boxes each part records (`avatarPartBoxes`).
 * Boxes that a limb or the head is meant to sit in are built as sockets.
 */

type Vec3 = readonly [number, number, number];
type Side = -1 | 1;

const TAU = Math.PI * 2;
const SIDES: readonly Side[] = [-1, 1];
const ZERO: Vec3 = [0, 0, 0];

/**
 * No look rises above this in any pose, build scale included (the large horned
 * helm, mid-stride), so a label anchored here clears every head.
 * Per-look standing top: `avatarFigureHeight`.
 */
export const AVATAR_FIGURE_HEIGHT = 1.8;

// Face: chibi eyes sit low and wide, and read at a distance as dark blocks.
const EYE_HEIGHT = 0.4;
const EYE_X = 0.118;
const EYE_WIDTH = 0.08;
const EYE_TALL = 0.115;
const EYE_COLOR = 0x2a1d17;
const EYE_SHINE = 0xfdf6ea;

// Gait. 1.6 strides (3.2 steps) per second is the 2D sheets' five walk
// columns at 8 FPS; at the 160 px/s walk speed a slower cadence reads as
// gliding. Sprint scales with the gameplay speed multiplier, as the sheets'
// 12 FPS did.
const WALK_STRIDES_PER_SECOND = 1.6;
const SPRINT_STRIDES_PER_SECOND = WALK_STRIDES_PER_SECOND * PLAYER_SPRINT_MULTIPLIER;
// Swings in radians: legs ~35/50 degrees, arms ~30/45 degrees.
const LEG_SWING_WALK = 0.61;
const LEG_SWING_SPRINT = 0.87;
const ARM_SWING_WALK = 0.52;
const ARM_SWING_SPRINT = 0.79;
const LEAN_WALK = 0.05;
const LEAN_SPRINT = 0.16;
const BOB_WALK = 0.022;
const BOB_SPRINT = 0.028;
const TORSO_TWIST = 0.08;
/** How much of the body's forward lean the head takes back. */
const HEAD_COUNTER_LEAN = 0.25;
/** A long robe's stride against everyone else's. */
const ROBE_STRIDE = 0.58;
/** Time constant for easing between idle, walk and sprint, so state changes never pop. */
const GAIT_BLEND_SECONDS = 0.1;
/** A stalled tab can deliver seconds in one frame; advance at most this much. */
const MAX_STEP_SECONDS = 0.1;
const BREATH_PER_SECOND = 0.3;
const BREATH_LIFT = 0.008;
const ARM_REST_SPREAD = 0.07;
const ARM_BREATH_SPREAD = 0.02;
const BLINK_PERIOD_SECONDS = 3.7;
const BLINK_SECONDS = 0.12;
/** A held weapon damps its arm's swing; a staff, halberd or shield is carried nearly steady. */
const WEAPON_ARM_SWING = 0.7;
const STEADY_ARM_SWING = 0.35;
const GOLDEN_RATIO_FRACTION = 0.618033988749895;

/** Body proportions per size class, in world units (1 unit = 1 tile). */
interface BuildDims {
  readonly legLength: number;
  readonly legWidth: number;
  readonly legDepth: number;
  readonly legSpacing: number;
  readonly bootHeight: number;
  readonly torsoWidth: number;
  readonly torsoDepth: number;
  readonly torsoHeight: number;
  readonly armLength: number;
  readonly armWidth: number;
  readonly armDepth: number;
  readonly headWidth: number;
  readonly headHeight: number;
  readonly headDepth: number;
  /** Weapons and shields scale with the body. */
  readonly propScale: number;
  /**
   * Uniform scale on the whole figure, on top of the proportions above, so the
   * size classes read at a glance. The sprites' small and large classes stand
   * about 0.8x and 1.25x the standard height; these land the 3D figures there.
   */
  readonly scale: number;
}

const BUILDS: Readonly<Record<AvatarBuild, BuildDims>> = {
  small: {
    legLength: 0.26,
    legWidth: 0.14,
    legDepth: 0.15,
    legSpacing: 0.09,
    bootHeight: 0.09,
    torsoWidth: 0.36,
    torsoDepth: 0.24,
    torsoHeight: 0.28,
    armLength: 0.25,
    armWidth: 0.11,
    armDepth: 0.12,
    headWidth: 0.54,
    headHeight: 0.47,
    headDepth: 0.48,
    propScale: 0.88,
    scale: 0.86,
  },
  standard: {
    legLength: 0.34,
    legWidth: 0.15,
    legDepth: 0.17,
    legSpacing: 0.105,
    bootHeight: 0.1,
    torsoWidth: 0.42,
    torsoDepth: 0.27,
    torsoHeight: 0.36,
    armLength: 0.31,
    armWidth: 0.12,
    armDepth: 0.13,
    headWidth: 0.56,
    headHeight: 0.5,
    headDepth: 0.5,
    propScale: 1,
    scale: 1,
  },
  large: {
    legLength: 0.38,
    legWidth: 0.2,
    legDepth: 0.22,
    legSpacing: 0.15,
    bootHeight: 0.12,
    torsoWidth: 0.64,
    torsoDepth: 0.4,
    torsoHeight: 0.44,
    armLength: 0.37,
    armWidth: 0.17,
    armDepth: 0.19,
    headWidth: 0.58,
    headHeight: 0.52,
    headDepth: 0.52,
    propScale: 1.15,
    scale: 1.14,
  },
};

/**
 * How far the torso's outermost layer stands out beside the arms, beyond the
 * shirt: a coat's shell (and the belt over a closed robe, level with its
 * cuffs) or a full chest plate. The arms hang that much further out, so they
 * swing clear of it.
 */
function torsoFlare(outfit: AvatarOutfit): number {
  const coat = findGear(outfit, 'coat');
  const plate = findGear(outfit, 'breastplate');
  let flare = 0;
  if (coat) flare = outfit.belt && coat.length === 'ankle' ? 0.032 : 0.02;
  if (plate?.coverage === 'full') flare = Math.max(flare, 0.022);
  if (findGear(outfit, 'cloak')) flare = Math.max(flare, 0.005);
  return flare;
}

function shoulderX(d: BuildDims, outfit: AvatarOutfit): number {
  return d.torsoWidth / 2 + torsoFlare(outfit) + d.armWidth / 2 + 0.006;
}

/** Whether a look's pauldrons reach in under the head (the standard build's do). */
function pauldronsUnderHead(d: BuildDims, outfit: AvatarOutfit): boolean {
  if (!findGear(outfit, 'pauldrons')) return false;
  return shoulderX(d, outfit) + 0.01 - (d.armWidth + 0.1) / 2 < d.headWidth / 2 + 0.005;
}

/**
 * How far the shoulder rises above its pivot: below the head, with room for
 * the swing, and lower still under pauldrons that sit low.
 */
function shoulderTop(d: BuildDims, outfit: AvatarOutfit): number {
  return d.armWidth * (pauldronsUnderHead(d, outfit) ? 0.12 : 0.3);
}

function shoulderY(d: BuildDims): number {
  return d.torsoHeight - d.armWidth * 0.45;
}

function headChamfer(d: BuildDims): number {
  return d.headWidth * 0.14;
}

/**
 * How far below the hip line the legs swing from. The hip band (in the torso,
 * which bobs, leans and twists) ends 0.05 below the hip line, and bobs down
 * 0.028 at most; a thigh turning about a point above the band's hem would
 * sweep out through its front and back, so the legs turn about a point below
 * it, and their tops stay up inside the band.
 */
const LEG_PIVOT_DROP = 0.1;
/** How far a leg's top reaches above its pivot, up inside the hip band. */
const LEG_TOP = 0.06;

/** How far the boot toe reaches ahead of the leg axis; the hips lift by it as a leg swings. */
function footReach(d: BuildDims): number {
  return (d.legDepth + 0.06) / 2 + 0.025;
}

function findGear<K extends AvatarGear['kind']>(
  outfit: AvatarOutfit,
  kind: K,
): Extract<AvatarGear, { kind: K }> | undefined {
  return outfit.gear.find((item): item is Extract<AvatarGear, { kind: K }> => item.kind === kind);
}

interface BoxSpec {
  readonly size: Vec3;
  readonly at: Vec3;
  readonly color: number;
  readonly rotation?: Vec3;
  /** Scale of the top face against the bottom, [x, z]; below 1 narrows the top. */
  readonly taper?: readonly [number, number];
  /** Bevel the four vertical edges so heads and buns read round from above. */
  readonly chamfer?: number;
}

function compose(at: Vec3, rotation: Vec3, scale = 1): Matrix4 {
  return new Matrix4().compose(
    new Vector3(at[0], at[1], at[2]),
    new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2])),
    new Vector3(scale, scale, scale),
  );
}

/** Centre and rotation for a panel hung from the middle of its top edge (coat tails, cloaks). */
function hang(attach: Vec3, length: number, rotation: Vec3): { at: Vec3; rotation: Vec3 } {
  const top = new Vector3(0, length / 2, 0).applyEuler(
    new Euler(rotation[0], rotation[1], rotation[2]),
  );
  return { at: [attach[0] - top.x, attach[1] - top.y, attach[2] - top.z], rotation };
}

/** Which moving parts may sit inside a box, and the open faces they leave it through. */
export interface AvatarSocket {
  readonly holds: readonly ('arm' | 'leg' | 'head')[];
  readonly open: readonly ('top' | 'bottom')[];
}

/**
 * One box of a part geometry, for the offline clipping check
 * (`tools/avatar-clipping.ts`). Triangles `first .. first + count - 1` of the
 * geometry are this box. It has no runtime meaning: nothing in the World reads it.
 */
export interface AvatarPartBox {
  /** What the box is: `skin`, `hair` and `headwear` are read by the check; the rest name findings. */
  readonly tag: string;
  readonly socket: AvatarSocket | null;
  readonly first: number;
  readonly count: number;
}

const PART_BOXES = 'avatarPartBoxes';

/** The boxes a part geometry was built from, in order; empty for a geometry this module did not build. */
export function avatarPartBoxes(geometry: BufferGeometry): readonly AvatarPartBox[] {
  const boxes: unknown = geometry.userData[PART_BOXES];
  return Array.isArray(boxes) ? (boxes as AvatarPartBox[]) : [];
}

// Sockets: the joints where a limb or the head is meant to pass into a part.
function socket(holds: AvatarSocket['holds'], open: AvatarSocket['open']): AvatarSocket {
  return Object.freeze({ holds: Object.freeze([...holds]), open: Object.freeze([...open]) });
}
const HIP_SOCKET = socket(['leg'], ['bottom']);
const SHOULDER_SOCKET = socket(['arm'], ['bottom']);
const NECK_SOCKET = socket(['head'], ['top']);
/** A cape over the shoulders: the head sits in its top, the arms leave through its underside. */
const YOKE_SOCKET = socket(['head', 'arm'], ['top', 'bottom']);

/**
 * Accumulates flat-shaded, vertex-coloured boxes into one non-indexed geometry.
 * Faces are split per triangle so each carries its own normal and colour.
 */
class PartBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly stack: Matrix4[] = [new Matrix4()];
  private readonly color = new Color();
  private readonly boxes: AvatarPartBox[] = [];
  private currentTag = 'part';
  private currentSocket: AvatarSocket | null = null;

  /** Name the boxes that follow (and the joint they hold, if any) for the clipping check. */
  tag(tag: string, socket: AvatarSocket | null = null): void {
    this.currentTag = tag;
    this.currentSocket = socket;
  }

  /** Nest the following boxes in a local frame, such as a hand grip or a horn root. */
  push(at: Vec3, rotation: Vec3 = ZERO, scale = 1): void {
    this.stack.push(this.current().clone().multiply(compose(at, rotation, scale)));
  }

  pop(): void {
    if (this.stack.length > 1) this.stack.pop();
  }

  box(spec: BoxSpec): void {
    const [width, height, depth] = spec.size;
    const [topX, topZ] = spec.taper ?? [1, 1];
    const chamfer = Math.max(0, Math.min(spec.chamfer ?? 0, width / 2 - 0.001, depth / 2 - 0.001));
    const outline = chamfer > 0
      ? octagon(width / 2, depth / 2, chamfer)
      : rectangle(width / 2, depth / 2);
    const bottom = outline.map(([x, z]) => new Vector3(x, -height / 2, z));
    const top = outline.map(([x, z]) => new Vector3(x * topX, height / 2, z * topZ));
    const matrix = this.current().clone().multiply(compose(spec.at, spec.rotation ?? ZERO));
    const normalMatrix = new Matrix3().getNormalMatrix(matrix);
    // Hex colours are sRGB; setHex converts to the linear working space vertex colours use.
    this.color.setHex(spec.color);
    const first = this.positions.length / 9;
    const count = outline.length;
    for (let i = 1; i < count - 1; i += 1) {
      this.triangle(bottom[0]!, bottom[i]!, bottom[i + 1]!, matrix, normalMatrix);
      this.triangle(top[0]!, top[i]!, top[i + 1]!, matrix, normalMatrix);
    }
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      this.triangle(bottom[i]!, bottom[j]!, top[j]!, matrix, normalMatrix);
      this.triangle(bottom[i]!, top[j]!, top[i]!, matrix, normalMatrix);
    }
    this.boxes.push(Object.freeze({
      tag: this.currentTag,
      socket: this.currentSocket,
      first,
      count: this.positions.length / 9 - first,
    }));
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData[PART_BOXES] = Object.freeze([...this.boxes]);
    return geometry;
  }

  private current(): Matrix4 {
    return this.stack[this.stack.length - 1]!;
  }

  /** Box vertices are local to the box centre, which lies inside every (convex) box, so outward is away from it. */
  private triangle(
    a: Vector3,
    b: Vector3,
    c: Vector3,
    matrix: Matrix4,
    normalMatrix: Matrix3,
  ): void {
    const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) return;
    let second = b;
    let third = c;
    if (normal.dot(new Vector3().add(a).add(b).add(c)) < 0) {
      second = c;
      third = b;
      normal.negate();
    }
    normal.applyMatrix3(normalMatrix).normalize();
    for (const vertex of [a, second, third]) {
      const point = vertex.clone().applyMatrix4(matrix);
      this.positions.push(point.x, point.y, point.z);
      this.normals.push(normal.x, normal.y, normal.z);
      this.colors.push(this.color.r, this.color.g, this.color.b);
    }
  }
}

function rectangle(halfWidth: number, halfDepth: number): Array<readonly [number, number]> {
  return [
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
    [-halfWidth, halfDepth],
    [-halfWidth, -halfDepth],
  ];
}

function octagon(
  halfWidth: number,
  halfDepth: number,
  chamfer: number,
): Array<readonly [number, number]> {
  return [
    [halfWidth, -halfDepth + chamfer],
    [halfWidth, halfDepth - chamfer],
    [halfWidth - chamfer, halfDepth],
    [-halfWidth + chamfer, halfDepth],
    [-halfWidth, halfDepth - chamfer],
    [-halfWidth, -halfDepth + chamfer],
    [-halfWidth + chamfer, -halfDepth],
    [halfWidth - chamfer, -halfDepth],
  ];
}

// Head: skin block, hair, headwear. Local origin is the chin line, centred.

type HairCover = 'none' | 'hood' | 'helmet';

interface FringeChunk {
  readonly x: number;
  readonly w: number;
  readonly h: number;
  readonly tilt: number;
}

function buildHead(look: AvatarLook, d: BuildDims): BufferGeometry {
  const b = new PartBuilder();
  const { headWidth: width, headHeight: height, headDepth: depth } = d;
  b.tag('skin');
  b.box({
    size: [width, height, depth],
    at: [0, height / 2, 0],
    color: look.character.skin,
    chamfer: headChamfer(d),
  });
  const hood = findGear(look.outfit, 'hood');
  const helmet = findGear(look.outfit, 'hornedHelmet');
  const goggles = findGear(look.outfit, 'goggles');
  const { ears, face } = look.character;
  if (face) addFace(b, face, d);
  addHair(b, look.character.hair, d, helmet ? 'helmet' : hood ? 'hood' : 'none');
  // Ears stand up through the hair; headwear would have to cover them, so none is worn with them.
  if (ears && !hood && !helmet) addEars(b, ears, d);
  if (hood) addHood(b, hood.color, d);
  if (helmet) addHelmet(b, helmet.color, helmet.horn, d);
  if (goggles) addGoggles(b, goggles.frame, goggles.lens, d);
  return b.build();
}

/**
 * Cat ears on the crown, rooted down in the hair and leaning out a little:
 * a tapered fur block, its inner ear a paler panel on the front face. They
 * are part of the head, so they turn and nod with it.
 */
function addEars(b: PartBuilder, ears: AvatarEars, d: BuildDims): void {
  const { headWidth: width, headHeight: height } = d;
  b.tag('ears');
  for (const s of SIDES) {
    b.push([s * width * 0.26, height + 0.005, -0.03], [-0.1, 0, -s * 0.3]);
    b.box({ size: [0.21, 0.22, 0.1], at: [0, 0.085, 0], color: ears.fur, taper: [0.14, 0.4] });
    b.box({ size: [0.13, 0.14, 0.02], at: [0, 0.065, 0.045], color: ears.inner, taper: [0.14, 1] });
    b.pop();
  }
}

/** Blushed cheeks below the eyes and a small cat mouth between them. */
function addFace(b: PartBuilder, face: AvatarFace, d: BuildDims): void {
  const halfDepth = d.headDepth / 2;
  const eyeY = EYE_HEIGHT * d.headHeight;
  b.tag('face');
  for (const s of SIDES) {
    b.box({ size: [0.075, 0.035, 0.012], at: [s * (EYE_X + 0.035), eyeY - 0.085, halfDepth + 0.004], color: face.blush });
    // The mouth's two strokes meet in the middle, like a little w.
    b.box({
      size: [0.034, 0.013, 0.01],
      at: [s * 0.015, eyeY - 0.115, halfDepth + 0.004],
      rotation: [0, 0, s * 0.55],
      color: face.mouth,
    });
  }
}

/** Headwear hides the crown (and a helmet the fringe), so those boxes are left out. */
function addHair(b: PartBuilder, hair: AvatarHair, d: BuildDims, cover: HairCover): void {
  const { headWidth: width, headHeight: height, headDepth: depth } = d;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const chamfer = headChamfer(d);
  const color = hair.color;
  const crown = cover === 'none';
  // Under a helmet the hair stops inside its rim, since the dome above narrows,
  // and keeps clear of the rim's bevelled corners.
  const helmet = cover === 'helmet';
  const ceiling = helmet ? height - HELMET_RIM_DROP : height + 0.01;
  b.tag('hair');

  const cap = (thick: number, over = 0.03, lift = 0.02, z = 0): void => {
    if (!crown) return;
    b.box({
      size: [width + 2 * over, thick, depth + 2 * over],
      at: [0, height - thick / 2 + lift, z],
      color,
      chamfer: chamfer + over * 0.6,
    });
  };
  const back = (length: number, thick = 0.1): void => {
    if (cover === 'hood') return;
    // Under a helmet it ends inside the neck guard, not below it.
    const bottom = Math.max(height + 0.01 - length, helmet ? helmetGuardBottom(d) + 0.01 : -Infinity);
    const top = Math.min(height + 0.01, ceiling);
    if (top <= bottom) return;
    b.box({
      size: [helmet ? width * 0.7 : width + 0.06, top - bottom, thick],
      at: [0, (top + bottom) / 2, -halfDepth - 0.01],
      color,
    });
  };
  const sides = (length: number, sideDepth: number, z = 0, thick = 0.06): void => {
    const bottom = height - length;
    const top = Math.min(height, ceiling);
    if (top <= bottom) return;
    for (const s of SIDES) {
      b.box({
        size: [thick, top - bottom, helmet ? Math.min(sideDepth, depth * 0.55) : sideDepth],
        at: [s * (halfWidth + 0.015), (top + bottom) / 2, z],
        color,
      });
    }
  };
  // A hood's brim comes lower than the hairline, so a fringe under it starts lower too.
  const fringeLift = cover === 'hood' ? 0 : 0.02;
  const fringe = (chunks: readonly FringeChunk[]): void => {
    if (cover === 'helmet') return;
    // Framing the face: the one hair a hood is meant to show.
    b.tag('hair-face');
    for (const chunk of chunks) {
      b.box({
        size: [chunk.w, chunk.h, 0.07],
        at: [chunk.x, height - chunk.h / 2 + fringeLift, halfDepth + 0.02],
        rotation: [0, 0, chunk.tilt],
        color,
      });
    }
    b.tag('hair');
  };
  const spike = (at: Vec3, size: number, tall: number, rotation: Vec3): void => {
    if (!crown) return;
    b.box({ size: [size, tall, size], at, rotation, color, taper: [0.15, 0.15] });
  };

  switch (hair.style) {
    case 'spiky':
      cap(0.13);
      back(0.44);
      sides(0.3, depth * 0.72, -0.04);
      fringe([
        { x: -0.17, w: 0.2, h: 0.17, tilt: 0.28 },
        { x: 0, w: 0.22, h: 0.19, tilt: -0.05 },
        { x: 0.17, w: 0.2, h: 0.15, tilt: -0.3 },
      ]);
      spike([-0.14, height + 0.06, 0.02], 0.15, 0.16, [0.25, 0, 0.5]);
      spike([0.13, height + 0.07, -0.02], 0.15, 0.17, [-0.1, 0, -0.45]);
      spike([0, height + 0.07, -0.12], 0.17, 0.18, [-0.65, 0, 0]);
      spike([0, height - 0.06, -halfDepth - 0.09], 0.15, 0.16, [-1.45, 0, 0]);
      spike([-(halfWidth + 0.05), height - 0.09, -0.04], 0.13, 0.15, [0, 0, 1.15]);
      spike([halfWidth + 0.05, height - 0.09, -0.04], 0.13, 0.15, [0, 0, -1.15]);
      break;
    case 'ponytail':
      cap(0.12);
      back(0.44);
      sides(0.34, depth * 0.72, 0.02);
      fringe([
        { x: -0.14, w: 0.24, h: 0.19, tilt: 0.35 },
        { x: 0.06, w: 0.22, h: 0.17, tilt: 0.22 },
        { x: 0.2, w: 0.14, h: 0.13, tilt: 0.1 },
      ]);
      if (crown) {
        // High on the right (-X) side, sweeping out and down as in the sprite.
        b.box({
          size: [0.13, 0.13, 0.13],
          at: [-(halfWidth - 0.06), height - 0.02, -halfDepth + 0.04],
          color,
          chamfer: 0.03,
        });
        b.box({
          size: [0.17, 0.22, 0.17],
          at: [-(halfWidth + 0.07), height - 0.02, -0.1],
          rotation: [0, 0, 1.55],
          color,
          chamfer: 0.04,
        });
        b.box({
          size: [0.17, 0.34, 0.17],
          at: [-(halfWidth + 0.16), height - 0.22, -0.11],
          rotation: [0, 0, Math.PI - 0.18],
          color,
          taper: [0.3, 0.3],
          chamfer: 0.04,
        });
      }
      break;
    case 'bob':
      cap(0.12);
      back(0.46);
      // Under a hood the sides fill its cheeks, seen only through the face opening.
      if (cover === 'hood') b.tag('hair-face');
      sides(0.36, depth * 0.8, 0.02);
      b.tag('hair');
      fringe([
        { x: -0.15, w: 0.2, h: 0.21, tilt: 0.12 },
        { x: 0.02, w: 0.2, h: 0.23, tilt: -0.05 },
        { x: 0.17, w: 0.18, h: 0.2, tilt: -0.14 },
      ]);
      // Face-framing locks stay visible inside a hood's opening.
      b.tag('hair-face');
      for (const s of SIDES) {
        b.box({
          size: [0.07, 0.3, 0.1],
          at: [s * (halfWidth - 0.03), height - 0.2, halfDepth - 0.01],
          color,
        });
      }
      b.tag('hair');
      break;
    case 'swept':
      cap(0.15, 0.03, 0.04, -0.03);
      back(0.42);
      if (crown) {
        b.box({
          size: [width * 0.7, 0.05, depth * 0.72],
          at: [0, height + 0.06, -0.06],
          color,
          chamfer: 0.08,
        });
      }
      for (const s of SIDES) {
        b.box({
          size: [0.06, 0.26, 0.14],
          at: [s * (halfWidth + 0.01), height * 0.5, halfDepth - 0.12],
          color,
        });
      }
      break;
    case 'long':
      cap(0.12);
      fringe([
        { x: -0.12, w: 0.22, h: 0.18, tilt: 0.28 },
        { x: 0.12, w: 0.22, h: 0.18, tilt: -0.28 },
      ]);
      // Locks end at the jaw; below the head the hair narrows between the arms.
      sides(0.48, depth * 0.55, 0.06, 0.08);
      if (cover !== 'hood') {
        b.box({ size: [width + 0.06, height + 0.01, 0.1], at: [0, (height + 0.01) / 2, -halfDepth - 0.03], color });
        b.box({ size: [width * 0.78, 0.3, 0.1], at: [0, -0.13, -halfDepth - 0.03], color });
        b.box({
          size: [width * 0.8, 0.14, 0.12],
          at: [0, height - 0.76, -halfDepth - 0.04],
          color,
          chamfer: 0.04,
        });
      }
      break;
    case 'buns':
      cap(0.12);
      back(0.4);
      sides(0.28, depth * 0.6, 0);
      fringe([
        { x: -0.16, w: 0.2, h: 0.17, tilt: 0.22 },
        { x: 0, w: 0.2, h: 0.19, tilt: 0 },
        { x: 0.16, w: 0.2, h: 0.16, tilt: -0.22 },
      ]);
      if (crown) {
        for (const s of SIDES) {
          b.box({
            size: [0.23, 0.1, 0.23],
            at: [s * 0.2, height + 0.045, -0.03],
            color,
            chamfer: 0.075,
          });
          b.box({
            size: [0.19, 0.08, 0.19],
            at: [s * 0.2, height + 0.13, -0.03],
            color,
            chamfer: 0.065,
            taper: [0.6, 0.6],
          });
        }
      }
      break;
    case 'mop':
      cap(0.16, 0.05, 0.03);
      back(0.48, 0.12);
      sides(0.36, depth * 0.9, 0, 0.08);
      fringe([{ x: 0, w: width + 0.06, h: 0.17, tilt: 0 }]);
      if (cover !== 'helmet') {
        for (const s of SIDES) {
          b.box({
            size: [0.1, 0.12, 0.08],
            at: [s * (halfWidth - 0.02), height - 0.19, halfDepth + 0.03],
            color,
          });
        }
      }
      break;
    case 'shaggy':
      cap(0.12);
      back(0.46);
      sides(0.34, depth * 0.75, 0);
      for (const s of SIDES) {
        b.box({
          size: [0.07, 0.1, 0.12],
          at: [s * (halfWidth + 0.02), height - 0.4, 0.08],
          rotation: [0, 0, s * 0.3],
          color,
        });
      }
      fringe([
        // The long lock just clips the right eye, as in the sprite.
        { x: -0.1, w: 0.25, h: 0.26, tilt: 0.12 },
        { x: 0.1, w: 0.2, h: 0.18, tilt: -0.2 },
        { x: 0.23, w: 0.12, h: 0.14, tilt: -0.3 },
      ]);
      spike([-0.1, height + 0.05, -0.05], 0.14, 0.14, [-0.3, 0, 0.35]);
      spike([0.12, height + 0.04, -0.1], 0.14, 0.13, [-0.45, 0, -0.35]);
      break;
  }
  if (hair.beard !== undefined) addBeard(b, hair.beard, color, d);
}

/**
 * The back of the beard where it hangs below the chin. It hangs in front of
 * the chest, clear of whatever the torso wears there as the head nods.
 */
function beardBack(d: BuildDims): number {
  return d.headDepth / 2 + 0.005;
}

/** Kept below the eyes so the face stays readable. */
function addBeard(b: PartBuilder, beard: number, brows: number, d: BuildDims): void {
  b.tag('beard');
  const halfWidth = d.headWidth / 2;
  const halfDepth = d.headDepth / 2;
  const eyeY = EYE_HEIGHT * d.headHeight;
  // On the face, from the chin up.
  b.box({
    size: [d.headWidth * 0.8, eyeY - 0.075, 0.12],
    at: [0, (eyeY - 0.075) / 2, halfDepth + 0.02],
    color: beard,
    chamfer: 0.03,
  });
  // Below the chin: the beard proper, then its point, in front of the chest.
  const below = 0.14;
  const thick = 0.085;
  const back = beardBack(d);
  b.box({
    size: [d.headWidth * 0.8, below, thick],
    at: [0, -below / 2 + 0.02, back + thick / 2],
    color: beard,
    chamfer: 0.03,
  });
  b.box({
    size: [d.headWidth * 0.46, 0.11, 0.07],
    at: [0, -below - 0.035, back + 0.04],
    rotation: [0, 0, Math.PI],
    taper: [0.4, 0.8],
    color: beard,
  });
  for (const s of SIDES) {
    // Sideburns end at the jaw, above anything worn at the shoulders.
    b.box({
      size: [0.08, eyeY - 0.02, 0.22],
      at: [s * (halfWidth - 0.01), (eyeY - 0.02) / 2 + 0.06, halfDepth - 0.08],
      color: beard,
    });
    b.box({
      size: [0.13, 0.045, 0.05],
      at: [s * EYE_X, eyeY + 0.09, halfDepth + 0.02],
      color: brows,
    });
  }
  b.box({
    size: [0.32, 0.06, 0.06],
    at: [0, eyeY - 0.1, halfDepth + 0.085],
    color: beard,
    chamfer: 0.015,
  });
}

function addHood(b: PartBuilder, color: number, d: BuildDims): void {
  b.tag('headwear');
  const { headWidth: width, headHeight: height, headDepth: depth } = d;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  b.box({
    size: [width + 0.16, 0.11, depth + 0.13],
    at: [0, height + 0.045, -0.02],
    color,
    chamfer: headChamfer(d) + 0.07,
    taper: [0.86, 0.86],
  });
  b.box({
    size: [width + 0.16, height + 0.06, 0.08],
    at: [0, height / 2 + 0.01, -(halfDepth + 0.075)],
    color,
  });
  b.box({
    size: [width + 0.16, 0.09, 0.1],
    at: [0, height - 0.015, halfDepth + 0.02],
    color,
    chamfer: 0.03,
  });
  for (const s of SIDES) {
    b.box({
      size: [0.07, height + 0.02, depth + 0.1],
      at: [s * (halfWidth + 0.065), height / 2 + 0.02, -0.03],
      color,
    });
    b.box({
      size: [0.05, height * 0.8, 0.09],
      at: [s * (halfWidth + 0.02), height * 0.47, halfDepth + 0.005],
      color,
    });
  }
}

/** How far below the crown a helmet's rim sits; hair under a helmet ends here. */
const HELMET_RIM_DROP = 0.15;

/** The bottom of a helmet's neck guard and cheek guards, in the head's frame. */
function helmetGuardBottom(d: BuildDims): number {
  return d.headHeight * 0.42 - 0.15;
}

/** Open-faced so the eyes stay visible; the nasal guard echoes the sprite's T visor. */
function addHelmet(b: PartBuilder, metal: number, horn: number, d: BuildDims): void {
  b.tag('headwear');
  const { headWidth: width, headHeight: height, headDepth: depth } = d;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const chamfer = headChamfer(d);
  b.box({
    size: [width + 0.12, 0.24, depth + 0.12],
    at: [0, height - 0.03, 0],
    color: metal,
    chamfer: chamfer + 0.06,
    taper: [0.82, 0.82],
  });
  b.box({
    size: [width + 0.15, 0.06, depth + 0.15],
    at: [0, height - HELMET_RIM_DROP, 0],
    color: metal,
    chamfer: chamfer + 0.075,
  });
  b.box({ size: [0.06, 0.2, 0.05], at: [0, height - 0.25, halfDepth + 0.05], color: metal });
  // The neck guard reaches in to the head, closing the gap the hair would show through.
  b.box({
    size: [width + 0.1, 0.3, 0.085],
    at: [0, height * 0.42, -(halfDepth + 0.0325)],
    color: metal,
  });
  // Cheek guards run back to the neck guard, so the sides are closed and no
  // hair shows between them.
  const guardFront = halfDepth + 0.01;
  const guardBack = -(halfDepth + 0.02);
  for (const s of SIDES) {
    // Their inner faces rest on the head, so nothing shows between.
    b.box({
      size: [0.085, 0.3, guardFront - guardBack],
      at: [s * (halfWidth + 0.0275), height * 0.45, (guardFront + guardBack) / 2],
      color: metal,
    });
    b.push([s * (halfWidth + 0.04), height - 0.01, 0], [0, 0, -s * 1.0]);
    b.tag('horn');
    b.box({ size: [0.1, 0.15, 0.1], at: [0, 0.075, 0], color: horn, taper: [0.75, 0.75] });
    b.push([0, 0.14, 0], [0, 0, s * 0.8]);
    b.box({ size: [0.075, 0.12, 0.075], at: [0, 0.06, 0], color: horn, taper: [0.15, 0.15] });
    b.pop();
    b.pop();
    b.tag('headwear');
  }
}

/** Pushed up onto the hairline, strap proud of the hair all round. */
function addGoggles(b: PartBuilder, frame: number, lens: number, d: BuildDims): void {
  b.tag('goggles');
  const { headWidth: width, headHeight: height, headDepth: depth } = d;
  const halfDepth = depth / 2;
  const y = height - 0.05;
  b.box({
    size: [width + 0.1, 0.05, depth + 0.13],
    at: [0, y, 0],
    color: frame,
    chamfer: headChamfer(d) + 0.05,
  });
  for (const s of SIDES) {
    b.box({
      size: [0.15, 0.12, 0.06],
      at: [s * 0.105, y + 0.015, halfDepth + 0.075],
      color: frame,
      chamfer: 0.025,
    });
    b.box({ size: [0.11, 0.08, 0.02], at: [s * 0.105, y + 0.015, halfDepth + 0.11], color: lens });
  }
}

function buildEyes(): BufferGeometry {
  const b = new PartBuilder();
  b.tag('eyes');
  for (const s of SIDES) {
    b.box({ size: [EYE_WIDTH, EYE_TALL, 0.03], at: [s * EYE_X, 0, 0], color: EYE_COLOR });
    // The sun is high in the south-west, so both highlights sit up and to screen-left.
    b.box({ size: [0.026, 0.034, 0.012], at: [s * EYE_X - 0.014, 0.024, 0.019], color: EYE_SHINE });
  }
  return b.build();
}

// Torso: local origin is the hip line, centred. Coat tails and cloaks hang below it.

function buildTorso(look: AvatarLook, d: BuildDims): BufferGeometry {
  const b = new PartBuilder();
  const { outfit } = look;
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  const coat = findGear(outfit, 'coat');
  // Straps and plates sit on whatever the outermost layer is.
  const surfaceDepth = coat ? torsoDepth + 0.04 : torsoDepth;
  // The hip band: the legs' tops sit in it and leave through its underside.
  b.tag('hips', HIP_SOCKET);
  b.box({
    // As deep as the shirt, so a thigh at full sprint stays inside it.
    size: [torsoWidth - 0.02, 0.13, torsoDepth],
    at: [0, 0.015, 0],
    color: outfit.trousers,
    chamfer: 0.02,
  });
  b.tag('top');
  b.box({
    size: [torsoWidth, torsoHeight - 0.06, torsoDepth],
    at: [0, 0.06 + (torsoHeight - 0.06) / 2, 0],
    color: outfit.top,
    chamfer: 0.03,
  });
  if (coat) addCoat(b, coat, outfit.top, d);
  if (outfit.belt) addBelt(b, outfit.belt.color, outfit.belt.buckle, coat, d);
  if (look.character.tail) addTail(b, look.character.tail, d);
  for (const item of outfit.gear) {
    switch (item.kind) {
      case 'scarf':
        addScarf(b, item.color, d);
        break;
      case 'harness':
        addHarness(b, item.color, item.buckle, surfaceDepth, d);
        break;
      case 'satchel':
        addSatchel(b, item.color, surfaceDepth, d);
        break;
      case 'mantle':
        addMantle(b, item.color, outfit, d);
        break;
      case 'furCollar': {
        // The head sits a little into it. A beard hangs in front of it, so
        // under a beard its front stops behind the beard.
        const back = -(torsoDepth / 2 + 0.09);
        const front = look.character.hair.beard === undefined
          ? torsoDepth / 2 + 0.07
          : Math.min(torsoDepth / 2 + 0.07, beardBack(d) - 0.02);
        // Bearded, it sits below the chin entirely, so the beard covers its front.
        const collarTop = look.character.hair.beard === undefined ? torsoHeight + 0.02 : torsoHeight - 0.03;
        b.tag('fur-collar', NECK_SOCKET);
        b.box({
          size: [torsoWidth * 0.94, 0.15, front - back],
          at: [0, collarTop - 0.075, (front + back) / 2],
          color: item.color,
          chamfer: 0.06,
        });
        break;
      }
      case 'cloak':
        addCloak(b, item.color, outfit, d);
        break;
      case 'collar':
        addCollar(b, item.color, d);
        break;
      case 'quiver':
        addQuiver(b, item.color, item.fletching, outfit, d);
        break;
      case 'sheath':
        addSheath(b, item.color, item.hilt, d);
        break;
      case 'pauldrons':
      {
        // Caps over the arm tops. Where they reach in under the head they sit
        // lower and flatter, below its chin as it nods.
        const low = pauldronsUnderHead(d, outfit);
        b.tag('pauldron', YOKE_SOCKET);
        for (const s of SIDES) {
          b.box({
            size: [d.armWidth + 0.1, low ? 0.08 : 0.1, d.armDepth + (low ? 0.14 : 0.12)],
            at: [s * (shoulderX(d, outfit) + 0.01), torsoHeight - (low ? 0.06 : 0.03), 0],
            rotation: [0, 0, -s * (low ? 0.1 : 0.28)],
            color: item.color,
            chamfer: 0.03,
          });
        }
        break;
      }
      case 'breastplate':
        addBreastplate(b, item.color, item.trim, item.coverage, surfaceDepth, d);
        break;
      default:
        // Head, arm and leg gear is built with those parts.
        break;
    }
  }
  return b.build();
}

type CoatGear = Extract<AvatarGear, { kind: 'coat' }>;

function coatOpening(coat: CoatGear, d: BuildDims): number {
  return d.torsoWidth * (coat.length === 'ankle' ? 0.26 : 0.36);
}

function addCoat(b: PartBuilder, coat: CoatGear, inner: number, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight, legLength } = d;
  const shellWidth = torsoWidth + 0.04;
  const shellDepth = torsoDepth + 0.04;
  b.tag('coat');
  b.box({
    size: [shellWidth, torsoHeight - 0.03, shellDepth],
    at: [0, 0.03 + (torsoHeight - 0.03) / 2, 0],
    color: coat.color,
    chamfer: 0.035,
  });
  // The open front shows the garment underneath, framed by trim.
  const opening = coatOpening(coat, d);
  const openingHeight = torsoHeight - 0.07;
  b.box({
    size: [opening, openingHeight, 0.02],
    at: [0, 0.035 + openingHeight / 2, shellDepth / 2 - 0.004],
    color: inner,
  });
  for (const s of SIDES) {
    b.box({
      size: [0.04, torsoHeight - 0.05, 0.028],
      at: [s * (opening / 2 + 0.02), 0.03 + (torsoHeight - 0.05) / 2, shellDepth / 2 + 0.002],
      color: coat.trim,
    });
  }
  if (coat.length === 'ankle') {
    // A closed bell that flares enough to hold the stride; the boots show below the hem.
    // The hem clears the ground by enough to survive the sprint lean, bob and hip drop.
    const top = 0.03;
    const length = top + legLength - 0.11;
    const bottomWidth = torsoWidth + 0.16;
    const bottomDepth = torsoDepth + 0.34;
    // A bell the legs stride inside, leaving through its open hem.
    b.tag('robe', HIP_SOCKET);
    b.box({
      size: [bottomWidth, length, bottomDepth],
      at: [0, top - length / 2, 0],
      color: coat.color,
      taper: [shellWidth / bottomWidth, shellDepth / bottomDepth],
    });
    b.box({
      size: [bottomWidth + 0.012, 0.045, bottomDepth + 0.012],
      at: [0, top - length + 0.0225, 0],
      color: coat.trim,
    });
    return;
  }
  // Knee and long coats: back and side tails only, so the legs stride through
  // the open front. A long coat's tails reach the calf, so they hang further
  // back and out, clear of the heels and hands at a sprint.
  b.tag('coat-tail');
  const long = coat.length === 'long';
  const length = legLength * (long ? COAT_LONG_TAIL : 0.55);
  b.box({
    size: [shellWidth, length, 0.04],
    color: coat.color,
    ...hang([0, 0.03, -shellDepth / 2 + 0.02], length, [long ? COAT_LONG_BACK_TILT : 0.35, 0, 0]),
  });
  for (const s of SIDES) {
    b.box({
      size: [0.04, length, shellDepth - 0.02],
      color: coat.color,
      ...hang([s * (shellWidth / 2 - 0.02), 0.03, 0], length, [0, 0, s * (long ? COAT_LONG_SIDE_FLARE : 0.12)]),
    });
  }
  if (long) {
    // A trim band across the back tail's hem.
    b.box({
      size: [shellWidth + 0.01, 0.035, 0.05],
      color: coat.trim,
      ...hang([0, 0.03, -shellDepth / 2 + 0.02], length * 2 - 0.035, [COAT_LONG_BACK_TILT, 0, 0]),
    });
  }
}

/** A long coat's tails, against the leg's length, and how far they hang back and out. */
const COAT_LONG_TAIL = 0.8;
const COAT_LONG_BACK_TILT = 0.55;
const COAT_LONG_SIDE_FLARE = 0.16;

function addBelt(
  b: PartBuilder,
  color: number,
  buckle: number,
  coat: CoatGear | undefined,
  d: BuildDims,
): void {
  const { torsoWidth, torsoDepth } = d;
  b.tag('belt');
  const y = 0.075;
  if (coat && coat.length !== 'ankle') {
    // Worn under an open coat: only the front opening shows it.
    const z = (torsoDepth + 0.04) / 2;
    b.box({ size: [coatOpening(coat, d), 0.06, 0.024], at: [0, y, z + 0.003], color });
    b.box({ size: [0.07, 0.06, 0.02], at: [0, y, z + 0.018], color: buckle });
    return;
  }
  const width = torsoWidth + (coat ? 0.04 : 0) + 0.025;
  const depth = torsoDepth + (coat ? 0.04 : 0) + 0.025;
  b.box({ size: [width, 0.06, depth], at: [0, y, 0], color, chamfer: 0.035 });
  b.box({ size: [0.08, 0.066, 0.02], at: [0, y, depth / 2 + 0.008], color: buckle });
}

/** A thick cowl under the chin (the chibi head hides any neck) with a knot and two tails. */
function addScarf(b: PartBuilder, color: number, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  // No wider than the shirt, so the arms swing clear of it.
  b.tag('scarf', NECK_SOCKET);
  b.box({
    size: [torsoWidth + 0.004, 0.11, torsoDepth + 0.1],
    at: [0, torsoHeight - 0.03, 0.005],
    color,
    chamfer: 0.045,
  });
  b.tag('scarf');
  b.box({
    size: [0.12, 0.1, 0.06],
    at: [torsoWidth * 0.16, torsoHeight - 0.07, torsoDepth / 2 + 0.055],
    color,
    chamfer: 0.02,
  });
  b.box({
    size: [0.1, 0.24, 0.035],
    color,
    ...hang([torsoWidth * 0.2, torsoHeight - 0.09, torsoDepth / 2 + 0.06], 0.24, [0, 0, 0.22]),
  });
  b.box({
    size: [0.1, 0.22, 0.035],
    color,
    ...hang([torsoWidth * 0.18, torsoHeight - 0.03, -(torsoDepth / 2 + 0.05)], 0.22, [0.6, 0, 0.15]),
  });
}

function addHarness(
  b: PartBuilder,
  color: number,
  buckle: number,
  surfaceDepth: number,
  d: BuildDims,
): void {
  const { torsoHeight } = d;
  b.tag('harness');
  const z = surfaceDepth / 2 + 0.011;
  for (const s of SIDES) {
    // Offset in depth so the crossing straps never share a plane.
    b.box({
      size: [0.05, torsoHeight * 1.02, 0.02],
      at: [0, torsoHeight * 0.54, z + (s > 0 ? 0.004 : 0)],
      rotation: [0, 0, s * 0.5],
      color,
    });
  }
  b.box({ size: [0.075, 0.075, 0.02], at: [0, torsoHeight * 0.54, z + 0.016], color: buckle });
}

/**
 * A tail from the small of the back, above the belt line the thighs swing
 * below: out and down, then curling up behind, its last block the paler tip.
 * It rides with the torso, so it leans and turns with the body.
 */
function addTail(b: PartBuilder, tail: AvatarTail, d: BuildDims): void {
  b.tag('tail');
  // Each segment runs along its frame's +Y; a frame's x turn bends the next.
  const segments: ReadonlyArray<readonly [number, number, number, number]> = [
    // length, width, bend from the previous direction, colour
    [0.12, 0.085, -1.8, tail.fur],
    [0.12, 0.09, 0.6, tail.fur],
    [0.11, 0.095, 0.6, tail.fur],
    [0.1, 0.11, 0.5, tail.tip],
  ];
  b.push([0, 0.1, -d.torsoDepth / 2 + 0.03]);
  for (const [length, width, bend, color] of segments) {
    b.push(ZERO, [bend, 0, 0]);
    b.box({ size: [width, length + 0.03, width], at: [0, length / 2, 0], color, chamfer: 0.015 });
    b.push([0, length, 0]);
  }
  for (let i = 0; i < segments.length * 2 + 1; i += 1) b.pop();
}

/** Strap from the right shoulder to a pouch on the left hip. */
function addSatchel(b: PartBuilder, color: number, surfaceDepth: number, d: BuildDims): void {
  const { torsoWidth, torsoHeight } = d;
  b.tag('satchel');
  for (const z of [surfaceDepth / 2 + 0.008, -(surfaceDepth / 2 + 0.008)]) {
    b.box({
      size: [0.045, torsoHeight * 1.14, 0.02],
      at: [0, torsoHeight * 0.5, z],
      rotation: [0, 0, 0.55],
      color,
    });
  }
  // On the hip, above the thigh's swing.
  b.box({
    size: [torsoWidth * 0.36, 0.13, 0.07],
    at: [torsoWidth * 0.24, 0.06, surfaceDepth / 2 + 0.03],
    color,
    chamfer: 0.02,
  });
}

/** Puffed shoulders that swallow the arm tops, plus the hood's drape down the back. */
function addMantle(b: PartBuilder, color: number, outfit: AvatarOutfit, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  b.tag('mantle', YOKE_SOCKET);
  b.box({
    size: [torsoWidth + 0.2, 0.15, torsoDepth + 0.1],
    at: [0, torsoHeight - 0.035, 0],
    color,
    chamfer: 0.06,
    taper: [0.8, 0.88],
  });
  b.tag('mantle-shoulder', YOKE_SOCKET);
  for (const s of SIDES) {
    // Round the shoulder joint only, deep enough for the arm's swing.
    b.box({
      size: [d.armWidth + 0.12, 0.105, d.armDepth + 0.18],
      at: [s * shoulderX(d, outfit), shoulderY(d) - 0.0075, 0],
      color,
      chamfer: 0.05,
    });
  }
  // The drape down the back stays between the arms, which swing past it.
  b.tag('mantle');
  b.box({
    size: [torsoWidth - 0.02, torsoHeight * 0.7, 0.06],
    at: [0, torsoHeight * 0.6, -(torsoDepth / 2 + 0.035)],
    color,
  });
}

/** Tilted back and flared so swinging arms and legs stay in front of it. */
function addCloak(b: PartBuilder, color: number, outfit: AvatarOutfit, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight, legLength } = d;
  // The yoke round the neck stays inside the arms' inner faces.
  b.tag('cloak-yoke', NECK_SOCKET);
  b.box({
    size: [torsoWidth + 2 * torsoFlare(outfit), 0.08, torsoDepth + 0.1],
    // Below the chin, as the head nods.
    at: [0, torsoHeight - 0.07, 0],
    color,
    chamfer: 0.04,
  });
  b.tag('cloak');
  const length = torsoHeight + legLength - 0.16;
  const width = torsoWidth + 0.24;
  b.box({
    size: [width, length, 0.05],
    color,
    taper: [(torsoWidth + 0.08) / width, 1],
    // Steep enough that a hand or heel swinging back at a sprint stays in front of it.
    ...hang([0, torsoHeight - 0.03, -(torsoDepth / 2 + 0.07)], length, [0.36, 0, 0]),
  });
}

/**
 * A standing collar: like the fur collar, the head sits a little into its top,
 * but it is cloth, crisper at the corners.
 */
function addCollar(b: PartBuilder, color: number, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  const back = -(torsoDepth / 2 + 0.08);
  const front = torsoDepth / 2 + 0.06;
  b.tag('collar', NECK_SOCKET);
  b.box({
    size: [torsoWidth * 0.92, 0.15, front - back],
    at: [0, torsoHeight + 0.02 - 0.075, (front + back) / 2],
    color,
    chamfer: 0.045,
  });
}

/**
 * A quiver slung across the back, its fletching below the head's overhang and
 * between the arms, behind a mantle's drape if one is worn.
 */
function addQuiver(b: PartBuilder, color: number, fletching: number, outfit: AvatarOutfit, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  const behind = findGear(outfit, 'mantle') ? 0.07 : 0.01;
  const tube = torsoHeight * 0.66;
  b.tag('quiver');
  b.push([torsoWidth * 0.08, torsoHeight * 0.4, -(torsoDepth / 2 + behind + 0.05)], [0, 0, 0.5]);
  b.box({ size: [0.11, tube, 0.09], at: [0, 0, 0], color });
  b.box({ size: [0.13, 0.035, 0.11], at: [0, tube / 2 - 0.01, 0], color: fletching });
  b.box({ size: [0.085, 0.06, 0.06], at: [0, tube / 2 + 0.035, 0], color: fletching, taper: [0.7, 0.4] });
  b.pop();
}

/**
 * A scabbarded sword on the left hip, hung from the belt and angled steeply
 * back, so the thigh swings in front of it and the heel below it.
 */
function addSheath(b: PartBuilder, color: number, hilt: number, d: BuildDims): void {
  const { torsoWidth, torsoDepth } = d;
  b.tag('sheath');
  b.push([torsoWidth * 0.36, 0.08, -(torsoDepth / 2 + 0.02)], [SHEATH_TILT, 0, 0]);
  const length = 0.36;
  b.box({ size: [0.05, length, 0.035], at: [0, -length / 2, 0], color });
  b.box({ size: [0.06, 0.04, 0.045], at: [0, -length + 0.02, 0], color: hilt });
  // The hilt rises forward out of the scabbard's mouth, into the hip.
  b.box({ size: [0.11, 0.03, 0.05], at: [0, 0.01, 0], color: hilt });
  b.box({ size: [0.04, 0.1, 0.04], at: [0, 0.07, 0], color: hilt });
  b.pop();
}

/** How far the sheath leans back from upright. */
const SHEATH_TILT = 0.95;

function addBreastplate(
  b: PartBuilder,
  color: number,
  trim: number,
  coverage: 'full' | 'upper',
  surfaceDepth: number,
  d: BuildDims,
): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  b.tag('breastplate');
  if (coverage === 'full') {
    const height = torsoHeight * 0.66;
    const y = torsoHeight - 0.02 - height / 2;
    b.box({
      size: [torsoWidth + 0.035, height, torsoDepth + 0.035],
      at: [0, y, 0],
      color,
      chamfer: 0.035,
    });
    b.box({
      size: [torsoWidth + 0.045, 0.035, torsoDepth + 0.045],
      at: [0, y - height / 2 + 0.0175, 0],
      color: trim,
      chamfer: 0.04,
    });
    b.box({
      size: [0.04, height - 0.04, 0.02],
      at: [0, y, (torsoDepth + 0.035) / 2 + 0.006],
      color: trim,
    });
    return;
  }
  const height = torsoHeight * 0.42;
  const y = torsoHeight * 0.66;
  const z = surfaceDepth / 2 + 0.024;
  b.box({ size: [torsoWidth * 0.46, height, 0.035], at: [0, y, z], color, chamfer: 0.012 });
  b.box({
    size: [torsoWidth * 0.26, height * 0.6, 0.02],
    at: [0, y + height * 0.1, z + 0.02],
    color: trim,
    chamfer: 0.008,
  });
}

// Arms: local origin is the shoulder pivot; the arm hangs along -Y.

function buildArm(look: AvatarLook, d: BuildDims, side: Side): BufferGeometry {
  const b = new PartBuilder();
  const { outfit, character } = look;
  const { armLength, armWidth, armDepth } = d;
  const gloved = outfit.gloves !== null;
  const lower = armLength * (gloved ? 0.45 : 0.28);
  const upper = armLength - lower;
  const sleeve = outfit.sleeves ?? character.skin;
  b.tag('arm');
  b.box({
    size: [armWidth, upper, armDepth],
    at: [0, -upper / 2, 0],
    color: sleeve,
    chamfer: 0.015,
  });
  // A shoulder that narrows front to back, so its corners stay under the
  // head's overhang however far the arm swings.
  const top = shoulderTop(d, outfit);
  b.box({
    size: [armWidth, top + 0.02, armDepth],
    at: [0, (top - 0.02) / 2, 0],
    color: sleeve,
    chamfer: 0.015,
    taper: [0.9, 0.5],
  });
  const handScale = gloved ? 1.06 : 0.92;
  // Fingerless gloves stop short of the fist's end, where the fingers show.
  const fingers = gloved && findGear(outfit, 'fingerless') ? FINGERS : 0;
  b.tag('hand');
  b.box({
    size: [armWidth * handScale, lower - fingers, armDepth * handScale],
    at: [0, -upper - (lower - fingers) / 2, 0],
    color: outfit.gloves ?? character.skin,
    chamfer: 0.015,
  });
  if (fingers > 0) {
    b.box({
      size: [armWidth * 0.94, fingers, armDepth * 0.94],
      at: [0, -armLength + fingers / 2, 0],
      color: character.skin,
    });
  }
  const coat = findGear(outfit, 'coat');
  if (coat) {
    b.tag('cuff');
    b.box({
      size: [armWidth + 0.03, 0.05, armDepth + 0.03],
      at: [0, -upper + 0.02, 0],
      color: coat.trim,
      chamfer: 0.015,
    });
  }
  if (side === 1) {
    const shield = findGear(outfit, 'shield');
    if (shield) addShield(b, shield, d);
  } else if (outfit.weapon) {
    addWeapon(b, outfit.weapon, [0, -armLength + 0.06, 0], d);
  }
  return b.build();
}

/** How much of a fingerless glove's fist is bare fingers. */
const FINGERS = 0.05;

/** Carried facing forward in front of the left forearm, clear of the chest plate. */
function addShield(
  b: PartBuilder,
  shield: Extract<AvatarGear, { kind: 'shield' }>,
  d: BuildDims,
): void {
  b.push([0.08, -d.armLength * 0.68, d.torsoDepth / 2 + 0.085], ZERO, d.propScale);
  b.tag('shield');
  b.box({ size: [0.36, 0.42, 0.04], at: [0, 0.03, 0], color: shield.rim, chamfer: 0.04 });
  b.box({
    size: [0.24, 0.16, 0.04],
    at: [0, -0.26, 0],
    rotation: [0, 0, Math.PI],
    taper: [0.12, 1],
    color: shield.rim,
  });
  b.box({ size: [0.3, 0.36, 0.03], at: [0, 0.03, 0.012], color: shield.face, chamfer: 0.032 });
  b.box({
    size: [0.19, 0.12, 0.03],
    at: [0, -0.22, 0.012],
    rotation: [0, 0, Math.PI],
    taper: [0.12, 1],
    color: shield.face,
  });
  b.box({ size: [0.045, 0.34, 0.02], at: [0, -0.01, 0.03], color: shield.emblem });
  b.box({ size: [0.22, 0.045, 0.02], at: [0, 0.07, 0.03], color: shield.emblem });
  b.pop();
}

/** Built in a frame at the fist; tips lean out to -X, away from the body. */
function addWeapon(b: PartBuilder, weapon: AvatarWeapon, grip: Vec3, d: BuildDims): void {
  const scale = d.propScale;
  b.tag(weapon.kind);
  switch (weapon.kind) {
    case 'sword':
      b.push(grip, [-0.5, 0, -0.7], scale);
      // The grip and pommel stay inside the fist, clear of the hip.
      b.box({ size: [0.045, 0.1, 0.045], at: [0, -0.005, 0], color: weapon.hilt });
      b.box({ size: [0.065, 0.05, 0.065], at: [0, 0.05, 0], color: weapon.hilt, chamfer: 0.015 });
      b.box({ size: [0.12, 0.04, 0.065], at: [0, -0.07, 0], color: weapon.hilt });
      b.box({ size: [0.075, 0.36, 0.022], at: [0, -0.27, 0], color: weapon.blade });
      b.box({
        size: [0.075, 0.08, 0.022],
        at: [0, -0.49, 0],
        rotation: [0, 0, Math.PI],
        taper: [0.12, 1],
        color: weapon.blade,
      });
      b.pop();
      break;
    case 'wrench':
      b.push(grip, [0.3, 0, 0.5], scale * (weapon.size === 'giant' ? 1.55 : 1));
      b.box({ size: [0.05, 0.4, 0.05], at: [0, 0.13, 0], color: weapon.handle, chamfer: 0.01 });
      b.box({ size: [0.17, 0.08, 0.06], at: [0, 0.36, 0], color: weapon.head });
      for (const x of [-0.055, 0.055]) {
        b.box({ size: [0.05, 0.1, 0.06], at: [x, 0.44, 0], color: weapon.head });
      }
      b.pop();
      break;
    case 'crossbow':
      // Limbs near upright, the top one leaning out, so neither reaches in over
      // the hip, thigh or shoulder; carried short so a forward swing keeps it
      // below the chin.
      b.push(grip, [0, 0, Math.PI / 2 + 0.45], scale);
      b.box({ size: [0.06, 0.065, 0.38], at: [0, 0, 0.04], color: weapon.stock, chamfer: 0.012 });
      b.box({ size: [0.32, 0.04, 0.05], at: [0, 0.015, 0.2], color: weapon.limbs });
      for (const s of SIDES) {
        b.box({
          size: [0.09, 0.04, 0.05],
          at: [s * 0.18, 0.015, 0.175],
          rotation: [0, s * 0.785, 0],
          color: weapon.limbs,
        });
      }
      b.box({ size: [0.3, 0.014, 0.014], at: [0, 0.03, 0.13], color: weapon.string });
      b.pop();
      break;
    case 'mace':
      b.push(grip, [0.45, 0, 0.75], scale);
      b.box({ size: [0.06, 0.44, 0.06], at: [0, 0.14, 0], color: weapon.handle, chamfer: 0.012 });
      b.box({ size: [0.17, 0.17, 0.17], at: [0, 0.42, 0], color: weapon.head, chamfer: 0.05 });
      b.box({ size: [0.25, 0.06, 0.06], at: [0, 0.42, 0], color: weapon.head });
      b.box({ size: [0.06, 0.06, 0.25], at: [0, 0.42, 0], color: weapon.head });
      b.box({ size: [0.06, 0.08, 0.06], at: [0, 0.54, 0], color: weapon.head, taper: [0.2, 0.2] });
      b.pop();
      break;
    case 'staff': {
      // Held low on the shaft, so its foot stays clear of a robe's flare.
      b.push(grip, [0.08, 0, 0.24], scale);
      b.box({ size: [0.05, 1.02, 0.05], at: [0, 0.33, 0], color: weapon.shaft, chamfer: 0.01 });
      const ringY = 0.9;
      const radius = 0.09;
      const bar = 0.035;
      for (const y of [ringY + radius, ringY - radius]) {
        b.box({ size: [2 * radius + bar, bar, 0.045], at: [0, y, 0], color: weapon.ring });
      }
      for (const x of [-radius, radius]) {
        b.box({ size: [bar, 2 * radius - bar, 0.045], at: [x, ringY, 0], color: weapon.ring });
      }
      b.box({ size: [0.11, 0.11, 0.11], at: [0, ringY, 0], color: weapon.orb, chamfer: 0.03 });
      b.pop();
      break;
    }
    case 'dagger':
      // Held like the sword, point down and leaning out, half its length.
      b.push(grip, [-0.5, 0, -0.7], scale);
      b.box({ size: [0.04, 0.09, 0.04], at: [0, -0.005, 0], color: weapon.hilt });
      b.box({ size: [0.11, 0.03, 0.05], at: [0, -0.06, 0], color: weapon.hilt });
      b.box({ size: [0.06, 0.17, 0.02], at: [0, -0.16, 0], color: weapon.blade });
      b.box({
        size: [0.06, 0.07, 0.02],
        at: [0, -0.28, 0],
        rotation: [0, 0, Math.PI],
        taper: [0.12, 1],
        color: weapon.blade,
      });
      b.pop();
      break;
    case 'bow': {
      // Upright at the side, its limbs bending out away from the body and the
      // string on the inside, short enough that the lower tip clears the ground.
      b.push(grip, [0, 0, 0], scale);
      b.box({ size: [0.05, 0.13, 0.05], at: [0, 0, 0], color: weapon.grip });
      for (const s of SIDES) {
        const limb = 0.22;
        const bend = 0.32;
        b.push([0, s * 0.055, 0], [0, 0, s * bend]);
        b.box({ size: [0.05, limb, 0.045], at: [0, s * limb / 2, 0], color: weapon.wood });
        b.box({
          size: [0.04, 0.06, 0.04],
          at: [0.008, s * (limb + 0.02), 0],
          rotation: [0, 0, -s * 0.5],
          color: weapon.wood,
        });
        b.pop();
      }
      const reach = 0.055 + 0.22 * Math.cos(0.32) + 0.04;
      b.box({ size: [0.012, 2 * reach, 0.012], at: [0.02, 0, 0], color: weapon.string });
      b.pop();
      break;
    }
    case 'hammer':
      // A two-handed war hammer carried in one fist, head up and leaning out.
      // Leaning well out, so the haft clears a pauldron as the arm swings.
      b.push(grip, [0.2, 0, 0.9], scale * 1.15);
      b.box({ size: [0.05, 0.62, 0.05], at: [0, 0.2, 0], color: weapon.handle, chamfer: 0.01 });
      b.box({ size: [0.24, 0.12, 0.12], at: [0, 0.56, 0], color: weapon.head });
      for (const x of [-0.13, 0.13]) {
        b.box({ size: [0.03, 0.14, 0.14], at: [x, 0.56, 0], color: weapon.face });
      }
      b.pop();
      break;
    case 'halberd':
      b.push(grip, [0.08, 0, 0.25], scale);
      b.box({ size: [0.055, 1.02, 0.055], at: [0, 0.21, 0], color: weapon.shaft, chamfer: 0.012 });
      b.box({ size: [0.2, 0.22, 0.03], at: [-0.12, 0.58, 0], color: weapon.blade });
      b.box({
        size: [0.07, 0.32, 0.03],
        at: [-0.235, 0.58, 0],
        color: weapon.blade,
        chamfer: 0.012,
      });
      b.box({
        size: [0.05, 0.12, 0.03],
        at: [0.08, 0.6, 0],
        rotation: [0, 0, -Math.PI / 2],
        taper: [0.15, 1],
        color: weapon.blade,
      });
      b.box({ size: [0.055, 0.14, 0.055], at: [0, 0.77, 0], color: weapon.blade, taper: [0.15, 0.15] });
      b.pop();
      break;
  }
}

// Legs: local origin is the swing pivot, LEG_PIVOT_DROP below the hip line; the
// boot sole is at y = -(legLength - LEG_PIVOT_DROP).

function buildLeg(look: AvatarLook, d: BuildDims): BufferGeometry {
  const b = new PartBuilder();
  const { outfit } = look;
  const { legWidth, legDepth, bootHeight } = d;
  const legLength = d.legLength - LEG_PIVOT_DROP;
  const trouser = legLength - bootHeight + LEG_TOP;
  b.tag('leg');
  b.box({
    size: [legWidth, trouser, legDepth],
    at: [0, LEG_TOP - trouser / 2, 0],
    color: outfit.trousers,
    chamfer: 0.015,
  });
  b.tag('boot');
  b.box({
    size: [legWidth + 0.025, bootHeight, legDepth + 0.06],
    at: [0, -legLength + bootHeight / 2, 0.025],
    color: outfit.boots,
    chamfer: 0.02,
  });
  const greaves = findGear(outfit, 'greaves');
  if (greaves) {
    // Over the shin from the boot to below the knee, with a knee cop in front.
    const shin = legLength - bootHeight - 0.02;
    // Low enough that a thigh swung forward at a sprint keeps it below the hip band.
    const height = shin * 0.48;
    b.tag('greave');
    b.box({
      size: [legWidth + 0.026, height, legDepth + 0.026],
      at: [0, -legLength + bootHeight + height / 2 - 0.01, 0.004],
      color: greaves.color,
    });
    b.box({
      size: [legWidth * 0.75, 0.05, 0.026],
      at: [0, -legLength + bootHeight + height - 0.02, legDepth / 2 + 0.022],
      color: greaves.trim,
    });
  }
  const wraps = findGear(outfit, 'wraps');
  if (wraps) {
    b.box({
      size: [legWidth + 0.035, 0.05, legDepth + 0.035],
      at: [0, -legLength + bootHeight + 0.02, 0],
      color: wraps.color,
    });
  }
  return b.build();
}

// Shared caches: geometry per look, one eye geometry, one material.

interface LookParts {
  readonly head: BufferGeometry;
  readonly torso: BufferGeometry;
  readonly armLeft: BufferGeometry;
  readonly armRight: BufferGeometry;
  readonly leg: BufferGeometry;
}

const partCache = new Map<AvatarSpriteKey, LookParts>();
const heightCache = new Map<AvatarSpriteKey, number>();
let eyeCache: BufferGeometry | null = null;
let materialCache: MeshStandardMaterial | null = null;

function lookParts(key: AvatarSpriteKey): LookParts {
  let parts = partCache.get(key);
  if (!parts) {
    const look = avatarLook(key);
    const d = BUILDS[look.character.build];
    parts = {
      head: buildHead(look, d),
      torso: buildTorso(look, d),
      armLeft: buildArm(look, d, 1),
      armRight: buildArm(look, d, -1),
      leg: buildLeg(look, d),
    };
    partCache.set(key, parts);
  }
  return parts;
}

function eyeGeometry(): BufferGeometry {
  eyeCache ??= buildEyes();
  return eyeCache;
}

/** Colour lives in the vertices, so one material serves every figure and look. */
function figureMaterial(): MeshStandardMaterial {
  materialCache ??= new MeshStandardMaterial({
    name: 'avatar-figure',
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
  });
  return materialCache;
}

/**
 * Release every shared geometry and the shared material, for engine teardown.
 * Figures still alive afterwards reference released resources; dispose them first.
 */
export function disposeAvatarFigureCache(): void {
  for (const parts of partCache.values()) {
    parts.head.dispose();
    parts.torso.dispose();
    parts.armLeft.dispose();
    parts.armRight.dispose();
    parts.leg.dispose();
  }
  partCache.clear();
  eyeCache?.dispose();
  eyeCache = null;
  materialCache?.dispose();
  materialCache = null;
}

/** Standing still at the top of a breath: the highest a still figure ever reaches. */
const PEAK_BREATH: FigurePhases = { breath: Math.PI / 2, blink: BLINK_SECONDS };

/**
 * The true top of one look standing still, build scale included, in world
 * units: the exact highest vertex at the top of its idle breath, so anything
 * held at or above it (a label, a carried block) never touches the figure
 * while it stands. Walking and sprinting lift the body up to ~0.06 x scale
 * higher; AVATAR_FIGURE_HEIGHT already includes that for the tallest look.
 */
export function avatarFigureHeight(key: AvatarSpriteKey): number {
  const valid = validateAvatarSprite(key);
  let height = heightCache.get(valid);
  if (height === undefined) {
    const figure = buildFigure(valid, PEAK_BREATH);
    height = new Box3().setFromObject(figure.object, true).max.y;
    figure.dispose();
    heightCache.set(valid, height);
  }
  return height;
}

function partMesh(name: string, geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  // Figures should darken when they walk into a building's shadow.
  mesh.receiveShadow = true;
  return mesh;
}

function pivot(name: string): Group {
  const group = new Group();
  group.name = name;
  return group;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

interface FigurePhases {
  readonly breath: number;
  readonly blink: number;
}

/** Per-key offsets keep a row of idle figures from breathing and blinking in unison. */
function keyPhases(key: AvatarSpriteKey): FigurePhases {
  const index = Math.max(0, AVATAR_SPRITE_KEYS.indexOf(key));
  return {
    breath: ((index * GOLDEN_RATIO_FRACTION) % 1) * TAU,
    blink:
      BLINK_SECONDS +
      ((index * GOLDEN_RATIO_FRACTION * GOLDEN_RATIO_FRACTION) % 1) *
        (BLINK_PERIOD_SECONDS - 2 * BLINK_SECONDS),
  };
}

export function createAvatarFigure(key: AvatarSpriteKey): AvatarFigure {
  // Keys can arrive from untyped runtime paths (remote peers); never trust them.
  const valid = validateAvatarSprite(key);
  return buildFigure(valid, keyPhases(valid));
}

function buildFigure(key: AvatarSpriteKey, phases: FigurePhases): AvatarFigure {
  let current = key;
  let dims = BUILDS[avatarLook(current).character.build];
  const parts = lookParts(current);
  const material = figureMaterial();

  const root = pivot('avatar-figure');
  const body = pivot('avatar-body');
  const hips = pivot('avatar-hips');
  const upperBody = pivot('avatar-upper-body');
  const headPivot = pivot('avatar-head-pivot');
  const armLeftPivot = pivot('avatar-arm-left-pivot');
  const armRightPivot = pivot('avatar-arm-right-pivot');
  const legLeftPivot = pivot('avatar-leg-left-pivot');
  const legRightPivot = pivot('avatar-leg-right-pivot');
  const torso = partMesh('avatar-torso', parts.torso, material);
  const head = partMesh('avatar-head', parts.head, material);
  const eyes = partMesh('avatar-eyes', eyeGeometry(), material);
  const armLeft = partMesh('avatar-arm-left', parts.armLeft, material);
  const armRight = partMesh('avatar-arm-right', parts.armRight, material);
  const legLeft = partMesh('avatar-leg-left', parts.leg, material);
  const legRight = partMesh('avatar-leg-right', parts.leg, material);

  root.add(body);
  body.add(hips);
  hips.add(legLeftPivot, legRightPivot, upperBody);
  upperBody.add(torso, headPivot, armLeftPivot, armRightPivot);
  headPivot.add(head, eyes);
  armLeftPivot.add(armLeft);
  armRightPivot.add(armRight);
  legLeftPivot.add(legLeft);
  legRightPivot.add(legRight);

  let walkWeight = 0;
  let sprintWeight = 0;
  let stridePhase = 0;
  let breathPhase = phases.breath;
  let blinkClock = phases.blink;
  let swingLeft = 1;
  let swingRight = 1;
  let strideScale = 1;
  let disposed = false;

  const applyLook = (): void => {
    const look = avatarLook(current);
    const next = lookParts(current);
    dims = BUILDS[look.character.build];
    // Scaling about the feet keeps them on y = 0; pairs share a build, so F-toggling keeps size.
    body.scale.setScalar(dims.scale);
    torso.geometry = next.torso;
    head.geometry = next.head;
    armLeft.geometry = next.armLeft;
    armRight.geometry = next.armRight;
    legLeft.geometry = next.leg;
    legRight.geometry = next.leg;
    legLeftPivot.position.set(dims.legSpacing, -LEG_PIVOT_DROP, 0);
    legRightPivot.position.set(-dims.legSpacing, -LEG_PIVOT_DROP, 0);
    headPivot.position.set(0, dims.torsoHeight, 0);
    armLeftPivot.position.set(shoulderX(dims, look.outfit), shoulderY(dims), 0);
    armRightPivot.position.set(-shoulderX(dims, look.outfit), shoulderY(dims), 0);
    eyes.position.set(0, EYE_HEIGHT * dims.headHeight, dims.headDepth / 2);
    // A long robe shortens the stride, so the legs stay inside its bell.
    strideScale = findGear(look.outfit, 'coat')?.length === 'ankle' ? ROBE_STRIDE : 1;
    const weapon = look.outfit.weapon;
    swingLeft = findGear(look.outfit, 'shield') ? STEADY_ARM_SWING : 1;
    swingRight = weapon === null
      ? 1
      : weapon.kind === 'staff' || weapon.kind === 'halberd' || weapon.kind === 'bow'
        ? STEADY_ARM_SWING
        : WEAPON_ARM_SWING;
  };

  const applyPose = (): void => {
    const swing = Math.sin(stridePhase);
    const legAngle = walkWeight * lerp(LEG_SWING_WALK, LEG_SWING_SPRINT, sprintWeight) * swing * strideScale;
    const armAngle = walkWeight * lerp(ARM_SWING_WALK, ARM_SWING_SPRINT, sprintWeight) * swing;
    legLeftPivot.rotation.x = legAngle;
    legRightPivot.rotation.x = -legAngle;
    // Arms swing against the same-side leg.
    armLeftPivot.rotation.x = -armAngle * swingLeft;
    armRightPivot.rotation.x = armAngle * swingRight;
    const breath = Math.sin(breathPhase) * (1 - walkWeight);
    const spread = ARM_REST_SPREAD + ARM_BREATH_SPREAD * breath;
    armLeftPivot.rotation.z = spread;
    armRightPivot.rotation.z = -spread;
    // Ride the hips on the swinging legs so neither the sole nor the toe sinks below y = 0.
    const tilt = Math.abs(legAngle);
    const swung = dims.legLength - LEG_PIVOT_DROP;
    hips.position.y = swung * Math.cos(tilt) + footReach(dims) * Math.sin(tilt) + LEG_PIVOT_DROP;
    // Bob the upper body rather than the hips: highest mid-stride, and the feet stay planted.
    const bob = walkWeight * lerp(BOB_WALK, BOB_SPRINT, sprintWeight) * Math.cos(2 * stridePhase);
    upperBody.position.y = bob + BREATH_LIFT * breath;
    const lean = walkWeight * lerp(LEAN_WALK, LEAN_SPRINT, sprintWeight);
    upperBody.rotation.x = lean;
    upperBody.rotation.y = -TORSO_TWIST * walkWeight * swing;
    // The head counters the lean and twist so the face keeps looking ahead.
    // Only partly, so its chin never dips into the shirt at a sprint.
    headPivot.rotation.x = -lean * HEAD_COUNTER_LEAN;
    headPivot.rotation.y = TORSO_TWIST * 0.5 * walkWeight * swing;
    eyes.scale.y = blinkClock < BLINK_SECONDS ? 0.15 : 1;
  };

  applyLook();
  applyPose();

  return {
    object: root,
    get look(): AvatarSpriteKey {
      return current;
    },
    setLook(next: AvatarSpriteKey): void {
      if (disposed) return;
      const valid = validateAvatarSprite(next);
      if (valid === current) return;
      current = valid;
      applyLook();
      applyPose();
    },
    update(deltaMs: number, motion: AvatarMotion): void {
      if (disposed) return;
      const seconds = Number.isFinite(deltaMs) && deltaMs > 0
        ? Math.min(deltaMs / 1000, MAX_STEP_SECONDS)
        : 0;
      const moving = motion?.moving === true;
      const sprinting = moving && motion.sprinting === true;
      const blend = 1 - Math.exp(-seconds / GAIT_BLEND_SECONDS);
      walkWeight += ((moving ? 1 : 0) - walkWeight) * blend;
      sprintWeight += ((sprinting ? 1 : 0) - sprintWeight) * blend;
      const cadence = lerp(WALK_STRIDES_PER_SECOND, SPRINT_STRIDES_PER_SECOND, sprintWeight);
      stridePhase = (stridePhase + seconds * cadence * TAU) % TAU;
      breathPhase = (breathPhase + seconds * BREATH_PER_SECOND * TAU) % TAU;
      blinkClock = (blinkClock + seconds) % BLINK_PERIOD_SECONDS;
      applyPose();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Geometry and material are shared; only the scene-graph nodes are this figure's.
      root.removeFromParent();
    },
  };
}
