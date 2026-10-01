import { Matrix4, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { avatarPartBoxes, createAvatarFigure, type AvatarPartBox } from '../src/three/avatar-figure.js';
import type { AvatarFigure, AvatarMotion } from '../src/three/types.js';
import { PLAYER_SPRINT_MULTIPLIER } from '../src/movement-input.js';
import { CAMERA_PITCH, ROOFTOP_CAMERA_PITCH } from '../src/three/camera-rig.js';

/**
 * An offline clipping check for the procedural avatars (D-059): does any
 * piece of a figure pass through another, in any pose of its idle, walk or
 * sprint?
 *
 * A figure is seven meshes on five moving groups (head with eyes, torso, two
 * arms, two legs), each mesh a merge of convex boxes that `PartBuilder`
 * records (`avatarPartBoxes`). Two checks run on every look:
 *
 * - **Moving parts never interpenetrate.** Each box's surface is sampled;
 *   a sample that lies inside a box of another group, deeper than the
 *   tolerance, is a clip: the two pieces slide through each other as the
 *   figure moves. Samples buried inside their own group's other boxes are
 *   hidden and skipped. The exceptions are the joints, the boxes built as
 *   sockets (the hip band, a robe's bell, shoulder puffs and pauldrons, a
 *   collar under the chin): the limb or head they hold may sit inside them
 *   and leave through their one open face, but may not come out of any other.
 * - **Headwear keeps its hair in.** Hair outside the hood or helmet is fine
 *   where it hangs below it (a nape, side locks, a fringe), but not where the
 *   headwear lies directly beneath it: that is hair poking out through the
 *   headwear's top or sides.
 *
 * Poses are the figure's own: `update()` through a breath at rest, and two
 * whole strides each of walking and sprinting after the gait has settled.
 */

/**
 * How far one piece may stand out through another before it counts: one pixel.
 * The street camera (camera-rig.ts: 50 degree field, 11 units back at 28
 * degrees, about 12.9 to the player) spans 12 world units over the view's
 * height, so on a 1080-pixel view one unit is 90 pixels and 0.011 is one.
 */
export const CLIP_TOLERANCE = 0.011;
/** Surface sample spacing, in world units. */
const SAMPLE_SPACING = 0.015;
/** A sample this close inside another box is next to the seam where the two surfaces cross. */
const SEAM_BAND = SAMPLE_SPACING * 1.5;
const HEADWEAR_STEP = 0.01;
const SETTLE_STRIDES = 4;

const IDLE: AvatarMotion = Object.freeze({ moving: false, sprinting: false });
const WALK: AvatarMotion = Object.freeze({ moving: true, sprinting: false });
const SPRINT: AvatarMotion = Object.freeze({ moving: true, sprinting: true });

type Group = 'head' | 'torso' | 'arm-left' | 'arm-right' | 'leg-left' | 'leg-right';

const MESH_GROUPS: Readonly<Record<string, Group>> = {
  'avatar-head': 'head',
  'avatar-eyes': 'head',
  'avatar-torso': 'torso',
  'avatar-arm-left': 'arm-left',
  'avatar-arm-right': 'arm-right',
  'avatar-leg-left': 'leg-left',
  'avatar-leg-right': 'leg-right',
};

function limbOf(group: Group): 'arm' | 'leg' | 'head' | null {
  if (group === 'head') return 'head';
  if (group === 'arm-left' || group === 'arm-right') return 'arm';
  if (group === 'leg-left' || group === 'leg-right') return 'leg';
  return null;
}

/** One posed convex box: its planes (outward normals) and bounds in world space. */
interface Solid {
  readonly mesh: string;
  readonly group: Group;
  readonly box: AvatarPartBox;
  /** nx, ny, nz, d per plane: inside where n·p < d. */
  readonly planes: Float64Array;
  /** Each triangle's world vertices, nine numbers a triangle. */
  readonly triangles: Float64Array;
  /** Per triangle: is it on the socket's open face? */
  readonly open: Uint8Array;
  /** Per triangle: its outward direction in the part frame, such as `-z`. */
  readonly faces: readonly string[];
  readonly min: Vector3;
  readonly max: Vector3;
}

export interface ClipFinding {
  readonly key: AvatarSpriteKey;
  readonly pose: string;
  readonly check: 'moving' | 'headwear';
  /** The surface that is pierced, and the piece inside it. */
  readonly surface: string;
  readonly inside: string;
  /** The pierced face's outward direction in its part's frame, such as `+y`. */
  readonly face: string;
  /** How far the piece stands out through the surface, in world units (headwear: how far the hair stands proud). */
  readonly depth: number;
  readonly point: readonly [number, number, number];
}

export interface Pose {
  readonly name: string;
  /** Advance a freshly built figure into the pose. */
  readonly drive: (figure: AvatarFigure) => void;
}

/** The poses every look is checked in. */
export function figurePoses(): Pose[] {
  const poses: Pose[] = [];
  const breathSteps = 4;
  for (let i = 0; i < breathSteps; i += 1) {
    poses.push({
      name: `idle ${i}/${breathSteps}`,
      drive: (figure) => {
        // The figure clamps a frame to 100 ms, so step a breath in 25 ms frames.
        const frames = Math.round((i * 1000) / 0.3 / breathSteps / 25);
        for (let t = 0; t < frames; t += 1) figure.update(25, IDLE);
      },
    });
  }
  for (const [label, motion, stridesPerSecond] of [
    ['walk', WALK, 1.6],
    ['sprint', SPRINT, 1.6 * PLAYER_SPRINT_MULTIPLIER],
  ] as const) {
    const frames = 16;
    const stepMs = 1000 / stridesPerSecond / frames;
    for (let i = 0; i < frames; i += 1) {
      poses.push({
        name: `${label} ${i}/${frames}`,
        drive: (figure) => {
          // Whole strides first, past ten time constants of the gait blend, so
          // frame i is i/frames of the way through a stride at full gait.
          for (let t = 0; t < SETTLE_STRIDES * frames + i; t += 1) figure.update(stepMs, motion);
        },
      });
    }
  }
  return poses;
}

function collectSolids(root: Object3D): Solid[] {
  root.updateMatrixWorld(true);
  const solids: Solid[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();
  const localNormal = new Vector3();
  const up = new Vector3();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const group = MESH_GROUPS[object.name];
    if (!group) return;
    const geometry = object.geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    const world: Matrix4 = object.matrixWorld;
    for (const box of avatarPartBoxes(geometry)) {
      const planes = new Float64Array(box.count * 4);
      const triangles = new Float64Array(box.count * 9);
      const open = new Uint8Array(box.count);
      const faces: string[] = [];
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (let t = 0; t < box.count; t += 1) {
        const v = (box.first + t) * 3;
        a.fromBufferAttribute(position, v);
        b.fromBufferAttribute(position, v + 1);
        c.fromBufferAttribute(position, v + 2);
        // The open face is judged in the part's own frame, where "up" is the part's up.
        localNormal.subVectors(b, a).cross(up.subVectors(c, a)).normalize();
        faces.push(dominantAxis(localNormal));
        if (box.socket) {
          const top = box.socket.open.includes('top') && localNormal.y > 0.9;
          const bottom = box.socket.open.includes('bottom') && localNormal.y < -0.9;
          open[t] = top || bottom ? 1 : 0;
        }
        a.applyMatrix4(world);
        b.applyMatrix4(world);
        c.applyMatrix4(world);
        normal.subVectors(b, a).cross(up.subVectors(c, a)).normalize();
        planes[t * 4] = normal.x;
        planes[t * 4 + 1] = normal.y;
        planes[t * 4 + 2] = normal.z;
        planes[t * 4 + 3] = normal.dot(a);
        triangles.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], t * 9);
        for (const p of [a, b, c]) {
          min.min(p);
          max.max(p);
        }
      }
      solids.push({ mesh: object.name, group, box, planes, triangles, open, faces, min, max });
    }
  });
  return solids;
}

