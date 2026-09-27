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
  type AvatarGear,
  type AvatarHair,
  type AvatarLook,
  type AvatarOutfit,
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
 * head, arms. Limbs pivot at the hips and shoulders. The body scales about the
 * feet, which sit on y = 0; the front faces +Z.
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
    legDepth: 0.16,
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

function shoulderX(d: BuildDims): number {
  return d.torsoWidth / 2 + d.armWidth / 2 + 0.006;
}

function shoulderY(d: BuildDims): number {
  return d.torsoHeight - d.armWidth * 0.45;
}

function headChamfer(d: BuildDims): number {
  return d.headWidth * 0.14;
}

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
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
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
  b.box({
    size: [width, height, depth],
    at: [0, height / 2, 0],
    color: look.character.skin,
    chamfer: headChamfer(d),
  });
  const hood = findGear(look.outfit, 'hood');
  const helmet = findGear(look.outfit, 'hornedHelmet');
  const goggles = findGear(look.outfit, 'goggles');
  addHair(b, look.character.hair, d, helmet ? 'helmet' : hood ? 'hood' : 'none');
  if (hood) addHood(b, hood.color, d);
  if (helmet) addHelmet(b, helmet.color, helmet.horn, d);
  if (goggles) addGoggles(b, goggles.frame, goggles.lens, d);
  return b.build();
}