function dominantAxis(n: Vector3): string {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x >= 0 ? '+x' : '-x';
  if (ay >= az) return n.y >= 0 ? '+y' : '-y';
  return n.z >= 0 ? '+z' : '-z';
}

/** How deep a point lies inside a solid: positive inside, by the nearest face. */
function depthInside(solid: Solid, x: number, y: number, z: number): number {
  if (
    x < solid.min.x || y < solid.min.y || z < solid.min.z ||
    x > solid.max.x || y > solid.max.y || z > solid.max.z
  ) {
    return -1;
  }
  const p = solid.planes;
  let depth = Infinity;
  for (let i = 0; i < p.length; i += 4) {
    const d = p[i + 3]! - (p[i]! * x + p[i + 1]! * y + p[i + 2]! * z);
    if (d < depth) depth = d;
    if (depth <= 0) return depth;
  }
  return depth;
}

/** Points spread over one triangle, kept just off its edges. */
function* trianglePoints(tri: Float64Array, offset: number): Generator<[number, number, number]> {
  const ax = tri[offset]!, ay = tri[offset + 1]!, az = tri[offset + 2]!;
  const bx = tri[offset + 3]!, by = tri[offset + 4]!, bz = tri[offset + 5]!;
  const cx = tri[offset + 6]!, cy = tri[offset + 7]!, cz = tri[offset + 8]!;
  const edge = Math.max(
    Math.hypot(bx - ax, by - ay, bz - az),
    Math.hypot(cx - bx, cy - by, cz - bz),
    Math.hypot(ax - cx, ay - cy, az - cz),
  );
  const n = Math.max(1, Math.ceil(edge / SAMPLE_SPACING));
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= n - i; j += 1) {
      // Barycentric, pulled 2% towards the centroid so shared edges are not sampled twice as "inside".
      let u = i / n;
      let v = j / n;
      let w = 1 - u - v;
      u = u * 0.98 + 0.02 / 3;
      v = v * 0.98 + 0.02 / 3;
      w = w * 0.98 + 0.02 / 3;
      yield [ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v];
    }
  }
}

function label(solid: Solid): string {
  return `${solid.mesh}:${solid.box.tag}`;
}

function holds(socket: Solid, other: Solid): boolean {
  const limb = limbOf(other.group);
  return socket.group !== other.group && limb !== null && socket.box.socket?.holds.includes(limb) === true;
}

function overlaps(a: Solid, b: Solid): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z;
}

/** The triangle whose plane is nearest a point inside a solid. */
function nearestFace(solid: Solid, x: number, y: number, z: number): number {
  const p = solid.planes;
  let best = 0;
  let depth = Infinity;
  for (let i = 0; i < p.length; i += 4) {
    const d = p[i + 3]! - (p[i]! * x + p[i + 1]! * y + p[i + 2]! * z);
    if (d < depth) {
      depth = d;
      best = i / 4;
    }
  }
  return best;
}

/**
 * Moving groups never interpenetrate where it shows. Two boxes that cross
 * meet along a seam on both surfaces; a seam is a clip when some of it lies
 * on the figure's visible surface. Seam points are found from samples on one
 * box lying just inside the other (within SEAM_BAND), pushed out to the other
 * box's nearest face: if that point is inside no third box, the seam shows.
 * A seam on a socket's open face, between it and the part it holds, is the
 * joint working as built.
 */
function movingClips(solids: readonly Solid[], key: AvatarSpriteKey, pose: string): ClipFinding[] {
  const worst = new Map<string, ClipFinding>();
  for (const surface of solids) {
    const others = solids.filter((s) => s.group !== surface.group && overlaps(s, surface));
    if (others.length === 0) continue;
    const own = solids.filter((s) => s !== surface && s.group === surface.group && overlaps(s, surface));
    for (let t = 0; t < surface.box.count; t += 1) {
      for (const [x, y, z] of trianglePoints(surface.triangles, t * 9)) {
        // Inside its own part's other boxes, the sample is hidden: no seam can show here.
        if (own.some((s) => depthInside(s, x, y, z) > CLIP_TOLERANCE)) continue;
        for (const inside of others) {
          const depth = depthInside(inside, x, y, z);
          if (depth <= CLIP_TOLERANCE || depth > SEAM_BAND) continue;
          const face = nearestFace(inside, x, y, z);
          // The held part crossing its socket's open face, from either side.
          if (holds(inside, surface) && inside.open[face] === 1) continue;
          if (holds(surface, inside) && surface.open[t] === 1) continue;
          // The seam point on the other box's face: does anything else cover it,
          // and can the game's camera see it from anywhere it can stand?
          const n = inside.planes;
          const px = x + n[face * 4]! * depth;
          const py = y + n[face * 4 + 1]! * depth;
          const pz = z + n[face * 4 + 2]! * depth;
          if (solids.some((s) => s !== surface && s !== inside && depthInside(s, px, py, pz) > CLIP_TOLERANCE)) {
            continue;
          }
          if (!seenByCamera(solids, px, py, pz)) continue;
          const id = `${label(surface)}|${label(inside)}`;
          if (worst.has(id)) continue;
          const reach = protrusion(solids, surface, inside);
          if (reach <= CLIP_TOLERANCE) continue;
          worst.set(id, {
            key,
            pose,
            check: 'moving',
            surface: label(inside),
            inside: label(surface),
            face: inside.faces[face]!,
            depth: reach,
            point: [px, py, pz],
          });
        }
      }
    }
  }
  return [...worst.values()];
}