/** Headwear hides the crown (and a helmet the fringe), so those boxes are left out. */
function addHair(b: PartBuilder, hair: AvatarHair, d: BuildDims, cover: HairCover): void {
  const { headWidth: width, headHeight: height, headDepth: depth } = d;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const chamfer = headChamfer(d);
  const color = hair.color;
  const crown = cover === 'none';

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
    b.box({
      size: [width + 0.06, length, thick],
      at: [0, height - length / 2 + 0.01, -halfDepth - 0.01],
      color,
    });
  };
  const sides = (length: number, sideDepth: number, z = 0, thick = 0.06): void => {
    for (const s of SIDES) {
      b.box({
        size: [thick, length, sideDepth],
        at: [s * (halfWidth + 0.015), height - length / 2, z],
        color,
      });
    }
  };
  const fringe = (chunks: readonly FringeChunk[]): void => {
    if (cover === 'helmet') return;
    for (const chunk of chunks) {
      b.box({
        size: [chunk.w, chunk.h, 0.07],
        at: [chunk.x, height - chunk.h / 2 + 0.02, halfDepth + 0.02],
        rotation: [0, 0, chunk.tilt],
        color,
      });
    }
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
      sides(0.36, depth * 0.8, 0.02);
      fringe([
        { x: -0.15, w: 0.2, h: 0.21, tilt: 0.12 },
        { x: 0.02, w: 0.2, h: 0.23, tilt: -0.05 },
        { x: 0.17, w: 0.18, h: 0.2, tilt: -0.14 },
      ]);
      // Face-framing locks stay visible inside a hood's opening.
      for (const s of SIDES) {
        b.box({
          size: [0.07, 0.3, 0.1],
          at: [s * (halfWidth - 0.03), height - 0.2, halfDepth - 0.01],
          color,
        });
      }
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
      sides(0.52, depth * 0.55, 0.06, 0.08);
      if (cover !== 'hood') {
        b.box({ size: [width + 0.06, 0.8, 0.1], at: [0, height - 0.39, -halfDepth - 0.03], color });
        b.box({
          size: [width + 0.12, 0.14, 0.12],
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

/** Kept below the eyes so the face stays readable. */
function addBeard(b: PartBuilder, beard: number, brows: number, d: BuildDims): void {
  const halfWidth = d.headWidth / 2;
  const halfDepth = d.headDepth / 2;
  const eyeY = EYE_HEIGHT * d.headHeight;
  b.box({
    size: [d.headWidth * 0.8, 0.22, 0.12],
    at: [0, eyeY - 0.185, halfDepth + 0.02],
    color: beard,
    chamfer: 0.03,
  });
  b.box({
    size: [d.headWidth * 0.46, 0.13, 0.1],
    at: [0, eyeY - 0.36, halfDepth + 0.02],
    rotation: [0, 0, Math.PI],
    taper: [0.4, 0.8],
    color: beard,
  });
  for (const s of SIDES) {
    b.box({
      size: [0.08, 0.26, 0.22],
      at: [s * (halfWidth - 0.01), eyeY - 0.1, halfDepth - 0.08],
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

/** Open-faced so the eyes stay visible; the nasal guard echoes the sprite's T visor. */
function addHelmet(b: PartBuilder, metal: number, horn: number, d: BuildDims): void {
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
    at: [0, height - 0.15, 0],
    color: metal,
    chamfer: chamfer + 0.075,
  });
  b.box({ size: [0.06, 0.2, 0.05], at: [0, height - 0.25, halfDepth + 0.05], color: metal });
  b.box({
    size: [width + 0.1, 0.3, 0.06],
    at: [0, height * 0.42, -(halfDepth + 0.045)],
    color: metal,
  });
  for (const s of SIDES) {
    b.box({
      size: [0.06, 0.3, 0.22],
      at: [s * (halfWidth + 0.04), height * 0.45, halfDepth - 0.1],
      color: metal,
    });
    b.push([s * (halfWidth + 0.04), height - 0.01, 0], [0, 0, -s * 1.0]);
    b.box({ size: [0.1, 0.15, 0.1], at: [0, 0.075, 0], color: horn, taper: [0.75, 0.75] });
    b.push([0, 0.14, 0], [0, 0, s * 0.8]);
    b.box({ size: [0.075, 0.12, 0.075], at: [0, 0.06, 0], color: horn, taper: [0.15, 0.15] });
    b.pop();
    b.pop();
  }
}

/** Pushed up onto the hairline, strap proud of the hair all round. */
function addGoggles(b: PartBuilder, frame: number, lens: number, d: BuildDims): void {
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
  b.box({
    size: [torsoWidth - 0.02, 0.13, torsoDepth - 0.02],
    at: [0, 0.015, 0],
    color: outfit.trousers,
    chamfer: 0.02,
  });
  b.box({
    size: [torsoWidth, torsoHeight - 0.06, torsoDepth],
    at: [0, 0.06 + (torsoHeight - 0.06) / 2, 0],
    color: outfit.top,
    chamfer: 0.03,
  });
  if (coat) addCoat(b, coat, outfit.top, d);
  if (outfit.belt) addBelt(b, outfit.belt.color, outfit.belt.buckle, coat, d);
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
        addMantle(b, item.color, d);
        break;
      case 'furCollar':
        b.box({
          size: [torsoWidth * 0.94, 0.15, torsoDepth + 0.16],
          at: [0, torsoHeight + 0.015, -0.01],
          color: item.color,
          chamfer: 0.06,
        });
        break;
      case 'cloak':
        addCloak(b, item.color, d);
        break;
      case 'pauldrons':
        for (const s of SIDES) {
          b.box({
            size: [d.armWidth + 0.1, 0.1, d.armDepth + 0.1],
            at: [s * shoulderX(d), torsoHeight - 0.03, 0],
            rotation: [0, 0, -s * 0.28],
            color: item.color,
            chamfer: 0.03,
          });
        }
        break;
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
    const length = top + legLength - 0.1;
    const bottomWidth = torsoWidth + 0.16;
    const bottomDepth = torsoDepth + 0.26;
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
  // Knee coats: back and side tails only, so the legs stride through the open front.
  const length = legLength * 0.55;
  b.box({
    size: [shellWidth, length, 0.04],
    color: coat.color,
    ...hang([0, 0.03, -shellDepth / 2 + 0.02], length, [0.2, 0, 0]),
  });
  for (const s of SIDES) {
    b.box({
      size: [0.04, length, shellDepth - 0.02],
      color: coat.color,
      ...hang([s * (shellWidth / 2 - 0.02), 0.03, 0], length, [0, 0, s * 0.12]),
    });
  }
}

function addBelt(
  b: PartBuilder,
  color: number,
  buckle: number,
  coat: CoatGear | undefined,
  d: BuildDims,
): void {
  const { torsoWidth, torsoDepth } = d;
  const y = 0.075;
  if (coat?.length === 'knee') {
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
  b.box({
    size: [torsoWidth + 0.04, 0.11, torsoDepth + 0.1],
    at: [0, torsoHeight - 0.03, 0.005],
    color,
    chamfer: 0.045,
  });
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

/** Strap from the right shoulder to a pouch on the left hip. */
function addSatchel(b: PartBuilder, color: number, surfaceDepth: number, d: BuildDims): void {
  const { torsoWidth, torsoHeight } = d;
  for (const z of [surfaceDepth / 2 + 0.008, -(surfaceDepth / 2 + 0.008)]) {
    b.box({
      size: [0.045, torsoHeight * 1.14, 0.02],
      at: [0, torsoHeight * 0.5, z],
      rotation: [0, 0, 0.55],
      color,
    });
  }
  b.box({
    size: [torsoWidth * 0.36, 0.13, 0.08],
    at: [torsoWidth * 0.24, 0.015, surfaceDepth / 2 + 0.03],
    color,
    chamfer: 0.02,
  });
}

/** Puffed shoulders that swallow the arm tops, plus the hood's drape down the back. */
function addMantle(b: PartBuilder, color: number, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
  b.box({
    size: [torsoWidth + 0.2, 0.15, torsoDepth + 0.1],
    at: [0, torsoHeight - 0.035, 0],
    color,
    chamfer: 0.06,
    taper: [0.8, 0.88],
  });
  for (const s of SIDES) {
    b.box({
      size: [d.armWidth + 0.1, 0.2, d.armDepth + 0.12],
      at: [s * shoulderX(d), shoulderY(d) - 0.03, 0],
      color,
      chamfer: 0.05,
    });
  }
  b.box({
    size: [torsoWidth + 0.06, torsoHeight * 0.7, 0.06],
    at: [0, torsoHeight * 0.6, -(torsoDepth / 2 + 0.035)],
    color,
  });
}

/** Tilted back and flared so swinging arms and legs stay in front of it. */
function addCloak(b: PartBuilder, color: number, d: BuildDims): void {
  const { torsoWidth, torsoDepth, torsoHeight, legLength } = d;
  b.box({
    size: [torsoWidth + 0.1, 0.08, torsoDepth + 0.08],
    at: [0, torsoHeight - 0.02, 0],
    color,
    chamfer: 0.04,
  });
  const length = torsoHeight + legLength - 0.16;
  const width = torsoWidth + 0.24;
  b.box({
    size: [width, length, 0.05],
    color,
    taper: [(torsoWidth + 0.08) / width, 1],
    ...hang([0, torsoHeight - 0.03, -(torsoDepth / 2 + 0.05)], length, [0.12, 0, 0]),
  });
}

function addBreastplate(
  b: PartBuilder,
  color: number,
  trim: number,
  coverage: 'full' | 'upper',
  surfaceDepth: number,
  d: BuildDims,
): void {
  const { torsoWidth, torsoDepth, torsoHeight } = d;
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
  const top = armWidth * 0.45;
  const gloved = outfit.gloves !== null;
  const lower = armLength * (gloved ? 0.45 : 0.28);
  const upper = armLength - lower;
  b.box({
    size: [armWidth, upper + top, armDepth],
    at: [0, (top - upper) / 2, 0],
    color: outfit.sleeves ?? character.skin,
    chamfer: 0.015,
  });
  const handScale = gloved ? 1.06 : 0.92;
  b.box({
    size: [armWidth * handScale, lower, armDepth * handScale],
    at: [0, -upper - lower / 2, 0],
    color: outfit.gloves ?? character.skin,
    chamfer: 0.015,
  });
  const coat = findGear(outfit, 'coat');
  if (coat) {
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

/** Carried facing forward in front of the left forearm, clear of the chest plate. */
function addShield(
  b: PartBuilder,
  shield: Extract<AvatarGear, { kind: 'shield' }>,
  d: BuildDims,
): void {
  b.push([0.06, -d.armLength * 0.6, d.torsoDepth / 2 + 0.085], ZERO, d.propScale);
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
  switch (weapon.kind) {
    case 'sword':
      b.push(grip, [-0.5, 0, -0.7], scale);
      b.box({ size: [0.045, 0.15, 0.045], at: [0, 0.02, 0], color: weapon.hilt });
      b.box({ size: [0.065, 0.05, 0.065], at: [0, 0.115, 0], color: weapon.hilt, chamfer: 0.015 });
      b.box({ size: [0.2, 0.04, 0.065], at: [0, -0.07, 0], color: weapon.hilt });
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
      b.push(grip, [0.3, 0, 0.35], scale * (weapon.size === 'giant' ? 1.55 : 1));
      b.box({ size: [0.05, 0.4, 0.05], at: [0, 0.13, 0], color: weapon.handle, chamfer: 0.01 });
      b.box({ size: [0.17, 0.08, 0.06], at: [0, 0.36, 0], color: weapon.head });
      for (const x of [-0.055, 0.055]) {
        b.box({ size: [0.05, 0.1, 0.06], at: [x, 0.44, 0], color: weapon.head });
      }
      b.pop();
      break;
    case 'crossbow':
      b.push(grip, ZERO, scale);
      b.box({ size: [0.06, 0.065, 0.38], at: [0, 0, 0.1], color: weapon.stock, chamfer: 0.012 });
      b.box({ size: [0.38, 0.04, 0.05], at: [0, 0.015, 0.26], color: weapon.limbs });
      for (const s of SIDES) {
        b.box({
          size: [0.09, 0.04, 0.05],
          at: [s * 0.21, 0.015, 0.235],
          rotation: [0, s * 0.785, 0],
          color: weapon.limbs,
        });
      }
      b.box({ size: [0.36, 0.014, 0.014], at: [0, 0.03, 0.19], color: weapon.string });
      b.pop();
      break;
    case 'mace':
      b.push(grip, [0.3, 0, 0.3], scale);
      b.box({ size: [0.06, 0.44, 0.06], at: [0, 0.14, 0], color: weapon.handle, chamfer: 0.012 });
      b.box({ size: [0.17, 0.17, 0.17], at: [0, 0.42, 0], color: weapon.head, chamfer: 0.05 });
      b.box({ size: [0.25, 0.06, 0.06], at: [0, 0.42, 0], color: weapon.head });
      b.box({ size: [0.06, 0.06, 0.25], at: [0, 0.42, 0], color: weapon.head });
      b.box({ size: [0.06, 0.08, 0.06], at: [0, 0.54, 0], color: weapon.head, taper: [0.2, 0.2] });
      b.pop();
      break;
    case 'staff': {
      b.push(grip, [0.08, 0, 0.1], scale);
      b.box({ size: [0.05, 1.02, 0.05], at: [0, 0.19, 0], color: weapon.shaft, chamfer: 0.01 });
      const ringY = 0.8;
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
    case 'halberd':
      b.push(grip, [0.08, 0, 0.1], scale);
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

// Legs: local origin is the hip pivot; the boot sole is at y = -legLength.

function buildLeg(look: AvatarLook, d: BuildDims): BufferGeometry {
  const b = new PartBuilder();
  const { outfit } = look;
  const { legLength, legWidth, legDepth, bootHeight } = d;
  const trouser = legLength - bootHeight + 0.04;
  b.box({
    size: [legWidth, trouser, legDepth],
    at: [0, 0.04 - trouser / 2, 0],
    color: outfit.trousers,
    chamfer: 0.015,
  });
  b.box({
    size: [legWidth + 0.025, bootHeight, legDepth + 0.06],
    at: [0, -legLength + bootHeight / 2, 0.025],
    color: outfit.boots,
    chamfer: 0.02,
  });
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
    legLeftPivot.position.set(dims.legSpacing, 0, 0);
    legRightPivot.position.set(-dims.legSpacing, 0, 0);
    headPivot.position.set(0, dims.torsoHeight, 0);
    armLeftPivot.position.set(shoulderX(dims), shoulderY(dims), 0);
    armRightPivot.position.set(-shoulderX(dims), shoulderY(dims), 0);
    eyes.position.set(0, EYE_HEIGHT * dims.headHeight, dims.headDepth / 2);
    const weapon = look.outfit.weapon;
    swingLeft = findGear(look.outfit, 'shield') ? STEADY_ARM_SWING : 1;
    swingRight = weapon === null
      ? 1
      : weapon.kind === 'staff' || weapon.kind === 'halberd'
        ? STEADY_ARM_SWING
        : WEAPON_ARM_SWING;
  };

  const applyPose = (): void => {
    const swing = Math.sin(stridePhase);
    const legAngle = walkWeight * lerp(LEG_SWING_WALK, LEG_SWING_SPRINT, sprintWeight) * swing;
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
    hips.position.y = dims.legLength * Math.cos(tilt) + footReach(dims) * Math.sin(tilt);
    // Bob the upper body rather than the hips: highest mid-stride, and the feet stay planted.
    const bob = walkWeight * lerp(BOB_WALK, BOB_SPRINT, sprintWeight) * Math.cos(2 * stridePhase);
    upperBody.position.y = bob + BREATH_LIFT * breath;
    const lean = walkWeight * lerp(LEAN_WALK, LEAN_SPRINT, sprintWeight);
    upperBody.rotation.x = lean;
    upperBody.rotation.y = -TORSO_TWIST * walkWeight * swing;
    // The head counters the lean and twist so the face keeps looking ahead.
    headPivot.rotation.x = -lean * 0.6;
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