/**
 * Directions towards the camera: the street and rooftop pitches (camera-rig.ts)
 * at eight yaws, since the player orbits the camera freely around the figure.
 */
const CAMERA_DIRECTIONS: readonly (readonly [number, number, number])[] = [CAMERA_PITCH, ROOFTOP_CAMERA_PITCH].flatMap(
  (pitch) =>
    Array.from({ length: 8 }, (_, i) => {
      const yaw = (i / 8) * Math.PI * 2;
      return [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)] as const;
    }),
);
/** A seam point is looked at from just off the surface, past the tolerance. */
const VIEW_OFFSET = CLIP_TOLERANCE * 1.5;

/** Does a ray from a point, along a direction, pass through a solid? */
function rayHits(solid: Solid, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  let enter = 0;
  let exit = Infinity;
  const p = solid.planes;
  for (let i = 0; i < p.length; i += 4) {
    const along = p[i]! * dx + p[i + 1]! * dy + p[i + 2]! * dz;
    const room = p[i + 3]! - (p[i]! * ox + p[i + 1]! * oy + p[i + 2]! * oz);
    if (Math.abs(along) < 1e-12) {
      if (room < 0) return false;
      continue;
    }
    const t = room / along;
    if (along > 0) exit = Math.min(exit, t);
    else enter = Math.max(enter, t);
    if (enter >= exit) return false;
  }
  return true;
}

/** Whether any camera direction sees the point unobstructed by the figure. */
function seenByCamera(solids: readonly Solid[], x: number, y: number, z: number): boolean {
  return CAMERA_DIRECTIONS.some(([dx, dy, dz]) => {
    const ox = x + dx * VIEW_OFFSET;
    const oy = y + dy * VIEW_OFFSET;
    const oz = z + dz * VIEW_OFFSET;
    return !solids.some((solid) => rayHits(solid, ox, oy, oz, dx, dy, dz));
  });
}

/**
 * How far one box stands out through another's surface: the deepest that a
 * visible sample of the pierced box's faces lies inside the piercing one. The
 * pierced box's open face, crossed by the part it holds, does not count.
 */
function protrusion(solids: readonly Solid[], piercing: Solid, pierced: Solid): number {
  // A held part's surface inside its socket is the joint, not a clip.
  if (holds(piercing, pierced)) return 0;
  const own = solids.filter((s) => s !== pierced && s.group === pierced.group && overlaps(s, pierced));
  const held = holds(pierced, piercing);
  let max = 0;
  for (let t = 0; t < pierced.box.count; t += 1) {
    if (held && pierced.open[t] === 1) continue;
    for (const [x, y, z] of trianglePoints(pierced.triangles, t * 9)) {
      const depth = depthInside(piercing, x, y, z);
      if (depth <= max) continue;
      if (own.some((s) => depthInside(s, x, y, z) > CLIP_TOLERANCE)) continue;
      max = depth;
    }
  }
  return max;
}

/**
 * Hair must not come out through headwear. Hair outside the hood or helmet is
 * a clip when headwear lies directly below it (it is within the headwear's
 * height, not hanging beneath it) and nothing of the headwear lies further out
 * from the head's axis (it is outside the shell, not tucked inside a hood).
 * The depth is how far the hair stands out beyond the headwear.
 */
function headwearClips(solids: readonly Solid[], key: AvatarSpriteKey, pose: string): ClipFinding[] {
  const headwear = solids.filter((s) => s.group === 'head' && s.box.tag === 'headwear');
  if (headwear.length === 0) return [];
  const covers = solids.filter((s) => s.group === 'head' && (s.box.tag === 'headwear' || s.box.tag === 'skin'));
  const skin = solids.find((s) => s.group === 'head' && s.box.tag === 'skin');
  if (!skin) return [];
  const axisX = (skin.min.x + skin.max.x) / 2;
  const axisZ = (skin.min.z + skin.max.z) / 2;
  const bottom = skin.min.y;
  const worst = new Map<string, ClipFinding>();
  for (const hair of solids.filter((s) => s.group === 'head' && s.box.tag === 'hair')) {
    for (let t = 0; t < hair.box.count; t += 1) {
      for (const [x, y, z] of trianglePoints(hair.triangles, t * 9)) {
        if (covers.some((s) => depthInside(s, x, y, z) > -CLIP_TOLERANCE)) continue;
        let under: Solid | undefined;
        for (let below = y - HEADWEAR_STEP; below > bottom && !under; below -= HEADWEAR_STEP) {
          under = headwear.find((s) => depthInside(s, x, below, z) > 0);
        }
        if (!under) continue;
        const rx = x - axisX;
        const rz = z - axisZ;
        const radius = Math.hypot(rx, rz);
        if (radius < 1e-6) continue;
        const dx = rx / radius;
        const dz = rz / radius;
        if (headwear.some((s) => rayHits(s, x, y, z, dx, 0, dz))) continue;
        // How far in from the hair the headwear begins.
        let proud = 0;
        while (proud < radius && !headwear.some((s) => depthInside(s, x - dx * proud, y, z - dz * proud) > 0)) {
          proud += HEADWEAR_STEP / 4;
        }
        const id = `${label(under)}|${label(hair)}`;
        const previous = worst.get(id);
        if (!previous || proud > previous.depth) {
          worst.set(id, {
            key,
            pose,
            check: 'headwear',
            surface: label(under),
            inside: label(hair),
            face: 'outside',
            depth: proud,
            point: [x, y, z],
          });
        }
      }
    }
  }
  return [...worst.values()];
}

/**
 * The clips in one figure as it stands now: its pose is whatever its pivots
 * hold. `key` and `pose` only label the findings.
 */
export function clippingInFigure(root: Object3D, key: AvatarSpriteKey, pose: string): ClipFinding[] {
  const solids = collectSolids(root);
  return [
    ...movingClips(solids, key, pose),
    ...headwearClips(solids, key, pose),
    ...hairShowingThroughHeadwear(solids, key, pose),
  ];
}

/**
 * Every direction a viewer could look at the head from, not only the game's
 * cameras: sixteen yaws at every 15 degrees of pitch from level to overhead.
 */
const EVERY_VIEW: readonly (readonly [number, number, number])[] = Array.from({ length: 7 }, (_, p) => (p * Math.PI) / 12)
  .flatMap((pitch) =>
    Array.from({ length: pitch === Math.PI / 2 ? 1 : 16 }, (_, i) => {
      const yaw = (i / 16) * Math.PI * 2;
      return [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)] as const;
    }),
  );

/**
 * Hair under headwear must not show at all, from any view: the headwear is
 * its shell. Only the hair built to frame the face (`hair-face`, a fringe
 * and locks inside a hood's opening) may be seen. The head is tested on its
 * own, with nothing else in front of it, so a collar or a shoulder never
 * hides a gap. The depth is the visible area, in square units.
 */
function hairShowingThroughHeadwear(solids: readonly Solid[], key: AvatarSpriteKey, pose: string): ClipFinding[] {
  const head = solids.filter((s) => s.group === 'head');
  const headwear = head.filter((s) => s.box.tag === 'headwear');
  if (headwear.length === 0) return [];
  const worst = new Map<string, ClipFinding>();
  for (const hair of head.filter((s) => s.box.tag === 'hair')) {
    const others = head.filter((s) => s !== hair);
    for (let t = 0; t < hair.box.count; t += 1) {
      const tri = hair.triangles.subarray(t * 9, t * 9 + 9);
      const points = [...trianglePoints(hair.triangles, t * 9)];
      const area = triangleArea(tri) / points.length;
      const nx = hair.planes[t * 4]!;
      const ny = hair.planes[t * 4 + 1]!;
      const nz = hair.planes[t * 4 + 2]!;
      for (const [x, y, z] of points) {
        if (others.some((s) => depthInside(s, x, y, z) > 0)) continue;
        const seen = EVERY_VIEW.some(([dx, dy, dz]) => {
          // A face is seen from in front of it, not edge on.
          if (nx * dx + ny * dy + nz * dz < 0.1) return false;
          const ox = x + dx * VIEW_OFFSET;
          const oy = y + dy * VIEW_OFFSET;
          const oz = z + dz * VIEW_OFFSET;
          return !head.some((solid) => rayHits(solid, ox, oy, oz, dx, dy, dz));
        });
        if (!seen) continue;
        const id = label(hair);
        const previous = worst.get(id);
        worst.set(id, {
          key,
          pose,
          check: 'headwear',
          surface: headwear.map(label)[0]!,
          inside: label(hair),
          face: 'seen',
          depth: (previous?.depth ?? 0) + area,
          point: previous?.point ?? [x, y, z],
        });
      }
    }
  }
  return [...worst.values()];
}

function triangleArea(tri: Float64Array): number {
  const ux = tri[3]! - tri[0]!, uy = tri[4]! - tri[1]!, uz = tri[5]! - tri[2]!;
  const vx = tri[6]! - tri[0]!, vy = tri[7]! - tri[1]!, vz = tri[8]! - tri[2]!;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** Every clip in one look, across the given poses (all of them by default). */
export function findAvatarClipping(key: AvatarSpriteKey, poses: readonly Pose[] = figurePoses()): ClipFinding[] {
  const findings: ClipFinding[] = [];
  for (const pose of poses) {
    const figure = createAvatarFigure(key);
    try {
      pose.drive(figure);
      const solids = collectSolids(figure.object);
      findings.push(...movingClips(solids, key, pose.name));
      // Headwear is part of the head: one rest pose says it all.
      if (pose === poses[0]) {
        findings.push(...headwearClips(solids, key, pose.name), ...hairShowingThroughHeadwear(solids, key, pose.name));
      }
    } finally {
      figure.dispose();
    }
  }
  return findings;
}

/** The deepest finding per pair of pieces, for a readable report. */
export function summarizeClipping(findings: readonly ClipFinding[]): ClipFinding[] {
  const worst = new Map<string, ClipFinding>();
  for (const finding of findings) {
    const id = `${finding.key}|${finding.check}|${finding.surface}|${finding.inside}`;
    const previous = worst.get(id);
    if (!previous || finding.depth > previous.depth) worst.set(id, finding);
  }
  return [...worst.values()].sort((a, b) => b.depth - a.depth);
}

export function formatClipping(finding: ClipFinding): string {
  const at = finding.point.map((v) => v.toFixed(3)).join(', ');
  return `${finding.key} ${finding.check}: ${finding.inside} through ${finding.surface} (${finding.face}), ${finding.depth.toFixed(3)} deep at (${at}) in ${finding.pose}`;
}
